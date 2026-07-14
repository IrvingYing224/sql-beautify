import type { LeafRange } from "./leaf-range";
import type { QueryNode, StatementNode } from "./node";
import {
    ParserSyntaxError,
    addDiagnostic,
    createOpaqueWithDiagnostic,
    isCodeWord,
    isSyntaxLeaf,
    trimToSyntax,
} from "./parser-context";
import type { ParserContext, SyntaxDiagnosticCode } from "./parser-context";
import { parseInsertQueryRange, parseQueryRange } from "./query-parser";

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
    recovery: "preserve-statement" | "preserve-target"
): StatementNode {
    if (isEmptyStatementRange(context, range)) {
        return context.factory.createStatement(range, "empty", null);
    }
    const opaque = createOpaqueWithDiagnostic(
        context,
        range,
        code,
        "statement",
        message,
        recovery
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
    if (
        !startsSelect &&
        !startsWith &&
        !startsParenthesized &&
        !startsInsert
    ) {
        return createOpaqueStatement(
            context,
            range,
            "SYN_UNSUPPORTED_STATEMENT",
            `Hive statement ${context.leaves[bodyRange.start]!.raw} is not modeled in Wave 2B`,
            statementRecovery(context)
        );
    }

    const factoryCheckpoint = context.factory.checkpoint();
    const diagnosticCheckpoint = context.diagnostics.length;
    try {
        const query = startsInsert
            ? parseInsertQueryRange(context, bodyRange)
            : parseQueryRange(context, bodyRange);
        return context.factory.createStatement(
            range,
            startsInsert || representsInsertQuery(query) ? "insert-query" : "query",
            query
        );
    } catch (error) {
        context.factory.rollback(factoryCheckpoint);
        context.diagnostics.length = diagnosticCheckpoint;
        if (!(error instanceof ParserSyntaxError)) {
            throw error;
        }
        const statement = createOpaqueStatement(
            context,
            range,
            error.code,
            `Statement preserved: ${error.message}`,
            context.mode === "fragment" || error.recovery === "preserve-target"
                ? "preserve-target"
                : "preserve-statement"
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
                context.mode === "fragment" ? "preserve-target" : error.recovery,
                "warning"
            );
        }
        return statement;
    }
}
