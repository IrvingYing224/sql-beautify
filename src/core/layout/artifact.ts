import type { AnalyzedArtifact } from "../analysis/types";
import type { CanonicalFormatOptions } from "../config/options";
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
    analysis: AnalyzedArtifact,
    root: LayoutDoc,
    options: CanonicalFormatOptions
): CreateLayoutArtifactResult {
    if (options.dialect !== analysis.dialect) {
        return failure(
            "LAYOUT_ARTIFACT_DIALECT",
            "Layout options dialect must match analysis dialect"
        );
    }

    const resources = checkLayoutResources(analysis, root);
    if (!resources.ok) {
        return failure("LAYOUT_ARTIFACT_RESOURCE", resources.message);
    }
    const artifact = Object.freeze({
        analysis,
        root,
        options,
        diagnostics: analysis.diagnostics,
        budget: resources.budget,
    });
    return Object.freeze({ ok: true, artifact });
}
