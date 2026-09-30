import { DEFAULT_FORMAT_OPTIONS } from "../../core/config/definitions";
import type { RenderTabSize } from "../../core/renderer/environment";
import { displayWidth } from "../../core/renderer/display-width";

export const DEFAULT_DDL_MAX_ALIGN_WIDTH = DEFAULT_FORMAT_OPTIONS.maxAlignWidth;
export const MAX_EXTRACT_TYPE_CODE_UNITS = 128;

interface AlignmentMeasure {
    readonly prefix: string;
    readonly name: string;
}

function checkedLinear(
    multiplier: number,
    value: number,
    extra: number
): number | null {
    const result = multiplier * value + extra;
    return Number.isSafeInteger(result) && result >= 0 ? result : null;
}

function paddingBudget(sourceLength: number, rowCount: number): number | null {
    const fromSource = checkedLinear(2, sourceLength, 4096);
    const fromRows = checkedLinear(32, rowCount, 0);
    if (fromSource === null || fromRows === null) {
        return null;
    }
    const result = fromSource + fromRows;
    return Number.isSafeInteger(result) ? result : null;
}

export function alignmentPaddings(
    rows: readonly AlignmentMeasure[],
    sourceLength: number,
    maxAlignWidth: number,
    tabSize: RenderTabSize,
    startColumn = 0
): readonly number[] {
    const fallback = Object.freeze(rows.map(() => 1));
    const widths: number[] = [];
    let targetColumn = 0;
    for (const row of rows) {
        const width = displayWidth(
            `${row.prefix}${row.name}`,
            startColumn,
            tabSize
        );
        if (width === null) {
            return fallback;
        }
        widths.push(width);
        targetColumn = Math.max(targetColumn, startColumn + width + 1);
    }
    if (targetColumn > maxAlignWidth) {
        return fallback;
    }
    let generated = 0;
    const paddings = widths.map((width) => {
        const padding = Math.max(1, targetColumn - startColumn - width);
        generated += padding;
        return padding;
    });
    const budget = paddingBudget(sourceLength, rows.length);
    return budget === null || generated > budget
        ? fallback
        : Object.freeze(paddings);
}

export function ddlOutputWithinBudget(
    sourceLength: number,
    rowCount: number,
    outputLength: number
): boolean {
    const fromSource = checkedLinear(4, sourceLength, 4096);
    const fromRows = checkedLinear(160, rowCount, 0);
    if (fromSource === null || fromRows === null) {
        return false;
    }
    const maximum = fromSource + fromRows;
    return Number.isSafeInteger(maximum) && outputLength <= maximum;
}
