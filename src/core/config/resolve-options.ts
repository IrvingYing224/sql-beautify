import { isProxy } from "node:util/types";

import type {
    CanonicalFormatOptions,
    CaseLayout,
    CommaStyle,
    Dialect,
    FormatOptions,
    IndentStyle,
    KeywordCase,
    UnsupportedSyntaxPolicy,
} from "./options";

export type FormatConfigFailureCode =
    | "CFG_OPTIONS_TYPE"
    | "CFG_OPTIONS_PROXY"
    | "CFG_OPTIONS_SHAPE"
    | "CFG_UNKNOWN_OPTION"
    | "CFG_OPTION_ACCESSOR"
    | "CFG_OPTION_VALUE"
    | "CFG_OPTIONS_READ";

export interface FormatConfigFailure {
    readonly ok: false;
    readonly code: FormatConfigFailureCode;
    readonly message: string;
}

export interface ResolvedFormatOptions {
    readonly ok: true;
    readonly options: CanonicalFormatOptions;
}

export type ResolveFormatOptionsResult = ResolvedFormatOptions | FormatConfigFailure;

const OPTION_KEYS = Object.freeze([
    "dialect",
    "keywordCase",
    "commaStyle",
    "indentStyle",
    "maxAlignWidth",
    "caseWhenThenWrapLength",
    "caseLayout",
    "unsupportedSyntaxPolicy",
] as const);

type OptionKey = (typeof OPTION_KEYS)[number];

const OPTION_KEY_SET: ReadonlySet<string> = new Set(OPTION_KEYS);
const CANONICAL_OPTIONS = new WeakSet<object>();

const DIALECTS: ReadonlySet<Dialect> = new Set([
    "hive",
    "generic",
    "postgresql",
    "mysql",
]);
const KEYWORD_CASES: ReadonlySet<KeywordCase> = new Set(["upper", "lower"]);
const COMMA_STYLES: ReadonlySet<CommaStyle> = new Set(["leading", "trailing"]);
const INDENT_STYLES: ReadonlySet<IndentStyle> = new Set(["space", "tab"]);
const CASE_LAYOUTS: ReadonlySet<CaseLayout> = new Set(["expanded", "compactShort"]);
const UNSUPPORTED_POLICIES: ReadonlySet<UnsupportedSyntaxPolicy> = new Set([
    "warn",
    "preserve",
    "bail_out",
]);

function freezeCanonicalOptions(
    options: CanonicalFormatOptions
): CanonicalFormatOptions {
    const frozen = Object.freeze(options);
    CANONICAL_OPTIONS.add(frozen);
    return frozen;
}

const DEFAULT_OPTIONS = freezeCanonicalOptions({
    dialect: "hive",
    keywordCase: "upper",
    commaStyle: "leading",
    indentStyle: "space",
    maxAlignWidth: 150,
    caseWhenThenWrapLength: 50,
    caseLayout: "expanded",
    unsupportedSyntaxPolicy: "warn",
});

function failure(
    code: FormatConfigFailureCode,
    message: string
): FormatConfigFailure {
    return Object.freeze({ ok: false, code, message });
}

function enumValue<T extends string>(
    value: unknown,
    allowed: ReadonlySet<T>
): value is T {
    return typeof value === "string" && allowed.has(value as T);
}

function integerInRange(value: unknown, minimum: number, maximum: number): value is number {
    return (
        typeof value === "number" &&
        Number.isSafeInteger(value) &&
        value >= minimum &&
        value <= maximum
    );
}

function invalidValue(key: OptionKey): FormatConfigFailure {
    return failure(
        "CFG_OPTION_VALUE",
        `Invalid formatter option value for ${key}`
    );
}

/**
 * Resolves the sole Wave 3 canonical option object.
 *
 * Runtime callers are treated as untrusted values. Proxies, accessors, exotic
 * prototypes, symbols, non-enumerable properties and unknown keys are rejected
 * rather than becoming hidden configuration channels. No caller object escapes.
 */
export function resolveFormatOptions(
    input: FormatOptions | unknown = undefined
): ResolveFormatOptionsResult {
    if (input === undefined) {
        return Object.freeze({ ok: true, options: DEFAULT_OPTIONS });
    }
    if (typeof input !== "object" || input === null) {
        return failure("CFG_OPTIONS_TYPE", "Formatter options must be a plain object");
    }

    try {
        if (isProxy(input)) {
            return failure("CFG_OPTIONS_PROXY", "Formatter options must not be a Proxy");
        }
    } catch {
        return failure("CFG_OPTIONS_READ", "Formatter options could not be inspected");
    }
    if (Array.isArray(input)) {
        return failure("CFG_OPTIONS_TYPE", "Formatter options must be a plain object");
    }

    let prototype: object | null;
    let ownKeys: readonly PropertyKey[];
    try {
        prototype = Object.getPrototypeOf(input);
        ownKeys = Reflect.ownKeys(input);
    } catch {
        return failure("CFG_OPTIONS_READ", "Formatter options could not be inspected");
    }
    if (prototype !== Object.prototype && prototype !== null) {
        return failure("CFG_OPTIONS_SHAPE", "Formatter options must be a plain object");
    }

    const values: Partial<Record<OptionKey, unknown>> = Object.create(null) as Partial<
        Record<OptionKey, unknown>
    >;
    for (const key of ownKeys) {
        if (typeof key !== "string" || !OPTION_KEY_SET.has(key)) {
            return failure(
                "CFG_UNKNOWN_OPTION",
                typeof key === "string"
                    ? `Unknown formatter option: ${key}`
                    : "Formatter options must not contain symbol keys"
            );
        }
        let descriptor: PropertyDescriptor | undefined;
        try {
            descriptor = Object.getOwnPropertyDescriptor(input, key);
        } catch {
            return failure("CFG_OPTIONS_READ", "Formatter options could not be inspected");
        }
        if (descriptor === undefined || descriptor.enumerable !== true) {
            return failure(
                "CFG_UNKNOWN_OPTION",
                `Formatter option ${key} must be an enumerable own property`
            );
        }
        if (!("value" in descriptor)) {
            return failure(
                "CFG_OPTION_ACCESSOR",
                `Formatter option ${key} must be a data property`
            );
        }
        values[key as OptionKey] = descriptor.value;
    }

    const selected = <K extends OptionKey>(
        key: K,
        fallback: CanonicalFormatOptions[K]
    ): unknown =>
        Object.prototype.hasOwnProperty.call(values, key) ? values[key] : fallback;

    const dialectValue = selected("dialect", DEFAULT_OPTIONS.dialect);
    const keywordCaseValue = selected("keywordCase", DEFAULT_OPTIONS.keywordCase);
    const commaStyleValue = selected("commaStyle", DEFAULT_OPTIONS.commaStyle);
    const indentStyleValue = selected("indentStyle", DEFAULT_OPTIONS.indentStyle);
    const maxAlignWidthValue = selected("maxAlignWidth", DEFAULT_OPTIONS.maxAlignWidth);
    const caseWhenThenWrapLengthValue = selected(
        "caseWhenThenWrapLength",
        DEFAULT_OPTIONS.caseWhenThenWrapLength
    );
    const caseLayoutValue = selected("caseLayout", DEFAULT_OPTIONS.caseLayout);
    const unsupportedPolicyValue = selected(
        "unsupportedSyntaxPolicy",
        DEFAULT_OPTIONS.unsupportedSyntaxPolicy
    );

    if (!enumValue(dialectValue, DIALECTS)) {
        return invalidValue("dialect");
    }
    if (!enumValue(keywordCaseValue, KEYWORD_CASES)) {
        return invalidValue("keywordCase");
    }
    if (!enumValue(commaStyleValue, COMMA_STYLES)) {
        return invalidValue("commaStyle");
    }
    if (!enumValue(indentStyleValue, INDENT_STYLES)) {
        return invalidValue("indentStyle");
    }
    if (!integerInRange(maxAlignWidthValue, 1, 500)) {
        return invalidValue("maxAlignWidth");
    }
    if (!integerInRange(caseWhenThenWrapLengthValue, 1, 300)) {
        return invalidValue("caseWhenThenWrapLength");
    }
    if (!enumValue(caseLayoutValue, CASE_LAYOUTS)) {
        return invalidValue("caseLayout");
    }
    if (!enumValue(unsupportedPolicyValue, UNSUPPORTED_POLICIES)) {
        return invalidValue("unsupportedSyntaxPolicy");
    }

    return Object.freeze({
        ok: true,
        options: freezeCanonicalOptions({
            dialect: dialectValue,
            keywordCase: keywordCaseValue,
            commaStyle: commaStyleValue,
            indentStyle: indentStyleValue,
            maxAlignWidth: maxAlignWidthValue,
            caseWhenThenWrapLength: caseWhenThenWrapLengthValue,
            caseLayout: caseLayoutValue,
            unsupportedSyntaxPolicy: unsupportedPolicyValue,
        }),
    });
}

/** Exact identity proof for options emitted by resolveFormatOptions(). */
export function isCanonicalFormatOptions(
    value: unknown
): value is CanonicalFormatOptions {
    return typeof value === "object" && value !== null && CANONICAL_OPTIONS.has(value);
}
