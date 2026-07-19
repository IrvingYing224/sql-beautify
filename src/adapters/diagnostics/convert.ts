import type { Diagnostic } from "../../core/diagnostics/diagnostic";
import type { TransactionDiagnostic } from "../transaction/types";
import { snapshotDataProperties } from "../boundary/data-snapshot";

const SAFE_MESSAGE_BY_CODE: Readonly<Record<string, string>> = Object.freeze({
    CFG_OPTIONS_TYPE: "Formatter options are invalid",
    CFG_OPTIONS_PROXY: "Formatter options are invalid",
    CFG_OPTIONS_SHAPE: "Formatter options are invalid",
    CFG_UNKNOWN_OPTION: "Formatter options contain an unsupported key",
    CFG_OPTION_ACCESSOR: "Formatter options contain an unsupported accessor",
    CFG_OPTION_VALUE: "Formatter options contain an invalid value",
    CFG_OPTIONS_READ: "Formatter options could not be inspected",
});

const RECOVERIES: ReadonlySet<string> = new Set([
    "none",
    "verbatim-node",
    "preserve-statement",
    "preserve-target",
]);

function compareString(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

const DIAGNOSTIC_KEYS: ReadonlySet<string> = new Set([
    "code",
    "severity",
    "message",
    "capabilityId",
    "span",
    "recovery",
]);
const SPAN_KEYS: ReadonlySet<string> = new Set(["start", "end"]);

function snapshotDiagnostic(value: unknown): Diagnostic | null {
    const raw = snapshotDataProperties(value, DIAGNOSTIC_KEYS, [
        "code",
        "severity",
        "message",
        "capabilityId",
        "span",
        "recovery",
    ]);
    if (raw === null) {
        return null;
    }
    const span = snapshotDataProperties(raw.span, SPAN_KEYS, ["start", "end"]);
    if (span === null) {
        return null;
    }
    return Object.freeze({
        code: raw.code,
        severity: raw.severity,
        message: raw.message,
        capabilityId: raw.capabilityId,
        span: Object.freeze({ start: span.start, end: span.end }),
        recovery: raw.recovery,
    }) as Diagnostic;
}

function safeMessage(code: string): string {
    const configured = SAFE_MESSAGE_BY_CODE[code];
    if (configured !== undefined) {
        return configured;
    }
    return /^[A-Z][A-Z0-9_]{1,119}$/.test(code)
        ? "Formatter reported a recoverable diagnostic"
        : "Formatter diagnostic is unavailable";
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
            message: safeMessage(snapshot.code),
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
