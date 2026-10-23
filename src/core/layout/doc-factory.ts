import { isProxy } from "node:util/types";

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

function copyTrigger(value: VerbatimTrigger): VerbatimTrigger | null {
    try {
        if (isProxy(value)) {
            return null;
        }
        const kindDescriptor = Object.getOwnPropertyDescriptor(value, "kind");
        if (kindDescriptor === undefined || !("value" in kindDescriptor)) {
            return null;
        }
        const kind = kindDescriptor.value;
        const keys = Reflect.ownKeys(value);
        const expected =
            kind === "operator-capability"
                ? ["kind", "capabilityId", "operatorId"]
                : ["kind", "capabilityId"];
        if (
            keys.length !== expected.length ||
            expected.some((key) => !keys.includes(key))
        ) {
            return null;
        }
        for (const key of expected) {
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            if (
                descriptor === undefined ||
                !("value" in descriptor) ||
                descriptor.enumerable !== true
            ) {
                return null;
            }
        }
        const capabilityDescriptor = Object.getOwnPropertyDescriptor(
            value,
            "capabilityId"
        );
        if (
            capabilityDescriptor === undefined ||
            !("value" in capabilityDescriptor)
        ) {
            return null;
        }
        const capabilityId = capabilityDescriptor.value;
        if (kind === "opaque") {
            if (
                capabilityId !== null &&
                (typeof capabilityId !== "string" || capabilityId.length === 0)
            ) {
                return null;
            }
            return Object.freeze({
                kind: "opaque",
                capabilityId,
            });
        }
        if (kind === "node-capability") {
            if (
                typeof capabilityId !== "string" ||
                capabilityId.length === 0
            ) {
                return null;
            }
            return Object.freeze({
                kind: "node-capability",
                capabilityId,
            });
        }
        if (kind === "bounded-payload") {
            if (capabilityId !== "set-command") {
                return null;
            }
            return Object.freeze({
                kind: "bounded-payload",
                capabilityId,
            });
        }
        const operatorDescriptor = Object.getOwnPropertyDescriptor(
            value,
            "operatorId"
        );
        if (
            kind !== "operator-capability" ||
            typeof capabilityId !== "string" ||
            capabilityId.length === 0 ||
            operatorDescriptor === undefined ||
            !("value" in operatorDescriptor) ||
            typeof operatorDescriptor.value !== "string" ||
            operatorDescriptor.value.length === 0
        ) {
            return null;
        }
        return Object.freeze({
            kind: "operator-capability",
            capabilityId,
            operatorId: operatorDescriptor.value,
        });
    } catch {
        return null;
    }
}

function copyLineSuffixSpacing(
    value: LineSuffixSpacingInput,
    maximum: number
): LineSuffixSpacing | undefined {
    if (value === null) {
        return null;
    }
    try {
        if (isProxy(value)) {
            return undefined;
        }
        const keys = Reflect.ownKeys(value);
        const kindDescriptor = Object.getOwnPropertyDescriptor(value, "kind");
        if (kindDescriptor === undefined || !("value" in kindDescriptor)) {
            return undefined;
        }
        const kind = kindDescriptor.value;
        const valueKey = kind === "space" ? "columns" : "targetColumn";
        if (
            keys.length !== 2 ||
            !keys.includes("kind") ||
            !keys.includes(valueKey)
        ) {
            return undefined;
        }
        const valueDescriptor = Object.getOwnPropertyDescriptor(value, valueKey);
        if (
            valueDescriptor === undefined ||
            !("value" in valueDescriptor) ||
            !isPositiveSafeInteger(valueDescriptor.value, maximum)
        ) {
            return undefined;
        }
        if (kind === "space") {
            return Object.freeze({
                kind: "space",
                columns: valueDescriptor.value as PositiveColumns,
            });
        }
        if (kind !== "pad-to-column") {
            return undefined;
        }
        return Object.freeze({
            kind: "pad-to-column",
            targetColumn: valueDescriptor.value as PositiveColumns,
        });
    } catch {
        return undefined;
    }
}

function snapshotDenseDocs(
    value: readonly LayoutDoc[],
    maximumLength: number
): readonly LayoutDoc[] | null {
    try {
        if (isProxy(value) || !Array.isArray(value)) {
            return null;
        }
        const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
        if (
            lengthDescriptor === undefined ||
            !("value" in lengthDescriptor) ||
            !Number.isSafeInteger(lengthDescriptor.value) ||
            lengthDescriptor.value < 0
        ) {
            return null;
        }
        const length = lengthDescriptor.value as number;
        if (length > maximumLength) {
            return null;
        }
        const copy: LayoutDoc[] = new Array(length);
        for (let index = 0; index < length; index++) {
            const descriptor = Object.getOwnPropertyDescriptor(value, index);
            if (descriptor === undefined || !("value" in descriptor)) {
                return null;
            }
            copy[index] = descriptor.value as LayoutDoc;
        }
        if (Reflect.ownKeys(value).some((key) => {
            if (key === "length") {
                return false;
            }
            if (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(key)) {
                return true;
            }
            const numeric = Number(key);
            return !Number.isSafeInteger(numeric) || numeric >= length;
        })) {
            return null;
        }
        return Object.freeze(copy);
    } catch {
        return null;
    }
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

        verbatim(ownerNodeId, rawTrigger): VerbatimDoc | null {
            const claim = claims.claimForOwner(ownerNodeId);
            const trigger = copyTrigger(rawTrigger);
            if (
                claim === null ||
                trigger === null ||
                !verbatimTriggersEqual(claim.trigger, trigger)
            ) {
                return null;
            }
            return register({
                kind: "verbatim",
                ownerNodeId,
                trigger,
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
            const parts = snapshotDenseDocs(rawParts, budget.maxDocNodes);
            if (parts === null) {
                return null;
            }
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
            const canonicalSpacing = copyLineSuffixSpacing(
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
