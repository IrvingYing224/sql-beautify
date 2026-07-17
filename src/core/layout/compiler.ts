import type { LayoutArtifact } from "./artifact";
import { createLayoutArtifact } from "./artifact";
import type { LayoutDoc } from "./doc";
import { createLayoutDocFactory } from "./doc-factory";
import type { LayoutPlan } from "./plan";
import { isCanonicalLayoutPlan } from "./plan";

export type LayoutCompileFailureCode =
    | "LAYOUT_COMPILE_PLAN_PROVENANCE"
    | "LAYOUT_COMPILE_ACTION"
    | "LAYOUT_COMPILE_DOC"
    | "LAYOUT_COMPILE_ARTIFACT"
    | "LAYOUT_COMPILE_RESOURCE"
    | "LAYOUT_COMPILE_INTERNAL";

export interface LayoutCompileStatistics {
    readonly leafVisitCount: number;
    readonly leafEmissionCount: number;
    readonly directLookupCount: number;
    readonly docPartCount: number;
}

export interface LayoutCompileFailure {
    readonly ok: false;
    readonly code: LayoutCompileFailureCode;
    readonly message: string;
}

export interface LayoutCompileSuccess {
    readonly ok: true;
    readonly artifact: LayoutArtifact;
    readonly statistics: LayoutCompileStatistics;
}

export type LayoutCompileResult = LayoutCompileSuccess | LayoutCompileFailure;

function failure(
    code: LayoutCompileFailureCode,
    message: string
): LayoutCompileFailure {
    return Object.freeze({ ok: false, code, message });
}

function compileCanonicalPlan(plan: LayoutPlan): LayoutCompileResult {
    const factory = createLayoutDocFactory(plan.analysis);
    if (factory === null) {
        return failure(
            "LAYOUT_COMPILE_DOC",
            "Layout compiler could not create an analysis-scoped factory"
        );
    }
    const parts: LayoutDoc[] = [];
    let leafVisitCount = 0;
    let leafEmissionCount = 0;
    let directLookupCount = 0;
    let cursor = 0;
    let boundaryPending = true;
    try {
        while (cursor <= plan.analysis.leaves.length) {
            directLookupCount += 1;
            const gap = boundaryPending ? plan.gapActions[cursor] : null;
            if (gap !== null && gap !== undefined) {
                if (
                    gap.startLeafId !== cursor ||
                    gap.endLeafId < cursor ||
                    gap.endLeafId > plan.analysis.leaves.length
                ) {
                    return failure(
                        "LAYOUT_COMPILE_ACTION",
                        `Invalid gap action at leaf ${cursor}`
                    );
                }
                const doc = gap.decision.kind === "space"
                    ? factory.space(gap.decision.columns)
                    : gap.decision.kind === "hard-line"
                      ? factory.hardLine()
                      : factory.empty();
                if (doc === null) {
                    return failure(
                        "LAYOUT_COMPILE_DOC",
                        `Gap action at leaf ${cursor} could not create a document node`
                    );
                }
                parts.push(doc);
                leafVisitCount += gap.endLeafId - cursor;
                if (gap.endLeafId > cursor) {
                    cursor = gap.endLeafId;
                    boundaryPending = true;
                    continue;
                }
                boundaryPending = false;
            }

            if (cursor === plan.analysis.leaves.length) {
                break;
            }

            directLookupCount += 1;
            const mode = plan.leafEmissions[cursor];
            const authorityNodeId = plan.leafAuthorityNodeIds[cursor];
            if (
                mode === undefined ||
                mode === "replaced-trivia" ||
                (mode === "keyword-case") !== (authorityNodeId !== null)
            ) {
                return failure(
                    "LAYOUT_COMPILE_ACTION",
                    `Leaf ${cursor} has no canonical monotonic emission action`
                );
            }
            if (mode === "verbatim") {
                const claim = plan.claimStarts[cursor];
                if (claim === null || claim === undefined) {
                    return failure(
                        "LAYOUT_COMPILE_ACTION",
                        `Verbatim-covered leaf ${cursor} is not a range start`
                    );
                }
                const doc = factory.verbatim(claim.ownerNodeId, claim.trigger);
                if (doc === null) {
                    return failure(
                        "LAYOUT_COMPILE_DOC",
                        `Verbatim owner ${claim.ownerNodeId} could not be compiled`
                    );
                }
                parts.push(doc);
                leafVisitCount += claim.leafRange.end - cursor;
                leafEmissionCount += 1;
                cursor = claim.leafRange.end;
                boundaryPending = true;
                continue;
            }

            const doc = mode === "line-suffix"
                ? factory.lineSuffix(cursor, null)
                : factory.leaf(cursor, mode);
            if (doc === null) {
                return failure(
                    "LAYOUT_COMPILE_DOC",
                    `Leaf ${cursor} could not be compiled as ${mode}`
                );
            }
            parts.push(doc);
            leafVisitCount += 1;
            leafEmissionCount += 1;
            cursor += 1;
            boundaryPending = true;
        }
        if (parts.length > plan.budget.maxDocNodes) {
            return failure(
                "LAYOUT_COMPILE_RESOURCE",
                "Layout compiler exceeded the document-node budget"
            );
        }
        const root = factory.concat(parts);
        if (root === null) {
            return failure(
                "LAYOUT_COMPILE_DOC",
                "Layout compiler could not assemble the canonical document graph"
            );
        }
        const created = createLayoutArtifact(
            plan.analysis,
            root,
            plan.options
        );
        if (!created.ok) {
            return failure(
                "LAYOUT_COMPILE_ARTIFACT",
                `${created.code}: ${created.message}`
            );
        }
        const statistics = Object.freeze({
            leafVisitCount,
            leafEmissionCount,
            directLookupCount,
            docPartCount: parts.length,
        });
        return Object.freeze({
            ok: true,
            artifact: created.artifact,
            statistics,
        });
    } catch {
        return failure(
            "LAYOUT_COMPILE_INTERNAL",
            "Layout compiler inspection failed"
        );
    }
}

/** One source-order gap cursor; invalid plans never expose partial artifacts. */
export function compileLayoutPlan(value: unknown): LayoutCompileResult {
    if (!isCanonicalLayoutPlan(value)) {
        return failure(
            "LAYOUT_COMPILE_PLAN_PROVENANCE",
            "Layout compiler requires an exact canonical plan"
        );
    }
    return compileCanonicalPlan(value);
}
