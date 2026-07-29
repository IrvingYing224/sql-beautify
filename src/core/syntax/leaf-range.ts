import type { SourceLeaf } from "../lexer/token";
import type { SourceSpan } from "../source/source-span";

/**
 * End-exclusive range over ParseOutput.leaves array indexes.
 * References leaf indexes, not source offsets.
 */
export interface LeafRange {
    readonly start: number;
    readonly end: number;
}

/**
 * Canonical source span for a leaf range, including the shared empty-range
 * boundary rules. Returns null for an invalid or out-of-bounds range.
 */
export function sourceSpanForLeafRange(
    leaves: readonly SourceLeaf[],
    sourceLength: number,
    range: LeafRange
): SourceSpan | null {
    if (
        !Number.isInteger(range.start) ||
        !Number.isInteger(range.end) ||
        range.start < 0 ||
        range.end < range.start ||
        range.end > leaves.length
    ) {
        return null;
    }
    if (range.start === range.end) {
        const offset =
            leaves.length === 0 || range.start === 0
                ? 0
                : range.start === leaves.length
                  ? sourceLength
                  : leaves[range.start]!.span.start;
        return { start: offset, end: offset };
    }
    const first = leaves[range.start]!;
    const last = leaves[range.end - 1]!;
    if (
        range.end === range.start + 1 &&
        Object.isFrozen(first.span)
    ) {
        return first.span;
    }
    return { start: first.span.start, end: last.span.end };
}
