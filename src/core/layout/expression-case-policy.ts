import type { CaseBranchNode, ExpressionNode } from "../syntax/node";
import {
    authorityForNode,
    rangeHasComment,
    rangeHasVerbatimClaim,
    wrapLayoutRange,
} from "./query-layout-context";
import type { QueryLayoutContext } from "./query-layout-context";
import {
    replaceStructuralGap,
    SOFT_LINE_SPACE,
    SPACE,
} from "./trivia-policy";

const INDENT = Object.freeze({ kind: "indent" as const, levels: 1 });

function markerLeaf(
    node: ExpressionNode | CaseBranchNode,
    syntaxId: "case:start" | "case:when" | "case:then" | "case:else" | "case:end"
): number | null {
    const matches = node.syntaxMarkers.filter((marker) => marker.syntaxId === syntaxId);
    return matches.length === 1 ? matches[0]!.leafId : null;
}

function formatBranch(
    context: QueryLayoutContext,
    authorityNodeId: number,
    branch: CaseBranchNode
): boolean {
    const threshold = context.plan.options.caseWhenThenWrapLength;
    const value = context.analysis.index.nodeById(branch.valueChildId);
    context.statistics.directLookupCount += 1;
    if (branch.branchKind === "when") {
        if (branch.conditionChildId === null) {
            return false;
        }
        const whenLeafId = markerLeaf(branch, "case:when");
        const thenLeafId = markerLeaf(branch, "case:then");
        const condition = context.analysis.index.nodeById(branch.conditionChildId);
        context.statistics.directLookupCount += 1;
        if (
            whenLeafId === null ||
            thenLeafId === null ||
            !replaceStructuralGap(
                context,
                authorityNodeId,
                whenLeafId + 1,
                condition.leafRange.start,
                SPACE
            ) ||
            !replaceStructuralGap(
                context,
                authorityNodeId,
                condition.leafRange.end,
                thenLeafId,
                SPACE
            ) ||
            !replaceStructuralGap(
                context,
                authorityNodeId,
                thenLeafId + 1,
                value.leafRange.start,
                SOFT_LINE_SPACE
            )
        ) {
            return false;
        }
    } else {
        const elseLeafId = markerLeaf(branch, "case:else");
        if (
            branch.conditionChildId !== null ||
            elseLeafId === null ||
            !replaceStructuralGap(
                context,
                authorityNodeId,
                elseLeafId + 1,
                value.leafRange.start,
                SOFT_LINE_SPACE
            )
        ) {
            return false;
        }
    }
    return (
        wrapLayoutRange(
            context,
            authorityNodeId,
            branch.leafRange.start,
            branch.leafRange.end,
            { kind: "auto-group", maxFlatWidth: threshold }
        ) &&
        wrapLayoutRange(
            context,
            authorityNodeId,
            value.leafRange.start,
            value.leafRange.end,
            INDENT
        )
    );
}

export function formatCaseExpression(
    context: QueryLayoutContext,
    node: ExpressionNode
): boolean {
    if (node.expressionKind !== "case") {
        return true;
    }
    const authorityNodeId = authorityForNode(context, node.id);
    if (authorityNodeId === null) {
        return true;
    }
    const caseLeafId = markerLeaf(node, "case:start");
    const endLeafId = markerLeaf(node, "case:end");
    const branches = node.children.filter(
        (child): child is CaseBranchNode => child.kind === "case-branch"
    );
    const firstBranch = branches[0];
    const lastBranch = branches[branches.length - 1];
    context.statistics.nodeVisitCount += node.children.length + branches.length;
    if (
        caseLeafId === null ||
        endLeafId === null ||
        firstBranch === undefined ||
        lastBranch === undefined
    ) {
        return false;
    }
    const simpleOperand = node.children[0]?.kind === "case-branch"
        ? null
        : node.children[0] ?? null;
    if (
        simpleOperand !== null &&
        !replaceStructuralGap(
            context,
            authorityNodeId,
            caseLeafId + 1,
            simpleOperand.leafRange.start,
            SPACE
        )
    ) {
        return false;
    }
    const firstGapStart = simpleOperand?.leafRange.end ?? caseLeafId + 1;
    if (
        !replaceStructuralGap(
            context,
            authorityNodeId,
            firstGapStart,
            firstBranch.leafRange.start,
            SOFT_LINE_SPACE
        )
    ) {
        return false;
    }
    for (let index = 0; index < branches.length; index++) {
        const branch = branches[index]!;
        if (!formatBranch(context, authorityNodeId, branch)) {
            return false;
        }
        const next = branches[index + 1];
        if (
            next !== undefined &&
            !replaceStructuralGap(
                context,
                authorityNodeId,
                branch.leafRange.end,
                next.leafRange.start,
                SOFT_LINE_SPACE
            )
        ) {
            return false;
        }
    }
    if (
        !replaceStructuralGap(
            context,
            authorityNodeId,
            lastBranch.leafRange.end,
            endLeafId,
            SOFT_LINE_SPACE
        ) ||
        !wrapLayoutRange(
            context,
            authorityNodeId,
            firstBranch.leafRange.start,
            endLeafId,
            INDENT
        )
    ) {
        return false;
    }
    const hasComment = rangeHasComment(
        context,
        node.leafRange.start,
        node.leafRange.end
    );
    const hasClaim = rangeHasVerbatimClaim(
        context,
        node.leafRange.start,
        node.leafRange.end
    );
    if (hasComment === null || hasClaim === null) {
        return false;
    }
    const compact =
        context.plan.options.caseLayout === "compactShort" &&
        !hasComment &&
        !hasClaim;
    return wrapLayoutRange(
        context,
        authorityNodeId,
        node.leafRange.start,
        node.leafRange.end,
        compact
            ? {
                  kind: "auto-group",
                  maxFlatWidth: context.plan.options.caseWhenThenWrapLength,
              }
            : { kind: "group", mode: "break" }
    );
}
