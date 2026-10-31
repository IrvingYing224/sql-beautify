import type { LayoutArtifact } from "./artifact";
import { createLayoutArtifact } from "./artifact";
import type { LayoutDoc } from "./doc";
import { createLayoutDocFactory } from "./doc-factory";
import type { LayoutGapAction, LayoutPlan, LayoutScopeAction } from "./plan";

export type LayoutCompileFailureCode =
    | "LAYOUT_COMPILE_ACTION"
    | "LAYOUT_COMPILE_DOC"
    | "LAYOUT_COMPILE_INTERNAL";

export interface LayoutCompileFailure {
    readonly ok: false;
    readonly code: LayoutCompileFailureCode;
    readonly message: string;
}

export interface LayoutCompileSuccess {
    readonly ok: true;
    readonly artifact: LayoutArtifact;
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

/** One source-order gap cursor; invalid plans never expose partial artifacts. */
export function compileLayoutPlan(plan: LayoutPlan): LayoutCompileResult {
    const factory = createLayoutDocFactory(plan.analysis);
    if (factory === null) {
        return failure(
            "LAYOUT_COMPILE_DOC",
            "Layout compiler could not create an analysis-scoped factory"
        );
    }
    const frames: CompileFrame[] = [{ action: null, parts: [] }];
    let scopeActionVisitCount = 0;
    let cursor = 0;
    let boundaryPending = true;
    const hasScopes = plan.scopeActionCount > 0;
    try {
        const appendDoc = (doc: LayoutDoc): void => {
            frames[frames.length - 1]!.parts.push(doc);
        };
        const appendGap = (gap: LayoutGapAction): LayoutCompileFailure | null => {
            const decision = gap.decision;
            const doc = decision.kind === "space"
                ? factory.space(decision.columns)
                : decision.kind === "hard-line"
                  ? factory.hardLine()
                  : decision.kind === "soft-line"
                    ? factory.softLine(decision.flat)
                    : decision.kind === "pad-to-column"
                      ? factory.padToColumn(decision.targetColumn)
                      : factory.empty();
            if (doc === null) {
                return failure(
                    "LAYOUT_COMPILE_DOC",
                    `Gap action at leaf ${gap.startLeafId} could not create a document node`
                );
            }
            appendDoc(doc);
            return null;
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
                    : action.decision.kind === "hang"
                      ? factory.hang(content)
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
            const atBoundary = boundaryPending;
            const gap = atBoundary ? plan.gapActions[cursor] : null;
            if (
                gap !== null &&
                gap !== undefined &&
                (gap.startLeafId !== cursor ||
                    gap.endLeafId < cursor ||
                    gap.endLeafId > plan.analysis.leaves.length)
            ) {
                return failure(
                    "LAYOUT_COMPILE_ACTION",
                    `Invalid gap action at leaf ${cursor}`
                );
            }
            if (atBoundary && hasScopes) {
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
            }
            // A gap with no source whitespace goes between the scopes that end here and the ones
            // that start here, where it would sit if the source had whitespace (K6).
            if (gap !== null && gap !== undefined && gap.endLeafId === cursor) {
                const appended = appendGap(gap);
                if (appended !== null) {
                    return appended;
                }
            }
            if (atBoundary && hasScopes) {
                const startingScopes = plan.scopeStarts[cursor];
                if (startingScopes !== null && startingScopes !== undefined) {
                    for (const scope of startingScopes) {
                        scopeActionVisitCount += 1;
                        frames.push({ action: scope, parts: [] });
                    }
                }
            }
            if (gap !== null && gap !== undefined) {
                if (gap.endLeafId > cursor) {
                    const appended = appendGap(gap);
                    if (appended !== null) {
                        return appended;
                    }
                    cursor = gap.endLeafId;
                    boundaryPending = true;
                    continue;
                }
                boundaryPending = false;
            }

            if (cursor === plan.analysis.leaves.length) {
                break;
            }
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
            cursor += 1;
            boundaryPending = true;
        }
        if (
            scopeActionVisitCount !==
            plan.scopeActionCount * 2
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
        const root = factory.concat(frames[0]!.parts);
        if (root === null) {
            return failure(
                "LAYOUT_COMPILE_DOC",
                "Layout compiler could not assemble the canonical document graph"
            );
        }
        return Object.freeze({
            ok: true,
            artifact: createLayoutArtifact(plan.analysis, root, plan.options, plan.baseIndentLeafId),
        });
    } catch {
        return failure(
            "LAYOUT_COMPILE_INTERNAL",
            "Layout compiler inspection failed"
        );
    }
}
