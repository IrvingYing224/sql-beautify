export interface SourceSpan {
    // End-exclusive JavaScript UTF-16 code-unit offsets.
    readonly start: number;
    readonly end: number;
}
