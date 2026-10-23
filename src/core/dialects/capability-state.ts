import type { CapabilityState } from "./types";

export type ParserStructuredCapabilityState = "structured" | "formatted";

/** `formatted` is a strict successor of `structured` for parser gating. */
export function isParserStructuredCapabilityState(
    state: CapabilityState | null | undefined
): state is ParserStructuredCapabilityState {
    return state === "structured" || state === "formatted";
}
