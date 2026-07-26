import {
    isCanonicalAnalyzedArtifact,
} from "../analysis/artifact";
import type { LeafRange } from "../syntax/leaf-range";
import type { VerbatimTrigger } from "./doc";

export interface DominatingVerbatimClaim {
    readonly ownerNodeId: number;
    readonly leafRange: LeafRange;
    readonly trigger: VerbatimTrigger;
}

export interface DominatingVerbatimClaims {
    readonly claims: readonly DominatingVerbatimClaim[];
    claimForLeaf(leafId: number): DominatingVerbatimClaim | null;
    claimForOwner(ownerNodeId: number): DominatingVerbatimClaim | null;
}

interface CandidateClaim extends DominatingVerbatimClaim {
    readonly priority: number;
    readonly depth: number;
}

const CLAIMS_BY_ANALYSIS = new WeakMap<object, DominatingVerbatimClaims | null>();

function compareClaims(left: CandidateClaim, right: CandidateClaim): number {
    return (
        left.leafRange.start - right.leafRange.start ||
        right.leafRange.end - left.leafRange.end ||
        left.depth - right.depth ||
        right.priority - left.priority ||
        left.ownerNodeId - right.ownerNodeId ||
        (left.trigger.kind === "operator-capability" &&
        right.trigger.kind === "operator-capability"
            ? left.trigger.operatorId.localeCompare(right.trigger.operatorId)
            : left.trigger.kind.localeCompare(right.trigger.kind))
    );
}

function frozenTrigger(trigger: VerbatimTrigger): VerbatimTrigger {
    return Object.freeze({ ...trigger });
}

function candidate(
    ownerNodeId: number,
    leafRange: LeafRange,
    trigger: VerbatimTrigger,
    priority: number,
    depth: number
): CandidateClaim {
    return Object.freeze({
        ownerNodeId,
        leafRange,
        trigger: frozenTrigger(trigger),
        priority,
        depth,
    });
}

export function verbatimTriggersEqual(
    left: VerbatimTrigger,
    right: VerbatimTrigger
): boolean {
    return (
        left.kind === right.kind &&
        left.capabilityId === right.capabilityId &&
        (left.kind !== "operator-capability" ||
            (right.kind === "operator-capability" &&
                left.operatorId === right.operatorId))
    );
}

/**
 * Computes the disjoint outermost ranges that cannot be behavior-formatted.
 * The result is cached per immutable analysis and addressed in O(1) by leaf or
 * owner. An unformatted ancestor dominates all nested claims.
 */
export function dominatingVerbatimClaims(
    analysisValue: unknown
): DominatingVerbatimClaims | null {
    if (!isCanonicalAnalyzedArtifact(analysisValue)) {
        return null;
    }
    const cached = CLAIMS_BY_ANALYSIS.get(analysisValue);
    if (cached !== undefined) {
        return cached;
    }
    const analysis = analysisValue;
    try {
        const nodes = analysis.index.nodes();
        const depthByNodeId = new Int32Array(nodes.length);
        const depthWork: Array<readonly [number, number]> = [[analysis.root.id, 0]];
        while (depthWork.length > 0) {
            const [nodeId, depth] = depthWork.pop()!;
            depthByNodeId[nodeId] = depth;
            const children = analysis.index.childrenOf(nodeId);
            for (let index = children.length - 1; index >= 0; index--) {
                depthWork.push([children[index]!.id, depth + 1]);
            }
        }
        const candidates: CandidateClaim[] = [];
        for (const node of nodes) {
            if (node.kind === "set-payload") {
                candidates.push(
                    candidate(
                        node.id,
                        node.leafRange,
                        {
                            kind: "bounded-payload",
                            capabilityId: "set-command",
                        },
                        2,
                        depthByNodeId[node.id]!
                    )
                );
                continue;
            }
            if (node.kind === "opaque") {
                candidates.push(
                    candidate(
                        node.id,
                        node.leafRange,
                        {
                            kind: "opaque",
                            capabilityId: node.capabilityId,
                        },
                        2,
                        depthByNodeId[node.id]!
                    )
                );
                continue;
            }
            if (node.formatRole === "capability") {
                if (node.capabilityId === null) {
                    CLAIMS_BY_ANALYSIS.set(analysis, null);
                    return null;
                }
                const capability = analysis.index.capabilityForNode(node.id);
                if (capability === null) {
                    CLAIMS_BY_ANALYSIS.set(analysis, null);
                    return null;
                }
                if (capability.state !== "formatted") {
                    candidates.push(
                        candidate(
                            node.id,
                            node.leafRange,
                            {
                                kind: "node-capability",
                                capabilityId: capability.id,
                            },
                            1,
                            depthByNodeId[node.id]!
                        )
                    );
                }
            }
            if (node.kind === "expression") {
                for (const occurrence of analysis.index.operatorOccurrencesOf(
                    node.id
                )) {
                    if (occurrence.capabilityId === null) {
                        continue;
                    }
                    const capability = analysis.index.capability(
                        occurrence.capabilityId
                    );
                    if (capability === null) {
                        CLAIMS_BY_ANALYSIS.set(analysis, null);
                        return null;
                    }
                    if (capability.state !== "formatted") {
                        candidates.push(
                            candidate(
                                node.id,
                                node.leafRange,
                                {
                                    kind: "operator-capability",
                                    capabilityId: capability.id,
                                    operatorId: occurrence.operatorId,
                                },
                                3,
                                depthByNodeId[node.id]!
                            )
                        );
                    }
                }
            }
        }
        candidates.sort(compareClaims);

        const selected: DominatingVerbatimClaim[] = [];
        for (const value of candidates) {
            if (value.leafRange.start === value.leafRange.end) {
                CLAIMS_BY_ANALYSIS.set(analysis, null);
                return null;
            }
            const previous = selected[selected.length - 1];
            if (previous !== undefined) {
                const sameRange =
                    value.leafRange.start === previous.leafRange.start &&
                    value.leafRange.end === previous.leafRange.end;
                if (sameRange) {
                    // Several independently valid reasons may require the same
                    // bytes to remain verbatim (for example CAST node + ::
                    // operator, or parenthesized query + subquery wrapper).
                    // compareClaims() already selects a deterministic strongest
                    // representative; one atomic range emission satisfies all
                    // equivalent preservation requirements.
                    continue;
                }
                if (
                    value.leafRange.start >= previous.leafRange.start &&
                    value.leafRange.end <= previous.leafRange.end
                ) {
                    continue;
                }
                if (value.leafRange.start < previous.leafRange.end) {
                    CLAIMS_BY_ANALYSIS.set(analysis, null);
                    return null;
                }
            }
            selected.push(
                Object.freeze({
                    ownerNodeId: value.ownerNodeId,
                    leafRange: value.leafRange,
                    trigger: value.trigger,
                })
            );
        }

        const frozenClaims = Object.freeze(selected);
        const claimIndexByLeaf = new Int32Array(analysis.leaves.length);
        claimIndexByLeaf.fill(-1);
        const claimByOwner = new Map<number, DominatingVerbatimClaim>();
        for (let claimIndex = 0; claimIndex < frozenClaims.length; claimIndex++) {
            const value = frozenClaims[claimIndex]!;
            if (claimByOwner.has(value.ownerNodeId)) {
                CLAIMS_BY_ANALYSIS.set(analysis, null);
                return null;
            }
            claimByOwner.set(value.ownerNodeId, value);
            for (
                let leafId = value.leafRange.start;
                leafId < value.leafRange.end;
                leafId++
            ) {
                if (claimIndexByLeaf[leafId] !== -1) {
                    CLAIMS_BY_ANALYSIS.set(analysis, null);
                    return null;
                }
                claimIndexByLeaf[leafId] = claimIndex;
            }
        }
        const result: DominatingVerbatimClaims = Object.freeze({
            claims: frozenClaims,
            claimForLeaf(leafId: number): DominatingVerbatimClaim | null {
                if (
                    !Number.isSafeInteger(leafId) ||
                    leafId < 0 ||
                    leafId >= claimIndexByLeaf.length
                ) {
                    return null;
                }
                const index = claimIndexByLeaf[leafId]!;
                return index < 0 ? null : frozenClaims[index]!;
            },
            claimForOwner(ownerNodeId: number): DominatingVerbatimClaim | null {
                if (!Number.isSafeInteger(ownerNodeId) || ownerNodeId < 0) {
                    return null;
                }
                return claimByOwner.get(ownerNodeId) ?? null;
            },
        });
        CLAIMS_BY_ANALYSIS.set(analysis, result);
        return result;
    } catch {
        CLAIMS_BY_ANALYSIS.set(analysis, null);
        return null;
    }
}
