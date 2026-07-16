import type { SourceLeaf } from "../lexer/token";
import type { LeafRange } from "./leaf-range";
import {
    CLOSERS,
    OPENERS,
    isStructuralCodeLeaf,
    isSyntaxChannel,
} from "./invariant-shared";

/**
 * Independent expected structural facts derived only from canonical leaves.
 * Must never share results with buildStructuralTokenTable implementation.
 */

export type ExpectedIssue = { code: string; leafIndex: number };

export type ExpectedTable = {
    syntaxIndexes: Uint32Array;
    codeIndexes: Uint32Array;
    depthBefore: Uint32Array;
    depthAfter: Uint32Array;
    match: Int32Array;
    delimiterIssues: ExpectedIssue[];
    statementRanges: LeafRange[];
    boundariesReliable: boolean;
};

/**
 * Independently re-derive structural token-table facts from canonical leaves.
 * Bounded multi-pass O(n): adjacency, delimiters, statement segmentation.
 */
export function deriveExpectedTable(leaves: readonly SourceLeaf[]): ExpectedTable {
    const n = leaves.length;
    const syntaxIndexStorage = new Uint32Array(n);
    const codeIndexStorage = new Uint32Array(n);
    const depthBefore = new Uint32Array(n);
    const depthAfter = new Uint32Array(n);
    const match = new Int32Array(n);
    match.fill(-1);

    let syntaxCount = 0;
    let codeCount = 0;
    for (let i = 0; i < n; i++) {
        const leaf = leaves[i]!;
        if (isSyntaxChannel(leaf.channel)) {
            syntaxIndexStorage[syntaxCount] = i;
            syntaxCount += 1;
        }
        if (isStructuralCodeLeaf(leaf)) {
            codeIndexStorage[codeCount] = i;
            codeCount += 1;
        }
    }
    const syntaxIndexes = syntaxIndexStorage.subarray(0, syntaxCount);
    const codeIndexes = codeIndexStorage.subarray(0, codeCount);

    type StackEntry = { index: number; expectedCloser: string };
    const stack: StackEntry[] = [];
    const delimiterIssues: ExpectedIssue[] = [];
    let depth = 0;
    let unreliable = false;

    for (let i = 0; i < n; i++) {
        const leaf = leaves[i]!;
        if (!isStructuralCodeLeaf(leaf)) {
            depthBefore[i] = depth;
            depthAfter[i] = depth;
            continue;
        }
        depthBefore[i] = depth;
        const raw = leaf.raw;
        if (OPENERS[raw] !== undefined) {
            stack.push({ index: i, expectedCloser: OPENERS[raw]! });
            depth += 1;
            depthAfter[i] = depth;
            continue;
        }
        if (CLOSERS[raw] !== undefined) {
            if (stack.length === 0) {
                delimiterIssues.push({ code: "STRUCT_UNMATCHED_CLOSER", leafIndex: i });
                unreliable = true;
                depthAfter[i] = depth;
                continue;
            }
            const top = stack[stack.length - 1]!;
            if (top.expectedCloser !== raw) {
                stack.pop();
                depth = Math.max(0, depth - 1);
                delimiterIssues.push({ code: "STRUCT_MIXED_DELIMITER", leafIndex: i });
                unreliable = true;
                depthAfter[i] = depth;
                continue;
            }
            stack.pop();
            depth = Math.max(0, depth - 1);
            match[top.index] = i;
            match[i] = top.index;
            depthAfter[i] = depth;
            continue;
        }
        depthAfter[i] = depth;
    }
    // Residual unmatched openers: drain LIFO (same order as buildStructuralTokenTable
    // stack.pop()), so ordered multi-set comparison stays aligned with production.
    for (let si = stack.length - 1; si >= 0; si--) {
        delimiterIssues.push({
            code: "STRUCT_UNMATCHED_OPENER",
            leafIndex: stack[si]!.index,
        });
        unreliable = true;
    }

    const statementRanges: LeafRange[] = [];
    let firstDelimiterIssueAt = Number.POSITIVE_INFINITY;
    for (const issue of delimiterIssues) {
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
            const leaf = leaves[i]!;
            if (!isStructuralCodeLeaf(leaf)) {
                continue;
            }
            if (leaf.raw !== ";" || depthBefore[i] !== 0 || depthAfter[i] !== 0) {
                continue;
            }
            if (firstDelimiterIssueAt < i) {
                delimiterIssues.push({
                    code: "STRUCT_UNRELIABLE_STATEMENT_BOUNDARY",
                    leafIndex: i,
                });
                break;
            }
            statementRanges.push({ start: stmtStart, end: i + 1 });
            stmtStart = i + 1;
        }
        if (stmtStart < n) {
            let hasSyntax = false;
            for (let i = stmtStart; i < n; i++) {
                if (isSyntaxChannel(leaves[i]!.channel)) {
                    hasSyntax = true;
                    break;
                }
            }
            if (hasSyntax) {
                statementRanges.push({ start: stmtStart, end: n });
            }
        }
    }

    const boundariesReliable = !unreliable;
    if (
        unreliable &&
        !delimiterIssues.some((x) => x.code === "STRUCT_UNRELIABLE_STATEMENT_BOUNDARY")
    ) {
        const anchor =
            Number.isFinite(firstDelimiterIssueAt) && firstDelimiterIssueAt < n
                ? firstDelimiterIssueAt
                : delimiterIssues.length > 0
                  ? delimiterIssues[0]!.leafIndex
                  : 0;
        delimiterIssues.push({
            code: "STRUCT_UNRELIABLE_STATEMENT_BOUNDARY",
            leafIndex: anchor,
        });
    }

    return {
        syntaxIndexes,
        codeIndexes,
        depthBefore,
        depthAfter,
        match,
        delimiterIssues,
        statementRanges,
        boundariesReliable,
    };
}
