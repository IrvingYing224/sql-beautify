import { isProxy } from "node:util/types";

import type {
    CommaStyle,
    IndentStyle,
    KeywordCase,
} from "../../core/config/options";
import type { HiveDdlFormatOptions } from "./types";

const OPTION_KEYS: ReadonlySet<string> = new Set([
    "keywordCase",
    "commaStyle",
    "indentStyle",
]);

export interface ResolvedHiveDdlFormatOptions {
    readonly keywordCase: KeywordCase;
    readonly commaStyle: CommaStyle;
    readonly indentStyle: IndentStyle;
}

export const DEFAULT_HIVE_DDL_FORMAT_OPTIONS: ResolvedHiveDdlFormatOptions =
    Object.freeze({
        keywordCase: "upper",
        commaStyle: "leading",
        indentStyle: "space",
    });

export function resolveHiveDdlFormatOptions(
    value: HiveDdlFormatOptions | unknown
): ResolvedHiveDdlFormatOptions | null {
    if (value === undefined) {
        return DEFAULT_HIVE_DDL_FORMAT_OPTIONS;
    }
    try {
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
            if (typeof key !== "string" || !OPTION_KEYS.has(key)) {
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
        const keywordCase = raw.keywordCase ??
            DEFAULT_HIVE_DDL_FORMAT_OPTIONS.keywordCase;
        const commaStyle = raw.commaStyle ??
            DEFAULT_HIVE_DDL_FORMAT_OPTIONS.commaStyle;
        const indentStyle = raw.indentStyle ??
            DEFAULT_HIVE_DDL_FORMAT_OPTIONS.indentStyle;
        if (
            (keywordCase !== "upper" && keywordCase !== "lower") ||
            (commaStyle !== "leading" && commaStyle !== "trailing") ||
            (indentStyle !== "space" && indentStyle !== "tab")
        ) {
            return null;
        }
        return Object.freeze({ keywordCase, commaStyle, indentStyle });
    } catch {
        return null;
    }
}
