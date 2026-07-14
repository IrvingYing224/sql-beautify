import { getDialect } from "../dialects/registry";
import type { QueryClauseSyntax, SetOperatorSyntax } from "../dialects/types";
import type { LeafRange } from "./leaf-range";
import { parseOpaqueList } from "./list-parser";
import type {
    ClauseKind,
    ClauseNode,
    CteNode,
    ListRole,
    QueryNode,
    SyntaxNode,
} from "./node";
import {
    ParserSyntaxError,
    baseDepth,
    createOpaqueWithDiagnostic,
    isAliasNameLeaf,
    isCodeWord,
    isDottedNamePart,
    isQueryLeadingRange,
    matchesSyntaxWords,
    nextSyntaxIndex,
    previousSyntaxIndex,
    syntaxIndexesInRange,
    trimToSyntax,
} from "./parser-context";
import type { ParserContext } from "./parser-context";
import {
    parseFromClauseChildren,
    parseRelationRange,
} from "./relation-parser";

const MAX_PARSER_NESTING = 256;

type ClauseMarker = {
    readonly syntax: QueryClauseSyntax;
    readonly start: number;
    readonly headEnd: number;
};

type SetMarker = {
    readonly syntax: SetOperatorSyntax;
    readonly start: number;
    readonly headEnd: number;
};

function assertNesting(range: LeafRange, nestingDepth: number): void {
    if (nestingDepth >= MAX_PARSER_NESTING) {
        throw new ParserSyntaxError(
            "SYN_MAX_DEPTH_EXCEEDED",
            range,
            `Parser nesting budget ${MAX_PARSER_NESTING} exceeded`
        );
    }
}

function hasPlausibleQueryBody(context: ParserContext, range: LeafRange): boolean {
    if (!isQueryLeadingRange(context, range)) {
        return false;
    }
    if (!isCodeWord(context, range.start, "select")) {
        return true;
    }
    return nextSyntaxIndex(context, range.start, range.end) !== null;
}

function isCteNameLeaf(context: ParserContext, leafIndex: number): boolean {
    const leaf = context.leaves[leafIndex];
    return leaf?.kind === "identifier" || leaf?.kind === "quoted-identifier";
}

function clauseCapabilityIsStructured(
    context: ParserContext,
    syntax: QueryClauseSyntax
): boolean {
    return getDialect(context.dialect).getCapability(syntax.capabilityId)?.state === "structured";
}

function setCapabilityIsStructured(
    context: ParserContext,
    syntax: SetOperatorSyntax
): boolean {
    return getDialect(context.dialect).getCapability(syntax.capabilityId)?.state === "structured";
}

function followsClauseHead(
    context: ParserContext,
    index: number,
    rangeStart: number
): boolean {
    const dialect = getDialect(context.dialect);
    const depth = context.table.depthBefore(index);
    const previous = previousSyntaxIndex(context, index, rangeStart);
    if (previous === null || context.table.depthBefore(previous) !== depth) {
        return false;
    }
    if (isCodeWord(context, previous, "all") || isCodeWord(context, previous, "distinct")) {
        const beforeModifier = previousSyntaxIndex(context, previous, rangeStart);
        if (
            beforeModifier !== null &&
            context.table.depthBefore(beforeModifier) === depth &&
            isCodeWord(context, beforeModifier, "select")
        ) {
            return true;
        }
    }
    for (const syntax of dialect.listQueryClauseSyntax()) {
        if (!clauseCapabilityIsStructured(context, syntax)) {
            continue;
        }
        let cursor: number | null = previous;
        let matches = true;
        for (let wordIndex = syntax.words.length - 1; wordIndex >= 0; wordIndex--) {
            if (
                cursor === null ||
                context.table.depthBefore(cursor) !== depth ||
                !isCodeWord(context, cursor, syntax.words[wordIndex]!)
            ) {
                matches = false;
                break;
            }
            cursor = previousSyntaxIndex(context, cursor, rangeStart);
        }
        if (matches) {
            return true;
        }
    }
    return false;
}

function setMarkerActsAsExpressionName(
    context: ParserContext,
    index: number,
    range: LeafRange,
    next: number | null,
    rightIsQuery: boolean
): boolean {
    if (isDottedNamePart(context, index, range.start, range.end)) {
        return true;
    }
    if (rightIsQuery) {
        return false;
    }
    const previous = previousSyntaxIndex(context, index, range.start);
    if (previous !== null) {
        const previousLeaf = context.leaves[previous]!;
        if (
            previousLeaf.kind === "operator" ||
            previousLeaf.raw === "," ||
            isCodeWord(context, previous, "as") ||
            followsClauseHead(context, index, range.start)
        ) {
            return true;
        }
    }
    if (next === null) {
        return false;
    }
    const nextLeaf = context.leaves[next]!;
    return (
        nextLeaf.kind === "operator" ||
        isCodeWord(context, next, "as")
    );
}

function findSetMarkers(context: ParserContext, range: LeafRange): readonly SetMarker[] {
    const dialect = getDialect(context.dialect);
    const syntaxes = dialect.listSetOperatorSyntax().filter((syntax) =>
        setCapabilityIsStructured(context, syntax)
    );
    if (syntaxes.length === 0) {
        return Object.freeze([]);
    }
    const byWord = new Map(syntaxes.map((syntax) => [syntax.word, syntax]));
    const depth = baseDepth(context, range);
    const markers: SetMarker[] = [];
    for (const index of syntaxIndexesInRange(context, range)) {
        if (context.table.depthBefore(index) !== depth) {
            continue;
        }
        const leaf = context.leaves[index]!;
        if (leaf.channel !== "code") {
            continue;
        }
        const syntax = byWord.get(context.table.normalizedWord(index));
        if (!syntax) {
            continue;
        }
        let headEnd = index + 1;
        const next = nextSyntaxIndex(context, index, range.end);
        let rightStart = next;
        if (
            next !== null &&
            (isCodeWord(context, next, "all") || isCodeWord(context, next, "distinct"))
        ) {
            headEnd = next + 1;
            rightStart = nextSyntaxIndex(context, next, range.end);
        }
        const left = trimToSyntax(context.leaves, { start: range.start, end: index });
        const right =
            rightStart === null
                ? null
                : trimToSyntax(context.leaves, {
                      start: rightStart,
                      end: range.end,
                  });
        const rightIsQuery = right !== null && isQueryLeadingRange(context, right);
        if (rightIsQuery) {
            if (left === null || !hasPlausibleQueryBody(context, left)) {
                throw new ParserSyntaxError(
                    "SYN_INCOMPLETE_CLAUSE",
                    { start: index, end: headEnd },
                    "Set operator requires a complete left query"
                );
            }
            markers.push(Object.freeze({ syntax, start: index, headEnd }));
            continue;
        }
        if (setMarkerActsAsExpressionName(context, index, range, next, rightIsQuery)) {
            continue;
        }
        if (left === null || !hasPlausibleQueryBody(context, left)) {
            continue;
        }
        if (rightStart === null) {
            throw new ParserSyntaxError(
                "SYN_INCOMPLETE_CLAUSE",
                { start: index, end: headEnd },
                "Set operator requires a right query"
            );
        }
        throw new ParserSyntaxError(
            "SYN_UNEXPECTED_TOKEN",
            { start: rightStart, end: range.end },
            "Set operator must be followed by a query"
        );
    }
    return Object.freeze(markers);
}

function findSetTailMarkers(
    context: ParserContext,
    range: LeafRange
): readonly ClauseMarker[] {
    const syntaxes = getDialect(context.dialect)
        .listQueryClauseSyntax()
        .filter(
            (syntax) =>
                (syntax.id === "order-by" || syntax.id === "limit") &&
                clauseCapabilityIsStructured(context, syntax)
        );
    const depth = baseDepth(context, range);
    const markers: ClauseMarker[] = [];
    let previousOrder = Number.NEGATIVE_INFINITY;
    for (const index of syntaxIndexesInRange(context, range)) {
        if (
            context.table.depthBefore(index) !== depth ||
            isDottedNamePart(context, index, range.start, range.end)
        ) {
            continue;
        }
        for (const syntax of syntaxes) {
            const headEnd = markerHeadEnd(context, index, range.end, syntax.words);
            if (
                headEnd === null ||
                markerActsAsExpressionName(context, syntax, headEnd, range.end, false)
            ) {
                continue;
            }
            const operandOrPreviousBody = trimToSyntax(context.leaves, {
                start: markers.length === 0
                    ? range.start
                    : markers[markers.length - 1]!.headEnd,
                end: index,
            });
            if (operandOrPreviousBody === null || syntax.order <= previousOrder) {
                throw new ParserSyntaxError(
                    "SYN_INCOMPLETE_CLAUSE",
                    { start: index, end: headEnd },
                    `${syntax.id.toUpperCase()} set-query tail requires a preceding body`
                );
            }
            markers.push(Object.freeze({ syntax, start: index, headEnd }));
            previousOrder = syntax.order;
            break;
        }
    }
    return Object.freeze(markers);
}

function parseSetQuery(
    context: ParserContext,
    range: LeafRange,
    markers: readonly SetMarker[],
    nestingDepth: number
): QueryNode {
    const children: SyntaxNode[] = [];
    const operatorLeafIds: number[] = [];
    let operandStart = range.start;
    for (const marker of markers) {
        const operand = trimToSyntax(context.leaves, {
            start: operandStart,
            end: marker.start,
        });
        if (operand === null) {
            throw new ParserSyntaxError(
                "SYN_UNEXPECTED_TOKEN",
                { start: marker.start, end: marker.headEnd },
                "Set operator requires a left query"
            );
        }
        children.push(parseQueryAtom(context, operand, nestingDepth + 1));
        children.push(
            context.factory.createClause(
                { start: marker.start, end: marker.headEnd },
                "set-operation",
                { start: marker.start, end: marker.headEnd },
                { start: marker.headEnd, end: marker.headEnd },
                []
            )
        );
        operatorLeafIds.push(marker.start);
        operandStart = marker.headEnd;
    }
    const lastWithTail = trimToSyntax(context.leaves, {
        start: operandStart,
        end: range.end,
    });
    if (lastWithTail === null) {
        throw new ParserSyntaxError(
            "SYN_UNEXPECTED_TOKEN",
            range,
            "Set operator requires a right query"
        );
    }
    const tailMarkers = findSetTailMarkers(context, lastWithTail);
    const last = trimToSyntax(context.leaves, {
        start: lastWithTail.start,
        end: tailMarkers.length === 0 ? lastWithTail.end : tailMarkers[0]!.start,
    });
    if (last === null) {
        throw new ParserSyntaxError(
            "SYN_INCOMPLETE_CLAUSE",
            lastWithTail,
            "Set query requires a final query operand before tail clauses"
        );
    }
    children.push(parseQueryAtom(context, last, nestingDepth + 1));
    for (let i = 0; i < tailMarkers.length; i++) {
        const marker = tailMarkers[i]!;
        const next = i + 1 < tailMarkers.length ? tailMarkers[i + 1]! : null;
        children.push(
            buildSelectClause(
                context,
                marker,
                clauseEndBeforeNextMarker(context, marker, next, range.end),
                nestingDepth
            )
        );
    }
    return context.factory.createQuery(range, "set", operatorLeafIds, children);
}

function parseCteColumnList(
    context: ParserContext,
    open: number,
    close: number
): ReturnType<ParserContext["factory"]["createList"]> {
    const body = trimToSyntax(context.leaves, { start: open + 1, end: close });
    if (body === null) {
        throw new ParserSyntaxError(
            "SYN_INCOMPLETE_CLAUSE",
            { start: open, end: close + 1 },
            "CTE column list requires at least one name"
        );
    }
    return parseOpaqueList(context, body, "cte-columns", {
        allowAlias: false,
        requireSingleName: true,
        reasonMessage: "CTE column name remains opaque until Wave 2C",
    });
}

function parseWithQuery(
    context: ParserContext,
    range: LeafRange,
    nestingDepth: number
): QueryNode {
    const withIndex = range.start;
    let current = nextSyntaxIndex(context, withIndex, range.end);
    if (current === null) {
        throw new ParserSyntaxError(
            "SYN_INCOMPLETE_CLAUSE",
            range,
            "WITH requires at least one CTE and a query"
        );
    }
    const ctes: CteNode[] = [];
    let lastCteEnd = current;
    let mainStart: number | null = null;

    while (current !== null) {
        const nameIndex = current;
        if (!isCteNameLeaf(context, nameIndex)) {
            throw new ParserSyntaxError(
                "SYN_UNEXPECTED_TOKEN",
                { start: nameIndex, end: nameIndex + 1 },
                "CTE name must be an identifier"
            );
        }
        let afterName = nextSyntaxIndex(context, nameIndex, range.end);
        let columnList: ReturnType<ParserContext["factory"]["createList"]> | null = null;
        if (afterName !== null && context.leaves[afterName]!.raw === "(") {
            const closeColumns = context.table.matchingDelimiterIndex(afterName);
            if (closeColumns === null || closeColumns >= range.end) {
                throw new ParserSyntaxError(
                    "SYN_UNMATCHED_DELIMITER",
                    { start: afterName, end: range.end },
                    "CTE column list has an unmatched delimiter"
                );
            }
            columnList = parseCteColumnList(context, afterName, closeColumns);
            afterName = nextSyntaxIndex(context, closeColumns, range.end);
        }
        if (afterName === null || !isCodeWord(context, afterName, "as")) {
            throw new ParserSyntaxError(
                "SYN_INCOMPLETE_CLAUSE",
                { start: nameIndex, end: range.end },
                "CTE requires AS (query)"
            );
        }
        const openQuery = nextSyntaxIndex(context, afterName, range.end);
        if (openQuery === null || context.leaves[openQuery]!.raw !== "(") {
            throw new ParserSyntaxError(
                "SYN_INCOMPLETE_CLAUSE",
                { start: afterName, end: range.end },
                "CTE AS must be followed by a parenthesized query"
            );
        }
        const closeQuery = context.table.matchingDelimiterIndex(openQuery);
        if (closeQuery === null || closeQuery >= range.end) {
            throw new ParserSyntaxError(
                "SYN_UNMATCHED_DELIMITER",
                { start: openQuery, end: range.end },
                "CTE query has an unmatched delimiter"
            );
        }
        const query = parseQueryRange(
            context,
            { start: openQuery, end: closeQuery + 1 },
            nestingDepth + 1
        );
        ctes.push(
            context.factory.createCte(
                { start: nameIndex, end: closeQuery + 1 },
                { start: nameIndex, end: nameIndex + 1 },
                columnList,
                query
            )
        );
        lastCteEnd = closeQuery + 1;
        const afterCte = nextSyntaxIndex(context, closeQuery, range.end);
        if (afterCte !== null && context.leaves[afterCte]!.raw === ",") {
            current = nextSyntaxIndex(context, afterCte, range.end);
            if (current === null) {
                throw new ParserSyntaxError(
                    "SYN_INCOMPLETE_CLAUSE",
                    { start: afterCte, end: range.end },
                    "WITH list must not end after a comma"
                );
            }
            continue;
        }
        mainStart = afterCte;
        break;
    }

    if (mainStart === null) {
        throw new ParserSyntaxError(
            "SYN_INCOMPLETE_CLAUSE",
            range,
            "WITH requires a main query"
        );
    }
    const mainRange = trimToSyntax(context.leaves, { start: mainStart, end: range.end });
    const mainIsInsert =
        mainRange !== null && isCodeWord(context, mainRange.start, "insert");
    if (
        mainRange === null ||
        (!isQueryLeadingRange(context, mainRange) && !mainIsInsert)
    ) {
        throw new ParserSyntaxError(
            "SYN_UNEXPECTED_TOKEN",
            { start: mainStart, end: range.end },
            "WITH must be followed by SELECT, INSERT, nested WITH, or parenthesized query"
        );
    }
    const main = mainIsInsert
        ? parseInsertQueryRange(context, mainRange, nestingDepth + 1)
        : parseQueryRange(context, mainRange, nestingDepth + 1);
    const withClause = context.factory.createClause(
        { start: withIndex, end: lastCteEnd },
        "with",
        { start: withIndex, end: withIndex + 1 },
        { start: withIndex + 1, end: lastCteEnd },
        ctes
    );
    return context.factory.createQuery(range, main.queryKind, [], [withClause, main]);
}

function markerHeadEnd(
    context: ParserContext,
    start: number,
    rangeEnd: number,
    words: readonly string[]
): number | null {
    const matched = matchesSyntaxWords(context, start, rangeEnd, words);
    if (matched === null) {
        return null;
    }
    const depth = context.table.depthBefore(start);
    for (const index of matched) {
        if (context.table.depthBefore(index) !== depth) {
            return null;
        }
    }
    return matched[matched.length - 1]! + 1;
}

function markerActsAsExpressionName(
    context: ParserContext,
    syntax: QueryClauseSyntax,
    headEnd: number,
    rangeEnd: number,
    isFirstBodyToken: boolean
): boolean {
    if (syntax.words.length !== 1) {
        return false;
    }
    const afterHead = nextSyntaxIndex(context, headEnd - 1, rangeEnd);
    if (afterHead === null) {
        return isFirstBodyToken;
    }
    if (
        context.leaves[afterHead]!.kind === "operator" ||
        context.leaves[afterHead]!.raw === "(" ||
        isCodeWord(context, afterHead, "as")
    ) {
        return true;
    }
    if (syntax.id !== "window") {
        return false;
    }

    if (!isAliasNameLeaf(context.leaves[afterHead]!)) {
        return true;
    }
    const asIndex = nextSyntaxIndex(context, afterHead, rangeEnd);
    if (asIndex === null || !isCodeWord(context, asIndex, "as")) {
        return true;
    }
    const open = nextSyntaxIndex(context, asIndex, rangeEnd);
    return open === null || context.leaves[open]!.raw !== "(";
}

function findClauseMarkers(context: ParserContext, range: LeafRange): readonly ClauseMarker[] {
    const dialect = getDialect(context.dialect);
    const syntaxes = dialect.listQueryClauseSyntax().filter((syntax) =>
        clauseCapabilityIsStructured(context, syntax)
    );
    const selectSyntax = syntaxes.find((syntax) => syntax.id === "select");
    if (!selectSyntax || !isCodeWord(context, range.start, "select")) {
        throw new ParserSyntaxError(
            "SYN_UNEXPECTED_TOKEN",
            range,
            "Query must begin with SELECT"
        );
    }

    let selectHeadEnd = range.start + 1;
    const afterSelect = nextSyntaxIndex(context, range.start, range.end);
    if (
        afterSelect !== null &&
        !isDottedNamePart(context, afterSelect, range.start, range.end) &&
        (isCodeWord(context, afterSelect, "all") ||
            isCodeWord(context, afterSelect, "distinct"))
    ) {
        selectHeadEnd = afterSelect + 1;
        const afterModifier = nextSyntaxIndex(context, afterSelect, range.end);
        if (
            afterModifier !== null &&
            (isCodeWord(context, afterModifier, "all") ||
                isCodeWord(context, afterModifier, "distinct"))
        ) {
            throw new ParserSyntaxError(
                "SYN_UNEXPECTED_TOKEN",
                { start: afterSelect, end: afterModifier + 1 },
                "SELECT must not contain conflicting ALL/DISTINCT modifiers"
            );
        }
    }
    const markers: ClauseMarker[] = [
        Object.freeze({ syntax: selectSyntax, start: range.start, headEnd: selectHeadEnd }),
    ];
    const depth = baseDepth(context, range);
    let currentOrder = selectSyntax.order;
    let currentHeadEnd = selectHeadEnd;

    for (const index of syntaxIndexesInRange(context, range)) {
        if (index < currentHeadEnd || context.table.depthBefore(index) !== depth) {
            continue;
        }
        if (isDottedNamePart(context, index, range.start, range.end)) {
            continue;
        }
        const previous = previousSyntaxIndex(context, index, range.start);
        if (previous !== null) {
            const previousLeaf = context.leaves[previous]!;
            if (
                (previousLeaf.kind === "operator" && previousLeaf.raw !== "*") ||
                isCodeWord(context, previous, "as")
            ) {
                continue;
            }
        }
        for (const syntax of syntaxes) {
            if (syntax.id === "select") {
                continue;
            }
            const headEnd = markerHeadEnd(context, index, range.end, syntax.words);
            if (headEnd === null) {
                continue;
            }
            const previousBody = trimToSyntax(context.leaves, {
                start: currentHeadEnd,
                end: index,
            });
            if (
                markerActsAsExpressionName(
                    context,
                    syntax,
                    headEnd,
                    range.end,
                    previousBody === null
                )
            ) {
                continue;
            }
            if (syntax.order <= currentOrder) {
                throw new ParserSyntaxError(
                    "SYN_UNEXPECTED_TOKEN",
                    { start: index, end: headEnd },
                    `${syntax.id.toUpperCase()} clause is duplicated or out of order`
                );
            }
            if (previousBody === null) {
                throw new ParserSyntaxError(
                    "SYN_INCOMPLETE_CLAUSE",
                    { start: markers[markers.length - 1]!.start, end: headEnd },
                    `${markers[markers.length - 1]!.syntax.id.toUpperCase()} clause requires a body before ${syntax.id.toUpperCase()}`
                );
            }
            markers.push(Object.freeze({ syntax, start: index, headEnd }));
            currentOrder = syntax.order;
            currentHeadEnd = headEnd;
            break;
        }
    }
    return Object.freeze(markers);
}

function listFactsForClause(clauseKind: ClauseKind): {
    readonly listRole: ListRole;
    readonly allowAlias: boolean;
    readonly modifierWords: readonly string[];
} | null {
    switch (clauseKind) {
        case "select":
            return Object.freeze({
                listRole: "select-items",
                allowAlias: true,
                modifierWords: Object.freeze([]),
            });
        case "group-by":
            return Object.freeze({
                listRole: "group-by-items",
                allowAlias: false,
                modifierWords: Object.freeze([]),
            });
        case "order-by":
            return Object.freeze({
                listRole: "order-by-items",
                allowAlias: false,
                modifierWords: Object.freeze(["asc", "desc"]),
            });
        case "cluster-by":
            return Object.freeze({
                listRole: "cluster-by-items",
                allowAlias: false,
                modifierWords: Object.freeze([]),
            });
        case "distribute-by":
            return Object.freeze({
                listRole: "distribute-by-items",
                allowAlias: false,
                modifierWords: Object.freeze([]),
            });
        case "sort-by":
            return Object.freeze({
                listRole: "sort-by-items",
                allowAlias: false,
                modifierWords: Object.freeze(["asc", "desc"]),
            });
        case "window":
            return Object.freeze({
                listRole: "other",
                allowAlias: false,
                modifierWords: Object.freeze([]),
            });
        default:
            return null;
    }
}

function clauseEndBeforeNextMarker(
    context: ParserContext,
    marker: ClauseMarker,
    next: ClauseMarker | null,
    queryEnd: number
): number {
    if (next === null) {
        return queryEnd;
    }
    const previous = previousSyntaxIndex(context, next.start, marker.headEnd);
    return previous === null ? next.start : previous + 1;
}

function buildSelectClause(
    context: ParserContext,
    marker: ClauseMarker,
    clauseEnd: number,
    nestingDepth: number
): ClauseNode {
    const clauseKind = marker.syntax.id;
    const clauseRange = Object.freeze({ start: marker.start, end: clauseEnd });
    const bodyRange = Object.freeze({ start: marker.headEnd, end: clauseEnd });
    const body = trimToSyntax(context.leaves, bodyRange);
    if (body === null) {
        throw new ParserSyntaxError(
            "SYN_INCOMPLETE_CLAUSE",
            clauseRange,
            `${clauseKind.toUpperCase()} clause requires a body`
        );
    }
    let children: readonly SyntaxNode[];
    const listFacts = listFactsForClause(clauseKind);
    if (listFacts !== null) {
        children = [
            parseOpaqueList(context, body, listFacts.listRole, {
                allowAlias: listFacts.allowAlias,
                modifierWords: listFacts.modifierWords,
                reasonMessage: `${clauseKind} expression remains opaque until Wave 2C`,
            }),
        ];
    } else if (clauseKind === "from") {
        children = parseFromClauseChildren(context, body, nestingDepth, parseQueryRange);
    } else {
        children = [
            createOpaqueWithDiagnostic(
                context,
                body,
                "SYN_UNMODELED_CONSTRUCT",
                "expression",
                `${clauseKind} expression remains opaque until Wave 2C`
            ),
        ];
    }
    return context.factory.createClause(
        clauseRange,
        clauseKind,
        { start: marker.start, end: marker.headEnd },
        bodyRange,
        children
    );
}

function parseSelectQuery(
    context: ParserContext,
    range: LeafRange,
    nestingDepth: number
): QueryNode {
    const markers = findClauseMarkers(context, range);
    const clauses: ClauseNode[] = [];
    for (let i = 0; i < markers.length; i++) {
        const marker = markers[i]!;
        const next = i + 1 < markers.length ? markers[i + 1]! : null;
        const clauseEnd = clauseEndBeforeNextMarker(context, marker, next, range.end);
        clauses.push(buildSelectClause(context, marker, clauseEnd, nestingDepth));
    }
    return context.factory.createQuery(range, "select", [], clauses);
}

function parseParenthesizedQuery(
    context: ParserContext,
    range: LeafRange,
    nestingDepth: number
): QueryNode {
    const close = context.table.matchingDelimiterIndex(range.start);
    if (close === null || close !== range.end - 1) {
        throw new ParserSyntaxError(
            "SYN_UNMATCHED_DELIMITER",
            range,
            "Parenthesized query must end at its matching delimiter"
        );
    }
    const inner = trimToSyntax(context.leaves, { start: range.start + 1, end: close });
    if (inner === null) {
        throw new ParserSyntaxError(
            "SYN_INCOMPLETE_CLAUSE",
            range,
            "Parenthesized query is empty"
        );
    }
    const child = parseQueryRange(context, inner, nestingDepth + 1);
    return context.factory.createQuery(range, "parenthesized", [], [child]);
}

function parseQueryAtom(
    context: ParserContext,
    inputRange: LeafRange,
    nestingDepth: number
): QueryNode {
    assertNesting(inputRange, nestingDepth);
    const range = trimToSyntax(context.leaves, inputRange);
    if (range === null) {
        throw new ParserSyntaxError(
            "SYN_UNEXPECTED_TOKEN",
            inputRange,
            "Query range is empty"
        );
    }
    if (context.leaves[range.start]!.channel === "code" && context.leaves[range.start]!.raw === "(") {
        return parseParenthesizedQuery(context, range, nestingDepth);
    }
    if (isCodeWord(context, range.start, "with")) {
        return parseWithQuery(context, range, nestingDepth);
    }
    if (isCodeWord(context, range.start, "select")) {
        return parseSelectQuery(context, range, nestingDepth);
    }
    throw new ParserSyntaxError(
        "SYN_UNEXPECTED_TOKEN",
        range,
        `Unsupported query-leading token ${context.leaves[range.start]!.raw}`
    );
}

export function parseQueryRange(
    context: ParserContext,
    inputRange: LeafRange,
    nestingDepth: number = 0
): QueryNode {
    assertNesting(inputRange, nestingDepth);
    const range = trimToSyntax(context.leaves, inputRange);
    if (range === null) {
        throw new ParserSyntaxError(
            "SYN_UNEXPECTED_TOKEN",
            inputRange,
            "Query range is empty"
        );
    }
    const markers = findSetMarkers(context, range);
    if (markers.length > 0) {
        return parseSetQuery(context, range, markers, nestingDepth);
    }
    return parseQueryAtom(context, range, nestingDepth);
}

export function parseInsertQueryRange(
    context: ParserContext,
    inputRange: LeafRange,
    nestingDepth: number = 0
): QueryNode {
    assertNesting(inputRange, nestingDepth);
    const range = trimToSyntax(context.leaves, inputRange);
    if (range === null) {
        throw new ParserSyntaxError(
            "SYN_UNEXPECTED_TOKEN",
            inputRange,
            "INSERT range is empty"
        );
    }
    const insertHead = matchesSyntaxWords(context, range.start, range.end, ["insert", "overwrite"]);
    if (insertHead === null) {
        throw new ParserSyntaxError(
            "SYN_UNSUPPORTED_STATEMENT",
            range,
            "Wave 2B supports INSERT OVERWRITE query statements only"
        );
    }
    let headLast = insertHead[insertHead.length - 1]!;
    const tableKeyword = nextSyntaxIndex(context, headLast, range.end);
    if (tableKeyword === null || !isCodeWord(context, tableKeyword, "table")) {
        throw new ParserSyntaxError(
            "SYN_UNSUPPORTED_STATEMENT",
            range,
            "Wave 2B supports INSERT OVERWRITE TABLE query statements only"
        );
    }
    headLast = tableKeyword;
    const targetStart = nextSyntaxIndex(context, tableKeyword, range.end);
    if (targetStart === null) {
        throw new ParserSyntaxError(
            "SYN_INCOMPLETE_CLAUSE",
            range,
            "INSERT OVERWRITE requires a target table"
        );
    }
    const depth = baseDepth(context, range);
    let partitionStart: number | null = null;
    let selectStart: number | null = null;
    for (const index of syntaxIndexesInRange(context, { start: targetStart, end: range.end })) {
        if (context.table.depthBefore(index) !== depth) {
            continue;
        }
        const isQualifiedNamePart = isDottedNamePart(
            context,
            index,
            targetStart,
            range.end
        );
        if (
            partitionStart === null &&
            !isQualifiedNamePart &&
            isCodeWord(context, index, "partition")
        ) {
            partitionStart = index;
            continue;
        }
        if (
            !isQualifiedNamePart &&
            (isCodeWord(context, index, "select") || isCodeWord(context, index, "with"))
        ) {
            selectStart = index;
            break;
        }
    }
    if (selectStart === null) {
        throw new ParserSyntaxError(
            "SYN_INCOMPLETE_CLAUSE",
            range,
            "INSERT OVERWRITE requires a SELECT query"
        );
    }
    const targetEndBoundary = partitionStart ?? selectStart;
    const targetRange = trimToSyntax(context.leaves, {
        start: targetStart,
        end: targetEndBoundary,
    });
    if (targetRange === null) {
        throw new ParserSyntaxError(
            "SYN_INCOMPLETE_CLAUSE",
            range,
            "INSERT OVERWRITE target table is empty"
        );
    }
    const target = parseRelationRange(context, targetRange, nestingDepth, parseQueryRange);
    const insertClause = context.factory.createClause(
        { start: range.start, end: targetRange.end },
        "insert",
        { start: range.start, end: headLast + 1 },
        { start: headLast + 1, end: targetRange.end },
        [target]
    );
    const children: SyntaxNode[] = [insertClause];

    if (partitionStart !== null) {
        const open = nextSyntaxIndex(context, partitionStart, selectStart);
        if (open === null || context.leaves[open]!.raw !== "(") {
            throw new ParserSyntaxError(
                "SYN_INCOMPLETE_CLAUSE",
                { start: partitionStart, end: selectStart },
                "PARTITION requires a parenthesized column list"
            );
        }
        const close = context.table.matchingDelimiterIndex(open);
        if (close === null || close >= selectStart) {
            throw new ParserSyntaxError(
                "SYN_UNMATCHED_DELIMITER",
                { start: partitionStart, end: selectStart },
                "PARTITION list has an unmatched delimiter"
            );
        }
        const partitionBody = trimToSyntax(context.leaves, { start: open + 1, end: close });
        if (partitionBody === null) {
            throw new ParserSyntaxError(
                "SYN_INCOMPLETE_CLAUSE",
                { start: partitionStart, end: close + 1 },
                "PARTITION requires at least one column"
            );
        }
        const afterPartition = nextSyntaxIndex(context, close, range.end);
        if (afterPartition !== selectStart) {
            throw new ParserSyntaxError(
                "SYN_UNEXPECTED_TOKEN",
                { start: close + 1, end: selectStart },
                "Unexpected syntax between PARTITION and SELECT"
            );
        }
        const list = parseOpaqueList(
            context,
            partitionBody,
            "partition-columns",
            {
                allowAlias: false,
                reasonMessage: "PARTITION expression remains opaque until Wave 2C",
            }
        );
        children.push(
            context.factory.createClause(
                { start: partitionStart, end: close + 1 },
                "partition",
                { start: partitionStart, end: open + 1 },
                { start: open + 1, end: close },
                [list]
            )
        );
    }

    const selectRange = trimToSyntax(context.leaves, { start: selectStart, end: range.end });
    if (selectRange === null) {
        throw new ParserSyntaxError(
            "SYN_INCOMPLETE_CLAUSE",
            range,
            "INSERT OVERWRITE SELECT body is empty"
        );
    }
    children.push(parseQueryRange(context, selectRange, nestingDepth + 1));
    return context.factory.createQuery(range, "select", [], children);
}
