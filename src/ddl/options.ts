import type { CommaStyle, IndentStyle, KeywordCase } from "../core/config/options";
import { DEFAULT_FORMAT_OPTIONS } from "../core/config/definitions";
import { resolveFormatOptions } from "../core/config/resolve-options";

export interface ResolvedHiveDdlFormatOptions {
    readonly keywordCase: KeywordCase;
    readonly commaStyle: CommaStyle;
    readonly indentStyle: IndentStyle;
    readonly maxAlignWidth: number;
}

const HIVE_DDL_OPTION_KEYS: ReadonlySet<string> = new Set([
    "keywordCase",
    "commaStyle",
    "indentStyle",
    "maxAlignWidth",
]);

/** The options as a record when they are an object with only `keys`, otherwise null. */
function optionRecord(value: unknown, keys: ReadonlySet<string>): Readonly<Record<string, unknown>> | null {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return null;
    }
    return Object.keys(value).every((key) => keys.has(key))
        ? value as Readonly<Record<string, unknown>>
        : null;
}

/** The formatSql options that apply to DDL, validated the same way; null when invalid. */
export function resolveHiveDdlFormatOptions(value: unknown): ResolvedHiveDdlFormatOptions | null {
    const record = value === undefined ? {} : optionRecord(value, HIVE_DDL_OPTION_KEYS);
    const resolved = record === null ? null : resolveFormatOptions(record);
    if (resolved === null || !resolved.ok) {
        return null;
    }
    const { keywordCase, commaStyle, indentStyle, maxAlignWidth } = resolved.options;
    return { keywordCase, commaStyle, indentStyle, maxAlignWidth };
}

/** The Extract placeholder type before its own checks; null when the options are invalid. */
export function resolveExtractDefaultType(value: unknown): string | null {
    if (value === undefined) {
        return "__TYPE_REQUIRED__";
    }
    const record = optionRecord(value, new Set(["defaultType"]));
    if (record === null) {
        return null;
    }
    if (!Object.prototype.hasOwnProperty.call(record, "defaultType")) {
        return "__TYPE_REQUIRED__";
    }
    return typeof record.defaultType === "string" ? record.defaultType : null;
}

export const DEFAULT_DDL_MAX_ALIGN_WIDTH = DEFAULT_FORMAT_OPTIONS.maxAlignWidth;
