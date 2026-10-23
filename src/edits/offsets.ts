import type { SourceMap } from "../core/source/source-map";
import { createSourceOffsetMapper } from "../core/source/source-map";

export interface OffsetEdit {
    readonly start: number;
    readonly end: number;
    readonly text: string;
}

/** The text after applying edits sorted by start. */
export function applyEdits(source: string, edits: readonly OffsetEdit[]): string {
    let output = "";
    let cursor = 0;
    for (const edit of edits) {
        output += source.slice(cursor, edit.start) + edit.text;
        cursor = edit.end;
    }
    return output + source.slice(cursor);
}

/**
 * Maps a document offset through edits sorted by start, for edits without a source map. An offset
 * inside an edit keeps its distance from the edit start, clamped to the replacement; the edit end
 * maps to the replacement end.
 */
export function mapThroughEdits(edits: readonly OffsetEdit[], offset: number): number {
    let delta = 0;
    for (const edit of edits) {
        const outputStart = edit.start + delta;
        if (offset < edit.start) {
            return offset + delta;
        }
        if (offset === edit.start && edit.start !== edit.end) {
            return outputStart;
        }
        if (offset <= edit.end) {
            return offset === edit.end
                ? outputStart + edit.text.length
                : outputStart + Math.min(offset - edit.start, edit.text.length);
        }
        delta += edit.text.length - (edit.end - edit.start);
    }
    return offset + delta;
}

/**
 * Maps a selection through a source map: a cursor to the same token when it is in one, otherwise
 * leftwards; a range widens over generated whitespace at both ends. The direction is kept.
 */
export function mapSelection(
    selection: { readonly anchor: number; readonly active: number },
    sourceMap: SourceMap,
    sourceLength: number,
    outputLength: number
): { readonly anchor: number; readonly active: number } {
    const mapper = createSourceOffsetMapper(sourceMap, sourceLength, outputLength);
    const map = (offset: number, affinity: "exact" | "left" | "right"): number | null =>
        mapper === null ? null : mapper.map(offset, affinity);
    if (selection.anchor === selection.active) {
        const offset = map(selection.anchor, "exact") ?? map(selection.anchor, "left");
        if (offset === null) {
            throw new Error("selection could not be mapped through the source map");
        }
        return { anchor: offset, active: offset };
    }
    const start = map(Math.min(selection.anchor, selection.active), "left");
    const end = map(Math.max(selection.anchor, selection.active), "right");
    if (start === null || end === null || end < start) {
        throw new Error("selection could not be mapped through the source map");
    }
    return selection.anchor < selection.active
        ? { anchor: start, active: end }
        : { anchor: end, active: start };
}
