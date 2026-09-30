import { isProxy } from "node:util/types";

import type {
    CommaStyle,
    IndentStyle,
    KeywordCase,
} from "../../core/config/options";
import type { HiveDdlFormatOptions } from "./types";
import type { ExtractDdlOptions } from "./types";
import { DEFAULT_FORMAT_OPTIONS } from "../../core/config/definitions";
import { resolveFormatOptions } from "../../core/config/resolve-options";

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
        keywordCase: DEFAULT_FORMAT_OPTIONS.keywordCase,
        commaStyle: DEFAULT_FORMAT_OPTIONS.commaStyle,
        indentStyle: DEFAULT_FORMAT_OPTIONS.indentStyle,
        maxAlignWidth: DEFAULT_FORMAT_OPTIONS.maxAlignWidth,
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
        const resolved = resolveFormatOptions(raw);
        if (!resolved.ok) {
            return null;
        }
        const { keywordCase, commaStyle, indentStyle, maxAlignWidth } = resolved.options;
        return Object.freeze({ keywordCase, commaStyle, indentStyle, maxAlignWidth });
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
        if (raw === null) {
            return null;
        }
        if (!Object.prototype.hasOwnProperty.call(raw, "defaultType")) {
            return DEFAULT_EXTRACT_DDL_OPTIONS;
        }
        return typeof raw.defaultType === "string"
            ? Object.freeze({ defaultType: raw.defaultType })
            : null;
    } catch {
        return null;
    }
}
