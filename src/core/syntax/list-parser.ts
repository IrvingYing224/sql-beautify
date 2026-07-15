import type { LeafRange } from "./leaf-range";
import { listItemRoleFor } from "./list-role-contract";
import type { AliasInfo, ListNode, ListRole, SyntaxNode } from "./node";
import {
    ParserSyntaxError,
    isAliasNameLeaf,
    isCodeWord,
    isDottedNamePart,
    previousSyntaxIndex,
    splitTopLevelByComma,
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
    readonly modifierWords?: readonly string[];
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

function parseItemFacts(
    context: ParserContext,
    range: LeafRange,
    options: OpaqueListOptions
): {
    readonly valueRange: LeafRange;
    readonly alias: AliasInfo | null;
    readonly modifierLeafIds: readonly number[];
} {
    const modifierWords = new Set(
        (options.modifierWords ?? []).map((word) => word.toLowerCase())
    );
    let valueEnd = range.end;
    const modifiers: number[] = [];
    let indexes = topLevelSyntaxIndexes(context, range);

    while (indexes.length > 0) {
        const last = indexes[indexes.length - 1]!;
        const leaf = context.leaves[last]!;
        if (
            leaf.channel !== "code" ||
            !modifierWords.has(context.table.normalizedWord(last)) ||
            isDottedNamePart(context, last, range.start, range.end)
        ) {
            break;
        }
        if (modifiers.length > 0) {
            throw new ParserSyntaxError(
                "SYN_UNEXPECTED_TOKEN",
                { start: last, end: modifiers[0]! + 1 },
                "List item must not contain conflicting trailing modifiers"
            );
        }
        modifiers.unshift(last);
        valueEnd = last;
        const beforeModifier = trimToSyntax(context.leaves, { start: range.start, end: valueEnd });
        if (beforeModifier === null) {
            throw new ParserSyntaxError(
                "SYN_INCOMPLETE_CLAUSE",
                range,
                "List item modifier has no value"
            );
        }
        indexes = topLevelSyntaxIndexes(context, beforeModifier);
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
            if (
                aliasIndex === null ||
                !isAliasNameLeaf(context.leaves[aliasIndex]!)
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
                value
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
                opaque
            );
        }
    });
    return context.factory.createList(trimmed, listRole, split.separators, items);
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
