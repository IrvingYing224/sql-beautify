import type { SourceLeaf } from "../lexer/token";
import { getDialect } from "../dialects/registry";
import { isParserStructuredCapabilityState } from "../dialects/capability-state";
import type { LeafRange } from "./leaf-range";
import { parseList } from "./list-parser";
import { parseExpressionRange } from "./expression-parser";
import type { AliasInfo, QueryNode, RelationNode, SyntaxNode } from "./node";
import {
    ParserSyntaxError,
    isAliasNameLeaf,
    isCodeWord,
    isDottedNamePart,
    isQueryLeadingRange,
    matchesSyntaxWords,
    mergeSyntaxMarkers,
    nextSyntaxIndex,
    nodeFacts,
    previousSyntaxIndex,
    syntaxLeavesAreSeparated,
    syntaxIndexesInRange,
    syntaxMarkers,
    topLevelSyntaxIndexes,
    trimToSyntax,
} from "./parser-context";
import type { ParserContext } from "./parser-context";
import {
    createOpaqueWithDiagnostic,
    createParserCheckpoint,
    rollbackParserCheckpoint,
} from "./recovery";
import { rejectUnsupportedRelationConstructs } from "./unsupported-recognizer";

export type QueryRangeParser = (
    context: ParserContext,
    range: LeafRange,
    nestingDepth: number
) => QueryNode;

export interface RelationAliasCandidate {
    readonly start: number;
    readonly hasAliasColumnList: boolean;
    readonly continuationStart: number | null;
}

export type RelationPrefixCandidateFact = "alias" | "join-condition" | null;

export interface ParsedFromClauseChildren {
    readonly children: readonly SyntaxNode[];
    readonly separatorLeafIds: readonly number[];
}

type MarkerKind = "comma" | "join" | "lateral";
type RelationMarker = {
    readonly kind: MarkerKind;
    readonly start: number;
    readonly token: number;
};

const IMPLICIT_RELATION_ALIAS_BLOCKERS = Object.freeze([
    "anti",
    "as",
    "cross",
    "full",
    "inner",
    "join",
    "lateral",
    "left",
    "on",
    "outer",
    "partition",
    "right",
    "semi",
    "using",
    "view",
]);

function relationFacts(
    alias: AliasInfo | null,
    capabilityId: string | null,
    nameLeafRange: LeafRange | null,
    markers: ReturnType<typeof syntaxMarkers> = []
) {
    const aliasMarkers = alias?.keywordLeafId === null || alias === null
        ? []
        : syntaxMarkers([alias.keywordLeafId], "alias-as");
    return {
        ...nodeFacts(
            capabilityId,
            capabilityId === null
                ? nameLeafRange === null ? "intrinsic-container" : "intrinsic-primitive"
                : "capability",
            mergeSyntaxMarkers(markers, aliasMarkers)
        ),
        nameLeafRange,
    };
}

function canBeImplicitRelationAlias(
    context: ParserContext,
    leafIndex: number
): boolean {
    const leaf = context.leaves[leafIndex]!;
    return (
        isAliasNameLeaf(leaf) &&
        (leaf.channel !== "code" ||
            !IMPLICIT_RELATION_ALIAS_BLOCKERS.includes(
                context.table.normalizedWord(leafIndex)
            ))
    );
}

function isRelationNamePart(leaf: SourceLeaf): boolean {
    return (
        leaf.kind === "identifier" ||
        leaf.kind === "keyword" ||
        leaf.kind === "quoted-identifier" ||
        leaf.kind === "parameter"
    );
}

function isQualifiedNameIndexes(
    context: ParserContext,
    indexes: readonly number[]
): boolean {
    if (indexes.length === 0 || indexes.length % 2 === 0) {
        return false;
    }
    for (let i = 0; i < indexes.length; i++) {
        const leaf = context.leaves[indexes[i]!]!;
        if ((i % 2 === 0 && !isRelationNamePart(leaf)) || (i % 2 === 1 && leaf.raw !== ".")) {
            return false;
        }
    }
    return true;
}

function aliasFromTrailingIndexes(
    context: ParserContext,
    indexes: readonly number[],
    minimumValueIndexes: number
): { readonly alias: AliasInfo | null; readonly valueEnd: number | null } {
    if (indexes.length <= minimumValueIndexes) {
        return Object.freeze({ alias: null, valueEnd: null });
    }
    const last = indexes[indexes.length - 1]!;
    const lastLeaf = context.leaves[last]!;
    if (!isAliasNameLeaf(lastLeaf)) {
        return Object.freeze({ alias: null, valueEnd: null });
    }
    const previous = indexes[indexes.length - 2]!;
    if (isCodeWord(context, previous, "as")) {
        if (indexes.length - 2 < minimumValueIndexes) {
            return Object.freeze({ alias: null, valueEnd: null });
        }
        return Object.freeze({
            alias: Object.freeze({
                keywordLeafId: previous,
                nameLeafRange: Object.freeze({ start: last, end: last + 1 }),
            }),
            valueEnd: previous,
        });
    }
    const previousLeaf = context.leaves[previous]!;
    const previousWord =
        previousLeaf.channel === "code"
            ? context.table.normalizedWord(previous)
            : null;
    if (
        previousLeaf.kind === "operator" ||
        previousLeaf.raw === "." ||
        previousLeaf.raw === "," ||
        (previousWord !== null &&
            IMPLICIT_RELATION_ALIAS_BLOCKERS.includes(previousWord)) ||
        !canBeImplicitRelationAlias(context, last) ||
        !syntaxLeavesAreSeparated(context, previous, last)
    ) {
        return Object.freeze({ alias: null, valueEnd: null });
    }
    return Object.freeze({
        alias: Object.freeze({
            keywordLeafId: null,
            nameLeafRange: Object.freeze({ start: last, end: last + 1 }),
        }),
        valueEnd: last,
    });
}

function parseKnownTrailingAlias(
    context: ParserContext,
    range: LeafRange,
    coreEnd: number
): AliasInfo | null {
    const trailing = trimToSyntax(context.leaves, { start: coreEnd, end: range.end });
    if (trailing === null) {
        return null;
    }
    const indexes = topLevelSyntaxIndexes(context, trailing);
    if (
        indexes.length === 1 &&
        canBeImplicitRelationAlias(context, indexes[0]!)
    ) {
        const name = indexes[0]!;
        return Object.freeze({
            keywordLeafId: null,
            nameLeafRange: Object.freeze({ start: name, end: name + 1 }),
        });
    }
    if (
        indexes.length === 2 &&
        isCodeWord(context, indexes[0]!, "as") &&
        isAliasNameLeaf(context.leaves[indexes[1]!]!)
    ) {
        const name = indexes[1]!;
        return Object.freeze({
            keywordLeafId: indexes[0]!,
            nameLeafRange: Object.freeze({ start: name, end: name + 1 }),
        });
    }
    throw new ParserSyntaxError(
        "SYN_UNEXPECTED_TOKEN",
        trailing,
        "Relation has unsupported trailing syntax"
    );
}

function createOpaqueRelation(
    context: ParserContext,
    range: LeafRange,
    message: string
): RelationNode {
    const opaque = createOpaqueWithDiagnostic(
        context,
        range,
        "SYN_UNMODELED_CONSTRUCT",
        "relation",
        message
    );
    return context.factory.createRelation(
        range,
        "opaque",
        null,
        opaque,
        [opaque],
        relationFacts(null, null, null)
    );
}

function trailingAliasColumnListCore(
    context: ParserContext,
    range: LeafRange,
    indexes: readonly number[]
): LeafRange | null {
    if (indexes.length < 3) {
        return null;
    }
    const open = indexes[indexes.length - 1]!;
    if (context.leaves[open]!.raw !== "(") {
        return null;
    }
    const close = context.table.matchingDelimiterIndex(open);
    if (
        close === null ||
        close >= range.end ||
        trimToSyntax(context.leaves, { start: close + 1, end: range.end }) !== null
    ) {
        return null;
    }
    const aliasIndex = indexes[indexes.length - 2]!;
    if (!isAliasNameLeaf(context.leaves[aliasIndex]!)) {
        return null;
    }
    const columnIndexes = topLevelSyntaxIndexes(context, {
        start: open + 1,
        end: close,
    });
    if (
        columnIndexes.length === 0 ||
        columnIndexes.length % 2 === 0 ||
        !columnIndexes.every((index, position) =>
            position % 2 === 0
                ? isAliasNameLeaf(context.leaves[index]!)
                : context.leaves[index]!.raw === ","
        )
    ) {
        return null;
    }

    const beforeAlias = indexes[indexes.length - 3]!;
    let coreEnd = aliasIndex;
    if (isCodeWord(context, beforeAlias, "as")) {
        coreEnd = beforeAlias;
    } else {
        const coreLast = previousSyntaxIndex(context, aliasIndex, range.start);
        if (
            coreLast === null ||
            !canBeImplicitRelationAlias(context, aliasIndex) ||
            !syntaxLeavesAreSeparated(context, coreLast, aliasIndex)
        ) {
            return null;
        }
    }
    return trimToSyntax(context.leaves, { start: range.start, end: coreEnd });
}

function containsOpaqueSyntax(node: SyntaxNode): boolean {
    const stack: SyntaxNode[] = [node];
    while (stack.length > 0) {
        const current = stack.pop()!;
        if (current.kind === "opaque") {
            return true;
        }
        for (let index = current.children.length - 1; index >= 0; index--) {
            stack.push(current.children[index]!);
        }
    }
    return false;
}

function relationAliasColumnListIsBounded(
    context: ParserContext,
    range: LeafRange,
    indexes: readonly number[],
    nestingDepth: number,
    parseQueryRange: QueryRangeParser
): boolean {
    const coreRange = trailingAliasColumnListCore(context, range, indexes);
    if (coreRange === null) {
        return false;
    }
    const checkpoint = createParserCheckpoint(context);
    try {
        const core = parseSingleRelation(
            context,
            coreRange,
            nestingDepth,
            parseQueryRange
        );
        const bounded =
            core.alias === null &&
            !containsOpaqueSyntax(core) &&
            (core.relationKind === "table" ||
                core.relationKind === "subquery" ||
                core.relationKind === "table-function");
        rollbackParserCheckpoint(context, checkpoint);
        return bounded;
    } catch (error) {
        rollbackParserCheckpoint(context, checkpoint);
        if (error instanceof ParserSyntaxError) {
            return false;
        }
        throw error;
    }
}

export function relationRangeIsBoundedAliasColumnList(
    context: ParserContext,
    inputRange: LeafRange,
    nestingDepth: number,
    parseQueryRange: QueryRangeParser
): boolean {
    const range = trimToSyntax(context.leaves, inputRange);
    if (range === null) {
        return false;
    }
    return relationAliasColumnListIsBounded(
        context,
        range,
        topLevelSyntaxIndexes(context, range),
        nestingDepth,
        parseQueryRange
    );
}

function containsUnprovenRelationOpaque(
    context: ParserContext,
    node: SyntaxNode,
    nestingDepth: number,
    parseQueryRange: QueryRangeParser
): boolean {
    const stack: SyntaxNode[] = [node];
    while (stack.length > 0) {
        const current = stack.pop()!;
        if (
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

function parseSingleRelation(
    context: ParserContext,
    inputRange: LeafRange,
    nestingDepth: number,
    parseQueryRange: QueryRangeParser
): RelationNode {
    const range = trimToSyntax(context.leaves, inputRange);
    if (range === null) {
        throw new ParserSyntaxError(
            "SYN_INCOMPLETE_CLAUSE",
            inputRange,
            "FROM/JOIN relation is empty"
        );
    }
    const indexes = topLevelSyntaxIndexes(context, range);
    if (indexes.length === 0) {
        throw new ParserSyntaxError(
            "SYN_INCOMPLETE_CLAUSE",
            range,
            "Relation contains no syntax"
        );
    }
    if (
        relationAliasColumnListIsBounded(
            context,
            range,
            indexes,
            nestingDepth,
            parseQueryRange
        )
    ) {
        return createOpaqueRelation(
            context,
            range,
            "Relation alias column list is recognized but not structured"
        );
    }
    rejectUnsupportedRelationConstructs(context, range, indexes);

    const first = indexes[0]!;
    if (context.leaves[first]!.raw === "(") {
        const close = context.table.matchingDelimiterIndex(first);
        if (close !== null && close < range.end) {
            const inner = trimToSyntax(context.leaves, { start: first + 1, end: close });
            if (inner !== null) {
                const firstInner = context.leaves[inner.start]!;
                if (
                    isCodeWord(context, inner.start, "select") ||
                    isCodeWord(context, inner.start, "with") ||
                    (firstInner.channel === "code" && firstInner.raw === "(")
                ) {
                    const alias = parseKnownTrailingAlias(context, range, close + 1);
                    const query = parseQueryRange(
                        context,
                        { start: first, end: close + 1 },
                        nestingDepth
                    );
                    return context.factory.createRelation(
                        range,
                        "subquery",
                        alias,
                        query,
                        [query],
                        relationFacts(alias, "subquery", null)
                    );
                }
            }
        }
    }

    const callOpenPosition = indexes.findIndex(
        (index) => context.leaves[index]!.raw === "("
    );
    if (
        callOpenPosition > 0 &&
        isQualifiedNameIndexes(context, indexes.slice(0, callOpenPosition))
    ) {
        const open = indexes[callOpenPosition]!;
        const close = context.table.matchingDelimiterIndex(open);
        if (close !== null && close < range.end) {
            const alias = parseKnownTrailingAlias(context, range, close + 1);
            const callRange = Object.freeze({ start: first, end: close + 1 });
            const call = parseExpressionRange(
                context,
                callRange,
                parseQueryRange,
                nestingDepth
            );
            return context.factory.createRelation(
                range,
                "table-function",
                alias,
                call,
                [call],
                relationFacts(alias, "table-function", null)
            );
        }
    }

    const aliasFacts = aliasFromTrailingIndexes(context, indexes, 1);
    const coreRange = trimToSyntax(context.leaves, {
        start: range.start,
        end: aliasFacts.valueEnd ?? range.end,
    });
    if (
        coreRange !== null &&
        isQualifiedNameIndexes(context, topLevelSyntaxIndexes(context, coreRange))
    ) {
        return context.factory.createRelation(
            range,
            "table",
            aliasFacts.alias,
            null,
            [],
            relationFacts(aliasFacts.alias, null, coreRange)
        );
    }
    return createOpaqueRelation(
        context,
        range,
        "Relation syntax remains opaque because a table boundary cannot be proven"
    );
}

export function parseRelationRange(
    context: ParserContext,
    range: LeafRange,
    nestingDepth: number,
    parseQueryRange: QueryRangeParser
): RelationNode {
    return parseSingleRelation(context, range, nestingDepth, parseQueryRange);
}

function joinMarkerStart(
    context: ParserContext,
    indexes: readonly number[],
    joinPosition: number
): number {
    const syntaxes = getDialect(context.dialect).listJoinSyntax();
    let bestStartPosition = joinPosition;
    let bestLength = 1;
    for (const syntax of syntaxes) {
        const startPosition = joinPosition - syntax.words.length + 1;
        if (startPosition < 0 || syntax.words.length <= bestLength) {
            continue;
        }
        let matches = true;
        for (let i = 0; i < syntax.words.length; i++) {
            if (!isCodeWord(context, indexes[startPosition + i]!, syntax.words[i]!)) {
                matches = false;
                break;
            }
        }
        if (matches) {
            bestStartPosition = startPosition;
            bestLength = syntax.words.length;
        }
    }
    if (bestLength > 1) {
        return indexes[bestStartPosition]!;
    }

    const modifierWords = new Set(
        syntaxes.flatMap((syntax) => syntax.words.slice(0, -1))
    );
    const previous = joinPosition > 0 ? indexes[joinPosition - 1]! : null;
    if (
        previous !== null &&
        context.leaves[previous]!.channel === "code" &&
        modifierWords.has(context.table.normalizedWord(previous)) &&
        syntaxLeavesAreSeparated(context, previous, indexes[joinPosition]!)
    ) {
        return previous;
    }
    return indexes[joinPosition]!;
}

function assertValidJoinHead(context: ParserContext, marker: RelationMarker): void {
    const indexes = syntaxIndexesInRange(context, {
        start: marker.start,
        end: marker.token + 1,
    });
    const head = indexes
        .map((index) =>
            context.leaves[index]!.channel === "code"
                ? context.table.normalizedWord(index)
                : ""
        )
        .join(" ");
    if (
        !getDialect(context.dialect)
            .listJoinSyntax()
            .some((syntax) => syntax.words.join(" ") === head)
    ) {
        throw new ParserSyntaxError(
            "SYN_UNEXPECTED_TOKEN",
            { start: marker.start, end: marker.token + 1 },
            `Unsupported JOIN head ${head}`
        );
    }
}

function joinActsAsNonQueryFunction(
    context: ParserContext,
    joinIndex: number,
    range: LeafRange
): boolean {
    const open = nextSyntaxIndex(context, joinIndex, range.end);
    if (open === null || context.leaves[open]!.raw !== "(") {
        return false;
    }
    const close = context.table.matchingDelimiterIndex(open);
    if (close === null || close >= range.end) {
        return false;
    }
    const inner = trimToSyntax(context.leaves, { start: open + 1, end: close });
    if (inner === null) {
        return true;
    }
    return !isQueryLeadingRange(context, inner);
}

const ON_EXPRESSION_PREDECESSORS = Object.freeze([
    "and",
    "else",
    "not",
    "on",
    "or",
    "then",
    "when",
]);

const ON_EXPRESSION_FOLLOWERS = Object.freeze([
    "between",
    "in",
    "is",
    "like",
    "regexp",
    "rlike",
]);

function markerActsAsOnExpressionName(
    context: ParserContext,
    markerStart: number,
    markerToken: number,
    range: LeafRange
): boolean {
    const previous = previousSyntaxIndex(context, markerStart, range.start);
    if (previous !== null) {
        const previousLeaf = context.leaves[previous]!;
        if (
            previousLeaf.kind === "operator" ||
            (previousLeaf.channel === "code" &&
                ON_EXPRESSION_PREDECESSORS.includes(
                    context.table.normalizedWord(previous)
                ))
        ) {
            return true;
        }
    }
    const next = nextSyntaxIndex(context, markerToken, range.end);
    if (next === null) {
        return false;
    }
    const nextLeaf = context.leaves[next]!;
    return (
        nextLeaf.kind === "operator" ||
        (nextLeaf.channel === "code" &&
            ON_EXPRESSION_FOLLOWERS.includes(context.table.normalizedWord(next)))
    );
}

function findMarkers(context: ParserContext, range: LeafRange): readonly RelationMarker[] {
    const indexes = topLevelSyntaxIndexes(context, range);
    const supportsLateralView = isParserStructuredCapabilityState(
        getDialect(context.dialect).getCapability("lateral-view")?.state
    );
    const markers: RelationMarker[] = [];
    const starts = new Set<number>();
    let joinMayOwnOn = false;
    let insideOnExpression = false;
    for (let i = 0; i < indexes.length; i++) {
        const index = indexes[i]!;
        const leaf = context.leaves[index]!;
        if (leaf.channel !== "code") {
            continue;
        }
        const raw = context.table.normalizedWord(index);
        const previous = i > 0 ? indexes[i - 1]! : null;
        const keywordActsAsName =
            isDottedNamePart(context, index, range.start, range.end) ||
            (previous !== null && isCodeWord(context, previous, "as"));
        if (raw === "on" && joinMayOwnOn && !keywordActsAsName) {
            joinMayOwnOn = false;
            insideOnExpression = true;
            continue;
        }
        let marker: RelationMarker | null = null;
        if (raw === ",") {
            marker = Object.freeze({ kind: "comma", start: index, token: index });
        } else if (
            raw === "join" &&
            !keywordActsAsName &&
            !joinActsAsNonQueryFunction(context, index, range)
        ) {
            const start = joinMarkerStart(context, indexes, i);
            if (
                insideOnExpression &&
                markerActsAsOnExpressionName(context, start, index, range)
            ) {
                continue;
            }
            marker = Object.freeze({
                kind: "join",
                start,
                token: index,
            });
        } else if (
            raw === "lateral" &&
            supportsLateralView &&
            !keywordActsAsName &&
            i + 1 < indexes.length &&
            isCodeWord(context, indexes[i + 1]!, "view")
        ) {
            if (
                insideOnExpression &&
                markerActsAsOnExpressionName(context, index, index, range)
            ) {
                continue;
            }
            marker = Object.freeze({ kind: "lateral", start: index, token: index });
        }
        if (marker !== null && !starts.has(marker.start)) {
            starts.add(marker.start);
            markers.push(marker);
            joinMayOwnOn = marker.kind === "join";
            insideOnExpression = false;
        }
    }
    return Object.freeze(markers.sort((left, right) => left.start - right.start));
}

function relationMarkerIsStructured(
    context: ParserContext,
    range: LeafRange,
    markers: readonly RelationMarker[],
    markerPosition: number,
    nestingDepth: number,
    parseQueryRange: QueryRangeParser
): boolean {
    const first = markers[markerPosition];
    if (
        first === undefined ||
        (first.kind !== "join" && first.kind !== "lateral")
    ) {
        return false;
    }
    let nextPosition = markerPosition + 1;
    if (first.kind === "lateral") {
        while (
            nextPosition < markers.length &&
            markers[nextPosition]!.kind === "comma"
        ) {
            nextPosition += 1;
        }
    }
    const constructEnd = nextPosition < markers.length
        ? markers[nextPosition]!.start
        : range.end;
    const constructRange = trimToSyntax(context.leaves, {
        start: first.start,
        end: constructEnd,
    });
    if (constructRange === null) {
        return false;
    }
    const checkpoint = createParserCheckpoint(context);
    try {
        const node = first.kind === "join"
            ? parseJoin(
                  context,
                  first,
                  constructRange,
                  nestingDepth,
                  parseQueryRange
              )
            : parseLateralView(
                  context,
                  first,
                  constructRange,
                  nestingDepth,
                  parseQueryRange
              );
        const structured = !containsUnprovenRelationOpaque(
            context,
            node,
            nestingDepth,
            parseQueryRange
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

export function relationPrefixesCanAcceptAlias(
    context: ParserContext,
    inputRange: LeafRange,
    candidates: readonly RelationAliasCandidate[],
    nestingDepth: number,
    parseQueryRange: QueryRangeParser
): readonly RelationPrefixCandidateFact[] {
    const results: RelationPrefixCandidateFact[] = candidates.map(() => null);
    const range = trimToSyntax(context.leaves, inputRange);
    if (range === null || candidates.length === 0) {
        return Object.freeze(results);
    }
    const ordered = candidates
        .map((candidate, resultIndex) => Object.freeze({
            start: candidate.start,
            hasAliasColumnList: candidate.hasAliasColumnList,
            continuationStart: candidate.continuationStart,
            resultIndex,
        }))
        .sort((left, right) => left.start - right.start);
    const markers = findMarkers(context, range);
    const markerPositions = new Map<number, number>();
    markers.forEach((marker, index) => markerPositions.set(marker.start, index));
    const structuredContinuationCache = new Map<number, boolean>();
    let markerPosition = 0;
    let activeMarker: RelationMarker | null = null;
    let intervalOrdinal = 0;
    let lastParsedInterval = -1;

    for (const candidate of ordered) {
        if (
            !Number.isInteger(candidate.start) ||
            candidate.start <= range.start ||
            candidate.start >= range.end
        ) {
            continue;
        }
        while (
            markerPosition < markers.length &&
            markers[markerPosition]!.start < candidate.start
        ) {
            const marker = markers[markerPosition]!;
            markerPosition += 1;
            if (activeMarker?.kind === "lateral" && marker.kind === "comma") {
                continue;
            }
            activeMarker = marker;
            intervalOrdinal += 1;
        }
        if (activeMarker?.kind === "lateral") {
            continue;
        }
        let canBeAlias =
            candidate.hasAliasColumnList && candidate.continuationStart === null;
        let requiresJoinOwner = false;
        if (candidate.continuationStart !== null) {
            const continuationLeaf = context.leaves[candidate.continuationStart];
            if (continuationLeaf?.raw === ",") {
                canBeAlias = true;
            } else if (
                isCodeWord(context, candidate.continuationStart, "on") ||
                isCodeWord(context, candidate.continuationStart, "using")
            ) {
                canBeAlias = true;
                requiresJoinOwner = true;
            } else {
                const continuationMarkerPosition = markerPositions.get(
                    candidate.continuationStart
                );
                if (continuationMarkerPosition !== undefined) {
                    let structured = structuredContinuationCache.get(
                        candidate.continuationStart
                    );
                    if (structured === undefined) {
                        structured = relationMarkerIsStructured(
                            context,
                            range,
                            markers,
                            continuationMarkerPosition,
                            nestingDepth,
                            parseQueryRange
                        );
                        structuredContinuationCache.set(
                            candidate.continuationStart,
                            structured
                        );
                    }
                    canBeAlias = structured;
                }
            }
        }
        let prefixStart = range.start;
        if (activeMarker?.kind === "comma") {
            prefixStart = activeMarker.token + 1;
        } else if (activeMarker?.kind === "join") {
            const afterJoin = nextSyntaxIndex(
                context,
                activeMarker.token,
                candidate.start
            );
            if (afterJoin === null) {
                continue;
            }
            prefixStart = afterJoin;
        }
        const prefix = trimToSyntax(context.leaves, {
            start: prefixStart,
            end: candidate.start,
        });
        if (prefix === null) {
            continue;
        }
        if (activeMarker?.kind === "join") {
            const condition = findJoinConditionMarker(
                context,
                prefixStart,
                candidate.start
            );
            if (
                condition?.kind === "on" &&
                previousSyntaxIndex(context, candidate.start, prefixStart) ===
                    condition.index
            ) {
                results[candidate.resultIndex] = "join-condition";
                continue;
            }
        }
        if (
            !canBeAlias ||
            (requiresJoinOwner && activeMarker?.kind !== "join") ||
            intervalOrdinal === lastParsedInterval
        ) {
            continue;
        }
        lastParsedInterval = intervalOrdinal;
        const checkpoint = createParserCheckpoint(context);
        try {
            const relation = parseSingleRelation(
                context,
                prefix,
                nestingDepth,
                parseQueryRange
            );
            results[candidate.resultIndex] =
                relation.alias === null &&
                (relation.relationKind === "table" ||
                    relation.relationKind === "subquery" ||
                    relation.relationKind === "table-function")
                    ? "alias"
                    : null;
            rollbackParserCheckpoint(context, checkpoint);
        } catch (error) {
            rollbackParserCheckpoint(context, checkpoint);
            if (!(error instanceof ParserSyntaxError)) {
                throw error;
            }
        }
    }
    return Object.freeze(results);
}

type JoinConditionMarker = {
    readonly kind: "on" | "using";
    readonly index: number;
};

function findJoinConditionMarker(
    context: ParserContext,
    afterJoin: number,
    rangeEnd: number
): JoinConditionMarker | null {
    const depth = context.table.depthBefore(afterJoin);
    for (const index of syntaxIndexesInRange(context, {
        start: afterJoin,
        end: rangeEnd,
    })) {
        if (context.table.depthBefore(index) !== depth) {
            continue;
        }
        const previous = previousSyntaxIndex(context, index, afterJoin);
        const keywordActsAsName =
            isDottedNamePart(context, index, afterJoin, rangeEnd) ||
            (previous !== null && isCodeWord(context, previous, "as"));
        if (keywordActsAsName) {
            continue;
        }
        if (isCodeWord(context, index, "using")) {
            return Object.freeze({ kind: "using", index });
        }
        if (isCodeWord(context, index, "on")) {
            return Object.freeze({ kind: "on", index });
        }
    }
    return null;
}

function parseJoin(
    context: ParserContext,
    marker: RelationMarker,
    range: LeafRange,
    nestingDepth: number,
    parseQueryRange: QueryRangeParser
): RelationNode {
    assertValidJoinHead(context, marker);
    const afterJoin = nextSyntaxIndex(context, marker.token, range.end);
    if (afterJoin === null) {
        throw new ParserSyntaxError(
            "SYN_INCOMPLETE_CLAUSE",
            range,
            "JOIN requires a right relation"
        );
    }
    const conditionMarker = findJoinConditionMarker(context, afterJoin, range.end);
    const onIndex = conditionMarker?.kind === "on" ? conditionMarker.index : null;
    const usingIndex = conditionMarker?.kind === "using" ? conditionMarker.index : null;
    const rightRange = trimToSyntax(context.leaves, {
        start: afterJoin,
        end: onIndex ?? usingIndex ?? range.end,
    });
    if (rightRange === null) {
        throw new ParserSyntaxError(
            "SYN_INCOMPLETE_CLAUSE",
            range,
            "JOIN requires a right relation"
        );
    }
    const right = parseSingleRelation(context, rightRange, nestingDepth, parseQueryRange);
    const children: SyntaxNode[] = [right];
    if (onIndex !== null) {
        const onBody = trimToSyntax(context.leaves, { start: onIndex + 1, end: range.end });
        if (onBody === null) {
            throw new ParserSyntaxError(
                "SYN_INCOMPLETE_CLAUSE",
                { start: onIndex, end: range.end },
                "JOIN ON requires a condition"
            );
        }
        const condition = parseExpressionRange(
            context,
            onBody,
            parseQueryRange,
            nestingDepth
        );
        const onClause = context.factory.createClause(
            { start: onIndex, end: range.end },
            "join-on",
            { start: onIndex, end: onIndex + 1 },
            { start: onIndex + 1, end: range.end },
            [condition],
            {
                ...nodeFacts(
                    "join",
                    "capability",
                    syntaxMarkers([onIndex], "clause:join-on")
                ),
                separatorLeafIds: [],
            }
        );
        children.push(onClause);
    } else if (usingIndex !== null) {
        const open = nextSyntaxIndex(context, usingIndex, range.end);
        if (open === null || context.leaves[open]!.raw !== "(") {
            throw new ParserSyntaxError(
                "SYN_INCOMPLETE_CLAUSE",
                { start: usingIndex, end: range.end },
                "JOIN USING requires a parenthesized column list"
            );
        }
        const close = context.table.matchingDelimiterIndex(open);
        if (
            close === null ||
            close >= range.end ||
            trimToSyntax(context.leaves, { start: close + 1, end: range.end }) !== null
        ) {
            throw new ParserSyntaxError(
                "SYN_UNMATCHED_DELIMITER",
                { start: open, end: range.end },
                "JOIN USING column list has an invalid closing boundary"
            );
        }
        const columnRange = trimToSyntax(context.leaves, {
            start: open + 1,
            end: close,
        });
        if (columnRange === null) {
            throw new ParserSyntaxError(
                "SYN_INCOMPLETE_CLAUSE",
                { start: usingIndex, end: close + 1 },
                "JOIN USING column list is empty"
            );
        }
        const columns = parseList(
            context,
            columnRange,
            "other",
            {
                allowAlias: false,
                requireSingleName: true,
                reasonMessage: "JOIN USING column is not a single name",
            },
            (parserContext, valueRange) =>
                parseExpressionRange(
                    parserContext,
                    valueRange,
                    parseQueryRange,
                    nestingDepth
                )
        );
        const usingClause = context.factory.createClause(
            { start: usingIndex, end: range.end },
            "join-using",
            { start: usingIndex, end: usingIndex + 1 },
            { start: usingIndex + 1, end: range.end },
            [columns],
            {
                ...nodeFacts(
                    "join",
                    "capability",
                    syntaxMarkers([usingIndex], "clause:join-using")
                ),
                separatorLeafIds: [],
            }
        );
        children.push(usingClause);
    }
    return context.factory.createRelation(
        range,
        "join",
        null,
        right,
        children,
        relationFacts(
            null,
            "join",
            null,
            syntaxMarkers(
                syntaxIndexesInRange(context, {
                    start: marker.start,
                    end: marker.token + 1,
                }),
                "join-head"
            )
        )
    );
}

function parseLateralView(
    context: ParserContext,
    marker: RelationMarker,
    range: LeafRange,
    nestingDepth: number,
    parseQueryRange: QueryRangeParser
): SyntaxNode {
    const viewMatch = matchesSyntaxWords(context, marker.token, range.end, ["lateral", "view"]);
    if (viewMatch === null) {
        throw new ParserSyntaxError(
            "SYN_INCOMPLETE_CLAUSE",
            range,
            "LATERAL must be followed by VIEW"
        );
    }
    let headLast = viewMatch[viewMatch.length - 1]!;
    let functionStart = nextSyntaxIndex(context, headLast, range.end);
    if (
        functionStart !== null &&
        isCodeWord(context, functionStart, "outer") &&
        !isDottedNamePart(context, functionStart, marker.token, range.end)
    ) {
        headLast = functionStart;
        functionStart = nextSyntaxIndex(context, functionStart, range.end);
    }
    if (functionStart === null) {
        throw new ParserSyntaxError(
            "SYN_INCOMPLETE_CLAUSE",
            range,
            "LATERAL VIEW requires a table function"
        );
    }
    if (!isRelationNamePart(context.leaves[functionStart]!)) {
        throw new ParserSyntaxError(
            "SYN_UNEXPECTED_TOKEN",
            { start: functionStart, end: functionStart + 1 },
            "LATERAL VIEW table function name must be an identifier"
        );
    }
    const open = nextSyntaxIndex(context, functionStart, range.end);
    if (open === null || context.leaves[open]!.raw !== "(") {
        throw new ParserSyntaxError(
            "SYN_INCOMPLETE_CLAUSE",
            range,
            "LATERAL VIEW table function requires parentheses"
        );
    }
    const close = context.table.matchingDelimiterIndex(open);
    if (close === null || close >= range.end) {
        throw new ParserSyntaxError(
            "SYN_UNMATCHED_DELIMITER",
            range,
            "LATERAL VIEW table function has an unmatched delimiter"
        );
    }
    const callRange = Object.freeze({ start: functionStart, end: close + 1 });
    const trailing = trimToSyntax(context.leaves, { start: close + 1, end: range.end });
    let relationAlias: AliasInfo | null = null;
    let outputStart: number | null = null;
    let outputAsLeafId: number | null = null;
    let functionRelationEnd = close + 1;
    if (trailing !== null) {
        const trailingIndexes = topLevelSyntaxIndexes(context, trailing);
        let position = 0;
        if (
            position < trailingIndexes.length &&
            !isCodeWord(context, trailingIndexes[position]!, "as")
        ) {
            const aliasIndex = trailingIndexes[position]!;
            if (!isAliasNameLeaf(context.leaves[aliasIndex]!)) {
                throw new ParserSyntaxError(
                    "SYN_UNEXPECTED_TOKEN",
                    trailing,
                    "LATERAL VIEW relation alias is invalid"
                );
            }
            relationAlias = Object.freeze({
                keywordLeafId: null,
                nameLeafRange: Object.freeze({ start: aliasIndex, end: aliasIndex + 1 }),
            });
            functionRelationEnd = aliasIndex + 1;
            position += 1;
        }
        if (
            position < trailingIndexes.length &&
            isCodeWord(context, trailingIndexes[position]!, "as")
        ) {
            outputAsLeafId = trailingIndexes[position]!;
            outputStart = nextSyntaxIndex(context, outputAsLeafId, range.end);
        } else if (position < trailingIndexes.length) {
            throw new ParserSyntaxError(
                "SYN_UNEXPECTED_TOKEN",
                trailing,
                "LATERAL VIEW output columns must follow AS"
            );
        }
    }
    if (
        relationAlias === null ||
        outputAsLeafId === null ||
        outputStart === null
    ) {
        throw new ParserSyntaxError(
            "SYN_INCOMPLETE_CLAUSE",
            range,
            "LATERAL VIEW requires a relation alias and AS output columns"
        );
    }

    const functionExpression = parseExpressionRange(
        context,
        callRange,
        parseQueryRange,
        nestingDepth
    );
    const tableFunction = context.factory.createRelation(
        { start: functionStart, end: functionRelationEnd },
        "table-function",
        relationAlias,
        functionExpression,
        [functionExpression],
        relationFacts(relationAlias, "table-function", null)
    );
    const relationChildren: SyntaxNode[] = [tableFunction];
    const outputRange = trimToSyntax(context.leaves, { start: outputStart, end: range.end });
    if (outputRange === null) {
        throw new ParserSyntaxError(
            "SYN_INCOMPLETE_CLAUSE",
            range,
            "LATERAL VIEW AS requires output columns"
        );
    }
    relationChildren.push(
        parseList(
            context,
            outputRange,
            "other",
            {
                allowAlias: false,
                requireSingleName: true,
                reasonMessage: "LATERAL VIEW output name is not modeled",
            },
            (parserContext, valueRange) =>
                parseExpressionRange(
                    parserContext,
                    valueRange,
                    parseQueryRange,
                    nestingDepth
                )
        )
    );
    const lateralRelation = context.factory.createRelation(
        { start: functionStart, end: range.end },
        "lateral-view",
        null,
        tableFunction,
        relationChildren,
        relationFacts(
            null,
            "lateral-view",
            null,
            syntaxMarkers([outputAsLeafId], "lateral-view-output-as")
        )
    );
    return context.factory.createClause(
        range,
        "lateral-view",
        { start: marker.start, end: headLast + 1 },
        { start: headLast + 1, end: range.end },
        [lateralRelation],
        {
            ...nodeFacts(
                "lateral-view",
                "capability",
                syntaxMarkers(
                    syntaxIndexesInRange(context, {
                        start: marker.start,
                        end: headLast + 1,
                    }),
                    "clause:lateral-view"
                )
            ),
            separatorLeafIds: [],
        }
    );
}

export function parseFromClauseChildren(
    context: ParserContext,
    inputRange: LeafRange,
    nestingDepth: number,
    parseQueryRange: QueryRangeParser
): ParsedFromClauseChildren {
    const range = trimToSyntax(context.leaves, inputRange);
    if (range === null) {
        throw new ParserSyntaxError(
            "SYN_INCOMPLETE_CLAUSE",
            inputRange,
            "FROM requires at least one relation"
        );
    }
    const markers = findMarkers(context, range);
    const children: SyntaxNode[] = [];
    let cursor = range.start;
    let markerPosition = 0;
    let requiresRelationAfterComma = false;

    while (markerPosition < markers.length) {
        const marker = markers[markerPosition]!;
        if (marker.start < cursor) {
            markerPosition += 1;
            continue;
        }
        const before = trimToSyntax(context.leaves, { start: cursor, end: marker.start });
        if (before !== null) {
            children.push(parseSingleRelation(context, before, nestingDepth, parseQueryRange));
            requiresRelationAfterComma = false;
        } else if (children.length === 0 || requiresRelationAfterComma) {
            throw new ParserSyntaxError(
                "SYN_INCOMPLETE_CLAUSE",
                range,
                `${marker.kind.toUpperCase()} requires a complete left relation`
            );
        }

        if (marker.kind === "comma") {
            cursor = marker.start + 1;
            markerPosition += 1;
            requiresRelationAfterComma = true;
            continue;
        }

        let end = range.end;
        let nextPosition = markerPosition + 1;
        while (nextPosition < markers.length) {
            const next = markers[nextPosition]!;
            if (marker.kind === "lateral" && next.kind === "comma") {
                nextPosition += 1;
                continue;
            }
            end = next.start;
            break;
        }
        const constructRange = trimToSyntax(context.leaves, { start: marker.start, end });
        if (constructRange === null) {
            throw new ParserSyntaxError(
                "SYN_INCOMPLETE_CLAUSE",
                range,
                `${marker.kind.toUpperCase()} construct is empty`
            );
        }
        children.push(
            marker.kind === "join"
                ? parseJoin(context, marker, constructRange, nestingDepth, parseQueryRange)
                : parseLateralView(
                      context,
                      marker,
                      constructRange,
                      nestingDepth,
                      parseQueryRange
                  )
        );
        cursor = end;
        markerPosition = nextPosition;
        requiresRelationAfterComma = false;
    }

    const tail = trimToSyntax(context.leaves, { start: cursor, end: range.end });
    if (tail !== null) {
        children.push(parseSingleRelation(context, tail, nestingDepth, parseQueryRange));
        requiresRelationAfterComma = false;
    } else if (requiresRelationAfterComma) {
        throw new ParserSyntaxError(
            "SYN_INCOMPLETE_CLAUSE",
            range,
            "FROM relation list must not end after a comma"
        );
    }
    if (children.length === 0) {
        throw new ParserSyntaxError(
            "SYN_INCOMPLETE_CLAUSE",
            range,
            "FROM requires at least one relation"
        );
    }
    return Object.freeze({
        children: Object.freeze(children),
        separatorLeafIds: Object.freeze(
            markers
                .filter(
                    (marker) =>
                        marker.kind === "comma" &&
                        !children.some(
                            (child) =>
                                marker.token >= child.leafRange.start &&
                                marker.token < child.leafRange.end
                        )
                )
                .map((marker) => marker.token)
        ),
    });
}
