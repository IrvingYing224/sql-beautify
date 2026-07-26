import { getDialect } from "../dialects/registry";
import { isParserStructuredCapabilityState } from "../dialects/capability-state";
import type {
    OperatorSemantics,
    QueryClauseSyntax,
    SetOperatorSyntax,
} from "../dialects/types";
import type { LeafRange } from "./leaf-range";
import { parseList } from "./list-parser";
import { parseExpressionRange } from "./expression-parser";
import { parseWindowDeclaration } from "./window-parser";
import {
    classifyUnsupportedGroupBySuffix,
    classifyUnsupportedSelectItemPrefix,
    classifyUnsupportedStatementStart,
    findUnsupportedQueryClauseCandidates,
} from "./unsupported-recognizer";
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
    firstSyntaxOrdinalInRange,
    isAliasNameLeaf,
    isCodeWord,
    isDottedNamePart,
    isQueryLeadingRange,
    lastSyntaxOrdinalInRange,
    mergeSyntaxMarkers,
    nodeFacts,
    nextSyntaxIndex,
    previousSyntaxIndex,
    syntaxIndexesInRange,
    syntaxMarkers,
    topLevelSyntaxIndexes,
    trimToSyntax,
} from "./parser-context";
import type { ParserContext } from "./parser-context";
import { hasAsciiKeywordCaseShape } from "./contextual-fact-contract";
import { assertParserDepth, descendParserDepth } from "./parser-depth";
import {
    createParserCheckpoint,
    recoverOpaqueFromError,
    rollbackParserCheckpoint,
} from "./recovery";
import {
    parseFromClauseChildren,
    parseRelationRange,
    relationRangeIsBoundedAliasColumnList,
    relationPrefixesCanAcceptAlias,
} from "./relation-parser";
import type { RelationAliasCandidate } from "./relation-parser";

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

const MAX_UNSUPPORTED_CLAUSE_PROOFS = 16;

function queryClauseFacts(
    context: ParserContext,
    clauseKind: ClauseKind,
    headRange: LeafRange,
    capabilityId: string | null,
    separatorLeafIds: readonly number[] = []
) {
    const headLeafIds = syntaxIndexesInRange(context, headRange);
    const keywordLeafIds: number[] = [];
    const delimiterLeafIds: number[] = [];
    for (const leafId of headLeafIds) {
        const leaf = context.leaves[leafId]!;
        if (
            leaf.channel === "code" &&
            hasAsciiKeywordCaseShape(leaf.raw)
        ) {
            keywordLeafIds.push(leafId);
        } else if (context.table.matchingDelimiterIndex(leafId) !== null) {
            delimiterLeafIds.push(leafId);
        }
    }
    const facts = nodeFacts(
        capabilityId,
        capabilityId === null ? "intrinsic-container" : "capability",
        mergeSyntaxMarkers(
            syntaxMarkers(keywordLeafIds, `clause:${clauseKind}`),
            syntaxMarkers(
                delimiterLeafIds,
                "delimiter",
                "delimiter",
                false
            )
        )
    );
    return {
        syntaxMarkers: facts.syntaxMarkers,
        capabilityId: facts.capabilityId,
        formatRole: facts.formatRole,
        separatorLeafIds,
    };
}

type StructuredQuerySyntaxView = Readonly<{
    syntaxes: readonly QueryClauseSyntax[];
    select: QueryClauseSyntax | null;
    byFirstWord: Readonly<Record<string, readonly QueryClauseSyntax[]>>;
}>;

type StructuredSetSyntaxView = Readonly<{
    count: number;
    byWord: Readonly<Record<string, SetOperatorSyntax>>;
}>;

const STRUCTURED_QUERY_SYNTAX_CACHE: Partial<
    Record<ParserContext["dialect"], StructuredQuerySyntaxView>
> = Object.create(null) as Partial<
    Record<ParserContext["dialect"], StructuredQuerySyntaxView>
>;

const STRUCTURED_SET_SYNTAX_CACHE: Partial<
    Record<ParserContext["dialect"], StructuredSetSyntaxView>
> = Object.create(null) as Partial<
    Record<ParserContext["dialect"], StructuredSetSyntaxView>
>;

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

function structuredQuerySyntaxes(context: ParserContext): StructuredQuerySyntaxView {
    const cached = STRUCTURED_QUERY_SYNTAX_CACHE[context.dialect];
    if (cached !== undefined) {
        return cached;
    }
    const dialect = getDialect(context.dialect);
    const syntaxes = Object.freeze(
        dialect.listQueryClauseSyntax().filter(
            (syntax) =>
                syntax.capabilityId === null ||
                isParserStructuredCapabilityState(
                    dialect.getCapability(syntax.capabilityId)?.state
                )
        )
    );
    let select: QueryClauseSyntax | null = null;
    const mutableByFirstWord = Object.create(null) as Record<
        string,
        QueryClauseSyntax[]
    >;
    for (let index = 0; index < syntaxes.length; index++) {
        const syntax = syntaxes[index]!;
        if (syntax.id === "select") {
            select = syntax;
        }
        const firstWord = syntax.words[0]!;
        const candidates = mutableByFirstWord[firstWord];
        if (candidates === undefined) {
            mutableByFirstWord[firstWord] = [syntax];
        } else {
            candidates.push(syntax);
        }
    }
    const byFirstWord = Object.create(null) as Record<
        string,
        readonly QueryClauseSyntax[]
    >;
    for (const firstWord of Object.keys(mutableByFirstWord)) {
        byFirstWord[firstWord] = Object.freeze(mutableByFirstWord[firstWord]!);
    }
    const view = Object.freeze({
        syntaxes,
        select,
        byFirstWord: Object.freeze(byFirstWord),
    });
    STRUCTURED_QUERY_SYNTAX_CACHE[context.dialect] = view;
    return view;
}

function structuredSetSyntaxes(context: ParserContext): StructuredSetSyntaxView {
    const cached = STRUCTURED_SET_SYNTAX_CACHE[context.dialect];
    if (cached !== undefined) {
        return cached;
    }
    const dialect = getDialect(context.dialect);
    const byWord = Object.create(null) as Record<string, SetOperatorSyntax>;
    let count = 0;
    const syntaxes = dialect.listSetOperatorSyntax();
    for (let index = 0; index < syntaxes.length; index++) {
        const syntax = syntaxes[index]!;
        const state = dialect.getCapability(syntax.capabilityId)?.state;
        if (isParserStructuredCapabilityState(state)) {
            byWord[syntax.word] = syntax;
            count += 1;
        }
    }
    const view = Object.freeze({
        count,
        byWord: Object.freeze(byWord),
    });
    STRUCTURED_SET_SYNTAX_CACHE[context.dialect] = view;
    return view;
}

function followsClauseHead(
    context: ParserContext,
    index: number,
    rangeStart: number
): boolean {
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
    const syntaxes = structuredQuerySyntaxes(context).syntaxes;
    for (let syntaxIndex = 0; syntaxIndex < syntaxes.length; syntaxIndex++) {
        const syntax = syntaxes[syntaxIndex]!;
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

function findSetMarkers(
    context: ParserContext,
    range: LeafRange,
    topLevelIndexes: readonly number[]
): readonly SetMarker[] {
    const syntaxes = structuredSetSyntaxes(context);
    if (syntaxes.count === 0) {
        return Object.freeze([]);
    }
    const markers: SetMarker[] = [];
    for (const index of topLevelIndexes) {
        const leaf = context.leaves[index]!;
        if (leaf.channel !== "code") {
            continue;
        }
        const syntax = syntaxes.byWord[context.table.normalizedWord(index)];
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
    const syntaxView = structuredQuerySyntaxes(context);
    const depth = baseDepth(context, range);
    const markers: ClauseMarker[] = [];
    let previousOrder = Number.NEGATIVE_INFINITY;
    const firstOrdinal = firstSyntaxOrdinalInRange(context, range);
    const lastOrdinal = firstOrdinal === null
        ? -1
        : lastSyntaxOrdinalInRange(context, range)!;
    for (let ordinal = firstOrdinal ?? 0; ordinal <= lastOrdinal; ordinal++) {
        const index = context.table.leafIndexOfSyntaxOrdinal(ordinal);
        if (
            context.table.depthBefore(index) !== depth ||
            isDottedNamePart(context, index, range.start, range.end)
        ) {
            continue;
        }
        const leaf = context.leaves[index]!;
        if (leaf.channel !== "code") {
            continue;
        }
        const candidates = syntaxView.byFirstWord[
            context.table.normalizedWord(index)
        ];
        if (candidates === undefined) {
            continue;
        }
        for (let syntaxIndex = 0; syntaxIndex < candidates.length; syntaxIndex++) {
            const syntax = candidates[syntaxIndex]!;
            if (syntax.id !== "order-by" && syntax.id !== "limit") {
                continue;
            }
            const headEnd = markerHeadEndAfterFirst(
                context,
                index,
                range.end,
                syntax.words
            );
            if (
                headEnd === null ||
                markerActsAsExpressionName(
                    context,
                    syntax,
                    headEnd,
                    range.end,
                    false,
                    false
                )
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
        children.push(
            parseQueryAtom(
                context,
                operand,
                descendParserDepth(operand, nestingDepth)
            )
        );
        children.push(
            context.factory.createClause(
                { start: marker.start, end: marker.headEnd },
                "set-operation",
                { start: marker.start, end: marker.headEnd },
                { start: marker.headEnd, end: marker.headEnd },
                [],
                {
                    ...nodeFacts(
                        marker.syntax.capabilityId,
                        "capability",
                        syntaxMarkers(
                            syntaxIndexesInRange(context, {
                                start: marker.start,
                                end: marker.headEnd,
                            }),
                            "set-operator"
                        )
                    ),
                    separatorLeafIds: [],
                }
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
    children.push(
        parseQueryAtom(
            context,
            last,
            descendParserDepth(last, nestingDepth)
        )
    );
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
    return context.factory.createQuery(
        range,
        "set",
        operatorLeafIds,
        children,
        nodeFacts("set-operations", "capability")
    );
}

function parseCteColumnList(
    context: ParserContext,
    open: number,
    close: number,
    nestingDepth: number
): ReturnType<ParserContext["factory"]["createList"]> {
    const body = trimToSyntax(context.leaves, { start: open + 1, end: close });
    if (body === null) {
        throw new ParserSyntaxError(
            "SYN_INCOMPLETE_CLAUSE",
            { start: open, end: close + 1 },
            "CTE column list requires at least one name"
        );
    }
    return parseList(
        context,
        body,
        "cte-columns",
        {
            allowAlias: false,
            requireSingleName: true,
            reasonMessage: "CTE column name is not modeled",
        },
        (parserContext, valueRange) =>
            parseExpressionRange(
                parserContext,
                valueRange,
                parseQueryRange,
                nestingDepth
            )
    );
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
    const cteSeparators: number[] = [];
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
            const columnRange = Object.freeze({
                start: afterName,
                end: closeColumns + 1,
            });
            columnList = parseCteColumnList(
                context,
                afterName,
                closeColumns,
                descendParserDepth(columnRange, nestingDepth)
            );
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
            nestingDepth
        );
        ctes.push(
            context.factory.createCte(
                { start: nameIndex, end: closeQuery + 1 },
                { start: nameIndex, end: nameIndex + 1 },
                columnList,
                query,
                nodeFacts(
                    null,
                    "intrinsic-container",
                    syntaxMarkers([afterName], "cte-as")
                )
            )
        );
        lastCteEnd = closeQuery + 1;
        const afterCte = nextSyntaxIndex(context, closeQuery, range.end);
        if (afterCte !== null && context.leaves[afterCte]!.raw === ",") {
            cteSeparators.push(afterCte);
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
    const unsupportedMain = mainRange === null
        ? null
        : classifyUnsupportedStatementStart(context, mainRange);
    if (unsupportedMain?.state === "diagnostic") {
        throw new ParserSyntaxError(
            "SYN_UNSUPPORTED_STATEMENT",
            mainRange!,
            `${context.dialect} ${unsupportedMain.signature.capabilityId} statement after WITH is recognized but not structured`,
            "statement",
            unsupportedMain.signature.capabilityId
        );
    }
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
        ? parseInsertQueryRange(
              context,
              mainRange,
              descendParserDepth(mainRange, nestingDepth)
          )
        : parseQueryRange(
              context,
              mainRange,
              descendParserDepth(mainRange, nestingDepth)
          );
    const withClause = context.factory.createClause(
        { start: withIndex, end: lastCteEnd },
        "with",
        { start: withIndex, end: withIndex + 1 },
        { start: withIndex + 1, end: lastCteEnd },
        ctes,
        {
            ...queryClauseFacts(
                context,
                "with",
                { start: withIndex, end: withIndex + 1 },
                null
            ),
            separatorLeafIds: cteSeparators,
        }
    );
    return context.factory.createQuery(
        range,
        main.queryKind,
        [],
        [withClause, main],
        nodeFacts("with-cte", "capability")
    );
}

function markerHeadEndAfterFirst(
    context: ParserContext,
    start: number,
    rangeEnd: number,
    words: readonly string[]
): number | null {
    const depth = context.table.depthBefore(start);
    let last = start;
    let current = nextSyntaxIndex(context, start, rangeEnd);
    for (let wordIndex = 1; wordIndex < words.length; wordIndex++) {
        if (
            current === null ||
            current >= rangeEnd ||
            context.table.depthBefore(current) !== depth ||
            !isCodeWord(context, current, words[wordIndex]!)
        ) {
            return null;
        }
        last = current;
        current = nextSyntaxIndex(context, current, rangeEnd);
    }
    return last + 1;
}

function markerActsAsExpressionName(
    context: ParserContext,
    syntax: QueryClauseSyntax,
    headEnd: number,
    rangeEnd: number,
    isFirstBodyToken: boolean,
    followsComma: boolean
): boolean {
    if (syntax.words.length !== 1) {
        return false;
    }
    if (!isFirstBodyToken) {
        const previous = previousSyntaxIndex(context, headEnd - 1, 0);
        return previous !== null &&
            context.leaves[previous]!.raw !== "*" &&
            (operatorSemanticsAt(context, previous).some(
                (semantics) =>
                    semantics.fixity === "prefix" || semantics.fixity === "infix"
            ) ||
                isCodeWord(context, previous, "case") ||
                isCodeWord(context, previous, "when") ||
                isCodeWord(context, previous, "then") ||
                isCodeWord(context, previous, "else"));
    }
    const afterHead = nextSyntaxIndex(context, headEnd - 1, rangeEnd);
    if (afterHead === null) {
        return true;
    }
    if (followsComma) {
        const leaf = context.leaves[afterHead]!;
        if (leaf.channel === "code") {
            const candidates = structuredQuerySyntaxes(context).byFirstWord[
                context.table.normalizedWord(afterHead)
            ];
            if (candidates !== undefined) {
                for (
                    let syntaxIndex = 0;
                    syntaxIndex < candidates.length;
                    syntaxIndex++
                ) {
                    const other = candidates[syntaxIndex]!;
                    if (
                        other.id !== syntax.id &&
                        markerHeadEndAfterFirst(
                            context,
                            afterHead,
                            rangeEnd,
                            other.words
                        ) !== null
                    ) {
                        return true;
                    }
                }
            }
        }
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

function findClauseMarkers(
    context: ParserContext,
    range: LeafRange,
    topLevelIndexes: readonly number[]
): readonly ClauseMarker[] {
    const syntaxView = structuredQuerySyntaxes(context);
    const selectSyntax = syntaxView.select;
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
    let currentOrder = selectSyntax.order;
    let currentHeadEnd = selectHeadEnd;

    for (const index of topLevelIndexes) {
        if (index < currentHeadEnd) {
            continue;
        }
        const leaf = context.leaves[index]!;
        if (leaf.channel !== "code") {
            continue;
        }
        const candidates = syntaxView.byFirstWord[
            context.table.normalizedWord(index)
        ];
        if (candidates === undefined) {
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
        for (let syntaxIndex = 0; syntaxIndex < candidates.length; syntaxIndex++) {
            const syntax = candidates[syntaxIndex]!;
            if (syntax.id === "select") {
                continue;
            }
            const headEnd = markerHeadEndAfterFirst(
                context,
                index,
                range.end,
                syntax.words
            );
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
                    previousBody === null ||
                        (previous !== null && context.leaves[previous]!.raw === ","),
                    previous !== null && context.leaves[previous]!.raw === ","
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

type ClauseListFacts = Readonly<{
    readonly listRole: ListRole;
    readonly allowAlias: boolean;
    readonly modifierWords: readonly string[];
}>;

const EMPTY_LIST_MODIFIERS: readonly string[] = Object.freeze([]);
const ORDER_LIST_MODIFIERS: readonly string[] = Object.freeze(["asc", "desc"]);
const LIST_FACTS_BY_CLAUSE: Partial<Record<ClauseKind, ClauseListFacts>> =
    Object.freeze({
        select: Object.freeze({
            listRole: "select-items" as const,
            allowAlias: true,
            modifierWords: EMPTY_LIST_MODIFIERS,
        }),
        "group-by": Object.freeze({
            listRole: "group-by-items" as const,
            allowAlias: false,
            modifierWords: EMPTY_LIST_MODIFIERS,
        }),
        "order-by": Object.freeze({
            listRole: "order-by-items" as const,
            allowAlias: false,
            modifierWords: ORDER_LIST_MODIFIERS,
        }),
        "cluster-by": Object.freeze({
            listRole: "cluster-by-items" as const,
            allowAlias: false,
            modifierWords: EMPTY_LIST_MODIFIERS,
        }),
        "distribute-by": Object.freeze({
            listRole: "distribute-by-items" as const,
            allowAlias: false,
            modifierWords: EMPTY_LIST_MODIFIERS,
        }),
        "sort-by": Object.freeze({
            listRole: "sort-by-items" as const,
            allowAlias: false,
            modifierWords: ORDER_LIST_MODIFIERS,
        }),
        window: Object.freeze({
            listRole: "other" as const,
            allowAlias: false,
            modifierWords: EMPTY_LIST_MODIFIERS,
        }),
    });

function listFactsForClause(clauseKind: ClauseKind): ClauseListFacts | null {
    return LIST_FACTS_BY_CLAUSE[clauseKind] ?? null;
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
    const checkpoint = createParserCheckpoint(context);
    let children: readonly SyntaxNode[];
    let separatorLeafIds: readonly number[] = [];
    try {
        const listFacts = listFactsForClause(clauseKind);
        if (listFacts !== null) {
            children = [
                parseList(
                    context,
                    body,
                    listFacts.listRole,
                    {
                        allowAlias: listFacts.allowAlias,
                        modifierWords: listFacts.modifierWords,
                        reasonMessage: `${clauseKind} expression is not structured`,
                    },
                    clauseKind === "window"
                        ? (parserContext, valueRange) =>
                              parseWindowDeclaration(
                                  parserContext,
                                  valueRange,
                                  nestingDepth,
                                  (windowContext, windowRange, windowDepth) =>
                                      parseExpressionRange(
                                          windowContext,
                                          windowRange,
                                          parseQueryRange,
                                          windowDepth
                                      )
                              )
                        : (parserContext, valueRange) =>
                              parseExpressionRange(
                                  parserContext,
                                  valueRange,
                                  parseQueryRange,
                                  nestingDepth
                              )
                ),
            ];
        } else if (clauseKind === "from") {
            const parsedFrom = parseFromClauseChildren(
                context,
                body,
                nestingDepth,
                parseQueryRange
            );
            children = parsedFrom.children;
            separatorLeafIds = parsedFrom.separatorLeafIds;
        } else {
            children = [
                parseExpressionRange(
                    context,
                    body,
                    parseQueryRange,
                    nestingDepth
                ),
            ];
        }
    } catch (error) {
        children = [
            recoverOpaqueFromError(
                context,
                checkpoint,
                body,
                error,
                "clause",
                `${clauseKind} clause preserved: `
            ),
        ];
    }
    return context.factory.createClause(
        clauseRange,
        clauseKind,
        { start: marker.start, end: marker.headEnd },
        bodyRange,
        children,
        queryClauseFacts(
            context,
            clauseKind,
            { start: marker.start, end: marker.headEnd },
            marker.syntax.capabilityId,
            separatorLeafIds
        )
    );
}

function containsOpaque(
    context: ParserContext,
    node: SyntaxNode,
    allowBoundedRelationAliasLists: boolean,
    nestingDepth: number
): boolean {
    const stack: SyntaxNode[] = [node];
    while (stack.length > 0) {
        const current = stack.pop()!;
        if (
            allowBoundedRelationAliasLists &&
            current.kind === "relation" &&
            current.relationKind === "opaque" &&
            relationRangeIsBoundedAliasColumnList(
                context,
                current.leafRange,
                nestingDepth,
                parseQueryRange
            )
        ) {
            continue;
        }
        if (current.kind === "opaque") {
            return true;
        }
        for (let index = current.children.length - 1; index >= 0; index--) {
            stack.push(current.children[index]!);
        }
    }
    return false;
}

function trialIsFullyStructured(
    context: ParserContext,
    build: () => SyntaxNode,
    allowBoundedRelationAliasLists: boolean = false,
    nestingDepth: number = 0
): boolean {
    const checkpoint = createParserCheckpoint(context);
    try {
        const node = build();
        const structured = !containsOpaque(
            context,
            node,
            allowBoundedRelationAliasLists,
            nestingDepth
        );
        rollbackParserCheckpoint(context, checkpoint);
        return structured;
    } catch (error) {
        rollbackParserCheckpoint(context, checkpoint);
        if (error instanceof ParserSyntaxError) {
            return false;
        }
        throw error;
    }
}

function operatorSemanticsAt(
    context: ParserContext,
    leafIndex: number
): readonly OperatorSemantics[] {
    const leaf = context.leaves[leafIndex];
    if (leaf === undefined || leaf.channel !== "code") {
        return [];
    }
    const key = leaf.kind === "operator"
        ? leaf.raw
        : context.table.normalizedWord(leafIndex);
    return getDialect(context.dialect).listOperatorSemanticsForKey(key);
}

function candidateIsClearlyExpressionName(
    context: ParserContext,
    previous: number,
    following: number
): boolean {
    const previousLeaf = context.leaves[previous]!;
    const followingLeaf = context.leaves[following]!;
    if (
        previousLeaf.raw === "," ||
        isCodeWord(context, previous, "as") ||
        isCodeWord(context, previous, "case") ||
        isCodeWord(context, previous, "when") ||
        isCodeWord(context, previous, "then") ||
        isCodeWord(context, previous, "else") ||
        operatorSemanticsAt(context, previous).some(
            (semantics) => semantics.fixity === "prefix" || semantics.fixity === "infix"
        )
    ) {
        return true;
    }
    if (
        followingLeaf.raw === "," ||
        followingLeaf.raw === ")" ||
        followingLeaf.raw === "]" ||
        followingLeaf.raw === ";" ||
        isCodeWord(context, following, "as") ||
        isCodeWord(context, following, "when") ||
        isCodeWord(context, following, "then") ||
        isCodeWord(context, following, "else") ||
        isCodeWord(context, following, "end")
    ) {
        return true;
    }
    const followingOperators = operatorSemanticsAt(context, following);
    return followingOperators.length > 0 &&
        !followingOperators.some((semantics) => semantics.fixity === "prefix") &&
        followingOperators.some(
            (semantics) => semantics.fixity === "infix" || semantics.fixity === "postfix"
        );
}

function relationAliasColumnListSuffix(
    context: ParserContext,
    suffix: LeafRange,
    segmentEnd: number
): Readonly<{ readonly continuationStart: number | null }> | null {
    if (context.leaves[suffix.start]!.raw !== "(") {
        return null;
    }
    const close = context.table.matchingDelimiterIndex(suffix.start);
    if (close === null || close >= segmentEnd) {
        return null;
    }
    const continuation = trimToSyntax(context.leaves, {
        start: close + 1,
        end: segmentEnd,
    });
    const innerRange = {
        start: suffix.start + 1,
        end: close,
    };
    const depth = baseDepth(context, innerRange);
    const firstOrdinal = firstSyntaxOrdinalInRange(context, innerRange);
    const lastOrdinal = firstOrdinal === null
        ? -1
        : lastSyntaxOrdinalInRange(context, innerRange)!;
    let position = 0;
    let valid = true;
    for (let ordinal = firstOrdinal ?? 0; ordinal <= lastOrdinal; ordinal++) {
        const index = context.table.leafIndexOfSyntaxOrdinal(ordinal);
        if (context.table.depthBefore(index) !== depth) {
            continue;
        }
        if (
            position % 2 === 0
                ? !isAliasNameLeaf(context.leaves[index]!)
                : context.leaves[index]!.raw !== ","
        ) {
            valid = false;
            break;
        }
        position += 1;
    }
    return valid && position > 0 && position % 2 === 1
        ? Object.freeze({
              continuationStart: continuation === null ? null : continuation.start,
          })
        : null;
}

function relationAliasCandidateStarts(
    context: ParserContext,
    range: LeafRange,
    candidates: ReturnType<typeof findUnsupportedQueryClauseCandidates>,
    markers: readonly ClauseMarker[],
    nestingDepth: number
): Readonly<{
    readonly aliases: ReadonlySet<number>;
    readonly joinConditions: ReadonlySet<number>;
}> {
    const aliases = new Set<number>();
    const joinConditions = new Set<number>();
    for (let markerIndex = 0; markerIndex < markers.length; markerIndex++) {
        const marker = markers[markerIndex]!;
        if (marker.syntax.id !== "from") {
            continue;
        }
        const next = markerIndex + 1 < markers.length
            ? markers[markerIndex + 1]!
            : null;
        const segmentEnd = next === null
            ? range.end
            : next.start;
        const relationCandidates: RelationAliasCandidate[] = candidates.flatMap((candidate) => {
            if (
                candidate.range.start < marker.headEnd ||
                candidate.range.start >= segmentEnd
            ) {
                return [];
            }
            const suffix = trimToSyntax(context.leaves, {
                start: candidate.range.end,
                end: segmentEnd,
            });
            if (suffix === null) {
                return [];
            }
            const aliasList = relationAliasColumnListSuffix(
                context,
                suffix,
                segmentEnd
            );
            return [Object.freeze({
                start: candidate.range.start,
                hasAliasColumnList: aliasList !== null,
                continuationStart:
                    aliasList === null
                        ? suffix.start
                        : aliasList.continuationStart,
            })];
        });
        const slots = relationPrefixesCanAcceptAlias(
            context,
            { start: marker.headEnd, end: segmentEnd },
            relationCandidates,
            nestingDepth,
            parseQueryRange
        );
        relationCandidates.forEach((candidate, index) => {
            if (slots[index] === "alias") {
                aliases.add(candidate.start);
            } else if (slots[index] === "join-condition") {
                joinConditions.add(candidate.start);
            }
        });
    }
    return Object.freeze({ aliases, joinConditions });
}

function rejectProvenUnsupportedQueryClauses(
    context: ParserContext,
    range: LeafRange,
    markers: readonly ClauseMarker[],
    topLevelIndexes: readonly number[],
    nestingDepth: number
): void {
    const candidates = findUnsupportedQueryClauseCandidates(
        context,
        range,
        topLevelIndexes
    );
    const relationCandidateFacts = relationAliasCandidateStarts(
        context,
        range,
        candidates,
        markers,
        nestingDepth
    );
    let proofCount = 0;
    for (const candidate of candidates) {
        const order = candidate.signature.order;
        if (order === null) {
            continue;
        }
        for (let markerIndex = 0; markerIndex < markers.length; markerIndex++) {
            const marker = markers[markerIndex]!;
            const next = markerIndex + 1 < markers.length
                ? markers[markerIndex + 1]!
                : null;
            const segmentEnd = next === null ? range.end : next.start;
            if (
                candidate.range.start < marker.headEnd ||
                candidate.range.start >= segmentEnd ||
                marker.syntax.order >= order ||
                (next !== null && next.syntax.order <= order)
            ) {
                continue;
            }

            const prefixLast = previousSyntaxIndex(
                context,
                candidate.range.start,
                marker.headEnd
            );
            const suffix = trimToSyntax(context.leaves, {
                start: candidate.range.end,
                end: segmentEnd,
            });
            if (prefixLast === null || suffix === null) {
                continue;
            }
            if (
                marker.syntax.id === "from" &&
                (relationCandidateFacts.aliases.has(candidate.range.start) ||
                    relationCandidateFacts.joinConditions.has(candidate.range.start))
            ) {
                continue;
            }
            if (candidateIsClearlyExpressionName(context, prefixLast, suffix.start)) {
                continue;
            }
            if (proofCount >= MAX_UNSUPPORTED_CLAUSE_PROOFS) {
                throw new ParserSyntaxError(
                    "SYN_UNMODELED_CONSTRUCT",
                    { start: candidate.range.start, end: range.end },
                    "Unsupported query-clause recognition proof budget exceeded",
                    "statement"
                );
            }
            proofCount += 1;
            const prefixStructured = trialIsFullyStructured(
                context,
                () => buildSelectClause(
                    context,
                    marker,
                    prefixLast + 1,
                    nestingDepth
                ),
                marker.syntax.id === "from",
                nestingDepth
            );
            const suffixStructured = trialIsFullyStructured(context, () =>
                parseExpressionRange(
                    context,
                    suffix,
                    parseQueryRange,
                    nestingDepth
                )
            );
            if (!prefixStructured || !suffixStructured) {
                continue;
            }
            throw new ParserSyntaxError(
                "SYN_UNMODELED_CONSTRUCT",
                { start: candidate.range.start, end: range.end },
                `${context.dialect} ${candidate.signature.capabilityId.toUpperCase()} clause is recognized but not structured`,
                "statement",
                candidate.signature.capabilityId
            );
        }
    }
}

function parseSelectQuery(
    context: ParserContext,
    range: LeafRange,
    topLevelIndexes: readonly number[],
    nestingDepth: number
): QueryNode {
    const preservedConstruct =
        classifyUnsupportedSelectItemPrefix(context, range, topLevelIndexes) ??
        classifyUnsupportedGroupBySuffix(context, range, topLevelIndexes);
    if (preservedConstruct !== null) {
        throw new ParserSyntaxError(
            "SYN_UNMODELED_CONSTRUCT",
            { start: preservedConstruct.range.start, end: range.end },
            `${context.dialect} ${preservedConstruct.signature.capabilityId.toUpperCase()} construct is recognized but not structured`,
            "statement",
            preservedConstruct.signature.capabilityId
        );
    }
    const markers = findClauseMarkers(context, range, topLevelIndexes);
    rejectProvenUnsupportedQueryClauses(
        context,
        range,
        markers,
        topLevelIndexes,
        nestingDepth
    );
    const clauses: ClauseNode[] = [];
    for (let i = 0; i < markers.length; i++) {
        const marker = markers[i]!;
        const next = i + 1 < markers.length ? markers[i + 1]! : null;
        const clauseEnd = clauseEndBeforeNextMarker(context, marker, next, range.end);
        clauses.push(buildSelectClause(context, marker, clauseEnd, nestingDepth));
    }
    const hasFrom = clauses.some((clause) => clause.clauseKind === "from");
    return context.factory.createQuery(
        range,
        "select",
        [],
        clauses,
        nodeFacts(hasFrom ? "from" : "select-without-from", "capability")
    );
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
    const child = parseQueryRange(
        context,
        inner,
        descendParserDepth(inner, nestingDepth)
    );
    return context.factory.createQuery(
        range,
        "parenthesized",
        [],
        [child],
        nodeFacts(
            "subquery",
            "capability",
            syntaxMarkers(
                [range.start, close],
                "delimiter",
                "delimiter",
                false
            )
        )
    );
}

function parseQueryAtom(
    context: ParserContext,
    inputRange: LeafRange,
    nestingDepth: number,
    topLevelIndexes?: readonly number[]
): QueryNode {
    assertParserDepth(inputRange, nestingDepth);
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
        return parseSelectQuery(
            context,
            range,
            topLevelIndexes ?? topLevelSyntaxIndexes(context, range),
            nestingDepth
        );
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
    assertParserDepth(inputRange, nestingDepth);
    const range = trimToSyntax(context.leaves, inputRange);
    if (range === null) {
        throw new ParserSyntaxError(
            "SYN_UNEXPECTED_TOKEN",
            inputRange,
            "Query range is empty"
        );
    }
    const topLevelIndexes = topLevelSyntaxIndexes(context, range);
    const markers = findSetMarkers(context, range, topLevelIndexes);
    if (markers.length > 0) {
        return parseSetQuery(context, range, markers, nestingDepth);
    }
    return parseQueryAtom(context, range, nestingDepth, topLevelIndexes);
}

export function parseInsertQueryRange(
    context: ParserContext,
    inputRange: LeafRange,
    nestingDepth: number = 0
): QueryNode {
    assertParserDepth(inputRange, nestingDepth);
    const range = trimToSyntax(context.leaves, inputRange);
    if (range === null) {
        throw new ParserSyntaxError(
            "SYN_UNEXPECTED_TOKEN",
            inputRange,
            "INSERT range is empty"
        );
    }
    if (!isCodeWord(context, range.start, "insert")) {
        throw new ParserSyntaxError(
            "SYN_UNSUPPORTED_STATEMENT",
            range,
            "Only bounded INSERT query statements are structured"
        );
    }
    const operationKeyword = nextSyntaxIndex(context, range.start, range.end);
    const overwrite =
        operationKeyword !== null &&
        isCodeWord(context, operationKeyword, "overwrite");
    const into =
        operationKeyword !== null &&
        isCodeWord(context, operationKeyword, "into");
    if (!overwrite && !into) {
        throw new ParserSyntaxError(
            "SYN_UNSUPPORTED_STATEMENT",
            range,
            "Only INSERT OVERWRITE or INSERT INTO query statements are structured"
        );
    }
    const capabilityId = overwrite
        ? "insert-overwrite-partition-select"
        : "insert-into-partition-select";
    if (
        !isParserStructuredCapabilityState(
            getDialect(context.dialect).getCapability(capabilityId)?.state
        )
    ) {
        throw new ParserSyntaxError(
            "SYN_UNSUPPORTED_STATEMENT",
            range,
            `${context.dialect} does not declare ${overwrite ? "INSERT OVERWRITE" : "INSERT INTO"} query syntax`
        );
    }
    let headLast = operationKeyword!;
    const tableKeyword = nextSyntaxIndex(context, headLast, range.end);
    if (overwrite && (tableKeyword === null || !isCodeWord(context, tableKeyword, "table"))) {
        throw new ParserSyntaxError(
            "SYN_UNSUPPORTED_STATEMENT",
            range,
            "Only INSERT OVERWRITE TABLE query statements are structured"
        );
    }
    if (tableKeyword !== null && isCodeWord(context, tableKeyword, "table")) {
        headLast = tableKeyword;
    }
    const targetStart = nextSyntaxIndex(context, headLast, range.end);
    if (targetStart === null) {
        throw new ParserSyntaxError(
            "SYN_INCOMPLETE_CLAUSE",
            range,
            `${overwrite ? "INSERT OVERWRITE" : "INSERT INTO"} requires a target table`
        );
    }
    const depth = baseDepth(context, range);
    let partitionStart: number | null = null;
    let selectStart: number | null = null;
    const targetTail = { start: targetStart, end: range.end };
    const firstOrdinal = firstSyntaxOrdinalInRange(context, targetTail);
    const lastOrdinal = firstOrdinal === null
        ? -1
        : lastSyntaxOrdinalInRange(context, targetTail)!;
    for (let ordinal = firstOrdinal ?? 0; ordinal <= lastOrdinal; ordinal++) {
        const index = context.table.leafIndexOfSyntaxOrdinal(ordinal);
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
            `${overwrite ? "INSERT OVERWRITE" : "INSERT INTO"} requires a SELECT query`
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
            `${overwrite ? "INSERT OVERWRITE" : "INSERT INTO"} target table is empty`
        );
    }
    const target = parseRelationRange(context, targetRange, nestingDepth, parseQueryRange);
    if (
        target.relationKind !== "table" ||
        target.alias !== null ||
        target.bodyChildId !== null ||
        target.children.length !== 0
    ) {
        throw new ParserSyntaxError(
            "SYN_UNEXPECTED_TOKEN",
            targetRange,
            "INSERT target must be one complete table name"
        );
    }
    const insertClause = context.factory.createClause(
        { start: range.start, end: targetRange.end },
        "insert",
        { start: range.start, end: headLast + 1 },
        { start: headLast + 1, end: targetRange.end },
        [target],
        queryClauseFacts(
            context,
            "insert",
            { start: range.start, end: headLast + 1 },
            capabilityId
        )
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
        const list = parseList(
            context,
            partitionBody,
            "partition-columns",
            {
                allowAlias: false,
                reasonMessage: "PARTITION expression is not modeled",
            },
            (parserContext, valueRange) =>
                parseExpressionRange(
                    parserContext,
                    valueRange,
                    parseQueryRange,
                    descendParserDepth(valueRange, nestingDepth)
                )
        );
        children.push(
            context.factory.createClause(
                { start: partitionStart, end: close + 1 },
                "partition",
                { start: partitionStart, end: open + 1 },
                { start: open + 1, end: close },
                [list],
                queryClauseFacts(
                    context,
                    "partition",
                    { start: partitionStart, end: open + 1 },
                    capabilityId
                )
            )
        );
    }

    const selectRange = trimToSyntax(context.leaves, { start: selectStart, end: range.end });
    if (selectRange === null) {
        throw new ParserSyntaxError(
            "SYN_INCOMPLETE_CLAUSE",
            range,
            `${overwrite ? "INSERT OVERWRITE" : "INSERT INTO"} SELECT body is empty`
        );
    }
    const bodyQuery = parseQueryRange(context, selectRange, nestingDepth);
    const representsNestedInsert = (query: QueryNode): boolean => {
        const first = query.children[0];
        if (first?.kind === "clause" && first.clauseKind === "insert") {
            return true;
        }
        return (
            first?.kind === "clause" &&
            first.clauseKind === "with" &&
            query.children[1]?.kind === "query" &&
            representsNestedInsert(query.children[1])
        );
    };
    if (representsNestedInsert(bodyQuery)) {
        throw new ParserSyntaxError(
            "SYN_UNEXPECTED_TOKEN",
            selectRange,
            "INSERT source WITH clause must end in SELECT, not another INSERT"
        );
    }
    children.push(bodyQuery);
    return context.factory.createQuery(
        range,
        "select",
        [],
        children,
        nodeFacts(capabilityId, "capability")
    );
}
