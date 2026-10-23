import { isKeywordCaseRole } from "../syntax/contextual-fact-contract";
import { authorityForNode } from "./query-layout-context";
import type { QueryLayoutContext } from "./query-layout-context";

export function applyKeywordCaseLayout(context: QueryLayoutContext): boolean {
    for (let leafId = 0; leafId < context.analysis.leafCount; leafId++) {
        if (context.claims.claimForLeaf(leafId) !== null) {
            continue;
        }
        const syntax = context.analysis.index.leafContext(leafId).syntax;
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
