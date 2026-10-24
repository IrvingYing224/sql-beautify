import { isTemplateFragment } from "../lexer/token";
import type { LeafRange } from "./leaf-range";
import { listItemRoleFor } from "./list-role-contract";
import type { AliasInfo, ListNode, ListRole, SyntaxNode } from "./node";
import {
    ParserSyntaxError,
    intervalUnit,
    isAliasNameLeaf,
    isCodeWord,
    isDottedNamePart,
    mergeSyntaxMarkers,
    nodeFacts,
    previousSyntaxIndex,
    splitTopLevelByComma,
    syntaxMarkers,
    syntaxLeavesAreSeparated,
    topLevelSyntaxIndexes,
    trimToSyntax,
} from "./parser-context";
import type { ParserContext } from "./parser-context";
import {
    createOpaqueWithDiagnostic,
    createParserCheckpoint,
    recoverOpaqueFromError,
    rollbackParserCheckpoint,
} from "./recovery";

export interface OpaqueListOptions {
    readonly allowAlias: boolean;
    /** Items may end in `[ASC|DESC] [NULLS FIRST|LAST]` (Hive columnRefOrder). */
    readonly ordering?: boolean;
    readonly requireSingleName?: boolean;
    readonly reasonMessage: string;
}

export type ListValueParser = (
    context: ParserContext,
    range: LeafRange
) => SyntaxNode;

const IMPLICIT_ALIAS_NAME_BLOCKERS = Object.freeze([
    "all",
    "and",
    "asc",
    "as",
    "between",
    "case",
    "desc",
    "distinct",
    "else",
    "end",
    "false",
    "in",
    "is",
    "like",
    "not",
    "null",
    "or",
    "regexp",
    "rlike",
    "then",
    "true",
    "when",
]);

const IMPLICIT_ALIAS_PREDECESSOR_BLOCKERS = Object.freeze([
    "and",
    "as",
    "between",
    "else",
    "in",
    "is",
    "like",
    "not",
    "or",
    "over",
    "regexp",
    "rlike",
    "then",
    "when",
]);

function listItemFacts(alias: AliasInfo | null, modifierLeafIds: readonly number[]) {
    const aliasKeywordLeafId = alias?.keywordLeafId ?? null;
    if (aliasKeywordLeafId === null && modifierLeafIds.length === 0) {
        return undefined;
    }
    const aliasMarkers = aliasKeywordLeafId === null
        ? []
        : syntaxMarkers([aliasKeywordLeafId], "alias-as");
    const modifierMarkers = modifierLeafIds.length === 0
        ? []
        : syntaxMarkers(modifierLeafIds, "operator");
    return nodeFacts(
        null,
        "intrinsic-container",
        aliasMarkers.length === 0
            ? modifierMarkers
            : modifierMarkers.length === 0
              ? aliasMarkers
              : mergeSyntaxMarkers(aliasMarkers, modifierMarkers)
    );
}

function canBeImplicitAlias(context: ParserContext, leafIndex: number): boolean {
    const leaf = context.leaves[leafIndex]!;
    if (!isAliasNameLeaf(leaf)) {
        return false;
    }
    return (
        leaf.channel !== "code" ||
        !IMPLICIT_ALIAS_NAME_BLOCKERS.includes(context.table.normalizedWord(leafIndex))
    );
}

/** `day` in `INTERVAL '1' day` or `INTERVAL (n) day` is the interval unit, not an alias. */
function isIntervalUnit(context: ParserContext, leafIndex: number, rangeStart: number): boolean {
    if (
        context.leaves[leafIndex]!.channel !== "code" ||
        intervalUnit(context.table.normalizedWord(leafIndex)) === null
    ) {
        return false;
    }
    const value = previousSyntaxIndex(context, leafIndex, rangeStart);
    const valueStart = value !== null && context.leaves[value]!.raw === ")"
        ? context.table.matchingDelimiterIndex(value)
        : value;
    const keyword = valueStart === null
        ? null
        : previousSyntaxIndex(context, valueStart, rangeStart);
    return keyword !== null && isCodeWord(context, keyword, "interval");
}

/** Number of trailing `[ASC|DESC] [NULLS FIRST|LAST]` words among `indexes`. */
function orderingModifierCount(
    context: ParserContext,
    range: LeafRange,
    indexes: readonly number[]
): number {
    const isWord = (position: number, words: readonly string[]): boolean => {
        const leafId = indexes[position];
        return (
            leafId !== undefined &&
            context.leaves[leafId]!.channel === "code" &&
            words.includes(context.table.normalizedWord(leafId)) &&
            !isDottedNamePart(context, leafId, range.start, range.end)
        );
    };
    let end = indexes.length;
    if (isWord(end - 1, ["first", "last"]) && isWord(end - 2, ["nulls"])) {
        end -= 2;
    }
    if (isWord(end - 1, ["asc", "desc"])) {
        end -= 1;
        if (isWord(end - 1, ["asc", "desc"])) {
            throw new ParserSyntaxError(
                "SYN_UNEXPECTED_TOKEN",
                { start: indexes[end - 1]!, end: indexes[end]! + 1 },
                "List item must not contain conflicting trailing modifiers"
            );
        }
    }
    if (end === 0 && indexes.length > 0) {
        throw new ParserSyntaxError(
            "SYN_INCOMPLETE_CLAUSE",
            range,
            "List item modifier has no value"
        );
    }
    return indexes.length - end;
}

function parseItemFacts(
    context: ParserContext,
    range: LeafRange,
    options: OpaqueListOptions
): {
    readonly valueRange: LeafRange;
    readonly alias: AliasInfo | null;
    readonly modifierLeafIds: readonly number[];
} {
    let valueEnd = range.end;
    let indexes = topLevelSyntaxIndexes(context, range);
    const modifiers = options.ordering === true
        ? indexes.slice(indexes.length - orderingModifierCount(context, range, indexes))
        : [];
    if (modifiers.length > 0) {
        valueEnd = modifiers[0]!;
        indexes = indexes.slice(0, indexes.length - modifiers.length);
    }

    let alias: AliasInfo | null = null;
    if (options.allowAlias && indexes.length >= 1) {
        for (let i = indexes.length - 1; i >= 0; i--) {
            const asIndex = indexes[i]!;
            if (!isCodeWord(context, asIndex, "as")) {
                continue;
            }
            const afterAs = indexes.slice(i + 1);
            const aliasIndex = afterAs.length === 1 ? afterAs[0]! : null;
            // A template after AS stands for an alias name: `a AS ${alias}`.
            if (
                aliasIndex === null ||
                !(
                    isAliasNameLeaf(context.leaves[aliasIndex]!) ||
                    isTemplateFragment(context.leaves[aliasIndex]!)
                )
            ) {
                throw new ParserSyntaxError(
                    "SYN_INCOMPLETE_CLAUSE",
                    { start: asIndex, end: range.end },
                    "AS requires exactly one alias name"
                );
            }
            alias = Object.freeze({
                keywordLeafId: asIndex,
                nameLeafRange: Object.freeze({
                    start: aliasIndex,
                    end: aliasIndex + 1,
                }),
            });
            valueEnd = asIndex;
            break;
        }
    }

    if (options.allowAlias && alias === null) {
        const candidateIndexes = topLevelSyntaxIndexes(context, {
            start: range.start,
            end: valueEnd,
        });
        if (candidateIndexes.length >= 2) {
            const aliasIndex = candidateIndexes[candidateIndexes.length - 1]!;
            const previousIndex = previousSyntaxIndex(context, aliasIndex, range.start);
            if (previousIndex === null) {
                throw new ParserSyntaxError(
                    "SYN_INCOMPLETE_CLAUSE",
                    range,
                    "Implicit alias has no value"
                );
            }
            const previousLeaf = context.leaves[previousIndex]!;
            const previousWord =
                previousLeaf.channel === "code"
                    ? context.table.normalizedWord(previousIndex)
                    : null;
            const blockedPrevious =
                previousLeaf.kind === "operator" ||
                previousLeaf.raw === "." ||
                previousLeaf.raw === "," ||
                previousLeaf.raw === "(" ||
                (previousWord !== null &&
                    IMPLICIT_ALIAS_PREDECESSOR_BLOCKERS.includes(previousWord));
            if (
                canBeImplicitAlias(context, aliasIndex) &&
                !blockedPrevious &&
                !isIntervalUnit(context, aliasIndex, range.start) &&
                syntaxLeavesAreSeparated(context, previousIndex, aliasIndex)
            ) {
                alias = Object.freeze({
                    keywordLeafId: null,
                    nameLeafRange: Object.freeze({ start: aliasIndex, end: aliasIndex + 1 }),
                });
                valueEnd = aliasIndex;
            }
        }
    }

    const valueRange = trimToSyntax(context.leaves, { start: range.start, end: valueEnd });
    if (valueRange === null) {
        throw new ParserSyntaxError(
            "SYN_INCOMPLETE_CLAUSE",
            range,
            "List item has no value"
        );
    }
    return Object.freeze({ valueRange, alias, modifierLeafIds: Object.freeze(modifiers) });
}

export function parseList(
    context: ParserContext,
    range: LeafRange,
    listRole: ListRole,
    options: OpaqueListOptions,
    parseValue: ListValueParser
): ListNode {
    const trimmed = trimToSyntax(context.leaves, range);
    if (trimmed === null) {
        throw new ParserSyntaxError(
            "SYN_INCOMPLETE_CLAUSE",
            range,
            `${listRole} requires at least one item`
        );
    }
    const split = splitTopLevelByComma(context, trimmed);
    const items = split.ranges.map((itemRange) => {
        const itemCheckpoint = createParserCheckpoint(context);
        try {
            let facts = parseItemFacts(context, itemRange, options);
            if (options.requireSingleName === true) {
                const nameIndexes = topLevelSyntaxIndexes(context, facts.valueRange);
                if (
                    nameIndexes.length !== 1 ||
                    !isAliasNameLeaf(context.leaves[nameIndexes[0]!]!)
                ) {
                    throw new ParserSyntaxError(
                        "SYN_UNEXPECTED_TOKEN",
                        facts.valueRange,
                        `${listRole} item must be a single identifier`
                    );
                }
            }
            const hasImplicitAlias =
                facts.alias !== null && facts.alias.keywordLeafId === null;
            const aliasCheckpoint = hasImplicitAlias
                ? createParserCheckpoint(context)
                : null;
            let value = parseValue(context, facts.valueRange);
            if (aliasCheckpoint !== null && value.kind === "opaque") {
                rollbackParserCheckpoint(context, aliasCheckpoint);
                facts = parseItemFacts(
                    context,
                    itemRange,
                    Object.freeze({ ...options, allowAlias: false })
                );
                value = parseValue(context, facts.valueRange);
            }
            return context.factory.createListItem(
                itemRange,
                listItemRoleFor(listRole),
                facts.alias,
                facts.modifierLeafIds,
                value,
                listItemFacts(facts.alias, facts.modifierLeafIds)
            );
        } catch (error) {
            const opaque = recoverOpaqueFromError(
                context,
                itemCheckpoint,
                itemRange,
                error,
                "list-item",
                `${listRole} item preserved: `
            );
            return context.factory.createListItem(
                itemRange,
                listItemRoleFor(listRole),
                null,
                [],
                opaque,
                nodeFacts(null, "intrinsic-container")
            );
        }
    });
    return context.factory.createList(
        trimmed,
        listRole,
        split.separators,
        items,
        nodeFacts(null, "intrinsic-container")
    );
}

export function parseOpaqueList(
    context: ParserContext,
    range: LeafRange,
    listRole: ListRole,
    options: OpaqueListOptions
): ListNode {
    return parseList(context, range, listRole, options, (parserContext, valueRange) =>
        createOpaqueWithDiagnostic(
            parserContext,
            valueRange,
            "SYN_UNMODELED_CONSTRUCT",
            "expression",
            options.reasonMessage
        )
    );
}
