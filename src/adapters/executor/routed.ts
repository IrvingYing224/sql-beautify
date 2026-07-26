import type { FormatResult } from "../../core/api/format-result";
import {
    formatExecutionOutcome,
    snapshotFormatExecutionOutcome,
} from "../boundary/execution-outcome-snapshot";
import { lexSql } from "../../core/lexer/lossless-lexer";
import type {
    FormatBatchExecutionResult,
    FormatExecutionOutcome,
    FormatExecutionRequest,
    FormatterExecutor,
    ValidateAndFormatExecutionRequest,
} from "../transaction/types";
import {
    executionRequestForCore,
    snapshotFormatExecutionRequest,
    snapshotValidateAndFormatExecutionRequest,
    type StableValidateAndFormatExecutionRequest,
} from "./request";

export interface ExecutorThresholds {
    readonly sourceCodeUnits: number;
    readonly leafCount: number;
}

export const DEFAULT_EXECUTOR_THRESHOLDS: ExecutorThresholds = Object.freeze({
    sourceCodeUnits: 8_192,
    leafCount: 2_000,
});

export class RoutedFormatterExecutor implements FormatterExecutor {
    private route: "direct" | "worker" = "direct";

    constructor(
        private readonly direct: FormatterExecutor,
        private readonly worker: FormatterExecutor,
        private readonly thresholds: ExecutorThresholds = DEFAULT_EXECUTOR_THRESHOLDS
    ) {
        if (
            !Number.isSafeInteger(thresholds.sourceCodeUnits) ||
            thresholds.sourceCodeUnits < 1 ||
            !Number.isSafeInteger(thresholds.leafCount) ||
            thresholds.leafCount < 1
        ) {
            throw new TypeError("Formatter executor thresholds are invalid");
        }
    }

    lastRoute(): "direct" | "worker" {
        return this.route;
    }

    private useWorkerFor(
        source: string,
        dialect: StableValidateAndFormatExecutionRequest["options"]["dialect"]
    ): boolean {
        let useWorker = source.length >= this.thresholds.sourceCodeUnits;
        // Every lossless leaf covers at least one UTF-16 code unit. Therefore
        // source.length < leafCount is a safe lower-bound prune, not a unit mix.
        if (!useWorker && source.length >= this.thresholds.leafCount) {
            try {
                useWorker = lexSql(source, { dialect }).leaves.length >=
                    this.thresholds.leafCount;
            } catch {
                useWorker = true;
            }
        }
        return useWorker;
    }

    async format(request: FormatExecutionRequest): Promise<FormatResult> {
        return (await this.execute(request)).result;
    }

    async execute(
        request: FormatExecutionRequest
    ): Promise<FormatExecutionOutcome> {
        const snapshot = snapshotFormatExecutionRequest(request);
        if (snapshot === null) {
            this.route = "direct";
            return typeof this.direct.execute === "function"
                ? await this.direct.execute(request)
                : formatExecutionOutcome(await this.direct.format(request));
        }
        const useWorker = this.useWorkerFor(
            snapshot.source,
            snapshot.options.dialect
        );
        this.route = useWorker ? "worker" : "direct";
        const selected = useWorker ? this.worker : this.direct;
        const stableRequest = executionRequestForCore(snapshot);
        if (typeof selected.execute === "function") {
            return await selected.execute(stableRequest);
        }
        const raw = await selected.format(stableRequest);
        return snapshotFormatExecutionOutcome(raw, snapshot.source) ??
            formatExecutionOutcome(raw);
    }

    async validateAndFormat(
        request: ValidateAndFormatExecutionRequest
    ): Promise<FormatBatchExecutionResult> {
        const snapshot = snapshotValidateAndFormatExecutionRequest(request);
        if (snapshot === null) {
            this.route = "direct";
            return Object.freeze({
                status: "failed" as const,
                code: "ADAPTER_EXECUTION_REQUEST",
            });
        }
        const useWorker = this.useWorkerFor(
            snapshot.source,
            snapshot.options.dialect
        );
        this.route = useWorker ? "worker" : "direct";
        const selected = useWorker ? this.worker : this.direct;
        if (typeof selected.validateAndFormat !== "function") {
            return Object.freeze({
                status: "failed" as const,
                code: "ADAPTER_EXECUTOR_FAILED",
            });
        }
        return await selected.validateAndFormat(snapshot);
    }

    async dispose(): Promise<void> {
        await Promise.all([this.direct.dispose(), this.worker.dispose()]);
    }
}
