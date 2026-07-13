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
    const n = leaves.length;

    const syntaxLeafIndexes: number[] = [];
    const codeLeafIndexes: number[] = [];
    const previousSyntax: Array<number | null> = new Array(n);
    const nextSyntax: Array<number | null> = new Array(n);
    const syntaxOrdinal: Array<number | null> = new Array(n);
    const previousCode: Array<number | null> = new Array(n);
    const nextCode: Array<number | null> = new Array(n);
    const codeOrdinal: Array<number | null> = new Array(n);
    const depthBeforeArr: number[] = new Array(n);
    const depthAfterArr: number[] = new Array(n);
    const match: Array<number | null> = new Array(n);
    const issues: StructuralIssue[] = [];

    // Pass 1: syntax + structural code adjacency (O(n))
    let lastSyntax: number | null = null;
    let lastCode: number | null = null;
    for (let i = 0; i < n; i++) {
        previousSyntax[i] = null;
        nextSyntax[i] = null;
        syntaxOrdinal[i] = null;
        previousCode[i] = null;
        nextCode[i] = null;
        codeOrdinal[i] = null;
        depthBeforeArr[i] = 0;
        depthAfterArr[i] = 0;
        match[i] = null;

        const leaf = leaves[i];
        if (!leaf) {
            continue;
        }

        if (isSyntaxLeaf(leaf)) {
            syntaxOrdinal[i] = syntaxLeafIndexes.length;
            syntaxLeafIndexes.push(i);
            previousSyntax[i] = lastSyntax;
            if (lastSyntax !== null) {
                nextSyntax[lastSyntax] = i;
            }
            lastSyntax = i;
        }

        if (isStructuralCodeLeaf(leaf)) {
            codeOrdinal[i] = codeLeafIndexes.length;
            codeLeafIndexes.push(i);
            previousCode[i] = lastCode;
            if (lastCode !== null) {
                nextCode[lastCode] = i;
            }
            lastCode = i;
        }
    }

    // Pass 2: delimiter depth / matching on structural code leaves only (O(n))
    type StackEntry = { index: number; expectedCloser: string; openRaw: string };
    const stack: StackEntry[] = [];
    let depth = 0;
    let unreliable = false;

    for (let i = 0; i < n; i++) {
        const leaf = leaves[i];
        if (!leaf || !isStructuralCodeLeaf(leaf)) {
            depthBeforeArr[i] = depth;
            depthAfterArr[i] = depth;
            continue;
        }

        depthBeforeArr[i] = depth;
        const raw = leaf.raw;

        if (OPENERS[raw] !== undefined) {
            stack.push({ index: i, expectedCloser: OPENERS[raw]!, openRaw: raw });
            depth += 1;
            depthAfterArr[i] = depth;
            continue;
        }

        if (CLOSERS[raw] !== undefined) {
            if (stack.length === 0) {
                issues.push(
                    Object.freeze({
                        code: "STRUCT_UNMATCHED_CLOSER" as const,
                        leafIndex: i,
                        message: `Unmatched closer ${raw} at leaf ${i}`,
                    })
                );
                unreliable = true;
                depthAfterArr[i] = depth;
                continue;
            }
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
                stack.pop();
                depth = Math.max(0, depth - 1);
                depthAfterArr[i] = depth;
                continue;
            }
            stack.pop();
            depth = Math.max(0, depth - 1);
            match[top.index] = i;
            match[i] = top.index;
            depthAfterArr[i] = depth;
            continue;
        }

        depthAfterArr[i] = depth;
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
    }

    // Pass 3: statement segmentation on depth-0 structural code semicolons (O(n))
    const statementRanges: LeafRange[] = [];
    let firstDelimiterIssueAt = Number.POSITIVE_INFINITY;
    for (const issue of issues) {
        if (
            issue.code === "STRUCT_UNMATCHED_OPENER" ||
            issue.code === "STRUCT_UNMATCHED_CLOSER" ||
            issue.code === "STRUCT_MIXED_DELIMITER"
        ) {
            if (issue.leafIndex < firstDelimiterIssueAt) {
                firstDelimiterIssueAt = issue.leafIndex;
            }
        }
    }

    let stmtStart = 0;

    if (n > 0) {
        for (let i = 0; i < n; i++) {
            const leaf = leaves[i];
            if (!leaf || !isStructuralCodeLeaf(leaf)) {
                continue;
            }
            if (leaf.raw !== ";" || depthBeforeArr[i] !== 0 || depthAfterArr[i] !== 0) {
                continue;
            }
            if (firstDelimiterIssueAt < i) {
                issues.push(
                    Object.freeze({
                        code: "STRUCT_UNRELIABLE_STATEMENT_BOUNDARY" as const,
                        leafIndex: i,
                        message:
                            "Statement boundary is unreliable; subsequent top-level splits are not trusted",
                    })
                );
                break;
            }
            statementRanges.push(Object.freeze({ start: stmtStart, end: i + 1 }));
            stmtStart = i + 1;
        }

        // Trailing remainder: present if any syntax (non-trivia) content remains.
        if (stmtStart < n) {
            let hasSyntax = false;
            for (let i = stmtStart; i < n; i++) {
                const leaf = leaves[i];
                if (leaf && isSyntaxLeaf(leaf)) {
                    hasSyntax = true;
                    break;
                }
            }
            if (hasSyntax) {
                statementRanges.push(Object.freeze({ start: stmtStart, end: n }));
            }
        }
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
    const frozenIssues = freezeImmutableArray(
        issues.map((x) => Object.freeze({ ...x }))
    );
    const frozenRanges = freezeImmutableArray(
        statementRanges.map((x) => Object.freeze({ start: x.start, end: x.end }))
    );

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

    const table: StructuralTokenTable = Object.freeze({
        leafCount(): number {
            return n;
        },
        syntaxLeafCount(): number {
            return syntaxLeafIndexes.length;
        },
        previousSyntaxLeafIndex(leafIndex: number): number | null {
            assertSyntaxLeaf(leafIndex);
            return previousSyntax[leafIndex] ?? null;
        },
        nextSyntaxLeafIndex(leafIndex: number): number | null {
            assertSyntaxLeaf(leafIndex);
            return nextSyntax[leafIndex] ?? null;
        },
        syntaxOrdinalOfLeaf(leafIndex: number): number {
            assertSyntaxLeaf(leafIndex);
            const ord = syntaxOrdinal[leafIndex];
            if (ord === null || ord === undefined) {
                throw new Error(`No syntax ordinal for leaf ${leafIndex}`);
            }
            return ord;
        },
        leafIndexOfSyntaxOrdinal(ordinal: number): number {
            if (
                !Number.isInteger(ordinal) ||
                ordinal < 0 ||
                ordinal >= syntaxLeafIndexes.length
            ) {
                throw new Error(
                    `Syntax ordinal out of range: ${ordinal} (syntaxLeafCount=${syntaxLeafIndexes.length})`
                );
            }
            return syntaxLeafIndexes[ordinal]!;
        },
        codeLeafCount(): number {
            return codeLeafIndexes.length;
        },
        previousCodeLeafIndex(leafIndex: number): number | null {
            assertStructuralCodeLeaf(leafIndex);
            return previousCode[leafIndex] ?? null;
        },
        nextCodeLeafIndex(leafIndex: number): number | null {
            assertStructuralCodeLeaf(leafIndex);
            return nextCode[leafIndex] ?? null;
        },
        codeOrdinalOfLeaf(leafIndex: number): number {
            assertStructuralCodeLeaf(leafIndex);
            const ord = codeOrdinal[leafIndex];
            if (ord === null || ord === undefined) {
                throw new Error(`No code ordinal for leaf ${leafIndex}`);
            }
            return ord;
        },
        leafIndexOfCodeOrdinal(ordinal: number): number {
            if (
                !Number.isInteger(ordinal) ||
                ordinal < 0 ||
                ordinal >= codeLeafIndexes.length
            ) {
                throw new Error(
                    `Code ordinal out of range: ${ordinal} (codeLeafCount=${codeLeafIndexes.length})`
                );
            }
            return codeLeafIndexes[ordinal]!;
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
            return match[leafIndex] ?? null;
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
            if (range.start === range.end) {
                if (n === 0) {
                    return Object.freeze({ start: 0, end: 0 });
                }
                if (range.start === 0) {
                    return Object.freeze({ start: 0, end: 0 });
                }
                if (range.start === n) {
                    return Object.freeze({ start: source.length, end: source.length });
                }
                const leaf = leaves[range.start];
                if (!leaf) {
                    return Object.freeze({ start: source.length, end: source.length });
                }
                return Object.freeze({ start: leaf.span.start, end: leaf.span.start });
            }
            const first = leaves[range.start];
            const last = leaves[range.end - 1];
            if (!first || !last) {
                throw new Error(`Leaf range out of bounds: [${range.start}, ${range.end})`);
            }
            return Object.freeze({ start: first.span.start, end: last.span.end });
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

    return table;
}
