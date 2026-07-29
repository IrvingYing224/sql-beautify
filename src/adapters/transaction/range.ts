import { analyzeSql } from "../../core/analysis/analyze";
import type { AnalysisArtifact } from "../../core/analysis/types";
import type { FormatOptions } from "../../core/config/options";
import { resolveFormatOptions } from "../../core/config/resolve-options";
import type { SourceLeaf } from "../../core/lexer/token";
import type { FormatTarget } from "./types";
import {
    snapshotDenseDataArray,
} from "../boundary/data-snapshot";
import { snapshotFormatTarget } from "./target-snapshot";
import { safeDiagnosticMessage } from "../diagnostics/safe-messages";

export type RangeValidationCode =
    | "ADAPTER_RANGE_TARGET"
    | "ADAPTER_RANGE_DOCUMENT"
    | "ADAPTER_RANGE_LINE"
    | "ADAPTER_RANGE_PROTECTED"
    | "ADAPTER_RANGE_EMPTY"
    | "ADAPTER_RANGE_ANALYSIS"
    | "ADAPTER_RANGE_OPAQUE"
    | "ADAPTER_RANGE_OWNERSHIP";

export interface ValidRangeValidation {
    readonly status: "valid";
    readonly safe: true;
    readonly code: null;
    readonly message: null;
    readonly targetId: null;
    readonly targetModes: readonly ValidatedTargetMode[];
}

export interface ValidatedTargetMode {
    readonly targetId: string;
    readonly mode: "document" | "fragment";
}

export interface InvalidRangeValidation {
    readonly status: "invalid";
    readonly safe: false;
    readonly code: RangeValidationCode;
    readonly message: string;
    readonly targetId: string | null;
}

export type RangeValidation = ValidRangeValidation | InvalidRangeValidation;

function valid(
    targetModes: readonly ValidatedTargetMode[]
): ValidRangeValidation {
    return Object.freeze({
        status: "valid" as const,
        safe: true as const,
        code: null,
        message: null,
        targetId: null,
        targetModes: Object.freeze(Array.from(targetModes)),
    });
}

const RANGE_VALIDATION_CODES: ReadonlySet<string> = new Set([
    "ADAPTER_RANGE_TARGET",
    "ADAPTER_RANGE_DOCUMENT",
    "ADAPTER_RANGE_LINE",
    "ADAPTER_RANGE_PROTECTED",
    "ADAPTER_RANGE_EMPTY",
    "ADAPTER_RANGE_ANALYSIS",
    "ADAPTER_RANGE_OPAQUE",
    "ADAPTER_RANGE_OWNERSHIP",
]);

export function isRangeValidationCode(
    value: unknown
): value is RangeValidationCode {
    return typeof value === "string" && RANGE_VALIDATION_CODES.has(value);
}

export function rangeValidationMessage(code: RangeValidationCode): string {
    return safeDiagnosticMessage(code, null);
}

interface ContentBoundary {
    readonly start: number;
    readonly end: number;
}

interface RangeEvidence {
    readonly artifact: AnalysisArtifact;
    readonly ownedBoundaries: ReadonlySet<string>;
    readonly statementBoundaries: readonly ContentBoundary[];
    readonly opaqueSpans: readonly ContentBoundary[];
}

function fail(
    code: RangeValidationCode,
    targetId: string | null
): InvalidRangeValidation {
    return Object.freeze({
        status: "invalid",
        safe: false,
        code,
        message: safeDiagnosticMessage(code, null),
        targetId,
    });
}

function isLineStart(source: string, offset: number): boolean {
    if (offset === 0) {
        return true;
    }
    const previous = source[offset - 1];
    // A position between the two UTF-16 units of CRLF is not a line boundary.
    return previous === "\n" || (previous === "\r" && source[offset] !== "\n");
}

function isLineEnd(source: string, offset: number): boolean {
    if (offset === source.length) {
        return true;
    }
    if (source[offset] === "\n" && source[offset - 1] === "\r") {
        return false;
    }
    const current = source[offset];
    const previous = source[offset - 1];
    return (
        current === "\n" ||
        current === "\r" ||
        previous === "\n" ||
        (previous === "\r" && current !== "\n")
    );
}

function isTrivia(leaf: SourceLeaf): boolean {
    return leaf.channel === "trivia";
}

function boundaryInsideProtectedOrComment(
    offset: number,
    evidence: RangeEvidence
): boolean {
    const index = evidence.artifact.index;
    if (index === null) {
        return false;
    }
    const location = index.offsetToLeaf(offset);
    if (location === null) {
        return false;
    }
    const leaf = evidence.artifact.leaves[location.leafId];
    return (
        leaf !== undefined &&
        location.relativeOffset > 0 &&
        location.relativeOffset < leaf.raw.length &&
        (leaf.channel === "protected" ||
            leaf.kind === "line-comment" ||
            leaf.kind === "block-comment")
    );
}

function contentBoundaryForTarget(
    startOffset: number,
    endOffset: number,
    leaves: readonly SourceLeaf[]
): ContentBoundary | null {
    let start: number | null = null;
    let end: number | null = null;
    for (const leaf of leaves) {
        if (
            isTrivia(leaf) ||
            leaf.span.start >= endOffset ||
            startOffset >= leaf.span.end
        ) {
            continue;
        }
        start ??= leaf.span.start;
        end = leaf.span.end;
    }
    return start === null || end === null ? null : { start, end };
}

function boundaryKey(boundary: ContentBoundary): string {
    return `${String(boundary.start)}:${String(boundary.end)}`;
}

function buildRangeEvidence(artifact: AnalysisArtifact): RangeEvidence | null {
    if (artifact.index === null) {
        return null;
    }
    const leaves = artifact.leaves;
    const nextSyntaxLeaf = new Int32Array(leaves.length + 1);
    const previousSyntaxLeaf = new Int32Array(leaves.length + 1);
    nextSyntaxLeaf.fill(-1);
    previousSyntaxLeaf.fill(-1);
    for (let leafId = leaves.length - 1; leafId >= 0; leafId -= 1) {
        nextSyntaxLeaf[leafId] = isTrivia(leaves[leafId]!)
            ? nextSyntaxLeaf[leafId + 1]!
            : leafId;
    }
    for (let boundary = 1; boundary <= leaves.length; boundary += 1) {
        const leafId = boundary - 1;
        previousSyntaxLeaf[boundary] = isTrivia(leaves[leafId]!)
            ? previousSyntaxLeaf[boundary - 1]!
            : leafId;
    }

    const ownedBoundaries = new Set<string>();
    const statementBoundaries: ContentBoundary[] = [];
    const opaqueSpans: ContentBoundary[] = [];
    for (const node of artifact.index.nodes()) {
        if (node.kind === "opaque") {
            opaqueSpans.push(node.span);
            continue;
        }
        if (
            node.kind !== "statement" &&
            node.kind !== "clause" &&
            node.kind !== "list"
        ) {
            continue;
        }
        const firstLeafId = nextSyntaxLeaf[node.leafRange.start]!;
        const lastLeafId = previousSyntaxLeaf[node.leafRange.end]!;
        if (
            firstLeafId < node.leafRange.start ||
            firstLeafId >= node.leafRange.end ||
            lastLeafId < node.leafRange.start ||
            lastLeafId >= node.leafRange.end
        ) {
            continue;
        }
        const boundary = Object.freeze({
            start: leaves[firstLeafId]!.span.start,
            end: leaves[lastLeafId]!.span.end,
        });
        ownedBoundaries.add(boundaryKey(boundary));
        if (node.kind === "statement") {
            statementBoundaries.push(boundary);
        }
    }
    return {
        artifact,
        ownedBoundaries,
        statementBoundaries: Object.freeze(statementBoundaries.sort(
            (left, right) => left.start - right.start || left.end - right.end
        )),
        opaqueSpans: Object.freeze(opaqueSpans.slice()),
    };
}

function intersectsOpaque(
    start: number,
    end: number,
    evidence: RangeEvidence
): boolean {
    return evidence.opaqueSpans.some(
        (span) => span.start < end && start < span.end
    );
}

function isCompleteStatementSequence(
    boundary: ContentBoundary,
    evidence: RangeEvidence
): boolean {
    const statements = evidence.statementBoundaries;
    let low = 0;
    let high = statements.length - 1;
    let first = -1;
    while (low <= high) {
        const middle = low + Math.floor((high - low) / 2);
        const start = statements[middle]!.start;
        if (start < boundary.start) {
            low = middle + 1;
        } else if (start > boundary.start) {
            high = middle - 1;
        } else {
            first = middle;
            break;
        }
    }
    if (first < 0) {
        return false;
    }
    for (let index = first; index < statements.length; index++) {
        const end = statements[index]!.end;
        if (end === boundary.end) {
            return index > first;
        }
        if (end > boundary.end) {
            return false;
        }
    }
    return false;
}

type TargetValidation =
    | InvalidRangeValidation
    | Readonly<{ readonly safe: true; readonly mode: "document" | "fragment" }>;

const VALID_DOCUMENT_TARGET: TargetValidation = Object.freeze({
    safe: true,
    mode: "document",
});
const VALID_FRAGMENT_TARGET: TargetValidation = Object.freeze({
    safe: true,
    mode: "fragment",
});

function validateTarget(
    source: string,
    target: FormatTarget,
    evidence: RangeEvidence | null
): TargetValidation {
    if (
        target.start < 0 ||
        target.end < target.start ||
        target.end > source.length
    ) {
        return fail("ADAPTER_RANGE_TARGET", target.id);
    }
    if (target.mode === "document") {
        return target.start === 0 && target.end === source.length
            ? VALID_DOCUMENT_TARGET
            : fail("ADAPTER_RANGE_DOCUMENT", target.id);
    }
    if (target.start === target.end) {
        return VALID_FRAGMENT_TARGET;
    }
    if (target.start === 0 && target.end === source.length) {
        return VALID_DOCUMENT_TARGET;
    }
    if (
        evidence === null ||
        evidence.artifact.status === "failed" ||
        evidence.artifact.status === "preserved" ||
        evidence.artifact.index === null
    ) {
        return fail("ADAPTER_RANGE_ANALYSIS", target.id);
    }
    if (
        boundaryInsideProtectedOrComment(target.start, evidence) ||
        boundaryInsideProtectedOrComment(target.end, evidence)
    ) {
        return fail("ADAPTER_RANGE_PROTECTED", target.id);
    }
    if (!isLineStart(source, target.start) || !isLineEnd(source, target.end)) {
        return fail("ADAPTER_RANGE_LINE", target.id);
    }
    if (intersectsOpaque(target.start, target.end, evidence)) {
        return fail("ADAPTER_RANGE_OPAQUE", target.id);
    }
    const boundary = contentBoundaryForTarget(
        target.start,
        target.end,
        evidence.artifact.leaves
    );
    if (boundary === null) {
        return fail("ADAPTER_RANGE_EMPTY", target.id);
    }
    if (evidence.ownedBoundaries.has(boundaryKey(boundary))) {
        return VALID_FRAGMENT_TARGET;
    }
    return isCompleteStatementSequence(boundary, evidence)
        ? VALID_DOCUMENT_TARGET
        : fail("ADAPTER_RANGE_OWNERSHIP", target.id);
}

/** Validates all targets against at most one analysis of the complete source. */
export function validateFormatTargetRanges(
    source: unknown,
    values: unknown,
    options: FormatOptions | undefined = undefined
): RangeValidation {
    const rawTargets = snapshotDenseDataArray(values);
    if (typeof source !== "string" || rawTargets === null) {
        return fail("ADAPTER_RANGE_TARGET", null);
    }
    const resolvedOptions = resolveFormatOptions(options);
    if (!resolvedOptions.ok) {
        return fail("ADAPTER_RANGE_ANALYSIS", null);
    }
    const targets: FormatTarget[] = [];
    const ids = new Set<string>();
    for (const value of rawTargets) {
        const target = snapshotFormatTarget(value, source.length, true, false);
        if (target === null || ids.has(target.id)) {
            return fail("ADAPTER_RANGE_TARGET", target?.id ?? null);
        }
        ids.add(target.id);
        targets.push(target);
    }

    let evidence: RangeEvidence | null = null;
    if (
        targets.some(
            (target) =>
                target.mode === "fragment" &&
                target.start !== target.end &&
                !(target.start === 0 && target.end === source.length)
        )
    ) {
        try {
            const artifact = analyzeSql(source, {
                dialect: resolvedOptions.options.dialect,
                mode: "document",
            });
            if (artifact.status === "analyzed") {
                evidence = buildRangeEvidence(artifact);
            }
        } catch {
            return fail("ADAPTER_RANGE_ANALYSIS", null);
        }
    }

    const targetModes: ValidatedTargetMode[] = [];
    for (const target of targets) {
        const result = validateTarget(source, target, evidence);
        if (!result.safe) {
            return result;
        }
        targetModes.push(Object.freeze({
            targetId: target.id,
            mode: result.mode,
        }));
    }
    return valid(targetModes);
}

/** Compatibility wrapper for existing single-fragment host adapters. */
export function validateFormatRange(
    source: unknown,
    start: unknown,
    end: unknown,
    options: FormatOptions | undefined
): RangeValidation {
    return validateFormatTargetRanges(
        source,
        [{ id: "fragment", start, end, mode: "fragment" }],
        options
    );
}
