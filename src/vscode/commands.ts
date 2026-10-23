import * as vscode from "vscode";

import type { CanonicalFormatOptions, UnsupportedSyntaxPolicy } from "../core/config/options";
import type { RenderNewline, RenderTabSize } from "../core/renderer/environment";
import { CANCELLED_RESULT, type EditExecutor } from "../edits/executor";
import { applyEdits } from "../edits/offsets";
import type { ComputeRequest, ComputeResult, EditSelection, EditTarget } from "../edits/types";
import { commandOptions, documentNewline, isSupported, readConfiguration, renderTabSize } from "./config";
import { diagnosticsForEditor, hostDiagnostic, logDebug, withSafeMessages, type Diagnostics } from "./diagnostics";
import type { VscodeMessageKey, VscodeMessages } from "./messages";
import { renderSafeDiagnosticReport } from "./safe-report";
import { selectionTargets } from "./selections";

/** What every command reads from the active editor before computing. */
interface CommandContext {
    readonly editor: vscode.TextEditor;
    readonly document: vscode.TextDocument;
    readonly source: string;
    readonly version: number;
    readonly options: CanonicalFormatOptions;
    readonly debug: boolean;
    readonly targets: readonly EditTarget[];
    readonly selections: readonly EditSelection[];
    readonly newline: RenderNewline;
    readonly tabSize: RenderTabSize;
}

const RANGE_CODES: ReadonlySet<string> = new Set([
    "ADAPTER_RANGE_LINE",
    "ADAPTER_RANGE_PROTECTED",
    "ADAPTER_RANGE_EMPTY",
    "ADAPTER_RANGE_ANALYSIS",
    "ADAPTER_RANGE_OPAQUE",
    "ADAPTER_RANGE_OWNERSHIP",
]);

function hostRejection(code: string, severity: "warning" | "error"): ComputeResult {
    return { status: "rejected", edits: [], selections: [], diagnostics: [hostDiagnostic(code, severity)], debugEvents: [] };
}

function isCurrent(context: CommandContext): boolean {
    return context.editor.document === context.document &&
        context.document.version === context.version &&
        context.document.getText() === context.source;
}

export function registerCommands(
    executor: EditExecutor,
    diagnostics: Diagnostics,
    messages: VscodeMessages,
    extensionVersion: string
): vscode.Disposable[] {
    function show(kind: "info" | "warning" | "error", key: VscodeMessageKey, values?: Parameters<VscodeMessages["text"]>[1]): void {
        const text = messages.text(key, values);
        void (kind === "info"
            ? vscode.window.showInformationMessage(text)
            : kind === "warning" ? vscode.window.showWarningMessage(text) : vscode.window.showErrorMessage(text));
    }

    function commandContext(): CommandContext | null {
        const editor = vscode.window.activeTextEditor;
        if (editor === undefined || !isSupported(editor.document)) {
            show("warning", "activeSqlEditor");
            return null;
        }
        const document = editor.document;
        const configuration = readConfiguration(document);
        if (!configuration.ok) {
            show("error", "configurationInvalid", { optionKey: configuration.optionKey });
            return null;
        }
        const source = document.getText();
        return {
            editor,
            document,
            source,
            version: document.version,
            options: configuration.options,
            debug: configuration.debug,
            ...selectionTargets(editor),
            newline: documentNewline(document, source),
            tabSize: renderTabSize(editor.options.tabSize),
        };
    }

    function request(context: CommandContext): Omit<ComputeRequest, "op" | "options"> {
        return {
            source: context.source,
            targets: context.targets,
            selections: context.selections,
            newline: context.newline,
            tabSize: context.tabSize,
            debug: context.debug,
        };
    }

    /** Applies a ready result in one `editor.edit`, unless the document changed. */
    async function apply(context: CommandContext, result: ComputeResult, policy: UnsupportedSyntaxPolicy): Promise<ComputeResult> {
        if (!isCurrent(context)) {
            return hostRejection("ADAPTER_STALE_DOCUMENT", "warning");
        }
        const { editor, document } = context;
        diagnostics.stage(document, applyEdits(context.source, result.edits), result.diagnostics, policy);
        let applied: boolean;
        try {
            applied = await editor.edit((builder) => {
                for (const edit of result.edits) {
                    builder.replace(new vscode.Range(document.positionAt(edit.start), document.positionAt(edit.end)), edit.text);
                }
            });
        } catch {
            applied = false;
        }
        if (!applied) {
            diagnostics.drop(document);
            return hostRejection("ADAPTER_EDIT_REJECTED", "error");
        }
        if (result.selections.length > 0) {
            // The edit is applied, so the document positions are in output coordinates.
            editor.selections = result.selections.map((selection) =>
                new vscode.Selection(document.positionAt(selection.anchor), document.positionAt(selection.active))
            );
        }
        diagnostics.confirm(document);
        return result;
    }

    async function run(
        context: CommandContext,
        computeRequest: ComputeRequest,
        policy: UnsupportedSyntaxPolicy,
        phase: string,
        token: vscode.CancellationToken
    ): Promise<ComputeResult> {
        diagnostics.drop(context.document);
        const computed = withSafeMessages(await executor.run(computeRequest, token));
        // Cancellation during computation wins over any result.
        const result = token.isCancellationRequested
            ? CANCELLED_RESULT
            : computed.status === "ready" ? await apply(context, computed, policy) : computed;
        logDebug(context.debug, phase, context.document, context.version, result);
        if (result.status !== "ready" && isCurrent(context)) {
            diagnostics.publish(context.document, result.diagnostics, policy);
        }
        return result;
    }

    function reportFormat(result: ComputeResult, policy: UnsupportedSyntaxPolicy): void {
        if (policy === "preserve" && (result.status === "unchanged" || result.status === "rejected")) {
            const preserved = diagnosticsForEditor(result.diagnostics.filter((item) => item.capabilityId !== null));
            if (preserved.length > 0) {
                show("info", preserved.some((item) => item.capabilityId === "hive-ddl") ? "preservedHiveDdl" : "unmodeledRegions",
                    { count: preserved.length });
                return;
            }
        }
        if (result.status === "cancelled") {
            show("info", "formatCancelled");
        } else if (result.status === "rejected") {
            const codes = result.diagnostics.map((item) => item.code);
            if (codes.includes("ADAPTER_STALE_DOCUMENT")) {
                show("info", "documentChanged");
            } else if (codes.some((code) => RANGE_CODES.has(code))) {
                show("warning", "rangeRejected");
            } else if (codes.includes("ADAPTER_INPUT_LIMIT")) {
                show("warning", "inputLimitRejected");
            } else if (codes.includes("ADAPTER_WORKER_CRASH")) {
                show("warning", "workerRejected");
            } else if (codes.includes("ADAPTER_EDIT_REJECTED")) {
                show("warning", "editRejected");
            } else {
                show("warning", "formatRejected");
            }
        }
    }

    function reportDdl(result: ComputeResult): void {
        if (result.status === "cancelled") {
            show("info", "formatCancelled");
        } else if (result.status === "rejected") {
            const codes = result.diagnostics.map((item) => item.code);
            if (codes.includes("ADAPTER_STALE_DOCUMENT")) {
                show("info", "documentChanged");
            } else if (codes.includes("ADAPTER_EDIT_REJECTED")) {
                show("warning", "editRejected");
            } else {
                show("warning", "ddlRejected");
            }
        }
    }

    async function formatSql(explicit: unknown, token: vscode.CancellationToken): Promise<ComputeResult | null> {
        const context = commandContext();
        if (context === null) {
            return null;
        }
        const resolved = commandOptions(context.options, explicit);
        if (!resolved.ok) {
            show("error", "commandOptionsInvalid", { optionKey: resolved.optionKey });
            return null;
        }
        const policy = resolved.options.unsupportedSyntaxPolicy;
        const result = await run(context, { ...request(context), op: "format", options: resolved.options }, policy, "command-format", token);
        reportFormat(result, policy);
        return result;
    }

    async function ddlCommand(op: "hive-ddl" | "extract", token: vscode.CancellationToken): Promise<ComputeResult | null> {
        const context = commandContext();
        if (context === null) {
            return null;
        }
        const { keywordCase, commaStyle, indentStyle, maxAlignWidth } = context.options;
        const computeRequest: ComputeRequest = op === "hive-ddl"
            ? { ...request(context), op, options: { keywordCase, commaStyle, indentStyle, maxAlignWidth } }
            : { ...request(context), op, options: undefined };
        const phase = op === "hive-ddl" ? "hive-ddl" : "extract-hive-ddl";
        const result = await run(context, computeRequest, context.options.unsupportedSyntaxPolicy, phase, token);
        reportDdl(result);
        return result;
    }

    /** Copies the codes and counts of a format of the selection; never any SQL (D3 removes this in P4b). */
    async function copySafeDiagnosticReport(token: vscode.CancellationToken): Promise<boolean> {
        const context = commandContext();
        if (context === null) {
            return false;
        }
        const result = await executor.run({ ...request(context), op: "format", options: context.options }, token);
        if (token.isCancellationRequested) {
            show("info", "safeReportCancelled");
            return false;
        }
        if (vscode.window.activeTextEditor !== context.editor || !isCurrent(context)) {
            show("info", "safeReportStale");
            return false;
        }
        const report = renderSafeDiagnosticReport({
            extensionVersion,
            dialect: context.options.dialect,
            sourceCodeUnits: context.targets.reduce((total, target) => total + target.end - target.start, 0),
            resultStatus: result.status,
            diagnostics: result.diagnostics,
        });
        try {
            await vscode.env.clipboard.writeText(report);
        } catch {
            show("error", "safeReportCopyFailed");
            return false;
        }
        show("info", "safeReportCopied");
        return true;
    }

    function withProgress<T>(title: VscodeMessageKey, task: (token: vscode.CancellationToken) => Promise<T>): Thenable<T> {
        return vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: messages.text(title), cancellable: true },
            (_progress, token) => task(token)
        );
    }

    return [
        vscode.commands.registerCommand("sqlBeautify.formatSql", (explicit?: unknown) =>
            withProgress("formattingSql", (token) => formatSql(explicit, token))),
        vscode.commands.registerCommand("sqlBeautify.formatHiveDdl", () =>
            withProgress("formattingHiveDdl", (token) => ddlCommand("hive-ddl", token))),
        vscode.commands.registerCommand("sqlBeautify.extractHiveDdl", () =>
            withProgress("extractingHiveDdl", (token) => ddlCommand("extract", token))),
        vscode.commands.registerCommand("sqlBeautify.copySafeDiagnosticReport", () =>
            withProgress("preparingSafeReport", copySafeDiagnosticReport)),
    ];
}
