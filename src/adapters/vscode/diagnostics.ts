import type * as Vscode from "vscode";

import type { UnsupportedSyntaxPolicy } from "../../core/config/options";
import { diagnosticsForEditor } from "../diagnostics/presentation";
import type { DocumentSnapshot } from "../transaction/document-snapshot";
import type { ExperimentalDdlTransactionResult } from "../transaction/experimental-ddl";
import type { FormatTransactionResult } from "../transaction/types";
import { supportedLanguage } from "./supported-languages";

type DiagnosticResult = FormatTransactionResult | ExperimentalDdlTransactionResult;

export interface DiagnosticRequest {
    readonly document: Vscode.TextDocument;
    readonly key: string;
    readonly generation: number;
    readonly snapshot: DocumentSnapshot;
}

interface PendingDiagnostics {
    readonly output: string;
    readonly result: Pick<DiagnosticResult, "diagnostics">;
    readonly policy: UnsupportedSyntaxPolicy;
    readonly requiresCommitConfirmation: boolean;
}

interface DiagnosticState {
    readonly request: DiagnosticRequest;
    pending: PendingDiagnostics | null;
    published: DocumentSnapshot | null;
}

function documentKey(document: Vscode.TextDocument): string | null {
    try {
        return document.uri.toString();
    } catch {
        return null;
    }
}

function readDocument(document: Vscode.TextDocument): DocumentSnapshot | null {
    try {
        return document.isClosed === true ? null : {
            identity: document,
            version: document.version,
            source: document.getText(),
        };
    } catch {
        return null;
    }
}

function sameSnapshot(left: DocumentSnapshot, right: DocumentSnapshot): boolean {
    return left.identity === right.identity &&
        left.version === right.version && left.source === right.source;
}

/** Owns diagnostic generations and source/output coordinate publication. */
export function createVscodeDiagnostics(vscode: typeof Vscode) {
    const collection = vscode.languages.createDiagnosticCollection("sqlBeautify");
    const states = new Map<string, DiagnosticState>();
    let generation = 0;
    let disposed = false;

    function currentState(request: DiagnosticRequest | null): DiagnosticState | null {
        if (disposed || request === null) {
            return null;
        }
        const state = states.get(request.key);
        return state?.request === request ? state : null;
    }

    function clear(document: Vscode.TextDocument): void {
        try {
            collection.delete(document.uri);
        } catch {
            return;
        }
    }

    function publish(
        state: DiagnosticState,
        snapshot: DocumentSnapshot,
        result: Pick<DiagnosticResult, "diagnostics">,
        policy: UnsupportedSyntaxPolicy
    ): void {
        const document = state.request.document;
        const sourceLength = snapshot.source.length;
        const visible = diagnosticsForEditor(result.diagnostics.filter((item) => !(
            policy === "preserve" && item.severity === "warning" &&
            item.capabilityId !== null
        )));
        const converted: Vscode.Diagnostic[] = [];
        for (const item of visible) {
            const severity = item.severity === "error"
                ? vscode.DiagnosticSeverity.Error
                : item.severity === "warning"
                    ? vscode.DiagnosticSeverity.Warning
                    : vscode.DiagnosticSeverity.Information;
            const start = Math.max(0, Math.min(item.span.start, sourceLength));
            const end = Math.max(start, Math.min(item.span.end, sourceLength));
            const diagnostic = new vscode.Diagnostic(
                new vscode.Range(document.positionAt(start), document.positionAt(end)),
                item.message,
                severity
            );
            diagnostic.code = item.code;
            diagnostic.source = "SQL Beautify";
            converted.push(diagnostic);
        }
        collection.set(document.uri, converted);
        state.pending = null;
        state.published = snapshot;
    }

    function matchesOutput(
        state: DiagnosticState,
        snapshot: DocumentSnapshot
    ): boolean {
        return state.pending !== null &&
            snapshot.identity === state.request.snapshot.identity &&
            snapshot.version > state.request.snapshot.version &&
            snapshot.source === state.pending.output;
    }

    return Object.freeze({
        collection,
        begin(
            document: Vscode.TextDocument,
            snapshot: DocumentSnapshot
        ): DiagnosticRequest | null {
            const key = documentKey(document);
            if (disposed || key === null || snapshot.identity !== document) {
                return null;
            }
            const request = Object.freeze({ document, key, snapshot, generation: ++generation });
            // A newer request replaces any unconsumed output from the old one.
            states.set(key, { request, pending: null, published: null });
            return request;
        },
        isCurrent(request: DiagnosticRequest | null): boolean {
            return currentState(request) !== null;
        },
        discard(request: DiagnosticRequest | null): void {
            const state = currentState(request);
            if (state !== null) {
                states.delete(state.request.key);
                clear(state.request.document);
            }
        },
        publishSource(
            request: DiagnosticRequest | null,
            result: DiagnosticResult,
            policy: UnsupportedSyntaxPolicy
        ): void {
            const state = currentState(request);
            if (state === null) {
                return;
            }
            state.pending = null;
            const snapshot = readDocument(state.request.document);
            if (snapshot !== null && sameSnapshot(state.request.snapshot, snapshot)) {
                publish(state, snapshot, result, policy);
            }
        },
        stageOutput(
            request: DiagnosticRequest | null,
            output: string,
            result: DiagnosticResult,
            policy: UnsupportedSyntaxPolicy,
            requiresCommitConfirmation: boolean = false
        ): boolean {
            const state = currentState(request);
            if (state === null) {
                return false;
            }
            const snapshot = readDocument(state.request.document);
            if (snapshot === null || !sameSnapshot(state.request.snapshot, snapshot)) {
                return false;
            }
            // The provider token belongs to computation. After returning edits,
            // only a matching document change proves that output was applied.
            // Retaining its cancellation listener here could discard diagnostics
            // when the host cancels the completed request while applying edits.
            state.pending = {
                output,
                result: { diagnostics: result.diagnostics },
                policy,
                requiresCommitConfirmation,
            };
            return true;
        },
        confirmOutput(request: DiagnosticRequest | null): void {
            const state = currentState(request);
            if (state === null || state.pending === null) {
                return;
            }
            const snapshot = readDocument(state.request.document);
            if (snapshot !== null && matchesOutput(state, snapshot)) {
                publish(state, snapshot, state.pending.result, state.pending.policy);
            } else {
                state.pending = null;
            }
        },
        change(event: Vscode.TextDocumentChangeEvent): void {
            if (disposed || event.contentChanges.length === 0) {
                return;
            }
            const key = documentKey(event.document);
            if (key === null) {
                return;
            }
            const state = states.get(key);
            if (state !== undefined && state.request.document !== event.document) {
                return;
            }
            const snapshot = readDocument(event.document);
            if (state !== undefined && snapshot !== null) {
                // A delayed event may describe the snapshot a newer request
                // already captured; it is not a change relative to that request.
                if (sameSnapshot(state.request.snapshot, snapshot)) {
                    return;
                }
                if (matchesOutput(state, snapshot)) {
                    if (!state.pending!.requiresCommitConfirmation) {
                        publish(state, snapshot, state.pending!.result, state.pending!.policy);
                    }
                    return;
                }
                // An editor.edit promise can resolve before its change event is
                // delivered. A confirmed publication is idempotent for that event.
                if (state.published !== null && sameSnapshot(state.published, snapshot)) {
                    return;
                }
            }
            states.delete(key);
            clear(event.document);
        },
        close(document: Vscode.TextDocument): void {
            if (disposed) {
                return;
            }
            const key = documentKey(document);
            if (key === null) {
                return;
            }
            const state = states.get(key);
            if (state !== undefined && state.request.document !== document) {
                return;
            }
            states.delete(key);
            clear(document);
        },
        debug(
            request: DiagnosticRequest | null,
            result: DiagnosticResult,
            enabled: boolean,
            phase: string
        ): void {
            const state = currentState(request);
            if (!enabled || state === null) {
                return;
            }
            const counts: Record<string, number> = Object.create(null) as Record<string, number>;
            for (const diagnostic of result.diagnostics) {
                counts[diagnostic.code] = (counts[diagnostic.code] ?? 0) + 1;
            }
            console.warn("[SQL Beautify]", Object.freeze({
                phase,
                languageId: supportedLanguage(state.request.document.languageId)?.languageId ?? "unsupported",
                documentVersion: result.documentVersion,
                status: result.status,
                diagnosticCodes: Object.freeze({ ...counts }),
            }));
            if ("debugEvents" in result && Array.isArray(result.debugEvents)) {
                for (const event of result.debugEvents) {
                    console.warn("[SQL Beautify debug]", event);
                }
            }
        },
        dispose(): void {
            if (disposed) {
                return;
            }
            disposed = true;
            states.clear();
            collection.dispose();
        },
    });
}
