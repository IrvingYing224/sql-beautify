import { Worker } from "node:worker_threads";

import { computeEdits, rejectedDocument } from "./compute";
import type { ComputeRequest, ComputeResult } from "./types";

/** Requests over sources of at least this many code units run in the worker (plan §5.4, D4-A). */
export const WORKER_MIN_CODE_UNITS = 32 * 1024;

/** The part of a VS Code CancellationToken the executor uses. */
export interface CancellationSignal {
    readonly isCancellationRequested: boolean;
    onCancellationRequested(listener: () => void): { dispose(): void };
}

export interface WorkerMessage {
    readonly id: number;
    readonly request: ComputeRequest;
}

export interface WorkerReply {
    readonly id: number;
    readonly result: ComputeResult;
}

/** The part of a worker_threads Worker the executor uses. */
export interface WorkerPort {
    postMessage(message: WorkerMessage): void;
    on(event: "message", listener: (value: unknown) => void): unknown;
    on(event: "error", listener: (error: Error) => void): unknown;
    on(event: "exit", listener: (code: number) => void): unknown;
    terminate(): Promise<number>;
}

export const CANCELLED_RESULT: ComputeResult = {
    status: "cancelled",
    edits: [],
    selections: [],
    diagnostics: [],
    debugEvents: [],
};

interface Pending {
    readonly source: string;
    readonly resolve: (result: ComputeResult) => void;
    listener: { dispose(): void } | undefined;
}

export function nodeWorkerFactory(script: string): () => WorkerPort {
    return () => new Worker(script);
}

/**
 * Runs computeEdits on the extension host, or for large sources in one lazily created worker.
 * A worker error or exit fails every pending request; the next request starts a new worker.
 * Cancelling the only pending request terminates the worker; with others pending, only that
 * request settles and its reply is ignored, so one document's cancel cannot fail another's format.
 */
export class EditExecutor {
    private worker: WorkerPort | null = null;
    private readonly pending = new Map<number, Pending>();
    private nextId = 0;

    constructor(
        private readonly createWorker: () => WorkerPort,
        private readonly minWorkerCodeUnits = WORKER_MIN_CODE_UNITS
    ) {}

    run(request: ComputeRequest, token?: CancellationSignal): Promise<ComputeResult> {
        if (token?.isCancellationRequested === true) {
            return Promise.resolve(CANCELLED_RESULT);
        }
        if (request.source.length < this.minWorkerCodeUnits) {
            return Promise.resolve(computeEdits(request));
        }
        const worker = this.worker ?? this.start();
        const id = ++this.nextId;
        return new Promise((resolve) => {
            const pending: Pending = { source: request.source, resolve, listener: undefined };
            this.pending.set(id, pending);
            worker.postMessage({ id, request });
            pending.listener = token?.onCancellationRequested(() => this.cancel(id));
        });
    }

    /** Settles every pending request as cancelled and stops the worker. */
    dispose(): void {
        this.stop();
        for (const id of [...this.pending.keys()]) {
            this.settle(id, CANCELLED_RESULT);
        }
    }

    private start(): WorkerPort {
        const worker = this.createWorker();
        worker.on("message", (value) => {
            const reply = value as WorkerReply;
            this.settle(reply.id, reply.result);
        });
        worker.on("error", () => this.fail(worker));
        worker.on("exit", () => this.fail(worker));
        this.worker = worker;
        return worker;
    }

    private stop(): void {
        const worker = this.worker;
        this.worker = null;
        void worker?.terminate();
    }

    private settle(id: number, result: ComputeResult): void {
        const pending = this.pending.get(id);
        if (pending !== undefined) {
            this.pending.delete(id);
            pending.listener?.dispose();
            pending.resolve(result);
        }
    }

    private cancel(id: number): void {
        if (this.pending.size === 1 && this.pending.has(id)) {
            this.stop();
        }
        this.settle(id, CANCELLED_RESULT);
    }

    /** A worker that was already stopped or replaced fails nothing. */
    private fail(worker: WorkerPort): void {
        if (this.worker !== worker) {
            return;
        }
        this.worker = null;
        for (const [id, pending] of [...this.pending]) {
            this.settle(id, rejectedDocument(
                pending.source,
                "ADAPTER_WORKER_CRASH",
                "The formatter worker stopped unexpectedly"
            ));
        }
    }
}
