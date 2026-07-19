import { formatSql } from "../../core/api/format";
import type { FormatResult } from "../../core/api/format-result";
import type { FormatterExecutor, FormatExecutionRequest } from "../transaction/types";

/** Synchronous core invocation behind the common executor contract. */
export class DirectFormatterExecutor implements FormatterExecutor {
    async format(request: FormatExecutionRequest): Promise<FormatResult> {
        if (request.cancellation?.isCancellationRequested === true) {
            return Object.freeze({
                status: "failed",
                text: request.source,
                diagnostics: Object.freeze([
                    Object.freeze({
                        code: "ADAPTER_CANCELLED",
                        severity: "warning" as const,
                        message: "Formatting was cancelled",
                        capabilityId: null,
                        span: Object.freeze({ start: 0, end: request.source.length }),
                        recovery: "preserve-target" as const,
                    }),
                ]),
            });
        }
        const result = formatSql(
            request.source,
            request.options,
            request.mode
        );
        return result;
    }

    async dispose(): Promise<void> {
        return undefined;
    }
}
