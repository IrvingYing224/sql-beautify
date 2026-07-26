import type { FormatResult } from "../../core/api/format-result";
import type { DebugEvent } from "../../core/diagnostics/debug-event";
import type { FormatExecutionOutcome } from "../transaction/types";
import {
    isFormatResultSafeForSource,
    snapshotFormatResult,
} from "./format-result-snapshot";
import { snapshotDataProperties } from "./data-snapshot";
import { snapshotDebugEvents } from "./debug-event-snapshot";

const OUTCOME_KEYS: ReadonlySet<string> = new Set(["result", "debugEvents"]);
const EMPTY_DEBUG_EVENTS: readonly DebugEvent[] = Object.freeze([]);

export function formatExecutionOutcome(
    result: FormatResult,
    debugEvents: readonly DebugEvent[] = EMPTY_DEBUG_EVENTS
): FormatExecutionOutcome {
    return Object.freeze({ result, debugEvents });
}

export function snapshotFormatExecutionOutcome(
    value: unknown,
    source: string
): FormatExecutionOutcome | null {
    const raw = snapshotDataProperties(value, OUTCOME_KEYS, ["result", "debugEvents"]);
    if (raw !== null) {
        const result = snapshotFormatResult(raw.result);
        const debugEvents = snapshotDebugEvents(raw.debugEvents);
        return result !== null &&
            debugEvents !== null &&
            isFormatResultSafeForSource(result, source)
            ? formatExecutionOutcome(result, debugEvents)
            : null;
    }
    const result = snapshotFormatResult(value);
    return result !== null && isFormatResultSafeForSource(result, source)
        ? formatExecutionOutcome(result)
        : null;
}
