import type { TransactionDiagnostic } from "../transaction/types";

export interface SafeDiagnosticReportInput {
    readonly extensionVersion: string;
    readonly dialect: unknown;
    readonly sourceCodeUnits: number;
    readonly resultStatus: unknown;
    readonly diagnostics: readonly TransactionDiagnostic[];
}

const DIALECTS: ReadonlySet<string> = new Set([
    "hive",
    "generic",
    "postgresql",
    "mysql",
]);
const RESULT_STATUSES: ReadonlySet<string> = new Set([
    "ready",
    "unchanged",
    "rejected",
    "cancelled",
    "unavailable",
]);

function safeVersion(value: unknown): string {
    return typeof value === "string" && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value)
        ? value
        : "unknown";
}

function safeEnum(value: unknown, allowed: ReadonlySet<string>): string {
    return typeof value === "string" && allowed.has(value) ? value : "unknown";
}

export function renderSafeDiagnosticReport(
    input: SafeDiagnosticReportInput
): string {
    const counts = { info: 0, warning: 0, error: 0 };
    const codes = new Map<string, number>();
    if (Array.isArray(input.diagnostics)) {
        for (const diagnostic of input.diagnostics) {
            if (
                typeof diagnostic !== "object" ||
                diagnostic === null ||
                (diagnostic.severity !== "info" &&
                    diagnostic.severity !== "warning" &&
                    diagnostic.severity !== "error") ||
                typeof diagnostic.code !== "string" ||
                !/^[A-Z][A-Z0-9_]{1,119}$/.test(diagnostic.code)
            ) {
                continue;
            }
            const severity = diagnostic.severity as "info" | "warning" | "error";
            counts[severity] += 1;
            codes.set(diagnostic.code, (codes.get(diagnostic.code) ?? 0) + 1);
        }
    }
    const codeSummary = Array.from(codes.entries())
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([code, count]) => `${code}:${String(count)}`)
        .join(", ") || "none";
    const sourceCodeUnits = Number.isSafeInteger(input.sourceCodeUnits) && input.sourceCodeUnits >= 0
        ? input.sourceCodeUnits
        : 0;
    return [
        "# SQL Beautify Safe Diagnostic Report",
        "",
        `- Extension version: ${safeVersion(input.extensionVersion)}`,
        `- Dialect: ${safeEnum(input.dialect, DIALECTS)}`,
        `- Source code units: ${String(sourceCodeUnits)}`,
        `- Result status: ${safeEnum(input.resultStatus, RESULT_STATUSES)}`,
        `- Diagnostics: info=${String(counts.info)}, warning=${String(counts.warning)}, error=${String(counts.error)}`,
        `- Diagnostic codes: ${codeSummary}`,
        "",
    ].join("\n");
}
