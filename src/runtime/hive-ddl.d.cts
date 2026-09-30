import type { CommaStyle, Diagnostic, IndentStyle, KeywordCase } from "./sql-formatter.cjs";

export interface HiveDdlFormatOptions {
    readonly keywordCase?: KeywordCase;
    readonly commaStyle?: CommaStyle;
    readonly indentStyle?: IndentStyle;
    /** Integer in the inclusive range 1..500. */
    readonly maxAlignWidth?: number;
}
export type HiveDdlStatus = "formatted" | "unchanged" | "preserved" | "failed";
export interface HiveDdlResult {
    readonly status: HiveDdlStatus;
    readonly source: string;
    readonly text: string;
    readonly diagnostics: readonly Diagnostic[];
}

export interface ExtractDdlOptions {
    /** Bounded Hive type declaration; at most 128 UTF-16 code units. */
    readonly defaultType?: string;
}
export type ExtractDdlStatus = "extracted" | "unsupported" | "ambiguous" | "empty" | "failed";
interface ExtractDdlResultBase<S extends ExtractDdlStatus> {
    readonly status: S;
    readonly source: string;
    readonly text: string;
}
export interface ExtractedDdlResult extends ExtractDdlResultBase<"extracted"> {
    readonly diagnostics: readonly [];
}
interface OriginalTextExtractDdlResult<S extends Exclude<ExtractDdlStatus, "extracted">>
    extends ExtractDdlResultBase<S> {
    readonly diagnostics: readonly [Diagnostic, ...Diagnostic[]];
}
export interface UnsupportedExtractDdlResult extends OriginalTextExtractDdlResult<"unsupported"> {}
export interface AmbiguousExtractDdlResult extends OriginalTextExtractDdlResult<"ambiguous"> {}
export interface EmptyExtractDdlResult extends OriginalTextExtractDdlResult<"empty"> {}
export interface FailedExtractDdlResult extends OriginalTextExtractDdlResult<"failed"> {}
export type NonExtractedDdlResult =
    | UnsupportedExtractDdlResult | AmbiguousExtractDdlResult
    | EmptyExtractDdlResult | FailedExtractDdlResult;
export type ExtractDdlResult = ExtractedDdlResult | NonExtractedDdlResult;

export declare function formatHiveDdl(source: string, options?: HiveDdlFormatOptions): HiveDdlResult;
export declare function extractDdl(source: string, options?: ExtractDdlOptions): ExtractDdlResult;
