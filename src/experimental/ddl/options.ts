import { isProxy } from "node:util/types";

import type {
    CommaStyle,
    IndentStyle,
    KeywordCase,
} from "../../core/config/options";
import type { HiveDdlFormatOptions } from "./types";
import type { ExtractDdlOptions } from "./types";
import { DEFAULT_DDL_MAX_ALIGN_WIDTH } from "./alignment";

const OPTION_KEYS: ReadonlySet<string> = new Set([
    "keywordCase",
    "commaStyle",
    "indentStyle",
    "maxAlignWidth",
]);
const EXTRACT_OPTION_KEYS: ReadonlySet<string> = new Set(["defaultType"]);

export interface ResolvedHiveDdlFormatOptions {
    readonly keywordCase: KeywordCase;
    readonly commaStyle: CommaStyle;
    readonly indentStyle: IndentStyle;
    readonly maxAlignWidth: number;
}

export interface ResolvedExtractDdlOptions {
    readonly defaultType?: string;
}

export const DEFAULT_HIVE_DDL_FORMAT_OPTIONS: ResolvedHiveDdlFormatOptions =
    Object.freeze({
        keywordCase: "upper",
        commaStyle: "leading",
        indentStyle: "space",
        maxAlignWidth: DEFAULT_DDL_MAX_ALIGN_WIDTH,
    });

const DEFAULT_EXTRACT_DDL_OPTIONS: ResolvedExtractDdlOptions = Object.freeze({});

function snapshotOptions(
    value: unknown,
    allowedKeys: ReadonlySet<string>
): Readonly<Record<string, unknown>> | null {
    if (
        typeof value !== "object" ||
        value === null ||
        Array.isArray(value) ||
        isProxy(value)
    ) {
        return null;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
        return null;
    }
    const raw: Record<string, unknown> = Object.create(null) as Record<
        string,
        unknown
    >;
    for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== "string" || !allowedKeys.has(key)) {
            return null;
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (
            descriptor === undefined ||
            descriptor.enumerable !== true ||
            !("value" in descriptor)
        ) {
            return null;
        }
        raw[key] = descriptor.value;
    }
    return raw;
}

export function resolveHiveDdlFormatOptions(
    value: HiveDdlFormatOptions | unknown
): ResolvedHiveDdlFormatOptions | null {
    if (value === undefined) {
        return DEFAULT_HIVE_DDL_FORMAT_OPTIONS;
    }
    try {
        const raw = snapshotOptions(value, OPTION_KEYS);
        if (raw === null) {
            return null;
        }
        const keywordCase = raw.keywordCase ??
            DEFAULT_HIVE_DDL_FORMAT_OPTIONS.keywordCase;
        const commaStyle = raw.commaStyle ??
            DEFAULT_HIVE_DDL_FORMAT_OPTIONS.commaStyle;
        const indentStyle = raw.indentStyle ??
            DEFAULT_HIVE_DDL_FORMAT_OPTIONS.indentStyle;
        const maxAlignWidth = raw.maxAlignWidth ??
            DEFAULT_HIVE_DDL_FORMAT_OPTIONS.maxAlignWidth;
        if (
            (keywordCase !== "upper" && keywordCase !== "lower") ||
            (commaStyle !== "leading" && commaStyle !== "trailing") ||
            (indentStyle !== "space" && indentStyle !== "tab") ||
            !Number.isSafeInteger(maxAlignWidth) ||
            (maxAlignWidth as number) < 1 ||
            (maxAlignWidth as number) > 500
        ) {
            return null;
        }
        return Object.freeze({
            keywordCase,
            commaStyle,
            indentStyle,
            maxAlignWidth: maxAlignWidth as number,
        });
    } catch {
        return null;
    }
}

export function resolveExtractDdlOptions(
    value: ExtractDdlOptions | unknown
): ResolvedExtractDdlOptions | null {
    if (value === undefined) {
        return DEFAULT_EXTRACT_DDL_OPTIONS;
    }
    try {
        const raw = snapshotOptions(value, EXTRACT_OPTION_KEYS);
        if (
            raw === null ||
            (raw.defaultType !== undefined && typeof raw.defaultType !== "string")
        ) {
            return null;
        }
        return raw.defaultType === undefined
            ? DEFAULT_EXTRACT_DDL_OPTIONS
            : Object.freeze({ defaultType: raw.defaultType });
    } catch {
        return null;
    }
}
