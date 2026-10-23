import type { Dialect } from "../config/options";
import { lexSql } from "../lexer/lossless-lexer";
import { isTemplateFragment, type SourceLeaf, type TokenKind } from "../lexer/token";

/** A non-whitespace source leaf, its rendered counterpart, and whether whitespace precedes each. */
export interface LeafPair {
    readonly source: SourceLeaf;
    readonly output: SourceLeaf;
    readonly sourceGap: boolean;
    readonly outputGap: boolean;
}

/**
 * The text an operation may emit for a source leaf: its raw text, or the re-cased keyword when the
 * operation plans to change its case; null when it plans a change the leaf does not allow.
 */
export type ExpectedLeafText = (leaf: SourceLeaf) => string | null;

const WORD_KINDS: ReadonlySet<TokenKind> = new Set([
    "keyword",
    "identifier",
    "number",
    "parameter",
]);

function isWhitespace(leaf: SourceLeaf): boolean {
    return leaf.kind === "whitespace" || leaf.kind === "newline";
}

/**
 * Safety floor 2 (plan §4) glue rules on token-equivalent pairs: adjacent word-like leaves keep
 * whether whitespace separates them, and a template fragment loses none of the whitespace around
 * it. The lexer makes each fragment one protected leaf, so token equivalence already keeps its
 * inside free of new whitespace and case changes.
 */
export function glueKept(pairs: readonly LeafPair[]): boolean {
    for (let index = 0; index < pairs.length; index += 1) {
        const pair = pairs[index]!;
        const previous = pairs[index - 1];
        if (
            previous !== undefined &&
            pair.sourceGap !== pair.outputGap &&
            ((WORD_KINDS.has(previous.source.kind) && WORD_KINDS.has(pair.source.kind)) ||
                (pair.sourceGap &&
                    (isTemplateFragment(previous.source) || isTemplateFragment(pair.source))))
        ) {
            return false;
        }
    }
    return true;
}

/**
 * Safety floor 2 for formatSql and formatHiveDdl: compares the re-lexed output with the source
 * leaves one by one. Returns "token" when a token changed, "glue" when only the glue rules broke,
 * null when both hold.
 */
export function floorViolation(
    sourceLeaves: readonly SourceLeaf[],
    output: string,
    dialect: Dialect,
    expected: ExpectedLeafText
): "token" | "glue" | null {
    const lexed = lexSql(output, { dialect });
    if (lexed.diagnostics.some((value) => value.severity === "error")) {
        return "token";
    }
    const pairs: LeafPair[] = [];
    let sourceIndex = 0;
    let outputIndex = 0;
    let glued = false;
    // Removing whitespace beside a template fragment lets the fragment absorb its neighbours when
    // the output is lexed again: a glue violation (plan §4 floor 2), not a changed token. The check
    // then skips the absorbed source leaves and goes on, so a later changed token is still reported.
    const absorb = (outputLeaf: SourceLeaf): boolean => {
        if (!isTemplateFragment(outputLeaf)) {
            return false;
        }
        let text = "";
        let index = sourceIndex - 1;
        for (; index < sourceLeaves.length && text.length < outputLeaf.raw.length; index += 1) {
            const leaf = sourceLeaves[index]!;
            if (!isWhitespace(leaf)) {
                text += expected(leaf) ?? leaf.raw;
            }
        }
        if (text !== outputLeaf.raw) {
            return false;
        }
        glued = true;
        sourceIndex = index;
        return true;
    };
    while (true) {
        let sourceLeaf: SourceLeaf | null = null;
        let sourceGap = pairs.length === 0;
        while (sourceIndex < sourceLeaves.length) {
            const candidate = sourceLeaves[sourceIndex++]!;
            if (!isWhitespace(candidate)) {
                sourceLeaf = candidate;
                break;
            }
            sourceGap = true;
        }
        let outputLeaf: SourceLeaf | null = null;
        let outputGap = pairs.length === 0;
        while (outputIndex < lexed.leaves.length) {
            const candidate = lexed.leaves[outputIndex++]!;
            if (!isWhitespace(candidate)) {
                outputLeaf = candidate;
                break;
            }
            outputGap = true;
        }
        if (sourceLeaf === null || outputLeaf === null) {
            if (sourceLeaf !== null || outputLeaf !== null) {
                return "token";
            }
            return glued || !glueKept(pairs) ? "glue" : null;
        }
        const value = sourceLeaf.kind === outputLeaf.kind && sourceLeaf.channel === outputLeaf.channel
            ? expected(sourceLeaf)
            : null;
        if (value === null || outputLeaf.raw !== value) {
            if (!absorb(outputLeaf)) {
                return "token";
            }
            continue;
        }
        pairs.push({ source: sourceLeaf, output: outputLeaf, sourceGap, outputGap });
    }
}
