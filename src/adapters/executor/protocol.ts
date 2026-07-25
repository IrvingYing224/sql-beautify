import { createHash } from "node:crypto";

import type { CanonicalFormatOptions } from "../../core/config/options";
import { resolveFormatOptions } from "../../core/config/resolve-options";
import {
    isRenderNewline,
    type RenderNewline,
} from "../../core/renderer/environment";
import { snapshotDataProperties } from "../boundary/data-snapshot";

const REQUEST_KEYS: ReadonlySet<string> = new Set([
    "kind",
    "requestId",
    "generation",
    "documentVersion",
    "targetId",
    "sourceDigest",
    "source",
    "options",
    "mode",
    "newline",
]);
const RESPONSE_KEYS: ReadonlySet<string> = new Set([
    "kind",
    "requestId",
    "generation",
    "documentVersion",
    "targetId",
    "sourceDigest",
    "runtimeDigest",
    "formattingMs",
    "result",
]);

export interface WorkerFormatRequestMessage {
    readonly kind: "format";
    readonly requestId: number;
    readonly generation: number;
    readonly documentVersion: number;
    readonly targetId: string;
    readonly sourceDigest: string;
    readonly source: string;
    readonly options: CanonicalFormatOptions;
    readonly mode: "document" | "fragment";
    readonly newline: RenderNewline;
}

export interface WorkerFormatResponseMessage {
    readonly kind: "result";
    readonly requestId: number;
    readonly generation: number;
    readonly documentVersion: number;
    readonly targetId: string;
    readonly sourceDigest: string;
    readonly runtimeDigest: string;
    readonly formattingMs: number;
    readonly result: unknown;
}

export function sourceDigest(source: string): string {
    return createHash("sha256").update(source, "utf8").digest("hex");
}

export function snapshotWorkerRequestMessage(
    value: unknown
): WorkerFormatRequestMessage | null {
    const raw = snapshotDataProperties(value, REQUEST_KEYS, [
        "kind",
        "requestId",
        "generation",
        "documentVersion",
        "targetId",
        "sourceDigest",
        "source",
        "options",
        "mode",
        "newline",
    ]);
    if (
        raw === null ||
        raw.kind !== "format" ||
        !Number.isSafeInteger(raw.requestId) ||
        (raw.requestId as number) < 1 ||
        !Number.isSafeInteger(raw.generation) ||
        (raw.generation as number) < 1 ||
        !Number.isSafeInteger(raw.documentVersion) ||
        (raw.documentVersion as number) < 0 ||
        typeof raw.targetId !== "string" ||
        raw.targetId.length === 0 ||
        typeof raw.sourceDigest !== "string" ||
        !/^[a-f0-9]{64}$/.test(raw.sourceDigest) ||
        typeof raw.source !== "string" ||
        (raw.mode !== "document" && raw.mode !== "fragment") ||
        !isRenderNewline(raw.newline)
    ) {
        return null;
    }
    const options = resolveFormatOptions(raw.options);
    if (!options.ok || sourceDigest(raw.source) !== raw.sourceDigest) {
        return null;
    }
    return Object.freeze({
        kind: "format" as const,
        requestId: raw.requestId as number,
        generation: raw.generation as number,
        documentVersion: raw.documentVersion as number,
        targetId: raw.targetId,
        sourceDigest: raw.sourceDigest,
        source: raw.source,
        options: options.options,
        mode: raw.mode,
        newline: raw.newline,
    });
}

export function snapshotWorkerResponseMessage(
    value: unknown
): WorkerFormatResponseMessage | null {
    const raw = snapshotDataProperties(value, RESPONSE_KEYS, [
        "kind",
        "requestId",
        "generation",
        "documentVersion",
        "targetId",
        "sourceDigest",
        "runtimeDigest",
        "formattingMs",
        "result",
    ]);
    if (
        raw === null ||
        raw.kind !== "result" ||
        !Number.isSafeInteger(raw.requestId) ||
        (raw.requestId as number) < 1 ||
        !Number.isSafeInteger(raw.generation) ||
        (raw.generation as number) < 1 ||
        !Number.isSafeInteger(raw.documentVersion) ||
        (raw.documentVersion as number) < 0 ||
        typeof raw.targetId !== "string" ||
        raw.targetId.length === 0 ||
        typeof raw.sourceDigest !== "string" ||
        !/^[a-f0-9]{64}$/.test(raw.sourceDigest) ||
        typeof raw.runtimeDigest !== "string" ||
        !/^[a-f0-9]{64}$/.test(raw.runtimeDigest) ||
        typeof raw.formattingMs !== "number" ||
        !Number.isFinite(raw.formattingMs) ||
        raw.formattingMs < 0
    ) {
        return null;
    }
    return Object.freeze({
        kind: "result" as const,
        requestId: raw.requestId as number,
        generation: raw.generation as number,
        documentVersion: raw.documentVersion as number,
        targetId: raw.targetId,
        sourceDigest: raw.sourceDigest,
        runtimeDigest: raw.runtimeDigest,
        formattingMs: raw.formattingMs,
        result: raw.result,
    });
}
