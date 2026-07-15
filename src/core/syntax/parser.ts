import type { Dialect } from "../config/options";
import type { Diagnostic } from "../diagnostics/diagnostic";
import { lexSql } from "../lexer/lossless-lexer";
import type { LexOutput } from "../lexer/lossless-lexer";
import { getDialect } from "../dialects/registry";
import { freezeImmutableArray } from "../util/immutable-array";
import { createNodeFactory } from "./node-factory";
import type { ProgramNode, StatementNode, SyntaxNode } from "./node";
import { createOpaqueWithDiagnostic } from "./recovery";
import {
    addDiagnostic,
    finalizeDiagnostics,
} from "./parser-context";
import type {
    ParserContext,
    SyntaxDiagnosticCode,
} from "./parser-context";
import type {
    ParseInput,
    ParseOptions,
    ParseOutput,
    ParserBackend,
} from "./parser-backend";
import { parseStatementRange } from "./statement-parser";
import { buildStructuralTokenTable } from "./token-table";
import type { StructuralTokenTable } from "./token-table";
import { validateSyntaxInvariants } from "./invariants";

const BACKEND_ID = "sql-beautify-v2";
const BACKEND_VERSION = "2d";

function createContext(
    dialect: Dialect,
    mode: ParseOptions["mode"],
    lexed: LexOutput,
    table: StructuralTokenTable,
    diagnostics: Diagnostic[] = Array.from(lexed.diagnostics)
): ParserContext {
    return Object.freeze({
        dialect,
        mode: mode ?? "document",
        leaves: lexed.leaves,
        table,
        factory: createNodeFactory(table),
        diagnostics,
    });
}

function buildProgram(context: ParserContext): ProgramNode {
    const statements: StatementNode[] = [];
    for (const range of context.table.statementRanges()) {
        statements.push(parseStatementRange(context, range));
    }
    return context.factory.createProgram(
        { start: 0, end: context.leaves.length },
        statements
    );
}

function programContainsOpaque(root: ProgramNode): boolean {
    const work: SyntaxNode[] = [root];
    while (work.length > 0) {
        const node = work.pop()!;
        if (node.kind === "opaque") {
            return true;
        }
        for (const child of node.children) {
            work.push(child);
        }
    }
    return false;
}

function buildTargetPreservingProgram(
    context: ParserContext,
    code: SyntaxDiagnosticCode,
    message: string
): ProgramNode {
    const fullRange = Object.freeze({ start: 0, end: context.leaves.length });
    if (context.leaves.length === 0) {
        addDiagnostic(context, code, fullRange, message, "preserve-target");
        return context.factory.createProgram(fullRange, []);
    }
    const opaque = createOpaqueWithDiagnostic(
        context,
        fullRange,
        code,
        "target",
        message,
        "preserve-target"
    );
    const statement = context.factory.createStatement(
        fullRange,
        "opaque",
        opaque
    );
    return context.factory.createProgram(fullRange, [statement]);
}

function outputOf(context: ParserContext, root: ProgramNode): ParseOutput {
    return Object.freeze({
        root,
        leaves: context.leaves,
        diagnostics: finalizeDiagnostics(context.diagnostics),
    });
}

function targetFallbackOutput(
    dialect: Dialect,
    mode: ParseOptions["mode"],
    lexed: LexOutput,
    table: StructuralTokenTable,
    code: SyntaxDiagnosticCode,
    message: string
): ParseOutput {
    const context = createContext(dialect, mode, lexed, table);
    const root = buildTargetPreservingProgram(context, code, message);
    return outputOf(context, root);
}

function hasFatalLexicalDiagnostic(lexed: LexOutput): boolean {
    return lexed.diagnostics.some(
        (diagnostic) =>
            diagnostic.severity === "error" && diagnostic.recovery === "preserve-target"
    );
}

export function parseSql(source: string, options: ParseOptions = {}): ParseOutput {
    const dialect = options.dialect ?? "hive";
    const mode = options.mode ?? "document";
    getDialect(dialect);
    const rawLexed = lexSql(source, { dialect });
    const lexed: LexOutput = Object.freeze({
        leaves: freezeImmutableArray(rawLexed.leaves),
        diagnostics: freezeImmutableArray(rawLexed.diagnostics),
    });
    const table = buildStructuralTokenTable(lexed.leaves, source);

    if (hasFatalLexicalDiagnostic(lexed)) {
        return targetFallbackOutput(
            dialect,
            mode,
            lexed,
            table,
            "SYN_UNEXPECTED_TOKEN",
            "Lexical error prevents safe CST construction"
        );
    }
    if (!table.statementBoundariesReliable()) {
        return targetFallbackOutput(
            dialect,
            mode,
            lexed,
            table,
            "SYN_UNMATCHED_DELIMITER",
            "Unreliable delimiter structure prevents safe statement parsing"
        );
    }
    if (mode !== "document" && table.statementRanges().length > 1) {
        return targetFallbackOutput(
            dialect,
            mode,
            lexed,
            table,
            "SYN_UNEXPECTED_TOKEN",
            `${mode} mode requires exactly one complete target`
        );
    }
    try {
        const context = createContext(dialect, mode, lexed, table);
        const root = buildProgram(context);
        if (mode === "fragment" && programContainsOpaque(root)) {
            return targetFallbackOutput(
                dialect,
                mode,
                lexed,
                table,
                "SYN_UNMODELED_CONSTRUCT",
                "Fragment target could not be fully structured"
            );
        }
        const invariant = validateSyntaxInvariants({
            root,
            leaves: lexed.leaves,
            source,
            tokenTable: table,
        });
        if (!invariant.ok) {
            const codes = Array.from(new Set(invariant.failures.map((failure) => failure.code)))
                .slice(0, 8)
                .join(", ");
            return targetFallbackOutput(
                dialect,
                mode,
                lexed,
                table,
                "SYN_INTERNAL_INVARIANT",
                `CST invariant validation failed: ${codes}`
            );
        }
        return outputOf(context, root);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return targetFallbackOutput(
            dialect,
            mode,
            lexed,
            table,
            "SYN_INTERNAL_INVARIANT",
            `Parser internal failure: ${message}`
        );
    }
}

export const parserBackend: ParserBackend = Object.freeze({
    id: BACKEND_ID,
    version: BACKEND_VERSION,
    parse(input: ParseInput): ParseOutput {
        return parseSql(input.source, {
            dialect: input.dialect,
            mode: input.mode,
        });
    },
});
