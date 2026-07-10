import type { SourceSpan } from "../source/source-span";

export type DiagnosticSeverity = "info" | "warning" | "error";
export type RecoveryAction =
    | "none"
    | "verbatim-node"
    | "preserve-statement"
    | "preserve-target";

export interface Diagnostic {
    readonly code: string;
    readonly severity: DiagnosticSeverity;
    readonly message: string;
    readonly span: SourceSpan;
    readonly recovery: RecoveryAction;
}
