export interface PreviewTextEdit {
    readonly start: number;
    readonly end: number;
    readonly text: string;
}

export interface TextEditPreview {
    readonly sourceLength: number;
    readonly output: string;
    readonly edits: readonly PreviewTextEdit[];
}

export function previewTextEdits(
    source: string,
    values: readonly PreviewTextEdit[]
): TextEditPreview | null {
    try {
        if (typeof source !== "string" || !Array.isArray(values)) {
            return null;
        }
        const edits = Array.from(values).sort((left, right) =>
            left.start - right.start || left.end - right.end
        );
        let sourceCursor = 0;
        const chunks: string[] = [];
        for (const edit of edits) {
            if (
                typeof edit !== "object" ||
                edit === null ||
                typeof edit.text !== "string" ||
                !Number.isSafeInteger(edit.start) ||
                !Number.isSafeInteger(edit.end) ||
                edit.start < sourceCursor ||
                edit.end < edit.start ||
                edit.end > source.length
            ) {
                return null;
            }
            chunks.push(source.slice(sourceCursor, edit.start), edit.text);
            sourceCursor = edit.end;
        }
        chunks.push(source.slice(sourceCursor));
        return Object.freeze({
            sourceLength: source.length,
            output: chunks.join(""),
            edits: Object.freeze(edits.map((edit) => Object.freeze({
                start: edit.start,
                end: edit.end,
                text: edit.text,
            }))),
        });
    } catch {
        return null;
    }
}

/**
 * Deterministic non-semantic mapping for hosts without a source map. Offsets
 * inside an edit retain their relative distance, clamped to the replacement;
 * exact end boundaries map to the replacement end.
 */
export function mapOffsetThroughEdits(
    preview: TextEditPreview,
    offset: number
): number | null {
    if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        offset > preview.sourceLength
    ) {
        return null;
    }
    let delta = 0;
    for (const edit of preview.edits) {
        const outputStart = edit.start + delta;
        if (offset < edit.start) {
            return offset + delta;
        }
        if (edit.start === edit.end && offset === edit.start) {
            return outputStart + edit.text.length;
        }
        if (offset === edit.start) {
            return outputStart;
        }
        if (offset < edit.end) {
            return outputStart + Math.min(offset - edit.start, edit.text.length);
        }
        if (offset === edit.end) {
            return outputStart + edit.text.length;
        }
        delta += edit.text.length - (edit.end - edit.start);
    }
    return offset + delta;
}

/**
 * Maps a collection of offsets in one ordered pass over the edits. The input
 * order is preserved, including backward selection endpoints.
 */
export function mapOffsetsThroughEdits(
    preview: TextEditPreview,
    offsets: readonly number[]
): readonly number[] | null {
    try {
        const ordered = offsets.map((offset, index) => ({ offset, index }));
        if (ordered.some(({ offset }) =>
            !Number.isSafeInteger(offset) ||
            offset < 0 ||
            offset > preview.sourceLength
        )) {
            return null;
        }
        ordered.sort((left, right) => left.offset - right.offset || left.index - right.index);
        const mapped = new Array<number>(offsets.length);
        let editIndex = 0;
        let delta = 0;
        for (const item of ordered) {
            while (
                editIndex < preview.edits.length &&
                item.offset > preview.edits[editIndex]!.end
            ) {
                const edit = preview.edits[editIndex]!;
                delta += edit.text.length - (edit.end - edit.start);
                editIndex += 1;
            }
            const edit = preview.edits[editIndex];
            if (edit === undefined || item.offset < edit.start) {
                mapped[item.index] = item.offset + delta;
                continue;
            }
            const outputStart = edit.start + delta;
            if (edit.start === edit.end) {
                mapped[item.index] = outputStart + edit.text.length;
            } else if (item.offset === edit.start) {
                mapped[item.index] = outputStart;
            } else if (item.offset === edit.end) {
                mapped[item.index] = outputStart + edit.text.length;
            } else {
                mapped[item.index] = outputStart + Math.min(
                    item.offset - edit.start,
                    edit.text.length
                );
            }
        }
        return Object.freeze(mapped);
    } catch {
        return null;
    }
}
