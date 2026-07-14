import type { SourceLeaf } from "../lexer/token";
import { getDialect } from "../dialects/registry";
import type { LeafRange } from "./leaf-range";
import { parseOpaqueList } from "./list-parser";
import type { AliasInfo, QueryNode, RelationNode, SyntaxNode } from "./node";
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
    syntaxLeavesAreSeparated,
    syntaxIndexesInRange,
    topLevelSyntaxIndexes,
    trimToSyntax,
} from "./parser-context";
import type { ParserContext } from "./parser-context";

export type QueryRangeParser = (
    context: ParserContext,
    range: LeafRange,
    nestingDepth: number
) => QueryNode;

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

function rejectUnsupportedRelationConstructs(
    context: ParserContext,
    range: LeafRange,
    indexes: readonly number[]
): void {
    for (let i = 1; i < indexes.length; i++) {
        const index = indexes[i]!;
        const leaf = context.leaves[index]!;
        if (leaf.channel !== "code") {
            continue;
        }
        const raw = context.table.normalizedWord(index);
        if (raw !== "match_recognize" && raw !== "pivot" && raw !== "unpivot") {
            continue;
        }
        const next = i + 1 < indexes.length ? indexes[i + 1]! : null;
        const previous = indexes[i - 1]!;
        if (
            context.leaves[previous]!.raw !== "." &&
            next !== null &&
            context.leaves[next]!.raw === "("
        ) {
            throw new ParserSyntaxError(
                "SYN_UNMODELED_CONSTRUCT",
                range,
                `Hive relation construct ${raw.toUpperCase()} is not modeled in Wave 2B`
            );
        }
    }
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
    return context.factory.createRelation(range, "opaque", null, opaque, [opaque]);
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
                        nestingDepth + 1
                    );
                    return context.factory.createRelation(
                        range,
                        "subquery",
                        alias,
                        query,
                        [query]
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
            const opaque = createOpaqueWithDiagnostic(
                context,
                callRange,
                "SYN_UNMODELED_CONSTRUCT",
                "relation",
                "Table-function arguments remain opaque until Wave 2C"
            );
            return context.factory.createRelation(
                range,
                "table-function",
                alias,
                opaque,
                [opaque]
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
            []
        );
    }
    return createOpaqueRelation(
        context,
        range,
        "Relation syntax remains opaque because Wave 2B cannot prove a table boundary"
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
    const depth = baseDepth(context, range);
    let onIndex: number | null = null;
    for (const index of syntaxIndexesInRange(context, { start: afterJoin, end: range.end })) {
        if (context.table.depthBefore(index) !== depth) {
            continue;
        }
        const previous = previousSyntaxIndex(context, index, afterJoin);
        const keywordActsAsName =
            isDottedNamePart(context, index, afterJoin, range.end) ||
            (previous !== null && isCodeWord(context, previous, "as"));
        if (!keywordActsAsName && isCodeWord(context, index, "using")) {
            throw new ParserSyntaxError(
                "SYN_UNMODELED_CONSTRUCT",
                { start: index, end: range.end },
                "JOIN USING is not modeled in Wave 2B"
            );
        }
        if (!keywordActsAsName && isCodeWord(context, index, "on")) {
            onIndex = index;
            break;
        }
    }
    const rightRange = trimToSyntax(context.leaves, {
        start: afterJoin,
        end: onIndex === null ? range.end : onIndex,
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
        const condition = createOpaqueWithDiagnostic(
            context,
            onBody,
            "SYN_UNMODELED_CONSTRUCT",
            "expression",
            "JOIN ON condition remains opaque until Wave 2C"
        );
        const onClause = context.factory.createClause(
            { start: onIndex, end: range.end },
            "join-on",
            { start: onIndex, end: onIndex + 1 },
            { start: onIndex + 1, end: range.end },
            [condition]
        );
        children.push(onClause);
    }
    return context.factory.createRelation(range, "join", null, right, children);
}

function parseLateralView(
    context: ParserContext,
    marker: RelationMarker,
    range: LeafRange
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
            outputStart = nextSyntaxIndex(context, trailingIndexes[position]!, range.end);
        } else if (position < trailingIndexes.length) {
            throw new ParserSyntaxError(
                "SYN_UNEXPECTED_TOKEN",
                trailing,
                "LATERAL VIEW output columns must follow AS"
            );
        }
    }
    if (relationAlias === null || outputStart === null) {
        throw new ParserSyntaxError(
            "SYN_INCOMPLETE_CLAUSE",
            range,
            "LATERAL VIEW requires a relation alias and AS output columns"
        );
    }

    const functionOpaque = createOpaqueWithDiagnostic(
        context,
        callRange,
        "SYN_UNMODELED_CONSTRUCT",
        "relation",
        "LATERAL VIEW table-function body remains opaque until Wave 2C"
    );
    const tableFunction = context.factory.createRelation(
        { start: functionStart, end: functionRelationEnd },
        "table-function",
        relationAlias,
        functionOpaque,
        [functionOpaque]
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
        parseOpaqueList(context, outputRange, "other", {
            allowAlias: false,
            requireSingleName: true,
            reasonMessage: "LATERAL VIEW output name remains opaque until Wave 2C",
        })
    );
    const lateralRelation = context.factory.createRelation(
        { start: functionStart, end: range.end },
        "lateral-view",
        null,
        tableFunction,
        relationChildren
    );
    return context.factory.createClause(
        range,
        "lateral-view",
        { start: marker.start, end: headLast + 1 },
        { start: headLast + 1, end: range.end },
        [lateralRelation]
    );
}

export function parseFromClauseChildren(
    context: ParserContext,
    inputRange: LeafRange,
    nestingDepth: number,
    parseQueryRange: QueryRangeParser
): readonly SyntaxNode[] {
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
        } else if (
            marker.kind === "comma" ||
            children.length === 0 ||
            requiresRelationAfterComma
        ) {
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
                : parseLateralView(context, marker, constructRange)
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
    return Object.freeze(children);
}
