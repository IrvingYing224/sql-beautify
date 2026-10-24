import type { Diagnostic } from "../diagnostics/diagnostic";
import { lexSql } from "../lexer/lossless-lexer";
import type { LexOutput } from "../lexer/lossless-lexer";
import { freezeImmutableArray } from "../util/immutable-array";
import { createNodeFactory } from "./node-factory";
import type { ProgramNode, StatementNode, SyntaxNode } from "./node";
import type { LeafRange } from "./leaf-range";
import { createOpaqueWithDiagnostic } from "./recovery";
import {
    addDiagnostic,
    createParserTrialState,
    finalizeDiagnostics,
    nodeFacts,
} from "./parser-context";
import type {
    ParserContext,
    SyntaxDiagnosticCode,
} from "./parser-context";
import type {
    ParseMode,
    ParseOptions,
    ParseOutput,
} from "./parser-backend";
import { parseStatementRange } from "./statement-parser";
import { buildStructuralTokenTable } from "./token-table";
import type { StructuralTokenTable } from "./token-table";
import {
    parseTypeExpressionPrefix,
    type ParsedTypePrefix,
} from "./type-parser";

/**
 * Internal parse product retained for Wave 2 analysis. The public parse result
 * deliberately omits the token table, while analysis consumes this artifact
 * so lexing and token-table construction happen once and analysis consumes
 * only the final trusted CST (recovery may replace an untrusted partial CST).
 */
export interface ParseArtifact {
    readonly source: string;
    readonly mode: ParseMode;
    readonly output: ParseOutput;
    /** Node ids of output.root are exactly [0, nodeCount). */
    readonly nodeCount: number;
    readonly tokenTable: StructuralTokenTable;
    /** Derived while freezing lexer output; avoids a second analysis pre-scan. */
    readonly hasCommentTrivia: boolean;
}

interface ParsedProgram {
    readonly output: ParseOutput;
    readonly nodeCount: number;
}

function createContext(
    mode: ParseOptions["mode"],
    lexed: LexOutput,
    table: StructuralTokenTable,
    diagnostics: Diagnostic[] = Array.from(lexed.diagnostics)
): ParserContext {
    return Object.freeze({
        mode: mode ?? "document",
        leaves: lexed.leaves,
        table,
        factory: createNodeFactory(table),
        diagnostics,
        trialState: createParserTrialState(table.syntaxLeafCount()),
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

function outputOf(context: ParserContext, root: ProgramNode): ParsedProgram {
    return {
        output: Object.freeze({
            root,
            leaves: context.leaves,
            diagnostics: finalizeDiagnostics(context.diagnostics),
        }),
        nodeCount: context.factory.checkpoint(),
    };
}

function targetFallbackOutput(
    mode: ParseOptions["mode"],
    lexed: LexOutput,
    table: StructuralTokenTable,
    code: SyntaxDiagnosticCode,
    message: string
): ParsedProgram {
    const context = createContext(mode, lexed, table);
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
    mode: ParseMode,
    parsed: ParsedProgram,
    tokenTable: StructuralTokenTable,
    hasCommentTrivia: boolean
): ParseArtifact {
    return Object.freeze({
        source,
        mode,
        output: parsed.output,
        nodeCount: parsed.nodeCount,
        tokenTable,
        hasCommentTrivia,
    });
}

export function parseSqlArtifact(
    source: string,
    options: ParseOptions = {}
): ParseArtifact {
    const mode = options.mode ?? "document";
    const rawLexed = lexSql(source);
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
            mode,
            targetFallbackOutput(
                mode,
                lexed,
                table,
                "SYN_UNEXPECTED_TOKEN",
                "Lexical error prevents safe CST construction"
            ),
            table,
            hasCommentTrivia
        );
    }
    if (!table.statementBoundariesReliable()) {
        return artifactOf(
            source,
            mode,
            targetFallbackOutput(
                mode,
                lexed,
                table,
                "SYN_UNMATCHED_DELIMITER",
                "Unreliable delimiter structure prevents safe statement parsing"
            ),
            table,
            hasCommentTrivia
        );
    }
    if (mode !== "document" && table.statementRanges().length > 1) {
        return artifactOf(
            source,
            mode,
            targetFallbackOutput(
                mode,
                lexed,
                table,
                "SYN_UNEXPECTED_TOKEN",
                `${mode} mode requires exactly one complete target`
            ),
            table,
            hasCommentTrivia
        );
    }
    try {
        const context = createContext(mode, lexed, table);
        const root = buildProgram(context);
        if (mode === "fragment" && programContainsOpaque(root)) {
            return artifactOf(
                source,
                mode,
                targetFallbackOutput(
                    mode,
                    lexed,
                    table,
                    "SYN_UNMODELED_CONSTRUCT",
                    "Fragment target could not be fully structured"
                ),
                table,
                hasCommentTrivia
            );
        }
        return artifactOf(
            source,
            mode,
            outputOf(context, root),
            table,
            hasCommentTrivia
        );
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return artifactOf(
            source,
            mode,
            targetFallbackOutput(
                mode,
                lexed,
                table,
                "SYN_INTERNAL_INVARIANT",
                `Parser internal failure: ${message}`
            ),
            table,
            hasCommentTrivia
        );
    }
}

/**
 * Runs the canonical bounded type parser over an existing parse artifact.
 * Experimental consumers reuse this seam instead of implementing angle-depth
 * or complex-type parsing outside the core syntax layer.
 */
export function parseTypePrefixFromArtifact(
    artifact: ParseArtifact,
    range: LeafRange,
    nestingDepth: number = 0
): ParsedTypePrefix {
    const lexed: LexOutput = Object.freeze({
        leaves: artifact.output.leaves,
        diagnostics: artifact.output.diagnostics,
    });
    const context = createContext(
        artifact.mode,
        lexed,
        artifact.tokenTable,
        []
    );
    return parseTypeExpressionPrefix(context, range, nestingDepth);
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
    const lexed: LexOutput = Object.freeze({
        leaves: artifact.output.leaves,
        diagnostics: artifact.output.diagnostics,
    });
    return artifactOf(
        artifact.source,
        artifact.mode,
        targetFallbackOutput(
            artifact.mode,
            lexed,
            artifact.tokenTable,
            "SYN_INTERNAL_INVARIANT",
            message
        ),
        artifact.tokenTable,
        artifact.hasCommentTrivia
    );
}
