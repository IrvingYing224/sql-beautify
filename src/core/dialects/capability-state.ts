import type { CapabilityState } from "./types";

export type RecognizedCapabilityState =
    | "recognized"
    | "structured"
    | "formatted";

export type ParserStructuredCapabilityState = "structured" | "formatted";

/**
 * Registry syntax identities may exist before the parser models their body.
 * This predicate must not be used to decide whether parser structure is safe.
 */
export function isRecognizedCapabilityState(
    state: CapabilityState | null | undefined
): state is RecognizedCapabilityState {
    return (
        state === "recognized" ||
        state === "structured" ||
        state === "formatted"
    );
}

/** `formatted` is a strict successor of `structured` for parser gating. */
export function isParserStructuredCapabilityState(
    state: CapabilityState | null | undefined
): state is ParserStructuredCapabilityState {
    return state === "structured" || state === "formatted";
}
