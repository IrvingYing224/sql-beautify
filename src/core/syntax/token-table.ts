import { isImmutableSourceLeafPartitionForSource } from "../lexer/lossless-lexer";
import type { SourceLeaf } from "../lexer/token";
import type { SourceSpan } from "../source/source-span";
import { freezeImmutableArray } from "../util/immutable-array";
import type { LeafRange } from "./leaf-range";

export type StructuralIssueCode =
    | "STRUCT_UNMATCHED_OPENER"
    | "STRUCT_UNMATCHED_CLOSER"
    | "STRUCT_MIXED_DELIMITER"
    | "STRUCT_UNRELIABLE_STATEMENT_BOUNDARY";

export interface StructuralIssue {
    readonly code: StructuralIssueCode;
    readonly leafIndex: number;
    readonly message: string;
}

/**
 * Structural token table over canonical SourceLeaf[].
 *
 * Distinguishes:
 * - syntax leaves: channel code | protected (parser adjacency / cursor)
 * - structural code leaves: channel === "code" only (delimiter / semicolon /
 *   normalized word). Protected punctuation interiors are never scanned.
 *
 * Built with bounded multi-pass O(n) scans (adjacency, delimiters, statements).
 * Does not re-lex and does not scan protected leaf interiors.
 */
export interface StructuralTokenTable {
    leafCount(): number;

    /** Non-trivia syntax leaves: channel code or protected. */
    syntaxLeafCount(): number;
    previousSyntaxLeafIndex(leafIndex: number): number | null;
    nextSyntaxLeafIndex(leafIndex: number): number | null;
    syntaxOrdinalOfLeaf(leafIndex: number): number;
    leafIndexOfSyntaxOrdinal(ordinal: number): number;

    /**
     * Structural code leaves only (channel === "code").
     * Used for delimiter pairing, semicolon segmentation, normalized words.
     */
    codeLeafCount(): number;
    previousCodeLeafIndex(leafIndex: number): number | null;
    nextCodeLeafIndex(leafIndex: number): number | null;
    codeOrdinalOfLeaf(leafIndex: number): number;
    leafIndexOfCodeOrdinal(ordinal: number): number;

    depthBefore(leafIndex: number): number;
    depthAfter(leafIndex: number): number;
    matchingDelimiterIndex(leafIndex: number): number | null;
    statementRanges(): readonly LeafRange[];
    statementBoundariesReliable(): boolean;
    structuralIssues(): readonly StructuralIssue[];
    rangeToSpan(range: LeafRange): SourceSpan;
    normalizedWord(leafIndex: number): string;
    codeWordsEqual(leftLeafIndex: number, rightLeafIndex: number): boolean;
    getLeaf(leafIndex: number): SourceLeaf;
}

const OPENERS: Readonly<Record<string, string>> = Object.freeze({
    "(": ")",
    "[": "]",
});

const CLOSERS: Readonly<Record<string, string>> = Object.freeze({
    ")": "(",
    "]": "[",
});

interface CanonicalStructuralTokenTableProof {
    readonly leaves: readonly SourceLeaf[];
    readonly canonicalSourcePartition: boolean;
    readonly rangeToSpan: (range: LeafRange) => SourceSpan;
}

const CANONICAL_STRUCTURAL_TOKEN_TABLE_PROOFS = new WeakMap<
    object,
    CanonicalStructuralTokenTableProof
>();
const NO_INDEX = -1;

/** Internal proof that the table owns immutable facts from the canonical builder. */
export function isCanonicalStructuralTokenTable(
    value: unknown
): value is StructuralTokenTable {
    return (
        typeof value === "object" &&
        value !== null &&
        CANONICAL_STRUCTURAL_TOKEN_TABLE_PROOFS.has(value)
    );
}

/** Internal proof that a canonical table was built over this exact leaf partition. */
export function isCanonicalStructuralTokenTableForLeaves(
    value: unknown,
    leaves: readonly SourceLeaf[]
): value is StructuralTokenTable {
    if (typeof value !== "object" || value === null) {
        return false;
    }
    const proof = CANONICAL_STRUCTURAL_TOKEN_TABLE_PROOFS.get(value);
    return proof?.leaves === leaves && proof.canonicalSourcePartition;
}

/** Internal provenance lookup for the exact leaf partition owned by a table. */
export function canonicalStructuralTokenTableLeaves(
    value: unknown
): readonly SourceLeaf[] | null {
    if (typeof value !== "object" || value === null) {
        return null;
    }
    const proof = CANONICAL_STRUCTURAL_TOKEN_TABLE_PROOFS.get(value);
    return proof?.canonicalSourcePartition === true ? proof.leaves : null;
}

/** Internal node-factory seam for ranges already validated by freezeRange(). */
export function canonicalRangeToSpan(
    table: StructuralTokenTable
): ((range: LeafRange) => SourceSpan) | null {
    return CANONICAL_STRUCTURAL_TOKEN_TABLE_PROOFS.get(table)?.rangeToSpan ?? null;
}

function isSyntaxLeaf(leaf: SourceLeaf): boolean {
    return leaf.channel === "code" || leaf.channel === "protected";
}

function isStructuralCodeLeaf(leaf: SourceLeaf): boolean {
    return leaf.channel === "code";
}

export function buildStructuralTokenTable(
    leaves: readonly SourceLeaf[],
    source: string
): StructuralTokenTable {
    const canonicalSourcePartition =
        isImmutableSourceLeafPartitionForSource(leaves, source);
    const n = leaves.length;

    const syntaxIndexStorage = new Uint32Array(n);
    const codeIndexStorage = new Uint32Array(n);
    const syntaxOrdinal = new Int32Array(n);
    const codeOrdinal = new Int32Array(n);
    const depthBeforeArr = new Uint32Array(n);
    const depthAfterArr = new Uint32Array(n);
    const match = new Int32Array(n);
    syntaxOrdinal.fill(NO_INDEX);
    codeOrdinal.fill(NO_INDEX);
    match.fill(NO_INDEX);
    const issues: StructuralIssue[] = [];

    // One bounded pass derives ordinals, delimiter facts, and reliable
    // statement boundaries from the same immutable leaf stream.
    let syntaxCount = 0;
    let codeCount = 0;
    type StackEntry = { index: number; expectedCloser: string; openRaw: string };
    const stack: StackEntry[] = [];
    const statementRanges: LeafRange[] = [];
    let depth = 0;
    let unreliable = false;
    let firstDelimiterIssueAt = Number.POSITIVE_INFINITY;
    let unreliableBoundaryLeafIndex: number | null = null;
    let statementSplittingStopped = false;
    let stmtStart = 0;

    for (let i = 0; i < n; i++) {
        const leaf = leaves[i];
        if (!leaf) {
            continue;
        }
        if (isSyntaxLeaf(leaf)) {
            syntaxOrdinal[i] = syntaxCount;
            syntaxIndexStorage[syntaxCount] = i;
            syntaxCount += 1;
        }
        if (!isStructuralCodeLeaf(leaf)) {
            depthBeforeArr[i] = depth;
            depthAfterArr[i] = depth;
            continue;
        }
        codeOrdinal[i] = codeCount;
        codeIndexStorage[codeCount] = i;
        codeCount += 1;

        depthBeforeArr[i] = depth;
        const raw = leaf.raw;

        if (OPENERS[raw] !== undefined) {
            stack.push({ index: i, expectedCloser: OPENERS[raw]!, openRaw: raw });
            depth += 1;
            depthAfterArr[i] = depth;
        } else if (CLOSERS[raw] !== undefined) {
            if (stack.length === 0) {
                issues.push(
                    Object.freeze({
                        code: "STRUCT_UNMATCHED_CLOSER" as const,
                        leafIndex: i,
                        message: `Unmatched closer ${raw} at leaf ${i}`,
                    })
                );
                unreliable = true;
                firstDelimiterIssueAt = Math.min(firstDelimiterIssueAt, i);
                depthAfterArr[i] = depth;
            } else {
                const top = stack[stack.length - 1]!;
                if (top.expectedCloser !== raw) {
                    issues.push(
                        Object.freeze({
                            code: "STRUCT_MIXED_DELIMITER" as const,
                            leafIndex: i,
                            message: `Mixed delimiter: expected ${top.expectedCloser} for ${top.openRaw}, found ${raw} at leaf ${i}`,
                        })
                    );
                    unreliable = true;
                    firstDelimiterIssueAt = Math.min(firstDelimiterIssueAt, i);
                    stack.pop();
                    depth = Math.max(0, depth - 1);
                    depthAfterArr[i] = depth;
                } else {
                    stack.pop();
                    depth = Math.max(0, depth - 1);
                    match[top.index] = i;
                    match[i] = top.index;
                    depthAfterArr[i] = depth;
                }
            }
        } else {
            depthAfterArr[i] = depth;
        }

        if (
            !statementSplittingStopped &&
            raw === ";" &&
            depthBeforeArr[i] === 0 &&
            depthAfterArr[i] === 0
        ) {
            if (firstDelimiterIssueAt < i) {
                unreliableBoundaryLeafIndex = i;
                statementSplittingStopped = true;
            } else {
                statementRanges.push(Object.freeze({ start: stmtStart, end: i + 1 }));
                stmtStart = i + 1;
            }
        }
    }

    while (stack.length > 0) {
        const open = stack.pop()!;
        issues.push(
            Object.freeze({
                code: "STRUCT_UNMATCHED_OPENER" as const,
                leafIndex: open.index,
                message: `Unmatched opener ${open.openRaw} at leaf ${open.index}`,
            })
        );
        unreliable = true;
        firstDelimiterIssueAt = Math.min(firstDelimiterIssueAt, open.index);
    }

    if (
        stmtStart < n &&
        syntaxCount > 0 &&
        syntaxIndexStorage[syntaxCount - 1]! >= stmtStart
    ) {
        statementRanges.push(Object.freeze({ start: stmtStart, end: n }));
    }

    if (unreliableBoundaryLeafIndex !== null) {
        issues.push(
            Object.freeze({
                code: "STRUCT_UNRELIABLE_STATEMENT_BOUNDARY" as const,
                leafIndex: unreliableBoundaryLeafIndex,
                message:
                    "Statement boundary is unreliable; subsequent top-level splits are not trusted",
            })
        );
    }

    const boundariesReliable = !unreliable;

    if (
        unreliable &&
        !issues.some((x) => x.code === "STRUCT_UNRELIABLE_STATEMENT_BOUNDARY")
    ) {
        const anchor =
            Number.isFinite(firstDelimiterIssueAt) && firstDelimiterIssueAt < n
                ? firstDelimiterIssueAt
                : issues.length > 0
                  ? issues[0]!.leafIndex
                  : 0;
        issues.push(
            Object.freeze({
                code: "STRUCT_UNRELIABLE_STATEMENT_BOUNDARY" as const,
                leafIndex: anchor,
                message:
                    "Statement boundary is unreliable due to unmatched or mixed delimiters",
            })
        );
    }

    // Cached immutable snapshots (real Arrays)
    const frozenIssues = freezeImmutableArray(issues);
    const frozenRanges = freezeImmutableArray(statementRanges);
    const syntaxIndexByOrdinal = syntaxIndexStorage.subarray(0, syntaxCount);
    const codeIndexByOrdinal = codeIndexStorage.subarray(0, codeCount);

    function assertLeafIndex(leafIndex: number): void {
        if (!Number.isInteger(leafIndex) || leafIndex < 0 || leafIndex >= n) {
            throw new Error(`Leaf index out of range: ${leafIndex} (leafCount=${n})`);
        }
    }

    function assertSyntaxLeaf(leafIndex: number): void {
        assertLeafIndex(leafIndex);
        const leaf = leaves[leafIndex];
        if (!leaf || !isSyntaxLeaf(leaf)) {
            throw new Error(
                `Expected a syntax leaf (code|protected) at index ${leafIndex}, got channel=${leaf ? leaf.channel : "missing"}`
            );
        }
    }

    function assertStructuralCodeLeaf(leafIndex: number): void {
        assertLeafIndex(leafIndex);
        const leaf = leaves[leafIndex];
        if (!leaf || !isStructuralCodeLeaf(leaf)) {
            throw new Error(
                `Expected a structural code leaf at index ${leafIndex}, got channel=${leaf ? leaf.channel : "missing"}`
            );
        }
    }

    const rangeToSpanUnchecked = (range: LeafRange): SourceSpan => {
        if (range.start === range.end) {
            if (n === 0 || range.start === 0) {
                return Object.freeze({ start: 0, end: 0 });
            }
            if (range.start === n) {
                return Object.freeze({ start: source.length, end: source.length });
            }
            const leaf = leaves[range.start];
            const offset = leaf?.span.start ?? source.length;
            return Object.freeze({ start: offset, end: offset });
        }
        const first = leaves[range.start]!;
        const last = leaves[range.end - 1]!;
        if (range.end === range.start + 1 && Object.isFrozen(first.span)) {
            return first.span;
        }
        return Object.freeze({ start: first.span.start, end: last.span.end });
    };

    const table: StructuralTokenTable = Object.freeze({
        leafCount(): number {
            return n;
        },
        syntaxLeafCount(): number {
            return syntaxIndexByOrdinal.length;
        },
        previousSyntaxLeafIndex(leafIndex: number): number | null {
            assertSyntaxLeaf(leafIndex);
            const ordinal = syntaxOrdinal[leafIndex]!;
            return ordinal === 0 ? null : syntaxIndexByOrdinal[ordinal - 1]!;
        },
        nextSyntaxLeafIndex(leafIndex: number): number | null {
            assertSyntaxLeaf(leafIndex);
            const ordinal = syntaxOrdinal[leafIndex]! + 1;
            return ordinal >= syntaxIndexByOrdinal.length
                ? null
                : syntaxIndexByOrdinal[ordinal]!;
        },
        syntaxOrdinalOfLeaf(leafIndex: number): number {
            assertSyntaxLeaf(leafIndex);
            const ord = syntaxOrdinal[leafIndex];
            if (ord === undefined || ord === NO_INDEX) {
                throw new Error(`No syntax ordinal for leaf ${leafIndex}`);
            }
            return ord;
        },
        leafIndexOfSyntaxOrdinal(ordinal: number): number {
            if (
                !Number.isInteger(ordinal) ||
                ordinal < 0 ||
                ordinal >= syntaxIndexByOrdinal.length
            ) {
                throw new Error(
                    `Syntax ordinal out of range: ${ordinal} (syntaxLeafCount=${syntaxIndexByOrdinal.length})`
                );
            }
            return syntaxIndexByOrdinal[ordinal]!;
        },
        codeLeafCount(): number {
            return codeIndexByOrdinal.length;
        },
        previousCodeLeafIndex(leafIndex: number): number | null {
            assertStructuralCodeLeaf(leafIndex);
            const ordinal = codeOrdinal[leafIndex]!;
            return ordinal === 0 ? null : codeIndexByOrdinal[ordinal - 1]!;
        },
        nextCodeLeafIndex(leafIndex: number): number | null {
            assertStructuralCodeLeaf(leafIndex);
            const ordinal = codeOrdinal[leafIndex]! + 1;
            return ordinal >= codeIndexByOrdinal.length
                ? null
                : codeIndexByOrdinal[ordinal]!;
        },
        codeOrdinalOfLeaf(leafIndex: number): number {
            assertStructuralCodeLeaf(leafIndex);
            const ord = codeOrdinal[leafIndex];
            if (ord === undefined || ord === NO_INDEX) {
                throw new Error(`No code ordinal for leaf ${leafIndex}`);
            }
            return ord;
        },
        leafIndexOfCodeOrdinal(ordinal: number): number {
            if (
                !Number.isInteger(ordinal) ||
                ordinal < 0 ||
                ordinal >= codeIndexByOrdinal.length
            ) {
                throw new Error(
                    `Code ordinal out of range: ${ordinal} (codeLeafCount=${codeIndexByOrdinal.length})`
                );
            }
            return codeIndexByOrdinal[ordinal]!;
        },
        depthBefore(leafIndex: number): number {
            assertLeafIndex(leafIndex);
            return depthBeforeArr[leafIndex]!;
        },
        depthAfter(leafIndex: number): number {
            assertLeafIndex(leafIndex);
            return depthAfterArr[leafIndex]!;
        },
        matchingDelimiterIndex(leafIndex: number): number | null {
            assertLeafIndex(leafIndex);
            const value = match[leafIndex]!;
            return value === NO_INDEX ? null : value;
        },
        statementRanges(): readonly LeafRange[] {
            return frozenRanges;
        },
        statementBoundariesReliable(): boolean {
            return boundariesReliable;
        },
        structuralIssues(): readonly StructuralIssue[] {
            return frozenIssues;
        },
        rangeToSpan(range: LeafRange): SourceSpan {
            if (
                !range ||
                !Number.isInteger(range.start) ||
                !Number.isInteger(range.end) ||
                range.start < 0 ||
                range.end < range.start ||
                range.end > n
            ) {
                throw new Error(
                    `Invalid leaf range: [${range && range.start}, ${range && range.end}) leafCount=${n}`
                );
            }
            return rangeToSpanUnchecked(range);
        },
        normalizedWord(leafIndex: number): string {
            assertStructuralCodeLeaf(leafIndex);
            return leaves[leafIndex]!.raw.toLowerCase();
        },
        codeWordsEqual(leftLeafIndex: number, rightLeafIndex: number): boolean {
            return this.normalizedWord(leftLeafIndex) === this.normalizedWord(rightLeafIndex);
        },
        getLeaf(leafIndex: number): SourceLeaf {
            assertLeafIndex(leafIndex);
            return leaves[leafIndex]!;
        },
    });

    CANONICAL_STRUCTURAL_TOKEN_TABLE_PROOFS.set(
        table,
        Object.freeze({
            leaves,
            canonicalSourcePartition,
            rangeToSpan: rangeToSpanUnchecked,
        })
    );
    return table;
}
