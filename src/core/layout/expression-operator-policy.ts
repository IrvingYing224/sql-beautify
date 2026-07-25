import type { OperatorOccurrence } from "../syntax/node";
import type { ExpressionNode, SyntaxNode } from "../syntax/node";
import {
    authorityForNode,
    wrapLayoutRange,
} from "./query-layout-context";
import type { QueryLayoutContext } from "./query-layout-context";
import {
    EMPTY,
    HARD_LINE,
    replaceStructuralGap,
    SPACE,
} from "./trivia-policy";

const INDENT = Object.freeze({ kind: "indent" as const, levels: 1 });

interface ExpressionAnchor {
    readonly start: number;
    readonly end: number;
    readonly operatorLeafId: number | null;
}

function directAnchors(
    node: ExpressionNode,
    occurrences: readonly OperatorOccurrence[]
): readonly ExpressionAnchor[] | null {
    const anchors: ExpressionAnchor[] = node.children.map((child: SyntaxNode) => ({
        start: child.leafRange.start,
        end: child.leafRange.end,
        operatorLeafId: null,
    }));
    for (const marker of node.syntaxMarkers) {
        anchors.push({
            start: marker.leafId,
            end: marker.leafId + 1,
            operatorLeafId: null,
        });
    }
    for (const occurrence of occurrences) {
        for (const leafId of occurrence.leafIds) {
            anchors.push({
                start: leafId,
                end: leafId + 1,
                operatorLeafId: leafId,
            });
        }
    }
    anchors.sort((left, right) => left.start - right.start || right.end - left.end);
    const unique: ExpressionAnchor[] = [];
    for (const anchor of anchors) {
        const previous = unique[unique.length - 1];
        if (
            previous !== undefined &&
            previous.start === anchor.start &&
            previous.end === anchor.end
        ) {
            if (
                previous.operatorLeafId === null &&
                anchor.operatorLeafId !== null
            ) {
                unique[unique.length - 1] = anchor;
            }
            continue;
        }
        if (
            previous !== undefined &&
            anchor.start < previous.end
        ) {
            return null;
        }
        unique.push(anchor);
    }
    return Object.freeze(unique);
}

function needsBefore(occurrence: OperatorOccurrence): boolean {
    return occurrence.fixity === "infix" ||
        occurrence.fixity === "postfix" ||
        occurrence.formatClass === "attached";
}

function needsAfter(occurrence: OperatorOccurrence): boolean {
    return occurrence.fixity === "prefix" ||
        occurrence.fixity === "infix" ||
        occurrence.formatClass === "attached";
}

function beforeDecision(occurrence: OperatorOccurrence) {
    switch (occurrence.formatClass) {
        case "infix-word-continuation":
            return HARD_LINE;
        case "infix-word":
        case "infix-symbol":
        case "postfix-word":
            return SPACE;
        case "prefix-word":
            return SPACE;
        case "prefix-symbol":
        case "postfix-symbol":
        case "attached":
            return EMPTY;
    }
}

function afterDecision(occurrence: OperatorOccurrence) {
    switch (occurrence.formatClass) {
        case "prefix-word":
        case "infix-word":
        case "infix-word-continuation":
        case "infix-symbol":
            return SPACE;
        case "prefix-symbol":
        case "postfix-symbol":
        case "attached":
            return EMPTY;
        case "postfix-word":
            return SPACE;
    }
}

export function formatExpressionOperators(
    context: QueryLayoutContext,
    node: ExpressionNode
): boolean {
    const authorityNodeId = authorityForNode(context, node.id);
    if (authorityNodeId === null) {
        return true;
    }
    const occurrences = context.analysis.index.operatorOccurrencesOf(node.id);
    context.statistics.directLookupCount += 1;
    if (occurrences.length === 0) {
        return true;
    }
    const anchors = directAnchors(node, occurrences);
    context.statistics.nodeVisitCount += node.children.length;
    context.statistics.directLookupCount +=
        node.syntaxMarkers.length + node.operatorLeafIds.length;
    if (anchors === null) {
        return false;
    }
    const anchorByOperator = new Map<number, number>();
    for (let index = 0; index < anchors.length; index++) {
        const leafId = anchors[index]!.operatorLeafId;
        if (leafId !== null) {
            anchorByOperator.set(leafId, index);
        }
    }
    for (const occurrence of occurrences) {
        for (const leafId of occurrence.leafIds) {
            const anchorIndex = anchorByOperator.get(leafId);
            if (anchorIndex === undefined) {
                return false;
            }
            const previous = anchors[anchorIndex - 1];
            const next = anchors[anchorIndex + 1];
            if (
                needsBefore(occurrence) &&
                (previous === undefined ||
                    !replaceStructuralGap(
                        context,
                        authorityNodeId,
                        previous.end,
                        leafId,
                        beforeDecision(occurrence)
                    ))
            ) {
                return false;
            }
            if (
                needsAfter(occurrence) &&
                (next === undefined ||
                    !replaceStructuralGap(
                        context,
                        authorityNodeId,
                        leafId + 1,
                        next.start,
                        afterDecision(occurrence)
                    ))
            ) {
                return false;
            }
            if (
                occurrence.formatClass === "infix-word-continuation" &&
                !wrapLayoutRange(
                    context,
                    authorityNodeId,
                    leafId,
                    node.leafRange.end,
                    INDENT
                )
            ) {
                return false;
            }
        }
    }
    return true;
}
