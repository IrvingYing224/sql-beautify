import type { LeafRange } from "./leaf-range";
import type {
    CapabilityIdentity,
    RecoveryAction,
} from "../diagnostics/diagnostic";
import type { QueryNode, StatementNode } from "./node";
import {
    ParserSyntaxError,
    addDiagnostic,
    isCodeWord,
    isSyntaxLeaf,
    trimToSyntax,
} from "./parser-context";
import type { ParserContext, SyntaxDiagnosticCode } from "./parser-context";
import { parseInsertQueryRange, parseQueryRange } from "./query-parser";
import {
    createOpaqueWithDiagnostic,
    createParserCheckpoint,
    rollbackParserCheckpoint,
} from "./recovery";
import { classifyUnsupportedStatementStart } from "./unsupported-recognizer";

function statementRecovery(
    context: ParserContext
): "preserve-statement" | "preserve-target" {
    return context.mode === "fragment" ? "preserve-target" : "preserve-statement";
}

function representsInsertQuery(query: QueryNode): boolean {
    const first = query.children[0];
    if (first?.kind === "clause" && first.clauseKind === "insert") {
        return true;
    }
    if (
        first?.kind === "clause" &&
        first.clauseKind === "with" &&
        query.children[1]?.kind === "query"
    ) {
        return representsInsertQuery(query.children[1]);
    }
    if (query.queryKind === "set" && first?.kind === "query") {
        return representsInsertQuery(first);
    }
    return false;
}

export function isEmptyStatementRange(context: ParserContext, range: LeafRange): boolean {
    let hasSemicolon = false;
    for (let i = range.start; i < range.end; i++) {
        const leaf = context.leaves[i]!;
        if (!isSyntaxLeaf(leaf)) {
            continue;
        }
        if (leaf.channel === "code" && leaf.raw === ";") {
            hasSemicolon = true;
            continue;
        }
        return false;
    }
    return hasSemicolon;
}

function queryBodyRange(context: ParserContext, statementRange: LeafRange): LeafRange | null {
    const trimmed = trimToSyntax(context.leaves, statementRange);
    if (trimmed === null) {
        return null;
    }
    const last = context.leaves[trimmed.end - 1]!;
    if (last.channel === "code" && last.raw === ";") {
        return trimToSyntax(context.leaves, {
            start: trimmed.start,
            end: trimmed.end - 1,
        });
    }
    return trimmed;
}

export function createOpaqueStatement(
    context: ParserContext,
    range: LeafRange,
    code: SyntaxDiagnosticCode,
    message: string,
    recovery: Extract<RecoveryAction, "verbatim-node" | "preserve-statement" | "preserve-target">,
    capabilityId: CapabilityIdentity = null
): StatementNode {
    if (isEmptyStatementRange(context, range)) {
        return context.factory.createStatement(range, "empty", null);
    }
    const opaque = createOpaqueWithDiagnostic(
        context,
        range,
        code,
        recovery === "preserve-target" ? "target" : "statement",
        message,
        recovery,
        capabilityId
    );
    return context.factory.createStatement(range, "opaque", opaque);
}

export function parseStatementRange(
    context: ParserContext,
    range: LeafRange
): StatementNode {
    if (isEmptyStatementRange(context, range)) {
        return context.factory.createStatement(range, "empty", null);
    }
    const bodyRange = queryBodyRange(context, range);
    if (bodyRange === null) {
        return createOpaqueStatement(
            context,
            range,
            "SYN_UNSUPPORTED_STATEMENT",
            "Statement contains no parseable query target",
            statementRecovery(context)
        );
    }
    const startsSelect = isCodeWord(context, bodyRange.start, "select");
    const startsWith = isCodeWord(context, bodyRange.start, "with");
    const startsInsert = isCodeWord(context, bodyRange.start, "insert");
    const startsParenthesized =
        context.leaves[bodyRange.start]!.channel === "code" &&
        context.leaves[bodyRange.start]!.raw === "(";
    const unsupported = classifyUnsupportedStatementStart(context, bodyRange);
    if (unsupported?.state === "verbatim") {
        return createOpaqueStatement(
            context,
            range,
            "SYN_UNSUPPORTED_STATEMENT",
            `${context.dialect} ${unsupported.signature.capabilityId} statement is preserved verbatim`,
            "verbatim-node",
            unsupported.signature.capabilityId
        );
    }
    if (
        !startsSelect &&
        !startsWith &&
        !startsParenthesized &&
        !startsInsert &&
        unsupported === null
    ) {
        return createOpaqueStatement(
            context,
            range,
            "SYN_UNSUPPORTED_STATEMENT",
            `${context.dialect} statement ${context.leaves[bodyRange.start]!.raw} is not structured`,
            statementRecovery(context)
        );
    }

    const checkpoint = createParserCheckpoint(context);
    try {
        if (unsupported?.state === "diagnostic") {
            throw new ParserSyntaxError(
                "SYN_UNSUPPORTED_STATEMENT",
                bodyRange,
                `${context.dialect} ${unsupported.signature.capabilityId} statement is recognized but not structured`,
                "statement",
                unsupported.signature.capabilityId
            );
        }
        const query = startsInsert
            ? parseInsertQueryRange(context, bodyRange)
            : parseQueryRange(context, bodyRange);
        return context.factory.createStatement(
            range,
            startsInsert || representsInsertQuery(query) ? "insert-query" : "query",
            query
        );
    } catch (error) {
        rollbackParserCheckpoint(context, checkpoint);
        if (!(error instanceof ParserSyntaxError)) {
            throw error;
        }
        const statement = createOpaqueStatement(
            context,
            range,
            error.code,
            `Statement preserved: ${error.message}`,
            context.mode === "fragment" ? "preserve-target" : "preserve-statement",
            error.capabilityId
        );
        if (
            error.range.start !== range.start ||
            error.range.end !== range.end
        ) {
            addDiagnostic(
                context,
                error.code,
                error.range,
                error.message,
                context.mode === "fragment" ? "preserve-target" : "preserve-statement",
                "warning",
                error.capabilityId
            );
        }
        return statement;
    }
}
