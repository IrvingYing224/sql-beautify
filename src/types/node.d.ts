// The few Node APIs the extension uses; the project does not depend on @types/node.

declare const __dirname: string;

declare module "node:path" {
    export function join(...parts: string[]): string;
}

declare module "node:worker_threads" {
    interface MessagePort {
        on(event: "message", listener: (value: unknown) => void): this;
        postMessage(value: unknown): void;
    }

    export const parentPort: MessagePort | null;

    export class Worker {
        constructor(filename: string);
        postMessage(value: unknown): void;
        on(event: "message", listener: (value: unknown) => void): this;
        on(event: "error", listener: (error: Error) => void): this;
        on(event: "exit", listener: (code: number) => void): this;
        terminate(): Promise<number>;
    }
}
