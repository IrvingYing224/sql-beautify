import type { LeafRange } from "./leaf-range";
import { parseList } from "./list-parser";
import type {
    ExpressionNode,
    ListNode,
    OpaqueNode,
    WindowSpecNode,
} from "./node";
import {
    ParserSyntaxError,
    baseDepth,
    createOpaqueWithDiagnostic,
    isAliasNameLeaf,
    isCodeWord,
    syntaxIndexesInRange,
    trimToSyntax,
} from "./parser-context";
import type { ParserContext } from "./parser-context";

export type WindowValueParser = (
    context: ParserContext,
    range: LeafRange,
    nestingDepth: number
) => ExpressionNode | OpaqueNode;

const FRAME_START_WORDS = Object.freeze(["rows", "range"]);
const FRAME_BOUND_SUFFIXES = Object.freeze(["preceding", "following"]);

function rangeFromIndexes(
    indexes: readonly number[],
    start: number,
    end: number
): LeafRange {
    if (start >= end) {
        throw new Error("Cannot create an empty window range");
    }
    return Object.freeze({
        start: indexes[start]!,
        end: indexes[end - 1]! + 1,
    });
}

class WindowParser {
    private readonly context: ParserContext;
    private readonly indexes: readonly number[];
    private readonly nestingDepth: number;
    private readonly parseValue: WindowValueParser;

    constructor(
        context: ParserContext,
        range: LeafRange,
        nestingDepth: number,
        parseValue: WindowValueParser
    ) {
        this.context = context;
        this.indexes = syntaxIndexesInRange(context, range);
        this.nestingDepth = nestingDepth;
        this.parseValue = parseValue;
    }

    parseBounded(
        nodeRange?: LeafRange,
        nameLeafRange: LeafRange | null = null
    ): WindowSpecNode {
        if (
            this.indexes.length < 2 ||
            this.raw(0) !== "(" ||
            this.raw(this.indexes.length - 1) !== ")" ||
            this.matchingPosition(0) !== this.indexes.length - 1
        ) {
            const fallback = this.indexes.length === 0
                ? { start: 0, end: 0 }
                : rangeFromIndexes(this.indexes, 0, this.indexes.length);
            throw new ParserSyntaxError(
                "SYN_UNMATCHED_DELIMITER",
                fallback,
                "Window specification must be one balanced parenthesized range"
            );
        }
        return this.parseInline(
            0,
            this.indexes.length - 1,
            nodeRange,
            nameLeafRange
        );
    }

    private raw(position: number): string | null {
        const index = this.indexes[position];
        return index === undefined ? null : this.context.leaves[index]!.raw;
    }

    private word(position: number): string | null {
        const index = this.indexes[position];
        if (index === undefined || this.context.leaves[index]!.channel !== "code") {
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
            return -1;
        }
        return this.indexes.indexOf(close, openPosition + 1);
    }

    private parseInline(
        openPosition: number,
        closePosition: number,
        nodeRange?: LeafRange,
        declarationName: LeafRange | null = null
    ): WindowSpecNode {
        const open = this.indexes[openPosition]!;
        const close = this.indexes[closePosition]!;
        const outputRange = nodeRange ?? { start: open, end: close + 1 };
        if (closePosition === openPosition + 1) {
            return this.context.factory.createWindowSpec(
                outputRange,
                declarationName,
                null,
                null,
                null
            );
        }

        const bodyStart = openPosition + 1;
        const bodyRange = rangeFromIndexes(this.indexes, bodyStart, closePosition);
        const depth = baseDepth(this.context, bodyRange);
        let partitionPosition = -1;
        let orderPosition = -1;
        let framePosition = -1;
        for (let position = bodyStart; position < closePosition; position++) {
            const index = this.indexes[position]!;
            if (this.context.table.depthBefore(index) !== depth) {
                continue;
            }
            if (
                partitionPosition < 0 &&
                this.wordIs(position, "partition") &&
                this.wordIs(position + 1, "by")
            ) {
                partitionPosition = position;
                continue;
            }
            if (
                orderPosition < 0 &&
                this.wordIs(position, "order") &&
                this.wordIs(position + 1, "by")
            ) {
                orderPosition = position;
                continue;
            }
            if (framePosition < 0 && FRAME_START_WORDS.includes(this.word(position) ?? "")) {
                framePosition = position;
            }
        }

        if (partitionPosition < 0 && orderPosition < 0 && framePosition < 0) {
            const bodyIndexes = syntaxIndexesInRange(this.context, bodyRange);
            if (
                bodyIndexes.length === 1 &&
                isAliasNameLeaf(this.context.leaves[bodyIndexes[0]!]!)
            ) {
                return this.context.factory.createWindowSpec(
                    outputRange,
                    declarationName ?? {
                        start: bodyIndexes[0]!,
                        end: bodyIndexes[0]! + 1,
                    },
                    null,
                    null,
                    null
                );
            }
            throw new ParserSyntaxError(
                "SYN_UNEXPECTED_TOKEN",
                bodyRange,
                "Window specification has an unmodeled body"
            );
        }

        let partition: ListNode | null = null;
        let order: ListNode | null = null;
        let frame: ExpressionNode | null = null;
        if (partitionPosition >= 0) {
            const partitionStart = partitionPosition + 2;
            const partitionEnd = orderPosition >= 0
                ? orderPosition
                : framePosition >= 0
                  ? framePosition
                  : closePosition;
            if (partitionStart >= partitionEnd) {
                throw new ParserSyntaxError(
                    "SYN_INCOMPLETE_CLAUSE",
                    {
                        start: this.indexes[partitionPosition]!,
                        end: this.indexes[partitionPosition + 1]! + 1,
                    },
                    "PARTITION BY requires expressions"
                );
            }
            partition = parseList(
                this.context,
                rangeFromIndexes(this.indexes, partitionStart, partitionEnd),
                "window-partition",
                { allowAlias: false, reasonMessage: "Window partition is not modeled" },
                (context, range) =>
                    this.parseValue(context, range, this.nestingDepth + 1)
            );
        }
        if (orderPosition >= 0) {
            const orderStart = orderPosition + 2;
            const orderEnd = framePosition >= 0 ? framePosition : closePosition;
            if (orderStart >= orderEnd) {
                throw new ParserSyntaxError(
                    "SYN_INCOMPLETE_CLAUSE",
                    {
                        start: this.indexes[orderPosition]!,
                        end: this.indexes[orderPosition + 1]! + 1,
                    },
                    "ORDER BY requires expressions"
                );
            }
            order = parseList(
                this.context,
                rangeFromIndexes(this.indexes, orderStart, orderEnd),
                "window-order",
                {
                    allowAlias: false,
                    modifierWords: ["asc", "desc"],
                    reasonMessage: "Window order is not modeled",
                },
                (context, range) =>
                    this.parseValue(context, range, this.nestingDepth + 1)
            );
        }
        if (framePosition >= 0) {
            frame = this.parseFrame(framePosition, closePosition);
        }
        return this.context.factory.createWindowSpec(
            outputRange,
            declarationName,
            partition,
            order,
            frame
        );
    }

    private parseFrame(start: number, end: number): ExpressionNode {
        const unit = this.indexes[start]!;
        if (start + 1 >= end) {
            throw new ParserSyntaxError(
                "SYN_INCOMPLETE_CLAUSE",
                { start: unit, end: unit + 1 },
                "Window frame requires a bound"
            );
        }
        if (this.wordIs(start + 1, "between")) {
            const frameDepth = this.context.table.depthBefore(unit);
            let andPosition = -1;
            for (let position = start + 2; position < end; position++) {
                const index = this.indexes[position]!;
                if (
                    this.context.table.depthBefore(index) === frameDepth &&
                    this.wordIs(position, "and")
                ) {
                    andPosition = position;
                    break;
                }
            }
            if (andPosition <= start + 2 || andPosition >= end - 1) {
                throw new ParserSyntaxError(
                    "SYN_INCOMPLETE_CLAUSE",
                    rangeFromIndexes(this.indexes, start, end),
                    "Window BETWEEN frame requires two bounds"
                );
            }
            const lower = this.parseFrameBound(start + 2, andPosition);
            const upper = this.parseFrameBound(andPosition + 1, end);
            return this.context.factory.createExpression(
                rangeFromIndexes(this.indexes, start, end),
                "between",
                [unit, this.indexes[start + 1]!, this.indexes[andPosition]!],
                [lower, upper]
            );
        }
        const bound = this.parseFrameBound(start + 1, end);
        return this.context.factory.createExpression(
            rangeFromIndexes(this.indexes, start, end),
            "unary",
            [unit],
            [bound]
        );
    }

    private parseFrameBound(start: number, end: number): ExpressionNode {
        const words: string[] = [];
        for (let position = start; position < end; position++) {
            words.push(this.word(position) ?? "");
        }
        if (
            (words.length === 2 &&
                words[0] === "unbounded" &&
                FRAME_BOUND_SUFFIXES.includes(words[1]!)) ||
            (words.length === 2 && words[0] === "current" && words[1] === "row")
        ) {
            return this.context.factory.createExpression(
                rangeFromIndexes(this.indexes, start, end),
                "frame-bound",
                this.indexes.slice(start, end),
                []
            );
        }
        if (end - start >= 2 && FRAME_BOUND_SUFFIXES.includes(words[words.length - 1]!)) {
            const suffix = this.indexes[end - 1]!;
            const value = this.parseValue(
                this.context,
                rangeFromIndexes(this.indexes, start, end - 1),
                this.nestingDepth + 1
            );
            return this.context.factory.createExpression(
                rangeFromIndexes(this.indexes, start, end),
                "frame-bound",
                [suffix],
                [value]
            );
        }
        throw new ParserSyntaxError(
            "SYN_UNEXPECTED_TOKEN",
            rangeFromIndexes(this.indexes, start, end),
            "Unsupported window frame bound"
        );
    }
}

export function parseWindowSpecRange(
    context: ParserContext,
    inputRange: LeafRange,
    nestingDepth: number,
    parseValue: WindowValueParser,
    nodeRange?: LeafRange,
    nameLeafRange: LeafRange | null = null
): WindowSpecNode {
    const range = trimToSyntax(context.leaves, inputRange);
    if (range === null) {
        throw new ParserSyntaxError(
            "SYN_INCOMPLETE_CLAUSE",
            inputRange,
            "Window specification is empty"
        );
    }
    return new WindowParser(context, range, nestingDepth, parseValue).parseBounded(
        nodeRange,
        nameLeafRange
    );
}

export function parseWindowDeclaration(
    context: ParserContext,
    inputRange: LeafRange,
    nestingDepth: number,
    parseValue: WindowValueParser
): WindowSpecNode | OpaqueNode {
    const range = trimToSyntax(context.leaves, inputRange);
    if (range === null) {
        throw new ParserSyntaxError(
            "SYN_INCOMPLETE_CLAUSE",
            inputRange,
            "WINDOW declaration is empty"
        );
    }
    const indexes = syntaxIndexesInRange(context, range);
    if (
        indexes.length < 4 ||
        !isAliasNameLeaf(context.leaves[indexes[0]!]!) ||
        !isCodeWord(context, indexes[1]!, "as") ||
        context.leaves[indexes[2]!]!.raw !== "("
    ) {
        return createOpaqueWithDiagnostic(
            context,
            range,
            "SYN_UNEXPECTED_TOKEN",
            "window",
            "WINDOW declaration requires name AS (specification)"
        );
    }
    const close = context.table.matchingDelimiterIndex(indexes[2]!);
    if (close === null || close !== indexes[indexes.length - 1]!) {
        return createOpaqueWithDiagnostic(
            context,
            range,
            "SYN_UNMATCHED_DELIMITER",
            "window",
            "WINDOW declaration has an unmatched specification"
        );
    }

    const factoryCheckpoint = context.factory.checkpoint();
    const diagnosticCheckpoint = context.diagnostics.length;
    try {
        return parseWindowSpecRange(
            context,
            { start: indexes[2]!, end: close + 1 },
            nestingDepth + 1,
            parseValue,
            range,
            { start: indexes[0]!, end: indexes[0]! + 1 }
        );
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
            "window",
            error.message
        );
    }
}
