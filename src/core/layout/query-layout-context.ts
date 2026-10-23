import type { StructuralIndex } from "../analysis/types";
import type { SourceLeaf } from "../lexer/token";
import type { ProgramNode, SyntaxNode } from "../syntax/node";
import type { LayoutPlanBuilder, LayoutScopeDecision } from "./plan";
import type { DominatingVerbatimClaims } from "./verbatim-claims";

/** Facts the policies record while registering actions. */
export interface QueryPolicyState {
    /** Whether an indent or align scope was registered; trivia layout needs one. */
    hasIndentationScope: boolean;
    /** Whether trailing comma style fell back to a leading comma (LAYOUT_COMMA_FALLBACK). */
    commaFallback: boolean;
}

export interface LayoutAnalysisView {
    readonly leafCount: number;
    readonly root: ProgramNode;
    readonly index: StructuralIndex;
    leafKind(leafId: number): SourceLeaf["kind"] | null;
    leafChannel(leafId: number): SourceLeaf["channel"] | null;
}

/** The registration surface policies use; finishing the plan stays with the caller. */
export type QueryPlanRegistration = Pick<
    LayoutPlanBuilder,
    "options" | "setKeywordCase" | "replaceGap" | "wrapRange"
>;

export interface QueryLayoutContext {
    readonly analysis: LayoutAnalysisView;
    readonly plan: QueryPlanRegistration;
    readonly claims: DominatingVerbatimClaims;
    readonly authorityByNodeId: Int32Array;
    readonly canonicalGapEnds: Int32Array;
    readonly registeredGapEnds: Int32Array;
    readonly scopeDeltas: Int32Array;
    readonly commentPrefix: Int32Array;
    readonly verbatimPrefix: Int32Array;
    readonly state: QueryPolicyState;
}

function buildRangePrefixes(
    leafCount: number,
    commentLeafIds: readonly number[],
    claims: DominatingVerbatimClaims
): Readonly<{
    commentPrefix: Int32Array;
    verbatimPrefix: Int32Array;
}> | null {
    const commentMarks = new Int32Array(leafCount + 1);
    const verbatimDeltas = new Int32Array(leafCount + 1);
    for (const leafId of commentLeafIds) {
        if (!Number.isSafeInteger(leafId) || leafId < 0 || leafId >= leafCount) {
            return null;
        }
        commentMarks[leafId + 1] = commentMarks[leafId + 1]! + 1;
    }
    for (const claim of claims.claims) {
        verbatimDeltas[claim.leafRange.start] =
            verbatimDeltas[claim.leafRange.start]! + 1;
        verbatimDeltas[claim.leafRange.end] =
            verbatimDeltas[claim.leafRange.end]! - 1;
    }
    const commentPrefix = new Int32Array(leafCount + 1);
    const verbatimPrefix = new Int32Array(leafCount + 1);
    let activeClaims = 0;
    for (let boundary = 1; boundary <= leafCount; boundary++) {
        commentPrefix[boundary] =
            commentPrefix[boundary - 1]! + commentMarks[boundary]!;
        activeClaims += verbatimDeltas[boundary - 1]!;
        verbatimPrefix[boundary] =
            verbatimPrefix[boundary - 1]! + (activeClaims > 0 ? 1 : 0);
    }
    return Object.freeze({ commentPrefix, verbatimPrefix });
}

function buildAuthorityProjection(
    root: ProgramNode,
    index: StructuralIndex,
    claims: DominatingVerbatimClaims
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
        let authority = inheritedAuthority;
        const blocked = inheritedBlocked ||
            claims.claimForOwner(node.id) !== null;
        if (blocked) {
            authority = -1;
        } else if (node.formatRole === "capability") {
            const capability = index.capabilityForNode(node.id);
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
    const authorityByNodeId = buildAuthorityProjection(
        artifact.root,
        artifact.index,
        claims
    );
    if (authorityByNodeId === null) {
        return null;
    }
    const bindings = artifact.index.commentBindings();
    const prefixes = buildRangePrefixes(
        leaves.length,
        bindings.map((binding) => binding.commentLeafId),
        claims
    );
    if (prefixes === null) {
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
    return Object.freeze({
        analysis,
        plan: builder,
        claims,
        authorityByNodeId,
        canonicalGapEnds: new Int32Array(leaves.length + 1).fill(-1),
        registeredGapEnds: new Int32Array(leaves.length + 1).fill(-1),
        scopeDeltas: new Int32Array(leaves.length + 1),
        commentPrefix: prefixes.commentPrefix,
        verbatimPrefix: prefixes.verbatimPrefix,
        state: { hasIndentationScope: false, commaFallback: false },
    });
}

function rangeCount(
    prefix: Int32Array,
    startLeafId: number,
    endLeafId: number
): number | null {
    if (
        !Number.isSafeInteger(startLeafId) ||
        !Number.isSafeInteger(endLeafId) ||
        startLeafId < 0 ||
        endLeafId < startLeafId ||
        endLeafId >= prefix.length
    ) {
        return null;
    }
    return prefix[endLeafId]! - prefix[startLeafId]!;
}

export function rangeHasComment(
    context: QueryLayoutContext,
    startLeafId: number,
    endLeafId: number
): boolean | null {
    const count = rangeCount(context.commentPrefix, startLeafId, endLeafId);
    return count === null ? null : count > 0;
}

export function rangeHasVerbatimClaim(
    context: QueryLayoutContext,
    startLeafId: number,
    endLeafId: number
): boolean | null {
    const count = rangeCount(context.verbatimPrefix, startLeafId, endLeafId);
    return count === null ? null : count > 0;
}

export function authorityForNode(
    context: QueryLayoutContext,
    nodeId: number
): number | null {
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
        context.state.hasIndentationScope = true;
        context.scopeDeltas[startLeafId] =
            context.scopeDeltas[startLeafId]! + 1;
        context.scopeDeltas[endLeafId] =
            context.scopeDeltas[endLeafId]! - 1;
    }
    return success;
}
