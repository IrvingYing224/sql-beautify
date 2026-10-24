import { floorViolation } from "../core/api/floor";
import { formatSql } from "../core/api/format";
import type { FormatResult } from "../core/api/format-result";
import { MAX_FORMAT_SOURCE_CODE_UNITS } from "../core/api/limits";
import { createDebugEvent, type DebugEvent } from "../core/diagnostics/debug-event";
import type { Diagnostic } from "../core/diagnostics/diagnostic";
import { lexSql } from "../core/lexer/lossless-lexer";
import { renderEnvironmentForNewline, type RenderNewline, type RenderTabSize } from "../core/renderer/environment";
import type { SourceMap, SourceMapEntry } from "../core/source/source-map";
import { extractDdl } from "../ddl/extract";
import { caseKeyword, formatHiveDdl } from "../ddl/hive-ddl";
import { resolveHiveDdlFormatOptions } from "../ddl/options";
import type { DdlLayout } from "../ddl/types";
import { mapSelection, mapThroughEdits } from "./offsets";
import { blankRunEnd, blankRunStart, FORMAT_RANGE_MESSAGES, invalidDdlTarget, validateFormatTargets } from "./range";
import type { ComputeRequest, ComputeResult, Edit, EditDiagnostic, EditTarget } from "./types";

type FormatRequest = Extract<ComputeRequest, { readonly op: "format" }>;
type DdlRequest = Exclude<ComputeRequest, FormatRequest>;

const EMPTY_TARGET_RESULT: FormatResult = {
    status: "unchanged",
    text: "",
    diagnostics: [],
    sourceMap: { entries: [] },
};

function adapterDiagnostic(
    code: string,
    message: string,
    span: { readonly start: number; readonly end: number },
    targetId: string | null,
    severity: Diagnostic["severity"] = "error"
): EditDiagnostic {
    return {
        code,
        severity,
        message,
        capabilityId: null,
        span: { start: span.start, end: span.end },
        recovery: "preserve-target",
        targetId,
    };
}

function documentDiagnostic(
    source: string,
    code: string,
    message: string,
    severity: Diagnostic["severity"] = "error"
): EditDiagnostic {
    return adapterDiagnostic(code, message, { start: 0, end: source.length }, null, severity);
}

function targetDiagnostic(target: EditTarget, code: string, message: string): EditDiagnostic {
    return adapterDiagnostic(code, message, target, target.id);
}

/** A core diagnostic with its span moved from target to document coordinates. */
function inDocument(diagnostic: Diagnostic, target: EditTarget): EditDiagnostic {
    return {
        ...diagnostic,
        span: { start: target.start + diagnostic.span.start, end: target.start + diagnostic.span.end },
        targetId: target.id,
    };
}

function compareText(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

export function sortDiagnostics(values: readonly EditDiagnostic[]): EditDiagnostic[] {
    return values.slice().sort((left, right) =>
        compareText(left.targetId ?? "", right.targetId ?? "") ||
        left.span.start - right.span.start ||
        left.span.end - right.span.end ||
        compareText(left.code, right.code)
    );
}

function rejected(diagnostics: readonly EditDiagnostic[], debugEvents: readonly DebugEvent[] = []): ComputeResult {
    return { status: "rejected", edits: [], selections: [], diagnostics: sortDiagnostics(diagnostics), debugEvents };
}

/** A rejection of the whole request, with one error diagnostic over the document. */
export function rejectedDocument(
    source: string,
    code: string,
    message: string,
    debugEvents: readonly DebugEvent[] = []
): ComputeResult {
    return rejected([documentDiagnostic(source, code, message)], debugEvents);
}

/** Targets in document order, or null when two of them overlap. */
function sortedTargets(values: readonly EditTarget[]): readonly EditTarget[] | null {
    const targets = values.slice().sort((left, right) =>
        left.start - right.start || left.end - right.end || compareText(left.id, right.id)
    );
    return targets.some((target, index) => index > 0 && targets[index - 1]!.end > target.start)
        ? null
        : targets;
}

/** One source map for the whole document: each target's map, with the text between targets kept. */
function documentSourceMap(
    sourceLength: number,
    targets: readonly EditTarget[],
    results: readonly FormatResult[]
): { readonly sourceMap: SourceMap; readonly outputLength: number } {
    const entries: SourceMapEntry[] = [];
    const add = (sourceStart: number, outputStart: number, length: number): void => {
        if (length > 0) {
            entries.push({
                source: { start: sourceStart, end: sourceStart + length },
                output: { start: outputStart, end: outputStart + length },
            });
        }
    };
    let sourceCursor = 0;
    let outputCursor = 0;
    targets.forEach((target, index) => {
        const result = results[index]!;
        add(sourceCursor, outputCursor, target.start - sourceCursor);
        outputCursor += target.start - sourceCursor;
        for (const entry of result.sourceMap!.entries) {
            add(target.start + entry.source.start, outputCursor + entry.output.start, entry.source.end - entry.source.start);
        }
        sourceCursor = target.end;
        outputCursor += result.text.length;
    });
    add(sourceCursor, outputCursor, sourceLength - sourceCursor);
    return { sourceMap: { entries }, outputLength: outputCursor + sourceLength - sourceCursor };
}

function computeFormat(request: FormatRequest, debugEvents: DebugEvent[]): ComputeResult {
    const source = request.source;
    if (source.length > MAX_FORMAT_SOURCE_CODE_UNITS) {
        return rejected([documentDiagnostic(
            source,
            "ADAPTER_INPUT_LIMIT",
            "SQL input exceeds the supported 512 Ki code-unit limit"
        )]);
    }
    const targets = sortedTargets(request.targets);
    if (targets === null) {
        return rejected([documentDiagnostic(source, "ADAPTER_TRANSACTION_TARGET", "Formatting targets overlap")]);
    }
    const validation = validateFormatTargets(source, targets);
    if (!validation.ok) {
        // A range that cannot be formatted alone is no problem in the SQL, for example half a
        // statement that formatOnPaste passes to the range provider (K26).
        return rejected([adapterDiagnostic(
            validation.code,
            FORMAT_RANGE_MESSAGES[validation.code],
            validation.target,
            validation.target.id,
            "info"
        )]);
    }
    const environment = renderEnvironmentForNewline(request.newline, request.tabSize);
    const results = targets.map((target) => target.start === target.end
        ? EMPTY_TARGET_RESULT
        : formatSql(
            source.slice(target.start, target.end),
            request.options,
            validation.modes.get(target.id),
            environment,
            debugEvents
        ));
    const diagnostics = results.flatMap((result, index) =>
        result.diagnostics.map((diagnostic) => inDocument(diagnostic, targets[index]!))
    );
    if (
        diagnostics.some((diagnostic) => diagnostic.severity === "error") ||
        results.some((result) => result.status === "failed" || result.status === "preserved")
    ) {
        return rejected(diagnostics, debugEvents);
    }
    const edits: Edit[] = [];
    targets.forEach((target, index) => {
        const result = results[index]!;
        if (result.status === "formatted") {
            edits.push({ targetId: target.id, start: target.start, end: target.end, text: result.text });
        }
    });
    const combined = documentSourceMap(source.length, targets, results);
    const outputStarts = new Map<string, number>();
    let delta = 0;
    targets.forEach((target, index) => {
        outputStarts.set(target.id, target.start + delta);
        delta += results[index]!.text.length - (target.end - target.start);
    });
    const selections = request.selections.map((selection) => {
        const index = targets.findIndex((target) => target.id === selection.targetId);
        if (index < 0) {
            return mapSelection(selection, combined.sourceMap, source.length, combined.outputLength);
        }
        // A selection inside a target maps through that target's own map.
        const target = targets[index]!;
        const result = results[index]!;
        const local = mapSelection(
            { anchor: selection.anchor - target.start, active: selection.active - target.start },
            result.sourceMap!,
            target.end - target.start,
            result.text.length
        );
        const outputStart = outputStarts.get(target.id)!;
        return { anchor: outputStart + local.anchor, active: outputStart + local.active };
    });
    if (edits.length === 0) {
        return { status: "unchanged", edits, selections, diagnostics: sortDiagnostics(diagnostics), debugEvents };
    }
    const outputDiagnostics = diagnostics.map((diagnostic) => {
        const span = mapSelection(
            { anchor: diagnostic.span.start, active: diagnostic.span.end },
            combined.sourceMap,
            source.length,
            combined.outputLength
        );
        return { ...diagnostic, span: { start: span.anchor, end: span.active } };
    });
    return { status: "ready", edits, selections, diagnostics: sortDiagnostics(outputDiagnostics), debugEvents };
}

/**
 * Where the DDL output for a target goes: the blanks at the start of the target begin the first
 * line, and later lines repeat the whole indentation of that line.
 */
export function ddlLayout(source: string, target: EditTarget, newline: RenderNewline, tabSize: RenderTabSize): DdlLayout {
    const firstIndent = source.slice(target.start, Math.min(blankRunEnd(source, target.start), target.end));
    return {
        newline,
        tabSize,
        firstIndent,
        indent: source.slice(blankRunStart(source, target.start), target.start) + firstIndent,
    };
}

function computeDdl(request: DdlRequest, debugEvents: DebugEvent[]): ComputeResult {
    const source = request.source;
    if (source.length > MAX_FORMAT_SOURCE_CODE_UNITS) {
        return rejected([documentDiagnostic(
            source,
            "ADAPTER_DDL_INPUT_LIMIT",
            "The DDL document exceeds the safe input limit",
            "warning"
        )]);
    }
    const targets = sortedTargets(request.targets);
    if (targets === null || targets.length === 0) {
        return rejected([documentDiagnostic(source, "ADAPTER_DDL_TARGET", "DDL targets are missing or overlap")]);
    }
    const invalid = invalidDdlTarget(source, targets);
    if (invalid !== null) {
        return rejected([targetDiagnostic(invalid, "ADAPTER_DDL_RANGE", "The DDL selection is not a complete safe source range")]);
    }
    const diagnostics: EditDiagnostic[] = [];
    const edits: Edit[] = [];
    for (const target of targets) {
        const text = source.slice(target.start, target.end);
        const layout = ddlLayout(source, target, request.newline, request.tabSize);
        const result = request.op === "hive-ddl"
            ? formatHiveDdl(text, request.options, layout, debugEvents)
            : extractDdl(text, request.options, layout, debugEvents);
        const problems = result.diagnostics.map((diagnostic) => inDocument(diagnostic, target));
        if (request.op === "hive-ddl" && result.status === "formatted") {
            // Safety floor 2 for DDL: only the leaves the renderer reports may change, and only in case.
            const keywordCase = resolveHiveDdlFormatOptions(request.options)!.keywordCase;
            const recased = new Set("recased" in result ? result.recased : []);
            const violation = floorViolation(lexSql(text).leaves, result.text, (leaf) =>
                recased.has(leaf.id) ? caseKeyword(leaf.raw, keywordCase) : leaf.raw
            );
            if (violation !== null) {
                problems.push(violation === "token"
                    ? adapterDiagnostic("FMT_TOKEN_EQUIVALENCE", "Formatted DDL failed token-equivalence validation", target, target.id)
                    : adapterDiagnostic("FMT_GLUE_PRESERVED", "Formatted DDL would change spacing between glued tokens", target, target.id, "warning"));
            }
        }
        if (problems.length > 0) {
            diagnostics.push(...problems, targetDiagnostic(target, "ADAPTER_DDL_RESULT", "The DDL result cannot be applied"));
        } else if (result.status === "formatted" || result.status === "extracted") {
            edits.push({ targetId: target.id, start: target.start, end: target.end, text: result.text });
        }
    }
    if (diagnostics.length > 0) {
        return rejected(diagnostics, debugEvents);
    }
    const selections = request.selections.map((selection) => ({
        anchor: mapThroughEdits(edits, selection.anchor),
        active: mapThroughEdits(edits, selection.active),
    }));
    return { status: edits.length === 0 ? "unchanged" : "ready", edits, selections, diagnostics: [], debugEvents };
}

/**
 * Computes every edit for one request, or none (plan §5.4). Pure; runs on the extension host or in
 * the worker. An internal error rejects the request with ADAPTER_EXECUTOR_FAILED.
 */
export function computeEdits(request: ComputeRequest): ComputeResult {
    const debugEvents: DebugEvent[] = [];
    try {
        return request.op === "format"
            ? computeFormat(request, debugEvents)
            : computeDdl(request, debugEvents);
    } catch (error) {
        debugEvents.push(createDebugEvent("executor", "ADAPTER_EXECUTOR_FAILED", error));
        return rejectedDocument(request.source, "ADAPTER_EXECUTOR_FAILED", "The formatter failed safely", debugEvents);
    }
}
