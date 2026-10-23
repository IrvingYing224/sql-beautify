import { parentPort } from "node:worker_threads";

import { computeEdits } from "./compute";
import type { WorkerMessage, WorkerReply } from "./executor";

// The worker entry (dist/worker.cjs): runs computeEdits for each message and replies with its id.

const port = parentPort!;
port.on("message", (value: unknown) => {
    const message = value as WorkerMessage;
    const reply: WorkerReply = { id: message.id, result: computeEdits(message.request) };
    port.postMessage(reply);
});
