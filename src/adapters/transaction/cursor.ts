import {
    mapSourceOffset,
    type SourceMapAffinity,
} from "../../core/source/source-map";
import type { SourceMap } from "../../core/source/source-map";

export interface CursorPosition {
    readonly start: number;
    readonly end: number;
}

export function mapSelectionThroughSourceMap(
    selection: CursorPosition | null | undefined,
    sourceMap: SourceMap,
    sourceLength: number,
    outputLength: number
): CursorPosition | null {
    if (
        selection === null ||
        selection === undefined ||
        !Number.isSafeInteger(selection.start) ||
        !Number.isSafeInteger(selection.end) ||
        selection.start < 0 ||
        selection.end < selection.start ||
        selection.end > sourceLength
    ) {
        return null;
    }
    const start = mapSourceOffset(
        sourceMap,
        selection.start,
        sourceLength,
        outputLength,
        "left" satisfies SourceMapAffinity
    );
    const end = mapSourceOffset(
        sourceMap,
        selection.end,
        sourceLength,
        outputLength,
        "right" satisfies SourceMapAffinity
    );
    if (start === null || end === null || end < start) {
        return null;
    }
    return Object.freeze({ start, end });
}
