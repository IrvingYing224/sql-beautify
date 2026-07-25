import type { SourceLeaf } from "../lexer/token";
import type { StructuralTokenTable } from "./token-table";

/**
 * Lightweight cursor over a structural token table.
 * Parser-facing navigation uses syntax leaves (code | protected).
 * Does not copy leaf arrays.
 */
export interface TokenCursor {
    leafIndex(): number;
    isAtEnd(): boolean;
    current(): SourceLeaf | null;
    /** Advance by one leaf (any channel). Returns false when already at end. */
    advance(): boolean;
    /**
     * Advance to the next syntax leaf (code | protected).
     * If currently on a syntax leaf, steps to the next syntax leaf after it.
     * Returns false if none remain.
     */
    advanceSyntax(): boolean;
    /** Move to an absolute leaf index. Rejects out-of-range / non-integer. */
    seek(leafIndex: number): void;
    /** Move to a syntax ordinal. */
    seekSyntaxOrdinal(ordinal: number): void;
    /** Peek current or next syntax leaf without moving past non-syntax. */
    peekSyntax(): SourceLeaf | null;
    syntaxOrdinal(): number | null;
}

function assertCursorIndex(index: number, leafCount: number, label: string): void {
    if (!Number.isInteger(index) || index < 0 || index > leafCount) {
        throw new Error(
            `Cursor ${label} out of range: ${index} (leafCount=${leafCount})`
        );
    }
}

export function createTokenCursor(
    table: StructuralTokenTable,
    startLeafIndex: number = 0
): TokenCursor {
    const leafCount = table.leafCount();
    assertCursorIndex(startLeafIndex, leafCount, "start index");
    let index = startLeafIndex;

    const cursor: TokenCursor = Object.freeze({
        leafIndex(): number {
            return index;
        },
        isAtEnd(): boolean {
            return index >= leafCount;
        },
        current(): SourceLeaf | null {
            if (index < 0 || index >= leafCount) {
                return null;
            }
            return table.getLeaf(index);
        },
        advance(): boolean {
            if (index >= leafCount) {
                return false;
            }
            index += 1;
            return index < leafCount;
        },
        advanceSyntax(): boolean {
            if (index >= leafCount) {
                return false;
            }
            const leaf = table.getLeaf(index);
            if (leaf.channel === "code" || leaf.channel === "protected") {
                const next = table.nextSyntaxLeafIndex(index);
                if (next === null) {
                    index = leafCount;
                    return false;
                }
                index = next;
                return true;
            }
            while (index < leafCount) {
                const current = table.getLeaf(index);
                if (current.channel === "code" || current.channel === "protected") {
                    return true;
                }
                index += 1;
            }
            return false;
        },
        seek(leafIndex: number): void {
            assertCursorIndex(leafIndex, leafCount, "seek");
            index = leafIndex;
        },
        seekSyntaxOrdinal(ordinal: number): void {
            index = table.leafIndexOfSyntaxOrdinal(ordinal);
        },
        peekSyntax(): SourceLeaf | null {
            if (index >= leafCount) {
                return null;
            }
            const leaf = table.getLeaf(index);
            if (leaf.channel === "code" || leaf.channel === "protected") {
                return leaf;
            }
            let i = index;
            while (i < leafCount) {
                const l = table.getLeaf(i);
                if (l.channel === "code" || l.channel === "protected") {
                    return l;
                }
                i += 1;
            }
            return null;
        },
        syntaxOrdinal(): number | null {
            if (index >= leafCount) {
                return null;
            }
            const leaf = table.getLeaf(index);
            if (leaf.channel !== "code" && leaf.channel !== "protected") {
                return null;
            }
            return table.syntaxOrdinalOfLeaf(index);
        },
    });

    return cursor;
}
