import type { FormatOptions } from "../../core/config/options";
import type { RenderNewline } from "../../core/renderer/environment";
import type {
    CancellationToken,
    FormatSelection,
    FormatTarget,
    FormatterExecutor,
    FormatTransactionResult,
} from "./types";
import { observeCancellation } from "./cancellation";
import { prepareFormatTransaction } from "./prepare";
import {
    sameDocument,
    snapshotDocument,
    type DocumentSnapshot,
} from "./document-snapshot";

export type { DocumentSnapshot } from "./document-snapshot";

export interface HostTransactionRequest {
    readonly document: DocumentSnapshot;
    readonly targets: readonly FormatTarget[];
    readonly selections?: readonly FormatSelection[];
    readonly options?: FormatOptions;
    readonly newline?: RenderNewline;
    readonly cancellation?: CancellationToken;
}

export interface HostCommit {
    readonly currentDocument: () => DocumentSnapshot | null;
    readonly apply: (
        result: Extract<FormatTransactionResult, { status: "ready" }>,
        expected: DocumentSnapshot
    ) => Promise<boolean>;
}

function rejected(
    version: number,
    code: string,
    message: string,
    severity: "warning" | "error" = "error"
): FormatTransactionResult {
    return Object.freeze({
        status: "rejected" as const,
        documentVersion: version,
        diagnostics: Object.freeze([
            Object.freeze({
                code,
                severity,
                message,
                capabilityId: null,
                span: Object.freeze({ start: 0, end: 0 }),
                recovery: "preserve-target" as const,
                targetId: null,
            }),
        ]),
    });
}

async function runHostTransactionInternal(
    request: HostTransactionRequest,
    executor: FormatterExecutor,
    commit: HostCommit
): Promise<FormatTransactionResult> {
    const expected = snapshotDocument(request.document);
    if (expected === null) {
        return rejected(0, "ADAPTER_DOCUMENT_SNAPSHOT", "Document snapshot is invalid");
    }
    const cancellationValue = request.cancellation;
    const cancellation = observeCancellation(cancellationValue);
    try {
        const transaction = await prepareFormatTransaction({
            source: expected.source,
            documentVersion: expected.version,
            targets: request.targets,
            ...(request.selections === undefined
                ? {}
                : { selections: request.selections }),
            ...(request.options === undefined ? {} : { options: request.options }),
            ...(request.newline === undefined ? {} : { newline: request.newline }),
            ...(cancellationValue === undefined
                ? {}
                : { cancellation: cancellationValue }),
        }, executor);
        if (transaction.status !== "ready") {
            return transaction;
        }
        if (cancellation.isCancelled()) {
            return Object.freeze({
                status: "cancelled" as const,
                documentVersion: expected.version,
                diagnostics: Object.freeze([]) as readonly [],
            });
        }
        if (!sameDocument(expected, snapshotDocument(commit.currentDocument()))) {
            return rejected(
                expected.version,
                "ADAPTER_STALE_DOCUMENT",
                "Document changed before formatting could be applied",
                "warning"
            );
        }
        if (cancellation.isCancelled()) {
            return Object.freeze({
                status: "cancelled" as const,
                documentVersion: expected.version,
                diagnostics: Object.freeze([]) as readonly [],
            });
        }
        let applied: boolean;
        try {
            applied = await commit.apply(transaction, expected);
        } catch {
            return rejected(
                expected.version,
                "ADAPTER_EDIT_REJECTED",
                "Host rejected the formatting edit"
            );
        }
        if (applied !== true) {
            return rejected(
                expected.version,
                "ADAPTER_EDIT_REJECTED",
                "Host rejected the formatting edit"
            );
        }
        return transaction;
    } finally {
        cancellation.dispose();
    }
}

export async function runHostTransaction(
    request: HostTransactionRequest,
    executor: FormatterExecutor,
    commit: HostCommit
): Promise<FormatTransactionResult> {
    try {
        return await runHostTransactionInternal(request, executor, commit);
    } catch {
        return rejected(0, "ADAPTER_HOST_FAILED", "Host transaction failed safely");
    }
}
