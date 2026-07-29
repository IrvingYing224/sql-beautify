import type * as Vscode from "vscode";

import type {
    CanonicalFormatOptions,
    FormatOptions,
    UnsupportedSyntaxPolicy,
} from "../../core/config/options";
import type { ResolveFormatOptionsResult } from "../../core/config/resolve-options";
import type {
    FormatConfigFailureCode,
    FormatOptionKey,
} from "../../core/config/resolve-options";
import {
    DEFAULT_RENDER_TAB_SIZE,
    inferRenderNewline,
    isRenderTabSize,
    type RenderNewline,
    type RenderTabSize,
} from "../../core/renderer/environment";
import { diagnosticsForEditor } from "../diagnostics/presentation";
import { safeDiagnosticMessage } from "../diagnostics/safe-messages";
import {
    buildTextLineIndex,
    positionAtOffset,
} from "../text/line-index";
import {
    mapOffsetsThroughEdits,
    previewTextEdits,
    type TextEditPreview,
} from "../transaction/edit-preview";
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
import { createRejectedTransaction } from "../transaction/rejected";
import { wrapVscodeCancellationToken } from "./cancellation";
import {
    mergeExplicitFormatOptions,
    readVscodeFormatConfiguration,
} from "./config";
import { renderSafeDiagnosticReport } from "./safe-report";
import { formatterSelector, supportedLanguage } from "./supported-languages";
import { createVscodeMessages } from "./messages";

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
const WORKER_REJECTION_CODES: ReadonlySet<string> = new Set([
    "ADAPTER_WORKER_BACKPRESSURE",
    "ADAPTER_WORKER_CRASH",
    "ADAPTER_WORKER_FORMAT_FAILED",
    "ADAPTER_WORKER_PROTOCOL",
    "ADAPTER_WORKER_RESULT_CONTRACT",
    "ADAPTER_WORKER_RUNTIME_MISMATCH",
    "ADAPTER_WORKER_STALE_RESPONSE",
    "ADAPTER_WORKER_TIMEOUT",
    "ADAPTER_WORKER_UNAVAILABLE",
]);
const RANGE_REJECTION_CODES: ReadonlySet<string> = new Set([
    "ADAPTER_RANGE_TARGET",
    "ADAPTER_RANGE_DOCUMENT",
    "ADAPTER_RANGE_LINE",
    "ADAPTER_RANGE_PROTECTED",
    "ADAPTER_RANGE_EMPTY",
    "ADAPTER_RANGE_ANALYSIS",
    "ADAPTER_RANGE_OPAQUE",
    "ADAPTER_RANGE_OWNERSHIP",
]);

interface ExtensionConfigurationSuccess {
    readonly ok: true;
    readonly options: CanonicalFormatOptions;
    readonly debugDiagnostics: boolean;
}

interface ExtensionConfigurationFailure {
    readonly ok: false;
    readonly code: FormatConfigFailureCode;
    readonly optionKey: FormatOptionKey | null;
}

type ExtensionConfiguration =
    | ExtensionConfigurationSuccess
    | ExtensionConfigurationFailure;

function configurationFailure(
    code: FormatConfigFailureCode,
    optionKey: FormatOptionKey | null = null
): ExtensionConfigurationFailure {
    return Object.freeze({ ok: false, code, optionKey });
}

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

function editorRenderTabSize(
    editor: Vscode.TextEditor | undefined,
    formattingOptions?: Vscode.FormattingOptions
): RenderTabSize {
    try {
        const candidate = formattingOptions?.tabSize ?? editor?.options.tabSize;
        return isRenderTabSize(candidate)
            ? candidate
            : DEFAULT_RENDER_TAB_SIZE;
    } catch {
        return DEFAULT_RENDER_TAB_SIZE;
    }
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

function documentTarget(sourceLength: number): FormatTarget {
    return Object.freeze({
        id: "document",
        start: 0,
        end: sourceLength,
        mode: "document" as const,
    });
}

interface SelectionTargetSet {
    readonly targets: readonly FormatTarget[];
    readonly selections: readonly FormatSelection[];
}

function selectionTargets(
    editor: Vscode.TextEditor,
    sourceLength: number
): SelectionTargetSet | null {
    try {
        const selections = Array.from(editor.selections);
        const records = selections.map((selection, index) => {
            const anchor = editor.document.offsetAt(selection.anchor);
            const active = editor.document.offsetAt(selection.active);
            return {
                index,
                anchor,
                active,
                start: Math.min(anchor, active),
                end: Math.max(anchor, active),
                isEmpty: selection.isEmpty,
            };
        });
        const nonEmpty = records.filter((record) => !record.isEmpty);
        if (nonEmpty.length === 0) {
            const target = documentTarget(sourceLength);
            return Object.freeze({
                targets: Object.freeze([target]),
                selections: Object.freeze(records.map((record) =>
                    Object.freeze({
                        id: `cursor:${String(record.index)}`,
                        targetId: target.id,
                        anchor: record.anchor,
                        active: record.active,
                    })
                )),
            });
        }
        const targets = nonEmpty.map((record, index) => Object.freeze({
                id: `selection:${String(index)}`,
                start: record.start,
                end: record.end,
                mode: "fragment" as const,
            })).sort((left, right) =>
                left.start - right.start ||
                left.end - right.end ||
                left.id.localeCompare(right.id)
            );
        const orderedRecords = records.slice().sort((left, right) =>
            left.end - right.end || left.start - right.start || left.index - right.index
        );
        const ownerBySelectionIndex = new Map<number, string>();
        let targetIndex = 0;
        for (const record of orderedRecords) {
            while (
                targetIndex < targets.length &&
                targets[targetIndex]!.end < record.end
            ) {
                targetIndex += 1;
            }
            const target = targets[targetIndex];
            if (
                target !== undefined &&
                target.start <= record.start &&
                record.end <= target.end
            ) {
                ownerBySelectionIndex.set(record.index, target.id);
            }
        }
        return Object.freeze({
            targets: Object.freeze(targets),
            selections: Object.freeze(records.map((record) => Object.freeze({
                id: `cursor:${String(record.index)}`,
                targetId: ownerBySelectionIndex.get(record.index) ?? null,
                anchor: record.anchor,
                active: record.active,
            }))),
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
    _message: string,
    optionKey?: FormatOptionKey | null
): Extract<FormatTransactionResult, { readonly status: "rejected" }> {
    return createRejectedTransaction(documentVersion, [
            Object.freeze({
                code,
                severity: "error" as const,
                message: safeDiagnosticMessage(code, null, optionKey),
                capabilityId: null,
                span: Object.freeze({ start: 0, end: 0 }),
                recovery: "preserve-target" as const,
                targetId: null,
            }),
        ]);
}

function rejectedDdlTransaction(
    documentVersion: number,
    code: string,
    _message: string
): Extract<ExperimentalDdlTransactionResult, { readonly status: "rejected" }> {
    return createRejectedTransaction(documentVersion, [
            Object.freeze({
                code,
                severity: "error" as const,
                message: safeDiagnosticMessage(code, null),
                capabilityId: null,
                span: Object.freeze({ start: 0, end: 0 }),
                recovery: "preserve-target" as const,
                targetId: null,
            }),
        ]);
}

export function createVscodeExtension(
    vscode: typeof Vscode,
    runtime: V2ExtensionRuntime,
    executor: FormatterExecutor,
    options: VscodeExtensionOptions
): VscodeExtensionSession {
    const diagnostics = vscode.languages.createDiagnosticCollection("sqlBeautify");
    const messages = createVscodeMessages(vscode.env.language);
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

    function closeDiagnostics(document: Vscode.TextDocument): void {
        if (disposed) {
            return;
        }
        const key = documentKey(document);
        if (key === null) {
            return;
        }
        latestDiagnosticGeneration.delete(key);
        try {
            diagnostics.delete(document.uri);
        } catch {
            return;
        }
    }

    function isCurrentDiagnosticRequest(
        document: Vscode.TextDocument,
        generation: number
    ): boolean {
        const key = documentKey(document);
        return key !== null && latestDiagnosticGeneration.get(key) === generation;
    }

    function configuration(
        document: Vscode.TextDocument
    ): ExtensionConfiguration {
        const configured = readVscodeFormatConfiguration(vscode, document);
        if (configured === null) {
            return configurationFailure("CFG_OPTIONS_READ");
        }
        try {
            const resolved = runtime.resolveFormatOptions(configured.options);
            return resolved.ok
                ? Object.freeze({
                    ok: true as const,
                    options: resolved.options,
                    debugDiagnostics: configured.debugDiagnostics,
                })
                : configurationFailure(resolved.code, resolved.optionKey);
        } catch {
            return configurationFailure("CFG_OPTIONS_READ");
        }
    }

    function commandOptions(
        configured: FormatOptions,
        explicit: unknown
    ): ResolveFormatOptionsResult {
        const merged = mergeExplicitFormatOptions(configured, explicit);
        if (merged === null) {
            return Object.freeze({
                ok: false as const,
                code: "CFG_OPTIONS_SHAPE" as const,
                message: "Command options must be a plain data object",
                optionKey: null,
            });
        }
        try {
            return runtime.resolveFormatOptions(merged);
        } catch {
            return Object.freeze({
                ok: false as const,
                code: "CFG_OPTIONS_READ" as const,
                message: "Command options could not be inspected",
                optionKey: null,
            });
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
        if ("debugEvents" in result && Array.isArray(result.debugEvents)) {
            for (const event of result.debugEvents) {
                console.warn("[SQL Beautify debug]", event);
            }
        }
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
        let sourceLength = 0;
        if (sourceStable) {
            try {
                sourceLength = document.getText().length;
            } catch {
                return;
            }
        }
        const visible = diagnosticsForEditor(result.diagnostics.filter((item) => !(
            unsupportedSyntaxPolicy === "preserve" &&
            item.severity === "warning" &&
            item.capabilityId !== null
        )));
        const converted: Vscode.Diagnostic[] = [];
        for (const item of visible) {
            const severity = item.severity === "error"
                ? vscode.DiagnosticSeverity.Error
                : item.severity === "warning"
                    ? vscode.DiagnosticSeverity.Warning
                    : vscode.DiagnosticSeverity.Information;
            const start = sourceStable
                ? Math.max(0, Math.min(item.span.start, sourceLength))
                : 0;
            const end = sourceStable
                ? Math.max(start, Math.min(item.span.end, sourceLength))
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

    function reportQueryCommandResult(
        result: FormatTransactionResult,
        unsupportedSyntaxPolicy: UnsupportedSyntaxPolicy
    ): void {
        if (
            unsupportedSyntaxPolicy === "preserve" &&
            (result.status === "unchanged" || result.status === "rejected")
        ) {
            const capabilities = diagnosticsForEditor(result.diagnostics.filter((item) =>
                item.capabilityId !== null
            ));
            if (capabilities.length > 0) {
                const containsHiveDdl = capabilities.some((item) =>
                    item.capabilityId === "hive-ddl"
                );
                void vscode.window.showInformationMessage(
                    containsHiveDdl
                        ? messages.text("preservedHiveDdl")
                        : messages.text("unmodeledRegions", {
                              count: capabilities.length,
                          })
                );
                return;
            }
        }
        if (result.status === "cancelled") {
            void vscode.window.showInformationMessage(
                messages.text("formatCancelled")
            );
            return;
        }
        if (result.status === "rejected") {
            const codes = new Set(result.diagnostics.map((item) => item.code));
            if (codes.has("ADAPTER_STALE_DOCUMENT")) {
                void vscode.window.showInformationMessage(
                    messages.text("documentChanged")
                );
                return;
            }
            if (Array.from(codes).some((code) => RANGE_REJECTION_CODES.has(code))) {
                void vscode.window.showWarningMessage(
                    messages.text("rangeRejected")
                );
                return;
            }
            if (codes.has("ADAPTER_SELECTION_MAP")) {
                void vscode.window.showWarningMessage(
                    messages.text("selectionMapRejected")
                );
                return;
            }
            if (codes.has("ADAPTER_INPUT_LIMIT")) {
                void vscode.window.showWarningMessage(
                    messages.text("inputLimitRejected")
                );
                return;
            }
            if (Array.from(codes).some((code) => WORKER_REJECTION_CODES.has(code))) {
                void vscode.window.showWarningMessage(
                    messages.text("workerRejected")
                );
                return;
            }
            if (codes.has("ADAPTER_EDIT_REJECTED")) {
                void vscode.window.showWarningMessage(
                    messages.text("editRejected")
                );
                return;
            }
            void vscode.window.showWarningMessage(
                messages.text("formatRejected")
            );
        }
    }

    function reportDdlCommandResult(result: ExperimentalDdlTransactionResult): void {
        if (result.status === "cancelled") {
            void vscode.window.showInformationMessage(
                messages.text("formatCancelled")
            );
            return;
        }
        if (result.status === "rejected") {
            const codes = new Set(result.diagnostics.map((item) => item.code));
            if (codes.has("ADAPTER_STALE_DOCUMENT")) {
                void vscode.window.showInformationMessage(
                    messages.text("documentChanged")
                );
                return;
            }
            if (codes.has("ADAPTER_EDIT_REJECTED")) {
                void vscode.window.showWarningMessage(
                    messages.text("editRejected")
                );
                return;
            }
            void vscode.window.showWarningMessage(
                messages.text("ddlRejected")
            );
        }
    }

    function selectionPositions(
        preview: TextEditPreview,
        selections: readonly {
            readonly anchor: number;
            readonly active: number;
        }[],
        offsetsAreOutput: boolean
    ): Vscode.Selection[] | null {
        const lineIndex = buildTextLineIndex(preview.output);
        const offsets = selections.flatMap((selection) => [
            selection.anchor,
            selection.active,
        ]);
        const mappedOffsets = offsetsAreOutput
            ? offsets
            : mapOffsetsThroughEdits(preview, offsets);
        if (mappedOffsets === null) {
            return null;
        }
        const mapped: Vscode.Selection[] = [];
        for (let index = 0; index < selections.length; index += 1) {
            const anchor = mappedOffsets[index * 2]!;
            const active = mappedOffsets[index * 2 + 1]!;
            const anchorPosition = positionAtOffset(lineIndex, anchor);
            const activePosition = positionAtOffset(lineIndex, active);
            if (anchorPosition === null || activePosition === null) {
                return null;
            }
            mapped.push(new vscode.Selection(
                new vscode.Position(anchorPosition.line, anchorPosition.character),
                new vscode.Position(activePosition.line, activePosition.character)
            ));
        }
        return mapped;
    }

    async function applyHostEdits(
        editor: Vscode.TextEditor,
        document: Vscode.TextDocument,
        expected: DocumentSnapshot,
        edits: readonly {
            readonly start: number;
            readonly end: number;
            readonly text: string;
        }[],
        selections: readonly {
            readonly anchor: number;
            readonly active: number;
        }[],
        offsetsAreOutput: boolean
    ): Promise<boolean> {
        const preview = previewTextEdits(expected.source, edits);
        if (preview === null) {
            return false;
        }
        let ranges: Array<Readonly<{
            readonly range: Vscode.Range;
            readonly text: string;
        }>>;
        let mappedSelections: Vscode.Selection[] | null;
        try {
            ranges = preview.edits.map((edit) => Object.freeze({
                range: new vscode.Range(
                    document.positionAt(edit.start),
                    document.positionAt(edit.end)
                ),
                text: edit.text,
            }));
            mappedSelections = selectionPositions(
                preview,
                selections,
                offsetsAreOutput
            );
        } catch {
            return false;
        }
        if (mappedSelections === null) {
            return false;
        }
        const applied = await editor.edit((builder) => {
            for (const edit of ranges) {
                builder.replace(edit.range, edit.text);
            }
        });
        if (applied === true && mappedSelections.length > 0) {
            try {
                editor.selections = mappedSelections;
            } catch {
                void vscode.window.showWarningMessage(
                    messages.text("selectionRestoreFailed")
                );
            }
        }
        return applied;
    }

    async function prepareProvider(
        document: Vscode.TextDocument,
        requestedTarget: FormatTarget | null,
        token: Vscode.CancellationToken,
        phase: string,
        formattingOptions: Vscode.FormattingOptions
    ): Promise<Vscode.TextEdit[]> {
        if (supportedLanguage(document.languageId) === null) {
            return [];
        }
        const generation = beginDiagnosticRequest(document);
        const capturedSource = document.getText();
        const capturedVersion = document.version;
        const current = configuration(document);
        if (!current.ok) {
            const failure = rejectedFormatTransaction(
                capturedVersion,
                current.code,
                safeDiagnosticMessage(
                    current.code,
                    null,
                    current.optionKey
                ),
                current.optionKey
            );
            publishDiagnostics(
                document,
                failure,
                "warn",
                false,
                phase,
                generation,
                true
            );
            return [];
        }
        const target = requestedTarget ?? documentTarget(capturedSource.length);
        const cancellation = wrapVscodeCancellationToken(token);
        let result: FormatTransactionResult;
        try {
            result = await runtime.prepareFormatTransaction({
                source: capturedSource,
                documentVersion: capturedVersion,
                targets: Object.freeze([target]),
                options: current.options,
                newline: documentRenderNewline(vscode, document, capturedSource),
                tabSize: editorRenderTabSize(
                    undefined,
                    formattingOptions
                ),
                debugEnabled: current.debugDiagnostics,
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
            ) => await applyHostEdits(
                editor,
                document,
                expected,
                result.edits,
                result.selections.map((selection) => Object.freeze({
                    anchor: selection.selectionAnchor,
                    active: selection.selectionActive,
                })),
                true
            ),
        });
    }

    function ddlCommit(
        editor: Vscode.TextEditor,
        document: Vscode.TextDocument,
        selections: readonly FormatSelection[]
    ): {
        readonly currentDocument: () => DocumentSnapshot | null;
        readonly apply: (
            result: ReadyExperimentalDdlTransaction,
            expected: DocumentSnapshot
        ) => Promise<boolean>;
    } {
        return Object.freeze({
            currentDocument: () => currentDocument(editor, document),
            apply: async (result, expected) => await applyHostEdits(
                editor,
                document,
                expected,
                result.edits,
                selections.map((selection) => Object.freeze({
                    anchor: selection.anchor,
                    active: selection.active,
                })),
                false
            ),
        });
    }

    async function runQueryCommand(
        explicitOptions: unknown,
        token: Vscode.CancellationToken
    ): Promise<FormatTransactionResult | null> {
        const editor = vscode.window.activeTextEditor;
        if (editor === undefined || supportedLanguage(editor.document.languageId) === null) {
            void vscode.window.showWarningMessage(messages.text("activeSqlEditor"));
            return null;
        }
        const expected = snapshotDocument(editor.document);
        const selectionSet = expected === null
            ? null
            : selectionTargets(editor, expected.source.length);
        const current = configuration(editor.document);
        if (expected === null || selectionSet === null) {
            void vscode.window.showErrorMessage(messages.text("editorState"));
            return null;
        }
        if (!current.ok) {
            void vscode.window.showErrorMessage(messages.text(
                "configurationInvalid",
                { optionKey: current.optionKey }
            ));
            return null;
        }
        const commandOptionsResult = commandOptions(current.options, explicitOptions);
        if (!commandOptionsResult.ok) {
            void vscode.window.showErrorMessage(messages.text(
                "commandOptionsInvalid",
                { optionKey: commandOptionsResult.optionKey }
            ));
            return null;
        }
        const commandOptionsValue = commandOptionsResult.options;
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
                tabSize: editorRenderTabSize(editor),
                debugEnabled: current.debugDiagnostics,
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
            true
        );
        reportQueryCommandResult(
            result,
            commandOptionsValue.unsupportedSyntaxPolicy
        );
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
            void vscode.window.showWarningMessage(messages.text("activeSqlEditor"));
            return null;
        }
        const expected = snapshotDocument(editor.document);
        const selectionSet = expected === null
            ? null
            : selectionTargets(editor, expected.source.length);
        const current = configuration(editor.document);
        if (expected === null || selectionSet === null) {
            void vscode.window.showErrorMessage(messages.text("editorState"));
            return null;
        }
        if (!current.ok) {
            void vscode.window.showErrorMessage(messages.text(
                "configurationInvalid",
                { optionKey: current.optionKey }
            ));
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
            }, operation, ddlCommit(
                editor,
                editor.document,
                selectionSet.selections
            ));
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
            true
        );
        reportDdlCommandResult(result);
        return result;
    }

    async function copySafeDiagnosticReport(
        token: Vscode.CancellationToken
    ): Promise<boolean> {
        const editor = vscode.window.activeTextEditor;
        if (editor === undefined || supportedLanguage(editor.document.languageId) === null) {
            void vscode.window.showErrorMessage(messages.text("activeSqlEditor"));
            return false;
        }
        const document = editor.document;
        const expected = snapshotDocument(document);
        const selectionSet = expected === null
            ? null
            : selectionTargets(editor, expected.source.length);
        const current = configuration(document);
        if (expected === null || selectionSet === null) {
            void vscode.window.showErrorMessage(messages.text("editorState"));
            return false;
        }
        if (!current.ok) {
            void vscode.window.showErrorMessage(messages.text(
                "configurationInvalid",
                { optionKey: current.optionKey }
            ));
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
                tabSize: editorRenderTabSize(editor),
                debugEnabled: current.debugDiagnostics,
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
        if (cancelled) {
            void vscode.window.showInformationMessage(
                messages.text("safeReportCancelled")
            );
            return false;
        }
        if (
            vscode.window.activeTextEditor !== editor ||
            after === null ||
            after.identity !== expected.identity ||
            after.version !== expected.version ||
            after.source !== expected.source
        ) {
            void vscode.window.showInformationMessage(
                messages.text("safeReportStale")
            );
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
                messages.text("safeReportCopied")
            );
            return true;
        } catch {
            void vscode.window.showErrorMessage(
                messages.text("safeReportCopyFailed")
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
                    if (supportedLanguage(event.document.languageId) !== null) {
                        invalidateDiagnostics(event.document);
                    }
                }));
                registrations.push(vscode.workspace.onDidCloseTextDocument((document) => {
                    if (supportedLanguage(document.languageId) !== null) {
                        closeDiagnostics(document);
                    }
                }));
                registrations.push(vscode.languages.registerDocumentFormattingEditProvider(
                    FORMATTER_SELECTOR,
                    {
                        provideDocumentFormattingEdits: async (document, formattingOptions, token) => {
                            return await prepareProvider(
                                document,
                                null,
                                token,
                                "document-format",
                                formattingOptions
                            );
                        },
                    }
                ));
                registrations.push(vscode.languages.registerDocumentRangeFormattingEditProvider(
                    FORMATTER_SELECTOR,
                    {
                        provideDocumentRangeFormattingEdits: async (
                            document,
                            range,
                            formattingOptions,
                            token
                        ) => await prepareProvider(document, Object.freeze({
                            id: "range",
                            start: document.offsetAt(range.start),
                            end: document.offsetAt(range.end),
                            mode: "fragment" as const,
                        }), token, "range-format", formattingOptions),
                    }
                ));
                registrations.push(vscode.commands.registerCommand(
                    "sqlBeautify.formatSql",
                    async (explicitOptions?: unknown) => await withCommandCancellation(
                        messages.text("formattingSql"),
                        async (token) => await runQueryCommand(explicitOptions, token)
                    )
                ));
                registrations.push(vscode.commands.registerCommand(
                    "sqlBeautify.formatHiveDdl",
                    async () => await withCommandCancellation(
                        messages.text("formattingHiveDdl"),
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
                        messages.text("extractingHiveDdl"),
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
                        messages.text("preparingSafeReport"),
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
            latestDiagnosticGeneration.clear();
            diagnostics.dispose();
            await executor.dispose();
        },
    });
}
