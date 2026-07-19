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

function validSpan(
    span: SourceSpan,
    maximum: number
): boolean {
    return (
        Number.isSafeInteger(span.start) &&
        Number.isSafeInteger(span.end) &&
        span.start >= 0 &&
        span.end > span.start &&
        span.end <= maximum
    );
}

function snapshotSourceMap(
    sourceMap: unknown,
    sourceLength: number,
    outputLength: number
): SourceMap | null {
    try {
        if (
            !Number.isSafeInteger(sourceLength) ||
            !Number.isSafeInteger(outputLength) ||
            sourceLength < 0 ||
            outputLength < 0 ||
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
                !validSpan(entry.source, sourceLength) ||
                !validSpan(entry.output, outputLength) ||
                entry.source.end - entry.source.start !==
                    entry.output.end - entry.output.start ||
                entry.source.start < previousSourceEnd ||
                entry.output.start < previousOutputEnd
            ) {
                return null;
            }
            entries.push(Object.freeze({
                source: Object.freeze({
                    start: entry.source.start,
                    end: entry.source.end,
                }),
                output: Object.freeze({
                    start: entry.output.start,
                    end: entry.output.end,
                }),
            }));
            previousSourceEnd = entry.source.end;
            previousOutputEnd = entry.output.end;
        }
        return Object.freeze({ entries: Object.freeze(entries) });
    } catch {
        return null;
    }
}

export function isValidSourceMap(
    sourceMap: unknown,
    sourceLength: number,
    outputLength: number
): sourceMap is SourceMap {
    return snapshotSourceMap(sourceMap, sourceLength, outputLength) !== null;
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
    const stableMap = snapshotSourceMap(sourceMap, sourceLength, outputLength);
    if (
        !Number.isSafeInteger(sourceOffset) ||
        !Number.isSafeInteger(sourceLength) ||
        !Number.isSafeInteger(outputLength) ||
        sourceLength < 0 ||
        outputLength < 0 ||
        sourceOffset < 0 ||
        sourceOffset > sourceLength ||
        (affinity !== "exact" && affinity !== "left" && affinity !== "right") ||
        stableMap === null
    ) {
        return null;
    }

    const entries = stableMap.entries;
    if (entries.length === 0) {
        return sourceLength === 0 && outputLength === 0 ? 0 : null;
    }

    let previousSourceEnd = 0;
    let previousOutputEnd = 0;
    let previousEntry: SourceMapEntry | null = null;
    for (let index = 0; index < entries.length; index++) {
        const entry = entries[index]!;
        if (sourceOffset > entry.source.start && sourceOffset < entry.source.end) {
            return entry.output.start + sourceOffset - entry.source.start;
        }
        if (sourceOffset === entry.source.start) {
            const hasSourceGap =
                previousEntry !== null &&
                entry.source.start > previousEntry.source.end;
            if (hasSourceGap || (previousEntry === null && entry.source.start > 0)) {
                if (affinity === "left") {
                    return previousEntry === null ? 0 : previousEntry.output.end;
                }
                return affinity === "right" ? entry.output.start : null;
            }
            if (affinity === "left" && previousEntry !== null) {
                return previousEntry.output.end;
            }
            return entry.output.start;
        }
        if (sourceOffset === entry.source.end) {
            const next = entries[index + 1];
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
            if (affinity === "left" && previousEntry !== null) {
                return previousEntry.output.end;
            }
            if (previousEntry === null) {
                return affinity === "left" ? 0 : affinity === "right" ? entry.output.start : null;
            }
            if (affinity === "right") {
                return entry.output.start;
            }
            return null;
        }

        previousSourceEnd = entry.source.end;
        previousOutputEnd = entry.output.end;
        previousEntry = entry;
    }

    if (sourceOffset >= previousSourceEnd) {
        if (sourceOffset > previousSourceEnd && affinity === "exact") {
            return null;
        }
        return affinity === "right" ? outputLength : previousOutputEnd;
    }
    return null;
}
