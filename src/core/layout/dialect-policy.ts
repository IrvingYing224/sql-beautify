import type { LayoutPolicyStatistics } from "./plan";
import { applyExpressionLayout } from "./expression-policy";
import { applyKeywordCaseLayout } from "./keyword-policy";
import {
    queryPolicyStatistics,
} from "./query-layout-context";
import type { QueryLayoutContext } from "./query-layout-context";
import { applyQueryLayout } from "./query-policy";
import { applyTriviaLayout } from "./trivia-policy";

/** Single registry-gated transaction shared by every proven dialect subset. */
export function applyDialectLayout(
    context: QueryLayoutContext
): LayoutPolicyStatistics | null {
    if (
        !applyQueryLayout(context) ||
        !applyExpressionLayout(context) ||
        !applyTriviaLayout(context) ||
        !applyKeywordCaseLayout(context)
    ) {
        return null;
    }
    return queryPolicyStatistics(context);
}
