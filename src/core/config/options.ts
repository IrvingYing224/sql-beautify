export type Dialect = "hive" | "generic" | "postgresql" | "mysql";
export type KeywordCase = "upper" | "lower";
export type CommaStyle = "leading" | "trailing";
export type IndentStyle = "space" | "tab";
export type CaseLayout = "expanded" | "compactShort";
export type UnsupportedSyntaxPolicy = "warn" | "preserve" | "bail_out";

export interface CanonicalFormatOptions {
    readonly dialect: Dialect;
    readonly keywordCase: KeywordCase;
    readonly commaStyle: CommaStyle;
    readonly indentStyle: IndentStyle;
    readonly maxAlignWidth: number;
    readonly caseWhenThenWrapLength: number;
    readonly caseLayout: CaseLayout;
    readonly unsupportedSyntaxPolicy: UnsupportedSyntaxPolicy;
}

export type FormatOptions = Readonly<Partial<CanonicalFormatOptions>>;
