import * as vscode from "vscode";

import type { UnsupportedSyntaxPolicy } from "../core/config/options";
import type { DiagnosticSeverity } from "../core/diagnostics/diagnostic";
import { sortDiagnostics } from "../edits/compute";
import type { ComputeResult, EditDiagnostic } from "../edits/types";
import { safeDiagnosticMessage } from "./safe-messages";

/** A diagnostic the host itself reports, at the start of the document. */
export function hostDiagnostic(code: string, severity: DiagnosticSeverity, optionKey: string | null = null): EditDiagnostic {
    return {
        code,
        severity,
        message: safeDiagnosticMessage(code, null, optionKey),
        capabilityId: null,
        span: { start: 0, end: 0 },
        recovery: "preserve-target",
        targetId: null,
    };
}

/** Replaces each message with the static safe message for its code; core messages may quote SQL. */
export function withSafeMessages(result: ComputeResult): ComputeResult {
    return {
        ...result,
        diagnostics: result.diagnostics.map((diagnostic) => ({
            ...diagnostic,
            message: safeDiagnosticMessage(diagnostic.code, diagnostic.capabilityId),
        })),
    };
}

/**
 * Keeps, for each target, code, capability and severity, only diagnostics that contain no narrower
 * one. Only the editor view is reduced; results and reports keep every diagnostic.
 */
export function diagnosticsForEditor(values: readonly EditDiagnostic[]): EditDiagnostic[] {
    const groups = new Map<string, EditDiagnostic[]>();
    for (const value of values) {
        const key = [value.targetId ?? "", value.code, value.capabilityId ?? "", value.severity].join("\u0000");
        groups.set(key, [...(groups.get(key) ?? []), value]);
    }
    const retained: EditDiagnostic[] = [];
    for (const group of groups.values()) {
        let minimumEnd = Number.POSITIVE_INFINITY;
        group.sort((left, right) => right.span.start - left.span.start || left.span.end - right.span.end);
        for (const candidate of group) {
            if (candidate.span.end < minimumEnd) {
                retained.push(candidate);
                minimumEnd = candidate.span.end;
            }
        }
    }
    return sortDiagnostics(retained);
}

/** `sqlBeautify.debugDiagnostics`: a summary and the debug events go to the console (D5 replaces this in P4b). */
export function logDebug(enabled: boolean, phase: string, document: vscode.TextDocument, version: number, result: ComputeResult): void {
    if (!enabled) {
        return;
    }
    const counts: Record<string, number> = {};
    for (const diagnostic of result.diagnostics) {
        counts[diagnostic.code] = (counts[diagnostic.code] ?? 0) + 1;
    }
    console.warn("[SQL Beautify]", {
        phase,
        languageId: document.languageId,
        documentVersion: version,
        status: result.status,
        diagnosticCodes: counts,
    });
    for (const event of result.debugEvents) {
        console.warn("[SQL Beautify debug]", event);
    }
}

const SEVERITIES: Readonly<Record<DiagnosticSeverity, vscode.DiagnosticSeverity>> = {
    error: vscode.DiagnosticSeverity.Error,
    warning: vscode.DiagnosticSeverity.Warning,
    info: vscode.DiagnosticSeverity.Information,
};

interface Pending {
    readonly output: string;
    readonly diagnostics: readonly EditDiagnostic[];
    readonly policy: UnsupportedSyntaxPolicy;
    published: boolean;
}

/**
 * The diagnostic collection. Diagnostics of a result with edits are in output coordinates: they are
 * held until the document text equals the predicted output, and any other edit discards them.
 */
export class Diagnostics {
    private readonly collection = vscode.languages.createDiagnosticCollection("sqlBeautify");
    private readonly pending = new Map<string, Pending>();

    /** Shows diagnostics in the document's current coordinates; any held output is discarded. */
    publish(document: vscode.TextDocument, diagnostics: readonly EditDiagnostic[], policy: UnsupportedSyntaxPolicy): void {
        this.pending.delete(document.uri.toString());
        this.show(document, diagnostics, policy);
    }

    stage(document: vscode.TextDocument, output: string, diagnostics: readonly EditDiagnostic[], policy: UnsupportedSyntaxPolicy): void {
        this.pending.set(document.uri.toString(), { output, diagnostics, policy, published: false });
    }

    /** After a command's edit: publishes the held diagnostics if the change event did not. */
    confirm(document: vscode.TextDocument): void {
        const pending = this.pending.get(document.uri.toString());
        if (pending !== undefined && !pending.published && document.getText() === pending.output) {
            pending.published = true;
            this.show(document, pending.diagnostics, pending.policy);
        }
    }

    /** Discards held output diagnostics and keeps what is shown. */
    drop(document: vscode.TextDocument): void {
        this.pending.delete(document.uri.toString());
    }

    /** The codes shown for the document. */
    codes(document: vscode.TextDocument): string[] {
        return (this.collection.get(document.uri) ?? []).map((item) => String(item.code));
    }

    clear(document: vscode.TextDocument): void {
        this.pending.delete(document.uri.toString());
        this.collection.delete(document.uri);
    }

    /**
     * The edit that produces the output publishes its diagnostics; the same text arriving again
     * (a command's change event after `editor.edit` resolved) keeps them. Any other edit clears.
     */
    change(event: vscode.TextDocumentChangeEvent): void {
        if (event.contentChanges.length === 0) {
            return;
        }
        const pending = this.pending.get(event.document.uri.toString());
        if (pending !== undefined && event.document.getText() === pending.output) {
            if (!pending.published) {
                pending.published = true;
                this.show(event.document, pending.diagnostics, pending.policy);
            }
            return;
        }
        this.clear(event.document);
    }

    dispose(): void {
        this.pending.clear();
        this.collection.dispose();
    }

    /** Under the preserve policy, warnings for preserved capabilities stay hidden. */
    private show(document: vscode.TextDocument, diagnostics: readonly EditDiagnostic[], policy: UnsupportedSyntaxPolicy): void {
        const visible = diagnosticsForEditor(diagnostics.filter((item) =>
            !(policy === "preserve" && item.severity === "warning" && item.capabilityId !== null)
        ));
        this.collection.set(document.uri, visible.map((item) => {
            const diagnostic = new vscode.Diagnostic(
                new vscode.Range(document.positionAt(item.span.start), document.positionAt(item.span.end)),
                item.message,
                SEVERITIES[item.severity]
            );
            diagnostic.code = item.code;
            diagnostic.source = "SQL Beautify";
            return diagnostic;
        }));
    }
}
