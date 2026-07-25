import type { Diagnostic, DiagnosticSeverity, RecoveryAction } from "../../core/diagnostics/diagnostic";
import type { SourceSpan } from "../../core/source/source-span";
import type {
    ExtractDdlResult,
    ExtractDdlStatus,
    ExtractedDdlResult,
    HiveDdlResult,
    HiveDdlStatus,
    NonExtractedDdlResult,
} from "./types";

export function ddlDiagnostic(
    code: string,
    message: string,
    source: string,
    severity: DiagnosticSeverity = "error",
    recovery: RecoveryAction = "preserve-target",
    span: SourceSpan = { start: 0, end: source.length }
): Diagnostic {
    return Object.freeze({
        code,
        severity,
        message,
        capabilityId: null,
        span: Object.freeze({ start: span.start, end: span.end }),
        recovery,
    });
}

export function hiveDdlResult(
    status: HiveDdlStatus,
    source: string,
    text: string,
    diagnostic: Diagnostic | null = null
): HiveDdlResult {
    const diagnostics = diagnostic === null
        ? Object.freeze([]) as readonly []
        : Object.freeze([diagnostic]) as readonly [Diagnostic];
    const safeText = status === "preserved" || status === "failed" ? source : text;
    return Object.freeze({
        status,
        source,
        text: safeText,
        diagnostics,
    });
}

export function extractDdlResult(
    status: "extracted",
    source: string,
    text: string,
    diagnostic?: null
): ExtractedDdlResult;
export function extractDdlResult(
    status: Exclude<ExtractDdlStatus, "extracted">,
    source: string,
    text: string,
    diagnostic: Diagnostic
): NonExtractedDdlResult;
export function extractDdlResult(
    status: ExtractDdlStatus,
    source: string,
    text: string,
    diagnostic: Diagnostic | null = null
): ExtractDdlResult {
    if (status === "extracted" && text.length === 0) {
        throw new TypeError("Extracted DDL text must not be empty");
    }
    if (status !== "extracted" && diagnostic === null) {
        throw new TypeError("Non-extracted DDL results require a diagnostic");
    }
    const diagnostics = diagnostic === null
        ? Object.freeze([]) as readonly []
        : Object.freeze([diagnostic]) as readonly [Diagnostic];
    const safeText = status === "extracted" ? text : source;
    return Object.freeze({
        status,
        source,
        text: safeText,
        diagnostics,
    }) as ExtractDdlResult;
}
