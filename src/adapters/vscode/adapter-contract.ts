import type { FormatOptions } from "../../core/config/options";
import { resolveFormatOptions } from "../../core/config/resolve-options";
import type { FormatTarget } from "../transaction/types";
import { formatterSelector, supportedLanguage } from "./supported-languages";
import {
    snapshotDataProperties,
    snapshotDenseDataArray,
} from "../boundary/data-snapshot";

export interface HostRange {
    readonly start: number;
    readonly end: number;
}

const OPTION_KEYS: ReadonlySet<string> = new Set([
    "dialect",
    "keywordCase",
    "commaStyle",
    "indentStyle",
    "maxAlignWidth",
    "caseWhenThenWrapLength",
    "caseLayout",
    "unsupportedSyntaxPolicy",
]);
const RANGE_KEYS: ReadonlySet<string> = new Set(["start", "end"]);

export function createDocumentTarget(sourceLength: number): FormatTarget | null {
    if (!Number.isSafeInteger(sourceLength) || sourceLength < 0) {
        return null;
    }
    return Object.freeze({
        id: "document",
        start: 0,
        end: sourceLength,
        mode: "document" as const,
    });
}

export function createFragmentTargets(
    ranges: readonly HostRange[]
): readonly FormatTarget[] | null {
    try {
        const rawRanges = snapshotDenseDataArray(ranges);
        if (rawRanges === null) {
            return null;
        }
        const targets: FormatTarget[] = [];
        for (let index = 0; index < rawRanges.length; index++) {
            const range = snapshotDataProperties(rawRanges[index], RANGE_KEYS, ["start", "end"]);
            if (
                range === null ||
                !Number.isSafeInteger(range.start) ||
                !Number.isSafeInteger(range.end) ||
                (range.start as number) < 0 ||
                (range.end as number) < (range.start as number)
            ) {
                return null;
            }
            targets.push(Object.freeze({
                id: `selection:${index}`,
                start: range.start as number,
                end: range.end as number,
                mode: "fragment" as const,
            }));
        }
        return Object.freeze(targets);
    } catch {
        return null;
    }
}

export function optionsForLanguage(
    languageId: unknown,
    options: FormatOptions
): FormatOptions | null {
    try {
        const supported = supportedLanguage(languageId);
        if (supported === null || typeof options !== "object" || options === null) {
            return null;
        }
        const snapshot = snapshotDataProperties(options, OPTION_KEYS, []);
        if (snapshot === null) {
            return null;
        }
        const hasDialect = Object.prototype.hasOwnProperty.call(snapshot, "dialect");
        const withDialect = Object.freeze({
            ...snapshot,
            dialect: hasDialect ? snapshot.dialect : supported.dialect,
        });
        const resolved = resolveFormatOptions(withDialect);
        return resolved.ok ? withDialect as FormatOptions : null;
    } catch {
        return null;
    }
}

export const FORMATTER_SELECTOR = formatterSelector();
