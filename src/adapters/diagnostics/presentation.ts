import type { TransactionDiagnostic } from "../transaction/types";
import { compareString } from "../boundary/order";
import { sortDiagnostics } from "./convert";

function presentationKey(value: TransactionDiagnostic): string {
    return [
        value.targetId ?? "",
        value.code,
        value.capabilityId ?? "",
        value.severity,
    ].join("\u0000");
}

export interface DiagnosticPresentationStatistics {
    readonly candidateCount: number;
    readonly containmentChecks: number;
}

export interface DiagnosticPresentationResult {
    readonly diagnostics: readonly TransactionDiagnostic[];
    readonly statistics: DiagnosticPresentationStatistics;
}

/**
 * Removes redundant containing spans only for editor presentation. Transaction
 * results and safe diagnostic reports continue to retain the complete evidence.
 */
export function diagnosticsForEditorWithStatistics(
    values: readonly TransactionDiagnostic[]
): DiagnosticPresentationResult {
    const groups = new Map<string, TransactionDiagnostic[]>();
    for (const value of values) {
        const key = presentationKey(value);
        const group = groups.get(key);
        if (group === undefined) {
            groups.set(key, [value]);
        } else {
            group.push(value);
        }
    }
    const retained: TransactionDiagnostic[] = [];
    let containmentChecks = 0;
    const keys = Array.from(groups.keys()).sort(compareString);
    for (const key of keys) {
        const candidates = groups.get(key)!.slice().sort((left, right) =>
            right.span.start - left.span.start ||
            left.span.end - right.span.end
        );
        let minimumEnd = Number.POSITIVE_INFINITY;
        for (const candidate of candidates) {
            if (minimumEnd !== Number.POSITIVE_INFINITY) {
                containmentChecks += 1;
            }
            if (minimumEnd <= candidate.span.end) {
                continue;
            }
            retained.push(candidate);
            minimumEnd = candidate.span.end;
        }
    }
    return Object.freeze({
        diagnostics: sortDiagnostics(retained),
        statistics: Object.freeze({
            candidateCount: values.length,
            containmentChecks,
        }),
    });
}

export function diagnosticsForEditor(
    values: readonly TransactionDiagnostic[]
): readonly TransactionDiagnostic[] {
    return diagnosticsForEditorWithStatistics(values).diagnostics;
}
