import { isProxy } from "node:util/types";

import { isCanonicalAnalyzedArtifact } from "../analysis/artifact";
import type { AnalyzedArtifact } from "../analysis/types";
import type { CanonicalFormatOptions } from "../config/options";
import { isCanonicalFormatOptions } from "../config/resolve-options";
import { isKeywordCaseRole } from "../syntax/contextual-fact-contract";
import type { DominatingVerbatimClaim } from "./verbatim-claims";
import { dominatingVerbatimClaims } from "./verbatim-claims";
import type { LayoutResourceBudget } from "./resource-budget";
import { createLayoutResourceBudget } from "./resource-budget";

export type PlannedLeafEmission =
    | "raw"
    | "keyword-case"
    | "line-suffix"
    | "verbatim"
    | "replaced-trivia";

export type LayoutGapDecision =
    | {
          readonly kind: "empty";
      }
    | {
          readonly kind: "space";
          readonly columns: number;
      }
    | {
          readonly kind: "hard-line";
      }
    | {
          readonly kind: "soft-line";
          readonly flat: "empty" | "space";
      };

export interface LayoutGapAction {
    readonly authorityNodeId: number;
    readonly startLeafId: number;
    readonly endLeafId: number;
    readonly decision: LayoutGapDecision;
}

export type LayoutScopeDecision =
    | {
          readonly kind: "indent";
          readonly levels: number;
      }
    | {
          readonly kind: "align";
          readonly columns: number;
      }
    | {
          readonly kind: "group";
          readonly mode: "flat" | "break";
      }
    | {
          readonly kind: "auto-group";
          readonly maxFlatWidth: number;
      };

export interface LayoutScopeAction {
    readonly id: number;
    readonly authorityNodeId: number;
    readonly startLeafId: number;
    readonly endLeafId: number;
    readonly decision: LayoutScopeDecision;
}

export interface LayoutPlanStatistics {
    readonly leafVisitCount: number;
    readonly directLookupCount: number;
    readonly actionCount: number;
    readonly scopeActionCount: number;
    readonly policyNodeVisitCount: number;
    readonly policyLeafVisitCount: number;
    readonly policyDirectLookupCount: number;
}

export interface LayoutPolicyStatistics {
    readonly nodeVisitCount: number;
    readonly leafVisitCount: number;
    readonly directLookupCount: number;
}

export interface LayoutPlan {
    readonly analysis: AnalyzedArtifact;
    readonly options: CanonicalFormatOptions;
    readonly budget: LayoutResourceBudget;
    readonly leafEmissions: readonly PlannedLeafEmission[];
    readonly leafAuthorityNodeIds: readonly (number | null)[];
    readonly gapActions: readonly (LayoutGapAction | null)[];
    readonly scopeStarts: readonly (readonly LayoutScopeAction[] | null)[];
    readonly scopeEnds: readonly (readonly LayoutScopeAction[] | null)[];
    readonly claimStarts: readonly (DominatingVerbatimClaim | null)[];
    readonly statistics: LayoutPlanStatistics;
}

export type LayoutPlanFailureCode =
    | "LAYOUT_PLAN_PROVENANCE"
    | "LAYOUT_PLAN_DOMINATED"
    | "LAYOUT_PLAN_AUTHORITY"
    | "LAYOUT_PLAN_CONFLICT"
    | "LAYOUT_PLAN_GAP"
    | "LAYOUT_PLAN_SCOPE"
    | "LAYOUT_PLAN_RESOURCE"
    | "LAYOUT_PLAN_INTERNAL";

export interface LayoutPlanFailure {
    readonly ok: false;
    readonly code: LayoutPlanFailureCode;
    readonly message: string;
}

export interface LayoutPlanSuccess {
    readonly ok: true;
    readonly plan: LayoutPlan;
}

export type LayoutPlanResult = LayoutPlanSuccess | LayoutPlanFailure;

export interface LayoutPlanBuilder {
    readonly analysis: AnalyzedArtifact;
    readonly options: CanonicalFormatOptions;
    readonly budget: LayoutResourceBudget;
    setKeywordCase(authorityNodeId: number, leafId: number): boolean;
    replaceGap(
        authorityNodeId: number,
        startLeafId: number,
        endLeafId: number,
        decision: LayoutGapDecision
    ): boolean;
    wrapRange(
        authorityNodeId: number,
        startLeafId: number,
        endLeafId: number,
        decision: LayoutScopeDecision
    ): boolean;
    finish(policyStatistics?: LayoutPolicyStatistics): LayoutPlanResult;
}

const CANONICAL_LAYOUT_PLANS = new WeakSet<object>();

function resultFailure(
    code: LayoutPlanFailureCode,
    message: string
): LayoutPlanFailure {
    return Object.freeze({ ok: false, code, message });
}

const ZERO_POLICY_STATISTICS: LayoutPolicyStatistics = Object.freeze({
    nodeVisitCount: 0,
    leafVisitCount: 0,
    directLookupCount: 0,
});

function snapshotPolicyStatistics(
    value: unknown,
    maximumCount: number
): LayoutPolicyStatistics | null {
    if (value === undefined) {
        return ZERO_POLICY_STATISTICS;
    }
    try {
        if (typeof value !== "object" || value === null || isProxy(value)) {
            return null;
        }
        const keys = Reflect.ownKeys(value);
        const expected = [
            "nodeVisitCount",
            "leafVisitCount",
            "directLookupCount",
        ] as const;
        if (
            keys.length !== expected.length ||
            expected.some((key) => !keys.includes(key))
        ) {
            return null;
        }
        const counts = expected.map((key) => {
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            return descriptor !== undefined && "value" in descriptor
                ? descriptor.value
                : null;
        });
        if (
            counts.some(
                (count) =>
                    !Number.isSafeInteger(count) ||
                    (count as number) < 0 ||
                    (count as number) > maximumCount
            )
        ) {
            return null;
        }
        return Object.freeze({
            nodeVisitCount: counts[0] as number,
            leafVisitCount: counts[1] as number,
            directLookupCount: counts[2] as number,
        });
    } catch {
        return null;
    }
}

function snapshotGapDecision(
    value: unknown,
    maximumColumns: number
): LayoutGapDecision | null {
    try {
        if (typeof value !== "object" || value === null || isProxy(value)) {
            return null;
        }
        const kindDescriptor = Object.getOwnPropertyDescriptor(value, "kind");
        if (kindDescriptor === undefined || !("value" in kindDescriptor)) {
            return null;
        }
        if (
            kindDescriptor.value === "empty" ||
            kindDescriptor.value === "hard-line"
        ) {
            return Reflect.ownKeys(value).length === 1
                ? Object.freeze({ kind: kindDescriptor.value })
                : null;
        }
        if (kindDescriptor.value === "soft-line") {
            const keys = Reflect.ownKeys(value);
            const flatDescriptor = Object.getOwnPropertyDescriptor(value, "flat");
            if (
                keys.length !== 2 ||
                !keys.includes("kind") ||
                !keys.includes("flat") ||
                flatDescriptor === undefined ||
                !("value" in flatDescriptor) ||
                (flatDescriptor.value !== "empty" &&
                    flatDescriptor.value !== "space")
            ) {
                return null;
            }
            return Object.freeze({
                kind: "soft-line",
                flat: flatDescriptor.value,
            });
        }
        if (kindDescriptor.value !== "space") {
            return null;
        }
        const keys = Reflect.ownKeys(value);
        const columnsDescriptor = Object.getOwnPropertyDescriptor(
            value,
            "columns"
        );
        if (
            keys.length !== 2 ||
            !keys.includes("kind") ||
            !keys.includes("columns") ||
            columnsDescriptor === undefined ||
            !("value" in columnsDescriptor) ||
            !Number.isSafeInteger(columnsDescriptor.value) ||
            columnsDescriptor.value <= 0 ||
            columnsDescriptor.value > maximumColumns
        ) {
            return null;
        }
        return Object.freeze({
            kind: "space",
            columns: columnsDescriptor.value as number,
        });
    } catch {
        return null;
    }
}

function decisionsEqual(
    left: LayoutGapDecision,
    right: LayoutGapDecision
): boolean {
    if (left.kind !== right.kind) {
        return false;
    }
    if (left.kind === "space") {
        return right.kind === "space" && left.columns === right.columns;
    }
    if (left.kind === "soft-line") {
        return right.kind === "soft-line" && left.flat === right.flat;
    }
    return true;
}

function snapshotScopeDecision(
    value: unknown,
    budget: LayoutResourceBudget
): LayoutScopeDecision | null {
    try {
        if (typeof value !== "object" || value === null || isProxy(value)) {
            return null;
        }
        const keys = Reflect.ownKeys(value);
        const kindDescriptor = Object.getOwnPropertyDescriptor(value, "kind");
        if (kindDescriptor === undefined || !("value" in kindDescriptor)) {
            return null;
        }
        if (kindDescriptor.value === "group") {
            const modeDescriptor = Object.getOwnPropertyDescriptor(value, "mode");
            if (
                keys.length !== 2 ||
                !keys.includes("kind") ||
                !keys.includes("mode") ||
                modeDescriptor === undefined ||
                !("value" in modeDescriptor) ||
                (modeDescriptor.value !== "flat" &&
                    modeDescriptor.value !== "break")
            ) {
                return null;
            }
            return Object.freeze({
                kind: "group",
                mode: modeDescriptor.value,
            });
        }
        const valueKey =
            kindDescriptor.value === "indent"
                ? "levels"
                : kindDescriptor.value === "align"
                  ? "columns"
                  : kindDescriptor.value === "auto-group"
                    ? "maxFlatWidth"
                    : null;
        if (valueKey === null) {
            return null;
        }
        const valueDescriptor = Object.getOwnPropertyDescriptor(value, valueKey);
        const maximum = kindDescriptor.value === "indent"
            ? budget.maxCumulativeIndentLevels
            : budget.maxGeneratedColumnsPerLine;
        if (
            keys.length !== 2 ||
            !keys.includes("kind") ||
            !keys.includes(valueKey) ||
            valueDescriptor === undefined ||
            !("value" in valueDescriptor) ||
            !Number.isSafeInteger(valueDescriptor.value) ||
            valueDescriptor.value <= 0 ||
            valueDescriptor.value > maximum
        ) {
            return null;
        }
        const amount = valueDescriptor.value as number;
        return kindDescriptor.value === "indent"
            ? Object.freeze({ kind: "indent", levels: amount })
            : kindDescriptor.value === "align"
              ? Object.freeze({ kind: "align", columns: amount })
              : Object.freeze({
                    kind: "auto-group",
                    maxFlatWidth: amount,
                });
    } catch {
        return null;
    }
}

function scopeDecisionsEqual(
    left: LayoutScopeDecision,
    right: LayoutScopeDecision
): boolean {
    if (left.kind !== right.kind) {
        return false;
    }
    switch (left.kind) {
        case "indent":
            return right.kind === "indent" && left.levels === right.levels;
        case "align":
            return right.kind === "align" && left.columns === right.columns;
        case "group":
            return right.kind === "group" && left.mode === right.mode;
        case "auto-group":
            return (
                right.kind === "auto-group" &&
                left.maxFlatWidth === right.maxFlatWidth
            );
    }
}

function scopeDecisionOrder(value: LayoutScopeDecision): number {
    return value.kind === "group" || value.kind === "auto-group"
        ? 0
        : value.kind === "indent"
          ? 1
          : 2;
}

function scopeDecisionFamily(value: LayoutScopeDecision): string {
    return value.kind === "group" || value.kind === "auto-group"
        ? "group"
        : value.kind;
}

/**
 * Creates the only mutable registration surface for a LayoutPlan. Dominating
 * claims and default identity emissions are installed before policy actions.
 */
export function createLayoutPlanBuilder(
    analysisValue: unknown,
    optionsValue: unknown
): LayoutPlanBuilder | null {
    if (
        !isCanonicalAnalyzedArtifact(analysisValue) ||
        !isCanonicalFormatOptions(optionsValue) ||
        analysisValue.dialect !== optionsValue.dialect
    ) {
        return null;
    }
    const analysis = analysisValue;
    const options = optionsValue;
    let budget: LayoutResourceBudget;
    let claims: ReturnType<typeof dominatingVerbatimClaims>;
    try {
        const derivedBudget = createLayoutResourceBudget(
            analysis.source.length,
            analysis.leaves.length,
            analysis.index.nodes().length
        );
        claims = dominatingVerbatimClaims(analysis);
        if (derivedBudget === null || claims === null) {
            return null;
        }
        budget = derivedBudget;
    } catch {
        return null;
    }

    const leafEmissions: PlannedLeafEmission[] = new Array(
        analysis.leaves.length
    ).fill("raw");
    const leafAuthorityNodeIds: Array<number | null> = new Array(
        analysis.leaves.length
    ).fill(null);
    const gapActions: Array<LayoutGapAction | null> = new Array(
        analysis.leaves.length + 1
    ).fill(null);
    const scopeActions: LayoutScopeAction[] = [];
    const scopeByKey = new Map<string, LayoutScopeAction>();
    const claimStarts: Array<DominatingVerbatimClaim | null> = new Array(
        analysis.leaves.length + 1
    ).fill(null);
    let leafVisitCount = 0;
    let directLookupCount = 0;
    let actionCount = 0;
    let failure: LayoutPlanFailure | null = null;
    let finished = false;

    const poison = (
        code: LayoutPlanFailureCode,
        message: string
    ): false => {
        if (failure === null) {
            failure = resultFailure(code, message);
        }
        return false;
    };

    const formattedAuthority = (nodeId: number) => {
        if (!Number.isSafeInteger(nodeId) || nodeId < 0) {
            return null;
        }
        try {
            const node = analysis.index.nodeById(nodeId);
            const capability = analysis.index.capabilityForNode(nodeId);
            return node.formatRole === "capability" &&
                node.capabilityId !== null &&
                capability?.id === node.capabilityId &&
                capability.state === "formatted"
                ? node
                : null;
        } catch {
            return null;
        }
    };

    try {
        for (const claim of claims.claims) {
            if (claimStarts[claim.leafRange.start] !== null) {
                return null;
            }
            claimStarts[claim.leafRange.start] = claim;
            actionCount += 1;
            for (
                let leafId = claim.leafRange.start;
                leafId < claim.leafRange.end;
                leafId++
            ) {
                leafVisitCount += 1;
                if (leafEmissions[leafId] !== "raw") {
                    return null;
                }
                leafEmissions[leafId] = "verbatim";
            }
        }
        for (let leafId = 0; leafId < analysis.leaves.length; leafId++) {
            leafVisitCount += 1;
            if (leafEmissions[leafId] === "verbatim") {
                continue;
            }
            const leaf = analysis.leaves[leafId]!;
            if (leaf.kind === "line-comment" || leaf.kind === "block-comment") {
                directLookupCount += 1;
                const binding = analysis.index.commentBinding(leafId);
                if (binding?.placement === "trailing") {
                    leafEmissions[leafId] = "line-suffix";
                }
            }
            actionCount += 1;
        }
    } catch {
        return null;
    }
    if (actionCount > budget.maxPlanActions) {
        return null;
    }

    let builder!: LayoutPlanBuilder;
    builder = Object.freeze({
        analysis,
        options,
        budget,

        setKeywordCase(authorityNodeId: number, leafId: number): boolean {
            if (finished) {
                return poison(
                    "LAYOUT_PLAN_CONFLICT",
                    "Layout plan is already finalized"
                );
            }
            if (
                !Number.isSafeInteger(leafId) ||
                leafId < 0 ||
                leafId >= leafEmissions.length
            ) {
                return poison(
                    "LAYOUT_PLAN_CONFLICT",
                    `Invalid keyword leaf ${String(leafId)}`
                );
            }
            directLookupCount += 1;
            const current = leafEmissions[leafId]!;
            if (current === "verbatim") {
                return poison(
                    "LAYOUT_PLAN_DOMINATED",
                    `Leaf ${leafId} is covered by a dominating verbatim range`
                );
            }
            if (current === "keyword-case") {
                return leafAuthorityNodeIds[leafId] === authorityNodeId
                    ? true
                    : poison(
                          "LAYOUT_PLAN_CONFLICT",
                          `Leaf ${leafId} already belongs to another formatted authority`
                      );
            }
            if (current !== "raw") {
                return poison(
                    "LAYOUT_PLAN_CONFLICT",
                    `Leaf ${leafId} already has incompatible emission ${current}`
                );
            }
            try {
                const authority = formattedAuthority(authorityNodeId);
                const leaf = analysis.leaves[leafId]!;
                const syntax = analysis.index.leafContext(leafId).syntax;
                directLookupCount += 1;
                if (
                    authority === null ||
                    leafId < authority.leafRange.start ||
                    leafId >= authority.leafRange.end ||
                    leaf.channel !== "code" ||
                    syntax === null ||
                    syntax.keywordCaseEligible !== true ||
                    !isKeywordCaseRole(syntax.syntaxRole)
                ) {
                    return poison(
                        authority === null
                            ? "LAYOUT_PLAN_AUTHORITY"
                            : "LAYOUT_PLAN_CONFLICT",
                        `Leaf ${leafId} lacks canonical formatted keyword-case authority`
                    );
                }
                leafEmissions[leafId] = "keyword-case";
                leafAuthorityNodeIds[leafId] = authorityNodeId;
                return true;
            } catch {
                return poison(
                    "LAYOUT_PLAN_INTERNAL",
                    "Keyword registration inspection failed"
                );
            }
        },

        replaceGap(
            authorityNodeId: number,
            startLeafId: number,
            endLeafId: number,
            rawDecision: LayoutGapDecision
        ): boolean {
            if (finished) {
                return poison(
                    "LAYOUT_PLAN_CONFLICT",
                    "Layout plan is already finalized"
                );
            }
            const decision = snapshotGapDecision(
                rawDecision,
                budget.maxGeneratedColumnsPerLine
            );
            if (
                decision === null ||
                !Number.isSafeInteger(startLeafId) ||
                !Number.isSafeInteger(endLeafId) ||
                startLeafId < 0 ||
                endLeafId < startLeafId ||
                endLeafId > analysis.leaves.length
            ) {
                return poison(
                    "LAYOUT_PLAN_GAP",
                    "Layout gap registration is invalid"
                );
            }
            const authority = formattedAuthority(authorityNodeId);
            const insertion = startLeafId === endLeafId;
            if (
                authority === null ||
                startLeafId < authority.leafRange.start ||
                endLeafId > authority.leafRange.end ||
                (insertion &&
                    (startLeafId <= authority.leafRange.start ||
                        startLeafId >= authority.leafRange.end))
            ) {
                return poison(
                    "LAYOUT_PLAN_AUTHORITY",
                    `Gap [${startLeafId}, ${endLeafId}) is outside formatted authority ${String(authorityNodeId)}`
                );
            }
            const existing = gapActions[startLeafId];
            if (existing !== null && existing !== undefined) {
                if (
                    existing.endLeafId === endLeafId &&
                    existing.authorityNodeId === authorityNodeId &&
                    decisionsEqual(existing.decision, decision)
                ) {
                    return true;
                }
                return poison(
                    "LAYOUT_PLAN_CONFLICT",
                    `Boundary ${startLeafId} already has an incompatible decision`
                );
            }
            if (insertion) {
                const leftClaim = startLeafId > 0
                    ? claims.claimForLeaf(startLeafId - 1)
                    : null;
                const rightClaim = startLeafId < analysis.leaves.length
                    ? claims.claimForLeaf(startLeafId)
                    : null;
                if (
                    (leftClaim !== null && leftClaim === rightClaim) ||
                    (startLeafId > 0 &&
                        leafEmissions[startLeafId - 1] === "replaced-trivia" &&
                        startLeafId < analysis.leaves.length &&
                        leafEmissions[startLeafId] === "replaced-trivia")
                ) {
                    return poison(
                        leftClaim !== null
                            ? "LAYOUT_PLAN_DOMINATED"
                            : "LAYOUT_PLAN_CONFLICT",
                        `Boundary ${startLeafId} is already dominated by an atomic range`
                    );
                }
            }
            for (let leafId = startLeafId; leafId < endLeafId; leafId++) {
                leafVisitCount += 1;
                directLookupCount += 1;
                const leaf = analysis.leaves[leafId];
                if (
                    leaf === undefined ||
                    leafEmissions[leafId] !== "raw" ||
                    leaf.channel !== "trivia" ||
                    (leaf.kind !== "whitespace" && leaf.kind !== "newline")
                ) {
                    const code = leafEmissions[leafId] === "verbatim"
                        ? "LAYOUT_PLAN_DOMINATED"
                        : "LAYOUT_PLAN_GAP";
                    return poison(
                        code,
                        `Gap [${startLeafId}, ${endLeafId}) is not replaceable layout trivia`
                    );
                }
            }
            if (actionCount >= budget.maxPlanActions) {
                return poison(
                    "LAYOUT_PLAN_RESOURCE",
                    "Layout plan exceeds the action budget"
                );
            }
            const action = Object.freeze({
                authorityNodeId,
                startLeafId,
                endLeafId,
                decision,
            });
            gapActions[startLeafId] = action;
            for (let leafId = startLeafId; leafId < endLeafId; leafId++) {
                leafEmissions[leafId] = "replaced-trivia";
            }
            actionCount += 1;
            return true;
        },

        wrapRange(
            authorityNodeId: number,
            startLeafId: number,
            endLeafId: number,
            rawDecision: LayoutScopeDecision
        ): boolean {
            if (finished) {
                return poison(
                    "LAYOUT_PLAN_CONFLICT",
                    "Layout plan is already finalized"
                );
            }
            const decision = snapshotScopeDecision(rawDecision, budget);
            if (
                decision === null ||
                !Number.isSafeInteger(startLeafId) ||
                !Number.isSafeInteger(endLeafId) ||
                startLeafId < 0 ||
                endLeafId <= startLeafId ||
                endLeafId > analysis.leaves.length
            ) {
                return poison(
                    "LAYOUT_PLAN_SCOPE",
                    "Layout scope registration is invalid"
                );
            }
            const authority = formattedAuthority(authorityNodeId);
            if (
                authority === null ||
                startLeafId < authority.leafRange.start ||
                endLeafId > authority.leafRange.end
            ) {
                return poison(
                    "LAYOUT_PLAN_AUTHORITY",
                    `Scope [${startLeafId}, ${endLeafId}) is outside formatted authority ${String(authorityNodeId)}`
                );
            }
            const startClaim = claims.claimForLeaf(startLeafId);
            const endClaim = claims.claimForLeaf(endLeafId - 1);
            if (
                (startClaim !== null &&
                    startLeafId > startClaim.leafRange.start) ||
                (endClaim !== null && endLeafId < endClaim.leafRange.end)
            ) {
                return poison(
                    "LAYOUT_PLAN_DOMINATED",
                    `Scope [${startLeafId}, ${endLeafId}) cuts an atomic verbatim range`
                );
            }
            const boundaryInsideReplacedGap = (boundary: number): boolean =>
                boundary > 0 &&
                boundary < leafEmissions.length &&
                leafEmissions[boundary - 1] === "replaced-trivia" &&
                leafEmissions[boundary] === "replaced-trivia";
            if (
                boundaryInsideReplacedGap(startLeafId) ||
                boundaryInsideReplacedGap(endLeafId)
            ) {
                return poison(
                    "LAYOUT_PLAN_CONFLICT",
                    "Layout scope boundary cuts a replaced trivia range"
                );
            }
            const key = `${startLeafId}:${endLeafId}:${scopeDecisionFamily(decision)}`;
            const existing = scopeByKey.get(key);
            if (existing !== undefined) {
                return existing.authorityNodeId === authorityNodeId &&
                    scopeDecisionsEqual(existing.decision, decision)
                    ? true
                    : poison(
                          "LAYOUT_PLAN_CONFLICT",
                          `Scope ${key} already has an incompatible decision`
                      );
            }
            if (actionCount >= budget.maxPlanActions) {
                return poison(
                    "LAYOUT_PLAN_RESOURCE",
                    "Layout plan exceeds the action budget"
                );
            }
            const action = Object.freeze({
                id: scopeActions.length,
                authorityNodeId,
                startLeafId,
                endLeafId,
                decision,
            });
            scopeActions.push(action);
            scopeByKey.set(key, action);
            actionCount += 1;
            return true;
        },

        finish(rawPolicyStatistics?: LayoutPolicyStatistics): LayoutPlanResult {
            if (finished) {
                return failure ?? resultFailure(
                    "LAYOUT_PLAN_CONFLICT",
                    "Layout plan is already finalized"
                );
            }
            finished = true;
            if (failure !== null) {
                return failure;
            }
            const policyStatistics = snapshotPolicyStatistics(
                rawPolicyStatistics,
                budget.maxPlanActions
            );
            if (policyStatistics === null) {
                return resultFailure(
                    "LAYOUT_PLAN_RESOURCE",
                    "Layout policy statistics are invalid or exceed the linear budget"
                );
            }
            let scopeStarts: LayoutPlan["scopeStarts"];
            let scopeEnds: LayoutPlan["scopeEnds"];
            if (scopeActions.length === 0) {
                const emptyScopeBoundaries = Object.freeze(
                    new Array<readonly LayoutScopeAction[] | null>(
                        analysis.leaves.length + 1
                    ).fill(null)
                );
                scopeStarts = emptyScopeBoundaries;
                scopeEnds = emptyScopeBoundaries;
            } else {
                const sortedScopes = scopeActions.slice().sort((left, right) =>
                    left.startLeafId - right.startLeafId ||
                    right.endLeafId - left.endLeafId ||
                    scopeDecisionOrder(left.decision) -
                        scopeDecisionOrder(right.decision) ||
                    left.id - right.id
                );
                const nesting: LayoutScopeAction[] = [];
                for (const scope of sortedScopes) {
                    while (
                        nesting.length > 0 &&
                        scope.startLeafId >=
                            nesting[nesting.length - 1]!.endLeafId
                    ) {
                        nesting.pop();
                    }
                    const parent = nesting[nesting.length - 1];
                    if (
                        parent !== undefined &&
                        scope.endLeafId > parent.endLeafId
                    ) {
                        return resultFailure(
                            "LAYOUT_PLAN_SCOPE",
                            `Scopes ${parent.id} and ${scope.id} cross without nesting`
                        );
                    }
                    nesting.push(scope);
                }

                const indentationScopeDeltas = new Int32Array(
                    analysis.leaves.length + 1
                );
                for (const scope of sortedScopes) {
                    if (
                        scope.decision.kind !== "indent" &&
                        scope.decision.kind !== "align"
                    ) {
                        continue;
                    }
                    indentationScopeDeltas[scope.startLeafId] =
                        indentationScopeDeltas[scope.startLeafId]! + 1;
                    indentationScopeDeltas[scope.endLeafId] =
                        indentationScopeDeltas[scope.endLeafId]! - 1;
                }
                let activeIndentationScopes = 0;
                for (
                    let leafId = 0;
                    leafId < analysis.leaves.length;
                    leafId++
                ) {
                    activeIndentationScopes += indentationScopeDeltas[leafId]!;
                    leafVisitCount += 1;
                    if (
                        activeIndentationScopes > 0 &&
                        analysis.leaves[leafId]?.kind === "newline" &&
                        leafEmissions[leafId] !== "replaced-trivia" &&
                        claims.claimForLeaf(leafId) === null
                    ) {
                        return resultFailure(
                            "LAYOUT_PLAN_SCOPE",
                            `Indentation scope contains unowned newline trivia at leaf ${leafId}`
                        );
                    }
                }

                const scopeBoundaryCounts = new Uint16Array(
                    analysis.leaves.length + 1
                );
                for (const scope of sortedScopes) {
                    if (
                        scopeBoundaryCounts[scope.startLeafId] === 0xFFFF ||
                        scopeBoundaryCounts[scope.endLeafId] === 0xFFFF
                    ) {
                        return resultFailure(
                            "LAYOUT_PLAN_RESOURCE",
                            "Layout scope boundary fanout is too large"
                        );
                    }
                    scopeBoundaryCounts[scope.startLeafId] =
                        scopeBoundaryCounts[scope.startLeafId]! + 1;
                    scopeBoundaryCounts[scope.endLeafId] =
                        scopeBoundaryCounts[scope.endLeafId]! + 1;
                }
                for (const gap of gapActions) {
                    if (
                        gap === null ||
                        gap.endLeafId <= gap.startLeafId + 1
                    ) {
                        continue;
                    }
                    for (
                        let boundary = gap.startLeafId + 1;
                        boundary < gap.endLeafId;
                        boundary++
                    ) {
                        leafVisitCount += 1;
                        if (scopeBoundaryCounts[boundary] !== 0) {
                            return resultFailure(
                                "LAYOUT_PLAN_CONFLICT",
                                `Gap [${gap.startLeafId}, ${gap.endLeafId}) skips a scope boundary`
                            );
                        }
                    }
                }

                const mutableScopeStarts: Array<LayoutScopeAction[] | null> =
                    new Array(analysis.leaves.length + 1).fill(null);
                const mutableScopeEnds: Array<LayoutScopeAction[] | null> =
                    new Array(analysis.leaves.length + 1).fill(null);
                for (const scope of sortedScopes) {
                    (mutableScopeStarts[scope.startLeafId] ??= []).push(scope);
                    (mutableScopeEnds[scope.endLeafId] ??= []).push(scope);
                }
                scopeStarts = Object.freeze(
                    mutableScopeStarts.map((values) =>
                        values === null
                            ? null
                            : Object.freeze(values.slice())
                    )
                );
                scopeEnds = Object.freeze(
                    mutableScopeEnds.map((values) => {
                        if (values === null) {
                            return null;
                        }
                        return Object.freeze(
                            values.slice().sort((left, right) =>
                                right.startLeafId - left.startLeafId ||
                                scopeDecisionOrder(right.decision) -
                                    scopeDecisionOrder(left.decision) ||
                                right.id - left.id
                            )
                        );
                    })
                );
            }
            const statistics = Object.freeze({
                leafVisitCount,
                directLookupCount,
                actionCount,
                scopeActionCount: scopeActions.length,
                policyNodeVisitCount: policyStatistics.nodeVisitCount,
                policyLeafVisitCount: policyStatistics.leafVisitCount,
                policyDirectLookupCount: policyStatistics.directLookupCount,
            });
            const plan = Object.freeze({
                analysis,
                options,
                budget,
                leafEmissions: Object.freeze(leafEmissions.slice()),
                leafAuthorityNodeIds: Object.freeze(
                    leafAuthorityNodeIds.slice()
                ),
                gapActions: Object.freeze(gapActions.slice()),
                scopeStarts,
                scopeEnds,
                claimStarts: Object.freeze(claimStarts.slice()),
                statistics,
            });
            CANONICAL_LAYOUT_PLANS.add(plan);
            return Object.freeze({ ok: true, plan });
        },
    });
    return builder;
}

/** Exact identity proof for immutable plans emitted by the canonical builder. */
export function isCanonicalLayoutPlan(value: unknown): value is LayoutPlan {
    return (
        typeof value === "object" &&
        value !== null &&
        Object.isFrozen(value) &&
        CANONICAL_LAYOUT_PLANS.has(value)
    );
}
