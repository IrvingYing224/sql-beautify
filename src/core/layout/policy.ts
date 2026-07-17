import { isKeywordCaseRole } from "../syntax/contextual-fact-contract";
import type { ClauseNode, QueryNode } from "../syntax/node";
import type { LayoutPlanFailure, LayoutPlanResult } from "./plan";
import { createLayoutPlanBuilder } from "./plan";
import { dominatingVerbatimClaims } from "./verbatim-claims";

function failure(message: string): LayoutPlanFailure {
    return Object.freeze({
        ok: false,
        code: "LAYOUT_PLAN_PROVENANCE",
        message,
    });
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

function selectClauseOf(
    query: QueryNode,
    clauses: readonly ClauseNode[]
): ClauseNode | null {
    if (query.queryKind !== "select") {
        return null;
    }
    let select: ClauseNode | null = null;
    for (const clause of clauses) {
        if (clause.clauseKind === "from") {
            return null;
        }
        if (clause.clauseKind === "select") {
            if (select !== null) {
                return null;
            }
            select = clause;
        }
    }
    return select;
}

/**
 * Wave 3B policy: identity everywhere except the proven Hive no-FROM SELECT
 * capability. It consumes typed nodes, capability state and contextual facts.
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

    const authorityStarts = new Int32Array(analysis.leaves.length + 1);
    const authorityEnds = new Int32Array(analysis.leaves.length + 1);
    authorityStarts.fill(-1);
    authorityEnds.fill(-1);
    try {
        for (const query of analysis.index.queries()) {
            const capability = analysis.index.capabilityForNode(query.id);
            if (
                query.queryKind !== "select" ||
                query.capabilityId !== "select-without-from" ||
                capability?.id !== query.capabilityId ||
                capability.state !== "formatted" ||
                claims.claimForLeaf(query.leafRange.start) !== null
            ) {
                continue;
            }
            const clauses = analysis.index.clausesOfQuery(query.id);
            const select = selectClauseOf(query, clauses);
            if (select === null || select.children.length !== 1) {
                return failure(
                    `Formatted no-FROM query ${query.id} lacks one SELECT body`
                );
            }
            if (
                authorityStarts[query.leafRange.start] !== -1 ||
                authorityEnds[query.leafRange.end] !== -1
            ) {
                return failure(
                    "Formatted authority ranges have ambiguous boundaries"
                );
            }
            authorityStarts[query.leafRange.start] = query.id;
            authorityEnds[query.leafRange.end] = query.id;

            const gapStart = select.headLeafRange.end;
            const gapEnd = select.children[0]!.leafRange.start;
            let replaceable = gapEnd >= gapStart;
            for (let leafId = gapStart; leafId < gapEnd; leafId++) {
                const leaf = analysis.leaves[leafId];
                if (
                    leaf === undefined ||
                    leaf.channel !== "trivia" ||
                    (leaf.kind !== "whitespace" && leaf.kind !== "newline")
                ) {
                    replaceable = false;
                    break;
                }
            }
            if (
                replaceable &&
                !builder.replaceGap(query.id, gapStart, gapEnd, {
                    kind: "space",
                    columns: 1,
                })
            ) {
                return builder.finish();
            }
        }

        const activeAuthorities: number[] = [];
        for (let leafId = 0; leafId < analysis.leaves.length; leafId++) {
            const endingAuthority = authorityEnds[leafId]!;
            if (endingAuthority !== -1) {
                if (
                    activeAuthorities[activeAuthorities.length - 1] !==
                    endingAuthority
                ) {
                    return failure(
                        "Formatted authority ranges are not properly nested"
                    );
                }
                activeAuthorities.pop();
            }
            const startingAuthority = authorityStarts[leafId]!;
            if (startingAuthority !== -1) {
                activeAuthorities.push(startingAuthority);
            }
            const authorityNodeId =
                activeAuthorities[activeAuthorities.length - 1];
            if (
                authorityNodeId === undefined ||
                claims.claimForLeaf(leafId) !== null
            ) {
                continue;
            }
            const syntax = analysis.index.leafContext(leafId).syntax;
            if (
                syntax !== null &&
                syntax.keywordCaseEligible === true &&
                isKeywordCaseRole(syntax.syntaxRole) &&
                !builder.setKeywordCase(authorityNodeId, leafId)
            ) {
                return builder.finish();
            }
        }
        const finalAuthority = authorityEnds[analysis.leaves.length]!;
        if (finalAuthority !== -1) {
            if (
                activeAuthorities[activeAuthorities.length - 1] !==
                finalAuthority
            ) {
                return failure("Formatted authority ranges are not balanced");
            }
            activeAuthorities.pop();
        }
        if (activeAuthorities.length !== 0) {
            return failure("Formatted authority ranges are not balanced");
        }
        return builder.finish();
    } catch {
        return failure("Layout policy inspection failed");
    }
}
