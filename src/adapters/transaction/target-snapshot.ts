import { snapshotDataProperties } from "../boundary/data-snapshot";
import type { FormatTarget } from "./types";

export interface TargetRangeSnapshot {
    readonly id: string;
    readonly start: number;
    readonly end: number;
}

const TARGET_RANGE_KEYS: ReadonlySet<string> = new Set([
    "id",
    "start",
    "end",
]);
const FORMAT_TARGET_KEYS: ReadonlySet<string> = new Set([
    "id",
    "start",
    "end",
    "mode",
]);
const RANGE_VALIDATION_TARGET_KEYS: ReadonlySet<string> = new Set([
    "id",
    "start",
    "end",
    "mode",
    "selection",
]);

function validRange(
    id: unknown,
    start: unknown,
    end: unknown,
    sourceLength: number,
    enforceBounds: boolean
): id is string {
    return typeof id === "string" &&
        id.length > 0 &&
        Number.isSafeInteger(start) &&
        Number.isSafeInteger(end) &&
        (!enforceBounds || (
            (start as number) >= 0 &&
            (end as number) >= (start as number) &&
            (end as number) <= sourceLength
        ));
}

export function snapshotTargetRange(
    value: unknown,
    sourceLength: number
): TargetRangeSnapshot | null {
    try {
        const raw = snapshotDataProperties(
            value,
            TARGET_RANGE_KEYS,
            ["id", "start", "end"]
        );
        if (
            raw === null ||
            !Number.isSafeInteger(sourceLength) ||
            sourceLength < 0 ||
            !validRange(raw.id, raw.start, raw.end, sourceLength, true)
        ) {
            return null;
        }
        return Object.freeze({
            id: raw.id,
            start: raw.start as number,
            end: raw.end as number,
        });
    } catch {
        return null;
    }
}

export function snapshotFormatTarget(
    value: unknown,
    sourceLength: number,
    allowSelectionKey = false,
    enforceBounds = true
): FormatTarget | null {
    try {
        const raw = snapshotDataProperties(
            value,
            allowSelectionKey
                ? RANGE_VALIDATION_TARGET_KEYS
                : FORMAT_TARGET_KEYS,
            ["id", "start", "end", "mode"]
        );
        if (
            raw === null ||
            !Number.isSafeInteger(sourceLength) ||
            sourceLength < 0 ||
            !validRange(
                raw.id,
                raw.start,
                raw.end,
                sourceLength,
                enforceBounds
            ) ||
            (raw.mode !== "document" && raw.mode !== "fragment")
        ) {
            return null;
        }
        return Object.freeze({
            id: raw.id,
            start: raw.start as number,
            end: raw.end as number,
            mode: raw.mode,
        });
    } catch {
        return null;
    }
}
