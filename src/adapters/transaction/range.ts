import { analyzeSql } from "../../core/analysis/analyze";
import type { AnalysisArtifact } from "../../core/analysis/types";
import type { FormatOptions } from "../../core/config/options";
import { resolveFormatOptions } from "../../core/config/resolve-options";
import type { SourceLeaf } from "../../core/lexer/token";
import type { FormatTarget } from "./types";
import {
    snapshotDataProperties,
    snapshotDenseDataArray,
} from "../boundary/data-snapshot";

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
}

export interface InvalidRangeValidation {
    readonly status: "invalid";
    readonly safe: false;
    readonly code: RangeValidationCode;
    readonly message: string;
    readonly targetId: string | null;
}

export type RangeValidation = ValidRangeValidation | InvalidRangeValidation;

const VALID: ValidRangeValidation = Object.freeze({
    status: "valid",
    safe: true,
    code: null,
    message: null,
    targetId: null,
});

const TARGET_KEYS: ReadonlySet<string> = new Set([
    "id",
    "start",
    "end",
    "mode",
    "selection",
]);

const MESSAGES: Readonly<Record<RangeValidationCode, string>> = Object.freeze({
    ADAPTER_RANGE_TARGET: "Formatter range target is invalid.",
    ADAPTER_RANGE_DOCUMENT: "Document target must cover the complete source.",
    ADAPTER_RANGE_LINE: "Formatter fragment must cover complete physical lines.",
    ADAPTER_RANGE_PROTECTED:
        "Formatter fragment boundary falls inside protected or comment text.",
    ADAPTER_RANGE_EMPTY: "Formatter fragment contains no syntax boundary.",
    ADAPTER_RANGE_ANALYSIS: "Formatter fragment analysis is not safe for editing.",
    ADAPTER_RANGE_OPAQUE: "Formatter fragment intersects opaque syntax.",
    ADAPTER_RANGE_OWNERSHIP:
        "Formatter fragment does not match a complete syntax boundary.",
});

interface ContentBoundary {
    readonly start: number;
    readonly end: number;
}

interface RangeEvidence {
    readonly artifact: AnalysisArtifact;
    readonly ownedBoundaries: ReadonlySet<string>;
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
        message: MESSAGES[code],
        targetId,
    });
}

function snapshotTarget(value: unknown): FormatTarget | null {
    try {
        const raw = snapshotDataProperties(
            value,
            TARGET_KEYS,
            ["id", "start", "end", "mode"]
        );
        if (raw === null) {
            return null;
        }
        const id = raw.id;
        const start = raw.start;
        const end = raw.end;
        const mode = raw.mode;
        if (
            typeof id !== "string" ||
            id.length === 0 ||
            !Number.isSafeInteger(start) ||
            !Number.isSafeInteger(end) ||
            (mode !== "document" && mode !== "fragment")
        ) {
            return null;
        }
        return Object.freeze({ id, start, end, mode }) as FormatTarget;
    } catch {
        return null;
    }
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
        ownedBoundaries.add(
            boundaryKey({
                start: leaves[firstLeafId]!.span.start,
                end: leaves[lastLeafId]!.span.end,
            })
        );
    }
    return {
        artifact,
        ownedBoundaries,
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

function validateTarget(
    source: string,
    target: FormatTarget,
    evidence: RangeEvidence | null
): RangeValidation {
    if (
        target.start < 0 ||
        target.end < target.start ||
        target.end > source.length
    ) {
        return fail("ADAPTER_RANGE_TARGET", target.id);
    }
    if (target.mode === "document") {
        return target.start === 0 && target.end === source.length
            ? VALID
            : fail("ADAPTER_RANGE_DOCUMENT", target.id);
    }
    if (target.start === target.end) {
        return VALID;
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
    return evidence.ownedBoundaries.has(boundaryKey(boundary))
        ? VALID
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
        const target = snapshotTarget(value);
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
                target.mode === "fragment" && target.start !== target.end
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

    for (const target of targets) {
        const result = validateTarget(source, target, evidence);
        if (!result.safe) {
            return result;
        }
    }
    return VALID;
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
