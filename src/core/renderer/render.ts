import {
    canonicalLayoutResourceBudget,
    isCanonicalLayoutArtifact,
} from "../layout/artifact";
import type { LayoutArtifact } from "../layout/artifact";
import type {
    LayoutDoc,
    LineSuffixSpacing,
} from "../layout/doc";
import type { SourceSpan } from "../source/source-span";
import type { SourceMap, SourceMapEntry } from "../source/source-map";
import { measureDisplayText } from "./display-width";
import { applyKeywordCase } from "./keyword-case";
import { measureLayoutArtifact } from "./metrics";
import type {
    LayoutMetrics,
    RenderFailure,
    RenderFailureCode,
    RenderResult,
} from "./types";

interface DocFrame {
    readonly doc: LayoutDoc;
    readonly mode: "flat" | "break";
    readonly indentLevels: number;
    readonly alignColumns: number;
}

interface PendingSuffix {
    readonly commentLeafId: number;
    readonly spacing: LineSuffixSpacing;
    readonly indentLevels: number;
    readonly alignColumns: number;
}

interface MutableSourceMapEntry {
    sourceStart: number;
    sourceEnd: number;
    outputStart: number;
    outputEnd: number;
}

class RenderAbort extends Error {
    constructor(
        readonly code: RenderFailureCode,
        message: string
    ) {
        super(message);
    }
}

const CANONICAL_RENDER_ARTIFACTS = new WeakMap<object, LayoutArtifact>();

/** Exact artifact proof for successful renderer results. */
export function canonicalLayoutArtifactForRenderSuccess(
    value: unknown
): LayoutArtifact | null {
    return typeof value === "object" && value !== null
        ? CANONICAL_RENDER_ARTIFACTS.get(value) ?? null
        : null;
}

function failure(code: RenderFailureCode, message: string): RenderFailure {
    return Object.freeze({ ok: false, code, message });
}

function startsWithLineBreak(value: string): boolean {
    return value.length > 0 &&
        (value.charCodeAt(0) === 0x0A || value.charCodeAt(0) === 0x0D);
}

function endsWithLineBreak(value: string): boolean {
    if (value.length === 0) {
        return false;
    }
    const last = value.charCodeAt(value.length - 1);
    return last === 0x0A || last === 0x0D;
}

function isHorizontalBoundaryWhitespace(code: number): boolean {
    return (
        code === 0x09 ||
        code === 0x0B ||
        code === 0x0C ||
        code === 0x20 ||
        code === 0x00A0 ||
        code === 0x1680 ||
        (code >= 0x2000 && code <= 0x200A) ||
        code === 0x202F ||
        code === 0x205F ||
        code === 0x3000
    );
}

function leadingBoundaryLineBreakCount(value: string): number {
    let count = 0;
    let cursor = 0;
    while (cursor < value.length) {
        const code = value.charCodeAt(cursor);
        if (code === 0x0D && value.charCodeAt(cursor + 1) === 0x0A) {
            cursor += 2;
            count += 1;
        } else if (code === 0x0D || code === 0x0A) {
            cursor += 1;
            count += 1;
        } else if (isHorizontalBoundaryWhitespace(code)) {
            cursor += 1;
        } else {
            break;
        }
    }
    return count;
}

function trailingBoundaryLineBreakCount(value: string): number {
    let count = 0;
    let cursor = value.length;
    while (cursor > 0) {
        const code = value.charCodeAt(cursor - 1);
        if (code === 0x0A && cursor > 1 && value.charCodeAt(cursor - 2) === 0x0D) {
            cursor -= 2;
            count += 1;
        } else if (code === 0x0D || code === 0x0A) {
            cursor -= 1;
            count += 1;
        } else if (isHorizontalBoundaryWhitespace(code)) {
            cursor -= 1;
        } else {
            break;
        }
    }
    return count;
}

function frozenSpan(start: number, end: number): SourceSpan {
    return Object.freeze({ start, end });
}

function freezeSourceMap(
    values: readonly MutableSourceMapEntry[]
): SourceMap {
    const entries: SourceMapEntry[] = values.map((value) =>
        Object.freeze({
            source: frozenSpan(value.sourceStart, value.sourceEnd),
            output: frozenSpan(value.outputStart, value.outputEnd),
        })
    );
    return Object.freeze({ entries: Object.freeze(entries) });
}

function renderCanonical(
    artifact: LayoutArtifact,
    metrics: LayoutMetrics
): RenderResult {
    const budget = canonicalLayoutResourceBudget(artifact);
    if (budget === null) {
        return failure(
            "RENDER_ARTIFACT_PROVENANCE",
            "Canonical layout budget proof is missing"
        );
    }

    const chunks: string[] = [];
    const mapEntries: MutableSourceMapEntry[] = [];
    const suffixes: PendingSuffix[] = [];
    const stack: DocFrame[] = [
        {
            doc: artifact.root,
            mode: "break",
            indentLevels: 0,
            alignColumns: 0,
        },
    ];
    let outputCodeUnits = 0;
    let generatedWhitespaceCodeUnits = 0;
    let generatedColumnsOnLine = 0;
    let displayColumn = 0;
    let needsLinePrefix = false;
    let docVisitCount = 0;
    let metricsLookupCount = 0;
    let sourceEmissionCount = 0;

    const assertOutputCapacity = (amount: number): void => {
        if (
            !Number.isSafeInteger(amount) ||
            amount < 0 ||
            outputCodeUnits > budget.maxOutputCodeUnits - amount
        ) {
            throw new RenderAbort(
                "RENDER_RESOURCE_BUDGET",
                "Rendered output exceeds the code-unit budget"
            );
        }
    };

    const appendGenerated = (
        raw: string,
        displayColumns: number,
        lineBreak: boolean
    ): void => {
        if (
            !Number.isSafeInteger(displayColumns) ||
            displayColumns < 0 ||
            generatedWhitespaceCodeUnits >
                budget.maxGeneratedWhitespaceCodeUnits - raw.length ||
            (!lineBreak &&
                generatedColumnsOnLine >
                    budget.maxGeneratedColumnsPerLine - displayColumns)
        ) {
            throw new RenderAbort(
                "RENDER_RESOURCE_BUDGET",
                "Generated layout whitespace exceeds its runtime budget"
            );
        }
        assertOutputCapacity(raw.length);
        chunks.push(raw);
        outputCodeUnits += raw.length;
        generatedWhitespaceCodeUnits += raw.length;
        if (lineBreak) {
            displayColumn = 0;
            generatedColumnsOnLine = 0;
            needsLinePrefix = true;
        } else {
            displayColumn += displayColumns;
            generatedColumnsOnLine += displayColumns;
        }
    };

    const appendMapEntry = (
        sourceStart: number,
        sourceEnd: number,
        outputStart: number,
        outputEnd: number
    ): void => {
        if (
            !Number.isSafeInteger(sourceStart) ||
            !Number.isSafeInteger(sourceEnd) ||
            sourceStart < 0 ||
            sourceEnd <= sourceStart ||
            sourceEnd > artifact.analysis.source.length ||
            outputEnd <= outputStart ||
            sourceEnd - sourceStart !== outputEnd - outputStart
        ) {
            throw new RenderAbort(
                "RENDER_SOURCE_MAP",
                "Source-map entry is not a valid one-to-one run"
            );
        }
        const previous = mapEntries[mapEntries.length - 1];
        if (
            previous !== undefined &&
            (sourceStart < previous.sourceEnd || outputStart < previous.outputEnd)
        ) {
            throw new RenderAbort(
                "RENDER_SOURCE_MAP",
                "Source-map entries are not monotonic"
            );
        }
        if (
            previous !== undefined &&
            sourceStart === previous.sourceEnd &&
            outputStart === previous.outputEnd
        ) {
            previous.sourceEnd = sourceEnd;
            previous.outputEnd = outputEnd;
            return;
        }
        mapEntries.push({
            sourceStart,
            sourceEnd,
            outputStart,
            outputEnd,
        });
    };

    const appendSource = (
        raw: string,
        span: SourceSpan,
        frame: Pick<DocFrame, "indentLevels" | "alignColumns">
    ): void => {
        if (raw.length !== span.end - span.start || raw.length === 0) {
            throw new RenderAbort(
                "RENDER_SOURCE_MAP",
                "Source-derived output length does not match its source span"
            );
        }
        if (needsLinePrefix && !startsWithLineBreak(raw)) {
            emitLinePrefix(frame);
        }
        const measured = measureDisplayText(raw, displayColumn);
        if (measured === null) {
            throw new RenderAbort(
                "RENDER_RESOURCE_BUDGET",
                "Source-derived display width could not be represented"
            );
        }
        assertOutputCapacity(raw.length);
        const outputStart = outputCodeUnits;
        const previous = mapEntries[mapEntries.length - 1];
        if (
            previous !== undefined &&
            (span.start < previous.sourceEnd || outputStart < previous.outputEnd)
        ) {
            throw new RenderAbort(
                "RENDER_SOURCE_MAP",
                "Source-derived emissions are out of order"
            );
        }
        chunks.push(raw);
        outputCodeUnits += raw.length;
        appendMapEntry(span.start, span.end, outputStart, outputCodeUnits);
        sourceEmissionCount += 1;
        displayColumn = measured.endColumn;
        if (measured.containsLineBreak) {
            generatedColumnsOnLine = 0;
        }
        needsLinePrefix = measured.endsWithLineBreak;
    };

    const emitLinePrefix = (
        frame: Pick<DocFrame, "indentLevels" | "alignColumns">
    ): void => {
        if (!needsLinePrefix) {
            return;
        }
        const indentColumns = frame.indentLevels * 4;
        const totalColumns = indentColumns + frame.alignColumns;
        if (
            !Number.isSafeInteger(totalColumns) ||
            totalColumns > budget.maxGeneratedColumnsPerLine
        ) {
            throw new RenderAbort(
                "RENDER_RESOURCE_BUDGET",
                "Generated line prefix exceeds the column budget"
            );
        }
        if (totalColumns === 0) {
            needsLinePrefix = false;
            return;
        }
        const raw = artifact.options.indentStyle === "tab"
            ? "\t".repeat(frame.indentLevels) +
                " ".repeat(frame.alignColumns)
            : " ".repeat(totalColumns);
        needsLinePrefix = false;
        appendGenerated(raw, totalColumns, false);
    };

    const emitSpaces = (
        columns: number,
        frame: Pick<DocFrame, "indentLevels" | "alignColumns">
    ): void => {
        if (suffixes.length > 0) {
            const hadLineComment = flushSuffixes();
            if (hadLineComment) {
                appendGenerated("\n", 0, true);
            }
        }
        if (needsLinePrefix) {
            emitLinePrefix(frame);
        }
        if (columns > 0) {
            appendGenerated(" ".repeat(columns), columns, false);
        }
    };

    const emitPad = (
        targetColumn: number,
        frame: Pick<DocFrame, "indentLevels" | "alignColumns">
    ): void => {
        if (suffixes.length > 0) {
            const hadLineComment = flushSuffixes();
            if (hadLineComment) {
                appendGenerated("\n", 0, true);
            }
        }
        if (needsLinePrefix) {
            emitLinePrefix(frame);
        }
        if (displayColumn < targetColumn) {
            emitSpaces(targetColumn - displayColumn, frame);
        }
    };

    const suffixHasLineComment = (): boolean => {
        for (const suffix of suffixes) {
            if (
                artifact.analysis.leaves[suffix.commentLeafId]?.kind ===
                "line-comment"
            ) {
                return true;
            }
        }
        return false;
    };

    const flushSuffixes = (): boolean => {
        if (suffixes.length === 0) {
            return false;
        }
        const hadLineComment = suffixHasLineComment();
        const pending = suffixes.splice(0, suffixes.length);
        for (const suffix of pending) {
            const leaf = artifact.analysis.leaves[suffix.commentLeafId];
            if (leaf === undefined) {
                throw new RenderAbort(
                    "RENDER_SOURCE_MAP",
                    "Line-suffix source leaf is missing"
                );
            }
            const frame = {
                indentLevels: suffix.indentLevels,
                alignColumns: suffix.alignColumns,
            };
            if (suffix.spacing?.kind === "space") {
                emitSpaces(suffix.spacing.columns, frame);
            } else if (suffix.spacing?.kind === "pad-to-column") {
                emitPad(suffix.spacing.targetColumn, frame);
            }
            appendSource(leaf.raw, leaf.span, frame);
        }
        return hadLineComment;
    };

    const emitLineBreak = (): void => {
        flushSuffixes();
        appendGenerated("\n", 0, true);
    };

    const beforeSource = (raw: string): void => {
        if (suffixes.length === 0) {
            return;
        }
        const hadLineComment = flushSuffixes();
        if (hadLineComment && !startsWithLineBreak(raw)) {
            appendGenerated("\n", 0, true);
        }
    };

    const appendLeaf = (doc: Extract<LayoutDoc, { kind: "leaf" }>, frame: DocFrame): void => {
        const leaf = artifact.analysis.leaves[doc.leafId];
        if (leaf === undefined) {
            throw new RenderAbort(
                "RENDER_SOURCE_MAP",
                `Unknown source leaf ${String(doc.leafId)}`
            );
        }
        const raw = doc.transform === "raw"
            ? leaf.raw
            : applyKeywordCase(leaf.raw, artifact.options.keywordCase);
        if (raw === null || raw.length !== leaf.raw.length) {
            throw new RenderAbort(
                "RENDER_KEYWORD_TRANSFORM",
                `Keyword transform is not one-to-one for leaf ${doc.leafId}`
            );
        }
        beforeSource(raw);
        appendSource(raw, leaf.span, frame);
    };

    const appendVerbatim = (
        doc: Extract<LayoutDoc, { kind: "verbatim" }>,
        frame: DocFrame
    ): void => {
        const first = artifact.analysis.leaves[doc.leafRange.start];
        const last = artifact.analysis.leaves[doc.leafRange.end - 1];
        if (first === undefined || last === undefined) {
            throw new RenderAbort(
                "RENDER_SOURCE_MAP",
                `Invalid verbatim range for node ${String(doc.ownerNodeId)}`
            );
        }
        const span = frozenSpan(first.span.start, last.span.end);
        const raw = artifact.analysis.source.slice(span.start, span.end);
        beforeSource(raw);
        appendSource(raw, span, frame);
    };

    try {
        while (stack.length > 0) {
            const frame = stack.pop()!;
            const doc = frame.doc;
            docVisitCount += 1;
            if (docVisitCount > budget.maxDocNodes) {
                throw new RenderAbort(
                    "RENDER_RESOURCE_BUDGET",
                    "Renderer exceeded the document-node budget"
                );
            }
            switch (doc.kind) {
                case "leaf":
                    appendLeaf(doc, frame);
                    break;
                case "verbatim":
                    appendVerbatim(doc, frame);
                    break;
                case "space":
                    emitSpaces(doc.columns, frame);
                    break;
                case "line":
                    if (doc.mode === "hard" || frame.mode === "break") {
                        emitLineBreak();
                    } else if (doc.flat === "space") {
                        emitSpaces(1, frame);
                    }
                    break;
                case "concat":
                    for (let index = doc.parts.length - 1; index >= 0; index--) {
                        stack.push({
                            doc: doc.parts[index]!,
                            mode: frame.mode,
                            indentLevels: frame.indentLevels,
                            alignColumns: frame.alignColumns,
                        });
                    }
                    break;
                case "indent":
                    stack.push({
                        doc: doc.content,
                        mode: frame.mode,
                        indentLevels: frame.indentLevels + doc.levels,
                        alignColumns: frame.alignColumns,
                    });
                    break;
                case "align":
                    stack.push({
                        doc: doc.content,
                        mode: frame.mode,
                        indentLevels: frame.indentLevels,
                        alignColumns: frame.alignColumns + doc.columns,
                    });
                    break;
                case "pad-to-column":
                    emitPad(doc.targetColumn, frame);
                    break;
                case "group": {
                    let mode: "flat" | "break";
                    if (frame.mode === "flat") {
                        mode = "flat";
                    } else if (doc.mode === "auto") {
                        metricsLookupCount += 1;
                        const summary = metrics.summaryOf(doc.content);
                        mode =
                            summary !== null &&
                            summary.flatWidth !== null &&
                            summary.flatWidth <= doc.maxFlatWidth
                                ? "flat"
                                : "break";
                    } else {
                        mode = doc.mode;
                    }
                    stack.push({
                        doc: doc.content,
                        mode,
                        indentLevels: frame.indentLevels,
                        alignColumns: frame.alignColumns,
                    });
                    break;
                }
                case "line-suffix":
                    if (suffixes.length >= budget.maxPendingLineSuffixes) {
                        throw new RenderAbort(
                            "RENDER_RESOURCE_BUDGET",
                            "Renderer exceeded the pending line-suffix budget"
                        );
                    }
                    suffixes.push({
                        commentLeafId: doc.commentLeafId,
                        spacing: doc.spacing,
                        indentLevels: frame.indentLevels,
                        alignColumns: frame.alignColumns,
                    });
                    break;
            }
        }
        flushSuffixes();
        const text = chunks.join("");
        const sourceLeadingLineBreaks = leadingBoundaryLineBreakCount(
            artifact.analysis.source
        );
        const outputLeadingLineBreaks = leadingBoundaryLineBreakCount(text);
        const sourceTrailingLineBreaks = trailingBoundaryLineBreakCount(
            artifact.analysis.source
        );
        const outputTrailingLineBreaks = trailingBoundaryLineBreakCount(text);
        if (
            text.length !== outputCodeUnits ||
            endsWithLineBreak(text) !== endsWithLineBreak(artifact.analysis.source) ||
            outputLeadingLineBreaks > sourceLeadingLineBreaks ||
            outputTrailingLineBreaks > sourceTrailingLineBreaks
        ) {
            return failure(
                "RENDER_NEWLINE_CONTRACT",
                "Rendered text changed the target newline boundary contract"
            );
        }
        const sourceMap = freezeSourceMap(mapEntries);
        const statistics = Object.freeze({
            docVisitCount,
            metricsDocVisitCount: metrics.statistics.docVisitCount,
            metricsSummaryLookupCount:
                metrics.statistics.summaryLookupCount,
            metricsLookupCount,
            sourceEmissionCount,
            chunkCount: chunks.length,
            sourceMapEntryCount: sourceMap.entries.length,
            generatedWhitespaceCodeUnits,
        });
        return Object.freeze({ ok: true, text, sourceMap, statistics });
    } catch (error) {
        if (error instanceof RenderAbort) {
            return failure(error.code, error.message);
        }
        return failure("RENDER_INTERNAL", "Layout rendering failed");
    }
}

/** Fail-closed SQL-agnostic renderer for exact canonical LayoutArtifact objects. */
export function renderLayoutArtifact(value: unknown): RenderResult {
    try {
        if (!isCanonicalLayoutArtifact(value)) {
            return failure(
                "RENDER_ARTIFACT_PROVENANCE",
                "Renderer requires an exact canonical LayoutArtifact"
            );
        }
        const measured = measureLayoutArtifact(value);
        if (!measured.ok) {
            return failure("RENDER_METRICS", measured.message);
        }
        const rendered = renderCanonical(value, measured.metrics);
        if (rendered.ok) {
            CANONICAL_RENDER_ARTIFACTS.set(rendered, value);
        }
        return rendered;
    } catch {
        return failure("RENDER_INTERNAL", "Renderer boundary inspection failed");
    }
}
