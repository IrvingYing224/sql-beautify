import type { FormatResult } from "../../core/api/format-result";
import type { FormatOptions } from "../../core/config/options";
import type { RenderNewline } from "../../core/renderer/environment";
import {
    failedFormatResult,
    isFormatResultSafeForSource,
    snapshotFormatResult,
} from "../boundary/format-result-snapshot";
import { observeCancellation } from "../transaction/cancellation";
import type { FormatterExecutor, FormatExecutionRequest } from "../transaction/types";
import type {
    FormatBatchExecutionResult,
    ValidateAndFormatExecutionRequest,
} from "../transaction/types";
import { executeFormatBatch } from "./batch";
import {
    snapshotFormatExecutionRequest,
    snapshotFormatExecutionSource,
    snapshotValidateAndFormatExecutionRequest,
} from "./request";

export type TargetFormatter = (
    source: string,
    options: FormatOptions,
    mode: "document" | "fragment",
    newline: RenderNewline
) => FormatResult;

/** Synchronous target invocation behind the common executor contract. */
export class DirectFormatterExecutor implements FormatterExecutor {
    private readonly formatTarget: TargetFormatter;

    constructor(formatTarget: TargetFormatter) {
        if (typeof formatTarget !== "function") {
            throw new TypeError("Direct formatter target is invalid");
        }
        this.formatTarget = formatTarget;
    }

    async format(request: FormatExecutionRequest): Promise<FormatResult> {
        const snapshot = snapshotFormatExecutionRequest(request);
        if (snapshot === null) {
            return failedFormatResult(
                snapshotFormatExecutionSource(request),
                "ADAPTER_EXECUTION_REQUEST",
                "Formatter execution request is invalid"
            );
        }
        const cancellation = observeCancellation(snapshot.cancellation);
        try {
            if (cancellation.isCancelled()) {
                return failedFormatResult(
                    snapshot.source,
                    "ADAPTER_CANCELLED",
                    "Formatting was cancelled",
                    "warning"
                );
            }
            const rawResult = this.formatTarget(
                snapshot.source,
                snapshot.options,
                snapshot.mode,
                snapshot.newline
            );
            if (cancellation.isCancelled()) {
                return failedFormatResult(
                    snapshot.source,
                    "ADAPTER_CANCELLED",
                    "Formatting was cancelled",
                    "warning"
                );
            }
            const result = snapshotFormatResult(rawResult);
            return result !== null && isFormatResultSafeForSource(result, snapshot.source)
                ? result
                : failedFormatResult(
                      snapshot.source,
                      "ADAPTER_RESULT_CONTRACT",
                      "Formatter result violated the executor contract"
                  );
        } catch {
            return failedFormatResult(
                snapshot.source,
                "ADAPTER_EXECUTOR_FAILED",
                "Formatter executor failed"
            );
        } finally {
            cancellation.dispose();
        }
    }

    async validateAndFormat(
        request: ValidateAndFormatExecutionRequest
    ): Promise<FormatBatchExecutionResult> {
        const snapshot = snapshotValidateAndFormatExecutionRequest(request);
        if (snapshot === null) {
            return Object.freeze({
                status: "failed" as const,
                code: "ADAPTER_EXECUTION_REQUEST",
            });
        }
        const cancellation = observeCancellation(snapshot.cancellation);
        try {
            if (cancellation.isCancelled()) {
                return Object.freeze({
                    status: "failed" as const,
                    code: "ADAPTER_CANCELLED",
                });
            }
            const result = executeFormatBatch(snapshot, this.formatTarget);
            return cancellation.isCancelled()
                ? Object.freeze({
                      status: "failed" as const,
                      code: "ADAPTER_CANCELLED",
                  })
                : result;
        } finally {
            cancellation.dispose();
        }
    }

    async dispose(): Promise<void> {
        return undefined;
    }
}
