import type { Dialect } from "../config/options";
import type { Diagnostic } from "../diagnostics/diagnostic";
import { lexSql } from "../lexer/lossless-lexer";
import type { LexOutput } from "../lexer/lossless-lexer";
import { getDialect } from "../dialects/registry";
import { freezeImmutableArray } from "../util/immutable-array";
import { createNodeFactory } from "./node-factory";
import type { ProgramNode, StatementNode } from "./node";
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
import { createOpaqueStatement, parseStatementRange } from "./statement-parser";
import { buildStructuralTokenTable } from "./token-table";
import type { StructuralTokenTable } from "./token-table";
import { validateSyntaxInvariants } from "./invariants";

const BACKEND_ID = "sql-beautify-v2";
const BACKEND_VERSION = "2b";

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

function buildProgram(
    context: ParserContext,
    parseStatements: boolean,
    fallbackCode?: SyntaxDiagnosticCode,
    fallbackMessage?: string,
    fallbackRecovery: "preserve-statement" | "preserve-target" = "preserve-target"
): ProgramNode {
    const statements: StatementNode[] = [];
    for (const range of context.table.statementRanges()) {
        if (parseStatements) {
            statements.push(parseStatementRange(context, range));
        } else {
            statements.push(
                createOpaqueStatement(
                    context,
                    range,
                    fallbackCode ?? "SYN_INTERNAL_INVARIANT",
                    fallbackMessage ?? "Parser target was preserved",
                    fallbackRecovery
                )
            );
        }
    }
    return context.factory.createProgram(
        { start: 0, end: context.leaves.length },
        statements
    );
}

function outputOf(context: ParserContext, root: ProgramNode): ParseOutput {
    return Object.freeze({
        root,
        leaves: context.leaves,
        diagnostics: finalizeDiagnostics(context.diagnostics),
    });
}

function fallbackOutput(
    dialect: Dialect,
    mode: ParseOptions["mode"],
    lexed: LexOutput,
    table: StructuralTokenTable,
    code: SyntaxDiagnosticCode,
    message: string,
    recovery: "preserve-statement" | "preserve-target"
): ParseOutput {
    const context = createContext(dialect, mode, lexed, table);
    const diagnosticCount = context.diagnostics.length;
    const root = buildProgram(context, false, code, message, recovery);
    if (
        context.diagnostics.length === diagnosticCount &&
        table.syntaxLeafCount() > 0
    ) {
        addDiagnostic(
            context,
            code,
            { start: 0, end: lexed.leaves.length },
            message,
            recovery
        );
    }
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
        return fallbackOutput(
            dialect,
            mode,
            lexed,
            table,
            "SYN_UNEXPECTED_TOKEN",
            "Lexical error prevents safe CST construction",
            "preserve-target"
        );
    }
    if (!table.statementBoundariesReliable()) {
        return fallbackOutput(
            dialect,
            mode,
            lexed,
            table,
            "SYN_UNMATCHED_DELIMITER",
            "Unreliable delimiter structure prevents safe statement parsing",
            "preserve-target"
        );
    }
    if (mode !== "document" && table.statementRanges().length > 1) {
        return fallbackOutput(
            dialect,
            mode,
            lexed,
            table,
            "SYN_UNEXPECTED_TOKEN",
            `${mode} mode requires exactly one complete target`,
            "preserve-target"
        );
    }
    if (dialect !== "hive") {
        return fallbackOutput(
            dialect,
            mode,
            lexed,
            table,
            "SYN_UNSUPPORTED_STATEMENT",
            `Wave 2B structures Hive queries only; ${dialect} remains recognized`,
            "preserve-target"
        );
    }

    try {
        const context = createContext(dialect, mode, lexed, table);
        const root = buildProgram(context, true);
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
            return fallbackOutput(
                dialect,
                mode,
                lexed,
                table,
                "SYN_INTERNAL_INVARIANT",
                `CST invariant validation failed: ${codes}`,
                "preserve-target"
            );
        }
        return outputOf(context, root);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return fallbackOutput(
            dialect,
            mode,
            lexed,
            table,
            "SYN_INTERNAL_INVARIANT",
            `Parser internal failure: ${message}`,
            "preserve-target"
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
