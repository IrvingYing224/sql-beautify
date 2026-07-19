import type { CanonicalFormatOptions } from "../../core/config/options";
import { resolveFormatOptions } from "../../core/config/resolve-options";
import { snapshotDataProperties } from "../boundary/data-snapshot";
import type {
    CancellationToken,
    FormatExecutionRequest,
} from "../transaction/types";

const REQUEST_KEYS: ReadonlySet<string> = new Set([
    "source",
    "options",
    "mode",
    "documentVersion",
    "targetId",
    "cancellation",
]);

export interface StableFormatExecutionRequest {
    readonly source: string;
    readonly options: CanonicalFormatOptions;
    readonly mode: "document" | "fragment";
    readonly documentVersion: number;
    readonly targetId: string;
    readonly cancellation?: CancellationToken;
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
        raw.targetId.length === 0
    ) {
        return null;
    }
    const options = resolveFormatOptions(raw.options);
    if (!options.ok) {
        return null;
    }
    const cancellation = raw.cancellation as CancellationToken | undefined;
    return Object.freeze({
        source: raw.source,
        options: options.options,
        mode: raw.mode,
        documentVersion: raw.documentVersion as number,
        targetId: raw.targetId,
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
        ...(request.cancellation === undefined
            ? {}
            : { cancellation: request.cancellation }),
    });
}
