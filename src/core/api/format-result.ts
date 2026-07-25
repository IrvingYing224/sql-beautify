import type { Diagnostic } from "../diagnostics/diagnostic";
import type { SourceMap } from "../source/source-map";

export type { SourceMap, SourceMapEntry } from "../source/source-map";

export type FormatStatus = "formatted" | "unchanged" | "preserved" | "failed";
interface FormatResultBase<S extends FormatStatus> {
    readonly status: S;
    readonly text: string;
    readonly diagnostics: readonly Diagnostic[];
}

export interface FormattedFormatResult
    extends FormatResultBase<"formatted"> {
    readonly sourceMap: SourceMap;
}

export interface UnchangedFormatResult
    extends FormatResultBase<"unchanged"> {
    readonly sourceMap: SourceMap;
}

export interface PreservedFormatResult
    extends FormatResultBase<"preserved"> {
    readonly sourceMap?: never;
}

export interface FailedFormatResult
    extends FormatResultBase<"failed"> {
    readonly sourceMap?: never;
}

export type SafeFormatResult =
    | FormattedFormatResult
    | UnchangedFormatResult;

export type OriginalTextFormatResult =
    | PreservedFormatResult
    | FailedFormatResult;

export type FormatResult = SafeFormatResult | OriginalTextFormatResult;
