import type { CommaStyle, IndentStyle, KeywordCase } from "../core/config/options";
import type { Diagnostic } from "../core/diagnostics/diagnostic";
import type { RenderNewline, RenderTabSize } from "../core/renderer/environment";

export type HiveDdlStatus = "formatted" | "unchanged" | "preserved" | "failed";

export type ExtractDdlStatus = "extracted" | "unsupported" | "ambiguous" | "empty" | "failed";

export interface HiveDdlFormatOptions {
    readonly keywordCase?: KeywordCase;
    readonly commaStyle?: CommaStyle;
    readonly indentStyle?: IndentStyle;
    readonly maxAlignWidth?: number;
}

export interface ExtractDdlOptions {
    readonly defaultType?: string;
}

/**
 * Where the output lines go: the first line starts with `firstIndent`, every later line with
 * `indent`, and lines are joined with `newline`. Alignment counts columns from the width of `indent`.
 */
export interface DdlLayout {
    readonly newline: RenderNewline;
    readonly tabSize: RenderTabSize;
    readonly firstIndent: string;
    readonly indent: string;
}

export interface DdlResult<S extends string> {
    readonly status: S;
    /** The laid-out output when formatted or extracted, otherwise the source. */
    readonly text: string;
    readonly diagnostics: readonly Diagnostic[];
}

export interface HiveDdlResult extends DdlResult<HiveDdlStatus> {
    /** Ids of the source leaves whose case the output may change (the source's lexer leaves). */
    readonly recased: readonly number[];
}

export type ExtractDdlResult = DdlResult<ExtractDdlStatus>;
