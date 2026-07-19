import type { FormatResult } from "../../core/api/format-result";
import type { Diagnostic, DiagnosticSeverity } from "../../core/diagnostics/diagnostic";
import {
    isValidSourceMap,
    type SourceMap,
} from "../../core/source/source-map";
import {
    snapshotDataProperties,
    snapshotDenseDataArray,
} from "./data-snapshot";

const RESULT_KEYS: ReadonlySet<string> = new Set([
    "status",
    "text",
    "diagnostics",
    "sourceMap",
]);
const DIAGNOSTIC_KEYS: ReadonlySet<string> = new Set([
    "code",
    "severity",
    "message",
    "capabilityId",
    "span",
    "recovery",
]);
const SPAN_KEYS: ReadonlySet<string> = new Set(["start", "end"]);
const SOURCE_MAP_KEYS: ReadonlySet<string> = new Set(["entries"]);
const SOURCE_MAP_ENTRY_KEYS: ReadonlySet<string> = new Set(["source", "output"]);

function snapshotSpan(value: unknown): Readonly<{ start: number; end: number }> | null {
    const raw = snapshotDataProperties(value, SPAN_KEYS, ["start", "end"]);
    return raw === null
        ? null
        : Object.freeze({ start: raw.start as number, end: raw.end as number });
}

export function snapshotDiagnostic(value: unknown): Diagnostic | null {
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
    const span = snapshotSpan(raw.span);
    if (span === null) {
        return null;
    }
    return Object.freeze({
        code: raw.code,
        severity: raw.severity,
        message: raw.message,
        capabilityId: raw.capabilityId,
        span,
        recovery: raw.recovery,
    }) as Diagnostic;
}

function snapshotSourceMap(value: unknown): SourceMap | null {
    const raw = snapshotDataProperties(value, SOURCE_MAP_KEYS, ["entries"]);
    if (raw === null) {
        return null;
    }
    const rawEntries = snapshotDenseDataArray(raw.entries);
    if (rawEntries === null) {
        return null;
    }
    const entries = [];
    for (const valueEntry of rawEntries) {
        const rawEntry = snapshotDataProperties(
            valueEntry,
            SOURCE_MAP_ENTRY_KEYS,
            ["source", "output"]
        );
        if (rawEntry === null) {
            return null;
        }
        const source = snapshotSpan(rawEntry.source);
        const output = snapshotSpan(rawEntry.output);
        if (source === null || output === null) {
            return null;
        }
        entries.push(Object.freeze({ source, output }));
    }
    return Object.freeze({ entries: Object.freeze(entries) });
}

export function snapshotFormatResult(value: unknown): FormatResult | null {
    const raw = snapshotDataProperties(value, RESULT_KEYS, ["status", "text", "diagnostics"]);
    if (raw === null) {
        return null;
    }
    const rawDiagnostics = snapshotDenseDataArray(raw.diagnostics);
    if (rawDiagnostics === null) {
        return null;
    }
    const diagnostics: Diagnostic[] = [];
    for (const rawDiagnostic of rawDiagnostics) {
        const item = snapshotDiagnostic(rawDiagnostic);
        if (item === null) {
            return null;
        }
        diagnostics.push(item);
    }
    const base = {
        status: raw.status,
        text: raw.text,
        diagnostics: Object.freeze(diagnostics),
    };
    if (Object.prototype.hasOwnProperty.call(raw, "sourceMap")) {
        const sourceMap = snapshotSourceMap(raw.sourceMap);
        if (sourceMap === null) {
            return null;
        }
        return Object.freeze({ ...base, sourceMap }) as FormatResult;
    }
    return Object.freeze(base) as FormatResult;
}

export function isFormatResultSafeForSource(
    result: FormatResult,
    source: string
): boolean {
    if (typeof result.text !== "string" || !Array.isArray(result.diagnostics)) {
        return false;
    }
    for (const value of result.diagnostics) {
        if (
            typeof value.code !== "string" ||
            typeof value.message !== "string" ||
            (value.capabilityId !== null && typeof value.capabilityId !== "string") ||
            (value.severity !== "info" &&
                value.severity !== "warning" &&
                value.severity !== "error") ||
            !Number.isSafeInteger(value.span.start) ||
            !Number.isSafeInteger(value.span.end) ||
            value.span.start < 0 ||
            value.span.end < value.span.start ||
            value.span.end > source.length ||
            (value.recovery !== "none" &&
                value.recovery !== "verbatim-node" &&
                value.recovery !== "preserve-statement" &&
                value.recovery !== "preserve-target")
        ) {
            return false;
        }
    }
    if (result.status === "formatted") {
        return (
            Object.prototype.hasOwnProperty.call(result, "sourceMap") &&
            result.text !== source &&
            isValidSourceMap(result.sourceMap, source.length, result.text.length)
        );
    }
    if (result.status === "unchanged") {
        return (
            Object.prototype.hasOwnProperty.call(result, "sourceMap") &&
            result.text === source &&
            isValidSourceMap(result.sourceMap, source.length, result.text.length)
        );
    }
    return (
        (result.status === "failed" || result.status === "preserved") &&
        !Object.prototype.hasOwnProperty.call(result, "sourceMap") &&
        result.text === source &&
        result.diagnostics.length > 0
    );
}

export function failedFormatResult(
    source: string,
    code: string,
    message: string,
    severity: DiagnosticSeverity = "error"
): FormatResult {
    return Object.freeze({
        status: "failed" as const,
        text: source,
        diagnostics: Object.freeze([
            Object.freeze({
                code,
                severity,
                message,
                capabilityId: null,
                span: Object.freeze({ start: 0, end: source.length }),
                recovery: "preserve-target" as const,
            }),
        ]),
    });
}
