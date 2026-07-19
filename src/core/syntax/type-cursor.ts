import type { SourceLeaf } from "../lexer/token";
import type { LeafRange } from "./leaf-range";
import type { StructuralTokenTable } from "./token-table";

function isCodeLeaf(leaf: SourceLeaf | undefined): boolean {
    return leaf?.channel === "code";
}

function angleDelta(raw: string): number {
    let delta = 0;
    for (const character of raw) {
        if (character === "<") {
            delta += 1;
        } else if (character === ">") {
            delta -= 1;
        }
    }
    return delta;
}

/**
 * Splits a bounded Hive type/column body using canonical delimiter depth and
 * one local angle-depth cursor. DDL consumers must use this helper instead of
 * implementing a second generic-type scanner.
 */
export function splitTopLevelTypeItems(
    leaves: readonly SourceLeaf[],
    table: StructuralTokenTable,
    range: LeafRange
): readonly LeafRange[] {
    let baseDepth: number | null = null;
    for (let index = range.start; index < range.end; index++) {
        if (isCodeLeaf(leaves[index])) {
            baseDepth = table.depthBefore(index);
            break;
        }
    }
    if (baseDepth === null) {
        return Object.freeze([Object.freeze({ start: range.start, end: range.end })]);
    }
    const ranges: LeafRange[] = [];
    let angleDepth = 0;
    let itemStart = range.start;
    for (let index = range.start; index < range.end; index++) {
        const leaf = leaves[index]!;
        if (isCodeLeaf(leaf)) {
            if (
                leaf.raw === "," &&
                table.depthBefore(index) === baseDepth &&
                angleDepth === 0
            ) {
                ranges.push(Object.freeze({ start: itemStart, end: index }));
                itemStart = index + 1;
                continue;
            }
            angleDepth += angleDelta(leaf.raw);
        }
    }
    ranges.push(Object.freeze({ start: itemStart, end: range.end }));
    return Object.freeze(ranges);
}
