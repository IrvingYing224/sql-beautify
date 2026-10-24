import type { AnalyzedArtifact } from "../analysis/types";
import type { CanonicalFormatOptions } from "../config/options";
import type {
    LayoutPlanBuilder,
    LayoutPlanFailure,
    LayoutPlanResult,
} from "./plan";
import { createLayoutPlanBuilder } from "./plan";
import { applyExpressionLayout } from "./expression-policy";
import { applyKeywordCaseLayout } from "./keyword-policy";
import { createQueryLayoutContext } from "./query-layout-context";
import { applyQueryLayout } from "./query-policy";
import { applyTriviaLayout } from "./trivia-policy";
import { dominatingVerbatimClaims } from "./verbatim-claims";

function failure(message: string): LayoutPlanFailure {
    return Object.freeze({
        ok: false,
        code: "LAYOUT_PLAN_PROVENANCE",
        message,
    });
}

/**
 * Commits a complete policy result atomically. A policy that stops after
 * registering only part of its actions must never expose that partial plan;
 * `commaFallback` is null when the policy stopped.
 */
export function finalizeLayoutPolicyApplication(
    builder: LayoutPlanBuilder,
    commaFallback: boolean | null
): LayoutPlanResult {
    if (commaFallback !== null) {
        return builder.finish(commaFallback);
    }
    const partial = builder.finish();
    return partial.ok
        ? failure("Layout policy rejected an incomplete plan")
        : partial;
}

/**
 * Wave 3 policy dispatch. Registry state and dominating claims gate the proven
 * Hive subset before the typed policies register actions in one transaction.
 */
export function buildLayoutPlan(
    analysis: AnalyzedArtifact,
    options: CanonicalFormatOptions
): LayoutPlanResult {
    const builder = createLayoutPlanBuilder(analysis, options);
    if (builder === null) {
        return failure("Layout policy requires canonical analysis and options");
    }
    const claims = dominatingVerbatimClaims(analysis);
    if (claims === null) {
        return failure("Layout policy could not derive dominating ranges");
    }

    try {
        const context = createQueryLayoutContext(builder, claims);
        if (context === null) {
            return failure("Layout policy could not derive query authority");
        }
        const complete =
            applyQueryLayout(context) &&
            applyExpressionLayout(context) &&
            applyTriviaLayout(context) &&
            applyKeywordCaseLayout(context);
        return finalizeLayoutPolicyApplication(
            builder,
            complete ? context.state.commaFallback : null
        );
    } catch {
        return failure("Layout policy inspection failed");
    }
}
