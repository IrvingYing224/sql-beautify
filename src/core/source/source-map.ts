import type { SourceSpan } from "./source-span";

/** One length-preserving source-derived output run. Generated layout is unmapped. */
export interface SourceMapEntry {
    readonly source: SourceSpan;
    readonly output: SourceSpan;
}

export interface SourceMap {
    readonly entries: readonly SourceMapEntry[];
}
