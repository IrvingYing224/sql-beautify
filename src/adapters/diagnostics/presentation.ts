import type { TransactionDiagnostic } from "../transaction/types";
import { sortDiagnostics } from "./convert";

function compareString(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

function presentationKey(value: TransactionDiagnostic): string {
    return [
        value.targetId ?? "",
        value.code,
        value.capabilityId ?? "",
        value.severity,
    ].join("\u0000");
}

function spanContains(
    outer: TransactionDiagnostic,
    inner: TransactionDiagnostic
): boolean {
    return outer.span.start <= inner.span.start &&
        inner.span.end <= outer.span.end;
}

/**
 * Removes redundant containing spans only for editor presentation. Transaction
 * results and safe diagnostic reports continue to retain the complete evidence.
 */
export function diagnosticsForEditor(
    values: readonly TransactionDiagnostic[]
): readonly TransactionDiagnostic[] {
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
    const keys = Array.from(groups.keys()).sort(compareString);
    for (const key of keys) {
        const candidates = groups.get(key)!.slice().sort((left, right) =>
            (left.span.end - left.span.start) -
                (right.span.end - right.span.start) ||
            left.span.start - right.span.start ||
            left.span.end - right.span.end
        );
        const narrow: TransactionDiagnostic[] = [];
        for (const candidate of candidates) {
            if (narrow.some((value) => spanContains(candidate, value))) {
                continue;
            }
            narrow.push(candidate);
        }
        retained.push(...narrow);
    }
    return sortDiagnostics(retained);
}
