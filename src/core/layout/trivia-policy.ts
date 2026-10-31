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
/** Where a parenthesized list may wrap: after a separator, and inside its delimiters (K16). */
export const REFLOW_LINE_SPACE = Object.freeze({
    kind: "soft-line" as const,
    flat: "space" as const,
    reflow: true as const,
});
export const REFLOW_LINE_EMPTY = Object.freeze({
    kind: "soft-line" as const,
    flat: "empty" as const,
    reflow: true as const,
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

/** Whether the source has a line break, after at most one run of blanks, on each side of a leaf. */
export function lineBreaksBeside(
    analysis: LayoutAnalysisView,
    leafId: number
): { readonly before: boolean; readonly after: boolean } {
    const isKind = (id: number, kind: string): boolean => analysis.leafKind(id) === kind;
    return {
        before: isKind(leafId - 1, "newline") ||
            (isKind(leafId - 1, "whitespace") && isKind(leafId - 2, "newline")),
        after: isKind(leafId + 1, "newline") ||
            (isKind(leafId + 1, "whitespace") && isKind(leafId + 2, "newline")),
    };
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
    if (
        left?.kind === "line-comment" ||
        (right?.kind === "line-comment" && right.placement === "leading")
    ) {
        return HARD_LINE;
    }
    if (right?.placement === "trailing") {
        return SPACE;
    }
    // A block comment keeps the line breaks written beside it; one written inline stays inline,
    // so `a = /* x */ 1` is not split onto three lines at column 0 (K4).
    if (
        left?.kind === "block-comment" ||
        right?.placement === "leading" ||
        right?.placement === "dangling"
    ) {
        try {
            if (
                context.analysis.index.rangeContainsLineBreak({
                    start: startLeafId,
                    end: endLeafId,
                }) &&
                keepsCommentLineBreak(context, requested, left, right)
            ) {
                return HARD_LINE;
            }
        } catch {
            return null;
        }
        // A leading block comment written on its item's line stays on that line.
        if (
            left?.placement === "leading" &&
            (requested.kind === "hard-line" || requested.kind === "soft-line")
        ) {
            return SPACE;
        }
    }
    // The space written after a block comment on its line stays where none is requested
    // (`f(/* arg */ x)`, K15).
    if (
        (requested.kind === "empty" ||
            (requested.kind === "soft-line" && requested.flat === "empty")) &&
        left?.kind === "block-comment" &&
        rangeHasWhitespace(context, startLeafId, endLeafId)
    ) {
        try {
            if (
                !context.analysis.index.rangeContainsLineBreak({
                    start: startLeafId,
                    end: endLeafId,
                })
            ) {
                return SPACE;
            }
        } catch {
            return null;
        }
    }
    return requested;
}

/**
 * A wrap point of a parenthesized list keeps the line break of a line comment or of a block comment
 * written on a line of its own. Other block comments reflow with the list, so a line break the list
 * makes beside one is not read back as the source's on a second pass (K16).
 */
function keepsCommentLineBreak(
    context: QueryLayoutContext,
    requested: LayoutGapDecision,
    left: GapComment | null,
    right: GapComment | null
): boolean {
    if (requested.kind !== "soft-line" || requested.reflow !== true) {
        return true;
    }
    return [left, right].some((comment) => {
        if (comment === null) {
            return false;
        }
        const beside = lineBreaksBeside(context.analysis, comment.leafId);
        return comment.kind === "line-comment" || (beside.before && beside.after);
    });
}

function rangeHasWhitespace(
    context: QueryLayoutContext,
    startLeafId: number,
    endLeafId: number
): boolean {
    for (let leafId = startLeafId; leafId < endLeafId; leafId++) {
        if (context.analysis.leafKind(leafId) === "whitespace") {
            return true;
        }
    }
    return false;
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
    const success = context.plan.replaceGap(
        authorityNodeId,
        startLeafId,
        endLeafId,
        decision
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
    if (!context.state.hasIndentationScope) {
        return true;
    }
    let previousSyntaxEnd = 0;
    let previousAuthorityNodeId: number | null = null;
    let requiresHardLine = false;
    let activeScopeCount = 0;
    for (let leafId = 0; leafId < context.analysis.leafCount; leafId++) {
        activeScopeCount += context.scopeDeltas[leafId]!;
        const claim = context.claims.claimForLeaf(leafId);
        if (claim !== null) {
            if (claim.leafRange.start === leafId) {
                previousSyntaxEnd = claim.leafRange.end;
                previousAuthorityNodeId = null;
                requiresHardLine = false;
            }
            continue;
        }
        const kind = context.analysis.leafKind(leafId);
        if (kind === null) {
            return false;
        }
        const facts = context.analysis.index.leafContext(leafId);
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
