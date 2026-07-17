import type { LayoutGapDecision } from "./plan";
import { authorityForNode } from "./query-layout-context";
import type {
    LayoutAnalysisView,
    QueryLayoutContext,
} from "./query-layout-context";

export const HARD_LINE = Object.freeze({ kind: "hard-line" as const });
export const EMPTY = Object.freeze({ kind: "empty" as const });
export const SPACE = Object.freeze({ kind: "space" as const, columns: 1 });

export function isLayoutTrivia(
    analysis: LayoutAnalysisView,
    leafId: number
): boolean {
    const channel = analysis.leafChannel(leafId);
    const kind = analysis.leafKind(leafId);
    return (
        channel === "trivia" &&
        (kind === "whitespace" || kind === "newline")
    );
}

export function isCommentLeaf(
    analysis: LayoutAnalysisView,
    leafId: number
): boolean {
    const kind = analysis.leafKind(leafId);
    return kind === "line-comment" || kind === "block-comment";
}

interface GapComment {
    readonly leafId: number;
    readonly kind: "line-comment" | "block-comment";
    readonly placement: "leading" | "trailing" | "dangling";
}

function decisionBetweenGapAnchors(
    requested: LayoutGapDecision,
    left: GapComment | null,
    right: GapComment | null
): LayoutGapDecision {
    if (left?.kind === "line-comment") {
        return HARD_LINE;
    }
    if (left?.placement === "leading" || right?.placement === "leading") {
        return HARD_LINE;
    }
    if (right?.placement === "trailing") {
        return SPACE;
    }
    return requested;
}

function replaceCanonicalTriviaRun(
    context: QueryLayoutContext,
    authorityNodeId: number,
    startLeafId: number,
    endLeafId: number,
    decision: LayoutGapDecision
): boolean {
    return startLeafId === endLeafId && decision.kind === "empty"
        ? true
        : context.plan.replaceGap(
              authorityNodeId,
              startLeafId,
              endLeafId,
              decision
          );
}

export function commentGapRequiresHardLine(
    context: QueryLayoutContext,
    startLeafId: number,
    endLeafId: number
): boolean | null {
    for (let leafId = startLeafId; leafId < endLeafId; leafId++) {
        context.statistics.leafVisitCount += 1;
        const kind = context.analysis.leafKind(leafId);
        if (kind === null) {
            return null;
        }
        if (isLayoutTrivia(context.analysis, leafId)) {
            continue;
        }
        if (!isCommentLeaf(context.analysis, leafId)) {
            return null;
        }
        const binding = context.analysis.index.commentBinding(leafId);
        context.statistics.directLookupCount += 1;
        if (binding === null || binding.commentLeafId !== leafId) {
            return null;
        }
        if (kind === "line-comment" || binding.placement === "leading") {
            return true;
        }
    }
    return false;
}

/** Canonicalizes one typed structural gap without consuming comment bytes. */
export function replaceStructuralGap(
    context: QueryLayoutContext,
    authorityNodeId: number,
    startLeafId: number,
    endLeafId: number,
    decision: LayoutGapDecision
): boolean {
    if (
        !Number.isSafeInteger(startLeafId) ||
        !Number.isSafeInteger(endLeafId) ||
        startLeafId < 0 ||
        endLeafId < startLeafId ||
        endLeafId > context.analysis.leafCount
    ) {
        return false;
    }
    const canonical = (success: boolean): boolean => {
        if (success) {
            context.canonicalGapEnds[startLeafId] = endLeafId;
        }
        return success;
    };
    const comments: GapComment[] = [];
    for (let leafId = startLeafId; leafId < endLeafId; leafId++) {
        context.statistics.leafVisitCount += 1;
        const kind = context.analysis.leafKind(leafId);
        if (kind === null) {
            return false;
        }
        if (isLayoutTrivia(context.analysis, leafId)) {
            continue;
        }
        if (!isCommentLeaf(context.analysis, leafId)) {
            return false;
        }
        const binding = context.analysis.index.commentBinding(leafId);
        context.statistics.directLookupCount += 1;
        if (binding === null || binding.commentLeafId !== leafId) {
            return false;
        }
        comments.push(Object.freeze({
            leafId,
            kind: kind as GapComment["kind"],
            placement: binding.placement,
        }));
    }
    if (comments.length === 0) {
        return canonical(replaceCanonicalTriviaRun(
            context,
            authorityNodeId,
            startLeafId,
            endLeafId,
            decision
        ));
    }

    let cursor = startLeafId;
    let left: GapComment | null = null;
    for (const right of comments) {
        if (
            !replaceCanonicalTriviaRun(
                context,
                authorityNodeId,
                cursor,
                right.leafId,
                decisionBetweenGapAnchors(decision, left, right)
            )
        ) {
            return false;
        }
        cursor = right.leafId + 1;
        left = right;
    }
    return canonical(replaceCanonicalTriviaRun(
        context,
        authorityNodeId,
        cursor,
        endLeafId,
        decisionBetweenGapAnchors(decision, left, null)
    ));
}

/**
 * Removes source indentation that would otherwise be added again by an
 * enclosing indent/align scope. Structural gaps already owned by a typed
 * policy action and verbatim authorities remain untouched.
 */
export function canonicalizeScopedAuthorityLineBreaks(
    context: QueryLayoutContext
): boolean {
    if (context.statistics.scopeRangeCount === 0) {
        return true;
    }
    let previousSyntaxEnd = 0;
    let previousAuthorityNodeId: number | null = null;
    let requiresHardLine = false;
    let activeScopeCount = 0;
    for (let leafId = 0; leafId < context.analysis.leafCount; leafId++) {
        activeScopeCount += context.scopeDeltas[leafId]!;
        context.statistics.leafVisitCount += 1;
        const kind = context.analysis.leafKind(leafId);
        if (kind === null) {
            return false;
        }
        const facts = context.analysis.index.leafContext(leafId);
        context.statistics.directLookupCount += 1;
        if (facts.syntax !== null) {
            const authorityNodeId = authorityForNode(
                context,
                facts.syntax.directOwnerNodeId
            );
            if (
                requiresHardLine &&
                activeScopeCount > 0 &&
                authorityNodeId !== null &&
                authorityNodeId === previousAuthorityNodeId &&
                context.canonicalGapEnds[previousSyntaxEnd] !== leafId &&
                !replaceStructuralGap(
                    context,
                    authorityNodeId,
                    previousSyntaxEnd,
                    leafId,
                    HARD_LINE
                )
            ) {
                return false;
            }
            previousSyntaxEnd = leafId + 1;
            previousAuthorityNodeId = authorityNodeId;
            requiresHardLine = false;
            continue;
        }
        if (kind === "newline" || kind === "line-comment") {
            requiresHardLine = true;
        }
    }
    return true;
}
