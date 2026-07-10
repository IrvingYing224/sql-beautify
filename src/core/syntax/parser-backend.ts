import type { Dialect } from "../config/options";
import type { Diagnostic } from "../diagnostics/diagnostic";
import type { SourceLeaf } from "../lexer/token";
import type { SyntaxNode } from "./node";

export type ParseMode = "document" | "statement" | "fragment";
export interface ParseInput {
    readonly source: string;
    readonly dialect: Dialect;
    readonly mode: ParseMode;
}
export interface ParseOutput {
    readonly root: SyntaxNode;
    readonly leaves: readonly SourceLeaf[];
    readonly diagnostics: readonly Diagnostic[];
}
export interface ParserBackend {
    readonly id: string;
    readonly version: string;
    parse(input: ParseInput): ParseOutput;
}
