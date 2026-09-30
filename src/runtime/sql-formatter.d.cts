/** Public value API; parser, layout and execution internals are not exported. */
export type Dialect = "hive" | "generic" | "postgresql" | "mysql";
export type KeywordCase = "upper" | "lower";
export type CommaStyle = "leading" | "trailing";
export type IndentStyle = "space" | "tab";
export type CaseLayout = "expanded" | "compactShort";
export type UnsupportedSyntaxPolicy = "warn" | "preserve" | "bail_out";

export interface FormatOptions {
    readonly dialect?: Dialect;
    readonly keywordCase?: KeywordCase;
    readonly commaStyle?: CommaStyle;
    readonly indentStyle?: IndentStyle;
    /** Integer in the inclusive range 1..500. */
    readonly maxAlignWidth?: number;
    /** Integer in the inclusive range 1..300. */
    readonly caseWhenThenWrapLength?: number;
    readonly caseLayout?: CaseLayout;
    readonly unsupportedSyntaxPolicy?: UnsupportedSyntaxPolicy;
}

/** Half-open offsets measured in JavaScript UTF-16 code units. */
export interface SourceSpan {
    readonly start: number;
    readonly end: number;
}

export type DiagnosticSeverity = "info" | "warning" | "error";
export type RecoveryAction = "none" | "verbatim-node" | "preserve-statement" | "preserve-target";
export type CapabilityIdentity = string | null;

export interface Diagnostic {
    readonly code: string;
    readonly severity: DiagnosticSeverity;
    readonly message: string;
    readonly capabilityId: CapabilityIdentity;
    readonly span: SourceSpan;
    readonly recovery: RecoveryAction;
}

export interface SourceMapEntry {
    readonly source: SourceSpan;
    readonly output: SourceSpan;
}

/** Only source-derived output is mapped; generated whitespace is unmapped. */
export interface SourceMap {
    readonly entries: readonly SourceMapEntry[];
}

export type FormatStatus = "formatted" | "unchanged" | "preserved" | "failed";
interface FormatResultBase<S extends FormatStatus> {
    readonly status: S;
    readonly text: string;
    readonly diagnostics: readonly Diagnostic[];
}

export interface FormattedFormatResult extends FormatResultBase<"formatted"> {
    readonly sourceMap: SourceMap;
}
export interface UnchangedFormatResult extends FormatResultBase<"unchanged"> {
    readonly sourceMap: SourceMap;
}
export interface PreservedFormatResult extends FormatResultBase<"preserved"> {
    readonly sourceMap?: never;
}
export interface FailedFormatResult extends FormatResultBase<"failed"> {
    readonly sourceMap?: never;
}
export type SafeFormatResult = FormattedFormatResult | UnchangedFormatResult;
export type OriginalTextFormatResult = PreservedFormatResult | FailedFormatResult;
export type FormatResult = SafeFormatResult | OriginalTextFormatResult;

export type TokenChannel = "code" | "trivia" | "protected";
export type TokenKind =
    | "keyword" | "identifier" | "quoted-identifier" | "number" | "string"
    | "parameter" | "operator" | "punctuation" | "line-comment" | "block-comment"
    | "byte-order-mark" | "whitespace" | "newline" | "unknown";

export interface SourceLeaf {
    readonly id: number;
    readonly kind: TokenKind;
    readonly channel: TokenChannel;
    readonly raw: string;
    readonly span: SourceSpan;
}
export interface LexOptions {
    readonly dialect?: Dialect;
}
export interface LexOutput {
    readonly leaves: readonly SourceLeaf[];
    readonly diagnostics: readonly Diagnostic[];
}

export declare function formatSql(source: string, options?: FormatOptions): FormatResult;
export declare function lexSql(source: string, options?: LexOptions): LexOutput;
