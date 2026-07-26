export interface TextLineIndex {
    readonly sourceLength: number;
    readonly lineStarts: readonly number[];
    readonly lineEnds: readonly number[];
}

export interface TextLinePosition {
    readonly line: number;
    readonly character: number;
}

export interface TextLineBounds {
    readonly start: number;
    readonly end: number;
}

export function buildTextLineIndex(source: string): TextLineIndex {
    const starts: number[] = [0];
    const ends: number[] = [];
    let index = 0;
    while (index < source.length) {
        const code = source.charCodeAt(index);
        if (code === 0x0D) {
            ends.push(index);
            index += source.charCodeAt(index + 1) === 0x0A ? 2 : 1;
            starts.push(index);
            continue;
        }
        if (code === 0x0A) {
            ends.push(index);
            index += 1;
            starts.push(index);
            continue;
        }
        index += 1;
    }
    ends.push(source.length);
    return Object.freeze({
        sourceLength: source.length,
        lineStarts: Object.freeze(starts),
        lineEnds: Object.freeze(ends),
    });
}

function lineAtOffset(index: TextLineIndex, offset: number): number | null {
    if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        offset > index.sourceLength
    ) {
        return null;
    }
    let low = 0;
    let high = index.lineStarts.length;
    while (low < high) {
        const middle = low + Math.floor((high - low) / 2);
        if (index.lineStarts[middle]! <= offset) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    const line = low - 1;
    if (line < 0) {
        return null;
    }
    const end = index.lineEnds[line]!;
    const nextStart = index.lineStarts[line + 1];
    if (
        nextStart !== undefined &&
        nextStart - end === 2 &&
        offset === end + 1
    ) {
        return null;
    }
    return line;
}

export function positionAtOffset(
    index: TextLineIndex,
    offset: number
): TextLinePosition | null {
    const line = lineAtOffset(index, offset);
    return line === null
        ? null
        : Object.freeze({
              line,
              character: offset - index.lineStarts[line]!,
          });
}

export function lineBoundsAtOffset(
    index: TextLineIndex,
    offset: number
): TextLineBounds | null {
    const line = lineAtOffset(index, offset);
    return line === null
        ? null
        : Object.freeze({
              start: index.lineStarts[line]!,
              end: index.lineEnds[line]!,
          });
}
