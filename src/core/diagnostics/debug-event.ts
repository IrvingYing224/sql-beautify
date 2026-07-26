export type DebugPhase =
    | "analysis"
    | "layout"
    | "render"
    | "equivalence"
    | "format"
    | "executor"
    | "worker";

export interface DebugEvent {
    readonly phase: DebugPhase;
    readonly code: string;
    readonly errorName: string;
    readonly message: string;
    readonly frames: readonly string[];
}

const MAX_MESSAGE_LENGTH = 512;
const MAX_NAME_LENGTH = 128;
const MAX_FRAME_LENGTH = 512;
const MAX_FRAME_COUNT = 8;
const MAX_TOTAL_FRAME_LENGTH = 2_048;

function safeProperty(value: unknown, key: "name" | "message" | "stack"): string {
    try {
        if ((typeof value !== "object" || value === null) && typeof value !== "function") {
            return "";
        }
        const property = Reflect.get(value, key);
        return typeof property === "string" ? property : "";
    } catch {
        return "";
    }
}

function cleanLine(value: string, limit: number): string {
    return value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, limit);
}

export function createDebugEvent(
    phase: DebugPhase,
    code: string,
    error: unknown
): DebugEvent {
    const errorName = cleanLine(safeProperty(error, "name"), MAX_NAME_LENGTH) ||
        "UnknownError";
    const message = cleanLine(safeProperty(error, "message"), MAX_MESSAGE_LENGTH) ||
        "No error message was available";
    const frames: string[] = [];
    let totalLength = 0;
    const stack = safeProperty(error, "stack");
    for (const line of stack.split(/\r\n|\r|\n/).slice(1)) {
        const frame = cleanLine(line, MAX_FRAME_LENGTH);
        if (!/^at\s/.test(frame) || frame.length === 0) {
            continue;
        }
        if (
            frames.length >= MAX_FRAME_COUNT ||
            totalLength + frame.length > MAX_TOTAL_FRAME_LENGTH
        ) {
            break;
        }
        frames.push(frame);
        totalLength += frame.length;
    }
    return Object.freeze({
        phase,
        code,
        errorName,
        message,
        frames: Object.freeze(frames),
    });
}
