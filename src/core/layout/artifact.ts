import type { AnalyzedArtifact } from "../analysis/types";
import type { CanonicalFormatOptions } from "../config/options";
import type { Diagnostic } from "../diagnostics/diagnostic";
import type { LayoutDoc } from "./doc";

export interface LayoutArtifact {
    readonly analysis: AnalyzedArtifact;
    readonly root: LayoutDoc;
    readonly options: CanonicalFormatOptions;
    readonly diagnostics: readonly Diagnostic[];
}

/** Binds analysis, the compiled doc and options for metrics, render and alignment. */
export function createLayoutArtifact(
    analysis: AnalyzedArtifact,
    root: LayoutDoc,
    options: CanonicalFormatOptions
): LayoutArtifact {
    return Object.freeze({
        analysis,
        root,
        options,
        diagnostics: analysis.diagnostics,
    });
}
