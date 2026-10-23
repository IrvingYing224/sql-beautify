import type { Diagnostic, DiagnosticSeverity } from "../core/diagnostics/diagnostic";
import type { SourceSpan } from "../core/source/source-span";

export function ddlDiagnostic(
    code: string,
    message: string,
    source: string,
    severity: DiagnosticSeverity = "error",
    span: SourceSpan = { start: 0, end: source.length }
): Diagnostic {
    return {
        code,
        severity,
        message,
        capabilityId: null,
        span: { start: span.start, end: span.end },
        recovery: "preserve-target",
    };
}
