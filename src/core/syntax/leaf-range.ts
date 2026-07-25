/**
 * End-exclusive range over ParseOutput.leaves array indexes.
 * References leaf indexes, not source offsets.
 */
export interface LeafRange {
    readonly start: number;
    readonly end: number;
}
