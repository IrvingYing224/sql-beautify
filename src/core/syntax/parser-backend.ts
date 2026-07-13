import type { Dialect } from "../config/options";
import type { Diagnostic } from "../diagnostics/diagnostic";
import type { SourceLeaf } from "../lexer/token";
import type { ProgramNode } from "./node";

export type ParseMode = "document" | "statement" | "fragment";
export interface ParseInput {
    readonly source: string;
    readonly dialect: Dialect;
    readonly mode: ParseMode;
}
/**
 * ParseOutput.root is a ProgramNode. Wave 2A/2B invariants and document mode
 * require program roots; fragment roots remain a later design decision and are
 * not modeled as a divergent unvalidated root type here.
 */
export interface ParseOutput {
    readonly root: ProgramNode;
    readonly leaves: readonly SourceLeaf[];
    readonly diagnostics: readonly Diagnostic[];
}
export interface ParserBackend {
    readonly id: string;
    readonly version: string;
    parse(input: ParseInput): ParseOutput;
}
