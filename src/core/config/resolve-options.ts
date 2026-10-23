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
    | "CFG_UNKNOWN_OPTION"
    | "CFG_OPTION_VALUE"
    // Produced by the VS Code host while reading and merging configuration.
    | "CFG_OPTIONS_SHAPE"
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

function failure(
    code: FormatConfigFailureCode,
    message: string,
    optionKey: FormatOptionKey | null = null
): FormatConfigFailure {
    return Object.freeze({ ok: false, code, message, optionKey });
}

/** Resolves caller options against the option definitions: unknown keys and invalid values fail. */
export function resolveFormatOptions(
    input: FormatOptions | unknown = undefined
): ResolveFormatOptionsResult {
    if (input === undefined) {
        return Object.freeze({ ok: true, options: DEFAULT_FORMAT_OPTIONS });
    }
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
        return failure("CFG_OPTIONS_TYPE", "Formatter options must be a plain object");
    }
    const values = input as Readonly<Record<string, unknown>>;
    for (const key of Object.keys(values)) {
        if (!OPTION_KEY_SET.has(key)) {
            return failure("CFG_UNKNOWN_OPTION", `Unknown formatter option: ${key}`);
        }
    }
    const resolved: Record<string, unknown> = {};
    for (const key of FORMAT_OPTION_KEYS) {
        const value = Object.prototype.hasOwnProperty.call(values, key)
            ? values[key]
            : DEFAULT_FORMAT_OPTIONS[key];
        if (!isFormatOptionValue(key, value)) {
            return failure("CFG_OPTION_VALUE", `Invalid formatter option value for ${key}`, key);
        }
        resolved[key] = value;
    }
    return Object.freeze({
        ok: true,
        options: Object.freeze(resolved) as unknown as CanonicalFormatOptions,
    });
}
