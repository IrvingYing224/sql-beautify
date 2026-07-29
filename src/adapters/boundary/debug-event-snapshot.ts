import {
    normalizeDebugFramePath,
    type DebugEvent,
    type DebugPhase,
} from "../../core/diagnostics/debug-event";
import {
    snapshotDataProperties,
    snapshotDenseDataArray,
} from "./data-snapshot";

const EVENT_KEYS: ReadonlySet<string> = new Set([
    "phase",
    "code",
    "errorName",
    "message",
    "frames",
]);
const PHASES: ReadonlySet<string> = new Set([
    "analysis",
    "layout",
    "render",
    "equivalence",
    "format",
    "executor",
    "worker",
]);
export const MAX_DEBUG_EVENT_COUNT = 64;
const DEBUG_EVENTS_TRUNCATED: DebugEvent = Object.freeze({
    phase: "executor",
    code: "ADAPTER_DEBUG_EVENTS_TRUNCATED",
    errorName: "DebugEventLimit",
    message: "Additional debug events were truncated",
    frames: Object.freeze([]),
});

export function limitDebugEvents(
    values: readonly DebugEvent[]
): readonly DebugEvent[] {
    return values.length <= MAX_DEBUG_EVENT_COUNT
        ? Object.freeze(Array.from(values))
        : Object.freeze([
              ...values.slice(0, MAX_DEBUG_EVENT_COUNT - 1),
              DEBUG_EVENTS_TRUNCATED,
          ]);
}

function isPhase(value: unknown): value is DebugPhase {
    return typeof value === "string" && PHASES.has(value);
}

export function snapshotDebugEvents(value: unknown): readonly DebugEvent[] | null {
    const rawEvents = snapshotDenseDataArray(value);
    if (rawEvents === null || rawEvents.length > MAX_DEBUG_EVENT_COUNT) {
        return null;
    }
    const events: DebugEvent[] = [];
    for (const rawEvent of rawEvents) {
        const raw = snapshotDataProperties(rawEvent, EVENT_KEYS, [
            "phase",
            "code",
            "errorName",
            "message",
            "frames",
        ]);
        if (
            raw === null ||
            !isPhase(raw.phase) ||
            typeof raw.code !== "string" ||
            !/^[A-Z][A-Z0-9_]{1,127}$/.test(raw.code) ||
            typeof raw.errorName !== "string" ||
            raw.errorName.length < 1 ||
            raw.errorName.length > 128 ||
            /[\u0000-\u001f\u007f]/.test(raw.errorName) ||
            typeof raw.message !== "string" ||
            raw.message.length < 1 ||
            raw.message.length > 512 ||
            /[\u0000-\u001f\u007f]/.test(raw.message)
        ) {
            return null;
        }
        const rawFrames = snapshotDenseDataArray(raw.frames);
        if (rawFrames === null || rawFrames.length > 8) {
            return null;
        }
        const frames: string[] = [];
        let totalLength = 0;
        for (const frame of rawFrames) {
            if (
                typeof frame !== "string" ||
                frame.length < 1 ||
                frame.length > 512 ||
                !/^at\s/.test(frame) ||
                /[\u0000-\u001f\u007f]/.test(frame)
            ) {
                return null;
            }
            totalLength += frame.length;
            if (totalLength > 2_048) {
                return null;
            }
            frames.push(normalizeDebugFramePath(frame));
        }
        events.push(Object.freeze({
            phase: raw.phase,
            code: raw.code,
            errorName: raw.errorName,
            message: raw.message,
            frames: Object.freeze(frames),
        }));
    }
    return Object.freeze(events);
}
