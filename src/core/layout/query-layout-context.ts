import type { StructuralIndex } from "../analysis/types";
import type { CanonicalFormatOptions } from "../config/options";
import type { SourceLeaf } from "../lexer/token";
import type { ProgramNode, SyntaxNode } from "../syntax/node";
import type {
    LayoutGapDecision,
    LayoutPlanBuilder,
    LayoutPolicyStatistics,
    LayoutScopeDecision,
} from "./plan";
import type { DominatingVerbatimClaims } from "./verbatim-claims";

export interface MutableQueryPolicyStatistics {
    nodeVisitCount: number;
    leafVisitCount: number;
    directLookupCount: number;
    scopeRangeCount: number;
}

export interface LayoutAnalysisView {
    readonly leafCount: number;
    readonly root: ProgramNode;
    readonly index: StructuralIndex;
    leafKind(leafId: number): SourceLeaf["kind"] | null;
    leafChannel(leafId: number): SourceLeaf["channel"] | null;
}

export interface QueryPlanRegistration {
    readonly options: CanonicalFormatOptions;
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
}

export interface QueryLayoutContext {
    readonly analysis: LayoutAnalysisView;
    readonly plan: QueryPlanRegistration;
    readonly claims: DominatingVerbatimClaims;
    readonly authorityByNodeId: Int32Array;
    readonly canonicalGapEnds: Int32Array;
    readonly scopeDeltas: Int32Array;
    readonly statistics: MutableQueryPolicyStatistics;
}

function buildAuthorityProjection(
    root: ProgramNode,
    index: StructuralIndex,
    claims: DominatingVerbatimClaims,
    statistics: MutableQueryPolicyStatistics
): Int32Array | null {
    const nodes = index.nodes();
    const authorityByNodeId = new Int32Array(nodes.length);
    authorityByNodeId.fill(-1);
    const work: Array<readonly [SyntaxNode, number, boolean]> = [
        [root, -1, false],
    ];
    let visited = 0;
    while (work.length > 0) {
        const [node, inheritedAuthority, inheritedBlocked] = work.pop()!;
        statistics.nodeVisitCount += 1;
        let authority = inheritedAuthority;
        const blocked = inheritedBlocked ||
            claims.claimForOwner(node.id) !== null;
        statistics.directLookupCount += 1;
        if (blocked) {
            authority = -1;
        } else if (node.formatRole === "capability") {
            const capability = index.capabilityForNode(node.id);
            statistics.directLookupCount += 1;
            if (capability === null) {
                return null;
            }
            if (capability.state === "formatted") {
                authority = node.id;
            }
        }
        authorityByNodeId[node.id] = authority;
        visited += 1;
        const children = index.childrenOf(node.id);
        statistics.directLookupCount += 1;
        for (let childIndex = children.length - 1; childIndex >= 0; childIndex--) {
            work.push([children[childIndex]!, authority, blocked]);
        }
    }
    return visited === nodes.length ? authorityByNodeId : null;
}

export function createQueryLayoutContext(
    builder: LayoutPlanBuilder,
    claims: DominatingVerbatimClaims
): QueryLayoutContext | null {
    const artifact = builder.analysis;
    const leaves = artifact.leaves;
    const statistics: MutableQueryPolicyStatistics = {
        nodeVisitCount: 0,
        leafVisitCount: 0,
        directLookupCount: 0,
        scopeRangeCount: 0,
    };
    const authorityByNodeId = buildAuthorityProjection(
        artifact.root,
        artifact.index,
        claims,
        statistics
    );
    if (authorityByNodeId === null) {
        return null;
    }
    const analysis: LayoutAnalysisView = Object.freeze({
        leafCount: leaves.length,
        root: artifact.root,
        index: artifact.index,
        leafKind(leafId: number): SourceLeaf["kind"] | null {
            return Number.isSafeInteger(leafId) && leafId >= 0
                ? leaves[leafId]?.kind ?? null
                : null;
        },
        leafChannel(leafId: number): SourceLeaf["channel"] | null {
            return Number.isSafeInteger(leafId) && leafId >= 0
                ? leaves[leafId]?.channel ?? null
                : null;
        },
    });
    const plan: QueryPlanRegistration = Object.freeze({
        options: builder.options,
        setKeywordCase: (
            authorityNodeId: number,
            leafId: number
        ): boolean => builder.setKeywordCase(authorityNodeId, leafId),
        replaceGap: (
            authorityNodeId: number,
            startLeafId: number,
            endLeafId: number,
            decision: LayoutGapDecision
        ): boolean => builder.replaceGap(
            authorityNodeId,
            startLeafId,
            endLeafId,
            decision
        ),
        wrapRange: (
            authorityNodeId: number,
            startLeafId: number,
            endLeafId: number,
            decision: LayoutScopeDecision
        ): boolean => builder.wrapRange(
            authorityNodeId,
            startLeafId,
            endLeafId,
            decision
        ),
    });
    return Object.freeze({
        analysis,
        plan,
        claims,
        authorityByNodeId,
        canonicalGapEnds: new Int32Array(leaves.length + 1).fill(-1),
        scopeDeltas: new Int32Array(leaves.length + 1),
        statistics,
    });
}

export function authorityForNode(
    context: QueryLayoutContext,
    nodeId: number
): number | null {
    context.statistics.directLookupCount += 1;
    const encoded = context.authorityByNodeId[nodeId];
    return encoded === undefined || encoded < 0 ? null : encoded;
}

export function wrapLayoutRange(
    context: QueryLayoutContext,
    authorityNodeId: number,
    startLeafId: number,
    endLeafId: number,
    decision: LayoutScopeDecision
): boolean {
    const success = context.plan.wrapRange(
        authorityNodeId,
        startLeafId,
        endLeafId,
        decision
    );
    if (
        success &&
        (decision.kind === "indent" || decision.kind === "align")
    ) {
        context.statistics.scopeRangeCount += 1;
        context.scopeDeltas[startLeafId] =
            context.scopeDeltas[startLeafId]! + 1;
        context.scopeDeltas[endLeafId] =
            context.scopeDeltas[endLeafId]! - 1;
    }
    return success;
}

export function queryPolicyStatistics(
    context: QueryLayoutContext
): LayoutPolicyStatistics {
    return Object.freeze({
        nodeVisitCount: context.statistics.nodeVisitCount,
        leafVisitCount: context.statistics.leafVisitCount,
        directLookupCount: context.statistics.directLookupCount,
    });
}
