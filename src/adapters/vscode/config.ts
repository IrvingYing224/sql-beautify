import type * as Vscode from "vscode";

import type { FormatOptions } from "../../core/config/options";
import { snapshotDataProperties } from "../boundary/data-snapshot";

const FORMAT_OPTION_KEYS = Object.freeze([
    "dialect",
    "keywordCase",
    "commaStyle",
    "indentStyle",
    "maxAlignWidth",
    "caseWhenThenWrapLength",
    "caseLayout",
    "unsupportedSyntaxPolicy",
] as const);

type FormatOptionKey = (typeof FORMAT_OPTION_KEYS)[number];

export interface VscodeFormatConfiguration {
    readonly options: FormatOptions;
    readonly debugDiagnostics: boolean;
}

const FORMAT_OPTION_KEY_SET: ReadonlySet<string> = new Set(FORMAT_OPTION_KEYS);

export function mergeExplicitFormatOptions(
    configured: FormatOptions,
    explicit: unknown
): FormatOptions | null {
    if (explicit === undefined) {
        return configured;
    }
    const snapshot = snapshotDataProperties(explicit, FORMAT_OPTION_KEY_SET, []);
    if (snapshot === null) {
        return null;
    }
    return Object.freeze({ ...configured, ...snapshot }) as FormatOptions;
}

/** Reads only the canonical sqlBeautify.* surface at the document/language scope. */
export function readVscodeFormatConfiguration(
    vscode: typeof Vscode,
    document: Vscode.TextDocument
): VscodeFormatConfiguration | null {
    try {
        const configuration = vscode.workspace.getConfiguration("sqlBeautify", {
            uri: document.uri,
            languageId: document.languageId,
        });
        const raw: Partial<Record<FormatOptionKey, unknown>> = Object.create(null) as Partial<
            Record<FormatOptionKey, unknown>
        >;
        for (const key of FORMAT_OPTION_KEYS) {
            const value = configuration.get<unknown>(key);
            if (value !== undefined) {
                raw[key] = value;
            }
        }
        return Object.freeze({
            options: Object.freeze({ ...raw }) as FormatOptions,
            debugDiagnostics: configuration.get<unknown>("debugDiagnostics") === true,
        });
    } catch {
        return null;
    }
}
