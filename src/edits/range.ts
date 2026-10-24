import { analyzeSql } from "../core/analysis/analyze";
import type { AnalyzedArtifact } from "../core/analysis/types";
import { lexSql } from "../core/lexer/lossless-lexer";
import type { SourceLeaf } from "../core/lexer/token";
import type { EditTarget } from "./types";

// Range validation (plan §5.4): the low-level tools are shared; each operation keeps its own
// acceptance rules. Offsets are UTF-16 code units; a position between CR and LF is no line boundary.

export function isLineStart(source: string, offset: number): boolean {
    if (offset === 0) {
        return true;
    }
    const previous = source[offset - 1];
    return previous === "\n" || (previous === "\r" && source[offset] !== "\n");
}

export function isLineEnd(source: string, offset: number): boolean {
    if (offset === source.length) {
        return true;
    }
    const current = source[offset];
    const previous = source[offset - 1];
    if (current === "\n" && previous === "\r") {
        return false;
    }
    return current === "\n" || current === "\r" || previous === "\n" || previous === "\r";
}

/** The index of the leaf whose span contains `offset`, or -1 past the last leaf. */
export function leafIndexAt(leaves: readonly SourceLeaf[], offset: number): number {
    let low = 0;
    let high = leaves.length;
    while (low < high) {
        const middle = (low + high) >>> 1;
        if (leaves[middle]!.span.end <= offset) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    return low < leaves.length ? low : -1;
}

/** Whether `offset` falls strictly inside a protected leaf (string, quoted name, template) or a comment. */
export function cutsProtectedLeaf(leaves: readonly SourceLeaf[], offset: number): boolean {
    const leaf = leaves[leafIndexAt(leaves, offset)];
    return leaf !== undefined &&
        leaf.span.start < offset &&
        (leaf.channel === "protected" || leaf.kind === "line-comment" || leaf.kind === "block-comment");
}

export type FormatRangeCode =
    | "ADAPTER_RANGE_LINE"
    | "ADAPTER_RANGE_PROTECTED"
    | "ADAPTER_RANGE_EMPTY"
    | "ADAPTER_RANGE_ANALYSIS"
    | "ADAPTER_RANGE_OPAQUE"
    | "ADAPTER_RANGE_OWNERSHIP";

export const FORMAT_RANGE_MESSAGES: Readonly<Record<FormatRangeCode, string>> = {
    ADAPTER_RANGE_LINE: "The selected range must cover complete safe lines",
    ADAPTER_RANGE_PROTECTED: "The selected range crosses protected SQL text",
    ADAPTER_RANGE_EMPTY: "The selected range contains no SQL",
    ADAPTER_RANGE_ANALYSIS: "The selected range could not be analyzed safely",
    ADAPTER_RANGE_OPAQUE: "The selected range crosses an opaque SQL region",
    ADAPTER_RANGE_OWNERSHIP: "The selected range crosses a syntax ownership boundary",
};

export type FormatRangeValidation =
    | { readonly ok: true; readonly modes: ReadonlyMap<string, "document" | "fragment"> }
    | { readonly ok: false; readonly code: FormatRangeCode; readonly target: EditTarget };

interface Span {
    readonly start: number;
    readonly end: number;
}

/** What a query fragment may cover: statement, clause and list nodes, and opaque regions to avoid. */
interface FormatEvidence {
    readonly artifact: AnalyzedArtifact;
    /** Content spans (first to last non-trivia leaf) of statement, clause and list nodes. */
    readonly owned: ReadonlySet<string>;
    readonly statements: readonly Span[];
    readonly opaque: readonly Span[];
}

function spanKey(span: Span): string {
    return `${String(span.start)}:${String(span.end)}`;
}

/** The span from the first to the last non-trivia leaf of `[start, end)`, or null if there is none. */
function contentSpan(leaves: readonly SourceLeaf[], start: number, end: number): Span | null {
    let first = start;
    while (first < end && leaves[first]!.channel === "trivia") {
        first += 1;
    }
    let last = end - 1;
    while (last >= first && leaves[last]!.channel === "trivia") {
        last -= 1;
    }
    return first > last ? null : { start: leaves[first]!.span.start, end: leaves[last]!.span.end };
}

function formatEvidence(artifact: AnalyzedArtifact): FormatEvidence {
    const owned = new Set<string>();
    const statements: Span[] = [];
    const opaque: Span[] = [];
    for (const node of artifact.index.nodes()) {
        if (node.kind === "opaque") {
            opaque.push(node.span);
        } else if (node.kind === "statement" || node.kind === "clause" || node.kind === "list") {
            const span = contentSpan(artifact.leaves, node.leafRange.start, node.leafRange.end);
            if (span !== null) {
                owned.add(spanKey(span));
                if (node.kind === "statement") {
                    statements.push(span);
                }
            }
        }
    }
    statements.sort((left, right) => left.start - right.start);
    return { artifact, owned, statements, opaque };
}

/** Whether `span` runs from the start of one statement to the end of a later one. */
function coversStatements(span: Span, statements: readonly Span[]): boolean {
    const first = statements.findIndex((statement) => statement.start === span.start);
    const last = statements.findIndex((statement) => statement.end === span.end);
    return first >= 0 && last > first;
}

function validateFormatTarget(
    source: string,
    target: EditTarget,
    evidence: FormatEvidence | null
): FormatRangeCode | "document" | "fragment" {
    if (target.mode === "document" || (target.start === 0 && target.end === source.length)) {
        return "document";
    }
    if (target.start === target.end) {
        return "fragment";
    }
    if (evidence === null) {
        return "ADAPTER_RANGE_ANALYSIS";
    }
    const leaves = evidence.artifact.leaves;
    if (cutsProtectedLeaf(leaves, target.start) || cutsProtectedLeaf(leaves, target.end)) {
        return "ADAPTER_RANGE_PROTECTED";
    }
    if (!isLineStart(source, target.start) || !isLineEnd(source, target.end)) {
        return "ADAPTER_RANGE_LINE";
    }
    if (evidence.opaque.some((span) => span.start < target.end && target.start < span.end)) {
        return "ADAPTER_RANGE_OPAQUE";
    }
    const span = contentSpan(
        leaves,
        leafIndexAt(leaves, target.start),
        leafIndexAt(leaves, target.end - 1) + 1
    );
    if (span === null) {
        return "ADAPTER_RANGE_EMPTY";
    }
    if (evidence.owned.has(spanKey(span))) {
        return "fragment";
    }
    // Contiguous whole statements format as a document.
    return coversStatements(span, evidence.statements) ? "document" : "ADAPTER_RANGE_OWNERSHIP";
}

/**
 * Query targets must cover complete lines and one statement, clause or list, or contiguous
 * statements; the whole document and empty targets always pass. Returns each target's parse mode.
 */
export function validateFormatTargets(
    source: string,
    targets: readonly EditTarget[]
): FormatRangeValidation {
    let evidence: FormatEvidence | null = null;
    if (targets.some((target) =>
        target.mode === "fragment" &&
        target.start !== target.end &&
        !(target.start === 0 && target.end === source.length)
    )) {
        const artifact = analyzeSql(source, { mode: "document" });
        evidence = artifact.status === "analyzed" ? formatEvidence(artifact) : null;
    }
    const modes = new Map<string, "document" | "fragment">();
    for (const target of targets) {
        const result = validateFormatTarget(source, target, evidence);
        if (result !== "document" && result !== "fragment") {
            return { ok: false, code: result, target };
        }
        modes.set(target.id, result);
    }
    return { ok: true, modes };
}

function isBlank(character: string | undefined): boolean {
    return character === " " || character === "\t";
}

/** Where the run of spaces and tabs that ends at `offset` starts. */
export function blankRunStart(source: string, offset: number): number {
    let index = offset;
    while (index > 0 && isBlank(source[index - 1])) {
        index -= 1;
    }
    return index;
}

/** Where the run of spaces and tabs that starts at `offset` ends. */
export function blankRunEnd(source: string, offset: number): number {
    let index = offset;
    while (index < source.length && isBlank(source[index])) {
        index += 1;
    }
    return index;
}

/**
 * DDL and Extract targets must be non-empty, have only blanks between them and a line start and a
 * line end, avoid lexical errors and protected leaves, and contain code. A target may end at column 0
 * of the next line, as query targets do (K18). Returns the first invalid target.
 */
export function invalidDdlTarget(source: string, targets: readonly EditTarget[]): EditTarget | null {
    const lexed = lexSql(source);
    for (const target of targets) {
        if (
            target.start === target.end ||
            !isLineStart(source, blankRunStart(source, target.start)) ||
            !(isLineEnd(source, target.end) || isLineEnd(source, blankRunEnd(source, target.end))) ||
            lexed.diagnostics.some((diagnostic) =>
                diagnostic.span.start < target.end && target.start < diagnostic.span.end
            ) ||
            cutsProtectedLeaf(lexed.leaves, target.start) ||
            cutsProtectedLeaf(lexed.leaves, target.end) ||
            !lexed.leaves.some((leaf) =>
                leaf.channel === "code" && leaf.span.start < target.end && target.start < leaf.span.end
            )
        ) {
            return target;
        }
    }
    return null;
}
