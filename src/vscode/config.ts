import * as vscode from "vscode";

import { FORMAT_OPTION_KEYS } from "../core/config/definitions";
import type { CanonicalFormatOptions } from "../core/config/options";
import {
    resolveFormatOptions,
    type FormatConfigFailureCode,
    type FormatOptionKey,
    type ResolveFormatOptionsResult,
} from "../core/config/resolve-options";
import {
    DEFAULT_RENDER_TAB_SIZE,
    inferRenderNewline,
    isRenderTabSize,
    type RenderNewline,
    type RenderTabSize,
} from "../core/renderer/environment";

export const SUPPORTED_LANGUAGES: readonly string[] = ["sql", "hive-sql"];

export function isSupported(document: vscode.TextDocument): boolean {
    return SUPPORTED_LANGUAGES.includes(document.languageId);
}

export type Configuration =
    | { readonly ok: true; readonly options: CanonicalFormatOptions }
    | {
        readonly ok: false;
        readonly code: FormatConfigFailureCode;
        readonly message: string;
        readonly optionKey: FormatOptionKey | null;
    };

/** Reads the sqlBeautify settings at the document's resource and language scope. */
export function readConfiguration(document: vscode.TextDocument): Configuration {
    const configuration = vscode.workspace.getConfiguration("sqlBeautify", {
        uri: document.uri,
        languageId: document.languageId,
    });
    const values: Record<string, unknown> = {};
    for (const key of FORMAT_OPTION_KEYS) {
        const value = configuration.get<unknown>(key);
        if (value !== undefined) {
            values[key] = value;
        }
    }
    const resolved = resolveFormatOptions(values);
    return resolved.ok
        ? { ok: true, options: resolved.options }
        : { ok: false, code: resolved.code, message: resolved.message, optionKey: resolved.optionKey };
}

/** Explicit `formatSql` command arguments (for example from a keybinding) override the settings. */
export function commandOptions(configured: CanonicalFormatOptions, explicit: unknown): ResolveFormatOptionsResult {
    if (explicit === undefined) {
        return { ok: true, options: configured };
    }
    if (typeof explicit !== "object" || explicit === null || Array.isArray(explicit)) {
        return { ok: false, code: "CFG_OPTIONS_SHAPE", message: "Command options must be an object", optionKey: null };
    }
    return resolveFormatOptions({ ...configured, ...explicit });
}

/** A line break in the text wins; otherwise the document's end-of-line setting. */
export function documentNewline(document: vscode.TextDocument, source: string): RenderNewline {
    return inferRenderNewline(source, document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n");
}

export function renderTabSize(value: unknown): RenderTabSize {
    return isRenderTabSize(value) ? value : DEFAULT_RENDER_TAB_SIZE;
}
