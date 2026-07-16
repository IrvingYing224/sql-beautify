import {
    isCanonicalAnalyzedArtifact,
} from "../analysis/artifact";
import type { SourceLeaf } from "../lexer/token";
import { isKeywordCaseRole } from "../syntax/contextual-fact-contract";
import type { LayoutDoc } from "./doc";
import {
    canonicalLayoutDocProof,
    isCanonicalLayoutDocFactory,
} from "./doc-factory";
import type { LayoutDocFactory } from "./doc-factory";
import {
    createLayoutResourceBudget,
} from "./resource-budget";
import type { LayoutResourceBudget } from "./resource-budget";
import {
    dominatingVerbatimClaims,
    verbatimTriggersEqual,
} from "./verbatim-claims";
import type { DominatingVerbatimClaim } from "./verbatim-claims";

export type LayoutInvariantFailureCode =
    | "LAYOUT_ANALYSIS_PROVENANCE"
    | "LAYOUT_DOC_PROVENANCE"
    | "LAYOUT_DOC_MUTABLE"
    | "LAYOUT_DOC_SHARED"
    | "LAYOUT_DOC_SHAPE"
    | "LAYOUT_RESOURCE_BUDGET"
    | "LAYOUT_LEAF_REFERENCE"
    | "LAYOUT_LEAF_TRANSFORM"
    | "LAYOUT_VERBATIM_HANDLE"
    | "LAYOUT_VERBATIM_REQUIRED"
    | "LAYOUT_COMMENT_SUFFIX"
    | "LAYOUT_SOURCE_ORDER"
    | "LAYOUT_SOURCE_DUPLICATE"
    | "LAYOUT_SOURCE_MISSING"
    | "LAYOUT_FLAT_MULTILINE";

export interface LayoutInvariantFailure {
    readonly code: LayoutInvariantFailureCode;
    readonly message: string;
}

export interface LayoutInvariantSuccess {
    readonly ok: true;
    readonly failures: readonly [];
    readonly budget: LayoutResourceBudget;
    readonly docNodeCount: number;
    readonly emittedSourceLeafCount: number;
}

export interface LayoutInvariantFailureResult {
    readonly ok: false;
    readonly failures: readonly LayoutInvariantFailure[];
    readonly budget: LayoutResourceBudget | null;
    readonly docNodeCount: number;
    readonly emittedSourceLeafCount: number;
}

export type LayoutInvariantResult =
    | LayoutInvariantSuccess
    | LayoutInvariantFailureResult;

interface WorkItem {
    readonly doc: LayoutDoc;
    readonly depth: number;
    readonly cumulativeIndent: number;
    readonly cumulativeAlignColumns: number;
    /** Identity of the outermost forced-flat group containing this item. */
    readonly flatGroupRoot: LayoutDoc | null;
    readonly softLineMode: "flat" | "break" | "unknown";
}

const MAX_FAILURES = 32;
function pushFailure(
    failures: LayoutInvariantFailure[],
    code: LayoutInvariantFailureCode,
    message: string
): void {
    if (failures.length >= MAX_FAILURES) {
        return;
    }
    failures.push(Object.freeze({ code, message }));
}

function failureResult(
    failures: LayoutInvariantFailure[],
    budget: LayoutResourceBudget | null,
    docNodeCount: number,
    emittedSourceLeafCount: number
): LayoutInvariantFailureResult {
    return Object.freeze({
        ok: false,
        failures: Object.freeze(failures),
        budget,
        docNodeCount,
        emittedSourceLeafCount,
    });
}

function isComment(leaf: SourceLeaf): boolean {
    return leaf.kind === "line-comment" || leaf.kind === "block-comment";
}

function isPositiveSafeInteger(value: unknown, maximum: number): value is number {
    return (
        typeof value === "number" &&
        Number.isSafeInteger(value) &&
        value > 0 &&
        value <= maximum
    );
}

function denseFrozenDocs(value: readonly LayoutDoc[]): boolean {
    if (!Array.isArray(value) || !Object.isFrozen(value)) {
        return false;
    }
    for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, index);
        if (descriptor === undefined || !("value" in descriptor)) {
            return false;
        }
    }
    return true;
}

/**
 * Iterative, bounded validation of one canonical analysis-scoped LayoutDoc.
 * It proves graph provenance and source ownership before any renderer sees it.
 */
export function validateLayoutDoc(
    analysisValue: unknown,
    rootValue: unknown
): LayoutInvariantResult {
    const failures: LayoutInvariantFailure[] = [];
    if (!isCanonicalAnalyzedArtifact(analysisValue)) {
        pushFailure(
            failures,
            "LAYOUT_ANALYSIS_PROVENANCE",
            "Layout requires an exact canonical analyzed artifact"
        );
        return failureResult(failures, null, 0, 0);
    }
    const analysis = analysisValue;
    let budget: LayoutResourceBudget | null;
    try {
        budget = createLayoutResourceBudget(
            analysis.source.length,
            analysis.leaves.length,
            analysis.index.nodes().length
        );
    } catch {
        budget = null;
    }
    if (budget === null) {
        pushFailure(
            failures,
            "LAYOUT_RESOURCE_BUDGET",
            "Layout resource budget could not be derived"
        );
        return failureResult(failures, null, 0, 0);
    }
    const verbatimClaims = dominatingVerbatimClaims(analysis);
    if (verbatimClaims === null) {
        pushFailure(
            failures,
            "LAYOUT_VERBATIM_REQUIRED",
            "Dominating verbatim claims could not be derived"
        );
        return failureResult(failures, budget, 0, 0);
    }

    const rootProof = canonicalLayoutDocProof(rootValue);
    if (
        rootProof === null ||
        rootProof.analysis !== analysis ||
        !isCanonicalLayoutDocFactory(rootProof.factory)
    ) {
        pushFailure(
            failures,
            "LAYOUT_DOC_PROVENANCE",
            "Layout root was not created by a factory scoped to this analysis"
        );
        return failureResult(failures, budget, 0, 0);
    }
    const root = rootValue as LayoutDoc;
    const expectedFactory: LayoutDocFactory = rootProof.factory;
    const work: WorkItem[] = [
        {
            doc: root,
            depth: 1,
            cumulativeIndent: 0,
            cumulativeAlignColumns: 0,
            flatGroupRoot: null,
            softLineMode: "unknown",
        },
    ];
    const seen = new Set<object>();
    const emitted = new Uint8Array(analysis.leaves.length);
    let emittedSourceLeafCount = 0;
    let sourceOrderCursor = 0;
    let docNodeCount = 0;
    let pendingLineSuffixCount = 0;
    let pendingLineComment = false;
    let pendingLineCommentFlatGroup: LayoutDoc | null = null;
    let generatedColumnsOnLine = 0;
    let generatedWhitespaceCodeUnits = 0;
    const coveredVerbatimClaims = new Set<DominatingVerbatimClaim>();

    const accountGeneratedCodeUnits = (amount: number): void => {
        if (
            amount < 0 ||
            !Number.isSafeInteger(amount) ||
            generatedWhitespaceCodeUnits >
                budget.maxGeneratedWhitespaceCodeUnits - amount
        ) {
            pushFailure(
                failures,
                "LAYOUT_RESOURCE_BUDGET",
                "Layout exceeds the total generated-whitespace budget"
            );
            return;
        }
        generatedWhitespaceCodeUnits += amount;
    };

    const accountGeneratedColumns = (amount: number): void => {
        if (
            amount < 0 ||
            !Number.isSafeInteger(amount) ||
            generatedColumnsOnLine >
                budget.maxGeneratedColumnsPerLine - amount
        ) {
            pushFailure(
                failures,
                "LAYOUT_RESOURCE_BUDGET",
                "Layout exceeds the generated-column budget on one physical line"
            );
            return;
        }
        generatedColumnsOnLine += amount;
    };

    const accountGeneratedInlineWhitespace = (amount: number): void => {
        accountGeneratedCodeUnits(amount);
        accountGeneratedColumns(amount);
    };

    const generatedLinePrefixColumns = (item: WorkItem): number => {
        const indentColumns = item.cumulativeIndent * 4;
        const columns = indentColumns + item.cumulativeAlignColumns;
        if (
            !Number.isSafeInteger(columns) ||
            columns > budget.maxGeneratedColumnsPerLine
        ) {
            pushFailure(
                failures,
                "LAYOUT_RESOURCE_BUDGET",
                "Layout line prefix exceeds the generated-column budget"
            );
        }
        return columns;
    };

    const accountGeneratedBreak = (item: WorkItem): void => {
        const prefixColumns = generatedLinePrefixColumns(item);
        accountGeneratedCodeUnits(1 + prefixColumns);
        pendingLineSuffixCount = 0;
        pendingLineComment = false;
        pendingLineCommentFlatGroup = null;
        generatedColumnsOnLine = 0;
        accountGeneratedColumns(prefixColumns);
    };

    const accountSourceDerivedLineEnding = (item: WorkItem): void => {
        const prefixColumns = generatedLinePrefixColumns(item);
        pendingLineSuffixCount = 0;
        pendingLineComment = false;
        pendingLineCommentFlatGroup = null;
        generatedColumnsOnLine = 0;
        accountGeneratedCodeUnits(prefixColumns);
        accountGeneratedColumns(prefixColumns);
    };

    const beforeSourceEmission = (
        item: WorkItem,
        startsWithLineBreak: boolean
    ): void => {
        if (
            (pendingLineSuffixCount === 0 && !pendingLineComment) ||
            startsWithLineBreak
        ) {
            return;
        }
        if (pendingLineComment) {
            if (
                pendingLineCommentFlatGroup !== null &&
                pendingLineCommentFlatGroup === item.flatGroupRoot
            ) {
                pushFailure(
                    failures,
                    "LAYOUT_FLAT_MULTILINE",
                    "A flat group requires an implicit break after a line comment"
                );
            }
            accountGeneratedBreak(item);
        } else {
            // Block-only suffixes flush in source order without forcing a
            // physical break. They are no longer concurrently pending once
            // ordinary source emission resumes.
            pendingLineSuffixCount = 0;
        }
    };

    const emitRange = (start: number, end: number): boolean => {
        if (
            !Number.isSafeInteger(start) ||
            !Number.isSafeInteger(end) ||
            start < 0 ||
            end <= start ||
            end > analysis.leaves.length
        ) {
            pushFailure(
                failures,
                "LAYOUT_LEAF_REFERENCE",
                `Invalid source leaf range [${String(start)}, ${String(end)})`
            );
            return false;
        }
        if (start < sourceOrderCursor) {
            pushFailure(
                failures,
                "LAYOUT_SOURCE_ORDER",
                `Source emission moved backwards from ${sourceOrderCursor} to ${start}`
            );
            return false;
        }
        sourceOrderCursor = end;
        for (let leafId = start; leafId < end; leafId++) {
            if (emitted[leafId] !== 0) {
                pushFailure(
                    failures,
                    "LAYOUT_SOURCE_DUPLICATE",
                    `Source leaf ${leafId} is emitted more than once`
                );
            } else {
                emitted[leafId] = 1;
                emittedSourceLeafCount += 1;
            }
        }
        return true;
    };

    try {
        while (work.length > 0) {
            const item = work.pop()!;
            const doc = item.doc;
            if (seen.has(doc)) {
                pushFailure(
                    failures,
                    "LAYOUT_DOC_SHARED",
                    "Layout graph contains a cycle or shared child identity"
                );
                continue;
            }
            seen.add(doc);
            docNodeCount += 1;
            if (docNodeCount > budget.maxDocNodes) {
                pushFailure(
                    failures,
                    "LAYOUT_RESOURCE_BUDGET",
                    "Layout graph exceeds the document-node budget"
                );
                break;
            }
            if (item.depth > budget.maxGraphNesting) {
                pushFailure(
                    failures,
                    "LAYOUT_RESOURCE_BUDGET",
                    "Layout graph exceeds the nesting budget"
                );
                continue;
            }
            if (item.cumulativeIndent > budget.maxCumulativeIndentLevels) {
                pushFailure(
                    failures,
                    "LAYOUT_RESOURCE_BUDGET",
                    "Layout graph exceeds the cumulative indent budget"
                );
            }
            if (
                item.cumulativeAlignColumns >
                budget.maxGeneratedColumnsPerLine
            ) {
                pushFailure(
                    failures,
                    "LAYOUT_RESOURCE_BUDGET",
                    "Layout graph exceeds the cumulative align-column budget"
                );
            }
            const proof = canonicalLayoutDocProof(doc);
            if (
                proof === null ||
                proof.analysis !== analysis ||
                proof.factory !== expectedFactory
            ) {
                pushFailure(
                    failures,
                    "LAYOUT_DOC_PROVENANCE",
                    "Layout graph contains a cross-analysis or cross-factory node"
                );
                continue;
            }
            if (!Object.isFrozen(doc)) {
                pushFailure(
                    failures,
                    "LAYOUT_DOC_MUTABLE",
                    "Layout nodes must be frozen"
                );
            }

            switch (doc.kind) {
                case "leaf": {
                    const leaf = analysis.leaves[doc.leafId];
                    if (leaf === undefined || leaf.id !== doc.leafId) {
                        pushFailure(
                            failures,
                            "LAYOUT_LEAF_REFERENCE",
                            `Layout leaf ${String(doc.leafId)} is outside the analysis partition`
                        );
                        break;
                    }
                    const dominatingClaim = verbatimClaims.claimForLeaf(
                        doc.leafId
                    );
                    if (dominatingClaim !== null) {
                        pushFailure(
                            failures,
                            "LAYOUT_VERBATIM_REQUIRED",
                            `Leaf ${doc.leafId} belongs to dominating verbatim owner ${dominatingClaim.ownerNodeId}`
                        );
                        break;
                    }
                    if (isComment(leaf)) {
                        const binding = analysis.index.commentBinding(doc.leafId);
                        if (
                            binding === null ||
                            binding.commentLeafId !== doc.leafId
                        ) {
                            pushFailure(
                                failures,
                                "LAYOUT_COMMENT_SUFFIX",
                                `Comment leaf ${doc.leafId} lacks canonical binding`
                            );
                            break;
                        }
                        if (binding.placement === "trailing") {
                            pushFailure(
                                failures,
                                "LAYOUT_COMMENT_SUFFIX",
                                `Trailing comment leaf ${doc.leafId} must use line-suffix emission`
                            );
                            break;
                        }
                    }
                    if (doc.transform === "keyword-case") {
                        const syntax = analysis.index.leafContext(doc.leafId).syntax;
                        if (
                            leaf.channel !== "code" ||
                            syntax === null ||
                            syntax.keywordCaseEligible !== true ||
                            !isKeywordCaseRole(syntax.syntaxRole)
                        ) {
                            pushFailure(
                                failures,
                                "LAYOUT_LEAF_TRANSFORM",
                                `Leaf ${doc.leafId} lacks canonical keyword-case authority`
                            );
                        }
                    } else if (doc.transform !== "raw") {
                        pushFailure(
                            failures,
                            "LAYOUT_LEAF_TRANSFORM",
                            `Leaf ${doc.leafId} has an unknown transform`
                        );
                    }
                    const containsLineBreak =
                        analysis.index.leafContainsLineBreak(doc.leafId);
                    const startsWithLineBreak =
                        analysis.index.leafStartsWithLineBreak(doc.leafId);
                    const endsWithLineBreak =
                        analysis.index.leafEndsWithLineBreak(doc.leafId);
                    if (item.flatGroupRoot !== null && containsLineBreak) {
                        pushFailure(
                            failures,
                            "LAYOUT_FLAT_MULTILINE",
                            "A flat group contains a multiline source leaf"
                        );
                    }
                    if (!emitRange(doc.leafId, doc.leafId + 1)) {
                        break;
                    }
                    beforeSourceEmission(item, startsWithLineBreak);
                    if (containsLineBreak) {
                        pendingLineSuffixCount = 0;
                        pendingLineComment = false;
                        pendingLineCommentFlatGroup = null;
                        generatedColumnsOnLine = 0;
                    }
                    if (endsWithLineBreak) {
                        accountSourceDerivedLineEnding(item);
                    } else if (leaf.kind === "line-comment") {
                        pendingLineComment = true;
                        pendingLineCommentFlatGroup = item.flatGroupRoot;
                    }
                    break;
                }

                case "verbatim": {
                    const claim = verbatimClaims.claimForOwner(doc.ownerNodeId);
                    if (
                        claim === null ||
                        claim.leafRange !== doc.leafRange ||
                        !Object.isFrozen(doc.trigger) ||
                        !verbatimTriggersEqual(claim.trigger, doc.trigger)
                    ) {
                        pushFailure(
                            failures,
                            "LAYOUT_VERBATIM_HANDLE",
                            `Node ${String(doc.ownerNodeId)} has an invalid verbatim handle`
                        );
                        break;
                    }
                    coveredVerbatimClaims.add(claim);
                    if (!emitRange(doc.leafRange.start, doc.leafRange.end)) {
                        break;
                    }
                    const containsLineBreak =
                        analysis.index.rangeContainsLineBreak(doc.leafRange);
                    const startsWithLineBreak =
                        analysis.index.rangeStartsWithLineBreak(doc.leafRange);
                    const endsWithLineBreak =
                        analysis.index.rangeEndsWithLineBreak(doc.leafRange);
                    if (item.flatGroupRoot !== null && containsLineBreak) {
                        pushFailure(
                            failures,
                            "LAYOUT_FLAT_MULTILINE",
                            "A flat group contains a multiline verbatim range"
                        );
                    }
                    beforeSourceEmission(item, startsWithLineBreak);
                    if (containsLineBreak) {
                        pendingLineSuffixCount = 0;
                        pendingLineComment = false;
                        pendingLineCommentFlatGroup = null;
                        generatedColumnsOnLine = 0;
                    }
                    if (endsWithLineBreak) {
                        accountSourceDerivedLineEnding(item);
                    } else if (
                        analysis.leaves[doc.leafRange.end - 1]?.kind ===
                        "line-comment"
                    ) {
                        pendingLineComment = true;
                        pendingLineCommentFlatGroup = item.flatGroupRoot;
                    }
                    break;
                }

                case "space":
                    if (
                        !isPositiveSafeInteger(
                            doc.columns,
                            budget.maxGeneratedColumnsPerLine
                        )
                    ) {
                        pushFailure(
                            failures,
                            "LAYOUT_RESOURCE_BUDGET",
                            "Space columns are outside the generated-column budget"
                        );
                    } else {
                        accountGeneratedInlineWhitespace(doc.columns);
                    }
                    break;

                case "line":
                    if (doc.mode === "hard") {
                        accountGeneratedBreak(item);
                        if (item.flatGroupRoot !== null) {
                            pushFailure(
                                failures,
                                "LAYOUT_FLAT_MULTILINE",
                                "A flat group contains a hard line"
                            );
                        }
                    } else {
                        if (
                            doc.mode !== "soft" ||
                            (doc.flat !== "empty" && doc.flat !== "space")
                        ) {
                            pushFailure(
                                failures,
                                "LAYOUT_DOC_SHAPE",
                                "Line node has an invalid discriminant"
                            );
                            break;
                        }
                        const flatColumns = doc.flat === "space" ? 1 : 0;
                        if (item.softLineMode === "break") {
                            accountGeneratedBreak(item);
                        } else if (item.softLineMode === "flat") {
                            accountGeneratedInlineWhitespace(flatColumns);
                        } else {
                            const breakColumns = generatedLinePrefixColumns(item);
                            accountGeneratedCodeUnits(1 + breakColumns);
                            accountGeneratedColumns(flatColumns);
                        }
                    }
                    break;

                case "concat":
                    if (!denseFrozenDocs(doc.parts)) {
                        pushFailure(
                            failures,
                            "LAYOUT_DOC_SHAPE",
                            "Concat parts must be a dense frozen data array"
                        );
                        break;
                    }
                    for (let index = doc.parts.length - 1; index >= 0; index--) {
                        work.push({
                            doc: doc.parts[index]!,
                            depth: item.depth + 1,
                            cumulativeIndent: item.cumulativeIndent,
                            cumulativeAlignColumns:
                                item.cumulativeAlignColumns,
                            flatGroupRoot: item.flatGroupRoot,
                            softLineMode: item.softLineMode,
                        });
                    }
                    break;

                case "indent":
                    if (
                        !isPositiveSafeInteger(
                            doc.levels,
                            budget.maxCumulativeIndentLevels
                        )
                    ) {
                        pushFailure(
                            failures,
                            "LAYOUT_RESOURCE_BUDGET",
                            "Indent levels are outside the cumulative-indent budget"
                        );
                    }
                    work.push({
                        doc: doc.content,
                        depth: item.depth + 1,
                        cumulativeIndent: item.cumulativeIndent + doc.levels,
                        cumulativeAlignColumns: item.cumulativeAlignColumns,
                        flatGroupRoot: item.flatGroupRoot,
                        softLineMode: item.softLineMode,
                    });
                    break;

                case "align":
                    if (
                        !isPositiveSafeInteger(
                            doc.columns,
                            budget.maxGeneratedColumnsPerLine
                        )
                    ) {
                        pushFailure(
                            failures,
                            "LAYOUT_RESOURCE_BUDGET",
                            "Align columns are outside the generated-column budget"
                        );
                    }
                    work.push({
                        doc: doc.content,
                        depth: item.depth + 1,
                        cumulativeIndent: item.cumulativeIndent,
                        cumulativeAlignColumns:
                            item.cumulativeAlignColumns + doc.columns,
                        flatGroupRoot: item.flatGroupRoot,
                        softLineMode: item.softLineMode,
                    });
                    break;

                case "pad-to-column":
                    if (
                        !isPositiveSafeInteger(
                            doc.targetColumn,
                            budget.maxGeneratedColumnsPerLine
                        )
                    ) {
                        pushFailure(
                            failures,
                            "LAYOUT_RESOURCE_BUDGET",
                            "Pad target is outside the generated-column budget"
                        );
                    } else {
                        accountGeneratedInlineWhitespace(doc.targetColumn);
                    }
                    break;

                case "group":
                    if (item.flatGroupRoot !== null && doc.mode === "break") {
                        pushFailure(
                            failures,
                            "LAYOUT_FLAT_MULTILINE",
                            "A flat group contains a nested forced-break group"
                        );
                    }
                    if (doc.mode === "auto") {
                        if (
                            !isPositiveSafeInteger(
                                doc.maxFlatWidth,
                                budget.maxGeneratedColumnsPerLine
                            )
                        ) {
                            pushFailure(
                                failures,
                                "LAYOUT_RESOURCE_BUDGET",
                                "Auto-group width is outside the generated-column budget"
                            );
                        }
                    } else if (doc.mode !== "flat" && doc.mode !== "break") {
                        pushFailure(
                            failures,
                            "LAYOUT_DOC_SHAPE",
                            "Group node has an invalid mode"
                        );
                    }
                    work.push({
                        doc: doc.content,
                        depth: item.depth + 1,
                        cumulativeIndent: item.cumulativeIndent,
                        cumulativeAlignColumns: item.cumulativeAlignColumns,
                        flatGroupRoot:
                            item.flatGroupRoot ??
                            (doc.mode === "flat" ? doc : null),
                        softLineMode:
                            item.flatGroupRoot !== null || doc.mode === "flat"
                                ? "flat"
                                : doc.mode === "break"
                                  ? "break"
                                  : "unknown",
                    });
                    break;

                case "line-suffix": {
                    const leaf = analysis.leaves[doc.commentLeafId];
                    const binding = analysis.index.commentBinding(doc.commentLeafId);
                    const dominatingClaim = verbatimClaims.claimForLeaf(
                        doc.commentLeafId
                    );
                    if (
                        leaf === undefined ||
                        !isComment(leaf) ||
                        binding === null ||
                        binding.placement !== "trailing" ||
                        dominatingClaim !== null
                    ) {
                        pushFailure(
                            failures,
                            "LAYOUT_COMMENT_SUFFIX",
                            `Leaf ${String(doc.commentLeafId)} is not a trailing comment`
                        );
                        break;
                    }
                    if (!emitRange(doc.commentLeafId, doc.commentLeafId + 1)) {
                        break;
                    }
                    pendingLineSuffixCount += 1;
                    if (
                        pendingLineSuffixCount >
                        budget.maxPendingLineSuffixes
                    ) {
                        pushFailure(
                            failures,
                            "LAYOUT_RESOURCE_BUDGET",
                            "Layout exceeds the line-suffix budget"
                        );
                    }
                    if (doc.spacing !== null) {
                        const value =
                            doc.spacing.kind === "space"
                                ? doc.spacing.columns
                                : doc.spacing.targetColumn;
                        if (
                            (doc.spacing.kind !== "space" &&
                                doc.spacing.kind !== "pad-to-column") ||
                            !isPositiveSafeInteger(
                                value,
                                budget.maxGeneratedColumnsPerLine
                            ) ||
                            !Object.isFrozen(doc.spacing)
                        ) {
                            pushFailure(
                                failures,
                                "LAYOUT_COMMENT_SUFFIX",
                                "Line-suffix spacing is invalid"
                            );
                        } else {
                            accountGeneratedInlineWhitespace(value);
                        }
                    }
                    if (item.flatGroupRoot !== null) {
                        pushFailure(
                            failures,
                            "LAYOUT_FLAT_MULTILINE",
                            "A flat group contains a line suffix"
                        );
                    }
                    const containsLineBreak =
                        analysis.index.leafContainsLineBreak(doc.commentLeafId);
                    if (containsLineBreak) {
                        pendingLineSuffixCount = 0;
                        pendingLineComment = false;
                        pendingLineCommentFlatGroup = null;
                        generatedColumnsOnLine = 0;
                    }
                    if (
                        analysis.index.leafEndsWithLineBreak(doc.commentLeafId)
                    ) {
                        accountSourceDerivedLineEnding(item);
                    } else if (leaf.kind === "line-comment") {
                        pendingLineComment = true;
                        pendingLineCommentFlatGroup = item.flatGroupRoot;
                    }
                    break;
                }
            }
        }
    } catch {
        pushFailure(
            failures,
            "LAYOUT_DOC_SHAPE",
            "Layout graph inspection failed"
        );
    }

    for (const claim of verbatimClaims.claims) {
        if (!coveredVerbatimClaims.has(claim)) {
            pushFailure(
                failures,
                "LAYOUT_VERBATIM_REQUIRED",
                `Dominating verbatim owner ${claim.ownerNodeId} was not emitted atomically`
            );
        }
    }

    for (let leafId = 0; leafId < analysis.leaves.length; leafId++) {
        const leaf = analysis.leaves[leafId]!;
        if (
            (leaf.channel === "code" ||
                leaf.channel === "protected" ||
                isComment(leaf)) &&
            emitted[leafId] === 0
        ) {
            pushFailure(
                failures,
                "LAYOUT_SOURCE_MISSING",
                `Required source leaf ${leafId} is not emitted`
            );
        }
    }

    if (
        analysis.source.length >
        budget.maxOutputCodeUnits - generatedWhitespaceCodeUnits
    ) {
        pushFailure(
            failures,
            "LAYOUT_RESOURCE_BUDGET",
            "Layout exceeds the total output-code-unit budget"
        );
    }

    if (failures.length > 0) {
        return failureResult(
            failures,
            budget,
            docNodeCount,
            emittedSourceLeafCount
        );
    }
    return Object.freeze({
        ok: true,
        failures: Object.freeze([]) as readonly [],
        budget,
        docNodeCount,
        emittedSourceLeafCount,
    });
}
