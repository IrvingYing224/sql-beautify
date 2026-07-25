import { performance } from "node:perf_hooks";

import type { FormatResult } from "../../core/api/format-result";
import {
    failedFormatResult,
    isFormatResultSafeForSource,
    snapshotFormatResult,
} from "../boundary/format-result-snapshot";
import {
    observeCancellation,
    type CancellationObservation,
} from "../transaction/cancellation";
import type {
    FormatExecutionRequest,
    FormatterExecutor,
} from "../transaction/types";
import {
    snapshotFormatExecutionRequest,
    snapshotFormatExecutionSource,
    type StableFormatExecutionRequest,
} from "./request";
import {
    snapshotWorkerResponseMessage,
    sourceDigest,
    type WorkerFormatRequestMessage,
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
    readonly maxQueueSize?: number;
    readonly maxQueuedSourceCodeUnits?: number;
}

export interface PersistentWorkerStatistics {
    readonly requests: number;
    readonly restarts: number;
    readonly staleResponses: number;
    readonly workerStartMs: number;
    readonly lastFormattingMs: number;
    readonly lastRoundTripMs: number;
    readonly lastTransferMs: number;
}

interface PendingRequest {
    readonly requestId: number;
    readonly request: StableFormatExecutionRequest;
    readonly digest: string;
    readonly resolve: (result: FormatResult) => void;
    observation: CancellationObservation;
    state: "queued" | "active" | "done";
    generation: number;
    dispatchedAt: number;
    timeout: ReturnType<typeof setTimeout> | null;
}

interface WorkerState {
    readonly connection: WorkerConnection;
    readonly generation: number;
    readonly unsubscribe: () => void;
    retired: boolean;
}

export class PersistentWorkerExecutor implements FormatterExecutor {
    private readonly factory: WorkerConnectionFactory;
    private readonly runtimeDigest: string;
    private readonly maxConsecutiveFailures: number;
    private readonly maxStaleResponses: number;
    private readonly requestTimeoutMs: number;
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
            !Number.isSafeInteger(this.maxQueueSize) ||
            this.maxQueueSize < 1 ||
            !Number.isSafeInteger(this.maxQueuedSourceCodeUnits) ||
            this.maxQueuedSourceCodeUnits < 1
        ) {
            throw new TypeError("Persistent worker executor options are invalid");
        }
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
        if (this.disposed) {
            return failedFormatResult(
                snapshot.source,
                "ADAPTER_CANCELLED",
                "Formatting was cancelled",
                "warning"
            );
        }
        return await new Promise<FormatResult>((resolve) => {
            let pending: PendingRequest | null = null;
            let cancellationObserved = false;
            const observation = observeCancellation(snapshot.cancellation, () => {
                cancellationObserved = true;
                if (pending !== null) {
                    this.cancelPending(pending);
                }
            });
            pending = {
                requestId: this.nextRequestId++,
                request: snapshot,
                digest: sourceDigest(snapshot.source),
                resolve,
                observation,
                state: "queued",
                generation: 0,
                dispatchedAt: 0,
                timeout: null,
            };
            this.requests += 1;
            if (cancellationObserved || observation.isCancelled()) {
                this.finishCancelled(pending);
                return;
            }
            const canDispatchImmediately =
                this.active === null &&
                this.queue.length === 0 &&
                this.retirement === null;
            if (
                !canDispatchImmediately &&
                (this.queue.length >= this.maxQueueSize ||
                    this.queuedSourceCodeUnits + snapshot.source.length >
                        this.maxQueuedSourceCodeUnits)
            ) {
                this.finish(
                    pending,
                    failedFormatResult(
                        snapshot.source,
                        "ADAPTER_WORKER_BACKPRESSURE",
                        "Formatter worker queue is full",
                        "warning"
                    )
                );
                return;
            }
            this.queue.push(pending);
            this.queuedSourceCodeUnits += pending.request.source.length;
            this.pump();
        });
    }

    statistics(): PersistentWorkerStatistics {
        return Object.freeze({
            requests: this.requests,
            restarts: this.restarts,
            staleResponses: this.staleResponses,
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
            this.finishCancelled(active);
        }
        while (this.queue.length > 0) {
            this.finishCancelled(this.dequeue()!);
        }
        await this.beginRetireWorker();
    }

    private finish(pending: PendingRequest, result: FormatResult): void {
        if (pending.state === "done") {
            return;
        }
        if (pending.timeout !== null) {
            clearTimeout(pending.timeout);
            pending.timeout = null;
        }
        pending.state = "done";
        pending.observation.dispose();
        pending.resolve(result);
    }

    private finishCancelled(pending: PendingRequest): void {
        this.finish(
            pending,
            failedFormatResult(
                pending.request.source,
                "ADAPTER_CANCELLED",
                "Formatting was cancelled",
                "warning"
            )
        );
    }

    private cancelPending(pending: PendingRequest): void {
        if (pending.state === "done") {
            return;
        }
        if (pending.state === "queued") {
            const index = this.queue.indexOf(pending);
            if (index >= 0) {
                this.queue.splice(index, 1);
                this.queuedSourceCodeUnits -= pending.request.source.length;
            }
            this.finishCancelled(pending);
            return;
        }
        if (this.active === pending) {
            this.active = null;
            this.finishCancelled(pending);
            void this.beginRetireWorker().then(() => this.pump());
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
                error: () => {
                    if (initializing) {
                        failedDuringInitialization = true;
                    } else {
                        this.handleFailure(state!);
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
        if (
            this.disposed ||
            this.active !== null ||
            this.retirement !== null
        ) {
            return;
        }
        while (this.queue.length > 0) {
            const pending = this.dequeue()!;
            if (pending.observation.isCancelled()) {
                this.finishCancelled(pending);
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
            const message: WorkerFormatRequestMessage = Object.freeze({
                kind: "format",
                requestId: pending.requestId,
                generation: pending.generation,
                documentVersion: pending.request.documentVersion,
                targetId: pending.request.targetId,
                sourceDigest: pending.digest,
                source: pending.request.source,
                options: pending.request.options,
                mode: pending.request.mode,
                newline: pending.request.newline,
            });
            pending.timeout = setTimeout(() => {
                if (
                    this.active === pending &&
                    this.worker === worker &&
                    pending.state === "active"
                ) {
                    this.handleFailure(worker, "ADAPTER_WORKER_TIMEOUT");
                }
            }, this.requestTimeoutMs);
            try {
                worker.connection.postMessage(message);
            } catch {
                this.handleFailure(worker);
            }
            return;
        }
    }

    private handleMessage(state: WorkerState, value: unknown): void {
        if (this.worker !== state || state.retired || this.active === null) {
            return;
        }
        const response = snapshotWorkerResponseMessage(value);
        const pending = this.active;
        if (pending.observation.isCancelled()) {
            this.active = null;
            this.staleForActive = 0;
            this.finishCancelled(pending);
            void this.beginRetireWorker().then(() => this.pump());
            return;
        }
        if (
            response === null ||
            response.requestId !== pending.requestId ||
            response.generation !== pending.generation ||
            response.documentVersion !== pending.request.documentVersion ||
            response.targetId !== pending.request.targetId ||
            response.sourceDigest !== pending.digest ||
            response.runtimeDigest !== this.runtimeDigest
        ) {
            this.staleResponses += 1;
            this.staleForActive += 1;
            if (this.staleForActive >= this.maxStaleResponses) {
                this.handleFailure(state, "ADAPTER_WORKER_STALE_RESPONSE");
            }
            return;
        }
        const result = snapshotFormatResult(response.result);
        if (result === null || !isFormatResultSafeForSource(result, pending.request.source)) {
            this.handleFailure(state, "ADAPTER_WORKER_RESULT_CONTRACT");
            return;
        }
        this.active = null;
        this.staleForActive = 0;
        this.consecutiveFailures = 0;
        this.lastFormattingMs = response.formattingMs;
        this.lastRoundTripMs = performance.now() - pending.dispatchedAt;
        this.lastTransferMs = Math.max(0, this.lastRoundTripMs - response.formattingMs);
        this.finish(pending, result);
        this.pump();
    }

    private handleFailure(
        state: WorkerState,
        code: string = "ADAPTER_WORKER_CRASH"
    ): void {
        if (this.worker !== state || state.retired) {
            return;
        }
        const pending = this.active;
        this.active = null;
        this.staleForActive = 0;
        this.consecutiveFailures += 1;
        if (pending !== null) {
            this.finish(
                pending,
                failedFormatResult(
                    pending.request.source,
                    code,
                    "Formatter worker failed"
                )
            );
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
                failedFormatResult(
                    pending.request.source,
                    "ADAPTER_WORKER_UNAVAILABLE",
                    "Formatter worker is unavailable"
                )
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
                failedFormatResult(
                    pending.request.source,
                    "ADAPTER_WORKER_UNAVAILABLE",
                    "Formatter worker is unavailable"
                )
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
