import { createHash } from "node:crypto";

import type { CanonicalFormatOptions } from "../../core/config/options";
import { resolveFormatOptions } from "../../core/config/resolve-options";
import {
    isRenderNewline,
    type RenderNewline,
} from "../../core/renderer/environment";
import { snapshotDataProperties } from "../boundary/data-snapshot";
import type { FormatTarget } from "../transaction/types";
import { snapshotValidateAndFormatExecutionRequest } from "./request";

const FORMAT_REQUEST_KEYS: ReadonlySet<string> = new Set([
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
const BATCH_REQUEST_KEYS: ReadonlySet<string> = new Set([
    "kind",
    "requestId",
    "generation",
    "documentVersion",
    "sourceDigest",
    "source",
    "options",
    "targets",
    "newline",
]);
const FORMAT_RESPONSE_KEYS: ReadonlySet<string> = new Set([
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
const BATCH_RESPONSE_KEYS: ReadonlySet<string> = new Set([
    "kind",
    "requestId",
    "generation",
    "documentVersion",
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

export interface WorkerBatchRequestMessage {
    readonly kind: "validate-and-format";
    readonly requestId: number;
    readonly generation: number;
    readonly documentVersion: number;
    readonly sourceDigest: string;
    readonly source: string;
    readonly options: CanonicalFormatOptions;
    readonly targets: readonly FormatTarget[];
    readonly newline: RenderNewline;
}

export interface WorkerBatchResponseMessage {
    readonly kind: "batch-result";
    readonly requestId: number;
    readonly generation: number;
    readonly documentVersion: number;
    readonly sourceDigest: string;
    readonly runtimeDigest: string;
    readonly formattingMs: number;
    readonly result: unknown;
}

export type WorkerRequestMessage =
    | WorkerFormatRequestMessage
    | WorkerBatchRequestMessage;

export type WorkerResponseMessage =
    | WorkerFormatResponseMessage
    | WorkerBatchResponseMessage;

export function sourceDigest(source: string): string {
    return createHash("sha256").update(source, "utf8").digest("hex");
}

export function snapshotWorkerRequestMessage(
    value: unknown
): WorkerRequestMessage | null {
    const raw = snapshotDataProperties(value, FORMAT_REQUEST_KEYS, [
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
        const batchRaw = snapshotDataProperties(value, BATCH_REQUEST_KEYS, [
            "kind",
            "requestId",
            "generation",
            "documentVersion",
            "sourceDigest",
            "source",
            "options",
            "targets",
            "newline",
        ]);
        if (
            batchRaw === null ||
            batchRaw.kind !== "validate-and-format" ||
            !Number.isSafeInteger(batchRaw.requestId) ||
            (batchRaw.requestId as number) < 1 ||
            !Number.isSafeInteger(batchRaw.generation) ||
            (batchRaw.generation as number) < 1 ||
            !Number.isSafeInteger(batchRaw.documentVersion) ||
            (batchRaw.documentVersion as number) < 0 ||
            typeof batchRaw.sourceDigest !== "string" ||
            !/^[a-f0-9]{64}$/.test(batchRaw.sourceDigest) ||
            typeof batchRaw.source !== "string" ||
            !isRenderNewline(batchRaw.newline) ||
            sourceDigest(batchRaw.source) !== batchRaw.sourceDigest
        ) {
            return null;
        }
        const batch = snapshotValidateAndFormatExecutionRequest({
            source: batchRaw.source,
            options: batchRaw.options,
            targets: batchRaw.targets,
            documentVersion: batchRaw.documentVersion,
            newline: batchRaw.newline,
        });
        if (batch === null) {
            return null;
        }
        return Object.freeze({
            kind: "validate-and-format" as const,
            requestId: batchRaw.requestId as number,
            generation: batchRaw.generation as number,
            documentVersion: batch.documentVersion,
            sourceDigest: batchRaw.sourceDigest,
            source: batch.source,
            options: batch.options,
            targets: batch.targets,
            newline: batch.newline,
        });
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
): WorkerResponseMessage | null {
    const raw = snapshotDataProperties(value, FORMAT_RESPONSE_KEYS, [
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
        const batchRaw = snapshotDataProperties(value, BATCH_RESPONSE_KEYS, [
            "kind",
            "requestId",
            "generation",
            "documentVersion",
            "sourceDigest",
            "runtimeDigest",
            "formattingMs",
            "result",
        ]);
        if (
            batchRaw === null ||
            batchRaw.kind !== "batch-result" ||
            !Number.isSafeInteger(batchRaw.requestId) ||
            (batchRaw.requestId as number) < 1 ||
            !Number.isSafeInteger(batchRaw.generation) ||
            (batchRaw.generation as number) < 1 ||
            !Number.isSafeInteger(batchRaw.documentVersion) ||
            (batchRaw.documentVersion as number) < 0 ||
            typeof batchRaw.sourceDigest !== "string" ||
            !/^[a-f0-9]{64}$/.test(batchRaw.sourceDigest) ||
            typeof batchRaw.runtimeDigest !== "string" ||
            !/^[a-f0-9]{64}$/.test(batchRaw.runtimeDigest) ||
            typeof batchRaw.formattingMs !== "number" ||
            !Number.isFinite(batchRaw.formattingMs) ||
            batchRaw.formattingMs < 0
        ) {
            return null;
        }
        return Object.freeze({
            kind: "batch-result" as const,
            requestId: batchRaw.requestId as number,
            generation: batchRaw.generation as number,
            documentVersion: batchRaw.documentVersion as number,
            sourceDigest: batchRaw.sourceDigest,
            runtimeDigest: batchRaw.runtimeDigest,
            formattingMs: batchRaw.formattingMs,
            result: batchRaw.result,
        });
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
