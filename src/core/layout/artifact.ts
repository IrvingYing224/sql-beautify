import {
    isCanonicalAnalyzedArtifact,
} from "../analysis/artifact";
import type { AnalyzedArtifact } from "../analysis/types";
import type { CanonicalFormatOptions } from "../config/options";
import {
    isCanonicalFormatOptions,
} from "../config/resolve-options";
import type { Diagnostic } from "../diagnostics/diagnostic";
import type { LayoutDoc } from "./doc";
import {
    validateLayoutDoc,
} from "./invariants";
import type { LayoutResourceBudget } from "./resource-budget";
import type {
    LayoutInvariantFailure,
    LayoutInvariantSuccess,
} from "./invariants";

export interface LayoutArtifact {
    readonly analysis: AnalyzedArtifact;
    readonly root: LayoutDoc;
    readonly options: CanonicalFormatOptions;
    readonly diagnostics: readonly Diagnostic[];
}

export type LayoutArtifactFailureCode =
    | "LAYOUT_ARTIFACT_ANALYSIS"
    | "LAYOUT_ARTIFACT_OPTIONS"
    | "LAYOUT_ARTIFACT_DIALECT"
    | "LAYOUT_ARTIFACT_DOC";

export interface LayoutArtifactFailure {
    readonly ok: false;
    readonly code: LayoutArtifactFailureCode;
    readonly message: string;
    readonly invariantFailures: readonly LayoutInvariantFailure[];
}

export interface LayoutArtifactSuccess {
    readonly ok: true;
    readonly artifact: LayoutArtifact;
    readonly invariant: LayoutInvariantSuccess;
}

export type CreateLayoutArtifactResult =
    | LayoutArtifactSuccess
    | LayoutArtifactFailure;

interface CanonicalLayoutArtifactProof {
    readonly analysis: AnalyzedArtifact;
    readonly root: LayoutDoc;
    readonly options: CanonicalFormatOptions;
    readonly budget: LayoutResourceBudget;
}

const CANONICAL_LAYOUT_ARTIFACT_PROOFS =
    new WeakMap<object, CanonicalLayoutArtifactProof>();
const LAYOUT_DOCS_BOUND_TO_ARTIFACTS = new WeakSet<object>();
const EMPTY_INVARIANT_FAILURES = Object.freeze(
    []
) as readonly LayoutInvariantFailure[];

function failure(
    code: LayoutArtifactFailureCode,
    message: string,
    invariantFailures: readonly LayoutInvariantFailure[] =
        EMPTY_INVARIANT_FAILURES
): LayoutArtifactFailure {
    return Object.freeze({
        ok: false,
        code,
        message,
        invariantFailures,
    });
}

function claimArtifactGraph(root: LayoutDoc): boolean {
    const work: LayoutDoc[] = [root];
    const graph: LayoutDoc[] = [];
    while (work.length > 0) {
        const doc = work.pop()!;
        if (LAYOUT_DOCS_BOUND_TO_ARTIFACTS.has(doc)) {
            return false;
        }
        graph.push(doc);
        if (doc.kind === "concat") {
            for (const part of doc.parts) {
                work.push(part);
            }
        } else if (
            doc.kind === "indent" ||
            doc.kind === "align" ||
            doc.kind === "group"
        ) {
            work.push(doc.content);
        }
    }
    for (const doc of graph) {
        LAYOUT_DOCS_BOUND_TO_ARTIFACTS.add(doc);
    }
    return true;
}

/**
 * Binds exact analysis, doc, options and diagnostic provenance. No partial
 * artifact is returned when any proof or ownership invariant fails.
 */
export function createLayoutArtifact(
    analysisValue: unknown,
    rootValue: unknown,
    optionsValue: unknown
): CreateLayoutArtifactResult {
    if (!isCanonicalAnalyzedArtifact(analysisValue)) {
        return failure(
            "LAYOUT_ARTIFACT_ANALYSIS",
            "Layout artifact requires an exact canonical analyzed artifact"
        );
    }
    if (!isCanonicalFormatOptions(optionsValue)) {
        return failure(
            "LAYOUT_ARTIFACT_OPTIONS",
            "Layout artifact requires canonical resolved formatter options"
        );
    }
    if (optionsValue.dialect !== analysisValue.dialect) {
        return failure(
            "LAYOUT_ARTIFACT_DIALECT",
            "Layout options dialect must match analysis dialect"
        );
    }

    const invariant = validateLayoutDoc(analysisValue, rootValue);
    if (!invariant.ok) {
        return failure(
            "LAYOUT_ARTIFACT_DOC",
            "Layout document failed provenance or source-ownership validation",
            invariant.failures
        );
    }
    if (!claimArtifactGraph(rootValue as LayoutDoc)) {
        return failure(
            "LAYOUT_ARTIFACT_DOC",
            "Layout document graph is already bound to another artifact"
        );
    }

    const artifact = Object.freeze({
        analysis: analysisValue,
        root: rootValue as LayoutDoc,
        options: optionsValue,
        diagnostics: analysisValue.diagnostics,
    });
    CANONICAL_LAYOUT_ARTIFACT_PROOFS.set(
        artifact,
        Object.freeze({
            analysis: analysisValue,
            root: rootValue as LayoutDoc,
            options: optionsValue,
            budget: invariant.budget,
        })
    );
    return Object.freeze({ ok: true, artifact, invariant });
}

/** Renderer-only access to the exact budget accepted by artifact validation. */
export function canonicalLayoutResourceBudget(
    value: unknown
): LayoutResourceBudget | null {
    if (typeof value !== "object" || value === null) {
        return null;
    }
    return CANONICAL_LAYOUT_ARTIFACT_PROOFS.get(value)?.budget ?? null;
}

/** Exact identity proof consumed by the renderer boundary in Wave 3B. */
export function isCanonicalLayoutArtifact(
    value: unknown
): value is LayoutArtifact {
    if (typeof value !== "object" || value === null) {
        return false;
    }
    const proof = CANONICAL_LAYOUT_ARTIFACT_PROOFS.get(value);
    if (proof === undefined) {
        return false;
    }
    const artifact = value as LayoutArtifact;
    return (
        Object.isFrozen(artifact) &&
        artifact.analysis === proof.analysis &&
        artifact.root === proof.root &&
        artifact.options === proof.options &&
        artifact.diagnostics === proof.analysis.diagnostics
    );
}
