import type { Dialect } from "../config/options";
import type { Diagnostic } from "../diagnostics/diagnostic";
import { lexSql } from "../lexer/lossless-lexer";
import type { LexOutput } from "../lexer/lossless-lexer";
import { getDialect } from "../dialects/registry";
import { freezeImmutableArray } from "../util/immutable-array";
import { createParserNodeFactory } from "./node-factory";
import type { ProgramNode, StatementNode, SyntaxNode } from "./node";
import { createOpaqueWithDiagnostic } from "./recovery";
import {
    addDiagnostic,
    finalizeDiagnostics,
    nodeFacts,
} from "./parser-context";
import type {
    ParserContext,
    SyntaxDiagnosticCode,
} from "./parser-context";
import type {
    ParseInput,
    ParseMode,
    ParseOptions,
    ParseOutput,
    ParserBackend,
} from "./parser-backend";
import { parseStatementRange } from "./statement-parser";
import { buildStructuralTokenTable } from "./token-table";
import type { StructuralTokenTable } from "./token-table";
import { validateSyntaxInvariants } from "./invariants";

const BACKEND_ID = "sql-beautify-v2";
const BACKEND_VERSION = "2e";
const CANONICAL_PARSE_ARTIFACTS = new WeakSet<object>();
const CANONICAL_PARSE_MODE_BY_ROOT = new WeakMap<object, ParseMode>();

/**
 * Internal parse product retained for Wave 2 analysis. The public parse result
 * deliberately omits the token table, while analysis consumes this artifact
 * so lexing and token-table construction happen once and analysis consumes
 * only the final trusted CST (recovery may replace an untrusted partial CST).
 */
export interface ParseArtifact {
    readonly source: string;
    readonly dialect: Dialect;
    readonly mode: ParseMode;
    readonly output: ParseOutput;
    readonly tokenTable: StructuralTokenTable;
    /** Derived while freezing lexer output; avoids a second analysis pre-scan. */
    readonly hasCommentTrivia: boolean;
}

/** Internal provenance check for exact immutable artifacts created by this parser. */
export function isCanonicalParseArtifact(value: unknown): value is ParseArtifact {
    return (
        typeof value === "object" &&
        value !== null &&
        CANONICAL_PARSE_ARTIFACTS.has(value)
    );
}

/** Internal provenance for the parse mode that produced a canonical root. */
export function canonicalParseModeForRoot(value: unknown): ParseMode | null {
    if (typeof value !== "object" || value === null) {
        return null;
    }
    return CANONICAL_PARSE_MODE_BY_ROOT.get(value) ?? null;
}

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
        factory: createParserNodeFactory(table, dialect),
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
        statements,
        nodeFacts(
            statements.length > 1 ? "multi-statement" : null,
            statements.length > 1 ? "capability" : "intrinsic-container"
        )
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
        return context.factory.createProgram(
            fullRange,
            [],
            nodeFacts(null, "intrinsic-container")
        );
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
        opaque,
        nodeFacts(null, "intrinsic-container")
    );
    return context.factory.createProgram(
        fullRange,
        [statement],
        nodeFacts(null, "intrinsic-container")
    );
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

function artifactOf(
    source: string,
    dialect: Dialect,
    mode: ParseMode,
    output: ParseOutput,
    tokenTable: StructuralTokenTable,
    hasCommentTrivia: boolean,
    canonical: boolean
): ParseArtifact {
    const artifact = Object.freeze({
        source,
        dialect,
        mode,
        output,
        tokenTable,
        hasCommentTrivia,
    });
    if (canonical) {
        CANONICAL_PARSE_ARTIFACTS.add(artifact);
        CANONICAL_PARSE_MODE_BY_ROOT.set(output.root, mode);
    }
    return artifact;
}

export function parseSqlArtifact(
    source: string,
    options: ParseOptions = {}
): ParseArtifact {
    const dialect = options.dialect ?? "hive";
    const mode = options.mode ?? "document";
    getDialect(dialect);
    const rawLexed = lexSql(source, { dialect });
    let hasCommentTrivia = false;
    for (const leaf of rawLexed.leaves) {
        if (leaf.kind === "line-comment" || leaf.kind === "block-comment") {
            hasCommentTrivia = true;
            break;
        }
    }
    const lexed: LexOutput = Object.freeze({
        leaves: rawLexed.leaves,
        diagnostics: freezeImmutableArray(rawLexed.diagnostics),
    });
    const table = buildStructuralTokenTable(lexed.leaves, source);

    if (hasFatalLexicalDiagnostic(lexed)) {
        return artifactOf(
            source,
            dialect,
            mode,
            targetFallbackOutput(
                dialect,
                mode,
                lexed,
                table,
                "SYN_UNEXPECTED_TOKEN",
                "Lexical error prevents safe CST construction"
            ),
            table,
            hasCommentTrivia,
            true
        );
    }
    if (!table.statementBoundariesReliable()) {
        return artifactOf(
            source,
            dialect,
            mode,
            targetFallbackOutput(
                dialect,
                mode,
                lexed,
                table,
                "SYN_UNMATCHED_DELIMITER",
                "Unreliable delimiter structure prevents safe statement parsing"
            ),
            table,
            hasCommentTrivia,
            true
        );
    }
    if (mode !== "document" && table.statementRanges().length > 1) {
        return artifactOf(
            source,
            dialect,
            mode,
            targetFallbackOutput(
                dialect,
                mode,
                lexed,
                table,
                "SYN_UNEXPECTED_TOKEN",
                `${mode} mode requires exactly one complete target`
            ),
            table,
            hasCommentTrivia,
            true
        );
    }
    try {
        const context = createContext(dialect, mode, lexed, table);
        const root = buildProgram(context);
        if (mode === "fragment" && programContainsOpaque(root)) {
            return artifactOf(
                source,
                dialect,
                mode,
                targetFallbackOutput(
                    dialect,
                    mode,
                    lexed,
                    table,
                    "SYN_UNMODELED_CONSTRUCT",
                    "Fragment target could not be fully structured"
                ),
                table,
                hasCommentTrivia,
                true
            );
        }
        const invariant = validateSyntaxInvariants({
            root,
            leaves: lexed.leaves,
            source,
            dialect,
            tokenTable: table,
        });
        if (!invariant.ok) {
            const codes = Array.from(new Set(invariant.failures.map((failure) => failure.code)))
                .slice(0, 8)
                .join(", ");
            return artifactOf(
                source,
                dialect,
                mode,
                targetFallbackOutput(
                    dialect,
                    mode,
                    lexed,
                    table,
                    "SYN_INTERNAL_INVARIANT",
                    `CST invariant validation failed: ${codes}`
                ),
                table,
                hasCommentTrivia,
                true
            );
        }
        return artifactOf(
            source,
            dialect,
            mode,
            outputOf(context, root),
            table,
            hasCommentTrivia,
            true
        );
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return artifactOf(
            source,
            dialect,
            mode,
            targetFallbackOutput(
                dialect,
                mode,
                lexed,
                table,
                "SYN_INTERNAL_INVARIANT",
                `Parser internal failure: ${message}`
            ),
            table,
            hasCommentTrivia,
            true
        );
    }
}

export function parseSql(source: string, options: ParseOptions = {}): ParseOutput {
    return parseSqlArtifact(source, options).output;
}

/**
 * Replaces an internal artifact with a target-preserving CST without lexing or
 * rebuilding its structural token table. Analysis uses this only when its own
 * invariants fail, so downstream stages never receive a partially trusted
 * structural index.
 */
export function preserveParseArtifactTarget(
    artifact: ParseArtifact,
    message: string
): ParseArtifact {
    const preserveCanonicalTrust = isCanonicalParseArtifact(artifact);
    const lexed: LexOutput = Object.freeze({
        leaves: artifact.output.leaves,
        diagnostics: artifact.output.diagnostics,
    });
    return artifactOf(
        artifact.source,
        artifact.dialect,
        artifact.mode,
        targetFallbackOutput(
            artifact.dialect,
            artifact.mode,
            lexed,
            artifact.tokenTable,
            "SYN_INTERNAL_INVARIANT",
            message
        ),
        artifact.tokenTable,
        artifact.hasCommentTrivia,
        preserveCanonicalTrust
    );
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
