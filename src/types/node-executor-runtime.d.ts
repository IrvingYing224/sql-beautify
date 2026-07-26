declare function require(path: string): unknown;

declare module "node:crypto" {
    interface Hash {
        update(value: string | Uint8Array, encoding?: "utf8"): Hash;
        digest(encoding: "hex"): string;
    }

    export function createHash(algorithm: "sha256"): Hash;
}

declare module "node:fs" {
    export const constants: Readonly<{ readonly R_OK: number }>;
    export function accessSync(path: string, mode?: number): void;
    export function readFileSync(path: string): Uint8Array;
    export function statSync(path: string): Readonly<{ isFile(): boolean }>;
}

declare module "node:perf_hooks" {
    export const performance: Readonly<{
        now(): number;
    }>;
}

declare module "node:worker_threads" {
    interface WorkerOptions {
        readonly workerData?: unknown;
    }

    interface MessagePort {
        on(event: "message", listener: (value: unknown) => void): this;
        postMessage(value: unknown): void;
    }

    interface WorkerData {
        readonly runtimePath?: unknown;
    }

    export const parentPort: MessagePort | null;
    export const workerData: WorkerData | unknown;

    export class Worker {
        constructor(filename: string, options?: WorkerOptions);
        postMessage(value: unknown): void;
        on(event: "message", listener: (value: unknown) => void): this;
        on(event: "error", listener: (error: Error) => void): this;
        on(event: "exit", listener: (code: number) => void): this;
        off(event: "message", listener: (value: unknown) => void): this;
        off(event: "error", listener: (error: Error) => void): this;
        off(event: "exit", listener: (code: number) => void): this;
        terminate(): Promise<number>;
    }
}
