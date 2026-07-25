import {
    mapSourceOffset,
    type SourceMapAffinity,
} from "../../core/source/source-map";
import type { SourceMap } from "../../core/source/source-map";

export interface CursorPosition {
    readonly anchor: number;
    readonly active: number;
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
        !Number.isSafeInteger(selection.anchor) ||
        !Number.isSafeInteger(selection.active) ||
        selection.anchor < 0 ||
        selection.active < 0 ||
        selection.anchor > sourceLength ||
        selection.active > sourceLength
    ) {
        return null;
    }
    if (selection.anchor === selection.active) {
        const exact = mapSourceOffset(sourceMap, selection.anchor, sourceLength, outputLength, "exact");
        const mapped = exact ?? mapSourceOffset(sourceMap, selection.anchor, sourceLength, outputLength, "left");
        if (mapped === null) {
            return null;
        }
        return Object.freeze({ anchor: mapped, active: mapped });
    }
    const forward = selection.anchor < selection.active;
    const sourceStart = Math.min(selection.anchor, selection.active);
    const sourceEnd = Math.max(selection.anchor, selection.active);
    const mappedStart = mapSourceOffset(
        sourceMap,
        sourceStart,
        sourceLength,
        outputLength,
        "left" satisfies SourceMapAffinity
    );
    const mappedEnd = mapSourceOffset(
        sourceMap,
        sourceEnd,
        sourceLength,
        outputLength,
        "right" satisfies SourceMapAffinity
    );
    if (mappedStart === null || mappedEnd === null || mappedEnd < mappedStart) {
        return null;
    }
    return Object.freeze(forward
        ? { anchor: mappedStart, active: mappedEnd }
        : { anchor: mappedEnd, active: mappedStart });
}
