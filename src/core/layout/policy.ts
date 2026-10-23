import type {
    LayoutPlanBuilder,
    LayoutPlanFailure,
    LayoutPlanResult,
} from "./plan";
import { createLayoutPlanBuilder } from "./plan";
import { applyDialectLayout } from "./dialect-policy";
import type { LayoutAlignmentPlan } from "./alignment-policy";
import { createQueryLayoutContext } from "./query-layout-context";
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

/** Identity policy used to prove the compiler and renderer conservation path. */
export function buildIdentityLayoutPlan(
    analysisValue: unknown,
    optionsValue: unknown
): LayoutPlanResult {
    const builder = createLayoutPlanBuilder(analysisValue, optionsValue);
    return builder === null
        ? failure("Identity layout requires canonical analysis and options")
        : builder.finish();
}

/**
 * Wave 3 policy dispatch. Registry state and dominating claims gate the proven
 * subset for each dialect before the shared typed policy can register actions.
 */
export function buildLayoutPlan(
    analysisValue: unknown,
    optionsValue: unknown,
    alignmentPlan: LayoutAlignmentPlan | null = null
): LayoutPlanResult {
    const builder = createLayoutPlanBuilder(analysisValue, optionsValue);
    if (builder === null) {
        return failure("Layout policy requires canonical analysis and options");
    }
    const analysis = builder.analysis;
    const claims = dominatingVerbatimClaims(analysis);
    if (claims === null) {
        return failure("Layout policy could not derive dominating ranges");
    }

    try {
        const context = createQueryLayoutContext(
            builder,
            claims,
            alignmentPlan
        );
        if (context === null) {
            return failure("Layout policy could not derive query authority");
        }
        return finalizeLayoutPolicyApplication(
            builder,
            applyDialectLayout(context) ? context.state.commaFallback : null
        );
    } catch {
        return failure("Layout policy inspection failed");
    }
}
