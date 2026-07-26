import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { parentPort, workerData } from "node:worker_threads";

import type { FormatSqlExecution } from "../../core/api/format";
import type { CanonicalFormatOptions, FormatOptions } from "../../core/config/options";
import { createDebugEvent } from "../../core/diagnostics/debug-event";
import type { RenderNewline } from "../../core/renderer/environment";
import { failedFormatResult } from "../boundary/format-result-snapshot";
import type {
    FormatBatchExecutionResult,
    FormatTarget,
} from "../transaction/types";
import {
    snapshotWorkerRequestMessage,
    type WorkerBatchResponseMessage,
    type WorkerFormatResponseMessage,
} from "./protocol";

interface FormatterRuntime {
    executeFormatSql(
        source: string,
        options: FormatOptions,
        mode: "document" | "fragment",
        newline: RenderNewline,
        debugEnabled: boolean
    ): FormatSqlExecution;
    validateAndFormatTargets(
        source: string,
        options: CanonicalFormatOptions,
        targets: readonly FormatTarget[],
        documentVersion: number,
        newline: RenderNewline,
        debugEnabled: boolean
    ): FormatBatchExecutionResult;
}

const data = workerData as { readonly runtimePath?: unknown } | null;
if (
    parentPort === null ||
    data === null ||
    typeof data.runtimePath !== "string" ||
    data.runtimePath.length === 0
) {
    throw new Error("Formatter worker configuration is invalid");
}

const runtimePath = data.runtimePath;
const port = parentPort;
const runtimeDigest = createHash("sha256")
    .update(readFileSync(runtimePath))
    .digest("hex");
const runtime = require(runtimePath) as Partial<FormatterRuntime>;
if (
    typeof runtime.executeFormatSql !== "function" ||
    typeof runtime.validateAndFormatTargets !== "function"
) {
    throw new Error("Formatter worker runtime is invalid");
}

port.on("message", (value: unknown) => {
    const request = snapshotWorkerRequestMessage(value);
    if (request === null) {
        return;
    }
    const startedAt = performance.now();
    if (request.kind === "validate-and-format") {
        let result: FormatBatchExecutionResult;
        try {
            result = runtime.validateAndFormatTargets!(
                request.source,
                request.options,
                request.targets,
                request.documentVersion,
                request.newline,
                request.debugEnabled
            );
        } catch (error) {
            result = Object.freeze({
                status: "failed" as const,
                code: "ADAPTER_WORKER_FORMAT_FAILED",
                ...(request.debugEnabled
                    ? {
                          debugEvents: Object.freeze([
                              createDebugEvent(
                                  "worker",
                                  "ADAPTER_WORKER_FORMAT_FAILED",
                                  error
                              ),
                          ]),
                      }
                    : {}),
            });
        }
        const response: WorkerBatchResponseMessage = Object.freeze({
            kind: "batch-result",
            requestId: request.requestId,
            generation: request.generation,
            documentVersion: request.documentVersion,
            sourceDigest: request.sourceDigest,
            runtimeDigest,
            formattingMs: performance.now() - startedAt,
            result,
        });
        port.postMessage(response);
        return;
    }
    let result: FormatSqlExecution;
    try {
        result = runtime.executeFormatSql!(
            request.source,
            request.options,
            request.mode,
            request.newline,
            request.debugEnabled
        );
    } catch (error) {
        result = Object.freeze({
            result: failedFormatResult(
                request.source,
                "ADAPTER_WORKER_FORMAT_FAILED",
                "Formatter worker failed"
            ),
            debugEvents: request.debugEnabled
                ? Object.freeze([
                      createDebugEvent(
                          "worker",
                          "ADAPTER_WORKER_FORMAT_FAILED",
                          error
                      ),
                  ])
                : Object.freeze([]),
        });
    }
    const response: WorkerFormatResponseMessage = Object.freeze({
        kind: "result",
        requestId: request.requestId,
        generation: request.generation,
        documentVersion: request.documentVersion,
        targetId: request.targetId,
        sourceDigest: request.sourceDigest,
        runtimeDigest,
        formattingMs: performance.now() - startedAt,
        result,
    });
    port.postMessage(response);
});
