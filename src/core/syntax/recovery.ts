import type {
    CapabilityIdentity,
    RecoveryAction,
} from "../diagnostics/diagnostic";
import type { LeafRange } from "./leaf-range";
import type { OpaqueBoundary, OpaqueNode } from "./node";
import {
    ParserSyntaxError,
    addDiagnostic,
} from "./parser-context";
import type {
    ParserContext,
    SyntaxDiagnosticCode,
} from "./parser-context";

export interface ParserCheckpoint {
    readonly factoryCheckpoint: number;
    readonly diagnosticCount: number;
}

export function createParserCheckpoint(context: ParserContext): ParserCheckpoint {
    return Object.freeze({
        factoryCheckpoint: context.factory.checkpoint(),
        diagnosticCount: context.diagnostics.length,
    });
}

export function rollbackParserCheckpoint(
    context: ParserContext,
    checkpoint: ParserCheckpoint
): void {
    context.factory.rollback(checkpoint.factoryCheckpoint);
    context.diagnostics.splice(checkpoint.diagnosticCount);
}

export function createOpaqueWithDiagnostic(
    context: ParserContext,
    range: LeafRange,
    code: SyntaxDiagnosticCode,
    boundary: OpaqueBoundary,
    message: string,
    recovery: RecoveryAction = "verbatim-node",
    capabilityId: CapabilityIdentity = null
): OpaqueNode {
    const recoveryIsValid =
        (boundary === "target" && recovery === "preserve-target") ||
        (boundary === "statement" &&
            (recovery === "preserve-statement" || recovery === "verbatim-node")) ||
        (boundary !== "target" &&
            boundary !== "statement" &&
            recovery === "verbatim-node");
    if (!recoveryIsValid) {
        throw new Error(
            `${boundary} opaque cannot use recovery action ${recovery}`
        );
    }
    const opaque = context.factory.createOpaque(
        range,
        code,
        boundary,
        capabilityId
    );
    addDiagnostic(context, code, range, message, recovery, "warning", capabilityId);
    return opaque;
}

export function recoverOpaqueFromError(
    context: ParserContext,
    checkpoint: ParserCheckpoint,
    range: LeafRange,
    error: unknown,
    boundary: OpaqueBoundary,
    messagePrefix: string = ""
): OpaqueNode {
    if (!(error instanceof ParserSyntaxError)) {
        throw error;
    }
    if (error.minimumBoundary === "statement") {
        throw error;
    }
    rollbackParserCheckpoint(context, checkpoint);
    return createOpaqueWithDiagnostic(
        context,
        range,
        error.code,
        boundary,
        `${messagePrefix}${error.message}`,
        "verbatim-node",
        error.capabilityId
    );
}
