import type { SourceSpan } from "../source/source-span";

export type DiagnosticSeverity = "info" | "warning" | "error";
export type RecoveryAction =
    | "none"
    | "verbatim-node"
    | "preserve-statement"
    | "preserve-target";

/**
 * Stable registry identity for a recognized dialect capability.
 * `null` means the diagnostic is lexical, malformed-input, or internal and
 * therefore must not claim ownership by a registry capability.
 */
export type CapabilityIdentity = string | null;

export function isCapabilityIdentity(value: unknown): value is CapabilityIdentity {
    return (
        value === null ||
        (typeof value === "string" &&
            /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value))
    );
}

export interface Diagnostic {
    readonly code: string;
    readonly severity: DiagnosticSeverity;
    readonly message: string;
    readonly capabilityId: CapabilityIdentity;
    readonly span: SourceSpan;
    readonly recovery: RecoveryAction;
}
