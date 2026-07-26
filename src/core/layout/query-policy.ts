import type {
    ClauseNode,
    CteNode,
    QueryNode,
    SetStatementNode,
    SyntaxNode,
} from "../syntax/node";
import {
    authorityForNode,
    wrapLayoutRange,
} from "./query-layout-context";
import type { QueryLayoutContext } from "./query-layout-context";
import {
    formatDelimitedList,
    formatFlatList,
    formatListItemAlias,
    formatMixedRelationSequence,
    formatMultilineSequence,
    formatQueryList,
    markerSequenceInRange,
    matchingDelimitersAround,
    normalizeMarkerSequence,
} from "./query-list-policy";
import { formatRelation } from "./query-relation-policy";
import {
    EMPTY,
    HARD_LINE,
    replaceStructuralGap,
    SPACE,
} from "./trivia-policy";

const INDENT = Object.freeze({ kind: "indent" as const, levels: 1 });

function formatSetStatement(
    context: QueryLayoutContext,
    statement: SetStatementNode
): boolean {
    const authorityNodeId = authorityForNode(context, statement.id);
    if (authorityNodeId === null) {
        return true;
    }
    context.statistics.directLookupCount += statement.syntaxMarkers.length;
    const head = statement.syntaxMarkers.find(
        (marker) => marker.syntaxId === "set:head"
    );
    if (head === undefined) {
        return false;
    }
    if (statement.payloadChildId === null) {
        return statement.children.length === 0;
    }
    const payload = context.analysis.index.nodeById(statement.payloadChildId);
    context.statistics.directLookupCount += 1;
    return (
        payload.kind === "set-payload" &&
        replaceStructuralGap(
            context,
            authorityNodeId,
            head.leafId + 1,
            payload.leafRange.start,
            SPACE
        )
    );
}

function formatClause(
    context: QueryLayoutContext,
    clause: ClauseNode
): boolean {
    const authorityNodeId = authorityForNode(context, clause.id);
    if (authorityNodeId === null) {
        return true;
    }
    if (
        !normalizeMarkerSequence(
            context,
            authorityNodeId,
            markerSequenceInRange(
                context,
                clause.syntaxMarkers,
                clause.headLeafRange
            )
        )
    ) {
        return false;
    }
    const first = clause.children[0];
    switch (clause.clauseKind) {
        case "with":
            return formatMultilineSequence(
                context,
                authorityNodeId,
                clause.headLeafRange.end,
                clause.children,
                clause.separatorLeafIds
            );
        case "from":
            return formatMixedRelationSequence(
                context,
                authorityNodeId,
                clause.headLeafRange.end,
                clause.children,
                clause.separatorLeafIds
            );
        case "window": {
            if (first === undefined || first.kind !== "list") {
                return false;
            }
            return formatMultilineSequence(
                context,
                authorityNodeId,
                clause.headLeafRange.end,
                first.children,
                first.separatorLeafIds
            );
        }
        case "partition": {
            if (first === undefined || first.kind !== "list") {
                return false;
            }
            return formatDelimitedList(
                context,
                authorityNodeId,
                clause.leafRange,
                null,
                first,
                false
            );
        }
        case "join-using": {
            if (first === undefined || first.kind !== "list") {
                return false;
            }
            return formatDelimitedList(
                context,
                authorityNodeId,
                clause.leafRange,
                clause.headLeafRange.end,
                first,
                true
            );
        }
        case "select":
        case "group-by":
        case "order-by":
        case "cluster-by":
        case "distribute-by":
        case "sort-by":
        case "set-operation":
            return true;
        case "where":
        case "having":
        case "limit":
        case "join-on":
        case "lateral-view":
        case "insert":
            return first === undefined ||
                replaceStructuralGap(
                    context,
                    authorityNodeId,
                    clause.headLeafRange.end,
                    first.leafRange.start,
                    SPACE
                );
    }
}

function formatCte(
    context: QueryLayoutContext,
    cte: CteNode
): boolean {
    const authorityNodeId = authorityForNode(context, cte.id);
    if (authorityNodeId === null) {
        return true;
    }
    let leftEnd = cte.nameLeafRange.end;
    if (cte.columnListChildId !== null) {
        const columnList = context.analysis.index.nodeById(
            cte.columnListChildId
        );
        context.statistics.directLookupCount += 1;
        if (columnList.kind !== "list") {
            return false;
        }
        const delimiters = matchingDelimitersAround(
            context,
            cte.leafRange,
            columnList.leafRange
        );
        if (
            delimiters === null ||
            !replaceStructuralGap(
                context,
                authorityNodeId,
                cte.nameLeafRange.end,
                delimiters[0],
                EMPTY
            ) ||
            !replaceStructuralGap(
                context,
                authorityNodeId,
                delimiters[0] + 1,
                columnList.leafRange.start,
                EMPTY
            ) ||
            !formatFlatList(context, authorityNodeId, columnList) ||
            !replaceStructuralGap(
                context,
                authorityNodeId,
                columnList.leafRange.end,
                delimiters[1],
                EMPTY
            )
        ) {
            return false;
        }
        leftEnd = delimiters[1] + 1;
    }
    context.statistics.directLookupCount += cte.syntaxMarkers.length;
    const asMarker = cte.syntaxMarkers.find(
        (marker) => marker.syntaxId === "cte-as"
    );
    const query = context.analysis.index.nodeById(cte.queryChildId);
    context.statistics.directLookupCount += 1;
    return (
        asMarker !== undefined &&
        replaceStructuralGap(
            context,
            authorityNodeId,
            leftEnd,
            asMarker.leafId,
            SPACE
        ) &&
        replaceStructuralGap(
            context,
            authorityNodeId,
            asMarker.leafId + 1,
            query.leafRange.start,
            SPACE
        )
    );
}

function formatParenthesizedQuery(
    context: QueryLayoutContext,
    query: QueryNode,
    authorityNodeId: number
): boolean {
    const child = query.children[0];
    context.statistics.nodeVisitCount += child === undefined ? 0 : 1;
    context.statistics.directLookupCount += query.syntaxMarkers.length * 2;
    const open = query.syntaxMarkers.find(
        (marker) => marker.syntaxId === "delimiter" && marker.partOrdinal === 0
    );
    const close = query.syntaxMarkers.find(
        (marker) => marker.syntaxId === "delimiter" && marker.partOrdinal === 1
    );
    if (child === undefined || open === undefined || close === undefined) {
        return false;
    }
    return (
        replaceStructuralGap(
            context,
            authorityNodeId,
            open.leafId + 1,
            child.leafRange.start,
            HARD_LINE
        ) &&
        replaceStructuralGap(
            context,
            authorityNodeId,
            child.leafRange.end,
            close.leafId,
            HARD_LINE
        ) &&
        wrapLayoutRange(
            context,
            authorityNodeId,
            open.leafId + 1,
            close.leafId,
            INDENT
        )
    );
}

function formatQuery(
    context: QueryLayoutContext,
    query: QueryNode
): boolean {
    const authorityNodeId = authorityForNode(context, query.id);
    if (authorityNodeId === null) {
        return true;
    }
    if (query.queryKind === "parenthesized") {
        return formatParenthesizedQuery(
            context,
            query,
            authorityNodeId
        );
    }
    for (let index = 1; index < query.children.length; index++) {
        context.statistics.nodeVisitCount += 2;
        const left = query.children[index - 1]!;
        const right = query.children[index]!;
        if (
            !replaceStructuralGap(
                context,
                authorityNodeId,
                left.leafRange.end,
                right.leafRange.start,
                HARD_LINE
            )
        ) {
            return false;
        }
    }
    return true;
}

function firstStatementSyntax(
    context: QueryLayoutContext,
    statement: SyntaxNode
): number | null {
    if (statement.kind !== "statement") {
        return null;
    }
    if (statement.bodyChildId !== null) {
        context.statistics.directLookupCount += 1;
        return context.analysis.index.nodeById(
            statement.bodyChildId
        ).leafRange.start;
    }
    context.statistics.directLookupCount += statement.syntaxMarkers.length;
    const terminator = statement.syntaxMarkers.find(
        (marker) => marker.syntaxId === "statement-terminator"
    );
    return terminator?.leafId ?? null;
}

function formatStatements(context: QueryLayoutContext): boolean {
    const program = context.analysis.root;
    const capability = context.analysis.index.capabilityForNode(program.id);
    context.statistics.directLookupCount += 1;
    if (capability?.state !== "formatted") {
        return true;
    }
    const statements = program.children;
    context.statistics.nodeVisitCount += statements.length;
    for (let index = 1; index < statements.length; index++) {
        const left = statements[index - 1]!;
        const rightStart = firstStatementSyntax(context, statements[index]!);
        if (
            rightStart === null ||
            !replaceStructuralGap(
                context,
                program.id,
                left.leafRange.end,
                rightStart,
                HARD_LINE
            )
        ) {
            return false;
        }
    }
    return true;
}

/** Applies the complete Wave 3C Hive query/layout policy from typed CST facts. */
export function applyQueryLayout(
    context: QueryLayoutContext
): boolean {
    if (!formatStatements(context)) {
        return false;
    }
    for (const node of context.analysis.index.nodes()) {
        context.statistics.nodeVisitCount += 1;
        if (node.kind === "query" && !formatQuery(context, node)) {
            return false;
        }
        if (
            node.kind === "set-statement" &&
            !formatSetStatement(context, node)
        ) {
            return false;
        }
        if (node.kind === "clause" && !formatClause(context, node)) {
            return false;
        }
        if (node.kind === "cte" && !formatCte(context, node)) {
            return false;
        }
        if (node.kind === "relation" && !formatRelation(context, node)) {
            return false;
        }
        if (
            node.kind === "list" &&
            (node.listRole === "select-items" ||
                node.listRole === "group-by-items" ||
                node.listRole === "order-by-items" ||
                node.listRole === "cluster-by-items" ||
                node.listRole === "distribute-by-items" ||
                node.listRole === "sort-by-items") &&
            !formatQueryList(context, node)
        ) {
            return false;
        }
        if (
            node.kind === "list-item" &&
            !formatListItemAlias(context, node)
        ) {
            return false;
        }
    }
    return true;
}
