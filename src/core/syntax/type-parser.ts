import type { SourceLeaf } from "../lexer/token";
import type { LeafRange } from "./leaf-range";
import type {
    AliasInfo,
    ExpressionNode,
    ListItemNode,
    ListNode,
    TypeExpressionNode,
} from "./node";
import {
    ParserSyntaxError,
    isAliasNameLeaf,
    syntaxIndexesInRange,
    trimToSyntax,
} from "./parser-context";
import type { ParserContext } from "./parser-context";
import { assertParserDepth, descendParserDepth } from "./parser-depth";

type VirtualTypeToken = Readonly<{
    leafIndex: number;
    raw: string;
}>;

type ParsedType = Readonly<{
    node: TypeExpressionNode;
    next: number;
}>;

export type ParsedTypePrefix = Readonly<{
    node: TypeExpressionNode;
    endLeafIndex: number;
}>;

function isTypeNameLeaf(
    leaf: SourceLeaf,
    allowCompactStructParameter: boolean
): boolean {
    return (
        leaf.kind === "identifier" ||
        leaf.kind === "keyword" ||
        leaf.kind === "quoted-identifier" ||
        (allowCompactStructParameter && leaf.kind === "parameter")
    );
}

function virtualTokens(
    context: ParserContext,
    range: LeafRange
): readonly VirtualTypeToken[] {
    const tokens: VirtualTypeToken[] = [];
    for (const leafIndex of syntaxIndexesInRange(context, range)) {
        const leaf = context.leaves[leafIndex]!;
        if (
            leaf.channel === "code" &&
            leaf.kind === "operator" &&
            (leaf.raw === "<<" || leaf.raw === ">>")
        ) {
            // The lexer correctly keeps shift operators atomic. In an explicit
            // type context each code-unit is a local angle delimiter; both
            // virtual delimiters still reference the same canonical leaf.
            tokens.push(Object.freeze({ leafIndex, raw: leaf.raw[0]! }));
            tokens.push(Object.freeze({ leafIndex, raw: leaf.raw[1]! }));
            continue;
        }
        tokens.push(Object.freeze({ leafIndex, raw: leaf.raw }));
    }
    return Object.freeze(tokens);
}

function rangeFromTokens(
    tokens: readonly VirtualTypeToken[],
    start: number,
    end: number
): LeafRange {
    if (start >= end) {
        throw new Error("Cannot create an empty type token range");
    }
    return Object.freeze({
        start: tokens[start]!.leafIndex,
        end: tokens[end - 1]!.leafIndex + 1,
    });
}

function createScalarArgument(
    context: ParserContext,
    range: LeafRange
): ExpressionNode {
    const trimmed = trimToSyntax(context.leaves, range);
    if (trimmed === null || syntaxIndexesInRange(context, trimmed).length !== 1) {
        throw new ParserSyntaxError(
            "SYN_UNEXPECTED_TOKEN",
            range,
            "Type argument must be one atomic number or identifier"
        );
    }
    const leaf = context.leaves[trimmed.start]!;
    if (
        leaf.kind !== "number" &&
        leaf.kind !== "identifier" &&
        leaf.kind !== "keyword"
    ) {
        throw new ParserSyntaxError(
            "SYN_UNEXPECTED_TOKEN",
            trimmed,
            "Unsupported scalar type argument"
        );
    }
    return context.factory.createExpression(
        trimmed,
        leaf.kind === "number" ? "literal" : "identifier",
        [],
        []
    );
}

function createList(
    context: ParserContext,
    role: "type-args" | "type-members",
    range: LeafRange,
    separators: readonly number[],
    items: readonly ListItemNode[]
): ListNode {
    if (items.length === 0) {
        throw new ParserSyntaxError(
            "SYN_INCOMPLETE_CLAUSE",
            range,
            `${role} requires at least one item`
        );
    }
    return context.factory.createList(range, role, separators, items);
}

class TypeParser {
    private readonly context: ParserContext;
    private readonly tokens: readonly VirtualTypeToken[];
    private readonly nestingDepth: number;

    constructor(
        context: ParserContext,
        range: LeafRange,
        nestingDepth: number
    ) {
        assertParserDepth(range, nestingDepth);
        this.context = context;
        this.tokens = virtualTokens(context, range);
        this.nestingDepth = nestingDepth;
    }

    parse(): TypeExpressionNode {
        if (this.tokens.length === 0) {
            throw new ParserSyntaxError(
                "SYN_INCOMPLETE_CLAUSE",
                { start: 0, end: 0 },
                "Type expression is empty"
            );
        }
        const parsed = this.parseTypeAt(0, this.nestingDepth);
        if (parsed.next !== this.tokens.length) {
            throw new ParserSyntaxError(
                "SYN_UNEXPECTED_TOKEN",
                rangeFromTokens(this.tokens, parsed.next, this.tokens.length),
                "Type parser did not consume its complete bounded range"
            );
        }
        return parsed.node;
    }

    parsePrefix(): ParsedTypePrefix {
        if (this.tokens.length === 0) {
            throw new ParserSyntaxError(
                "SYN_INCOMPLETE_CLAUSE",
                { start: 0, end: 0 },
                "Type expression is empty"
            );
        }
        const parsed = this.parseTypeAt(0, this.nestingDepth);
        return Object.freeze({
            node: parsed.node,
            endLeafIndex: this.tokens[parsed.next - 1]!.leafIndex + 1,
        });
    }

    private parseTypeAt(
        start: number,
        nestingDepth: number,
        allowCompactStructParameter: boolean = false
    ): ParsedType {
        const anchor = this.tokens[start]?.leafIndex ?? this.tokens[this.tokens.length - 1]!.leafIndex;
        assertParserDepth({ start: anchor, end: anchor + 1 }, nestingDepth);
        const name = this.tokens[start];
        const nameLeaf = name === undefined
            ? undefined
            : this.context.leaves[name.leafIndex];
        if (
            name === undefined ||
            nameLeaf === undefined ||
            !isTypeNameLeaf(nameLeaf, allowCompactStructParameter)
        ) {
            const anchor = name?.leafIndex ?? this.tokens[this.tokens.length - 1]!.leafIndex;
            throw new ParserSyntaxError(
                "SYN_UNEXPECTED_TOKEN",
                { start: anchor, end: anchor + 1 },
                "Type name must be an identifier"
            );
        }

        const nameRange = Object.freeze({ start: name.leafIndex, end: name.leafIndex + 1 });
        const next = this.tokens[start + 1];
        if (next?.raw === "(") {
            return this.parseParenthesizedArguments(start, nameRange);
        }
        if (next?.raw === "<") {
            return this.parseAngleArguments(start, nameRange, nestingDepth);
        }
        return Object.freeze({
            node: this.context.factory.createTypeExpression(
                nameRange,
                nameRange,
                null,
                null
            ),
            next: start + 1,
        });
    }

    private parseParenthesizedArguments(
        start: number,
        nameRange: LeafRange
    ): ParsedType {
        const openPosition = start + 1;
        const openLeafIndex = this.tokens[openPosition]!.leafIndex;
        const closeLeafIndex = this.context.table.matchingDelimiterIndex(openLeafIndex);
        const closePosition = this.tokens.findIndex(
            (token, position) => position > openPosition && token.leafIndex === closeLeafIndex
        );
        if (closeLeafIndex === null || closePosition < 0) {
            throw new ParserSyntaxError(
                "SYN_UNMATCHED_DELIMITER",
                { start: openLeafIndex, end: this.tokens[this.tokens.length - 1]!.leafIndex + 1 },
                "Type argument list has an unmatched parenthesis"
            );
        }
        if (closePosition === openPosition + 1) {
            throw new ParserSyntaxError(
                "SYN_INCOMPLETE_CLAUSE",
                { start: openLeafIndex, end: closeLeafIndex + 1 },
                "Type argument list must not be empty"
            );
        }

        const items: ListItemNode[] = [];
        const separators: number[] = [];
        let itemStart = openPosition + 1;
        for (let position = itemStart; position < closePosition; position++) {
            if (this.tokens[position]!.raw !== ",") {
                continue;
            }
            const itemRange = rangeFromTokens(this.tokens, itemStart, position);
            const value = createScalarArgument(this.context, itemRange);
            items.push(
                this.context.factory.createListItem(
                    itemRange,
                    "type-arg",
                    null,
                    [],
                    value
                )
            );
            separators.push(this.tokens[position]!.leafIndex);
            itemStart = position + 1;
        }
        const lastRange = rangeFromTokens(this.tokens, itemStart, closePosition);
        const lastValue = createScalarArgument(this.context, lastRange);
        items.push(
            this.context.factory.createListItem(
                lastRange,
                "type-arg",
                null,
                [],
                lastValue
            )
        );
        const listRange = rangeFromTokens(this.tokens, openPosition + 1, closePosition);
        const list = createList(this.context, "type-args", listRange, separators, items);
        const range = rangeFromTokens(this.tokens, start, closePosition + 1);
        return Object.freeze({
            node: this.context.factory.createTypeExpression(range, nameRange, list, null),
            next: closePosition + 1,
        });
    }

    private parseAngleArguments(
        start: number,
        nameRange: LeafRange,
        nestingDepth: number
    ): ParsedType {
        const typeNameLeaf = this.context.leaves[nameRange.start]!;
        const typeName =
            typeNameLeaf.channel === "code"
                ? this.context.table.normalizedWord(nameRange.start)
                : "";
        const members = typeName === "struct";
        const items: ListItemNode[] = [];
        const separators: number[] = [];
        let position = start + 2;
        const bodyStart = position;

        while (position < this.tokens.length && this.tokens[position]!.raw !== ">") {
            const itemStart = position;
            let alias: AliasInfo | null = null;
            let allowCompactStructParameter = false;
            if (members) {
                const memberName = this.tokens[position];
                const memberLeaf = memberName === undefined
                    ? undefined
                    : this.context.leaves[memberName.leafIndex];
                const colon = this.tokens[position + 1];
                const colonLeaf = colon === undefined
                    ? undefined
                    : this.context.leaves[colon.leafIndex];
                const compactStructParameter =
                    this.context.dialect === "hive" &&
                    colonLeaf?.kind === "parameter" &&
                    colonLeaf.raw.startsWith(":");
                if (
                    memberName === undefined ||
                    memberLeaf === undefined ||
                    !isAliasNameLeaf(memberLeaf) ||
                    (colon?.raw !== ":" && !compactStructParameter)
                ) {
                    const anchor = memberName?.leafIndex ?? nameRange.start;
                    throw new ParserSyntaxError(
                        "SYN_UNEXPECTED_TOKEN",
                        { start: anchor, end: anchor + 1 },
                        "STRUCT member requires name : type"
                    );
                }
                alias = Object.freeze({
                    keywordLeafId: null,
                    nameLeafRange: Object.freeze({
                        start: memberName.leafIndex,
                        end: memberName.leafIndex + 1,
                    }),
                });
                if (colon?.raw === ":") {
                    position += 2;
                } else {
                    // Hive's canonical lexer intentionally keeps :name as one
                    // protected parameter leaf. In STRUCT member context the
                    // whole leaf is a safe atomic type spelling; do not scan or
                    // split its raw content.
                    // Move to the protected leaf and let parseTypeAt keep it as
                    // the atomic type-name spelling. A following <...> remains
                    // ordinary code leaves and can still be structured.
                    position += 1;
                    allowCompactStructParameter = true;
                }
            }

            const nestedAnchor = this.tokens[position]?.leafIndex ?? nameRange.start;
            const parsed = this.parseTypeAt(
                position,
                descendParserDepth(
                    {
                        start: nestedAnchor,
                        end: nestedAnchor + 1,
                    },
                    nestingDepth
                ),
                allowCompactStructParameter
            );
            position = parsed.next;
            const itemRange = rangeFromTokens(this.tokens, itemStart, position);
            items.push(
                this.context.factory.createListItem(
                    itemRange,
                    members ? "type-member" : "type-arg",
                    alias,
                    [],
                    parsed.node
                )
            );
            if (this.tokens[position]?.raw === ",") {
                separators.push(this.tokens[position]!.leafIndex);
                position += 1;
                if (this.tokens[position]?.raw === ">") {
                    throw new ParserSyntaxError(
                        "SYN_UNEXPECTED_TOKEN",
                        { start: this.tokens[position - 1]!.leafIndex, end: this.tokens[position - 1]!.leafIndex + 1 },
                        "Type argument list must not end after a comma"
                    );
                }
                continue;
            }
            if (this.tokens[position]?.raw !== ">") {
                const anchor = this.tokens[position]?.leafIndex ?? parsed.node.leafRange.end - 1;
                throw new ParserSyntaxError(
                    "SYN_UNEXPECTED_TOKEN",
                    { start: anchor, end: anchor + 1 },
                    "Type argument must be followed by comma or closing angle"
                );
            }
        }

        if (position >= this.tokens.length || this.tokens[position]!.raw !== ">") {
            throw new ParserSyntaxError(
                "SYN_UNMATCHED_DELIMITER",
                { start: nameRange.start, end: this.tokens[this.tokens.length - 1]!.leafIndex + 1 },
                "Type expression has an unmatched angle delimiter"
            );
        }
        if (items.length === 0) {
            throw new ParserSyntaxError(
                "SYN_INCOMPLETE_CLAUSE",
                { start: this.tokens[start + 1]!.leafIndex, end: this.tokens[position]!.leafIndex + 1 },
                "Type angle list must not be empty"
            );
        }
        const bodyEnd = Math.max(bodyStart + 1, position);
        const listRange = rangeFromTokens(this.tokens, bodyStart, bodyEnd);
        const list = createList(
            this.context,
            members ? "type-members" : "type-args",
            listRange,
            separators,
            items
        );
        const range = rangeFromTokens(this.tokens, start, position + 1);
        return Object.freeze({
            node: this.context.factory.createTypeExpression(
                range,
                nameRange,
                members ? null : list,
                members ? list : null
            ),
            next: position + 1,
        });
    }
}

export function parseTypeExpression(
    context: ParserContext,
    inputRange: LeafRange,
    nestingDepth: number = 0
): TypeExpressionNode {
    const range = trimToSyntax(context.leaves, inputRange);
    if (range === null) {
        throw new ParserSyntaxError(
            "SYN_INCOMPLETE_CLAUSE",
            inputRange,
            "Type expression is empty"
        );
    }
    return new TypeParser(context, range, nestingDepth).parse();
}

export function parseTypeExpressionPrefix(
    context: ParserContext,
    inputRange: LeafRange,
    nestingDepth: number = 0
): ParsedTypePrefix {
    const range = trimToSyntax(context.leaves, inputRange);
    if (range === null) {
        throw new ParserSyntaxError(
            "SYN_INCOMPLETE_CLAUSE",
            inputRange,
            "Type expression is empty"
        );
    }
    return new TypeParser(context, range, nestingDepth).parsePrefix();
}
