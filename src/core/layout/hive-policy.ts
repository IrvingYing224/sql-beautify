import type { LayoutPolicyStatistics } from "./plan";
import { applyHiveExpressionLayout } from "./expression-policy";
import { applyKeywordCaseLayout } from "./keyword-policy";
import {
    queryPolicyStatistics,
} from "./query-layout-context";
import type { QueryLayoutContext } from "./query-layout-context";
import { applyHiveQueryLayout } from "./query-policy";
import { canonicalizeScopedAuthorityLineBreaks } from "./query-trivia-policy";

/** Single Hive policy transaction; any child policy failure rejects all actions. */
export function applyHiveLayout(
    context: QueryLayoutContext
): LayoutPolicyStatistics | null {
    if (
        !applyHiveQueryLayout(context) ||
        !applyHiveExpressionLayout(context) ||
        !canonicalizeScopedAuthorityLineBreaks(context) ||
        !applyKeywordCaseLayout(context)
    ) {
        return null;
    }
    return queryPolicyStatistics(context);
}
