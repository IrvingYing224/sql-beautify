import type { Diagnostic } from "../../core/diagnostics/diagnostic";

export type HiveDdlStatus = "formatted" | "unchanged" | "preserved" | "failed";

export interface HiveDdlResult {
    readonly status: HiveDdlStatus;
    readonly source: string;
    readonly text: string;
    readonly diagnostics: readonly Diagnostic[];
}

export type ExtractDdlStatus =
    | "extracted"
    | "unsupported"
    | "ambiguous"
    | "empty"
    | "failed";

export interface ExtractDdlOptions {
    readonly defaultType?: string;
}

interface ExtractDdlResultBase<S extends ExtractDdlStatus> {
    readonly status: S;
    readonly source: string;
    readonly text: string;
}

export interface ExtractedDdlResult
    extends ExtractDdlResultBase<"extracted"> {
    readonly diagnostics: readonly [];
}

interface OriginalTextExtractDdlResult<S extends Exclude<ExtractDdlStatus, "extracted">>
    extends ExtractDdlResultBase<S> {
    readonly diagnostics: readonly [Diagnostic, ...Diagnostic[]];
}

export interface UnsupportedExtractDdlResult
    extends OriginalTextExtractDdlResult<"unsupported"> {}

export interface AmbiguousExtractDdlResult
    extends OriginalTextExtractDdlResult<"ambiguous"> {}

export interface EmptyExtractDdlResult
    extends OriginalTextExtractDdlResult<"empty"> {}

export interface FailedExtractDdlResult
    extends OriginalTextExtractDdlResult<"failed"> {}

export type NonExtractedDdlResult =
    | UnsupportedExtractDdlResult
    | AmbiguousExtractDdlResult
    | EmptyExtractDdlResult
    | FailedExtractDdlResult;

export type ExtractDdlResult = ExtractedDdlResult | NonExtractedDdlResult;
