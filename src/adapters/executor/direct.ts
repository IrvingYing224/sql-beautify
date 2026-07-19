import { formatSql } from "../../core/api/format";
import type { FormatResult } from "../../core/api/format-result";
import {
    failedFormatResult,
    isFormatResultSafeForSource,
    snapshotFormatResult,
} from "../boundary/format-result-snapshot";
import { observeCancellation } from "../transaction/cancellation";
import type { FormatterExecutor, FormatExecutionRequest } from "../transaction/types";
import {
    snapshotFormatExecutionRequest,
    snapshotFormatExecutionSource,
} from "./request";

/** Synchronous core invocation behind the common executor contract. */
export class DirectFormatterExecutor implements FormatterExecutor {
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
            const rawResult = formatSql(
                snapshot.source,
                snapshot.options,
                snapshot.mode
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

    async dispose(): Promise<void> {
        return undefined;
    }
}
