import {
    isCanonicalAnalyzedArtifact,
} from "../analysis/artifact";
import type { AnalyzedArtifact, CommentBinding } from "../analysis/types";
import { isKeywordCaseRole } from "../syntax/contextual-fact-contract";
import type {
    AlignDoc,
    AutoGroupDoc,
    ConcatDoc,
    ForcedGroupDoc,
    HardLineDoc,
    IndentDoc,
    LayoutDoc,
    LeafDoc,
    LeafTransform,
    LineSuffixDoc,
    LineSuffixSpacing,
    PadToColumnDoc,
    PositiveColumns,
    PositiveLevels,
    SoftLineDoc,
    SpaceDoc,
    VerbatimDoc,
    VerbatimTrigger,
} from "./doc";
import {
    createLayoutResourceBudget,
} from "./resource-budget";
import type { LayoutResourceBudget } from "./resource-budget";
import {
    dominatingVerbatimClaims,
    verbatimTriggersEqual,
} from "./verbatim-claims";
import type { DominatingVerbatimClaim } from "./verbatim-claims";

export type LineSuffixSpacingInput =
    | {
          readonly kind: "space";
          readonly columns: number;
      }
    | {
          readonly kind: "pad-to-column";
          readonly targetColumn: number;
      }
    | null;

export interface LayoutDocFactory {
    readonly analysis: AnalyzedArtifact;
    readonly budget: LayoutResourceBudget;
    readonly verbatimClaims: readonly DominatingVerbatimClaim[];
    empty(): ConcatDoc | null;
    leaf(leafId: number, transform?: LeafTransform): LeafDoc | null;
    verbatim(
        ownerNodeId: number,
        trigger: VerbatimTrigger
    ): VerbatimDoc | null;
    space(columns: number): LayoutDoc | null;
    hardLine(): HardLineDoc | null;
    softLine(flat: "empty" | "space"): SoftLineDoc | null;
    concat(parts: readonly LayoutDoc[]): LayoutDoc | null;
    indent(levels: number, content: LayoutDoc): LayoutDoc | null;
    align(columns: number, content: LayoutDoc): LayoutDoc | null;
    padToColumn(targetColumn: number): LayoutDoc | null;
    autoGroup(maxFlatWidth: number, content: LayoutDoc): AutoGroupDoc | null;
    group(
        mode: "flat" | "break",
        content: LayoutDoc
    ): ForcedGroupDoc | null;
    lineSuffix(
        commentLeafId: number,
        spacing?: LineSuffixSpacingInput
    ): LineSuffixDoc | null;
}

function isPositiveSafeInteger(value: unknown, maximum: number): value is number {
    return (
        typeof value === "number" &&
        Number.isSafeInteger(value) &&
        value > 0 &&
        value <= maximum
    );
}

function isNonNegativeSafeInteger(
    value: unknown,
    maximum: number
): value is number {
    return (
        typeof value === "number" &&
        Number.isSafeInteger(value) &&
        value >= 0 &&
        value <= maximum
    );
}

function lineSuffixSpacing(
    value: LineSuffixSpacingInput,
    maximum: number
): LineSuffixSpacing | undefined {
    if (value === null) {
        return null;
    }
    if (value.kind === "space") {
        return isPositiveSafeInteger(value.columns, maximum)
            ? Object.freeze({ kind: "space", columns: value.columns as PositiveColumns })
            : undefined;
    }
    return value.kind === "pad-to-column" &&
        isPositiveSafeInteger(value.targetColumn, maximum)
        ? Object.freeze({
              kind: "pad-to-column",
              targetColumn: value.targetColumn as PositiveColumns,
          })
        : undefined;
}

/**
 * Creates the constructor for immutable LayoutDoc nodes of one analyzed
 * artifact. Invalid input or an exhausted node budget returns null.
 */
export function createLayoutDocFactory(
    analysis: unknown
): LayoutDocFactory | null {
    if (!isCanonicalAnalyzedArtifact(analysis)) {
        return null;
    }
    let syntaxNodeCount: number;
    try {
        syntaxNodeCount = analysis.index.nodes().length;
    } catch {
        return null;
    }
    const budget = createLayoutResourceBudget(
        analysis.source.length,
        analysis.leaves.length,
        syntaxNodeCount
    );
    if (budget === null) {
        return null;
    }
    const claims = dominatingVerbatimClaims(analysis);
    if (claims === null) {
        return null;
    }

    let createdNodeCount = 0;

    const register = <T extends LayoutDoc>(node: T): T | null => {
        if (createdNodeCount >= budget.maxDocNodes) {
            return null;
        }
        createdNodeCount += 1;
        return Object.freeze(node);
    };

    const commentBindingForLeaf = (leafId: number): CommentBinding | null => {
        try {
            const binding = analysis.index.commentBinding(leafId);
            return binding?.commentLeafId === leafId ? binding : null;
        } catch {
            return null;
        }
    };

    const empty = (): ConcatDoc | null =>
        register({
            kind: "concat",
            parts: Object.freeze([]) as readonly LayoutDoc[],
        });

    const zeroOrPositiveColumns = (
        value: number,
        zero: () => LayoutDoc | null,
        positive: (columns: PositiveColumns) => LayoutDoc | null
    ): LayoutDoc | null => {
        if (!isNonNegativeSafeInteger(value, budget.maxGeneratedColumnsPerLine)) {
            return null;
        }
        return value === 0 ? zero() : positive(value as PositiveColumns);
    };

    const factory: LayoutDocFactory = {
        analysis,
        budget,
        verbatimClaims: claims.claims,

        empty,

        leaf(leafId, transform = "raw"): LeafDoc | null {
            if (
                !Number.isSafeInteger(leafId) ||
                leafId < 0 ||
                leafId >= analysis.leaves.length ||
                (transform !== "raw" && transform !== "keyword-case")
            ) {
                return null;
            }
            if (claims.claimForLeaf(leafId) !== null) {
                return null;
            }
            const leaf = analysis.leaves[leafId]!;
            if (leaf.kind === "line-comment" || leaf.kind === "block-comment") {
                const binding = commentBindingForLeaf(leafId);
                if (binding === null || binding.placement === "trailing") {
                    return null;
                }
            }
            if (transform === "keyword-case") {
                const syntax = analysis.index.leafContext(leafId).syntax;
                if (
                    leaf.channel !== "code" ||
                    syntax === null ||
                    syntax.keywordCaseEligible !== true ||
                    !isKeywordCaseRole(syntax.syntaxRole)
                ) {
                    return null;
                }
            }
            return register({ kind: "leaf", leafId, transform });
        },

        verbatim(ownerNodeId, trigger): VerbatimDoc | null {
            const claim = claims.claimForOwner(ownerNodeId);
            if (claim === null || !verbatimTriggersEqual(claim.trigger, trigger)) {
                return null;
            }
            return register({
                kind: "verbatim",
                ownerNodeId,
                trigger: claim.trigger,
                leafRange: claim.leafRange,
            });
        },

        space(columns): LayoutDoc | null {
            return zeroOrPositiveColumns(
                columns,
                empty,
                (positive) => register({ kind: "space", columns: positive } as SpaceDoc)
            );
        },

        hardLine(): HardLineDoc | null {
            return register({ kind: "line", mode: "hard" });
        },

        softLine(flat): SoftLineDoc | null {
            if (flat !== "empty" && flat !== "space") {
                return null;
            }
            return register({ kind: "line", mode: "soft", flat });
        },

        concat(rawParts): LayoutDoc | null {
            if (rawParts.length > budget.maxDocNodes) {
                return null;
            }
            const parts = Object.freeze(rawParts.slice());
            if (parts.length === 0) {
                return empty();
            }
            if (parts.length === 1) {
                return parts[0]!;
            }
            return register({ kind: "concat", parts });
        },

        indent(levels, content): LayoutDoc | null {
            if (
                !isNonNegativeSafeInteger(
                    levels,
                    budget.maxCumulativeIndentLevels
                )
            ) {
                return null;
            }
            if (levels === 0) {
                return content;
            }
            return register({
                kind: "indent",
                levels: levels as PositiveLevels,
                content,
            } as IndentDoc);
        },

        align(columns, content): LayoutDoc | null {
            return zeroOrPositiveColumns(
                columns,
                () => content,
                (positive) =>
                    register({
                        kind: "align",
                        columns: positive,
                        content,
                    } as AlignDoc)
            );
        },

        padToColumn(targetColumn): LayoutDoc | null {
            return zeroOrPositiveColumns(
                targetColumn,
                empty,
                (positive) =>
                    register({
                        kind: "pad-to-column",
                        targetColumn: positive,
                    } as PadToColumnDoc)
            );
        },

        autoGroup(maxFlatWidth, content): AutoGroupDoc | null {
            if (
                !isPositiveSafeInteger(
                    maxFlatWidth,
                    budget.maxGeneratedColumnsPerLine
                )
            ) {
                return null;
            }
            return register({
                kind: "group",
                mode: "auto",
                maxFlatWidth: maxFlatWidth as PositiveColumns,
                content,
            });
        },

        group(mode, content): ForcedGroupDoc | null {
            if (mode !== "flat" && mode !== "break") {
                return null;
            }
            return register({ kind: "group", mode, content });
        },

        lineSuffix(commentLeafId, spacing = null): LineSuffixDoc | null {
            if (
                !Number.isSafeInteger(commentLeafId) ||
                commentLeafId < 0 ||
                commentLeafId >= analysis.leaves.length
            ) {
                return null;
            }
            if (claims.claimForLeaf(commentLeafId) !== null) {
                return null;
            }
            const leaf = analysis.leaves[commentLeafId]!;
            const binding = commentBindingForLeaf(commentLeafId);
            if (
                (leaf.kind !== "line-comment" && leaf.kind !== "block-comment") ||
                binding === null ||
                binding.placement !== "trailing"
            ) {
                return null;
            }
            const canonicalSpacing = lineSuffixSpacing(
                spacing,
                budget.maxGeneratedColumnsPerLine
            );
            if (canonicalSpacing === undefined) {
                return null;
            }
            return register({
                kind: "line-suffix",
                commentLeafId,
                spacing: canonicalSpacing,
            });
        },
    };
    return Object.freeze(factory);
}
