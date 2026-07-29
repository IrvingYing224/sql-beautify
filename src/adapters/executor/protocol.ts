import { createHash } from "node:crypto";

import type { CanonicalFormatOptions } from "../../core/config/options";
import { resolveFormatOptions } from "../../core/config/resolve-options";
import {
    isRenderNewline,
    isRenderTabSize,
    type RenderNewline,
    type RenderTabSize,
} from "../../core/renderer/environment";
import {
    snapshotDataProperties,
    snapshotDataProperty,
} from "../boundary/data-snapshot";
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
    "tabSize",
    "debugEnabled",
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
    "tabSize",
    "debugEnabled",
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
const PROTOCOL_ERROR_RESPONSE_KEYS: ReadonlySet<string> = new Set([
    "kind",
    "requestKind",
    "requestId",
    "generation",
    "documentVersion",
    "targetId",
    "sourceDigest",
    "runtimeDigest",
    "code",
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
    readonly tabSize: RenderTabSize;
    readonly debugEnabled: boolean;
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
    readonly tabSize: RenderTabSize;
    readonly debugEnabled: boolean;
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

export type WorkerRequestKind = "format" | "validate-and-format";

export interface WorkerRequestIdentity {
    readonly requestKind: WorkerRequestKind;
    readonly requestId: number;
    readonly generation: number;
    readonly documentVersion: number;
    readonly targetId: string | null;
    readonly sourceDigest: string;
}

export interface WorkerProtocolErrorResponseMessage {
    readonly kind: "protocol-error";
    readonly requestKind: WorkerRequestKind;
    readonly requestId: number;
    readonly generation: number;
    readonly documentVersion: number;
    readonly targetId: string | null;
    readonly sourceDigest: string;
    readonly runtimeDigest: string;
    readonly code: "ADAPTER_WORKER_PROTOCOL";
}

export interface WorkerResponseIdentity extends WorkerRequestIdentity {
    readonly runtimeDigest: string;
}

export type WorkerRequestMessage =
    | WorkerFormatRequestMessage
    | WorkerBatchRequestMessage;

export type WorkerResponseMessage =
    | WorkerFormatResponseMessage
    | WorkerBatchResponseMessage
    | WorkerProtocolErrorResponseMessage;

function validPositiveInteger(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) >= 1;
}

function validDocumentVersion(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validDigest(value: unknown): value is string {
    return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function validFormattingMs(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function sourceDigest(source: string): string {
    return createHash("sha256").update(source, "utf8").digest("hex");
}

export function snapshotWorkerRequestIdentity(
    value: unknown
): WorkerRequestIdentity | null {
    const kind = snapshotDataProperty(value, "kind")?.value;
    if (kind !== "format" && kind !== "validate-and-format") {
        return null;
    }
    const requestId = snapshotDataProperty(value, "requestId")?.value;
    const generation = snapshotDataProperty(value, "generation")?.value;
    const documentVersion = snapshotDataProperty(value, "documentVersion")?.value;
    const digest = snapshotDataProperty(value, "sourceDigest")?.value;
    const targetId = kind === "format"
        ? snapshotDataProperty(value, "targetId")?.value
        : null;
    if (
        !validPositiveInteger(requestId) ||
        !validPositiveInteger(generation) ||
        !validDocumentVersion(documentVersion) ||
        !validDigest(digest) ||
        (kind === "format" &&
            (typeof targetId !== "string" || targetId.length === 0))
    ) {
        return null;
    }
    return Object.freeze({
        requestKind: kind,
        requestId,
        generation,
        documentVersion,
        targetId: kind === "format" ? targetId as string : null,
        sourceDigest: digest,
    });
}

function snapshotFormatRequest(value: unknown): WorkerFormatRequestMessage | null {
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
        "tabSize",
        "debugEnabled",
    ]);
    if (
        raw === null ||
        raw.kind !== "format" ||
        !validPositiveInteger(raw.requestId) ||
        !validPositiveInteger(raw.generation) ||
        !validDocumentVersion(raw.documentVersion) ||
        typeof raw.targetId !== "string" ||
        raw.targetId.length === 0 ||
        !validDigest(raw.sourceDigest) ||
        typeof raw.source !== "string" ||
        (raw.mode !== "document" && raw.mode !== "fragment") ||
        !isRenderNewline(raw.newline) ||
        !isRenderTabSize(raw.tabSize) ||
        typeof raw.debugEnabled !== "boolean"
    ) {
        return null;
    }
    const options = resolveFormatOptions(raw.options);
    if (!options.ok || sourceDigest(raw.source) !== raw.sourceDigest) {
        return null;
    }
    return Object.freeze({
        kind: "format",
        requestId: raw.requestId,
        generation: raw.generation,
        documentVersion: raw.documentVersion,
        targetId: raw.targetId,
        sourceDigest: raw.sourceDigest,
        source: raw.source,
        options: options.options,
        mode: raw.mode,
        newline: raw.newline,
        tabSize: raw.tabSize,
        debugEnabled: raw.debugEnabled,
    });
}

function snapshotBatchRequest(value: unknown): WorkerBatchRequestMessage | null {
    const raw = snapshotDataProperties(value, BATCH_REQUEST_KEYS, [
        "kind",
        "requestId",
        "generation",
        "documentVersion",
        "sourceDigest",
        "source",
        "options",
        "targets",
        "newline",
        "tabSize",
        "debugEnabled",
    ]);
    if (
        raw === null ||
        raw.kind !== "validate-and-format" ||
        !validPositiveInteger(raw.requestId) ||
        !validPositiveInteger(raw.generation) ||
        !validDocumentVersion(raw.documentVersion) ||
        !validDigest(raw.sourceDigest) ||
        typeof raw.source !== "string" ||
        !isRenderNewline(raw.newline) ||
        !isRenderTabSize(raw.tabSize) ||
        typeof raw.debugEnabled !== "boolean" ||
        sourceDigest(raw.source) !== raw.sourceDigest
    ) {
        return null;
    }
    const batch = snapshotValidateAndFormatExecutionRequest({
        source: raw.source,
        options: raw.options,
        targets: raw.targets,
        documentVersion: raw.documentVersion,
        newline: raw.newline,
        tabSize: raw.tabSize,
        debugEnabled: raw.debugEnabled,
    });
    if (batch === null) {
        return null;
    }
    return Object.freeze({
        kind: "validate-and-format",
        requestId: raw.requestId,
        generation: raw.generation,
        documentVersion: batch.documentVersion,
        sourceDigest: raw.sourceDigest,
        source: batch.source,
        options: batch.options,
        targets: batch.targets,
        newline: batch.newline,
        tabSize: batch.tabSize,
        debugEnabled: batch.debugEnabled,
    });
}

export function snapshotWorkerRequestMessage(
    value: unknown
): WorkerRequestMessage | null {
    const kind = snapshotDataProperty(value, "kind")?.value;
    return kind === "format"
        ? snapshotFormatRequest(value)
        : kind === "validate-and-format"
            ? snapshotBatchRequest(value)
            : null;
}

function snapshotCommonResponse(
    raw: Readonly<Record<string, unknown>> | null
): Readonly<{
    requestId: number;
    generation: number;
    documentVersion: number;
    sourceDigest: string;
    runtimeDigest: string;
}> | null {
    return raw !== null &&
        validPositiveInteger(raw.requestId) &&
        validPositiveInteger(raw.generation) &&
        validDocumentVersion(raw.documentVersion) &&
        validDigest(raw.sourceDigest) &&
        validDigest(raw.runtimeDigest)
        ? Object.freeze({
              requestId: raw.requestId,
              generation: raw.generation,
              documentVersion: raw.documentVersion,
              sourceDigest: raw.sourceDigest,
              runtimeDigest: raw.runtimeDigest,
          })
        : null;
}

function snapshotFormatResponse(value: unknown): WorkerFormatResponseMessage | null {
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
    const common = snapshotCommonResponse(raw);
    if (
        raw === null ||
        common === null ||
        raw.kind !== "result" ||
        typeof raw.targetId !== "string" ||
        raw.targetId.length === 0 ||
        !validFormattingMs(raw.formattingMs)
    ) {
        return null;
    }
    return Object.freeze({
        kind: "result",
        ...common,
        targetId: raw.targetId,
        formattingMs: raw.formattingMs,
        result: raw.result,
    });
}

function snapshotBatchResponse(value: unknown): WorkerBatchResponseMessage | null {
    const raw = snapshotDataProperties(value, BATCH_RESPONSE_KEYS, [
        "kind",
        "requestId",
        "generation",
        "documentVersion",
        "sourceDigest",
        "runtimeDigest",
        "formattingMs",
        "result",
    ]);
    const common = snapshotCommonResponse(raw);
    if (
        raw === null ||
        common === null ||
        raw.kind !== "batch-result" ||
        !validFormattingMs(raw.formattingMs)
    ) {
        return null;
    }
    return Object.freeze({
        kind: "batch-result",
        ...common,
        formattingMs: raw.formattingMs,
        result: raw.result,
    });
}

function snapshotProtocolErrorResponse(
    value: unknown
): WorkerProtocolErrorResponseMessage | null {
    const raw = snapshotDataProperties(value, PROTOCOL_ERROR_RESPONSE_KEYS, [
        "kind",
        "requestKind",
        "requestId",
        "generation",
        "documentVersion",
        "targetId",
        "sourceDigest",
        "runtimeDigest",
        "code",
    ]);
    const common = snapshotCommonResponse(raw);
    if (
        raw === null ||
        common === null ||
        raw.kind !== "protocol-error" ||
        (raw.requestKind !== "format" &&
            raw.requestKind !== "validate-and-format") ||
        raw.code !== "ADAPTER_WORKER_PROTOCOL" ||
        (raw.requestKind === "format"
            ? typeof raw.targetId !== "string" || raw.targetId.length === 0
            : raw.targetId !== null)
    ) {
        return null;
    }
    return Object.freeze({
        kind: "protocol-error",
        requestKind: raw.requestKind,
        ...common,
        targetId: raw.targetId as string | null,
        code: "ADAPTER_WORKER_PROTOCOL",
    });
}

export function snapshotWorkerResponseMessage(
    value: unknown
): WorkerResponseMessage | null {
    const kind = snapshotDataProperty(value, "kind")?.value;
    return kind === "result"
        ? snapshotFormatResponse(value)
        : kind === "batch-result"
            ? snapshotBatchResponse(value)
            : kind === "protocol-error"
                ? snapshotProtocolErrorResponse(value)
                : null;
}

export function snapshotWorkerResponseIdentity(
    value: unknown
): WorkerResponseIdentity | null {
    const kind = snapshotDataProperty(value, "kind")?.value;
    let requestKind: WorkerRequestKind;
    let targetId: unknown;
    if (kind === "result") {
        requestKind = "format";
        targetId = snapshotDataProperty(value, "targetId")?.value;
    } else if (kind === "batch-result") {
        requestKind = "validate-and-format";
        targetId = null;
    } else if (kind === "protocol-error") {
        const requested = snapshotDataProperty(value, "requestKind")?.value;
        if (requested !== "format" && requested !== "validate-and-format") {
            return null;
        }
        requestKind = requested;
        targetId = snapshotDataProperty(value, "targetId")?.value;
    } else {
        return null;
    }
    const requestId = snapshotDataProperty(value, "requestId")?.value;
    const generation = snapshotDataProperty(value, "generation")?.value;
    const documentVersion = snapshotDataProperty(value, "documentVersion")?.value;
    const digest = snapshotDataProperty(value, "sourceDigest")?.value;
    const runtimeDigest = snapshotDataProperty(value, "runtimeDigest")?.value;
    if (
        !validPositiveInteger(requestId) ||
        !validPositiveInteger(generation) ||
        !validDocumentVersion(documentVersion) ||
        !validDigest(digest) ||
        !validDigest(runtimeDigest) ||
        (requestKind === "format"
            ? typeof targetId !== "string" || targetId.length === 0
            : targetId !== null)
    ) {
        return null;
    }
    return Object.freeze({
        requestKind,
        requestId,
        generation,
        documentVersion,
        targetId: targetId as string | null,
        sourceDigest: digest,
        runtimeDigest,
    });
}
