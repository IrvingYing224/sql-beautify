import type {
    LayoutPlanBuilder,
    LayoutPlanFailure,
    LayoutPlanResult,
    LayoutPolicyStatistics,
} from "./plan";
import { createLayoutPlanBuilder } from "./plan";
import { createQueryLayoutContext } from "./query-layout-context";
import { applyHiveQueryLayout } from "./query-policy";
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
 * registering only part of its actions must never expose that partial plan.
 */
export function finalizeLayoutPolicyApplication(
    builder: LayoutPlanBuilder,
    applied: LayoutPolicyStatistics | null
): LayoutPlanResult {
    if (applied !== null) {
        return builder.finish(applied);
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
 * Wave 3 policy dispatch. Non-Hive dialects remain identity until Wave 3E;
 * Hive query behavior is delegated to the typed Wave 3C policy.
 */
export function buildLayoutPlan(
    analysisValue: unknown,
    optionsValue: unknown
): LayoutPlanResult {
    const builder = createLayoutPlanBuilder(analysisValue, optionsValue);
    if (builder === null) {
        return failure("Layout policy requires canonical analysis and options");
    }
    const analysis = builder.analysis;
    if (analysis.dialect !== "hive") {
        return builder.finish();
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
        const applied = applyHiveQueryLayout(context);
        return finalizeLayoutPolicyApplication(builder, applied);
    } catch {
        return failure("Layout policy inspection failed");
    }
}
