import { MAX_FORMAT_SOURCE_CODE_UNITS } from "../../core/api/limits";
import type { Diagnostic } from "../../core/diagnostics/diagnostic";
import { createDebugEvent, type DebugEvent } from "../../core/diagnostics/debug-event";
import { lexSql } from "../../core/lexer/lossless-lexer";
import {
    DEFAULT_RENDER_TAB_SIZE,
    inferRenderNewline,
    isRenderNewline,
    isRenderTabSize,
    type RenderNewline,
    type RenderTabSize,
} from "../../core/renderer/environment";
import { displayWidth } from "../../core/renderer/display-width";
import type {
    ExtractDdlResult,
    HiveDdlResult,
} from "../../experimental/ddl/types";
import { snapshotDataProperties, snapshotDenseDataArray } from "../boundary/data-snapshot";
import {
    limitDebugEvents,
    snapshotDebugEvents,
} from "../boundary/debug-event-snapshot";
import { compareString } from "../boundary/order";
import { convertDiagnostic, sortDiagnostics } from "../diagnostics/convert";
import { safeDiagnosticMessage } from "../diagnostics/safe-messages";
import {
    buildTextLineIndex,
    lineBoundsAtOffset,
    type TextLineIndex,
} from "../text/line-index";
import { observeCancellation } from "./cancellation";
import {
    sameDocument,
    snapshotDocument,
    type DocumentSnapshot,
} from "./document-snapshot";
import type {
    CancellationToken,
    TransactionDiagnostic,
} from "./types";
import { createRejectedTransaction } from "./rejected";
import { snapshotTargetRange } from "./target-snapshot";

export type ExperimentalDdlResult = HiveDdlResult | ExtractDdlResult;

export interface ExperimentalDdlTarget {
    readonly id: string;
    readonly start: number;
    readonly end: number;
}

export interface ExperimentalDdlTransactionRequest {
    readonly document: DocumentSnapshot;
    readonly targets: readonly ExperimentalDdlTarget[];
    readonly newline?: RenderNewline;
    readonly tabSize?: RenderTabSize;
    readonly cancellation?: CancellationToken;
    readonly debugEnabled?: boolean;
}

export interface ExperimentalDdlOperationContext {
    readonly tabSize: RenderTabSize;
    readonly startColumn: number;
}

export interface ExperimentalDdlEdit {
    readonly targetId: string;
    readonly start: number;
    readonly end: number;
    readonly text: string;
}

interface ExperimentalDdlTransactionBase<S extends string> {
    readonly status: S;
    readonly documentVersion: number;
    readonly diagnostics: readonly TransactionDiagnostic[];
    readonly debugEvents?: readonly DebugEvent[];
}

export interface ReadyExperimentalDdlTransaction
    extends ExperimentalDdlTransactionBase<"ready"> {
    readonly edits: readonly ExperimentalDdlEdit[];
}

export interface UnchangedExperimentalDdlTransaction
    extends ExperimentalDdlTransactionBase<"unchanged"> {
    readonly edits: readonly [];
}

export interface RejectedExperimentalDdlTransaction
    extends ExperimentalDdlTransactionBase<"rejected"> {
    readonly edits?: never;
}

export interface CancelledExperimentalDdlTransaction
    extends ExperimentalDdlTransactionBase<"cancelled"> {
    readonly diagnostics: readonly [];
    readonly edits?: never;
}

export type ExperimentalDdlTransactionResult =
    | ReadyExperimentalDdlTransaction
    | UnchangedExperimentalDdlTransaction
    | RejectedExperimentalDdlTransaction
    | CancelledExperimentalDdlTransaction;

export type ExperimentalDdlOperation = (
    source: string,
    context: ExperimentalDdlOperationContext
) => ExperimentalDdlResult | Promise<ExperimentalDdlResult>;

export interface ExperimentalDdlCommit {
    readonly currentDocument: () => DocumentSnapshot | null;
    readonly apply: (
        result: ReadyExperimentalDdlTransaction,
        expected: DocumentSnapshot
    ) => Promise<boolean>;
}

interface SnapshottedDdlResult {
    readonly target: ExperimentalDdlTarget;
    readonly indentation: DdlTargetIndentation;
    readonly result: {
        readonly status: string;
        readonly source: string;
        readonly text: string;
        readonly diagnostics: readonly TransactionDiagnostic[];
        readonly debugEvents: readonly DebugEvent[];
    };
}

interface DdlTargetIndentation extends ExperimentalDdlOperationContext {
    readonly internalIndent: string;
    readonly continuationIndent: string;
}

const RESULT_KEYS: ReadonlySet<string> = new Set([
    "status",
    "source",
    "text",
    "diagnostics",
    "debugEvents",
]);
const RESULT_STATUSES: ReadonlySet<string> = new Set([
    "formatted",
    "unchanged",
    "preserved",
    "failed",
    "extracted",
    "unsupported",
    "ambiguous",
    "empty",
]);

function diagnostic(
    target: ExperimentalDdlTarget,
    code: string,
    _message: string,
    severity: "warning" | "error" = "error"
): TransactionDiagnostic {
    return Object.freeze({
        code,
        severity,
        message: safeDiagnosticMessage(code, null),
        capabilityId: null,
        span: Object.freeze({ start: target.start, end: target.end }),
        recovery: "preserve-target" as const,
        targetId: target.id,
    });
}

function rejected(
    version: number,
    diagnostics: readonly TransactionDiagnostic[],
    debugEvents: readonly DebugEvent[] = Object.freeze([])
): RejectedExperimentalDdlTransaction {
    return createRejectedTransaction(version, diagnostics, limitDebugEvents(debugEvents));
}

function appendDebugEvents(
    target: DebugEvent[],
    values: readonly DebugEvent[]
): void {
    if (values.length === 0) {
        return;
    }
    const bounded = limitDebugEvents([...target, ...values]);
    target.splice(0, target.length, ...bounded);
}

function cancelled(
    version: number,
    debugEvents: readonly DebugEvent[] = Object.freeze([])
): CancelledExperimentalDdlTransaction {
    const bounded = limitDebugEvents(debugEvents);
    return Object.freeze({
        status: "cancelled",
        documentVersion: version,
        diagnostics: Object.freeze([]) as readonly [],
        ...(bounded.length === 0 ? {} : { debugEvents: bounded }),
    });
}

function sortedTargets(
    source: string,
    values: readonly ExperimentalDdlTarget[]
): readonly ExperimentalDdlTarget[] | null {
    const rawTargets = snapshotDenseDataArray(values);
    if (rawTargets === null || rawTargets.length === 0) {
        return null;
    }
    const ids = new Set<string>();
    const targets: ExperimentalDdlTarget[] = [];
    for (const rawTarget of rawTargets) {
        const target = snapshotTargetRange(rawTarget, source.length);
        if (target === null || ids.has(target.id)) {
            return null;
        }
        ids.add(target.id);
        targets.push(target);
    }
    targets.sort((left, right) =>
        left.start - right.start ||
        left.end - right.end ||
        compareString(left.id, right.id)
    );
    for (let index = 1; index < targets.length; index++) {
        if (targets[index - 1]!.end > targets[index]!.start) {
            return null;
        }
    }
    return Object.freeze(targets);
}

function isHorizontalWhitespaceRange(
    source: string,
    start: number,
    end: number
): boolean {
    for (let index = start; index < end; index++) {
        const code = source.charCodeAt(index);
        if (code !== 0x20 && code !== 0x09) {
            return false;
        }
    }
    return true;
}

type DdlTargetValidation =
    | { readonly status: "valid" }
    | { readonly status: "cancelled" }
    | { readonly status: "invalid"; readonly target: ExperimentalDdlTarget };

const VALID_DDL_TARGETS: DdlTargetValidation = Object.freeze({ status: "valid" });
const CANCELLED_DDL_TARGETS: DdlTargetValidation = Object.freeze({ status: "cancelled" });

function invalidDdlLineRange(
    source: string,
    target: ExperimentalDdlTarget,
    lineIndex: TextLineIndex
): boolean {
    if (target.start === target.end) {
        return true;
    }
    const startLine = lineBoundsAtOffset(lineIndex, target.start);
    const endLine = lineBoundsAtOffset(lineIndex, target.end);
    return startLine === null ||
        endLine === null ||
        !isHorizontalWhitespaceRange(source, startLine.start, target.start) ||
        !isHorizontalWhitespaceRange(source, target.end, endLine.end);
}

function validateDdlTargets(
    source: string,
    targets: readonly ExperimentalDdlTarget[],
    isCancelled: () => boolean
): DdlTargetValidation {
    try {
        if (isCancelled()) {
            return CANCELLED_DDL_TARGETS;
        }
        const lexical = lexSql(source, { dialect: "hive" });
        if (isCancelled()) {
            return CANCELLED_DDL_TARGETS;
        }
        const lineIndex = buildTextLineIndex(source);
        if (isCancelled()) {
            return CANCELLED_DDL_TARGETS;
        }
        let diagnosticIndex = 0;
        let leafIndex = 0;
        let visitedLeaves = 0;
        for (const target of targets) {
            if (isCancelled()) {
                return CANCELLED_DDL_TARGETS;
            }
            if (invalidDdlLineRange(source, target, lineIndex)) {
                return Object.freeze({ status: "invalid", target });
            }

            while (
                diagnosticIndex < lexical.diagnostics.length &&
                lexical.diagnostics[diagnosticIndex]!.span.end <= target.start
            ) {
                diagnosticIndex += 1;
                visitedLeaves += 1;
                if ((visitedLeaves & 2047) === 0 && isCancelled()) {
                    return CANCELLED_DDL_TARGETS;
                }
            }
            const overlappingDiagnostic = lexical.diagnostics[diagnosticIndex];
            if (
                overlappingDiagnostic !== undefined &&
                overlappingDiagnostic.span.start < target.end &&
                target.start < overlappingDiagnostic.span.end
            ) {
                return Object.freeze({ status: "invalid", target });
            }

            while (
                leafIndex < lexical.leaves.length &&
                lexical.leaves[leafIndex]!.span.end <= target.start
            ) {
                leafIndex += 1;
                visitedLeaves += 1;
                if ((visitedLeaves & 2047) === 0 && isCancelled()) {
                    return CANCELLED_DDL_TARGETS;
                }
            }
            let scanIndex = leafIndex;
            let containsCode = false;
            while (
                scanIndex < lexical.leaves.length &&
                lexical.leaves[scanIndex]!.span.start < target.end
            ) {
                const leaf = lexical.leaves[scanIndex]!;
                const protectedBoundary = leaf.channel === "protected" ||
                    leaf.kind === "line-comment" ||
                    leaf.kind === "block-comment";
                if (protectedBoundary && (
                    (leaf.span.start < target.start && target.start < leaf.span.end) ||
                    (leaf.span.start < target.end && target.end < leaf.span.end)
                )) {
                    return Object.freeze({ status: "invalid", target });
                }
                if (
                    leaf.channel === "code" &&
                    leaf.span.end > target.start
                ) {
                    containsCode = true;
                }
                scanIndex += 1;
                visitedLeaves += 1;
                if ((visitedLeaves & 2047) === 0 && isCancelled()) {
                    return CANCELLED_DDL_TARGETS;
                }
            }
            while (
                leafIndex < scanIndex &&
                lexical.leaves[leafIndex]!.span.end <= target.end
            ) {
                leafIndex += 1;
            }
            if (!containsCode) {
                return Object.freeze({ status: "invalid", target });
            }
        }
        return isCancelled() ? CANCELLED_DDL_TARGETS : VALID_DDL_TARGETS;
    } catch {
        return Object.freeze({ status: "invalid", target: targets[0]! });
    }
}

function snapshotResult(
    value: ExperimentalDdlResult,
    target: ExperimentalDdlTarget
): { readonly status: string; readonly source: string; readonly text: string; readonly diagnostics: readonly TransactionDiagnostic[]; readonly debugEvents: readonly DebugEvent[] } | null {
    const raw = snapshotDataProperties(value, RESULT_KEYS, [
        "status",
        "source",
        "text",
        "diagnostics",
    ]);
    if (
        raw === null ||
        typeof raw.status !== "string" ||
        !RESULT_STATUSES.has(raw.status) ||
        typeof raw.source !== "string" ||
        typeof raw.text !== "string"
    ) {
        return null;
    }
    const diagnostics = snapshotDenseDataArray(raw.diagnostics);
    if (diagnostics === null) {
        return null;
    }
    const debugEvents = raw.debugEvents === undefined
        ? Object.freeze([])
        : snapshotDebugEvents(raw.debugEvents);
    if (debugEvents === null) {
        return null;
    }
    const converted: TransactionDiagnostic[] = [];
    for (const value of diagnostics) {
        const convertedDiagnostic = convertDiagnostic(
            value as Diagnostic,
            target.id,
            target.start,
            target.end - target.start
        );
        if (convertedDiagnostic === null) {
            return null;
        }
        converted.push(convertedDiagnostic);
    }
    return Object.freeze({
        status: raw.status,
        source: raw.source,
        text: raw.text,
        diagnostics: sortDiagnostics(converted),
        debugEvents,
    });
}

function lineBreakLengthAt(source: string, offset: number): number {
    const code = source.charCodeAt(offset);
    if (code === 0x0D) {
        return source.charCodeAt(offset + 1) === 0x0A ? 2 : 1;
    }
    return code === 0x0A ? 1 : 0;
}

function targetIndentation(
    source: string,
    target: ExperimentalDdlTarget,
    lineIndex: TextLineIndex,
    tabSize: RenderTabSize
): DdlTargetIndentation | null {
    const startLine = lineBoundsAtOffset(lineIndex, target.start);
    if (startLine === null) {
        return null;
    }
    const externalIndent = source.slice(startLine.start, target.start);
    if (!isHorizontalWhitespaceRange(source, startLine.start, target.start)) {
        return null;
    }
    let internalIndentEnd = target.start;
    while (internalIndentEnd < target.end) {
        const code = source.charCodeAt(internalIndentEnd);
        if (code !== 0x20 && code !== 0x09) {
            break;
        }
        internalIndentEnd += 1;
    }
    const internalIndent = source.slice(target.start, internalIndentEnd);
    const continuationIndent = externalIndent + internalIndent;
    const startColumn = displayWidth(continuationIndent, 0, tabSize);
    if (startColumn === null) {
        return null;
    }
    return Object.freeze({
        tabSize,
        startColumn,
        internalIndent,
        continuationIndent,
    });
}

interface DdlReplacement {
    readonly start: number;
    readonly end: number;
    readonly text: string;
}

function normalizeDdlReplacement(
    source: string,
    target: ExperimentalDdlTarget,
    rawText: string,
    lineIndex: TextLineIndex,
    newline: RenderNewline,
    indentation: DdlTargetIndentation
): DdlReplacement | null {
    const targetSource = source.slice(target.start, target.end);
    let end = target.end;
    let preserveTerminalNewline = /(?:\r\n|\r|\n)$/.test(targetSource);
    if (!preserveTerminalNewline) {
        const endLine = lineBoundsAtOffset(lineIndex, target.end);
        if (
            endLine === null ||
            !isHorizontalWhitespaceRange(source, target.end, endLine.end)
        ) {
            return null;
        }
        end = endLine.end;
        const lineBreakLength = lineBreakLengthAt(source, end);
        if (lineBreakLength > 0) {
            end += lineBreakLength;
            preserveTerminalNewline = true;
        }
    }
    const lexical = lexSql(rawText, { dialect: "hive" });
    if (lexical.diagnostics.length !== 0) {
        return null;
    }
    const output: string[] = [];
    let pendingHorizontalWhitespace = "";
    let lineIndent = indentation.internalIndent;
    let atGeneratedLineStart = true;
    for (const leaf of lexical.leaves) {
        if (leaf.kind === "whitespace") {
            pendingHorizontalWhitespace += leaf.raw;
            continue;
        }
        if (leaf.kind === "newline") {
            pendingHorizontalWhitespace = "";
            output.push(newline);
            lineIndent = indentation.continuationIndent;
            atGeneratedLineStart = true;
            continue;
        }
        if (atGeneratedLineStart) {
            output.push(lineIndent);
            atGeneratedLineStart = false;
        }
        if (pendingHorizontalWhitespace.length > 0) {
            output.push(pendingHorizontalWhitespace);
            pendingHorizontalWhitespace = "";
        }
        output.push(leaf.raw);
    }
    let rendered = output.join("");
    if (preserveTerminalNewline && !rendered.endsWith(newline)) {
        rendered += newline;
    }
    return Object.freeze({ start: target.start, end, text: rendered });
}

function prepareExperimentalDdlTransactionInternal(
    expected: DocumentSnapshot,
    snapshots: readonly SnapshottedDdlResult[],
    lineIndex: TextLineIndex,
    newline: RenderNewline,
    operationDebugEvents: readonly DebugEvent[]
): ExperimentalDdlTransactionResult {
    const debugEvents = limitDebugEvents(operationDebugEvents);
    const diagnostics: TransactionDiagnostic[] = [];
    for (const value of snapshots) {
        if (value.result.diagnostics.length === 0) {
            continue;
        }
        diagnostics.push(...value.result.diagnostics);
        diagnostics.push(diagnostic(
            value.target,
            "ADAPTER_DDL_RESULT",
            "Experimental DDL result must be diagnostic-free"
        ));
    }
    if (diagnostics.length !== 0) {
        return rejected(expected.version, diagnostics, debugEvents);
    }

    const edits: ExperimentalDdlEdit[] = [];
    for (const value of snapshots) {
        const { target, result } = value;
        if (result.status === "formatted" || result.status === "extracted") {
            if (result.text.length === 0) {
                return rejected(expected.version, [
                    diagnostic(
                        target,
                        "ADAPTER_DDL_RESULT",
                        "Editable experimental DDL result must be non-empty"
                    ),
                ], debugEvents);
            }
            if (result.text !== result.source) {
                const replacement = normalizeDdlReplacement(
                    expected.source,
                    target,
                    result.text,
                    lineIndex,
                    newline,
                    value.indentation
                );
                if (replacement === null) {
                    return rejected(expected.version, [
                        diagnostic(
                            target,
                            "ADAPTER_DDL_RESULT",
                            "Experimental DDL replacement boundary is invalid"
                        ),
                    ], debugEvents);
                }
                edits.push(Object.freeze({
                    targetId: target.id,
                    start: replacement.start,
                    end: replacement.end,
                    text: replacement.text,
                }));
            }
            continue;
        }
        if (result.status === "unchanged" && result.text === result.source) {
            continue;
        }
        if (result.text !== result.source) {
            return rejected(expected.version, [
                diagnostic(
                    target,
                    "ADAPTER_DDL_RESULT",
                    "Non-editable experimental DDL result must retain source"
                ),
            ], debugEvents);
        }
        return rejected(expected.version, [
            diagnostic(
                target,
                "ADAPTER_DDL_NOT_EDITABLE",
                "Experimental DDL result is not editable in this transaction",
                result.status === "failed" ? "error" : "warning"
            ),
        ], debugEvents);
    }
    if (edits.length === 0) {
        return Object.freeze({
            status: "unchanged",
            documentVersion: expected.version,
            edits: Object.freeze([]) as readonly [],
            diagnostics: Object.freeze([]),
            ...(debugEvents.length === 0 ? {} : { debugEvents }),
        });
    }
    return Object.freeze({
        status: "ready",
        documentVersion: expected.version,
        edits: Object.freeze(edits),
        diagnostics: Object.freeze([]),
        ...(debugEvents.length === 0 ? {} : { debugEvents }),
    });
}

async function runExperimentalDdlTransactionInternal(
    request: ExperimentalDdlTransactionRequest,
    operation: ExperimentalDdlOperation,
    commit: ExperimentalDdlCommit
): Promise<ExperimentalDdlTransactionResult> {
    const expected = snapshotDocument(request.document);
    if (expected === null) {
        return rejected(0, [
            diagnostic(
                { id: "document", start: 0, end: 0 },
                "ADAPTER_DOCUMENT_SNAPSHOT",
                "Document snapshot is invalid"
            ),
        ]);
    }
    const cancellation = observeCancellation(request.cancellation);
    const operationDebugEvents: DebugEvent[] = [];
    try {
        if (cancellation.isCancelled()) {
            return cancelled(expected.version);
        }
        let newline: RenderNewline;
        let tabSize: RenderTabSize;
        try {
            const requestedNewline = request.newline;
            if (requestedNewline !== undefined && !isRenderNewline(requestedNewline)) {
                return rejected(expected.version, [
                    diagnostic(
                        { id: "document", start: 0, end: expected.source.length },
                        "ADAPTER_DDL_TRANSACTION",
                        "Experimental DDL newline is invalid"
                    ),
                ]);
            }
            newline = requestedNewline ?? inferRenderNewline(expected.source, "\n");
            const requestedTabSize = request.tabSize;
            if (requestedTabSize !== undefined && !isRenderTabSize(requestedTabSize)) {
                return rejected(expected.version, [
                    diagnostic(
                        { id: "document", start: 0, end: expected.source.length },
                        "ADAPTER_DDL_TRANSACTION",
                        "Experimental DDL tab size is invalid"
                    ),
                ]);
            }
            tabSize = requestedTabSize ?? DEFAULT_RENDER_TAB_SIZE;
        } catch {
            return rejected(expected.version, [
                diagnostic(
                    { id: "document", start: 0, end: expected.source.length },
                    "ADAPTER_DDL_TRANSACTION",
                    "Experimental DDL newline could not be inspected"
                ),
                ]);
        }
        if (expected.source.length > MAX_FORMAT_SOURCE_CODE_UNITS) {
            return rejected(expected.version, [
                diagnostic(
                    { id: "document", start: 0, end: expected.source.length },
                    "ADAPTER_DDL_INPUT_LIMIT",
                    "Experimental DDL document exceeds the safe input limit",
                    "warning"
                ),
            ]);
        }
        const targets = sortedTargets(expected.source, request.targets);
        if (targets === null) {
            return rejected(expected.version, [
                diagnostic(
                    { id: "document", start: 0, end: expected.source.length },
                    "ADAPTER_DDL_TARGET",
                    "Experimental DDL targets are invalid or overlapping"
                ),
            ]);
        }
        if (cancellation.isCancelled()) {
            return cancelled(expected.version);
        }
        const targetValidation = validateDdlTargets(
            expected.source,
            targets,
            () => cancellation.isCancelled()
        );
        if (targetValidation.status === "cancelled") {
            return cancelled(expected.version);
        }
        if (targetValidation.status === "invalid") {
            return rejected(expected.version, [
                diagnostic(
                    targetValidation.target,
                    "ADAPTER_DDL_RANGE",
                    "Experimental DDL target is not a complete safe source range"
                ),
            ]);
        }
        const lineIndex = buildTextLineIndex(expected.source);
        const operationResults: SnapshottedDdlResult[] = [];
        const operationDiagnostics: TransactionDiagnostic[] = [];
        for (const target of targets) {
            const indentation = targetIndentation(
                expected.source,
                target,
                lineIndex,
                tabSize
            );
            if (indentation === null) {
                operationDiagnostics.push(diagnostic(
                    target,
                    "ADAPTER_DDL_RANGE",
                    "Experimental DDL target indentation is invalid"
                ));
                if (cancellation.isCancelled()) {
                    return cancelled(expected.version, operationDebugEvents);
                }
                continue;
            }
            try {
                const operationResult = await operation(
                    expected.source.slice(target.start, target.end),
                    Object.freeze({
                        tabSize: indentation.tabSize,
                        startColumn: indentation.startColumn,
                    })
                );
                const result = snapshotResult(operationResult, target);
                if (
                    result === null ||
                    result.source !== expected.source.slice(target.start, target.end)
                ) {
                    operationDiagnostics.push(diagnostic(
                        target,
                        "ADAPTER_DDL_RESULT",
                        "Experimental DDL result violated the source identity contract"
                    ));
                } else {
                    appendDebugEvents(operationDebugEvents, result.debugEvents);
                    operationResults.push(Object.freeze({
                        target,
                        result,
                        indentation,
                    }));
                }
            } catch (error) {
                let debugEnabled = false;
                try {
                    debugEnabled = request.debugEnabled === true;
                } catch {
                    debugEnabled = false;
                }
                if (debugEnabled) {
                    appendDebugEvents(operationDebugEvents, Object.freeze([
                        createDebugEvent(
                            "executor",
                            "ADAPTER_DDL_OPERATION",
                            error
                        ),
                    ]));
                }
                operationDiagnostics.push(diagnostic(
                    target,
                    "ADAPTER_DDL_OPERATION",
                    "Experimental DDL operation failed"
                ));
            }
            if (cancellation.isCancelled()) {
                return cancelled(expected.version, operationDebugEvents);
            }
        }
        if (operationDiagnostics.length !== 0) {
            return rejected(
                expected.version,
                operationDiagnostics,
                operationDebugEvents
            );
        }
        const prepared = prepareExperimentalDdlTransactionInternal(
            expected,
            Object.freeze(operationResults),
            lineIndex,
            newline,
            operationDebugEvents
        );
        if (prepared.status !== "ready") {
            return prepared;
        }
        if (!sameDocument(expected, snapshotDocument(commit.currentDocument()))) {
            return rejected(expected.version, [
                diagnostic(
                    { id: "document", start: 0, end: expected.source.length },
                    "ADAPTER_STALE_DOCUMENT",
                    "Document changed before the experimental DDL edit could be applied",
                    "warning"
                ),
            ], prepared.debugEvents ?? Object.freeze([]));
        }
        if (cancellation.isCancelled()) {
            return cancelled(
                expected.version,
                prepared.debugEvents ?? Object.freeze([])
            );
        }
        try {
            if (await commit.apply(prepared, expected) !== true) {
                return rejected(expected.version, [
                    diagnostic(
                        { id: "document", start: 0, end: expected.source.length },
                        "ADAPTER_EDIT_REJECTED",
                        "Host rejected the experimental DDL edits"
                    ),
                ], prepared.debugEvents ?? Object.freeze([]));
            }
        } catch {
            return rejected(expected.version, [
                diagnostic(
                    { id: "document", start: 0, end: expected.source.length },
                    "ADAPTER_EDIT_REJECTED",
                    "Host rejected the experimental DDL edits"
                ),
            ], prepared.debugEvents ?? Object.freeze([]));
        }
        return prepared;
    } finally {
        cancellation.dispose();
    }
}

export async function runExperimentalDdlTransaction(
    request: ExperimentalDdlTransactionRequest,
    operation: ExperimentalDdlOperation,
    commit: ExperimentalDdlCommit
): Promise<ExperimentalDdlTransactionResult> {
    try {
        return await runExperimentalDdlTransactionInternal(request, operation, commit);
    } catch {
        return rejected(0, [
            diagnostic(
                { id: "document", start: 0, end: 0 },
                "ADAPTER_DDL_TRANSACTION",
                "Experimental DDL transaction failed safely"
            ),
        ]);
    }
}
