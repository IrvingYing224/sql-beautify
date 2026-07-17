import type { RelationNode } from "../syntax/node";
import {
    authorityForNode,
    wrapLayoutRange,
} from "./query-layout-context";
import type { QueryLayoutContext } from "./query-layout-context";
import {
    formatAlias,
    formatFlatList,
    normalizeMarkerSequence,
} from "./query-list-policy";
import {
    commentGapRequiresHardLine,
    EMPTY,
    HARD_LINE,
    replaceStructuralGap,
    SPACE,
} from "./query-trivia-policy";

const INDENT = Object.freeze({ kind: "indent" as const, levels: 1 });

function formatRelationName(
    context: QueryLayoutContext,
    authorityNodeId: number,
    relation: RelationNode
): boolean {
    const range = relation.nameLeafRange;
    if (range === null) {
        return true;
    }
    let previousLeafId: number | null = null;
    for (let leafId = range.start; leafId < range.end; leafId++) {
        context.statistics.leafVisitCount += 1;
        const syntax = context.analysis.index.leafContext(leafId).syntax;
        context.statistics.directLookupCount += 1;
        if (syntax === null) {
            continue;
        }
        if (
            previousLeafId !== null &&
            !replaceStructuralGap(
                context,
                authorityNodeId,
                previousLeafId + 1,
                leafId,
                EMPTY
            )
        ) {
            return false;
        }
        previousLeafId = leafId;
    }
    return true;
}

export function formatRelation(
    context: QueryLayoutContext,
    relation: RelationNode
): boolean {
    const authorityNodeId = authorityForNode(context, relation.id);
    if (authorityNodeId === null) {
        return true;
    }
    if (!formatRelationName(context, authorityNodeId, relation)) {
        return false;
    }
    let valueEnd = relation.nameLeafRange?.end ?? relation.leafRange.end;
    if (relation.bodyChildId !== null) {
        valueEnd = context.analysis.index.nodeById(
            relation.bodyChildId
        ).leafRange.end;
        context.statistics.directLookupCount += 1;
    }
    if (!formatAlias(context, authorityNodeId, valueEnd, relation.alias)) {
        return false;
    }
    if (relation.relationKind === "join") {
        const right = relation.bodyChildId === null
            ? null
            : context.analysis.index.nodeById(relation.bodyChildId);
        context.statistics.directLookupCount += relation.bodyChildId === null
            ? 0
            : 1;
        context.statistics.directLookupCount += relation.syntaxMarkers.length;
        if (right === null) {
            return false;
        }
        const headMarkers = relation.syntaxMarkers.filter(
            (marker) => marker.syntaxId === "join-head"
        );
        const finalHead = headMarkers[headMarkers.length - 1];
        const commentBreak = finalHead === undefined
            ? null
            : commentGapRequiresHardLine(
                  context,
                  finalHead.leafId + 1,
                  right.leafRange.start
              );
        if (
            finalHead === undefined ||
            commentBreak === null ||
            !normalizeMarkerSequence(
                context,
                authorityNodeId,
                headMarkers
            ) ||
            !replaceStructuralGap(
                context,
                authorityNodeId,
                finalHead.leafId + 1,
                right.leafRange.start,
                SPACE
            ) ||
            (commentBreak &&
                !wrapLayoutRange(
                    context,
                    authorityNodeId,
                    finalHead.leafId + 1,
                    right.leafRange.end,
                    INDENT
                ))
        ) {
            return false;
        }
        for (const child of relation.children) {
            context.statistics.nodeVisitCount += 1;
            if (child.id === right.id) {
                continue;
            }
            if (
                child.kind !== "clause" ||
                !replaceStructuralGap(
                    context,
                    authorityNodeId,
                    right.leafRange.end,
                    child.leafRange.start,
                    HARD_LINE
                ) ||
                !wrapLayoutRange(
                    context,
                    authorityNodeId,
                    right.leafRange.end,
                    child.leafRange.end,
                    INDENT
                )
            ) {
                return false;
            }
        }
    }
    if (relation.relationKind === "lateral-view") {
        const tableFunction = relation.bodyChildId === null
            ? null
            : context.analysis.index.nodeById(relation.bodyChildId);
        context.statistics.directLookupCount += relation.bodyChildId === null
            ? 0
            : 1;
        context.statistics.nodeVisitCount += relation.children.length;
        const output = relation.children.find(
            (child) => child.kind === "list"
        );
        context.statistics.directLookupCount += relation.syntaxMarkers.length;
        const asMarker = relation.syntaxMarkers.find(
            (marker) => marker.syntaxId === "lateral-view-output-as"
        );
        if (
            tableFunction === null ||
            output === undefined ||
            output.kind !== "list" ||
            asMarker === undefined ||
            !replaceStructuralGap(
                context,
                authorityNodeId,
                tableFunction.leafRange.end,
                asMarker.leafId,
                SPACE
            ) ||
            !replaceStructuralGap(
                context,
                authorityNodeId,
                asMarker.leafId + 1,
                output.leafRange.start,
                SPACE
            ) ||
            !formatFlatList(context, authorityNodeId, output)
        ) {
            return false;
        }
    }
    return true;
}
