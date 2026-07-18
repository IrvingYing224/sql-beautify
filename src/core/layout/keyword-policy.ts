import { isKeywordCaseRole } from "../syntax/contextual-fact-contract";
import { authorityForNode } from "./query-layout-context";
import type { QueryLayoutContext } from "./query-layout-context";

export function applyKeywordCaseLayout(context: QueryLayoutContext): boolean {
    for (let leafId = 0; leafId < context.analysis.leafCount; leafId++) {
        context.statistics.leafVisitCount += 1;
        if (context.claims.claimForLeaf(leafId) !== null) {
            context.statistics.directLookupCount += 1;
            continue;
        }
        context.statistics.directLookupCount += 1;
        const syntax = context.analysis.index.leafContext(leafId).syntax;
        context.statistics.directLookupCount += 1;
        if (
            syntax === null ||
            syntax.keywordCaseEligible !== true ||
            !isKeywordCaseRole(syntax.syntaxRole)
        ) {
            continue;
        }
        const authorityNodeId = authorityForNode(
            context,
            syntax.directOwnerNodeId
        );
        if (
            authorityNodeId !== null &&
            !context.plan.setKeywordCase(authorityNodeId, leafId)
        ) {
            return false;
        }
    }
    return true;
}
