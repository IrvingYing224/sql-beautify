import type { DebugEvent } from "../../core/diagnostics/debug-event";
import { sortDiagnostics } from "../diagnostics/convert";
import type { TransactionDiagnostic } from "./types";

export interface RejectedTransactionResult {
    readonly status: "rejected";
    readonly documentVersion: number;
    readonly diagnostics: readonly TransactionDiagnostic[];
    readonly debugEvents?: readonly DebugEvent[];
}

export function createRejectedTransaction(
    documentVersion: number,
    diagnostics: readonly TransactionDiagnostic[],
    debugEvents: readonly DebugEvent[] = Object.freeze([])
): RejectedTransactionResult {
    return Object.freeze({
        status: "rejected" as const,
        documentVersion,
        diagnostics: sortDiagnostics(diagnostics),
        ...(debugEvents.length === 0
            ? {}
            : { debugEvents: Object.freeze(Array.from(debugEvents)) }),
    });
}
