import type { ExpressionNode } from "../syntax/node";
import { formatCaseExpression } from "./expression-case-policy";
import {
    formatExpressionContainer,
    formatExpressionList,
    formatExpressionListItem,
    formatTypeExpression,
    formatWindowSpec,
} from "./expression-container-policy";
import { formatExpressionOperators } from "./expression-operator-policy";
import type { QueryLayoutContext } from "./query-layout-context";

function formatExpression(
    context: QueryLayoutContext,
    node: ExpressionNode
): boolean {
    return (
        formatExpressionOperators(context, node) &&
        formatExpressionContainer(context, node) &&
        formatCaseExpression(context, node)
    );
}

/** Applies registry-backed expression behavior without reading SQL token text. */
export function applyHiveExpressionLayout(
    context: QueryLayoutContext
): boolean {
    for (const node of context.analysis.index.nodes()) {
        context.statistics.nodeVisitCount += 1;
        if (node.kind === "expression" && !formatExpression(context, node)) {
            return false;
        }
        if (node.kind === "list" && !formatExpressionList(context, node)) {
            return false;
        }
        if (
            node.kind === "list-item" &&
            !formatExpressionListItem(context, node)
        ) {
            return false;
        }
        if (
            node.kind === "type-expression" &&
            !formatTypeExpression(context, node)
        ) {
            return false;
        }
        if (node.kind === "window-spec" && !formatWindowSpec(context, node)) {
            return false;
        }
    }
    return true;
}
