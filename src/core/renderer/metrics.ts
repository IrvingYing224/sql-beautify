import {
    canonicalLayoutResourceBudget,
    isCanonicalLayoutArtifact,
} from "../layout/artifact";
import type { LayoutArtifact } from "../layout/artifact";
import type { LayoutDoc } from "../layout/doc";
import { canonicalLayoutDocProof } from "../layout/doc-factory";
import { measureDisplayText } from "./display-width";
import type {
    FlatLayoutSummary,
    LayoutMetricsFailure,
    LayoutMetricsFailureCode,
    LayoutMetricsResult,
} from "./types";

interface MetricWorkItem {
    readonly doc: LayoutDoc;
    readonly exit: boolean;
}

function failure(
    code: LayoutMetricsFailureCode,
    message: string
): LayoutMetricsFailure {
    return Object.freeze({ ok: false, code, message });
}

function frozenSummary(
    value: FlatLayoutSummary
): FlatLayoutSummary {
    return Object.freeze(value);
}

function noSourceSummary(flatWidth: number | null): FlatLayoutSummary {
    return frozenSummary({
        flatWidth,
        hasSourceEmission: false,
        endsWithUnterminatedLineComment: false,
        containsHardLine: false,
        containsMultilineSource: false,
        containsTab: false,
        containsContextualWidth: false,
        containsLineSuffix: false,
    });
}

function sourceText(
    artifact: LayoutArtifact,
    doc: Extract<LayoutDoc, { readonly kind: "verbatim" }>
): string | null {
    const first = artifact.analysis.leaves[doc.leafRange.start];
    const last = artifact.analysis.leaves[doc.leafRange.end - 1];
    if (
        first === undefined ||
        last === undefined ||
        first.span.start < 0 ||
        last.span.end < first.span.start ||
        last.span.end > artifact.analysis.source.length
    ) {
        return null;
    }
    return artifact.analysis.source.slice(first.span.start, last.span.end);
}

function sourceSummary(
    raw: string,
    unterminatedLineComment: boolean
): FlatLayoutSummary | null {
    const measured = measureDisplayText(raw, 0);
    if (measured === null) {
        return null;
    }
    return frozenSummary({
        flatWidth:
            measured.containsLineBreak || measured.containsTab
                ? null
                : measured.endColumn,
        hasSourceEmission: true,
        endsWithUnterminatedLineComment:
            unterminatedLineComment && !measured.endsWithLineBreak,
        containsHardLine: false,
        containsMultilineSource: measured.containsLineBreak,
        containsTab: measured.containsTab,
        containsContextualWidth: false,
        containsLineSuffix: false,
    });
}

function combineConcat(
    parts: readonly LayoutDoc[],
    summaries: WeakMap<object, FlatLayoutSummary>
): FlatLayoutSummary | null {
    let flatWidth: number | null = 0;
    let hasSourceEmission = false;
    let pendingLineComment = false;
    let containsHardLine = false;
    let containsMultilineSource = false;
    let containsTab = false;
    let containsContextualWidth = false;
    let containsLineSuffix = false;

    for (const part of parts) {
        const summary = summaries.get(part);
        if (summary === undefined) {
            return null;
        }
        if (pendingLineComment && summary.hasSourceEmission) {
            flatWidth = null;
        }
        if (flatWidth !== null) {
            if (
                summary.flatWidth === null ||
                flatWidth > Number.MAX_SAFE_INTEGER - summary.flatWidth
            ) {
                flatWidth = null;
            } else {
                flatWidth += summary.flatWidth;
            }
        }
        if (summary.containsHardLine) {
            pendingLineComment = false;
        }
        if (summary.hasSourceEmission) {
            hasSourceEmission = true;
            pendingLineComment = summary.endsWithUnterminatedLineComment;
        }
        containsHardLine = containsHardLine || summary.containsHardLine;
        containsMultilineSource =
            containsMultilineSource || summary.containsMultilineSource;
        containsTab = containsTab || summary.containsTab;
        containsContextualWidth =
            containsContextualWidth || summary.containsContextualWidth;
        containsLineSuffix = containsLineSuffix || summary.containsLineSuffix;
    }
    return frozenSummary({
        flatWidth,
        hasSourceEmission,
        endsWithUnterminatedLineComment: pendingLineComment,
        containsHardLine,
        containsMultilineSource,
        containsTab,
        containsContextualWidth,
        containsLineSuffix,
    });
}

function childOf(doc: LayoutDoc): LayoutDoc | null {
    return doc.kind === "indent" ||
        doc.kind === "align" ||
        doc.kind === "group"
        ? doc.content
        : null;
}

/** Computes context-independent flat summaries with one iterative post-order pass. */
export function measureLayoutArtifact(value: unknown): LayoutMetricsResult {
    if (!isCanonicalLayoutArtifact(value)) {
        return failure(
            "METRICS_ARTIFACT_PROVENANCE",
            "Layout metrics require an exact canonical artifact"
        );
    }
    const artifact = value;
    const budget = canonicalLayoutResourceBudget(artifact);
    if (budget === null) {
        return failure(
            "METRICS_ARTIFACT_PROVENANCE",
            "Canonical artifact budget proof is missing"
        );
    }

    const summaries = new WeakMap<object, FlatLayoutSummary>();
    const work: MetricWorkItem[] = [{ doc: artifact.root, exit: false }];
    let docNodeCount = 0;
    try {
        while (work.length > 0) {
            const item = work.pop()!;
            const doc = item.doc;
            if (!item.exit) {
                const proof = canonicalLayoutDocProof(doc);
                if (proof === null || proof.analysis !== artifact.analysis) {
                    return failure(
                        "METRICS_DOC_PROVENANCE",
                        "Layout metrics encountered a foreign document node"
                    );
                }
                docNodeCount += 1;
                if (docNodeCount > budget.maxDocNodes) {
                    return failure(
                        "METRICS_OVERFLOW",
                        "Layout metrics exceeded the document-node budget"
                    );
                }
                work.push({ doc, exit: true });
                if (doc.kind === "concat") {
                    for (let index = doc.parts.length - 1; index >= 0; index--) {
                        work.push({ doc: doc.parts[index]!, exit: false });
                    }
                } else {
                    const child = childOf(doc);
                    if (child !== null) {
                        work.push({ doc: child, exit: false });
                    }
                }
                continue;
            }

            let summary: FlatLayoutSummary | null;
            switch (doc.kind) {
                case "leaf": {
                    const leaf = artifact.analysis.leaves[doc.leafId];
                    if (leaf === undefined || leaf.id !== doc.leafId) {
                        return failure(
                            "METRICS_SOURCE_RANGE",
                            `Unknown source leaf ${String(doc.leafId)}`
                        );
                    }
                    summary = sourceSummary(
                        leaf.raw,
                        leaf.kind === "line-comment"
                    );
                    break;
                }
                case "verbatim": {
                    const raw = sourceText(artifact, doc);
                    if (raw === null) {
                        return failure(
                            "METRICS_SOURCE_RANGE",
                            `Invalid verbatim range for node ${String(doc.ownerNodeId)}`
                        );
                    }
                    const finalLeaf =
                        artifact.analysis.leaves[doc.leafRange.end - 1];
                    summary = sourceSummary(
                        raw,
                        finalLeaf?.kind === "line-comment"
                    );
                    break;
                }
                case "space":
                    summary = noSourceSummary(doc.columns);
                    break;
                case "line":
                    summary = doc.mode === "hard"
                        ? frozenSummary({
                              ...noSourceSummary(null),
                              containsHardLine: true,
                          })
                        : noSourceSummary(doc.flat === "space" ? 1 : 0);
                    break;
                case "concat":
                    summary = combineConcat(doc.parts, summaries);
                    break;
                case "indent": {
                    const child = summaries.get(doc.content);
                    summary = child ?? null;
                    break;
                }
                case "align": {
                    const child = summaries.get(doc.content);
                    summary = child === undefined
                        ? null
                        : frozenSummary({
                              ...child,
                              flatWidth: null,
                              containsContextualWidth: true,
                          });
                    break;
                }
                case "pad-to-column":
                    summary = frozenSummary({
                        ...noSourceSummary(null),
                        containsContextualWidth: true,
                    });
                    break;
                case "group": {
                    const child = summaries.get(doc.content);
                    summary = child === undefined
                        ? null
                        : doc.mode === "break"
                          ? frozenSummary({ ...child, flatWidth: null })
                          : child;
                    break;
                }
                case "line-suffix": {
                    const leaf = artifact.analysis.leaves[doc.commentLeafId];
                    if (leaf === undefined) {
                        return failure(
                            "METRICS_SOURCE_RANGE",
                            `Unknown suffix leaf ${String(doc.commentLeafId)}`
                        );
                    }
                    const source = sourceSummary(
                        leaf.raw,
                        leaf.kind === "line-comment"
                    );
                    summary = source === null
                        ? null
                        : frozenSummary({
                              ...source,
                              flatWidth: null,
                              containsContextualWidth: true,
                              containsLineSuffix: true,
                          });
                    break;
                }
            }
            if (summary === null) {
                return failure(
                    "METRICS_OVERFLOW",
                    "Layout metrics could not represent a source width"
                );
            }
            summaries.set(doc, summary);
        }
    } catch {
        return failure(
            "METRICS_INTERNAL",
            "Layout metrics inspection failed"
        );
    }

    const rootSummary = summaries.get(artifact.root);
    if (rootSummary === undefined) {
        return failure("METRICS_INTERNAL", "Layout root summary is missing");
    }
    const metrics = Object.freeze({
        summary: rootSummary,
        docNodeCount,
        summaryOf(doc: LayoutDoc): FlatLayoutSummary | null {
            return summaries.get(doc) ?? null;
        },
    });
    return Object.freeze({ ok: true, metrics });
}
