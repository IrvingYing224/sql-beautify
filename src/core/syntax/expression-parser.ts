import { getDialect } from "../dialects/registry";
import type { OperatorSemantics } from "../dialects/types";
import type { LeafRange } from "./leaf-range";
import { parseList } from "./list-parser";
import type {
    ExpressionKind,
    ExpressionNode,
    OpaqueNode,
    QueryNode,
    SyntaxNode,
    TypeExpressionNode,
    WindowSpecNode,
} from "./node";
import {
    ParserSyntaxError,
    baseDepth,
    createOpaqueWithDiagnostic,
    isAliasNameLeaf,
    isQueryLeadingRange,
    syntaxIndexesInRange,
    trimToSyntax,
} from "./parser-context";
import type { ParserContext } from "./parser-context";
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

const MAX_EXPRESSION_NESTING = 256;
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
    return capabilityId !== null && getDialect(dialect).getCapability(capabilityId)?.state === "structured";
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
        if (nestingDepth >= MAX_EXPRESSION_NESTING) {
            throw new ParserSyntaxError(
                "SYN_MAX_DEPTH_EXCEEDED",
                range,
                `Expression nesting budget ${MAX_EXPRESSION_NESTING} exceeded`
            );
        }
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
        children: readonly SyntaxNode[]
    ): ExpressionNode {
        return this.context.factory.createExpression(range, kind, operators, children);
    }

    private parseTypeOrOpaque(range: LeafRange): TypeExpressionNode | OpaqueNode {
        const factoryCheckpoint = this.context.factory.checkpoint();
        const diagnosticCheckpoint = this.context.diagnostics.length;
        try {
            return parseTypeExpression(this.context, range);
        } catch (error) {
            if (!(error instanceof ParserSyntaxError)) {
                throw error;
            }
            this.context.factory.rollback(factoryCheckpoint);
            this.context.diagnostics.splice(diagnosticCheckpoint);
            return createOpaqueWithDiagnostic(
                this.context,
                range,
                error.code,
                "type",
                error.message
            );
        }
    }

    private parseExpression(
        minPrecedence: number,
        recursionDepth: number = 0
    ): ExpressionNode {
        if (this.nestingDepth + recursionDepth >= MAX_EXPRESSION_NESTING) {
            const anchor = this.leafIndex() ?? this.indexes[this.indexes.length - 1]!;
            throw new ParserSyntaxError(
                "SYN_MAX_DEPTH_EXCEEDED",
                { start: anchor, end: anchor + 1 },
                `Expression nesting budget ${MAX_EXPRESSION_NESTING} exceeded`
            );
        }
        let left = this.parsePrefix(recursionDepth);
        left = this.parsePostfix(left);
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
                    [left]
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
                left = this.parseBetween(left, infix, recursionDepth);
                nonAssociativePrecedence = precedence;
                continue;
            }
            if (infix.semantics.key === "in" || infix.semantics.key === "not-in") {
                left = this.parseIn(left, infix);
                nonAssociativePrecedence = precedence;
                continue;
            }

            const operatorIds = infix.positions.map((position) => this.indexes[position]!);
            this.position = infix.positions[infix.positions.length - 1]! + 1;
            const rightPrecedence = infix.semantics.associativity === "right"
                ? precedence
                : precedence + 1;
            const right = this.parseExpression(rightPrecedence, recursionDepth + 1);
            left = this.create(
                { start: left.leafRange.start, end: right.leafRange.end },
                "binary",
                operatorIds,
                [left, right]
            );
            if (infix.semantics.associativity === "none") {
                nonAssociativePrecedence = precedence;
            }
        }
        return left;
    }

    private parsePrefix(recursionDepth: number): ExpressionNode {
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
                recursionDepth + 1
            );
            return this.create(
                { start: leafIndex, end: operand.leafRange.end },
                "unary",
                prefix.positions.map((position) => this.indexes[position]!),
                [operand]
            );
        }

        if (this.wordIs(start, "case")) {
            return this.parseCase();
        }
        if (this.wordIs(start, "cast") && this.raw(start + 1) === "(") {
            return this.parseCast();
        }
        if (this.wordIs(start, "exists") && this.raw(start + 1) === "(") {
            return this.parseExists();
        }
        if (leaf.raw === "(") {
            return this.parseParenthesized();
        }
        if (leaf.raw === "[" && supportsCollectionSyntax(this.context.dialect)) {
            return this.parseBareCollection();
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
                    [leafIndex],
                    [literal]
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

    private parsePostfix(input: ExpressionNode): ExpressionNode {
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
                    [dot],
                    [left, part]
                );
                continue;
            }
            if (this.raw() === "(") {
                left = this.parseCall(left);
                continue;
            }
            if (this.raw() === "[" && supportsCollectionSyntax(this.context.dialect)) {
                left = this.parseIndexCollection(left);
                continue;
            }
            if (this.wordIs(this.position, "over")) {
                left = this.parseWindow(left);
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
                    expressionRange(this.indexes, typeStart, this.indexes.length)
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
                    [left, type]
                );
                continue;
            }
            break;
        }
        return left;
    }

    private parseCall(callee: ExpressionNode): ExpressionNode {
        const openPosition = this.position;
        const closePosition = this.matchingPosition(openPosition);
        const open = this.indexes[openPosition]!;
        const close = this.indexes[closePosition]!;
        const operators: number[] = [open];
        const children: SyntaxNode[] = [callee];
        let bodyStart = openPosition + 1;
        if (bodyStart < closePosition && this.wordIs(bodyStart, "distinct")) {
            operators.push(this.indexes[bodyStart]!);
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
                            this.nestingDepth + 1
                        )
                )
            );
        }
        operators.push(close);
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
            operators,
            children
        );
    }

    private parseIndexCollection(left: ExpressionNode): ExpressionNode {
        const openPosition = this.position;
        const closePosition = this.matchingPosition(openPosition);
        const open = this.indexes[openPosition]!;
        const close = this.indexes[closePosition]!;
        if (closePosition === openPosition + 1) {
            this.position = closePosition + 1;
            return this.create(
                { start: left.leafRange.start, end: close + 1 },
                "collection",
                [open, close],
                [left]
            );
        }
        const body = expressionRange(this.indexes, openPosition + 1, closePosition);
        const list = parseList(
            this.context,
            body,
            "values",
            { allowAlias: false, reasonMessage: "Collection value is not modeled" },
            (context, range) =>
                parseExpressionRange(context, range, this.queryParser, this.nestingDepth + 1)
        );
        this.position = closePosition + 1;
        return this.create(
            { start: left.leafRange.start, end: close + 1 },
            "collection",
            [open, close],
            [left, list]
        );
    }

    private parseBareCollection(): ExpressionNode {
        const openPosition = this.position;
        const open = this.indexes[openPosition]!;
        const closePosition = this.matchingPosition(openPosition);
        const close = this.indexes[closePosition]!;
        if (closePosition === openPosition + 1) {
            this.position = closePosition + 1;
            return this.create(
                { start: open, end: close + 1 },
                "collection",
                [open, close],
                []
            );
        }
        const list = parseList(
            this.context,
            expressionRange(this.indexes, openPosition + 1, closePosition),
            "values",
            { allowAlias: false, reasonMessage: "Collection value is not modeled" },
            (context, range) =>
                parseExpressionRange(context, range, this.queryParser, this.nestingDepth + 1)
        );
        this.position = closePosition + 1;
        return this.create(
            { start: open, end: close + 1 },
            "collection",
            [open, close],
            [list]
        );
    }

    private parseParenthesized(): ExpressionNode {
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
                this.nestingDepth + 1
            );
            return this.create(
                { start: open, end: close + 1 },
                "subquery",
                [open, close],
                [query]
            );
        }
        const topDepth = baseDepth(this.context, innerRange);
        const hasComma = syntaxIndexesInRange(this.context, innerRange).some((index) =>
            this.context.table.depthBefore(index) === topDepth &&
            this.context.leaves[index]!.raw === ","
        );
        if (hasComma) {
            const list = parseList(
                this.context,
                innerRange,
                "values",
                { allowAlias: false, reasonMessage: "Tuple value is not modeled" },
                (context, range) =>
                    parseExpressionRange(context, range, this.queryParser, this.nestingDepth + 1)
            );
            return this.create(
                { start: open, end: close + 1 },
                "collection",
                [open, close],
                [list]
            );
        }
        const child = parseExpressionRange(
            this.context,
            innerRange,
            this.queryParser,
            this.nestingDepth + 1
        );
        return this.create(
            { start: open, end: close + 1 },
            "parenthesized",
            [open, close],
            [child]
        );
    }

    private parseCast(): ExpressionNode {
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
        const value = parseExpressionRange(
            this.context,
            expressionRange(this.indexes, openPosition + 1, asPosition),
            this.queryParser,
            this.nestingDepth + 1
        );
        const type = this.parseTypeOrOpaque(
            expressionRange(this.indexes, asPosition + 1, closePosition)
        );
        this.position = closePosition + 1;
        return this.create(
            { start: this.indexes[castPosition]!, end: close + 1 },
            "cast",
            [this.indexes[castPosition]!, open, this.indexes[asPosition]!, close],
            [value, type]
        );
    }

    private parseExists(): ExpressionNode {
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
            this.nestingDepth + 1
        );
        const subquery = this.create(
            { start: open, end: close + 1 },
            "subquery",
            [open, close],
            [query]
        );
        this.position = closePosition + 1;
        return this.create(
            { start: this.indexes[existsPosition]!, end: close + 1 },
            "exists",
            [this.indexes[existsPosition]!],
            [subquery]
        );
    }

    private parseCase(): ExpressionNode {
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
        const operators: number[] = [this.indexes[casePosition]!];
        if (firstWhen > casePosition + 1) {
            children.push(
                parseExpressionRange(
                    this.context,
                    expressionRange(this.indexes, casePosition + 1, firstWhen),
                    this.queryParser,
                    this.nestingDepth + 1
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
                    this.nestingDepth + 1
                );
                const value = parseExpressionRange(
                    this.context,
                    expressionRange(this.indexes, then + 1, nextMarker),
                    this.queryParser,
                    this.nestingDepth + 1
                );
                children.push(
                    this.context.factory.createCaseBranch(
                        expressionRange(this.indexes, marker, nextMarker),
                        "when",
                        condition,
                        value
                    )
                );
                operators.push(this.indexes[marker]!, this.indexes[then]!);
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
                    this.nestingDepth + 1
                );
                children.push(
                    this.context.factory.createCaseBranch(
                        expressionRange(this.indexes, marker, endPosition),
                        "else",
                        null,
                        value
                    )
                );
                operators.push(this.indexes[marker]!);
                markerIndex += 1;
                continue;
            }
            throw new ParserSyntaxError(
                "SYN_UNEXPECTED_TOKEN",
                { start: this.indexes[marker]!, end: this.indexes[marker]! + 1 },
                "Unexpected CASE branch marker"
            );
        }
        operators.push(this.indexes[endPosition]!);
        this.position = endPosition + 1;
        return this.create(
            expressionRange(this.indexes, casePosition, endPosition + 1),
            "case",
            operators,
            children
        );
    }

    private parseBetween(
        left: ExpressionNode,
        match: OperatorMatch,
        recursionDepth: number
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
            this.nestingDepth + 1
        );
        this.position = andPosition + 1;
        const upper = this.parseExpression(
            match.semantics.precedence + 1,
            recursionDepth + 1
        );
        operatorIds.push(this.indexes[andPosition]!);
        return this.create(
            { start: left.leafRange.start, end: upper.leafRange.end },
            "between",
            operatorIds,
            [left, lower, upper]
        );
    }

    private parseIn(left: ExpressionNode, match: OperatorMatch): ExpressionNode {
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
                this.nestingDepth + 1
            );
            right = this.create(
                { start: open, end: close + 1 },
                "subquery",
                [open, close],
                [query]
            );
        } else {
            right = parseList(
                this.context,
                innerRange,
                "values",
                { allowAlias: false, reasonMessage: "IN value is not modeled" },
                (context, range) =>
                    parseExpressionRange(context, range, this.queryParser, this.nestingDepth + 1)
            );
        }
        this.position = closePosition + 1;
        operatorIds.push(open, close);
        return this.create(
            { start: left.leafRange.start, end: close + 1 },
            "in",
            operatorIds,
            [left, right]
        );
    }

    private parseWindow(left: ExpressionNode): ExpressionNode {
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
                this.nestingDepth + 1,
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
            [over],
            [left, spec]
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
    const factoryCheckpoint = context.factory.checkpoint();
    const diagnosticCheckpoint = context.diagnostics.length;
    try {
        return new PrattParser(context, range, queryParser, nestingDepth).parseBounded();
    } catch (error) {
        if (!(error instanceof ParserSyntaxError)) {
            throw error;
        }
        context.factory.rollback(factoryCheckpoint);
        context.diagnostics.splice(diagnosticCheckpoint);
        return createOpaqueWithDiagnostic(
            context,
            range,
            error.code,
            "expression",
            error.message
        );
    }
}
