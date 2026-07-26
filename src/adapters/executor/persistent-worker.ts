import { performance } from "node:perf_hooks";

import type { FormatResult } from "../../core/api/format-result";
import { createDebugEvent, type DebugEvent } from "../../core/diagnostics/debug-event";
import { failedFormatResult } from "../boundary/format-result-snapshot";
import {
    formatExecutionOutcome,
    snapshotFormatExecutionOutcome,
} from "../boundary/execution-outcome-snapshot";
import {
    observeCancellation,
    type CancellationObservation,
} from "../transaction/cancellation";
import type {
    FormatBatchExecutionResult,
    FormatExecutionOutcome,
    FormatExecutionRequest,
    FormatterExecutor,
    ValidateAndFormatExecutionRequest,
} from "../transaction/types";
import { snapshotFormatBatchExecutionResult } from "./batch";
import {
    snapshotFormatExecutionRequest,
    snapshotFormatExecutionSource,
    snapshotValidateAndFormatExecutionRequest,
    type StableFormatExecutionRequest,
    type StableValidateAndFormatExecutionRequest,
} from "./request";
import {
    snapshotWorkerResponseMessage,
    sourceDigest,
    type WorkerBatchRequestMessage,
    type WorkerFormatRequestMessage,
    type WorkerRequestMessage,
    type WorkerResponseMessage,
} from "./protocol";
import type {
    WorkerConnection,
    WorkerConnectionFactory,
} from "./worker-connection";

export interface PersistentWorkerExecutorOptions {
    readonly workerFactory: WorkerConnectionFactory;
    readonly runtimeDigest: string;
    readonly maxConsecutiveFailures?: number;
    readonly maxStaleResponses?: number;
    readonly requestTimeoutMs?: number;
    readonly cancellationGraceMs?: number;
    readonly maxQueueSize?: number;
    readonly maxQueuedSourceCodeUnits?: number;
}

export interface PersistentWorkerStatistics {
    readonly requests: number;
    readonly restarts: number;
    readonly staleResponses: number;
    readonly cancellationReuses: number;
    readonly cancellationRetirements: number;
    readonly workerStartMs: number;
    readonly lastFormattingMs: number;
    readonly lastRoundTripMs: number;
    readonly lastTransferMs: number;
}

type StableExecutionRequest =
    | StableFormatExecutionRequest
    | StableValidateAndFormatExecutionRequest;
type ExecutionResult = FormatExecutionOutcome | FormatBatchExecutionResult;

interface PendingRequest {
    readonly kind: "format" | "batch";
    readonly requestId: number;
    readonly request: StableExecutionRequest;
    readonly digest: string;
    readonly deadlineAt: number;
    readonly resolve: (result: ExecutionResult) => void;
    observation: CancellationObservation;
    state: "queued" | "active" | "draining" | "done";
    settled: boolean;
    generation: number;
    dispatchedAt: number;
    timeout: ReturnType<typeof setTimeout> | null;
    drainTimeout: ReturnType<typeof setTimeout> | null;
}

interface WorkerState {
    readonly connection: WorkerConnection;
    readonly generation: number;
    readonly unsubscribe: () => void;
    retired: boolean;
}

function failedBatch(
    code: string,
    debugEvents: readonly DebugEvent[] = Object.freeze([])
): FormatBatchExecutionResult {
    return Object.freeze({
        status: "failed" as const,
        code,
        ...(debugEvents.length === 0 ? {} : { debugEvents }),
    });
}

export class PersistentWorkerExecutor implements FormatterExecutor {
    private readonly factory: WorkerConnectionFactory;
    private readonly runtimeDigest: string;
    private readonly maxConsecutiveFailures: number;
    private readonly maxStaleResponses: number;
    private readonly requestTimeoutMs: number;
    private readonly cancellationGraceMs: number;
    private readonly maxQueueSize: number;
    private readonly maxQueuedSourceCodeUnits: number;
    private readonly queue: PendingRequest[] = [];
    private queuedSourceCodeUnits = 0;
    private worker: WorkerState | null = null;
    private retirement: Promise<void> | null = null;
    private active: PendingRequest | null = null;
    private disposed = false;
    private nextRequestId = 1;
    private generation = 0;
    private consecutiveFailures = 0;
    private staleForActive = 0;
    private requests = 0;
    private restarts = 0;
    private staleResponses = 0;
    private cancellationReuses = 0;
    private cancellationRetirements = 0;
    private workerStartMs = 0;
    private lastFormattingMs = 0;
    private lastRoundTripMs = 0;
    private lastTransferMs = 0;

    constructor(options: PersistentWorkerExecutorOptions) {
        this.factory = options.workerFactory;
        this.runtimeDigest = options.runtimeDigest;
        this.maxConsecutiveFailures = options.maxConsecutiveFailures ?? 3;
        this.maxStaleResponses = options.maxStaleResponses ?? 8;
        this.requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
        this.cancellationGraceMs = options.cancellationGraceMs ?? 200;
        this.maxQueueSize = options.maxQueueSize ?? 64;
        this.maxQueuedSourceCodeUnits =
            options.maxQueuedSourceCodeUnits ?? 4 * 1024 * 1024;
        if (
            typeof this.factory !== "function" ||
            !/^[a-f0-9]{64}$/.test(this.runtimeDigest) ||
            !Number.isSafeInteger(this.maxConsecutiveFailures) ||
            this.maxConsecutiveFailures < 1 ||
            !Number.isSafeInteger(this.maxStaleResponses) ||
            this.maxStaleResponses < 1 ||
            !Number.isSafeInteger(this.requestTimeoutMs) ||
            this.requestTimeoutMs < 1 ||
            !Number.isSafeInteger(this.cancellationGraceMs) ||
            this.cancellationGraceMs < 1 ||
            !Number.isSafeInteger(this.maxQueueSize) ||
            this.maxQueueSize < 1 ||
            !Number.isSafeInteger(this.maxQueuedSourceCodeUnits) ||
            this.maxQueuedSourceCodeUnits < 1
        ) {
            throw new TypeError("Persistent worker executor options are invalid");
        }
    }

    async format(request: FormatExecutionRequest): Promise<FormatResult> {
        return (await this.execute(request)).result;
    }

    async execute(
        request: FormatExecutionRequest
    ): Promise<FormatExecutionOutcome> {
        const snapshot = snapshotFormatExecutionRequest(request);
        if (snapshot === null) {
            return formatExecutionOutcome(
                failedFormatResult(
                    snapshotFormatExecutionSource(request),
                    "ADAPTER_EXECUTION_REQUEST",
                    "Formatter execution request is invalid"
                )
            );
        }
        if (this.disposed) {
            return formatExecutionOutcome(
                this.failedFormat(snapshot.source, "ADAPTER_CANCELLED")
            );
        }
        return await new Promise<FormatExecutionOutcome>((resolve) => {
            this.enqueue("format", snapshot, (result) => {
                resolve(result as FormatExecutionOutcome);
            });
        });
    }

    async validateAndFormat(
        request: ValidateAndFormatExecutionRequest
    ): Promise<FormatBatchExecutionResult> {
        const snapshot = snapshotValidateAndFormatExecutionRequest(request);
        if (snapshot === null) {
            return failedBatch("ADAPTER_EXECUTION_REQUEST");
        }
        if (this.disposed) {
            return failedBatch("ADAPTER_CANCELLED");
        }
        return await new Promise<FormatBatchExecutionResult>((resolve) => {
            this.enqueue("batch", snapshot, (result) => {
                resolve(result as FormatBatchExecutionResult);
            });
        });
    }

    statistics(): PersistentWorkerStatistics {
        return Object.freeze({
            requests: this.requests,
            restarts: this.restarts,
            staleResponses: this.staleResponses,
            cancellationReuses: this.cancellationReuses,
            cancellationRetirements: this.cancellationRetirements,
            workerStartMs: this.workerStartMs,
            lastFormattingMs: this.lastFormattingMs,
            lastRoundTripMs: this.lastRoundTripMs,
            lastTransferMs: this.lastTransferMs,
        });
    }

    async dispose(): Promise<void> {
        if (this.disposed) {
            if (this.retirement !== null) {
                await this.retirement;
            }
            return;
        }
        this.disposed = true;
        const active = this.active;
        this.active = null;
        if (active !== null) {
            this.finish(active, this.cancelledResult(active));
        }
        while (this.queue.length > 0) {
            const pending = this.dequeue()!;
            this.finish(pending, this.cancelledResult(pending));
        }
        await this.beginRetireWorker();
    }

    private enqueue(
        kind: PendingRequest["kind"],
        request: StableExecutionRequest,
        resolve: PendingRequest["resolve"]
    ): void {
        let pending: PendingRequest | null = null;
        let cancellationObserved = false;
        const observation = observeCancellation(request.cancellation, () => {
            cancellationObserved = true;
            if (pending !== null) {
                this.cancelPending(pending);
            }
        });
        const now = performance.now();
        pending = {
            kind,
            requestId: this.nextRequestId++,
            request,
            digest: sourceDigest(request.source),
            deadlineAt: now + this.requestTimeoutMs,
            resolve,
            observation,
            state: "queued",
            settled: false,
            generation: 0,
            dispatchedAt: 0,
            timeout: null,
            drainTimeout: null,
        };
        this.requests += 1;
        if (cancellationObserved || observation.isCancelled()) {
            this.finish(pending, this.cancelledResult(pending));
            return;
        }
        const canDispatchImmediately =
            this.active === null &&
            this.queue.length === 0 &&
            this.retirement === null;
        if (
            !canDispatchImmediately &&
            (this.queue.length >= this.maxQueueSize ||
                this.queuedSourceCodeUnits + request.source.length >
                    this.maxQueuedSourceCodeUnits)
        ) {
            this.finish(pending, this.failedResult(
                pending,
                "ADAPTER_WORKER_BACKPRESSURE"
            ));
            return;
        }
        pending.timeout = setTimeout(() => {
            this.handleDeadline(pending!);
        }, this.requestTimeoutMs);
        this.queue.push(pending);
        this.queuedSourceCodeUnits += request.source.length;
        this.pump();
    }

    private failedFormat(source: string, code: string): FormatResult {
        return failedFormatResult(
            source,
            code,
            code === "ADAPTER_CANCELLED"
                ? "Formatting was cancelled"
                : "Formatter worker failed",
            code === "ADAPTER_CANCELLED" ||
                code === "ADAPTER_WORKER_BACKPRESSURE"
                ? "warning"
                : "error"
        );
    }

    private failedResult(
        pending: PendingRequest,
        code: string,
        error: unknown = undefined
    ): ExecutionResult {
        const debugEvents = pending.request.debugEnabled && error !== undefined
            ? Object.freeze([createDebugEvent("worker", code, error)])
            : Object.freeze([]);
        return pending.kind === "batch"
            ? failedBatch(code, debugEvents)
            : formatExecutionOutcome(
                  this.failedFormat(pending.request.source, code),
                  debugEvents
              );
    }

    private cancelledResult(pending: PendingRequest): ExecutionResult {
        return this.failedResult(pending, "ADAPTER_CANCELLED");
    }

    private settle(pending: PendingRequest, result: ExecutionResult): void {
        if (pending.settled) {
            return;
        }
        pending.settled = true;
        pending.observation.dispose();
        pending.resolve(result);
    }

    private finish(pending: PendingRequest, result: ExecutionResult): void {
        if (pending.state === "done") {
            return;
        }
        if (pending.timeout !== null) {
            clearTimeout(pending.timeout);
            pending.timeout = null;
        }
        if (pending.drainTimeout !== null) {
            clearTimeout(pending.drainTimeout);
            pending.drainTimeout = null;
        }
        pending.state = "done";
        this.settle(pending, result);
    }

    private cancelPending(pending: PendingRequest): void {
        if (pending.state === "done" || pending.state === "draining") {
            return;
        }
        if (pending.state === "queued") {
            const index = this.queue.indexOf(pending);
            if (index >= 0) {
                this.queue.splice(index, 1);
                this.queuedSourceCodeUnits -= pending.request.source.length;
            }
            this.finish(pending, this.cancelledResult(pending));
            return;
        }
        if (this.active === pending) {
            this.beginCancellationDrain(pending);
        }
    }

    private beginCancellationDrain(pending: PendingRequest): void {
        if (pending.state === "draining" || pending.state === "done") {
            return;
        }
        this.settle(pending, this.cancelledResult(pending));
        if (pending.timeout !== null) {
            clearTimeout(pending.timeout);
            pending.timeout = null;
        }
        pending.state = "draining";
        pending.drainTimeout = setTimeout(() => {
            if (this.active !== pending || pending.state !== "draining") {
                return;
            }
            this.active = null;
            this.staleForActive = 0;
            this.cancellationRetirements += 1;
            this.finish(pending, this.cancelledResult(pending));
            void this.beginRetireWorker().then(() => this.pump());
        }, this.cancellationGraceMs);
    }

    private handleDeadline(pending: PendingRequest): void {
        if (pending.state === "done" || pending.state === "draining") {
            return;
        }
        if (pending.state === "queued") {
            const index = this.queue.indexOf(pending);
            if (index >= 0) {
                this.queue.splice(index, 1);
                this.queuedSourceCodeUnits -= pending.request.source.length;
            }
            this.finish(
                pending,
                this.failedResult(pending, "ADAPTER_WORKER_TIMEOUT")
            );
            return;
        }
        const worker = this.worker;
        if (this.active === pending && worker !== null) {
            this.handleFailure(worker, "ADAPTER_WORKER_TIMEOUT");
        }
    }

    private ensureWorker(): WorkerState | null {
        if (this.worker !== null) {
            return this.worker;
        }
        const startedAt = performance.now();
        let state: WorkerState | null = null;
        try {
            const generation = ++this.generation;
            const connection = this.factory(generation);
            let unsubscribeHandlers: (() => void) | null = null;
            let initializing = true;
            let failedDuringInitialization = false;
            state = {
                connection,
                generation,
                unsubscribe: () => {
                    const unsubscribe = unsubscribeHandlers;
                    unsubscribeHandlers = null;
                    unsubscribe?.();
                },
                retired: false,
            };
            const registeredUnsubscribe = connection.setHandlers({
                message: (value) => {
                    if (initializing) {
                        failedDuringInitialization = true;
                    } else {
                        this.handleMessage(state!, value);
                    }
                },
                error: (error) => {
                    if (initializing) {
                        failedDuringInitialization = true;
                    } else {
                        this.handleFailure(state!, "ADAPTER_WORKER_CRASH", error);
                    }
                },
                exit: () => {
                    if (initializing) {
                        failedDuringInitialization = true;
                    } else {
                        this.handleFailure(state!);
                    }
                },
            });
            if (typeof registeredUnsubscribe !== "function") {
                throw new TypeError("Worker connection disposer is invalid");
            }
            unsubscribeHandlers = registeredUnsubscribe;
            initializing = false;
            if (failedDuringInitialization) {
                this.worker = state;
                void this.beginRetireWorker().then(() => this.resumeAfterFailure());
                this.workerStartMs = performance.now() - startedAt;
                return null;
            }
            this.worker = state;
            if (generation > 1) {
                this.restarts += 1;
            }
            this.workerStartMs = performance.now() - startedAt;
            return state;
        } catch {
            if (state !== null) {
                this.worker = state;
                void this.beginRetireWorker().then(() => this.resumeAfterFailure());
            }
            this.workerStartMs = performance.now() - startedAt;
            return null;
        }
    }

    private pump(): void {
        if (this.disposed || this.active !== null || this.retirement !== null) {
            return;
        }
        while (this.queue.length > 0) {
            const pending = this.dequeue()!;
            if (pending.observation.isCancelled()) {
                this.finish(pending, this.cancelledResult(pending));
                continue;
            }
            if (performance.now() >= pending.deadlineAt) {
                this.finish(
                    pending,
                    this.failedResult(pending, "ADAPTER_WORKER_TIMEOUT")
                );
                continue;
            }
            this.active = pending;
            this.staleForActive = 0;
            pending.state = "active";
            const worker = this.ensureWorker();
            if (worker === null) {
                this.handleUnavailable();
                return;
            }
            pending.generation = worker.generation;
            pending.dispatchedAt = performance.now();
            const message = this.workerMessage(pending);
            try {
                worker.connection.postMessage(message);
            } catch (error) {
                this.handleFailure(worker, "ADAPTER_WORKER_CRASH", error);
            }
            return;
        }
    }

    private workerMessage(pending: PendingRequest): WorkerRequestMessage {
        if (pending.kind === "batch") {
            const request = pending.request as StableValidateAndFormatExecutionRequest;
            const message: WorkerBatchRequestMessage = Object.freeze({
                kind: "validate-and-format",
                requestId: pending.requestId,
                generation: pending.generation,
                documentVersion: request.documentVersion,
                sourceDigest: pending.digest,
                source: request.source,
                options: request.options,
                targets: request.targets,
                newline: request.newline,
                debugEnabled: request.debugEnabled,
            });
            return message;
        }
        const request = pending.request as StableFormatExecutionRequest;
        const message: WorkerFormatRequestMessage = Object.freeze({
            kind: "format",
            requestId: pending.requestId,
            generation: pending.generation,
            documentVersion: request.documentVersion,
            targetId: request.targetId,
            sourceDigest: pending.digest,
            source: request.source,
            options: request.options,
            mode: request.mode,
            newline: request.newline,
            debugEnabled: request.debugEnabled,
        });
        return message;
    }

    private responseMatches(
        response: WorkerResponseMessage,
        pending: PendingRequest
    ): boolean {
        if (
            response.requestId !== pending.requestId ||
            response.generation !== pending.generation ||
            response.documentVersion !== pending.request.documentVersion ||
            response.sourceDigest !== pending.digest ||
            response.runtimeDigest !== this.runtimeDigest
        ) {
            return false;
        }
        if (pending.kind === "batch") {
            return response.kind === "batch-result";
        }
        const request = pending.request as StableFormatExecutionRequest;
        return response.kind === "result" && response.targetId === request.targetId;
    }

    private snapshotResponseResult(
        response: WorkerResponseMessage,
        pending: PendingRequest
    ): ExecutionResult | null {
        if (pending.kind === "batch") {
            if (response.kind !== "batch-result") {
                return null;
            }
            return snapshotFormatBatchExecutionResult(
                response.result,
                pending.request as StableValidateAndFormatExecutionRequest
            );
        }
        if (response.kind !== "result") {
            return null;
        }
        return snapshotFormatExecutionOutcome(
            response.result,
            pending.request.source
        );
    }

    private handleMessage(state: WorkerState, value: unknown): void {
        if (this.worker !== state || state.retired || this.active === null) {
            return;
        }
        const response = snapshotWorkerResponseMessage(value);
        const pending = this.active;
        if (pending.observation.isCancelled() && pending.state === "active") {
            this.beginCancellationDrain(pending);
        }
        if (response === null || !this.responseMatches(response, pending)) {
            this.staleResponses += 1;
            this.staleForActive += 1;
            if (this.staleForActive >= this.maxStaleResponses) {
                this.handleFailure(state, "ADAPTER_WORKER_STALE_RESPONSE");
            }
            return;
        }
        const result = this.snapshotResponseResult(response, pending);
        if (result === null) {
            this.handleFailure(state, "ADAPTER_WORKER_RESULT_CONTRACT");
            return;
        }
        this.active = null;
        this.staleForActive = 0;
        this.consecutiveFailures = 0;
        this.lastFormattingMs = response.formattingMs;
        this.lastRoundTripMs = performance.now() - pending.dispatchedAt;
        this.lastTransferMs = Math.max(
            0,
            this.lastRoundTripMs - response.formattingMs
        );
        const wasDraining = pending.state === "draining";
        this.finish(pending, wasDraining ? this.cancelledResult(pending) : result);
        if (wasDraining) {
            this.cancellationReuses += 1;
        }
        this.pump();
    }

    private handleFailure(
        state: WorkerState,
        code: string = "ADAPTER_WORKER_CRASH",
        error: unknown = undefined
    ): void {
        if (this.worker !== state || state.retired) {
            return;
        }
        const pending = this.active;
        this.active = null;
        this.staleForActive = 0;
        this.consecutiveFailures += 1;
        if (pending !== null) {
            if (pending.state === "draining") {
                this.cancellationRetirements += 1;
            }
            this.finish(pending, this.failedResult(pending, code, error));
        }
        void this.beginRetireWorker().then(() => this.resumeAfterFailure());
    }

    private handleUnavailable(): void {
        const pending = this.active;
        this.active = null;
        this.staleForActive = 0;
        this.consecutiveFailures += 1;
        if (pending !== null) {
            this.finish(
                pending,
                this.failedResult(pending, "ADAPTER_WORKER_UNAVAILABLE")
            );
        }
        if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
            this.failQueueUnavailable();
        } else {
            this.pump();
        }
    }

    private failQueueUnavailable(): void {
        while (this.queue.length > 0) {
            const pending = this.dequeue()!;
            this.finish(
                pending,
                this.failedResult(pending, "ADAPTER_WORKER_UNAVAILABLE")
            );
        }
    }

    private resumeAfterFailure(): void {
        if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
            this.failQueueUnavailable();
        } else {
            this.pump();
        }
    }

    private dequeue(): PendingRequest | undefined {
        const pending = this.queue.shift();
        if (pending !== undefined) {
            this.queuedSourceCodeUnits -= pending.request.source.length;
        }
        return pending;
    }

    private beginRetireWorker(): Promise<void> {
        if (this.retirement !== null) {
            return this.retirement;
        }
        const state = this.worker;
        if (state === null) {
            return Promise.resolve();
        }
        this.worker = null;
        state.retired = true;
        const retirement = (async (): Promise<void> => {
            try {
                state.unsubscribe();
            } catch {
                // The worker is already isolated; termination remains authoritative.
            }
            try {
                await state.connection.terminate();
            } catch {
                return;
            }
        })();
        this.retirement = retirement;
        void retirement.then(() => {
            if (this.retirement === retirement) {
                this.retirement = null;
            }
        });
        return retirement;
    }
}
