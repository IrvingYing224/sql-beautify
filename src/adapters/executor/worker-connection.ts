import { Worker } from "node:worker_threads";

export interface WorkerMessageHandlers {
    readonly message: (value: unknown) => void;
    readonly error: (error: Error) => void;
    readonly exit: (code: number) => void;
}

export interface WorkerConnection {
    postMessage(value: unknown): void;
    setHandlers(handlers: WorkerMessageHandlers): () => void;
    terminate(): Promise<number>;
}

export type WorkerConnectionFactory = (generation: number) => WorkerConnection;

export function createNodeWorkerFactory(
    workerScript: string,
    runtimePath: string
): WorkerConnectionFactory {
    return () => {
        const worker = new Worker(workerScript, {
            workerData: Object.freeze({ runtimePath }),
        });
        return {
            postMessage(value: unknown): void {
                worker.postMessage(value);
            },
            setHandlers(handlers: WorkerMessageHandlers): () => void {
                worker.on("message", handlers.message);
                worker.on("error", handlers.error);
                worker.on("exit", handlers.exit);
                return () => {
                    worker.off("message", handlers.message);
                    worker.off("error", handlers.error);
                    worker.off("exit", handlers.exit);
                };
            },
            async terminate(): Promise<number> {
                return await worker.terminate();
            },
        };
    };
}
