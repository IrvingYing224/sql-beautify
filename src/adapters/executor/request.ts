import type { CanonicalFormatOptions } from "../../core/config/options";
import { resolveFormatOptions } from "../../core/config/resolve-options";
import {
    inferRenderNewline,
    isRenderNewline,
    type RenderNewline,
} from "../../core/renderer/environment";
import {
    snapshotDataProperties,
    snapshotDenseDataArray,
} from "../boundary/data-snapshot";
import type {
    CancellationToken,
    FormatExecutionRequest,
    FormatTarget,
} from "../transaction/types";

const REQUEST_KEYS: ReadonlySet<string> = new Set([
    "source",
    "options",
    "mode",
    "documentVersion",
    "targetId",
    "newline",
    "cancellation",
    "debugEnabled",
]);
const BATCH_REQUEST_KEYS: ReadonlySet<string> = new Set([
    "source",
    "options",
    "targets",
    "documentVersion",
    "newline",
    "cancellation",
    "debugEnabled",
]);
const TARGET_KEYS: ReadonlySet<string> = new Set([
    "id",
    "start",
    "end",
    "mode",
]);

export interface StableFormatExecutionRequest {
    readonly source: string;
    readonly options: CanonicalFormatOptions;
    readonly mode: "document" | "fragment";
    readonly documentVersion: number;
    readonly targetId: string;
    readonly newline: RenderNewline;
    readonly cancellation?: CancellationToken;
    readonly debugEnabled: boolean;
}

export interface StableValidateAndFormatExecutionRequest {
    readonly source: string;
    readonly options: CanonicalFormatOptions;
    readonly targets: readonly FormatTarget[];
    readonly documentVersion: number;
    readonly newline: RenderNewline;
    readonly cancellation?: CancellationToken;
    readonly debugEnabled: boolean;
}

export function snapshotFormatExecutionSource(value: unknown): string {
    const raw = snapshotDataProperties(value, REQUEST_KEYS, []);
    return raw !== null && typeof raw.source === "string" ? raw.source : "";
}

export function snapshotFormatExecutionRequest(
    value: unknown
): StableFormatExecutionRequest | null {
    const raw = snapshotDataProperties(value, REQUEST_KEYS, [
        "source",
        "mode",
        "documentVersion",
        "targetId",
    ]);
    if (
        raw === null ||
        typeof raw.source !== "string" ||
        (raw.mode !== "document" && raw.mode !== "fragment") ||
        !Number.isSafeInteger(raw.documentVersion) ||
        (raw.documentVersion as number) < 0 ||
        typeof raw.targetId !== "string" ||
        raw.targetId.length === 0 ||
        (raw.debugEnabled !== undefined && typeof raw.debugEnabled !== "boolean")
    ) {
        return null;
    }
    const options = resolveFormatOptions(raw.options);
    const newline = raw.newline === undefined
        ? inferRenderNewline(raw.source)
        : raw.newline;
    if (!options.ok || !isRenderNewline(newline)) {
        return null;
    }
    const cancellation = raw.cancellation as CancellationToken | undefined;
    return Object.freeze({
        source: raw.source,
        options: options.options,
        mode: raw.mode,
        documentVersion: raw.documentVersion as number,
        targetId: raw.targetId,
        newline,
        debugEnabled: raw.debugEnabled === true,
        ...(cancellation === undefined ? {} : { cancellation }),
    });
}

export function snapshotValidateAndFormatExecutionSource(value: unknown): string {
    const raw = snapshotDataProperties(value, BATCH_REQUEST_KEYS, []);
    return raw !== null && typeof raw.source === "string" ? raw.source : "";
}

export function snapshotValidateAndFormatExecutionRequest(
    value: unknown
): StableValidateAndFormatExecutionRequest | null {
    const raw = snapshotDataProperties(value, BATCH_REQUEST_KEYS, [
        "source",
        "targets",
        "documentVersion",
    ]);
    if (
        raw === null ||
        typeof raw.source !== "string" ||
        !Number.isSafeInteger(raw.documentVersion) ||
        (raw.documentVersion as number) < 0 ||
        (raw.debugEnabled !== undefined && typeof raw.debugEnabled !== "boolean")
    ) {
        return null;
    }
    const rawTargets = snapshotDenseDataArray(raw.targets);
    if (rawTargets === null || rawTargets.length === 0) {
        return null;
    }
    const ids = new Set<string>();
    const targets: FormatTarget[] = [];
    for (const value of rawTargets) {
        const target = snapshotDataProperties(value, TARGET_KEYS, [
            "id",
            "start",
            "end",
            "mode",
        ]);
        if (
            target === null ||
            typeof target.id !== "string" ||
            target.id.length === 0 ||
            ids.has(target.id) ||
            !Number.isSafeInteger(target.start) ||
            !Number.isSafeInteger(target.end) ||
            (target.start as number) < 0 ||
            (target.end as number) < (target.start as number) ||
            (target.end as number) > raw.source.length ||
            (target.mode !== "document" && target.mode !== "fragment") ||
            (target.mode === "document" &&
                ((target.start as number) !== 0 ||
                    (target.end as number) !== raw.source.length))
        ) {
            return null;
        }
        ids.add(target.id);
        targets.push(Object.freeze({
            id: target.id,
            start: target.start as number,
            end: target.end as number,
            mode: target.mode,
        }));
    }
    targets.sort((left, right) =>
        left.start - right.start ||
        left.end - right.end ||
        (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
    );
    for (let index = 1; index < targets.length; index++) {
        if (targets[index - 1]!.end > targets[index]!.start) {
            return null;
        }
    }
    if (
        targets.some((target) => target.mode === "document") &&
        targets.length !== 1
    ) {
        return null;
    }
    const options = resolveFormatOptions(raw.options);
    const newline = raw.newline === undefined
        ? inferRenderNewline(raw.source)
        : raw.newline;
    if (!options.ok || !isRenderNewline(newline)) {
        return null;
    }
    const cancellation = raw.cancellation as CancellationToken | undefined;
    return Object.freeze({
        source: raw.source,
        options: options.options,
        targets: Object.freeze(targets),
        documentVersion: raw.documentVersion as number,
        newline,
        debugEnabled: raw.debugEnabled === true,
        ...(cancellation === undefined ? {} : { cancellation }),
    });
}

export function executionRequestForCore(
    request: StableFormatExecutionRequest
): FormatExecutionRequest {
    return Object.freeze({
        source: request.source,
        options: request.options,
        mode: request.mode,
        documentVersion: request.documentVersion,
        targetId: request.targetId,
        newline: request.newline,
        debugEnabled: request.debugEnabled,
        ...(request.cancellation === undefined
            ? {}
            : { cancellation: request.cancellation }),
    });
}
