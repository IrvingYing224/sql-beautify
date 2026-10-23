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
import type { LayoutResourceBudget } from "./resource-budget";
import { checkLayoutResources } from "./resource-limits";

export interface LayoutArtifact {
    readonly analysis: AnalyzedArtifact;
    readonly root: LayoutDoc;
    readonly options: CanonicalFormatOptions;
    readonly diagnostics: readonly Diagnostic[];
    /** The budget accepted by the resource check; render, metrics and alignment read it. */
    readonly budget: LayoutResourceBudget;
}

export type LayoutArtifactFailureCode =
    | "LAYOUT_ARTIFACT_ANALYSIS"
    | "LAYOUT_ARTIFACT_OPTIONS"
    | "LAYOUT_ARTIFACT_DIALECT"
    | "LAYOUT_ARTIFACT_RESOURCE";

export interface LayoutArtifactFailure {
    readonly ok: false;
    readonly code: LayoutArtifactFailureCode;
    readonly message: string;
}

export interface LayoutArtifactSuccess {
    readonly ok: true;
    readonly artifact: LayoutArtifact;
}

export type CreateLayoutArtifactResult =
    | LayoutArtifactSuccess
    | LayoutArtifactFailure;

function failure(
    code: LayoutArtifactFailureCode,
    message: string
): LayoutArtifactFailure {
    return Object.freeze({ ok: false, code, message });
}

/** Binds analysis, doc, options and the checked budget; no partial artifact on failure. */
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

    const root = rootValue as LayoutDoc;
    const resources = checkLayoutResources(analysisValue, root);
    if (!resources.ok) {
        return failure("LAYOUT_ARTIFACT_RESOURCE", resources.message);
    }
    const artifact = Object.freeze({
        analysis: analysisValue,
        root,
        options: optionsValue,
        diagnostics: analysisValue.diagnostics,
        budget: resources.budget,
    });
    return Object.freeze({ ok: true, artifact });
}
