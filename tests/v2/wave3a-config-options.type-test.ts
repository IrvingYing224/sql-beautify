import type { FormatOptions } from "../../src/core/config/options";
import {
    isCanonicalFormatOptions,
    resolveFormatOptions,
} from "../../src/core/config/resolve-options";

const valid: FormatOptions = {
    dialect: "hive",
    keywordCase: "upper",
    commaStyle: "leading",
    indentStyle: "space",
    maxAlignWidth: 150,
    caseWhenThenWrapLength: 50,
    caseLayout: "expanded",
    unsupportedSyntaxPolicy: "warn",
};

// @ts-expect-error unknown keys are not part of the typed option surface
const unknown: FormatOptions = { keywordcase: "lower" };
// @ts-expect-error legacy dialect aliases are not canonical
const invalidDialect: FormatOptions = { dialect: "postgres" };
// @ts-expect-error explicit undefined is not an optional value under exact optional types
const explicitUndefined: FormatOptions = { dialect: undefined };

const resolved = resolveFormatOptions(valid);
if (resolved.ok) {
    const dialect: "hive" | "generic" | "postgresql" | "mysql" =
        resolved.options.dialect;
    // @ts-expect-error canonical options are readonly
    resolved.options.dialect = "mysql";
    void dialect;
} else {
    const code: string = resolved.code;
    void code;
}

const unknownIdentity: unknown = valid;
if (isCanonicalFormatOptions(unknownIdentity)) {
    const keywordCase: "upper" | "lower" = unknownIdentity.keywordCase;
    void keywordCase;
}

void unknown;
void invalidDialect;
void explicitUndefined;
