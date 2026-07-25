import { getDialect } from "../dialects/registry";
import { isParserStructuredCapabilityState } from "../dialects/capability-state";
import type { OperatorSemantics } from "../dialects/types";
import type { LeafRange } from "./leaf-range";
import { parseList } from "./list-parser";
import type {
    ExpressionKind,
    ExpressionNode,
    FormatRole,
    OperatorOccurrenceInput,
    OpaqueNode,
    QueryNode,
    SyntaxMarker,
    SyntaxNode,
    TypeExpressionNode,
    WindowSpecNode,
} from "./node";
import { primitiveExpressionCapabilityId } from "./primitive-capability";
import {
    ParserSyntaxError,
    baseDepth,
    isAliasNameLeaf,
    isQueryLeadingRange,
    mergeSyntaxMarkers,
    nodeFacts,
    syntaxMarkers,
    syntaxIndexesInRange,
    trimToSyntax,
} from "./parser-context";
import type { ParserContext } from "./parser-context";
import { assertParserDepth, descendParserDepth } from "./parser-depth";
import {
    createParserCheckpoint,
    recoverOpaqueFromError,
} from "./recovery";
import {
    parseTypeExpression,
    parseTypeExpressionPrefix,
} from "./type-parser";
import { parseWindowSpecRange } from "./window-parser";

export type ExpressionValueNode = ExpressionNode | OpaqueNode;

export type ExpressionQueryParser = (
    context: ParserContext,
    range: LeafRange,
    nestingDepth: number
) => QueryNode;

const COLLECTION_NAMES = Object.freeze(["array", "map", "struct", "named_struct"]);

type OperatorMatch = Readonly<{
    semantics: OperatorSemantics;
    positions: readonly number[];
}>;

function expressionRange(
    indexes: readonly number[],
    start: number,
    end: number
): LeafRange {
    if (start >= end) {
        throw new Error("Cannot create an empty expression range");
    }
    return Object.freeze({
        start: indexes[start]!,
        end: indexes[end - 1]! + 1,
    });
}

function isAtomicNameKind(kind: string): boolean {
    return kind === "identifier" || kind === "keyword" || kind === "quoted-identifier";
}

function isCollectionName(dialect: ParserContext["dialect"], word: string): boolean {
    if (dialect === "hive") {
        return COLLECTION_NAMES.includes(word);
    }
    return (dialect === "generic" || dialect === "postgresql") && word === "array";
}

function supportsCollectionSyntax(dialect: ParserContext["dialect"]): boolean {
    const capabilityId =
        dialect === "hive"
            ? "collection-expression"
            : dialect === "postgresql"
              ? "postgres-array-subset"
              : dialect === "generic"
                ? "generic-array-subset"
                : null;
    const state = capabilityId === null
        ? null
        : getDialect(dialect).getCapability(capabilityId)?.state;
    return isParserStructuredCapabilityState(state);
}

class PrattParser {
    private readonly context: ParserContext;
    private readonly queryParser: ExpressionQueryParser;
    private readonly nestingDepth: number;
    private readonly indexes: readonly number[];
    private position = 0;

    constructor(
        context: ParserContext,
        range: LeafRange,
        queryParser: ExpressionQueryParser,
        nestingDepth: number
    ) {
        assertParserDepth(range, nestingDepth);
        this.context = context;
        this.queryParser = queryParser;
        this.nestingDepth = nestingDepth;
        this.indexes = syntaxIndexesInRange(context, range);
    }

    parseBounded(): ExpressionNode {
        if (this.indexes.length === 0) {
            throw new ParserSyntaxError(
                "SYN_INCOMPLETE_CLAUSE",
                { start: 0, end: 0 },
                "Expression range is empty"
            );
        }
        const expression = this.parseExpression(0);
        if (this.position !== this.indexes.length) {
            throw new ParserSyntaxError(
                "SYN_UNEXPECTED_TOKEN",
                expressionRange(this.indexes, this.position, this.indexes.length),
                "Expression parser did not consume its complete bounded range"
            );
        }
        return expression;
    }

    private leafIndex(position: number = this.position): number | null {
        return position >= 0 && position < this.indexes.length
            ? this.indexes[position]!
            : null;
    }

    private raw(position: number = this.position): string | null {
        const index = this.leafIndex(position);
        return index === null ? null : this.context.leaves[index]!.raw;
    }

    private word(position: number = this.position): string | null {
        const index = this.leafIndex(position);
        if (index === null || this.context.leaves[index]!.channel !== "code") {
            return null;
        }
        return this.context.table.normalizedWord(index);
    }

    private wordIs(position: number, expected: string): boolean {
        return this.word(position) === expected;
    }

    private matchingPosition(openPosition: number): number {
        const open = this.indexes[openPosition]!;
        const close = this.context.table.matchingDelimiterIndex(open);
        if (close === null) {
            throw new ParserSyntaxError(
                "SYN_UNMATCHED_DELIMITER",
                { start: open, end: this.indexes[this.indexes.length - 1]! + 1 },
                "Expression delimiter is unmatched"
            );
        }
        const closePosition = this.indexes.indexOf(close, openPosition + 1);
        if (closePosition < 0) {
            throw new ParserSyntaxError(
                "SYN_UNMATCHED_DELIMITER",
                { start: open, end: this.indexes[this.indexes.length - 1]! + 1 },
                "Expression delimiter closes outside the bounded range"
            );
        }
        return closePosition;
    }

    private create(
        range: LeafRange,
        kind: ExpressionKind,
        operators: readonly number[],
        children: readonly SyntaxNode[],
        operatorOccurrences: readonly OperatorOccurrenceInput[] = [],
        markers: readonly SyntaxMarker[] = []
    ): ExpressionNode {
        const capabilityId = this.expressionCapabilityId(kind, range);
        const primitive =
            kind === "identifier" ||
            kind === "wildcard" ||
            kind === "literal" ||
            kind === "parameter" ||
            kind === "typed-literal";
        const formatRole: FormatRole = capabilityId === null
            ? primitive
                ? "intrinsic-primitive"
                : "intrinsic-container"
            : "capability";
        const facts =
            capabilityId === null &&
            formatRole === "intrinsic-primitive" &&
            markers.length === 0 &&
            operatorOccurrences.length === 0
                ? undefined
                : {
                      syntaxMarkers: markers,
                      capabilityId,
                      formatRole,
                      operatorOccurrences,
                  };
        return this.context.factory.createExpression(
            range,
            kind,
            operators,
            children,
            facts
        );
    }

    private expressionCapabilityId(
        kind: ExpressionKind,
        range: LeafRange
    ): string | null {
        const primitiveCapability =
            kind === "literal" || kind === "parameter"
                ? primitiveExpressionCapabilityId(
                      this.context.dialect,
                      kind,
                      this.context.leaves[range.start]
                  )
                : null;
        if (primitiveCapability !== null) {
            return primitiveCapability;
        }
        if (kind === "function-call") {
            return "function-call";
        }
        if (kind === "cast") {
            return "cast-type";
        }
        if (kind === "case") {
            return "case-expression";
        }
        if (kind === "subquery") {
            return "subquery-expression";
        }
        if (kind === "window") {
            return "window-expression";
        }
        if (kind === "collection") {
            if (this.context.dialect === "hive") {
                return "collection-expression";
            }
            if (this.context.dialect === "postgresql") {
                return "postgres-array-subset";
            }
            if (this.context.dialect === "generic") {
                return "generic-array-subset";
            }
        }
        return null;
    }

    private parseTypeOrOpaque(
        range: LeafRange,
        nestingDepth: number
    ): TypeExpressionNode | OpaqueNode {
        const checkpoint = createParserCheckpoint(this.context);
        try {
            return parseTypeExpression(this.context, range, nestingDepth);
        } catch (error) {
            return recoverOpaqueFromError(
                this.context,
                checkpoint,
                range,
                error,
                "type",
            );
        }
    }

    private parseExpression(
        minPrecedence: number,
        nestingDepth: number = this.nestingDepth
    ): ExpressionNode {
        const anchor = this.leafIndex() ?? this.indexes[this.indexes.length - 1]!;
        assertParserDepth({ start: anchor, end: anchor + 1 }, nestingDepth);
        let left = this.parsePrefix(nestingDepth);
        left = this.parsePostfix(left, nestingDepth);
        let nonAssociativePrecedence: number | null = null;

        while (this.position < this.indexes.length) {
            const postfix = this.matchWordPostfix();
            if (
                postfix !== null &&
                postfix.semantics.precedence !== null &&
                postfix.semantics.precedence >= minPrecedence
            ) {
                const operatorIds = postfix.positions.map((position) => this.indexes[position]!);
                if (
                    postfix.semantics.associativity === "none" &&
                    nonAssociativePrecedence === postfix.semantics.precedence
                ) {
                    throw new ParserSyntaxError(
                        "SYN_UNEXPECTED_TOKEN",
                        { start: operatorIds[0]!, end: operatorIds[operatorIds.length - 1]! + 1 },
                        "Non-associative predicates require explicit grouping"
                    );
                }
                this.position = postfix.positions[postfix.positions.length - 1]! + 1;
                left = this.create(
                    { start: left.leafRange.start, end: operatorIds[operatorIds.length - 1]! + 1 },
                    "is",
                    operatorIds,
                    [left],
                    [{ semantics: postfix.semantics, leafIds: operatorIds }]
                );
                if (postfix.semantics.associativity === "none") {
                    nonAssociativePrecedence = postfix.semantics.precedence;
                }
                continue;
            }

            const infix = this.matchInfix();
            if (
                infix === null ||
                infix.semantics.precedence === null ||
                infix.semantics.precedence < minPrecedence
            ) {
                break;
            }
            const precedence = infix.semantics.precedence;
            if (
                infix.semantics.associativity === "none" &&
                nonAssociativePrecedence === precedence
            ) {
                const operatorIds = infix.positions.map((position) => this.indexes[position]!);
                throw new ParserSyntaxError(
                    "SYN_UNEXPECTED_TOKEN",
                    { start: operatorIds[0]!, end: operatorIds[operatorIds.length - 1]! + 1 },
                    "Non-associative predicates require explicit grouping"
                );
            }
            if (infix.semantics.key === "between" || infix.semantics.key === "not-between") {
                left = this.parseBetween(left, infix, nestingDepth);
                nonAssociativePrecedence = precedence;
                continue;
            }
            if (infix.semantics.key === "in" || infix.semantics.key === "not-in") {
                left = this.parseIn(left, infix, nestingDepth);
                nonAssociativePrecedence = precedence;
                continue;
            }

            const operatorIds = infix.positions.map((position) => this.indexes[position]!);
            this.position = infix.positions[infix.positions.length - 1]! + 1;
            const rightPrecedence = infix.semantics.associativity === "right"
                ? precedence
                : precedence + 1;
            const rightStart = this.leafIndex() ?? operatorIds[operatorIds.length - 1]!;
            const right = this.parseExpression(
                rightPrecedence,
                descendParserDepth(
                    { start: rightStart, end: rightStart + 1 },
                    nestingDepth
                )
            );
            left = this.create(
                { start: left.leafRange.start, end: right.leafRange.end },
                "binary",
                operatorIds,
                [left, right],
                [{ semantics: infix.semantics, leafIds: operatorIds }]
            );
            if (infix.semantics.associativity === "none") {
                nonAssociativePrecedence = precedence;
            }
        }
        return left;
    }

    private parsePrefix(nestingDepth: number): ExpressionNode {
        const start = this.position;
        const leafIndex = this.leafIndex();
        if (leafIndex === null) {
            throw new ParserSyntaxError(
                "SYN_INCOMPLETE_CLAUSE",
                { start: this.indexes[this.indexes.length - 1]!, end: this.indexes[this.indexes.length - 1]! + 1 },
                "Expression requires an operand"
            );
        }
        const leaf = this.context.leaves[leafIndex]!;
        const prefix = this.matchPrefix();
        if (prefix !== null && prefix.semantics.precedence !== null) {
            this.position = prefix.positions[prefix.positions.length - 1]! + 1;
            const operand = this.parseExpression(
                prefix.semantics.precedence,
                descendParserDepth(
                    { start: leafIndex, end: leafIndex + 1 },
                    nestingDepth
                )
            );
            return this.create(
                { start: leafIndex, end: operand.leafRange.end },
                "unary",
                prefix.positions.map((position) => this.indexes[position]!),
                [operand],
                [{
                    semantics: prefix.semantics,
                    leafIds: prefix.positions.map((position) => this.indexes[position]!),
                }]
            );
        }

        if (this.wordIs(start, "case")) {
            return this.parseCase(nestingDepth);
        }
        if (this.wordIs(start, "cast") && this.raw(start + 1) === "(") {
            return this.parseCast(nestingDepth);
        }
        if (this.wordIs(start, "exists") && this.raw(start + 1) === "(") {
            return this.parseExists(nestingDepth);
        }
        if (leaf.raw === "(") {
            return this.parseParenthesized(nestingDepth);
        }
        if (leaf.raw === "[" && supportsCollectionSyntax(this.context.dialect)) {
            return this.parseBareCollection(nestingDepth);
        }
        if (leaf.raw === "*") {
            this.position += 1;
            return this.create({ start: leafIndex, end: leafIndex + 1 }, "wildcard", [], []);
        }
        if (leaf.kind === "number" || leaf.kind === "string") {
            this.position += 1;
            return this.create({ start: leafIndex, end: leafIndex + 1 }, "literal", [], []);
        }
        if (leaf.kind === "parameter") {
            this.position += 1;
            return this.create({ start: leafIndex, end: leafIndex + 1 }, "parameter", [], []);
        }
        if (isAtomicNameKind(leaf.kind)) {
            const word = this.word(start);
            if (word === "null" || word === "true" || word === "false") {
                this.position += 1;
                return this.create({ start: leafIndex, end: leafIndex + 1 }, "literal", [], []);
            }
            if (
                (word === "date" || word === "timestamp" || word === "interval") &&
                this.leafIndex(start + 1) !== null &&
                this.context.leaves[this.leafIndex(start + 1)!]!.kind === "string"
            ) {
                const literalIndex = this.leafIndex(start + 1)!;
                const literal = this.create(
                    { start: literalIndex, end: literalIndex + 1 },
                    "literal",
                    [],
                    []
                );
                this.position += 2;
                return this.create(
                    { start: leafIndex, end: literalIndex + 1 },
                    "typed-literal",
                    [],
                    [literal],
                    [],
                    syntaxMarkers(
                        [leafIndex],
                        "type:name",
                        "builtin-type-keyword"
                    )
                );
            }
            this.position += 1;
            return this.create(
                { start: leafIndex, end: leafIndex + 1 },
                "identifier",
                [],
                []
            );
        }

        throw new ParserSyntaxError(
            "SYN_UNEXPECTED_TOKEN",
            { start: leafIndex, end: leafIndex + 1 },
            `Unsupported expression atom ${leaf.raw}`
        );
    }

    private parsePostfix(
        input: ExpressionNode,
        nestingDepth: number
    ): ExpressionNode {
        let left = input;
        while (this.position < this.indexes.length) {
            if (this.raw() === ".") {
                const dot = this.leafIndex()!;
                const partIndex = this.leafIndex(this.position + 1);
                if (partIndex === null) {
                    throw new ParserSyntaxError(
                        "SYN_INCOMPLETE_CLAUSE",
                        { start: dot, end: dot + 1 },
                        "Qualified identifier requires a name after dot"
                    );
                }
                const partLeaf = this.context.leaves[partIndex]!;
                if (!isAtomicNameKind(partLeaf.kind) && partLeaf.raw !== "*") {
                    throw new ParserSyntaxError(
                        "SYN_UNEXPECTED_TOKEN",
                        { start: partIndex, end: partIndex + 1 },
                        "Qualified identifier part is invalid"
                    );
                }
                const part = this.create(
                    { start: partIndex, end: partIndex + 1 },
                    partLeaf.raw === "*" ? "wildcard" : "identifier",
                    [],
                    []
                );
                this.position += 2;
                left = this.create(
                    { start: left.leafRange.start, end: partIndex + 1 },
                    "qualified-identifier",
                    [],
                    [left, part],
                    [],
                    syntaxMarkers([dot], "delimiter", "punctuation", false)
                );
                continue;
            }
            if (this.raw() === "(") {
                left = this.parseCall(left, nestingDepth);
                continue;
            }
            if (this.raw() === "[" && supportsCollectionSyntax(this.context.dialect)) {
                left = this.parseIndexCollection(left, nestingDepth);
                continue;
            }
            if (this.wordIs(this.position, "over")) {
                left = this.parseWindow(left, nestingDepth);
                continue;
            }
            const cast = getDialect(this.context.dialect).getOperatorSemantics(
                this.raw() ?? "",
                "postfix"
            );
            if (cast?.key === "::") {
                const operator = this.leafIndex()!;
                const typeStart = this.position + 1;
                if (typeStart >= this.indexes.length) {
                    throw new ParserSyntaxError(
                        "SYN_INCOMPLETE_CLAUSE",
                        { start: operator, end: operator + 1 },
                        "PostgreSQL :: requires a type"
                    );
                }
                const parsedType = parseTypeExpressionPrefix(
                    this.context,
                    expressionRange(this.indexes, typeStart, this.indexes.length),
                    nestingDepth
                );
                const type = parsedType.node;
                const nextPosition = this.indexes.findIndex(
                    (index, position) =>
                        position >= typeStart && index >= parsedType.endLeafIndex
                );
                this.position = nextPosition < 0 ? this.indexes.length : nextPosition;
                left = this.create(
                    { start: left.leafRange.start, end: type.leafRange.end },
                    "cast",
                    [operator],
                    [left, type],
                    [{ semantics: cast, leafIds: [operator] }]
                );
                continue;
            }
            break;
        }
        return left;
    }

    private parseCall(
        callee: ExpressionNode,
        nestingDepth: number
    ): ExpressionNode {
        const openPosition = this.position;
        const closePosition = this.matchingPosition(openPosition);
        const open = this.indexes[openPosition]!;
        const close = this.indexes[closePosition]!;
        const children: SyntaxNode[] = [callee];
        let bodyStart = openPosition + 1;
        let distinctLeafId: number | null = null;
        if (bodyStart < closePosition && this.wordIs(bodyStart, "distinct")) {
            distinctLeafId = this.indexes[bodyStart]!;
            bodyStart += 1;
            if (bodyStart === closePosition) {
                throw new ParserSyntaxError(
                    "SYN_INCOMPLETE_CLAUSE",
                    { start: open, end: close + 1 },
                    "DISTINCT function call requires an argument"
                );
            }
        }
        if (bodyStart < closePosition) {
            const listRange = expressionRange(this.indexes, bodyStart, closePosition);
            const argumentDepth = descendParserDepth(
                { start: open, end: close + 1 },
                nestingDepth
            );
            children.push(
                parseList(
                    this.context,
                    listRange,
                    "function-args",
                    {
                        allowAlias: false,
                        reasonMessage: "Function argument is not modeled",
                    },
                    (context, range) =>
                        parseExpressionRange(
                            context,
                            range,
                            this.queryParser,
                            argumentDepth
                        )
                )
            );
        }
        const calleeWord =
            callee.leafRange.end === callee.leafRange.start + 1
                ? this.context.table.normalizedWord(callee.leafRange.start)
                : null;
        this.position = closePosition + 1;
        return this.create(
            { start: callee.leafRange.start, end: close + 1 },
            calleeWord !== null && isCollectionName(this.context.dialect, calleeWord)
                ? "collection"
                : "function-call",
            [],
            children,
            [],
            mergeSyntaxMarkers(
                syntaxMarkers([open, close], "delimiter", "delimiter", false),
                distinctLeafId === null
                    ? []
                    : syntaxMarkers([distinctLeafId], "operator")
            )
        );
    }

    private parseIndexCollection(
        left: ExpressionNode,
        nestingDepth: number
    ): ExpressionNode {
        const openPosition = this.position;
        const closePosition = this.matchingPosition(openPosition);
        const open = this.indexes[openPosition]!;
        const close = this.indexes[closePosition]!;
        if (closePosition === openPosition + 1) {
            this.position = closePosition + 1;
            return this.create(
                { start: left.leafRange.start, end: close + 1 },
                "collection",
                [],
                [left],
                [],
                syntaxMarkers([open, close], "delimiter", "delimiter", false)
            );
        }
        const body = expressionRange(this.indexes, openPosition + 1, closePosition);
        const valueDepth = descendParserDepth(
            { start: open, end: close + 1 },
            nestingDepth
        );
        const list = parseList(
            this.context,
            body,
            "values",
            { allowAlias: false, reasonMessage: "Collection value is not modeled" },
            (context, range) =>
                parseExpressionRange(context, range, this.queryParser, valueDepth)
        );
        this.position = closePosition + 1;
        return this.create(
            { start: left.leafRange.start, end: close + 1 },
            "collection",
            [],
            [left, list],
            [],
            syntaxMarkers([open, close], "delimiter", "delimiter", false)
        );
    }

    private parseBareCollection(nestingDepth: number): ExpressionNode {
        const openPosition = this.position;
        const open = this.indexes[openPosition]!;
        const closePosition = this.matchingPosition(openPosition);
        const close = this.indexes[closePosition]!;
        if (closePosition === openPosition + 1) {
            this.position = closePosition + 1;
            return this.create(
                { start: open, end: close + 1 },
                "collection",
                [],
                [],
                [],
                syntaxMarkers([open, close], "delimiter", "delimiter", false)
            );
        }
        const valueDepth = descendParserDepth(
            { start: open, end: close + 1 },
            nestingDepth
        );
        const list = parseList(
            this.context,
            expressionRange(this.indexes, openPosition + 1, closePosition),
            "values",
            { allowAlias: false, reasonMessage: "Collection value is not modeled" },
            (context, range) =>
                parseExpressionRange(context, range, this.queryParser, valueDepth)
        );
        this.position = closePosition + 1;
        return this.create(
            { start: open, end: close + 1 },
            "collection",
            [],
            [list],
            [],
            syntaxMarkers([open, close], "delimiter", "delimiter", false)
        );
    }

    private parseParenthesized(nestingDepth: number): ExpressionNode {
        const openPosition = this.position;
        const closePosition = this.matchingPosition(openPosition);
        const open = this.indexes[openPosition]!;
        const close = this.indexes[closePosition]!;
        if (closePosition === openPosition + 1) {
            throw new ParserSyntaxError(
                "SYN_INCOMPLETE_CLAUSE",
                { start: open, end: close + 1 },
                "Parenthesized expression is empty"
            );
        }
        const innerRange = expressionRange(this.indexes, openPosition + 1, closePosition);
        this.position = closePosition + 1;
        if (isQueryLeadingRange(this.context, innerRange)) {
            const query = this.queryParser(
                this.context,
                { start: open, end: close + 1 },
                nestingDepth
            );
            return this.create(
                { start: open, end: close + 1 },
                "subquery",
                [],
                [query]
            );
        }
        const topDepth = baseDepth(this.context, innerRange);
        const hasComma = syntaxIndexesInRange(this.context, innerRange).some((index) =>
            this.context.table.depthBefore(index) === topDepth &&
            this.context.leaves[index]!.raw === ","
        );
        if (hasComma) {
            const valueDepth = descendParserDepth(
                { start: open, end: close + 1 },
                nestingDepth
            );
            const list = parseList(
                this.context,
                innerRange,
                "values",
                { allowAlias: false, reasonMessage: "Tuple value is not modeled" },
                (context, range) =>
                    parseExpressionRange(context, range, this.queryParser, valueDepth)
            );
            return this.create(
                { start: open, end: close + 1 },
                "collection",
                [],
                [list],
                [],
                syntaxMarkers([open, close], "delimiter", "delimiter", false)
            );
        }
        const child = parseExpressionRange(
            this.context,
            innerRange,
            this.queryParser,
            descendParserDepth(
                { start: open, end: close + 1 },
                nestingDepth
            )
        );
        return this.create(
            { start: open, end: close + 1 },
            "parenthesized",
            [],
            [child],
            [],
            syntaxMarkers([open, close], "delimiter", "delimiter", false)
        );
    }

    private parseCast(nestingDepth: number): ExpressionNode {
        const castPosition = this.position;
        const openPosition = castPosition + 1;
        const closePosition = this.matchingPosition(openPosition);
        const open = this.indexes[openPosition]!;
        const close = this.indexes[closePosition]!;
        const innerDepth = this.context.table.depthAfter(open);
        let asPosition = -1;
        for (let position = openPosition + 1; position < closePosition; position++) {
            const index = this.indexes[position]!;
            if (
                this.context.table.depthBefore(index) === innerDepth &&
                this.wordIs(position, "as")
            ) {
                asPosition = position;
                break;
            }
        }
        if (asPosition <= openPosition + 1 || asPosition >= closePosition - 1) {
            throw new ParserSyntaxError(
                "SYN_INCOMPLETE_CLAUSE",
                { start: this.indexes[castPosition]!, end: close + 1 },
                "CAST requires expression AS type"
            );
        }
        const bodyDepth = descendParserDepth(
            { start: this.indexes[castPosition]!, end: close + 1 },
            nestingDepth
        );
        const value = parseExpressionRange(
            this.context,
            expressionRange(this.indexes, openPosition + 1, asPosition),
            this.queryParser,
            bodyDepth
        );
        const type = this.parseTypeOrOpaque(
            expressionRange(this.indexes, asPosition + 1, closePosition),
            bodyDepth
        );
        this.position = closePosition + 1;
        const cast = this.indexes[castPosition]!;
        const as = this.indexes[asPosition]!;
        return this.create(
            { start: cast, end: close + 1 },
            "cast",
            [],
            [value, type],
            [],
            mergeSyntaxMarkers(
                syntaxMarkers([cast], "type:cast"),
                syntaxMarkers([open, close], "delimiter", "delimiter", false),
                syntaxMarkers([as], "type:as")
            )
        );
    }

    private parseExists(nestingDepth: number): ExpressionNode {
        const existsPosition = this.position;
        const openPosition = existsPosition + 1;
        const closePosition = this.matchingPosition(openPosition);
        const open = this.indexes[openPosition]!;
        const close = this.indexes[closePosition]!;
        if (closePosition === openPosition + 1) {
            throw new ParserSyntaxError(
                "SYN_INCOMPLETE_CLAUSE",
                { start: open, end: close + 1 },
                "EXISTS requires a subquery"
            );
        }
        const inner = expressionRange(this.indexes, openPosition + 1, closePosition);
        if (!isQueryLeadingRange(this.context, inner)) {
            throw new ParserSyntaxError(
                "SYN_UNEXPECTED_TOKEN",
                inner,
                "EXISTS requires a query"
            );
        }
        const query = this.queryParser(
            this.context,
            { start: open, end: close + 1 },
            nestingDepth
        );
        const subquery = this.create(
            { start: open, end: close + 1 },
            "subquery",
            [],
            [query]
        );
        this.position = closePosition + 1;
        const exists = this.indexes[existsPosition]!;
        return this.create(
            { start: exists, end: close + 1 },
            "exists",
            [],
            [subquery],
            [],
            syntaxMarkers([exists], "operator", "word-operator-keyword")
        );
    }

    private parseCase(nestingDepth: number): ExpressionNode {
        const casePosition = this.position;
        const caseDepth = this.context.table.depthBefore(this.indexes[casePosition]!);
        let nestedCases = 0;
        let endPosition = -1;
        const markers: number[] = [];
        for (let position = casePosition + 1; position < this.indexes.length; position++) {
            if (
                this.context.table.depthBefore(this.indexes[position]!) !== caseDepth
            ) {
                continue;
            }
            const word = this.word(position);
            if (word === "case") {
                nestedCases += 1;
                continue;
            }
            if (word === "end") {
                if (nestedCases > 0) {
                    nestedCases -= 1;
                    continue;
                }
                endPosition = position;
                break;
            }
            if (
                nestedCases === 0 &&
                (word === "when" || word === "then" || word === "else")
            ) {
                markers.push(position);
            }
        }
        if (endPosition < 0) {
            throw new ParserSyntaxError(
                "SYN_INCOMPLETE_CLAUSE",
                expressionRange(this.indexes, casePosition, this.indexes.length),
                "CASE expression requires END"
            );
        }
        const firstWhen = markers.find((position) => this.wordIs(position, "when"));
        if (firstWhen === undefined) {
            throw new ParserSyntaxError(
                "SYN_INCOMPLETE_CLAUSE",
                expressionRange(this.indexes, casePosition, endPosition + 1),
                "CASE expression requires at least one WHEN branch"
            );
        }

        const children: SyntaxNode[] = [];
        const caseLeafId = this.indexes[casePosition]!;
        const branchDepth = descendParserDepth(
            expressionRange(this.indexes, casePosition, endPosition + 1),
            nestingDepth
        );
        if (firstWhen > casePosition + 1) {
            children.push(
                parseExpressionRange(
                    this.context,
                    expressionRange(this.indexes, casePosition + 1, firstWhen),
                    this.queryParser,
                    branchDepth
                )
            );
        }

        let markerIndex = markers.indexOf(firstWhen);
        while (markerIndex < markers.length) {
            const marker = markers[markerIndex]!;
            if (marker >= endPosition) {
                break;
            }
            if (this.wordIs(marker, "when")) {
                const then = markers[markerIndex + 1];
                if (then === undefined || !this.wordIs(then, "then")) {
                    throw new ParserSyntaxError(
                        "SYN_INCOMPLETE_CLAUSE",
                        { start: this.indexes[marker]!, end: this.indexes[marker]! + 1 },
                        "WHEN branch requires THEN"
                    );
                }
                const nextMarker = markers[markerIndex + 2] ?? endPosition;
                if (then === marker + 1 || nextMarker === then + 1) {
                    throw new ParserSyntaxError(
                        "SYN_INCOMPLETE_CLAUSE",
                        expressionRange(this.indexes, marker, nextMarker),
                        "WHEN/THEN branch requires condition and value"
                    );
                }
                const condition = parseExpressionRange(
                    this.context,
                    expressionRange(this.indexes, marker + 1, then),
                    this.queryParser,
                    branchDepth
                );
                const value = parseExpressionRange(
                    this.context,
                    expressionRange(this.indexes, then + 1, nextMarker),
                    this.queryParser,
                    branchDepth
                );
                children.push(
                    this.context.factory.createCaseBranch(
                        expressionRange(this.indexes, marker, nextMarker),
                        "when",
                        condition,
                        value,
                        nodeFacts(
                            null,
                            "intrinsic-container",
                            mergeSyntaxMarkers(
                                syntaxMarkers(
                                    [this.indexes[marker]!],
                                    "case:when"
                                ),
                                syntaxMarkers(
                                    [this.indexes[then]!],
                                    "case:then"
                                )
                            )
                        )
                    )
                );
                markerIndex += 2;
                continue;
            }
            if (this.wordIs(marker, "else")) {
                if (marker + 1 >= endPosition) {
                    throw new ParserSyntaxError(
                        "SYN_INCOMPLETE_CLAUSE",
                        { start: this.indexes[marker]!, end: this.indexes[endPosition]! + 1 },
                        "ELSE branch requires a value"
                    );
                }
                const value = parseExpressionRange(
                    this.context,
                    expressionRange(this.indexes, marker + 1, endPosition),
                    this.queryParser,
                    branchDepth
                );
                children.push(
                    this.context.factory.createCaseBranch(
                        expressionRange(this.indexes, marker, endPosition),
                        "else",
                        null,
                        value,
                        nodeFacts(
                            null,
                            "intrinsic-container",
                            syntaxMarkers(
                                [this.indexes[marker]!],
                                "case:else"
                            )
                        )
                    )
                );
                markerIndex += 1;
                continue;
            }
            throw new ParserSyntaxError(
                "SYN_UNEXPECTED_TOKEN",
                { start: this.indexes[marker]!, end: this.indexes[marker]! + 1 },
                "Unexpected CASE branch marker"
            );
        }
        const endLeafId = this.indexes[endPosition]!;
        this.position = endPosition + 1;
        return this.create(
            expressionRange(this.indexes, casePosition, endPosition + 1),
            "case",
            [],
            children,
            [],
            mergeSyntaxMarkers(
                syntaxMarkers([caseLeafId], "case:start"),
                syntaxMarkers([endLeafId], "case:end")
            )
        );
    }

    private parseBetween(
        left: ExpressionNode,
        match: OperatorMatch,
        nestingDepth: number
    ): ExpressionNode {
        const operatorIds = match.positions.map((position) => this.indexes[position]!);
        const valueStart = match.positions[match.positions.length - 1]! + 1;
        const depth = this.context.table.depthBefore(operatorIds[0]!);
        let andPosition = -1;
        for (let position = valueStart; position < this.indexes.length; position++) {
            const index = this.indexes[position]!;
            if (
                this.context.table.depthBefore(index) === depth &&
                this.wordIs(position, "and")
            ) {
                andPosition = position;
                break;
            }
        }
        if (andPosition <= valueStart || andPosition >= this.indexes.length - 1) {
            throw new ParserSyntaxError(
                "SYN_INCOMPLETE_CLAUSE",
                { start: operatorIds[0]!, end: operatorIds[operatorIds.length - 1]! + 1 },
                "BETWEEN requires lower AND upper expressions"
            );
        }
        const lower = parseExpressionRange(
            this.context,
            expressionRange(this.indexes, valueStart, andPosition),
            this.queryParser,
            descendParserDepth(
                expressionRange(this.indexes, valueStart, andPosition),
                nestingDepth
            )
        );
        this.position = andPosition + 1;
        const upper = this.parseExpression(
            match.semantics.precedence + 1,
            descendParserDepth(
                {
                    start: this.indexes[andPosition]!,
                    end: this.indexes[andPosition]! + 1,
                },
                nestingDepth
            )
        );
        operatorIds.push(this.indexes[andPosition]!);
        return this.create(
            { start: left.leafRange.start, end: upper.leafRange.end },
            "between",
            operatorIds,
            [left, lower, upper],
            [{ semantics: match.semantics, leafIds: operatorIds }]
        );
    }

    private parseIn(
        left: ExpressionNode,
        match: OperatorMatch,
        nestingDepth: number
    ): ExpressionNode {
        const operatorIds = match.positions.map((position) => this.indexes[position]!);
        const openPosition = match.positions[match.positions.length - 1]! + 1;
        if (this.raw(openPosition) !== "(") {
            const anchor = this.leafIndex(openPosition) ?? operatorIds[operatorIds.length - 1]!;
            throw new ParserSyntaxError(
                "SYN_INCOMPLETE_CLAUSE",
                { start: anchor, end: anchor + 1 },
                "IN requires a parenthesized list or query"
            );
        }
        const closePosition = this.matchingPosition(openPosition);
        const open = this.indexes[openPosition]!;
        const close = this.indexes[closePosition]!;
        if (closePosition === openPosition + 1) {
            throw new ParserSyntaxError(
                "SYN_INCOMPLETE_CLAUSE",
                { start: open, end: close + 1 },
                "IN list must not be empty"
            );
        }
        const innerRange = expressionRange(this.indexes, openPosition + 1, closePosition);
        let right: SyntaxNode;
        if (isQueryLeadingRange(this.context, innerRange)) {
            const query = this.queryParser(
                this.context,
                { start: open, end: close + 1 },
                nestingDepth
            );
            right = this.create(
                { start: open, end: close + 1 },
                "subquery",
                [],
                [query]
            );
        } else {
            const valueDepth = descendParserDepth(
                { start: open, end: close + 1 },
                nestingDepth
            );
            right = parseList(
                this.context,
                innerRange,
                "values",
                { allowAlias: false, reasonMessage: "IN value is not modeled" },
                (context, range) =>
                    parseExpressionRange(context, range, this.queryParser, valueDepth)
            );
        }
        this.position = closePosition + 1;
        const occurrenceLeafIds = operatorIds.slice();
        const rightOwnsDelimiters =
            right.kind === "expression" && right.expressionKind === "subquery";
        return this.create(
            { start: left.leafRange.start, end: close + 1 },
            "in",
            occurrenceLeafIds,
            [left, right],
            [{ semantics: match.semantics, leafIds: occurrenceLeafIds }],
            rightOwnsDelimiters
                ? []
                : syntaxMarkers(
                      [open, close],
                      "delimiter",
                      "delimiter",
                      false
                  )
        );
    }

    private parseWindow(
        left: ExpressionNode,
        nestingDepth: number
    ): ExpressionNode {
        const over = this.leafIndex()!;
        const specStart = this.position + 1;
        if (specStart >= this.indexes.length) {
            throw new ParserSyntaxError(
                "SYN_INCOMPLETE_CLAUSE",
                { start: over, end: over + 1 },
                "OVER requires a named or parenthesized window"
            );
        }
        let spec: WindowSpecNode;
        if (this.raw(specStart) === "(") {
            const closePosition = this.matchingPosition(specStart);
            spec = parseWindowSpecRange(
                this.context,
                expressionRange(this.indexes, specStart, closePosition + 1),
                nestingDepth,
                (context, range, nestingDepth) =>
                    parseExpressionRange(
                        context,
                        range,
                        this.queryParser,
                        nestingDepth
                    )
            );
            this.position = closePosition + 1;
        } else {
            const nameIndex = this.indexes[specStart]!;
            if (!isAliasNameLeaf(this.context.leaves[nameIndex]!)) {
                throw new ParserSyntaxError(
                    "SYN_UNEXPECTED_TOKEN",
                    { start: nameIndex, end: nameIndex + 1 },
                    "OVER window name must be an identifier"
                );
            }
            const nameRange = Object.freeze({ start: nameIndex, end: nameIndex + 1 });
            spec = this.context.factory.createWindowSpec(
                nameRange,
                nameRange,
                null,
                null,
                null
            );
            this.position = specStart + 1;
        }
        return this.create(
            { start: left.leafRange.start, end: spec.leafRange.end },
            "window",
            [],
            [left, spec],
            [],
            syntaxMarkers([over], "window:over")
        );
    }

    private matchPrefix(): OperatorMatch | null {
        const index = this.leafIndex();
        if (index === null) {
            return null;
        }
        const leaf = this.context.leaves[index]!;
        const key = leaf.kind === "operator" ? leaf.raw : this.word();
        if (key === null) {
            return null;
        }
        const semantics = getDialect(this.context.dialect).getOperatorSemantics(key, "prefix");
        return semantics === null
            ? null
            : Object.freeze({ semantics, positions: Object.freeze([this.position]) });
    }

    private matchInfix(): OperatorMatch | null {
        const index = this.leafIndex();
        if (index === null) {
            return null;
        }
        const leaf = this.context.leaves[index]!;
        const dialect = getDialect(this.context.dialect);
        if (leaf.kind === "operator") {
            const semantics = dialect.getOperatorSemantics(leaf.raw, "infix");
            return semantics === null
                ? null
                : Object.freeze({ semantics, positions: Object.freeze([this.position]) });
        }
        const word = this.word();
        if (word === null) {
            return null;
        }
        let key = word;
        let positions = [this.position];
        if (word === "not") {
            const compoundKey = `not-${this.word(this.position + 1) ?? ""}`;
            if (dialect.getOperatorSemantics(compoundKey, "infix") !== null) {
                key = compoundKey;
                positions = [this.position, this.position + 1];
            }
        }
        const semantics = dialect.getOperatorSemantics(key, "infix");
        return semantics === null
            ? null
            : Object.freeze({ semantics, positions: Object.freeze(positions) });
    }

    private matchWordPostfix(): OperatorMatch | null {
        if (!this.wordIs(this.position, "is")) {
            return null;
        }
        let key: string;
        let positions: number[];
        if (this.wordIs(this.position + 1, "not")) {
            const predicate = this.word(this.position + 2);
            if (predicate !== "null" && predicate !== "true" && predicate !== "false") {
                return null;
            }
            key = `is-not-${predicate}`;
            positions = [this.position, this.position + 1, this.position + 2];
        } else {
            const predicate = this.word(this.position + 1);
            if (predicate !== "null" && predicate !== "true" && predicate !== "false") {
                return null;
            }
            key = `is-${predicate}`;
            positions = [this.position, this.position + 1];
        }
        const semantics = getDialect(this.context.dialect).getOperatorSemantics(key, "postfix");
        return semantics === null
            ? null
            : Object.freeze({ semantics, positions: Object.freeze(positions) });
    }
}

export function parseExpressionRange(
    context: ParserContext,
    inputRange: LeafRange,
    queryParser: ExpressionQueryParser,
    nestingDepth: number = 0
): ExpressionValueNode {
    const range = trimToSyntax(context.leaves, inputRange);
    if (range === null) {
        throw new ParserSyntaxError(
            "SYN_INCOMPLETE_CLAUSE",
            inputRange,
            "Expression range is empty"
        );
    }
    const checkpoint = createParserCheckpoint(context);
    try {
        return new PrattParser(context, range, queryParser, nestingDepth).parseBounded();
    } catch (error) {
        return recoverOpaqueFromError(
            context,
            checkpoint,
            range,
            error,
            "expression",
        );
    }
}
