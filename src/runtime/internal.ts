import { createHash } from "node:crypto";
import { accessSync, constants, readFileSync, statSync } from "node:fs";

import { executeFormatBatch } from "../adapters/executor/batch";
import { DirectFormatterExecutor } from "../adapters/executor/direct";
import { PersistentWorkerExecutor } from "../adapters/executor/persistent-worker";
import {
    DEFAULT_EXECUTOR_THRESHOLDS,
    RoutedFormatterExecutor,
    type ExecutorThresholds,
} from "../adapters/executor/routed";
import { createNodeWorkerFactory } from "../adapters/executor/worker-connection";
import type {
    FormatBatchExecutionResult,
    FormatExecutionRequest,
    FormatTarget,
    FormatterExecutor,
    ValidateAndFormatExecutionRequest,
} from "../adapters/transaction/types";
import { runExperimentalDdlTransaction } from "../adapters/transaction/experimental-ddl";
import { runHostTransaction } from "../adapters/transaction/host-transaction";
import { prepareFormatTransaction } from "../adapters/transaction/prepare";
import {
    executeFormatSql,
    formatSql as formatSqlTarget,
} from "../core/api/format";
import { formatSql } from "../core/api/public-format";
import { resolveFormatOptions } from "../core/config/resolve-options";
import type { CanonicalFormatOptions } from "../core/config/options";
import { lexSql } from "../core/lexer/lossless-lexer";
import type { RenderNewline } from "../core/renderer/environment";
import { extractDdl, formatHiveDdl } from "../experimental/ddl";

declare const __filename: string;

export {
    extractDdl,
    executeFormatSql,
    formatHiveDdl,
    formatSql,
    formatSqlTarget,
    lexSql,
    prepareFormatTransaction,
    resolveFormatOptions,
    runExperimentalDdlTransaction,
    runHostTransaction,
};

/** Internal worker entry; it is not re-exported by either public facade. */
export function validateAndFormatTargets(
    source: string,
    options: CanonicalFormatOptions,
    targets: readonly FormatTarget[],
    documentVersion: number,
    newline: RenderNewline,
    debugEnabled = false
): FormatBatchExecutionResult {
    return executeFormatBatch(
        Object.freeze({
            source,
            options,
            targets,
            documentVersion,
            newline,
            debugEnabled,
        }),
        executeFormatSql
    );
}

export interface ProductionFormatterExecutorOptions {
    readonly runtimePath: string;
    readonly workerPath: string;
    readonly thresholds?: ExecutorThresholds;
}

export interface ProductionFormatterExecutor extends FormatterExecutor {
    readonly runtimeDigest: string;
    lastRoute(): "direct" | "worker";
}

function runtimeDigest(runtimePath: string): string {
    return createHash("sha256").update(readFileSync(runtimePath)).digest("hex");
}

/** Creates the production direct/worker pair bound to this runtime artifact. */
export function createProductionFormatterExecutor(
    options: ProductionFormatterExecutorOptions
): ProductionFormatterExecutor {
    let runtimePath: string;
    let workerPath: string;
    let thresholds: ExecutorThresholds;
    try {
        runtimePath = options.runtimePath;
        workerPath = options.workerPath;
        thresholds = options.thresholds ?? DEFAULT_EXECUTOR_THRESHOLDS;
    } catch {
        throw new TypeError("Production formatter executor options are invalid");
    }
    if (
        typeof runtimePath !== "string" ||
        runtimePath.length === 0 ||
        runtimePath !== __filename ||
        typeof workerPath !== "string" ||
        workerPath.length === 0
    ) {
        throw new TypeError("Production formatter runtime paths are invalid");
    }

    let digest: string;
    try {
        digest = runtimeDigest(runtimePath);
        if (!statSync(workerPath).isFile()) {
            throw new TypeError("Formatter worker artifact is not a file");
        }
        accessSync(workerPath, constants.R_OK);
    } catch {
        throw new TypeError("Production formatter runtime artifacts are unavailable");
    }

    const direct = new DirectFormatterExecutor(executeFormatSql);
    const worker = new PersistentWorkerExecutor({
        workerFactory: createNodeWorkerFactory(workerPath, runtimePath),
        runtimeDigest: digest,
    });
    const routed = new RoutedFormatterExecutor(direct, worker, thresholds);
    return Object.freeze({
        runtimeDigest: digest,
        format(request: FormatExecutionRequest) {
            return routed.format(request);
        },
        execute(request: FormatExecutionRequest) {
            return routed.execute(request);
        },
        validateAndFormat(request: ValidateAndFormatExecutionRequest) {
            return routed.validateAndFormat(request);
        },
        lastRoute() {
            return routed.lastRoute();
        },
        dispose() {
            return routed.dispose();
        },
    });
}
