/** Maximum supported SQL source length, measured in UTF-16 code units. */
export const MAX_FORMAT_SOURCE_CODE_UNITS = 524_288;

/** formatSql output limit of one target: 4 × input + 64 Ki UTF-16 code units (plan §4 floor 4). */
export function maxFormatOutputCodeUnits(sourceLength: number): number {
    return 4 * sourceLength + 65_536;
}
