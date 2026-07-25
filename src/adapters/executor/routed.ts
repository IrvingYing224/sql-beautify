import type { FormatResult } from "../../core/api/format-result";
import { lexSql } from "../../core/lexer/lossless-lexer";
import type {
    FormatExecutionRequest,
    FormatterExecutor,
} from "../transaction/types";
import {
    executionRequestForCore,
    snapshotFormatExecutionRequest,
} from "./request";

export interface ExecutorThresholds {
    readonly sourceCodeUnits: number;
    readonly leafCount: number;
}

export const DEFAULT_EXECUTOR_THRESHOLDS: ExecutorThresholds = Object.freeze({
    sourceCodeUnits: 65_536,
    leafCount: 12_000,
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

    async format(request: FormatExecutionRequest): Promise<FormatResult> {
        const snapshot = snapshotFormatExecutionRequest(request);
        if (snapshot === null) {
            this.route = "direct";
            return await this.direct.format(request);
        }
        let useWorker = snapshot.source.length >= this.thresholds.sourceCodeUnits;
        if (!useWorker && snapshot.source.length >= this.thresholds.leafCount) {
            try {
                useWorker = lexSql(snapshot.source, {
                    dialect: snapshot.options.dialect,
                }).leaves.length >= this.thresholds.leafCount;
            } catch {
                useWorker = true;
            }
        }
        this.route = useWorker ? "worker" : "direct";
        return await (useWorker ? this.worker : this.direct).format(
            executionRequestForCore(snapshot)
        );
    }

    async dispose(): Promise<void> {
        await Promise.all([this.direct.dispose(), this.worker.dispose()]);
    }
}
