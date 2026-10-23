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
    /** The budget accepted by doc validation; render, metrics and alignment read it. */
    readonly budget: LayoutResourceBudget;
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

/** Binds analysis, doc, options and the validated budget; no partial artifact on failure. */
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
    const artifact = Object.freeze({
        analysis: analysisValue,
        root: rootValue as LayoutDoc,
        options: optionsValue,
        diagnostics: analysisValue.diagnostics,
        budget: invariant.budget,
    });
    return Object.freeze({ ok: true, artifact, invariant });
}
