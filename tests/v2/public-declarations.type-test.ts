import * as publishedFormatter from "../../src/runtime/sql-formatter.cjs";
import * as publishedDdl from "../../src/runtime/hive-ddl.cjs";
import type * as formatterImplementation from "../../src/runtime/index";
import type * as ddlImplementation from "../../src/runtime/experimental-ddl";

type Assert<T extends true> = T;
type Equivalent<A, B> = [A] extends [B] ? [B] extends [A] ? true : false : false;
type FunctionShape<F extends (...args: never[]) => unknown> = {
    parameters: Parameters<F>;
    result: ReturnType<F>;
};

export type FormatterValuesMatch = Assert<Equivalent<
    keyof typeof publishedFormatter, keyof typeof formatterImplementation
>>;
export type DdlValuesMatch = Assert<Equivalent<
    keyof typeof publishedDdl, keyof typeof ddlImplementation
>>;
export type FormatSqlMatches = Assert<Equivalent<
    FunctionShape<typeof publishedFormatter.formatSql>,
    FunctionShape<typeof formatterImplementation.formatSql>
>>;
export type LexSqlMatches = Assert<Equivalent<
    FunctionShape<typeof publishedFormatter.lexSql>,
    FunctionShape<typeof formatterImplementation.lexSql>
>>;
export type FormatHiveDdlMatches = Assert<Equivalent<
    FunctionShape<typeof publishedDdl.formatHiveDdl>,
    FunctionShape<typeof ddlImplementation.formatHiveDdl>
>>;
export type ExtractDdlMatches = Assert<Equivalent<
    FunctionShape<typeof publishedDdl.extractDdl>,
    FunctionShape<typeof ddlImplementation.extractDdl>
>>;

publishedFormatter.formatSql("select 1", { dialect: "postgresql", commaStyle: "trailing" });
publishedFormatter.lexSql("select 1", { dialect: "hive" });
publishedDdl.formatHiveDdl("create table t (id int)", { indentStyle: "tab" });
publishedDdl.extractDdl("select id from t", { defaultType: "BIGINT" });

// @ts-expect-error The legacy dialect alias is not supported.
publishedFormatter.formatSql("select 1", { dialect: "postgres" });
// @ts-expect-error Unknown options are rejected.
publishedFormatter.formatSql("select 1", { tabSize: 4 });
// @ts-expect-error Target parse modes are internal.
publishedFormatter.formatSql("select 1", {}, "fragment");
// @ts-expect-error Supplied undefined properties are not default values.
publishedFormatter.formatSql("select 1", { dialect: undefined });
// @ts-expect-error Null is not an options object.
publishedDdl.formatHiveDdl("create table t (id int)", null);
// @ts-expect-error DDL formatting exposes only its own option subset.
publishedDdl.formatHiveDdl("create table t (id int)", { dialect: "hive" });
// @ts-expect-error Extract DDL does not expose formatter layout settings.
publishedDdl.extractDdl("select id from t", { commaStyle: "leading" });
// @ts-expect-error The lexer only accepts dialect configuration.
publishedFormatter.lexSql("select 1", { keywordCase: "upper" });
// @ts-expect-error Parser internals are not part of the facade.
publishedFormatter.parseSql("select 1");

export function checkFormatResult(result: publishedFormatter.FormatResult): void {
    if (result.status === "formatted" || result.status === "unchanged") {
        const entries: readonly publishedFormatter.SourceMapEntry[] = result.sourceMap.entries;
        void entries;
        // @ts-expect-error Returned maps are immutable.
        result.sourceMap.entries.push({ source: { start: 0, end: 1 }, output: { start: 0, end: 1 } });
    } else {
        const missing: undefined = result.sourceMap;
        void missing;
    }
}

export function checkExtractResult(result: publishedDdl.ExtractDdlResult): void {
    if (result.status === "extracted") {
        const empty: readonly [] = result.diagnostics;
        void empty;
    } else {
        const first: publishedFormatter.Diagnostic = result.diagnostics[0];
        void first;
    }
}
