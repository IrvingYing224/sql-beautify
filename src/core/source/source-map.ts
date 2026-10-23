import type { SourceSpan } from "./source-span";

/** One length-preserving source-derived output run. Generated layout is unmapped. */
export interface SourceMapEntry {
    readonly source: SourceSpan;
    readonly output: SourceSpan;
}

export interface SourceMap {
    readonly entries: readonly SourceMapEntry[];
}

export type SourceMapAffinity = "exact" | "left" | "right";

export interface SourceOffsetMapper {
    readonly map: (
        sourceOffset: number,
        affinity?: SourceMapAffinity
    ) => number | null;
}

function validLength(value: number): boolean {
    return Number.isSafeInteger(value) && value >= 0;
}

function validSpanValues(start: number, end: number, maximum: number): boolean {
    return Number.isSafeInteger(start) &&
        Number.isSafeInteger(end) &&
        start >= 0 &&
        end > start &&
        end <= maximum;
}

/** Entries are non-empty, length-preserving, in bounds and monotonic on both sides. */
export function isValidSourceMap(
    sourceMap: SourceMap,
    sourceLength: number,
    outputLength: number
): boolean {
    if (!validLength(sourceLength) || !validLength(outputLength)) {
        return false;
    }
    let previousSourceEnd = 0;
    let previousOutputEnd = 0;
    for (const { source, output } of sourceMap.entries) {
        if (
            !validSpanValues(source.start, source.end, sourceLength) ||
            !validSpanValues(output.start, output.end, outputLength) ||
            source.end - source.start !== output.end - output.start ||
            source.start < previousSourceEnd ||
            output.start < previousOutputEnd
        ) {
            return false;
        }
        previousSourceEnd = source.end;
        previousOutputEnd = output.end;
    }
    return true;
}

function firstEntryEndingAtOrAfter(
    entries: readonly SourceMapEntry[],
    sourceOffset: number
): number {
    let low = 0;
    let high = entries.length;
    while (low < high) {
        const middle = low + Math.floor((high - low) / 2);
        if (entries[middle]!.source.end < sourceOffset) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    return low;
}

function mapOffset(
    entries: readonly SourceMapEntry[],
    sourceOffset: number,
    sourceLength: number,
    outputLength: number,
    affinity: SourceMapAffinity
): number | null {
    if (
        !Number.isSafeInteger(sourceOffset) ||
        sourceOffset < 0 ||
        sourceOffset > sourceLength ||
        (affinity !== "exact" && affinity !== "left" && affinity !== "right")
    ) {
        return null;
    }
    if (entries.length === 0) {
        return sourceLength === 0 && outputLength === 0 ? 0 : null;
    }

    const index = firstEntryEndingAtOrAfter(entries, sourceOffset);
    if (index === entries.length) {
        const previous = entries[entries.length - 1]!;
        if (sourceOffset > previous.source.end && affinity === "exact") {
            return null;
        }
        return affinity === "right" ? outputLength : previous.output.end;
    }

    const entry = entries[index]!;
    const previous = entries[index - 1];
    const next = entries[index + 1];
    if (sourceOffset > entry.source.start && sourceOffset < entry.source.end) {
        return entry.output.start + sourceOffset - entry.source.start;
    }
    if (sourceOffset === entry.source.start) {
        const hasSourceGap = previous !== undefined
            ? entry.source.start > previous.source.end
            : entry.source.start > 0;
        if (hasSourceGap) {
            if (affinity === "left") {
                return previous === undefined ? 0 : previous.output.end;
            }
            return affinity === "right" ? entry.output.start : null;
        }
        if (affinity === "left" && previous !== undefined) {
            return previous.output.end;
        }
        return entry.output.start;
    }
    if (sourceOffset === entry.source.end) {
        if (next !== undefined && next.source.start > entry.source.end) {
            if (affinity === "left") {
                return entry.output.end;
            }
            return affinity === "right" ? next.output.start : null;
        }
        if (affinity !== "right") {
            return entry.output.end;
        }
        if (next === undefined) {
            return entry.source.end === sourceLength
                ? outputLength
                : entry.output.end;
        }
        return next.output.start;
    }
    if (sourceOffset < entry.source.start) {
        if (affinity === "left") {
            return previous === undefined ? 0 : previous.output.end;
        }
        return affinity === "right" ? entry.output.start : null;
    }
    return null;
}

/** Creates one mapper for a cursor/selection operation; invalid maps return null. */
export function createSourceOffsetMapper(
    sourceMap: SourceMap,
    sourceLength: number,
    outputLength: number
): SourceOffsetMapper | null {
    if (!isValidSourceMap(sourceMap, sourceLength, outputLength)) {
        return null;
    }
    const entries = sourceMap.entries;
    return Object.freeze({
        map(
            sourceOffset: number,
            affinity: SourceMapAffinity = "exact"
        ): number | null {
            return mapOffset(
                entries,
                sourceOffset,
                sourceLength,
                outputLength,
                affinity
            );
        },
    });
}

/**
 * Maps a UTF-16 source cursor through the renderer source map. Generated
 * whitespace is resolved only through an explicit affinity.
 */
export function mapSourceOffset(
    sourceMap: SourceMap,
    sourceOffset: number,
    sourceLength: number,
    outputLength: number,
    affinity: SourceMapAffinity = "exact"
): number | null {
    return createSourceOffsetMapper(sourceMap, sourceLength, outputLength)
        ?.map(sourceOffset, affinity) ?? null;
}
