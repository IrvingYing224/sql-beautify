import * as vscode from "vscode";

import type { EditExecutor } from "../edits/executor";
import { applyEdits } from "../edits/offsets";
import type { EditTarget } from "../edits/types";
import { documentNewline, isSupported, readConfiguration, renderTabSize, SUPPORTED_LANGUAGES, type Configuration } from "./config";
import { hostDiagnostic, logDebug, type Diagnostics } from "./diagnostics";

/**
 * Document and range formatting providers. They only return edits: VS Code applies them, and the
 * diagnostics are published once the document text equals the output.
 */
export function registerProviders(executor: EditExecutor, diagnostics: Diagnostics): vscode.Disposable[] {
    function publishConfiguration(document: vscode.TextDocument, configuration: Extract<Configuration, { readonly ok: false }>): void {
        diagnostics.publish(document, [hostDiagnostic(configuration.code, "error", configuration.message)], "warn");
    }

    /** After a settings change, each settings error shown follows the settings without waiting for an edit (K25). */
    function refreshConfiguration(event: vscode.ConfigurationChangeEvent): void {
        if (!event.affectsConfiguration("sqlBeautify")) {
            return;
        }
        for (const document of vscode.workspace.textDocuments) {
            if (isSupported(document) && diagnostics.codes(document).some((code) => code.startsWith("CFG_"))) {
                const configuration = readConfiguration(document);
                if (configuration.ok) {
                    diagnostics.clear(document);
                } else {
                    publishConfiguration(document, configuration);
                }
            }
        }
    }

    async function provide(
        document: vscode.TextDocument,
        ranges: readonly vscode.Range[] | null,
        formatting: vscode.FormattingOptions,
        token: vscode.CancellationToken
    ): Promise<vscode.TextEdit[]> {
        if (!isSupported(document)) {
            return [];
        }
        const source = document.getText();
        const version = document.version;
        const configuration = readConfiguration(document);
        if (!configuration.ok) {
            publishConfiguration(document, configuration);
            return [];
        }
        // All ranges share one snapshot and one request: one invalid range rejects them all.
        const targets: readonly EditTarget[] = ranges === null
            ? [{ id: "document", start: 0, end: source.length, mode: "document" }]
            : ranges.map((range, index) => ({
                id: `range:${String(index)}`,
                start: document.offsetAt(range.start),
                end: document.offsetAt(range.end),
                mode: "fragment",
            }));
        diagnostics.drop(document);
        const result = await executor.run({
            op: "format",
            source,
            targets,
            selections: [],
            options: configuration.options,
            newline: documentNewline(document, source),
            tabSize: renderTabSize(formatting.tabSize),
            debug: configuration.debug,
        }, token);
        if (token.isCancellationRequested || document.version !== version || document.getText() !== source) {
            diagnostics.clear(document);
            return [];
        }
        logDebug(configuration.debug, ranges === null ? "document-format" : "range-format", document, version, result);
        const policy = configuration.options.unsupportedSyntaxPolicy;
        if (result.status !== "ready") {
            diagnostics.publish(document, result.diagnostics, policy);
            return [];
        }
        diagnostics.stage(document, applyEdits(source, result.edits), result.diagnostics, policy);
        return result.edits.map((edit) => vscode.TextEdit.replace(
            new vscode.Range(document.positionAt(edit.start), document.positionAt(edit.end)),
            edit.text
        ));
    }

    return [
        vscode.workspace.onDidChangeConfiguration(refreshConfiguration),
        vscode.languages.registerDocumentFormattingEditProvider(SUPPORTED_LANGUAGES, {
            provideDocumentFormattingEdits: (document, formatting, token) => provide(document, null, formatting, token),
        }),
        vscode.languages.registerDocumentRangeFormattingEditProvider(SUPPORTED_LANGUAGES, {
            provideDocumentRangeFormattingEdits: (document, range, formatting, token) =>
                provide(document, [range], formatting, token),
            provideDocumentRangesFormattingEdits: (document, ranges, formatting, token) =>
                provide(document, ranges, formatting, token),
        }),
    ];
}
