import type { LeafRange } from "./leaf-range";
import { ParserSyntaxError } from "./parser-context";

export const PARSER_NESTING_BUDGET = 256;

// Root parsing starts at 0; 255 is the last valid recursive grammar level.
export function assertParserDepth(range: LeafRange, depth: number): void {
    if (
        !Number.isSafeInteger(depth) ||
        depth < 0 ||
        depth >= PARSER_NESTING_BUDGET
    ) {
        throw new ParserSyntaxError(
            "SYN_MAX_DEPTH_EXCEEDED",
            range,
            `Parser nesting budget ${PARSER_NESTING_BUDGET} exceeded`
        );
    }
}

export function descendParserDepth(range: LeafRange, depth: number): number {
    assertParserDepth(range, depth);
    const nestedDepth = depth + 1;
    assertParserDepth(range, nestedDepth);
    return nestedDepth;
}
