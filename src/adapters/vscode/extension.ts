import type * as Vscode from "vscode";

import type {
    CanonicalFormatOptions,
    FormatOptions,
    UnsupportedSyntaxPolicy,
} from "../../core/config/options";
import type { ResolveFormatOptionsResult } from "../../core/config/resolve-options";
import {
    inferRenderNewline,
    type RenderNewline,
} from "../../core/renderer/environment";
import type { ExperimentalDdlOperation } from "../transaction/experimental-ddl";
import type {
    ExperimentalDdlTransactionRequest,
    ExperimentalDdlTransactionResult,
    ReadyExperimentalDdlTransaction,
} from "../transaction/experimental-ddl";
import type {
    DocumentSnapshot,
    HostCommit,
    HostTransactionRequest,
} from "../transaction/host-transaction";
import type {
    FormatSelection,
    FormatTarget,
    FormatTransactionRequest,
    FormatTransactionResult,
    FormatterExecutor,
    TransactionDiagnostic,
} from "../transaction/types";
import { wrapVscodeCancellationToken } from "./cancellation";
import {
    mergeExplicitFormatOptions,
    readVscodeFormatConfiguration,
} from "./config";
import { renderSafeDiagnosticReport } from "./safe-report";
import { formatterSelector, supportedLanguage } from "./supported-languages";

export interface V2ExtensionRuntime {
    readonly resolveFormatOptions: (
        input: FormatOptions | unknown
    ) => ResolveFormatOptionsResult;
    readonly prepareFormatTransaction: (
        request: FormatTransactionRequest,
        executor: FormatterExecutor
    ) => Promise<FormatTransactionResult>;
    readonly runHostTransaction: (
        request: HostTransactionRequest,
        executor: FormatterExecutor,
        commit: HostCommit
    ) => Promise<FormatTransactionResult>;
    readonly runExperimentalDdlTransaction: (
        request: ExperimentalDdlTransactionRequest,
        operation: ExperimentalDdlOperation,
        commit: {
            readonly currentDocument: () => DocumentSnapshot | null;
            readonly apply: (
                result: ReadyExperimentalDdlTransaction,
                expected: DocumentSnapshot
            ) => Promise<boolean>;
        }
    ) => Promise<ExperimentalDdlTransactionResult>;
    readonly formatHiveDdl: ExperimentalDdlOperation;
    readonly extractDdl: ExperimentalDdlOperation;
}

export interface VscodeExtensionSession {
    activate(context: Vscode.ExtensionContext): void;
    dispose(): Promise<void>;
}

export interface VscodeExtensionOptions {
    readonly extensionVersion: string;
}

type AnyTransactionResult = FormatTransactionResult | ExperimentalDdlTransactionResult;
const FORMATTER_SELECTOR = formatterSelector();

function documentRenderNewline(
    vscode: typeof Vscode,
    document: Vscode.TextDocument,
    source: string
): RenderNewline {
    let fallback: RenderNewline = "\n";
    try {
        if (document.eol === vscode.EndOfLine.CRLF) {
            fallback = "\r\n";
        }
    } catch {
        fallback = "\n";
    }
    return inferRenderNewline(source, fallback);
}

function snapshotDocument(document: Vscode.TextDocument): DocumentSnapshot | null {
    try {
        return Object.freeze({
            identity: document,
            source: document.getText(),
            version: document.version,
        });
    } catch {
        return null;
    }
}

function documentTarget(document: Vscode.TextDocument): FormatTarget | null {
    try {
        const sourceLength = document.getText().length;
        return Object.freeze({
            id: "document",
            start: 0,
            end: sourceLength,
            mode: "document" as const,
        });
    } catch {
        return null;
    }
}

interface SelectionTargetSet {
    readonly targets: readonly FormatTarget[];
    readonly selections: readonly FormatSelection[];
}

function selectionTargets(editor: Vscode.TextEditor): SelectionTargetSet | null {
    try {
        const selections = Array.from(editor.selections);
        const nonEmpty = selections.filter((selection) => !selection.isEmpty);
        if (nonEmpty.length === 0) {
            const target = documentTarget(editor.document);
            if (target === null) {
                return null;
            }
            return Object.freeze({
                targets: Object.freeze([target]),
                selections: Object.freeze(selections.map((selection, index) =>
                    Object.freeze({
                        id: `cursor:${String(index)}`,
                        targetId: target.id,
                        anchor: editor.document.offsetAt(selection.anchor),
                        active: editor.document.offsetAt(selection.active),
                    })
                )),
            });
        }
        const targets = nonEmpty.map((selection, index) => {
            const start = editor.document.offsetAt(selection.start);
            const end = editor.document.offsetAt(selection.end);
            return Object.freeze({
                id: `selection:${String(index)}`,
                start,
                end,
                mode: "fragment" as const,
            });
        });
        return Object.freeze({
            targets: Object.freeze(targets),
            selections: Object.freeze(selections.map((selection, index) => {
                const anchor = editor.document.offsetAt(selection.anchor);
                const active = editor.document.offsetAt(selection.active);
                const owner = targets.find((target) =>
                    target.start <= anchor && anchor <= target.end &&
                    target.start <= active && active <= target.end
                );
                return Object.freeze({
                    id: `cursor:${String(index)}`,
                    targetId: owner?.id ?? null,
                    anchor,
                    active,
                });
            })),
        });
    } catch {
        return null;
    }
}

function ddlTargets(
    targets: readonly FormatTarget[]
): ExperimentalDdlTransactionRequest["targets"] {
    return Object.freeze(targets.map((target) => Object.freeze({
        id: target.id,
        start: target.start,
        end: target.end,
    })));
}

function sourceCodeUnits(targets: readonly FormatTarget[]): number {
    return targets.reduce((total, target) => total + target.end - target.start, 0);
}

function rejectedFormatTransaction(
    documentVersion: number,
    code: string,
    message: string
): Extract<FormatTransactionResult, { readonly status: "rejected" }> {
    return Object.freeze({
        status: "rejected" as const,
        documentVersion,
        diagnostics: Object.freeze([
            Object.freeze({
                code,
                severity: "error" as const,
                message,
                capabilityId: null,
                span: Object.freeze({ start: 0, end: 0 }),
                recovery: "preserve-target" as const,
                targetId: null,
            }),
        ]),
    });
}

function rejectedDdlTransaction(
    documentVersion: number,
    code: string,
    message: string
): Extract<ExperimentalDdlTransactionResult, { readonly status: "rejected" }> {
    return Object.freeze({
        status: "rejected" as const,
        documentVersion,
        diagnostics: Object.freeze([
            Object.freeze({
                code,
                severity: "error" as const,
                message,
                capabilityId: null,
                span: Object.freeze({ start: 0, end: 0 }),
                recovery: "preserve-target" as const,
                targetId: null,
            }),
        ]),
    });
}

function applyTransactionEdits(
    source: string,
    edits: readonly { readonly start: number; readonly end: number; readonly text: string }[]
): string | null {
    let output = source;
    const ordered = Array.from(edits).sort((left, right) => right.start - left.start);
    let previousStart = source.length + 1;
    for (const edit of ordered) {
        if (
            !Number.isSafeInteger(edit.start) ||
            !Number.isSafeInteger(edit.end) ||
            edit.start < 0 ||
            edit.end < edit.start ||
            edit.end > source.length ||
            edit.end > previousStart
        ) {
            return null;
        }
        output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
        previousStart = edit.start;
    }
    return output;
}

function positionAtText(
    vscode: typeof Vscode,
    source: string,
    offset: number
): Vscode.Position {
    let line = 0;
    let lineStart = 0;
    const bounded = Math.max(0, Math.min(offset, source.length));
    for (let index = 0; index < bounded; index += 1) {
        if (source[index] === "\n") {
            line += 1;
            lineStart = index + 1;
        }
    }
    return new vscode.Position(line, bounded - lineStart);
}

export function createVscodeExtension(
    vscode: typeof Vscode,
    runtime: V2ExtensionRuntime,
    executor: FormatterExecutor,
    options: VscodeExtensionOptions
): VscodeExtensionSession {
    const diagnostics = vscode.languages.createDiagnosticCollection("sqlBeautify");
    let activated = false;
    let disposed = false;
    let diagnosticGeneration = 0;
    const latestDiagnosticGeneration = new Map<string, number>();

    function documentKey(document: Vscode.TextDocument): string | null {
        try {
            return document.uri.toString();
        } catch {
            return null;
        }
    }

    function beginDiagnosticRequest(document: Vscode.TextDocument): number {
        diagnosticGeneration += 1;
        const generation = diagnosticGeneration;
        const key = documentKey(document);
        if (key !== null) {
            latestDiagnosticGeneration.set(key, generation);
        }
        return generation;
    }

    function invalidateDiagnostics(document: Vscode.TextDocument): void {
        if (disposed) {
            return;
        }
        const key = documentKey(document);
        if (key !== null) {
            latestDiagnosticGeneration.set(key, ++diagnosticGeneration);
            try {
                diagnostics.delete(document.uri);
            } catch {
                return;
            }
        }
    }

    function isCurrentDiagnosticRequest(
        document: Vscode.TextDocument,
        generation: number
    ): boolean {
        const key = documentKey(document);
        return key !== null && latestDiagnosticGeneration.get(key) === generation;
    }

    function configuration(document: Vscode.TextDocument): Readonly<{
        options: CanonicalFormatOptions;
        debugDiagnostics: boolean;
    }> | null {
        const configured = readVscodeFormatConfiguration(vscode, document);
        if (configured === null) {
            return null;
        }
        try {
            const resolved = runtime.resolveFormatOptions(configured.options);
            return resolved.ok
                ? Object.freeze({
                    options: resolved.options,
                    debugDiagnostics: configured.debugDiagnostics,
                })
                : null;
        } catch {
            return null;
        }
    }

    function commandOptions(
        configured: FormatOptions,
        explicit: unknown
    ): CanonicalFormatOptions | null {
        const merged = mergeExplicitFormatOptions(configured, explicit);
        if (merged === null) {
            return null;
        }
        try {
            const resolved = runtime.resolveFormatOptions(merged);
            return resolved.ok ? resolved.options : null;
        } catch {
            return null;
        }
    }

    async function withCommandCancellation<T>(
        title: string,
        operation: (token: Vscode.CancellationToken) => Promise<T>
    ): Promise<T> {
        return await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title,
                cancellable: true,
            },
            async (_progress, token) => await operation(token)
        );
    }

    function debugSummary(
        document: Vscode.TextDocument,
        result: AnyTransactionResult,
        debugDiagnostics: boolean,
        phase: string
    ): void {
        if (!debugDiagnostics) {
            return;
        }
        const counts: Record<string, number> = Object.create(null) as Record<string, number>;
        for (const diagnostic of result.diagnostics) {
            counts[diagnostic.code] = (counts[diagnostic.code] ?? 0) + 1;
        }
        console.warn("[SQL Beautify]", Object.freeze({
            phase,
            languageId: supportedLanguage(document.languageId)?.languageId ?? "unsupported",
            documentVersion: result.documentVersion,
            status: result.status,
            diagnosticCodes: Object.freeze({ ...counts }),
        }));
    }

    function publishDiagnostics(
        document: Vscode.TextDocument,
        result: AnyTransactionResult,
        unsupportedSyntaxPolicy: UnsupportedSyntaxPolicy,
        debugDiagnostics: boolean,
        phase: string,
        generation: number,
        sourceStable: boolean
    ): void {
        if (!isCurrentDiagnosticRequest(document, generation)) {
            return;
        }
        const converted: Vscode.Diagnostic[] = [];
        for (const item of result.diagnostics) {
            if (
                unsupportedSyntaxPolicy === "preserve" &&
                item.severity === "warning" &&
                item.capabilityId !== null
            ) {
                continue;
            }
            const severity = item.severity === "error"
                ? vscode.DiagnosticSeverity.Error
                : item.severity === "warning"
                    ? vscode.DiagnosticSeverity.Warning
                    : vscode.DiagnosticSeverity.Information;
            const start = sourceStable
                ? Math.max(0, Math.min(item.span.start, document.getText().length))
                : 0;
            const end = sourceStable
                ? Math.max(start, Math.min(item.span.end, document.getText().length))
                : 0;
            const diagnostic = new vscode.Diagnostic(
                new vscode.Range(document.positionAt(start), document.positionAt(end)),
                item.message,
                severity
            );
            diagnostic.code = item.code;
            diagnostic.source = "SQL Beautify";
            converted.push(diagnostic);
        }
        diagnostics.set(document.uri, converted);
        debugSummary(document, result, debugDiagnostics, phase);
    }

    function reportCommandFailure(result: AnyTransactionResult): void {
        if (result.status === "rejected") {
            void vscode.window.showWarningMessage(
                "SQL Beautify did not modify the document because formatting was not safe."
            );
        }
    }

    async function prepareProvider(
        document: Vscode.TextDocument,
        target: FormatTarget,
        token: Vscode.CancellationToken,
        phase: string
    ): Promise<Vscode.TextEdit[]> {
        const current = configuration(document);
        if (current === null || supportedLanguage(document.languageId) === null) {
            return [];
        }
        const generation = beginDiagnosticRequest(document);
        const capturedSource = document.getText();
        const capturedVersion = document.version;
        const cancellation = wrapVscodeCancellationToken(token);
        let result: FormatTransactionResult;
        try {
            result = await runtime.prepareFormatTransaction({
                source: capturedSource,
                documentVersion: capturedVersion,
                targets: Object.freeze([target]),
                options: current.options,
                newline: documentRenderNewline(vscode, document, capturedSource),
                ...(cancellation === undefined ? {} : { cancellation }),
            }, executor);
        } catch {
            result = rejectedFormatTransaction(
                capturedVersion,
                "ADAPTER_PROVIDER_FAILED",
                "Formatter provider failed safely"
            );
        }
        let cancelled = false;
        try {
            cancelled = token.isCancellationRequested === true;
        } catch {
            cancelled = true;
        }
        const after = snapshotDocument(document);
        const currentGeneration = isCurrentDiagnosticRequest(document, generation);
        if (
            cancelled ||
            after === null ||
            after.version !== capturedVersion ||
            after.source !== capturedSource ||
            !currentGeneration
        ) {
            if (currentGeneration) {
                invalidateDiagnostics(document);
            }
            return [];
        }
        publishDiagnostics(
            document,
            result,
            current.options.unsupportedSyntaxPolicy,
            current.debugDiagnostics,
            phase,
            generation,
            true
        );
        if (result.status !== "ready") {
            return [];
        }
        return result.edits.map((edit) => vscode.TextEdit.replace(
            new vscode.Range(document.positionAt(edit.start), document.positionAt(edit.end)),
            edit.text
        ));
    }

    function currentDocument(
        editor: Vscode.TextEditor,
        expected: Vscode.TextDocument
    ): DocumentSnapshot | null {
        return editor.document === expected ? snapshotDocument(expected) : null;
    }

    function queryCommit(
        editor: Vscode.TextEditor,
        document: Vscode.TextDocument
    ): HostCommit {
        return Object.freeze({
            currentDocument: () => currentDocument(editor, document),
            apply: async (
                result: Extract<FormatTransactionResult, { readonly status: "ready" }>,
                expected: DocumentSnapshot
            ) => {
                const outputSource = applyTransactionEdits(expected.source, result.edits);
                if (outputSource === null) {
                    return false;
                }
                if (result.selections.some((selection) =>
                    !Number.isSafeInteger(selection.selectionAnchor) ||
                    !Number.isSafeInteger(selection.selectionActive) ||
                    selection.selectionAnchor < 0 ||
                    selection.selectionActive < 0 ||
                    selection.selectionAnchor > outputSource.length ||
                    selection.selectionActive > outputSource.length
                )) {
                    return false;
                }
                let mappedSelections: Vscode.Selection[];
                try {
                    mappedSelections = result.selections.map((selection) => new vscode.Selection(
                        positionAtText(vscode, outputSource, selection.selectionAnchor),
                        positionAtText(vscode, outputSource, selection.selectionActive)
                    ));
                } catch {
                    return false;
                }
                const applied = await editor.edit((builder) => {
                    for (const edit of result.edits) {
                        builder.replace(
                            new vscode.Range(
                                document.positionAt(edit.start),
                                document.positionAt(edit.end)
                            ),
                            edit.text
                        );
                    }
                });
                if (applied === true) {
                    try {
                        editor.selections = mappedSelections;
                    } catch {
                        void vscode.window.showWarningMessage(
                            "SQL Beautify formatted the document but could not restore the selection."
                        );
                    }
                }
                return applied;
            },
        });
    }

    function ddlCommit(
        editor: Vscode.TextEditor,
        document: Vscode.TextDocument
    ): {
        readonly currentDocument: () => DocumentSnapshot | null;
        readonly apply: (
            result: ReadyExperimentalDdlTransaction,
            expected: DocumentSnapshot
        ) => Promise<boolean>;
    } {
        return Object.freeze({
            currentDocument: () => currentDocument(editor, document),
            apply: async (result) => await editor.edit((builder) => {
                for (const edit of result.edits) {
                    builder.replace(
                        new vscode.Range(
                            document.positionAt(edit.start),
                            document.positionAt(edit.end)
                        ),
                        edit.text
                    );
                }
            }),
        });
    }

    async function runQueryCommand(
        explicitOptions: unknown,
        token: Vscode.CancellationToken
    ): Promise<FormatTransactionResult | null> {
        const editor = vscode.window.activeTextEditor;
        if (editor === undefined || supportedLanguage(editor.document.languageId) === null) {
            void vscode.window.showWarningMessage("SQL Beautify requires an active SQL editor.");
            return null;
        }
        const expected = snapshotDocument(editor.document);
        const selectionSet = selectionTargets(editor);
        const current = configuration(editor.document);
        if (expected === null || selectionSet === null || current === null) {
            void vscode.window.showErrorMessage("SQL Beautify could not read the editor state safely.");
            return null;
        }
        const commandOptionsValue = commandOptions(current.options, explicitOptions);
        if (commandOptionsValue === null) {
            void vscode.window.showErrorMessage("SQL Beautify command options are invalid.");
            return null;
        }
        const generation = beginDiagnosticRequest(editor.document);
        const cancellation = wrapVscodeCancellationToken(token);
        let result: FormatTransactionResult;
        try {
            result = await runtime.runHostTransaction({
                document: expected,
                targets: selectionSet.targets,
                selections: selectionSet.selections,
                options: commandOptionsValue,
                newline: documentRenderNewline(
                    vscode,
                    editor.document,
                    expected.source
                ),
                ...(cancellation === undefined ? {} : { cancellation }),
            }, executor, queryCommit(editor, editor.document));
        } catch {
            result = rejectedFormatTransaction(
                expected.version,
                "ADAPTER_COMMAND_FAILED",
                "Formatter command failed safely"
            );
        }
        const publishedGeneration = result.status === "ready" && result.edits.length > 0
            ? beginDiagnosticRequest(editor.document)
            : generation;
        publishDiagnostics(
            editor.document,
            result,
            commandOptionsValue.unsupportedSyntaxPolicy,
            current.debugDiagnostics,
            "command-format",
            publishedGeneration,
            !(result.status === "ready" && result.edits.length > 0)
        );
        reportCommandFailure(result);
        return result;
    }

    async function runDdlCommand(
        operation: ExperimentalDdlOperation,
        phase: string,
        token: Vscode.CancellationToken
    ): Promise<ExperimentalDdlTransactionResult | null> {
        const editor = vscode.window.activeTextEditor;
        const language = editor === undefined
            ? null
            : supportedLanguage(editor.document.languageId);
        if (
            editor === undefined ||
            language === null ||
            !language.supportsExperimentalDdl
        ) {
            void vscode.window.showWarningMessage("SQL Beautify requires an active SQL editor.");
            return null;
        }
        const expected = snapshotDocument(editor.document);
        const selectionSet = selectionTargets(editor);
        const current = configuration(editor.document);
        if (expected === null || selectionSet === null || current === null) {
            void vscode.window.showErrorMessage("SQL Beautify could not read the editor state safely.");
            return null;
        }
        const generation = beginDiagnosticRequest(editor.document);
        const cancellation = wrapVscodeCancellationToken(token);
        let result: ExperimentalDdlTransactionResult;
        try {
            result = await runtime.runExperimentalDdlTransaction({
                document: expected,
                targets: ddlTargets(selectionSet.targets),
                ...(cancellation === undefined ? {} : { cancellation }),
            }, operation, ddlCommit(editor, editor.document));
        } catch {
            result = rejectedDdlTransaction(
                expected.version,
                "ADAPTER_DDL_COMMAND_FAILED",
                "Experimental DDL command failed safely"
            );
        }
        const publishedGeneration = result.status === "ready" && result.edits.length > 0
            ? beginDiagnosticRequest(editor.document)
            : generation;
        publishDiagnostics(
            editor.document,
            result,
            current.options.unsupportedSyntaxPolicy,
            current.debugDiagnostics,
            phase,
            publishedGeneration,
            !(result.status === "ready" && result.edits.length > 0)
        );
        reportCommandFailure(result);
        return result;
    }

    async function copySafeDiagnosticReport(
        token: Vscode.CancellationToken
    ): Promise<boolean> {
        const editor = vscode.window.activeTextEditor;
        if (editor === undefined || supportedLanguage(editor.document.languageId) === null) {
            void vscode.window.showErrorMessage("SQL Beautify requires an active SQL editor.");
            return false;
        }
        const document = editor.document;
        const expected = snapshotDocument(document);
        const selectionSet = selectionTargets(editor);
        const current = configuration(document);
        if (expected === null || selectionSet === null || current === null) {
            void vscode.window.showErrorMessage("SQL Beautify could not read the editor state safely.");
            return false;
        }
        let result: FormatTransactionResult;
        const cancellation = wrapVscodeCancellationToken(token);
        try {
            result = await runtime.prepareFormatTransaction({
                source: expected.source,
                documentVersion: expected.version,
                targets: selectionSet.targets,
                selections: selectionSet.selections,
                options: current.options,
                newline: documentRenderNewline(vscode, document, expected.source),
                ...(cancellation === undefined ? {} : { cancellation }),
            }, executor);
        } catch {
            result = Object.freeze({
                status: "rejected" as const,
                documentVersion: expected.version,
                diagnostics: Object.freeze([]) as readonly TransactionDiagnostic[],
            });
        }
        let cancelled = false;
        try {
            cancelled = token.isCancellationRequested === true;
        } catch {
            cancelled = true;
        }
        const after = currentDocument(editor, document);
        if (
            cancelled ||
            vscode.window.activeTextEditor !== editor ||
            after === null ||
            after.identity !== expected.identity ||
            after.version !== expected.version ||
            after.source !== expected.source
        ) {
            return false;
        }
        const dialect = (current.options as { readonly dialect?: unknown }).dialect ?? "hive";
        const report = renderSafeDiagnosticReport({
            extensionVersion: options.extensionVersion,
            dialect,
            sourceCodeUnits: sourceCodeUnits(selectionSet.targets),
            resultStatus: result.status,
            diagnostics: result.diagnostics,
        });
        try {
            await vscode.env.clipboard.writeText(report);
            void vscode.window.showInformationMessage(
                "SQL Beautify safe diagnostic report copied."
            );
            return true;
        } catch {
            void vscode.window.showErrorMessage(
                "SQL Beautify could not copy the safe diagnostic report."
            );
            return false;
        }
    }

    return Object.freeze({
        activate(context: Vscode.ExtensionContext): void {
            if (activated || disposed) {
                return;
            }
            const registrations: Vscode.Disposable[] = [];
            try {
                registrations.push(vscode.workspace.onDidChangeTextDocument((event) => {
                    invalidateDiagnostics(event.document);
                }));
                registrations.push(vscode.languages.registerDocumentFormattingEditProvider(
                    FORMATTER_SELECTOR,
                    {
                        provideDocumentFormattingEdits: async (document, _formattingOptions, token) => {
                            const target = documentTarget(document);
                            return target === null
                                ? []
                                : await prepareProvider(document, target, token, "document-format");
                        },
                    }
                ));
                registrations.push(vscode.languages.registerDocumentRangeFormattingEditProvider(
                    FORMATTER_SELECTOR,
                    {
                        provideDocumentRangeFormattingEdits: async (
                            document,
                            range,
                            _formattingOptions,
                            token
                        ) => await prepareProvider(document, Object.freeze({
                            id: "range",
                            start: document.offsetAt(range.start),
                            end: document.offsetAt(range.end),
                            mode: "fragment" as const,
                        }), token, "range-format"),
                    }
                ));
                registrations.push(vscode.commands.registerCommand(
                    "sqlBeautify.formatSql",
                    async (explicitOptions?: unknown) => await withCommandCancellation(
                        "Formatting SQL",
                        async (token) => await runQueryCommand(explicitOptions, token)
                    )
                ));
                registrations.push(vscode.commands.registerCommand(
                    "sqlBeautify.formatHiveDdl",
                    async () => await withCommandCancellation(
                        "Formatting Hive DDL",
                        async (token) => await runDdlCommand(
                            runtime.formatHiveDdl,
                            "hive-ddl",
                            token
                        )
                    )
                ));
                registrations.push(vscode.commands.registerCommand(
                    "sqlBeautify.extractHiveDdl",
                    async () => await withCommandCancellation(
                        "Extracting Hive DDL",
                        async (token) => await runDdlCommand(
                            runtime.extractDdl,
                            "extract-hive-ddl",
                            token
                        )
                    )
                ));
                registrations.push(vscode.commands.registerCommand(
                    "sqlBeautify.copySafeDiagnosticReport",
                    async () => await withCommandCancellation(
                        "Preparing safe diagnostic report",
                        copySafeDiagnosticReport
                    )
                ));
                context.subscriptions.push(diagnostics, ...registrations);
                activated = true;
            } catch (error) {
                for (let index = registrations.length - 1; index >= 0; index -= 1) {
                    try {
                        registrations[index]!.dispose();
                    } catch {
                        continue;
                    }
                }
                throw error;
            }
        },
        async dispose(): Promise<void> {
            if (disposed) {
                return;
            }
            disposed = true;
            diagnostics.dispose();
            await executor.dispose();
        },
    });
}
