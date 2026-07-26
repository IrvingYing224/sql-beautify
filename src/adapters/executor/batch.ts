import type { FormatResult } from "../../core/api/format-result";
import { MAX_FORMAT_SOURCE_CODE_UNITS } from "../../core/api/limits";
import { createDebugEvent, type DebugEvent } from "../../core/diagnostics/debug-event";
import type { FormatOptions } from "../../core/config/options";
import type { RenderNewline } from "../../core/renderer/environment";
import { snapshotFormatExecutionOutcome } from "../boundary/execution-outcome-snapshot";
import { snapshotDebugEvents } from "../boundary/debug-event-snapshot";
import {
    isFormatResultSafeForSource,
    snapshotFormatResult,
} from "../boundary/format-result-snapshot";
import {
    snapshotDataProperties,
    snapshotDenseDataArray,
} from "../boundary/data-snapshot";
import {
    isRangeValidationCode,
    validateFormatTargetRanges,
} from "../transaction/range";
import type {
    FormatBatchExecutionResult,
    FormatBatchTargetResult,
} from "../transaction/types";
import type { StableValidateAndFormatExecutionRequest } from "./request";

export type BatchTargetFormatter = (
    source: string,
    options: FormatOptions,
    mode: "document" | "fragment",
    newline: RenderNewline,
    debugEnabled?: boolean
) => unknown;

const RESULT_KEYS: ReadonlySet<string> = new Set([
    "status",
    "results",
    "code",
    "targetId",
    "debugEvents",
]);
const TARGET_RESULT_KEYS: ReadonlySet<string> = new Set([
    "targetId",
    "result",
]);

function debugProperties(debugEvents: readonly DebugEvent[]): Readonly<{
    readonly debugEvents?: readonly DebugEvent[];
}> {
    return debugEvents.length === 0 ? Object.freeze({}) : { debugEvents };
}

function failed(
    code: string,
    debugEvents: readonly DebugEvent[] = Object.freeze([])
): FormatBatchExecutionResult {
    return Object.freeze({
        status: "failed" as const,
        code,
        ...debugProperties(debugEvents),
    });
}

function emptyResult(): FormatResult {
    return Object.freeze({
        status: "unchanged" as const,
        text: "",
        diagnostics: Object.freeze([]),
        sourceMap: Object.freeze({ entries: Object.freeze([]) }),
    });
}

export function executeFormatBatch(
    request: StableValidateAndFormatExecutionRequest,
    formatTarget: BatchTargetFormatter
): FormatBatchExecutionResult {
    const debugEvents: DebugEvent[] = [];
    try {
        if (request.source.length > MAX_FORMAT_SOURCE_CODE_UNITS) {
            return failed("ADAPTER_INPUT_LIMIT");
        }
        const validation = validateFormatTargetRanges(
            request.source,
            request.targets,
            request.options
        );
        if (!validation.safe) {
            return Object.freeze({
                status: "invalid" as const,
                code: validation.code,
                targetId: validation.targetId,
            });
        }
        const results: FormatBatchTargetResult[] = [];
        for (const target of request.targets) {
            const source = request.source.slice(target.start, target.end);
            const raw = source.length === 0
                ? emptyResult()
                : formatTarget(
                      source,
                      request.options,
                      target.mode,
                      request.newline,
                      request.debugEnabled
                  );
            const outcome = snapshotFormatExecutionOutcome(raw, source);
            if (outcome === null) {
                return failed("ADAPTER_RESULT_CONTRACT", Object.freeze(debugEvents));
            }
            debugEvents.push(...outcome.debugEvents);
            results.push(Object.freeze({ targetId: target.id, result: outcome.result }));
        }
        return Object.freeze({
            status: "completed" as const,
            results: Object.freeze(results),
            ...debugProperties(Object.freeze(debugEvents)),
        });
    } catch (error) {
        if (request.debugEnabled) {
            debugEvents.push(createDebugEvent(
                "executor",
                "ADAPTER_EXECUTOR_FAILED",
                error
            ));
        }
        return failed("ADAPTER_EXECUTOR_FAILED", Object.freeze(debugEvents));
    }
}

export function snapshotFormatBatchExecutionResult(
    value: unknown,
    request: StableValidateAndFormatExecutionRequest
): FormatBatchExecutionResult | null {
    const raw = snapshotDataProperties(value, RESULT_KEYS, ["status"]);
    if (raw === null) {
        return null;
    }
    const debugEvents = raw.debugEvents === undefined
        ? Object.freeze([])
        : snapshotDebugEvents(raw.debugEvents);
    if (debugEvents === null) {
        return null;
    }
    if (raw.status === "invalid") {
        if (
            raw.results !== undefined ||
            !isRangeValidationCode(raw.code) ||
            (raw.targetId !== null && typeof raw.targetId !== "string") ||
            (typeof raw.targetId === "string" &&
                !request.targets.some((target) => target.id === raw.targetId))
        ) {
            return null;
        }
        return Object.freeze({
            status: "invalid" as const,
            code: raw.code,
            targetId: raw.targetId as string | null,
            ...debugProperties(debugEvents),
        });
    }
    if (raw.status === "failed") {
        if (
            raw.results !== undefined ||
            raw.targetId !== undefined ||
            typeof raw.code !== "string" ||
            !/^ADAPTER_[A-Z0-9_]{1,111}$/.test(raw.code)
        ) {
            return null;
        }
        return Object.freeze({
            status: "failed" as const,
            code: raw.code,
            ...debugProperties(debugEvents),
        });
    }
    if (
        raw.status !== "completed" ||
        raw.code !== undefined ||
        raw.targetId !== undefined
    ) {
        return null;
    }
    const rawResults = snapshotDenseDataArray(raw.results);
    if (rawResults === null || rawResults.length !== request.targets.length) {
        return null;
    }
    const results: FormatBatchTargetResult[] = [];
    for (let index = 0; index < rawResults.length; index++) {
        const target = request.targets[index]!;
        const rawResult = snapshotDataProperties(
            rawResults[index],
            TARGET_RESULT_KEYS,
            ["targetId", "result"]
        );
        if (rawResult === null || rawResult.targetId !== target.id) {
            return null;
        }
        const source = request.source.slice(target.start, target.end);
        const result = snapshotFormatResult(rawResult.result);
        if (result === null || !isFormatResultSafeForSource(result, source)) {
            return null;
        }
        results.push(Object.freeze({ targetId: target.id, result }));
    }
    return Object.freeze({
        status: "completed" as const,
        results: Object.freeze(results),
        ...debugProperties(debugEvents),
    });
}
