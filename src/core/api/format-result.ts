import type { Diagnostic } from "../diagnostics/diagnostic";
import type { SourceSpan } from "../source/source-span";

export type FormatStatus = "formatted" | "unchanged" | "preserved" | "failed";
export interface SourceMapEntry {
    readonly source: SourceSpan;
    readonly output: SourceSpan;
}
export interface SourceMap {
    readonly entries: readonly SourceMapEntry[];
}
export interface FormatResult {
    readonly status: FormatStatus;
    readonly text: string;
    readonly diagnostics: readonly Diagnostic[];
    readonly sourceMap?: SourceMap;
}
