import type { LayoutGapDecision } from "./plan";
import { authorityForNode } from "./query-layout-context";
import type {
    LayoutAnalysisView,
    QueryLayoutContext,
} from "./query-layout-context";

export const HARD_LINE = Object.freeze({ kind: "hard-line" as const });
export const EMPTY = Object.freeze({ kind: "empty" as const });
export const SPACE = Object.freeze({ kind: "space" as const, columns: 1 });
export const SOFT_LINE_SPACE = Object.freeze({
    kind: "soft-line" as const,
    flat: "space" as const,
});

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
    context: QueryLayoutContext,
    startLeafId: number,
    endLeafId: number,
    requested: LayoutGapDecision,
    left: GapComment | null,
    right: GapComment | null
): LayoutGapDecision | null {
    if (left?.kind === "line-comment") {
        return HARD_LINE;
    }
    if (left?.placement === "leading" || right?.placement === "leading") {
        return HARD_LINE;
    }
    if (right?.placement === "trailing") {
        return SPACE;
    }
    if (
        left?.placement === "dangling" ||
        right?.placement === "dangling" ||
        left?.kind === "block-comment"
    ) {
        try {
            context.statistics.directLookupCount += 1;
            if (
                context.analysis.index.rangeContainsLineBreak({
                    start: startLeafId,
                    end: endLeafId,
                })
            ) {
                return HARD_LINE;
            }
        } catch {
            return null;
        }
    }
    return requested;
}

function registerTriviaGap(
    context: QueryLayoutContext,
    authorityNodeId: number,
    startLeafId: number,
    endLeafId: number,
    decision: LayoutGapDecision
): boolean {
    if (startLeafId === endLeafId && decision.kind === "empty") {
        return true;
    }
    const alignmentTarget = context.alignmentTargetByLeaf[endLeafId];
    const alignedDecision: LayoutGapDecision =
        decision.kind === "space" &&
        alignmentTarget !== undefined &&
        alignmentTarget > 0
            ? Object.freeze({
                  kind: "pad-to-column",
                  targetColumn: alignmentTarget,
              })
            : decision;
    const success = context.plan.replaceGap(
        authorityNodeId,
        startLeafId,
        endLeafId,
        alignedDecision
    );
    if (success) {
        context.registeredGapEnds[startLeafId] = endLeafId;
    }
    return success;
}

function sourceGapHasBlankLine(
    context: QueryLayoutContext,
    startLeafId: number,
    endLeafId: number
): boolean | null {
    try {
        context.statistics.directLookupCount += 1;
        return context.analysis.index.blankLineCountBetween(
            startLeafId,
            endLeafId
        ) > 0;
    } catch {
        return null;
    }
}

function replaceCanonicalTriviaRun(
    context: QueryLayoutContext,
    authorityNodeId: number,
    startLeafId: number,
    endLeafId: number,
    decision: LayoutGapDecision
): boolean {
    if (decision.kind !== "hard-line") {
        return registerTriviaGap(
            context,
            authorityNodeId,
            startLeafId,
            endLeafId,
            decision
        );
    }
    const hasBlankLine = sourceGapHasBlankLine(
        context,
        startLeafId,
        endLeafId
    );
    if (hasBlankLine === null) {
        return false;
    }
    if (!hasBlankLine) {
        return registerTriviaGap(
            context,
            authorityNodeId,
            startLeafId,
            endLeafId,
            decision
        );
    }
    if (endLeafId - startLeafId < 2) {
        return false;
    }
    const splitLeafId = endLeafId - 1;
    return (
        registerTriviaGap(
            context,
            authorityNodeId,
            startLeafId,
            splitLeafId,
            HARD_LINE
        ) &&
        registerTriviaGap(
            context,
            authorityNodeId,
            splitLeafId,
            endLeafId,
            HARD_LINE
        )
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
        const gapDecision = decisionBetweenGapAnchors(
            context,
            cursor,
            right.leafId,
            decision,
            left,
            right
        );
        if (
            gapDecision === null ||
            !replaceCanonicalTriviaRun(
                context,
                authorityNodeId,
                cursor,
                right.leafId,
                gapDecision
            )
        ) {
            return false;
        }
        cursor = right.leafId + 1;
        left = right;
    }
    const finalDecision = decisionBetweenGapAnchors(
        context,
        cursor,
        endLeafId,
        decision,
        left,
        null
    );
    if (finalDecision === null) {
        return false;
    }
    return canonical(replaceCanonicalTriviaRun(
        context,
        authorityNodeId,
        cursor,
        endLeafId,
        finalDecision
    ));
}

/**
 * Removes source indentation that would otherwise be added again by an
 * enclosing indent/align scope. Structural gaps already owned by a typed
 * policy action and verbatim authorities remain untouched.
 */
export function applyTriviaLayout(context: QueryLayoutContext): boolean {
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
