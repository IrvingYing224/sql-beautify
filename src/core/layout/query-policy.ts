import type { LeafRange } from "../syntax/leaf-range";
import type {
    ClauseNode,
    CteNode,
    GenericStatementNode,
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

/**
 * Generic layer (plan §5.3): only the amount of whitespace changes. A run inside a line becomes
 * one space and a run before a line break goes away; line breaks, continuation indentation,
 * zero-width gaps and the command payload stay as written.
 */
function formatGenericRange(
    context: QueryLayoutContext,
    authorityNodeId: number,
    range: LeafRange
): boolean {
    const { analysis } = context;
    for (let leafId = range.start; leafId < range.end; leafId++) {
        if (
            analysis.leafKind(leafId) !== "whitespace" ||
            context.claims.claimForLeaf(leafId) !== null
        ) {
            continue;
        }
        const decision = analysis.leafKind(leafId + 1) === "newline"
            ? EMPTY
            : analysis.leafKind(leafId - 1) === "newline"
              ? null
              : SPACE;
        if (
            decision !== null &&
            !context.plan.replaceGap(authorityNodeId, leafId, leafId + 1, decision)
        ) {
            return false;
        }
    }
    return true;
}

function formatGenericStatement(
    context: QueryLayoutContext,
    statement: GenericStatementNode
): boolean {
    const authorityNodeId = authorityForNode(context, statement.id);
    return authorityNodeId === null ||
        formatGenericRange(context, authorityNodeId, statement.leafRange);
}

function formatClause(
    context: QueryLayoutContext,
    clause: ClauseNode
): boolean {
    const authorityNodeId = authorityForNode(context, clause.id);
    if (authorityNodeId === null) {
        return true;
    }
    if (clause.clauseKind === "create-table") {
        // The CTAS shell takes the generic layer; the query starts on the next line.
        return formatGenericRange(context, authorityNodeId, clause.leafRange);
    }
    if (
        !normalizeMarkerSequence(
            context,
            authorityNodeId,
            markerSequenceInRange(
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
            const delimiters = matchingDelimitersAround(context, clause.leafRange, first.leafRange);
            return (
                delimiters !== null &&
                formatDelimitedList(
                    context,
                    authorityNodeId,
                    clause.leafRange,
                    null,
                    first,
                    false
                ) &&
                formatInsertColumns(context, authorityNodeId, clause, delimiters[1] + 1)
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
        case "group-by":
            return first === undefined ||
                formatClauseBody(context, authorityNodeId, clause, first.leafRange.end);
        case "limit":
            return formatClauseBody(context, authorityNodeId, clause, clause.headLeafRange.end);
        case "insert":
            return first === undefined ||
                (replaceStructuralGap(
                    context,
                    authorityNodeId,
                    clause.headLeafRange.end,
                    first.leafRange.start,
                    SPACE
                ) &&
                    formatInsertColumns(context, authorityNodeId, clause, first.leafRange.end));
        case "select":
        case "order-by":
        case "cluster-by":
        case "distribute-by":
        case "sort-by":
        case "set-operation":
            return true;
        case "where":
        case "having":
        case "join-on":
        case "lateral-view":
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

/**
 * Children and body keywords from `fromLeafId` on (`, n`, `OFFSET m`, `WITH ROLLUP`) are one
 * space apart; a separator comma takes no space before it.
 */
function formatClauseBody(
    context: QueryLayoutContext,
    authorityNodeId: number,
    clause: ClauseNode,
    fromLeafId: number
): boolean {
    const keyword = `clause:${clause.clauseKind}`;
    const anchors = [
        ...clause.children.map((child) => child.leafRange),
        ...clause.syntaxMarkers
            .filter(
                (marker) =>
                    marker.syntaxId === keyword && marker.leafId >= clause.headLeafRange.end
            )
            .map((marker) => ({ start: marker.leafId, end: marker.leafId + 1 })),
        ...clause.separatorLeafIds.map((leafId) => ({ start: leafId, end: leafId + 1 })),
    ]
        .filter((anchor) => anchor.start >= fromLeafId)
        .sort((left, right) => left.start - right.start);
    let leftEnd = fromLeafId;
    for (const anchor of anchors) {
        const decision = clause.separatorLeafIds.includes(anchor.start) ? EMPTY : SPACE;
        if (!replaceStructuralGap(context, authorityNodeId, leftEnd, anchor.start, decision)) {
            return false;
        }
        leftEnd = anchor.end;
    }
    return true;
}

/** `t (c1, c2)` and `PARTITION (…) (c1, c2)`: the INSERT column list one space after `leftEnd`. */
function formatInsertColumns(
    context: QueryLayoutContext,
    authorityNodeId: number,
    clause: ClauseNode,
    leftEnd: number
): boolean {
    const columns = clause.children[1];
    return (
        columns === undefined ||
        (columns.kind === "list" &&
            formatDelimitedList(
                context,
                authorityNodeId,
                clause.leafRange,
                leftEnd,
                columns,
                true
            ))
    );
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
    const asMarker = cte.syntaxMarkers.find(
        (marker) => marker.syntaxId === "cte-as"
    );
    const query = context.analysis.index.nodeById(cte.queryChildId);
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
        return context.analysis.index.nodeById(
            statement.bodyChildId
        ).leafRange.start;
    }
    const terminator = statement.syntaxMarkers.find(
        (marker) => marker.syntaxId === "statement-terminator"
    );
    return terminator?.leafId ?? null;
}

function formatStatements(context: QueryLayoutContext): boolean {
    const program = context.analysis.root;
    const capability = context.analysis.index.capabilityForNode(program.id);
    if (capability?.state !== "formatted") {
        return true;
    }
    const statements = program.children;
    for (let index = 1; index < statements.length; index++) {
        const left = statements[index - 1]!;
        const rightStart = firstStatementSyntax(context, statements[index]!);
        if (rightStart !== null) {
            const claim = context.claims.claimForLeaf(rightStart);
            if (claim !== null && claim.leafRange.start === rightStart) {
                // An opaque statement owns its leading trivia. Its existing
                // line break already separates the statements; inserting one
                // outside the claim would add another on every format pass.
                let prefix = rightStart;
                while (
                    prefix < claim.leafRange.end &&
                    context.analysis.leafKind(prefix) === "whitespace"
                ) {
                    prefix += 1;
                }
                if (context.analysis.leafKind(prefix) === "newline") {
                    continue;
                }
            }
        }
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
        if (node.kind === "query" && !formatQuery(context, node)) {
            return false;
        }
        if (
            node.kind === "set-statement" &&
            !formatSetStatement(context, node)
        ) {
            return false;
        }
        if (
            node.kind === "generic-statement" &&
            !formatGenericStatement(context, node)
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
