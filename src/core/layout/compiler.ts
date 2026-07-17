import type { LayoutArtifact } from "./artifact";
import { createLayoutArtifact } from "./artifact";
import type { LayoutDoc } from "./doc";
import { createLayoutDocFactory } from "./doc-factory";
import type { LayoutPlan, LayoutScopeAction } from "./plan";
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
    readonly scopeActionVisitCount: number;
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

interface CompileFrame {
    readonly action: LayoutScopeAction | null;
    readonly parts: LayoutDoc[];
}

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
    const frames: CompileFrame[] = [{ action: null, parts: [] }];
    let leafVisitCount = 0;
    let leafEmissionCount = 0;
    let directLookupCount = 0;
    let scopeActionVisitCount = 0;
    let cursor = 0;
    let boundaryPending = true;
    let docPartCount = 0;
    const hasScopes = plan.statistics.scopeActionCount > 0;
    try {
        const appendDoc = (doc: LayoutDoc): void => {
            frames[frames.length - 1]!.parts.push(doc);
            docPartCount += 1;
        };
        const closeScope = (action: LayoutScopeAction): LayoutCompileFailure | null => {
            const frame = frames[frames.length - 1];
            if (frame === undefined || frame.action?.id !== action.id) {
                return failure(
                    "LAYOUT_COMPILE_ACTION",
                    `Scope ${action.id} does not close in nesting order`
                );
            }
            const content = factory.concat(frame.parts);
            if (content === null) {
                return failure(
                    "LAYOUT_COMPILE_DOC",
                    `Scope ${action.id} content could not be assembled`
                );
            }
            const wrapped = action.decision.kind === "indent"
                ? factory.indent(action.decision.levels, content)
                : action.decision.kind === "align"
                  ? factory.align(action.decision.columns, content)
                  : action.decision.kind === "auto-group"
                    ? factory.autoGroup(
                          action.decision.maxFlatWidth,
                          content
                      )
                    : factory.group(action.decision.mode, content);
            if (wrapped === null) {
                return failure(
                    "LAYOUT_COMPILE_DOC",
                    `Scope ${action.id} wrapper could not be compiled`
                );
            }
            frames.pop();
            appendDoc(wrapped);
            return null;
        };

        while (cursor <= plan.analysis.leaves.length) {
            if (boundaryPending && hasScopes) {
                directLookupCount += 2;
                const endingScopes = plan.scopeEnds[cursor];
                if (endingScopes !== null && endingScopes !== undefined) {
                    for (const scope of endingScopes) {
                        scopeActionVisitCount += 1;
                        const closed = closeScope(scope);
                        if (closed !== null) {
                            return closed;
                        }
                    }
                }
                const startingScopes = plan.scopeStarts[cursor];
                if (startingScopes !== null && startingScopes !== undefined) {
                    for (const scope of startingScopes) {
                        scopeActionVisitCount += 1;
                        frames.push({ action: scope, parts: [] });
                    }
                }
            }
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
                appendDoc(doc);
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
                appendDoc(doc);
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
            appendDoc(doc);
            leafVisitCount += 1;
            leafEmissionCount += 1;
            cursor += 1;
            boundaryPending = true;
        }
        if (
            scopeActionVisitCount !==
            plan.statistics.scopeActionCount * 2
        ) {
            return failure(
                "LAYOUT_COMPILE_ACTION",
                "Layout compiler did not visit every scope start and end exactly once"
            );
        }
        if (frames.length !== 1) {
            return failure(
                "LAYOUT_COMPILE_ACTION",
                "Layout compiler finished with unclosed scopes"
            );
        }
        if (docPartCount > plan.budget.maxDocNodes) {
            return failure(
                "LAYOUT_COMPILE_RESOURCE",
                "Layout compiler exceeded the document-node budget"
            );
        }
        const root = factory.concat(frames[0]!.parts);
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
            const detail = created.invariantFailures[0];
            return failure(
                "LAYOUT_COMPILE_ARTIFACT",
                `${created.code}: ${created.message}` +
                    (detail === undefined
                        ? ""
                        : ` (${detail.code}: ${detail.message})`)
            );
        }
        const statistics = Object.freeze({
            leafVisitCount,
            leafEmissionCount,
            directLookupCount,
            docPartCount,
            scopeActionVisitCount,
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
