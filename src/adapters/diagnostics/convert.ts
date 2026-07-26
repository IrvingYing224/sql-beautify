import type { Diagnostic } from "../../core/diagnostics/diagnostic";
import type { TransactionDiagnostic } from "../transaction/types";
import { snapshotDiagnostic } from "../boundary/format-result-snapshot";
import { safeDiagnosticMessage } from "./safe-messages";

const RECOVERIES: ReadonlySet<string> = new Set([
    "none",
    "verbatim-node",
    "preserve-statement",
    "preserve-target",
]);

function compareString(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

export function convertDiagnostic(
    value: Diagnostic,
    targetId: string,
    targetStart: number,
    targetLength: number
): TransactionDiagnostic | null {
    try {
        const snapshot = snapshotDiagnostic(value);
        if (
            snapshot === null ||
            typeof snapshot.code !== "string" ||
            !/^[A-Z][A-Z0-9_]{1,119}$/.test(snapshot.code) ||
            (snapshot.severity !== "info" &&
                snapshot.severity !== "warning" &&
                snapshot.severity !== "error") ||
            typeof snapshot.message !== "string" ||
            (snapshot.capabilityId !== null &&
                (typeof snapshot.capabilityId !== "string" ||
                    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(snapshot.capabilityId))) ||
            !RECOVERIES.has(snapshot.recovery) ||
            typeof targetId !== "string" ||
            targetId.length === 0 ||
            !Number.isSafeInteger(targetStart) ||
            targetStart < 0 ||
            !Number.isSafeInteger(targetLength) ||
            targetLength < 0 ||
            !Number.isSafeInteger(snapshot.span.start) ||
            !Number.isSafeInteger(snapshot.span.end) ||
            snapshot.span.start < 0 ||
            snapshot.span.end < snapshot.span.start ||
            snapshot.span.end > targetLength
        ) {
            return null;
        }
        return Object.freeze({
            code: snapshot.code,
            severity: snapshot.severity,
            message: safeDiagnosticMessage(
                snapshot.code,
                snapshot.capabilityId
            ),
            capabilityId: snapshot.capabilityId,
            span: Object.freeze({
                start: targetStart + snapshot.span.start,
                end: targetStart + snapshot.span.end,
            }),
            recovery: snapshot.recovery,
            targetId,
        });
    } catch {
        return null;
    }
}

export function sortDiagnostics(
    values: readonly TransactionDiagnostic[]
): readonly TransactionDiagnostic[] {
    return Object.freeze(Array.from(values).sort((left, right) =>
        compareString(left.targetId ?? "", right.targetId ?? "") ||
        left.span.start - right.span.start ||
        left.span.end - right.span.end ||
        compareString(left.code, right.code)
    ));
}
