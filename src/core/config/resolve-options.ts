import { isProxy } from "node:util/types";

import type { CanonicalFormatOptions, FormatOptions } from "./options";
import {
    DEFAULT_FORMAT_OPTIONS,
    FORMAT_OPTION_KEYS,
    isFormatOptionValue,
    type FormatOptionKey,
} from "./definitions";
export type { FormatOptionKey } from "./definitions";

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
    readonly optionKey: FormatOptionKey | null;
}

export interface ResolvedFormatOptions {
    readonly ok: true;
    readonly options: CanonicalFormatOptions;
}

export type ResolveFormatOptionsResult = ResolvedFormatOptions | FormatConfigFailure;

const OPTION_KEY_SET: ReadonlySet<string> = new Set(FORMAT_OPTION_KEYS);
const CANONICAL_OPTIONS = new WeakSet<object>();

function freezeCanonicalOptions(
    options: CanonicalFormatOptions
): CanonicalFormatOptions {
    const frozen = Object.freeze(options);
    CANONICAL_OPTIONS.add(frozen);
    return frozen;
}

const DEFAULT_OPTIONS = freezeCanonicalOptions(DEFAULT_FORMAT_OPTIONS);

function failure(
    code: FormatConfigFailureCode,
    message: string,
    optionKey: FormatOptionKey | null = null
): FormatConfigFailure {
    return Object.freeze({ ok: false, code, message, optionKey });
}

function invalidValue(key: FormatOptionKey): FormatConfigFailure {
    return failure(
        "CFG_OPTION_VALUE",
        `Invalid formatter option value for ${key}`,
        key
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

    const values: Partial<Record<FormatOptionKey, unknown>> = Object.create(null) as Partial<
        Record<FormatOptionKey, unknown>
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
                `Formatter option ${key} must be an enumerable own property`,
                key as FormatOptionKey
            );
        }
        if (!("value" in descriptor)) {
            return failure(
                "CFG_OPTION_ACCESSOR",
                `Formatter option ${key} must be a data property`,
                key as FormatOptionKey
            );
        }
        values[key as FormatOptionKey] = descriptor.value;
    }

    const selected = <K extends FormatOptionKey>(
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

    if (!isFormatOptionValue("dialect", dialectValue)) {
        return invalidValue("dialect");
    }
    if (!isFormatOptionValue("keywordCase", keywordCaseValue)) {
        return invalidValue("keywordCase");
    }
    if (!isFormatOptionValue("commaStyle", commaStyleValue)) {
        return invalidValue("commaStyle");
    }
    if (!isFormatOptionValue("indentStyle", indentStyleValue)) {
        return invalidValue("indentStyle");
    }
    if (!isFormatOptionValue("maxAlignWidth", maxAlignWidthValue)) {
        return invalidValue("maxAlignWidth");
    }
    if (!isFormatOptionValue("caseWhenThenWrapLength", caseWhenThenWrapLengthValue)) {
        return invalidValue("caseWhenThenWrapLength");
    }
    if (!isFormatOptionValue("caseLayout", caseLayoutValue)) {
        return invalidValue("caseLayout");
    }
    if (!isFormatOptionValue("unsupportedSyntaxPolicy", unsupportedPolicyValue)) {
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
