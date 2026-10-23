import * as vscode from "vscode";

import type { CanonicalFormatOptions, UnsupportedSyntaxPolicy } from "../core/config/options";
import type { RenderNewline, RenderTabSize } from "../core/renderer/environment";
import { CANCELLED_RESULT, type EditExecutor } from "../edits/executor";
import { applyEdits } from "../edits/offsets";
import type { ComputeRequest, ComputeResult, EditSelection, EditTarget } from "../edits/types";
import { commandOptions, documentNewline, isSupported, readConfiguration, renderTabSize } from "./config";
import { diagnosticsForEditor, hostDiagnostic, logDebug, type Diagnostics } from "./diagnostics";
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

function hostRejection(code: string, severity: "warning" | "error", message: string): ComputeResult {
    return { status: "rejected", edits: [], selections: [], diagnostics: [hostDiagnostic(code, severity, message)], debugEvents: [] };
}

function staleDocument(): ComputeResult {
    return hostRejection("ADAPTER_STALE_DOCUMENT", "warning", "The document changed before edits could be applied");
}

function isCurrent(context: CommandContext): boolean {
    return context.editor.document === context.document &&
        context.document.version === context.version &&
        context.document.getText() === context.source;
}

/** What the commands share. */
interface Host {
    readonly executor: EditExecutor;
    readonly diagnostics: Diagnostics;
    readonly messages: VscodeMessages;
    readonly extensionVersion: string;
}

function show(host: Host, kind: "info" | "warning" | "error", key: VscodeMessageKey, values?: Parameters<VscodeMessages["text"]>[1]): void {
    const text = host.messages.text(key, values);
    void (kind === "info"
        ? vscode.window.showInformationMessage(text)
        : kind === "warning" ? vscode.window.showWarningMessage(text) : vscode.window.showErrorMessage(text));
}

function commandContext(host: Host): CommandContext | null {
    const editor = vscode.window.activeTextEditor;
    if (editor === undefined || !isSupported(editor.document)) {
        show(host, "warning", "activeSqlEditor");
        return null;
    }
    const document = editor.document;
    const configuration = readConfiguration(document);
    if (!configuration.ok) {
        show(host, "error", "configurationInvalid", { optionKey: configuration.optionKey });
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
async function apply(
    host: Host,
    context: CommandContext,
    result: ComputeResult,
    policy: UnsupportedSyntaxPolicy
): Promise<ComputeResult> {
    if (!isCurrent(context)) {
        return staleDocument();
    }
    const { editor, document } = context;
    const output = applyEdits(context.source, result.edits);
    host.diagnostics.stage(document, output, result.diagnostics, policy);
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
    // editor.edit resolves false when the document changed meanwhile or the editor is hidden, throws
    // when it is closed, and resolves true without editing a read-only editor (K24).
    if (!applied || document.getText() !== output) {
        host.diagnostics.drop(document);
        return isCurrent(context)
            ? hostRejection("ADAPTER_EDIT_REJECTED", "error", "The editor rejected the formatting edits")
            : staleDocument();
    }
    if (result.selections.length > 0) {
        // The edit is applied, so the document positions are in output coordinates.
        editor.selections = result.selections.map((selection) =>
            new vscode.Selection(document.positionAt(selection.anchor), document.positionAt(selection.active))
        );
    }
    host.diagnostics.confirm(document);
    return result;
}

async function run(
    host: Host,
    context: CommandContext,
    computeRequest: ComputeRequest,
    policy: UnsupportedSyntaxPolicy,
    phase: string,
    token: vscode.CancellationToken
): Promise<ComputeResult> {
    host.diagnostics.drop(context.document);
    const computed = await host.executor.run(computeRequest, token);
    // Cancellation during computation wins over any result.
    const result = token.isCancellationRequested
        ? CANCELLED_RESULT
        : computed.status === "ready" ? await apply(host, context, computed, policy) : computed;
    logDebug(context.debug, phase, context.document, context.version, result);
    if (result.status !== "ready" && isCurrent(context)) {
        host.diagnostics.publish(context.document, result.diagnostics, policy);
    }
    return result;
}

function reportFormat(host: Host, result: ComputeResult, policy: UnsupportedSyntaxPolicy): void {
    if (policy === "preserve" && (result.status === "unchanged" || result.status === "rejected")) {
        const preserved = diagnosticsForEditor(result.diagnostics.filter((item) => item.capabilityId !== null));
        if (preserved.length > 0) {
            show(host, "info", preserved.some((item) => item.capabilityId === "hive-ddl") ? "preservedHiveDdl" : "unmodeledRegions",
                { count: preserved.length });
            return;
        }
    }
    if (result.status === "cancelled") {
        show(host, "info", "formatCancelled");
    } else if (result.status === "rejected") {
        const codes = result.diagnostics.map((item) => item.code);
        if (codes.includes("ADAPTER_STALE_DOCUMENT")) {
            show(host, "info", "documentChanged");
        } else if (codes.some((code) => RANGE_CODES.has(code))) {
            show(host, "warning", "rangeRejected");
        } else if (codes.includes("ADAPTER_INPUT_LIMIT")) {
            show(host, "warning", "inputLimitRejected");
        } else if (codes.includes("ADAPTER_WORKER_CRASH")) {
            show(host, "warning", "workerRejected");
        } else if (codes.includes("ADAPTER_EDIT_REJECTED")) {
            show(host, "warning", "editRejected");
        } else {
            show(host, "warning", "formatRejected");
        }
    }
}

function reportDdl(host: Host, result: ComputeResult): void {
    if (result.status === "cancelled") {
        show(host, "info", "formatCancelled");
    } else if (result.status === "rejected") {
        const codes = result.diagnostics.map((item) => item.code);
        if (codes.includes("ADAPTER_STALE_DOCUMENT")) {
            show(host, "info", "documentChanged");
        } else if (codes.includes("ADAPTER_EDIT_REJECTED")) {
            show(host, "warning", "editRejected");
        } else {
            show(host, "warning", "ddlRejected");
        }
    }
}

async function formatSql(host: Host, explicit: unknown, token: vscode.CancellationToken): Promise<ComputeResult | null> {
    const context = commandContext(host);
    if (context === null) {
        return null;
    }
    const resolved = commandOptions(context.options, explicit);
    if (!resolved.ok) {
        show(host, "error", "commandOptionsInvalid", { optionKey: resolved.optionKey });
        return null;
    }
    const policy = resolved.options.unsupportedSyntaxPolicy;
    const computeRequest: ComputeRequest = { ...request(context), op: "format", options: resolved.options };
    const result = await run(host, context, computeRequest, policy, "command-format", token);
    reportFormat(host, result, policy);
    return result;
}

async function ddlCommand(host: Host, op: "hive-ddl" | "extract", token: vscode.CancellationToken): Promise<ComputeResult | null> {
    const context = commandContext(host);
    if (context === null) {
        return null;
    }
    const { keywordCase, commaStyle, indentStyle, maxAlignWidth } = context.options;
    const computeRequest: ComputeRequest = op === "hive-ddl"
        ? { ...request(context), op, options: { keywordCase, commaStyle, indentStyle, maxAlignWidth } }
        : { ...request(context), op, options: undefined };
    const phase = op === "hive-ddl" ? "hive-ddl" : "extract-hive-ddl";
    const result = await run(host, context, computeRequest, context.options.unsupportedSyntaxPolicy, phase, token);
    reportDdl(host, result);
    return result;
}

/** Copies the codes and counts of a format of the selection; never any SQL (D3 removes this in P4b). */
async function copySafeDiagnosticReport(host: Host, token: vscode.CancellationToken): Promise<boolean> {
    const context = commandContext(host);
    if (context === null) {
        return false;
    }
    const result = await host.executor.run({ ...request(context), op: "format", options: context.options }, token);
    if (token.isCancellationRequested) {
        show(host, "info", "safeReportCancelled");
        return false;
    }
    if (vscode.window.activeTextEditor !== context.editor || !isCurrent(context)) {
        show(host, "info", "safeReportStale");
        return false;
    }
    const report = renderSafeDiagnosticReport({
        extensionVersion: host.extensionVersion,
        dialect: context.options.dialect,
        sourceCodeUnits: context.targets.reduce((total, target) => total + target.end - target.start, 0),
        resultStatus: result.status,
        diagnostics: result.diagnostics,
    });
    try {
        await vscode.env.clipboard.writeText(report);
    } catch {
        show(host, "error", "safeReportCopyFailed");
        return false;
    }
    show(host, "info", "safeReportCopied");
    return true;
}

export function registerCommands(
    executor: EditExecutor,
    diagnostics: Diagnostics,
    messages: VscodeMessages,
    extensionVersion: string
): vscode.Disposable[] {
    const host: Host = { executor, diagnostics, messages, extensionVersion };
    function withProgress<T>(title: VscodeMessageKey, task: (token: vscode.CancellationToken) => Promise<T>): Thenable<T> {
        return vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: messages.text(title), cancellable: true },
            (_progress, token) => task(token)
        );
    }
    return [
        vscode.commands.registerCommand("sqlBeautify.formatSql", (explicit?: unknown) =>
            withProgress("formattingSql", (token) => formatSql(host, explicit, token))),
        vscode.commands.registerCommand("sqlBeautify.formatHiveDdl", () =>
            withProgress("formattingHiveDdl", (token) => ddlCommand(host, "hive-ddl", token))),
        vscode.commands.registerCommand("sqlBeautify.extractHiveDdl", () =>
            withProgress("extractingHiveDdl", (token) => ddlCommand(host, "extract", token))),
        vscode.commands.registerCommand("sqlBeautify.copySafeDiagnosticReport", () =>
            withProgress("preparingSafeReport", (token) => copySafeDiagnosticReport(host, token))),
    ];
}
