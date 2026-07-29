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

interface CanonicalSourceMapProof {
    readonly sourceLength: number;
    readonly outputLength: number;
    readonly mapper: SourceOffsetMapper;
}

const CANONICAL_SOURCE_MAPS = new WeakMap<object, CanonicalSourceMapProof>();

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

function snapshotSourceMap(
    sourceMap: unknown,
    sourceLength: number,
    outputLength: number
): SourceMap | null {
    try {
        if (
            !validLength(sourceLength) ||
            !validLength(outputLength) ||
            typeof sourceMap !== "object" ||
            sourceMap === null
        ) {
            return null;
        }
        const rawEntries = (sourceMap as SourceMap).entries;
        if (!Array.isArray(rawEntries)) {
            return null;
        }
        const stableEntries = Array.from(rawEntries);
        const entries: SourceMapEntry[] = [];
        let previousSourceEnd = 0;
        let previousOutputEnd = 0;
        for (const entry of stableEntries) {
            if (
                typeof entry !== "object" ||
                entry === null
            ) {
                return null;
            }
            const source = entry.source;
            const output = entry.output;
            const sourceStart = source.start;
            const sourceEnd = source.end;
            const outputStart = output.start;
            const outputEnd = output.end;
            if (
                !validSpanValues(sourceStart, sourceEnd, sourceLength) ||
                !validSpanValues(outputStart, outputEnd, outputLength) ||
                sourceEnd - sourceStart !== outputEnd - outputStart ||
                sourceStart < previousSourceEnd ||
                outputStart < previousOutputEnd
            ) {
                return null;
            }
            entries.push(Object.freeze({
                source: Object.freeze({
                    start: sourceStart,
                    end: sourceEnd,
                }),
                output: Object.freeze({
                    start: outputStart,
                    end: outputEnd,
                }),
            }));
            previousSourceEnd = sourceEnd;
            previousOutputEnd = outputEnd;
        }
        return Object.freeze({ entries: Object.freeze(entries) });
    } catch {
        return null;
    }
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

function mapStableOffset(
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

function mapperForStableMap(
    sourceMap: SourceMap,
    sourceLength: number,
    outputLength: number
): SourceOffsetMapper {
    const entries = sourceMap.entries;
    return Object.freeze({
        map(
            sourceOffset: number,
            affinity: SourceMapAffinity = "exact"
        ): number | null {
            return mapStableOffset(
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
 * Copies, validates and marks an internally owned source map. Only exact maps
 * returned by this function receive the cached binary-search proof.
 */
export function canonicalSourceMapSnapshot(
    sourceMap: unknown,
    sourceLength: number,
    outputLength: number
): SourceMap | null {
    if (typeof sourceMap === "object" && sourceMap !== null) {
        const existing = CANONICAL_SOURCE_MAPS.get(sourceMap);
        if (
            existing?.sourceLength === sourceLength &&
            existing.outputLength === outputLength
        ) {
            return sourceMap as SourceMap;
        }
    }
    const stableMap = snapshotSourceMap(sourceMap, sourceLength, outputLength);
    if (stableMap === null) {
        return null;
    }
    const mapper = mapperForStableMap(stableMap, sourceLength, outputLength);
    CANONICAL_SOURCE_MAPS.set(stableMap, Object.freeze({
        sourceLength,
        outputLength,
        mapper,
    }));
    return stableMap;
}

export function isValidSourceMap(
    sourceMap: unknown,
    sourceLength: number,
    outputLength: number
): sourceMap is SourceMap {
    if (typeof sourceMap === "object" && sourceMap !== null) {
        const proof = CANONICAL_SOURCE_MAPS.get(sourceMap);
        if (
            proof?.sourceLength === sourceLength &&
            proof.outputLength === outputLength
        ) {
            return true;
        }
    }
    return snapshotSourceMap(sourceMap, sourceLength, outputLength) !== null;
}

/**
 * Creates one stable mapper for a cursor/selection operation. Untrusted maps
 * are fully snapshotted once; canonical internal maps reuse their proof.
 */
export function createSourceOffsetMapper(
    sourceMap: unknown,
    sourceLength: number,
    outputLength: number
): SourceOffsetMapper | null {
    if (!validLength(sourceLength) || !validLength(outputLength)) {
        return null;
    }
    if (typeof sourceMap === "object" && sourceMap !== null) {
        const proof = CANONICAL_SOURCE_MAPS.get(sourceMap);
        if (
            proof?.sourceLength === sourceLength &&
            proof.outputLength === outputLength
        ) {
            return proof.mapper;
        }
    }
    const stableMap = snapshotSourceMap(sourceMap, sourceLength, outputLength);
    return stableMap === null
        ? null
        : mapperForStableMap(stableMap, sourceLength, outputLength);
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
