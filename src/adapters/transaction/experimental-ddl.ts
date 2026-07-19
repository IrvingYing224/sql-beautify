import type { Diagnostic } from "../../core/diagnostics/diagnostic";
import type {
    ExtractDdlResult,
    HiveDdlResult,
} from "../../experimental/ddl/types";
import { snapshotDataProperties, snapshotDenseDataArray } from "../boundary/data-snapshot";
import { convertDiagnostic, sortDiagnostics } from "../diagnostics/convert";
import { observeCancellation } from "./cancellation";
import {
    sameDocument,
    snapshotDocument,
    type DocumentSnapshot,
} from "./document-snapshot";
import type {
    CancellationToken,
    TransactionDiagnostic,
} from "./types";

export type ExperimentalDdlResult = HiveDdlResult | ExtractDdlResult;

export interface ExperimentalDdlTarget {
    readonly id: string;
    readonly start: number;
    readonly end: number;
}

export interface ExperimentalDdlTransactionRequest {
    readonly document: DocumentSnapshot;
    readonly target: ExperimentalDdlTarget;
    readonly cancellation?: CancellationToken;
}

export interface ExperimentalDdlEdit {
    readonly targetId: string;
    readonly start: number;
    readonly end: number;
    readonly text: string;
}

interface ExperimentalDdlTransactionBase<S extends string> {
    readonly status: S;
    readonly documentVersion: number;
    readonly diagnostics: readonly TransactionDiagnostic[];
}

export interface ReadyExperimentalDdlTransaction
    extends ExperimentalDdlTransactionBase<"ready"> {
    readonly edits: readonly [ExperimentalDdlEdit];
}

export interface UnchangedExperimentalDdlTransaction
    extends ExperimentalDdlTransactionBase<"unchanged"> {
    readonly edits: readonly [];
}

export interface RejectedExperimentalDdlTransaction
    extends ExperimentalDdlTransactionBase<"rejected"> {
    readonly edits?: never;
}

export interface CancelledExperimentalDdlTransaction
    extends ExperimentalDdlTransactionBase<"cancelled"> {
    readonly diagnostics: readonly [];
    readonly edits?: never;
}

export type ExperimentalDdlTransactionResult =
    | ReadyExperimentalDdlTransaction
    | UnchangedExperimentalDdlTransaction
    | RejectedExperimentalDdlTransaction
    | CancelledExperimentalDdlTransaction;

export type ExperimentalDdlOperation = (
    source: string
) => ExperimentalDdlResult | Promise<ExperimentalDdlResult>;

export interface ExperimentalDdlCommit {
    readonly currentDocument: () => DocumentSnapshot | null;
    readonly apply: (
        result: ReadyExperimentalDdlTransaction,
        expected: DocumentSnapshot
    ) => Promise<boolean>;
}

const TARGET_KEYS: ReadonlySet<string> = new Set(["id", "start", "end"]);
const RESULT_KEYS: ReadonlySet<string> = new Set([
    "status",
    "source",
    "text",
    "diagnostics",
]);
const RESULT_STATUSES: ReadonlySet<string> = new Set([
    "formatted",
    "unchanged",
    "preserved",
    "failed",
    "extracted",
    "unsupported",
    "ambiguous",
    "empty",
]);

function diagnostic(
    target: ExperimentalDdlTarget,
    code: string,
    message: string,
    severity: "warning" | "error" = "error"
): TransactionDiagnostic {
    return Object.freeze({
        code,
        severity,
        message,
        capabilityId: null,
        span: Object.freeze({ start: target.start, end: target.end }),
        recovery: "preserve-target" as const,
        targetId: target.id,
    });
}

function rejected(
    version: number,
    diagnostics: readonly TransactionDiagnostic[]
): RejectedExperimentalDdlTransaction {
    return Object.freeze({
        status: "rejected",
        documentVersion: version,
        diagnostics: sortDiagnostics(diagnostics),
    });
}

function cancelled(version: number): CancelledExperimentalDdlTransaction {
    return Object.freeze({
        status: "cancelled",
        documentVersion: version,
        diagnostics: Object.freeze([]) as readonly [],
    });
}

function snapshotTarget(
    value: ExperimentalDdlTarget,
    sourceLength: number
): ExperimentalDdlTarget | null {
    const snapshot = snapshotDataProperties(value, TARGET_KEYS, ["id", "start", "end"]);
    const start = snapshot?.start;
    const end = snapshot?.end;
    if (
        snapshot === null ||
        typeof snapshot.id !== "string" ||
        snapshot.id.length === 0 ||
        typeof start !== "number" ||
        typeof end !== "number" ||
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        end < start ||
        end > sourceLength
    ) {
        return null;
    }
    return Object.freeze({
        id: snapshot.id as string,
        start,
        end,
    });
}

function snapshotResult(
    value: ExperimentalDdlResult,
    target: ExperimentalDdlTarget
): { readonly status: string; readonly source: string; readonly text: string; readonly diagnostics: readonly TransactionDiagnostic[] } | null {
    const raw = snapshotDataProperties(value, RESULT_KEYS, [
        "status",
        "source",
        "text",
        "diagnostics",
    ]);
    if (
        raw === null ||
        typeof raw.status !== "string" ||
        !RESULT_STATUSES.has(raw.status) ||
        typeof raw.source !== "string" ||
        typeof raw.text !== "string"
    ) {
        return null;
    }
    const diagnostics = snapshotDenseDataArray(raw.diagnostics);
    if (diagnostics === null) {
        return null;
    }
    const converted: TransactionDiagnostic[] = [];
    for (const value of diagnostics) {
        const convertedDiagnostic = convertDiagnostic(
            value as Diagnostic,
            target.id,
            target.start,
            target.end - target.start
        );
        if (convertedDiagnostic === null) {
            return null;
        }
        converted.push(convertedDiagnostic);
    }
    return Object.freeze({
        status: raw.status,
        source: raw.source,
        text: raw.text,
        diagnostics: sortDiagnostics(converted),
    });
}

function prepareExperimentalDdlTransactionInternal(
    request: ExperimentalDdlTransactionRequest,
    operationResult: ExperimentalDdlResult
): ExperimentalDdlTransactionResult {
    const expected = snapshotDocument(request.document);
    if (expected === null) {
        return rejected(0, [
            diagnostic(
                { id: "document", start: 0, end: 0 },
                "ADAPTER_DOCUMENT_SNAPSHOT",
                "Document snapshot is invalid"
            ),
        ]);
    }
    const target = snapshotTarget(request.target, expected.source.length);
    if (target === null) {
        return rejected(expected.version, [
            diagnostic(
                { id: "document", start: 0, end: expected.source.length },
                "ADAPTER_DDL_TARGET",
                "Experimental DDL target is invalid"
            ),
        ]);
    }
    const snapshot = snapshotResult(operationResult, target);
    if (snapshot === null || snapshot.source !== expected.source.slice(target.start, target.end)) {
        return rejected(expected.version, [
            diagnostic(
                target,
                "ADAPTER_DDL_RESULT",
                "Experimental DDL result violated the source identity contract"
            ),
        ]);
    }
    const diagnostics = snapshot.diagnostics;
    if (snapshot.status === "formatted" || snapshot.status === "extracted") {
        if (snapshot.text.length === 0 || diagnostics.length !== 0) {
            return rejected(expected.version, [
                ...diagnostics,
                diagnostic(
                    target,
                    "ADAPTER_DDL_RESULT",
                    "Editable experimental DDL result must be non-empty and diagnostic-free"
                ),
            ]);
        }
        if (snapshot.text === snapshot.source) {
            return Object.freeze({
                status: "unchanged",
                documentVersion: expected.version,
                edits: Object.freeze([]) as readonly [],
                diagnostics,
            });
        }
        return Object.freeze({
            status: "ready",
            documentVersion: expected.version,
            edits: Object.freeze([
                Object.freeze({
                    targetId: target.id,
                    start: target.start,
                    end: target.end,
                    text: snapshot.text,
                }),
            ]) as readonly [ExperimentalDdlEdit],
            diagnostics,
        });
    }
    if (snapshot.status === "unchanged" && snapshot.text === snapshot.source) {
        if (diagnostics.some((item) => item.severity === "error")) {
            return rejected(expected.version, [
                ...diagnostics,
                diagnostic(
                    target,
                    "ADAPTER_DDL_RESULT",
                    "Unchanged experimental DDL result must be error-free"
                ),
            ]);
        }
        return Object.freeze({
            status: "unchanged",
            documentVersion: expected.version,
            edits: Object.freeze([]) as readonly [],
            diagnostics,
        });
    }
    if (snapshot.text !== snapshot.source || diagnostics.length === 0) {
        return rejected(expected.version, [
            ...diagnostics,
            diagnostic(
                target,
                "ADAPTER_DDL_RESULT",
                "Non-editable experimental DDL result must retain source and diagnostics"
            ),
        ]);
    }
    return rejected(expected.version, [
        ...diagnostics,
        diagnostic(
            target,
            "ADAPTER_DDL_NOT_EDITABLE",
            "Experimental DDL result is not editable in this transaction",
            snapshot.status === "failed" ? "error" : "warning"
        ),
    ]);
}

async function runExperimentalDdlTransactionInternal(
    request: ExperimentalDdlTransactionRequest,
    operation: ExperimentalDdlOperation,
    commit: ExperimentalDdlCommit
): Promise<ExperimentalDdlTransactionResult> {
    const expected = snapshotDocument(request.document);
    if (expected === null) {
        return rejected(0, [
            diagnostic(
                { id: "document", start: 0, end: 0 },
                "ADAPTER_DOCUMENT_SNAPSHOT",
                "Document snapshot is invalid"
            ),
        ]);
    }
    const target = snapshotTarget(request.target, expected.source.length);
    if (target === null) {
        return rejected(expected.version, [
            diagnostic(
                { id: "document", start: 0, end: expected.source.length },
                "ADAPTER_DDL_TARGET",
                "Experimental DDL target is invalid"
            ),
        ]);
    }
    const stableRequest: ExperimentalDdlTransactionRequest = Object.freeze({
        document: expected,
        target,
        ...(request.cancellation === undefined
            ? {}
            : { cancellation: request.cancellation }),
    });
    const cancellation = observeCancellation(request.cancellation);
    try {
        if (cancellation.isCancelled()) {
            return cancelled(expected.version);
        }
        let operationResult: ExperimentalDdlResult;
        try {
            operationResult = await operation(expected.source.slice(target.start, target.end));
        } catch {
            return rejected(expected.version, [
                diagnostic(
                    target,
                    "ADAPTER_DDL_OPERATION",
                    "Experimental DDL operation failed"
                ),
            ]);
        }
        if (cancellation.isCancelled()) {
            return cancelled(expected.version);
        }
        const prepared = prepareExperimentalDdlTransactionInternal(stableRequest, operationResult);
        if (prepared.status !== "ready") {
            return prepared;
        }
        if (!sameDocument(expected, snapshotDocument(commit.currentDocument()))) {
            return rejected(expected.version, [
                diagnostic(
                    target,
                    "ADAPTER_STALE_DOCUMENT",
                    "Document changed before the experimental DDL edit could be applied",
                    "warning"
                ),
            ]);
        }
        if (cancellation.isCancelled()) {
            return cancelled(expected.version);
        }
        try {
            if (await commit.apply(prepared, expected) !== true) {
                return rejected(expected.version, [
                    diagnostic(
                        target,
                        "ADAPTER_EDIT_REJECTED",
                        "Host rejected the experimental DDL edit"
                    ),
                ]);
            }
        } catch {
            return rejected(expected.version, [
                diagnostic(
                    target,
                    "ADAPTER_EDIT_REJECTED",
                    "Host rejected the experimental DDL edit"
                ),
            ]);
        }
        return prepared;
    } finally {
        cancellation.dispose();
    }
}

export async function runExperimentalDdlTransaction(
    request: ExperimentalDdlTransactionRequest,
    operation: ExperimentalDdlOperation,
    commit: ExperimentalDdlCommit
): Promise<ExperimentalDdlTransactionResult> {
    try {
        return await runExperimentalDdlTransactionInternal(request, operation, commit);
    } catch {
        return rejected(0, [
            diagnostic(
                { id: "document", start: 0, end: 0 },
                "ADAPTER_DDL_TRANSACTION",
                "Experimental DDL transaction failed safely"
            ),
        ]);
    }
}
