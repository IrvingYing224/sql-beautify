import type { AnalyzedArtifact } from "../analysis/types";
import type { CanonicalFormatOptions } from "../config/options";
import type { Diagnostic } from "../diagnostics/diagnostic";
import type { LayoutDoc } from "./doc";

export interface LayoutArtifact {
    readonly analysis: AnalyzedArtifact;
    readonly root: LayoutDoc;
    readonly options: CanonicalFormatOptions;
    readonly diagnostics: readonly Diagnostic[];
    /** See LayoutPlan.baseIndentLeafId. */
    readonly baseIndentLeafId: number | null;
}

/** Binds analysis, the compiled doc and options for metrics, render and alignment. */
export function createLayoutArtifact(
    analysis: AnalyzedArtifact,
    root: LayoutDoc,
    options: CanonicalFormatOptions,
    baseIndentLeafId: number | null
): LayoutArtifact {
    return Object.freeze({
        analysis,
        root,
        options,
        diagnostics: analysis.diagnostics,
        baseIndentLeafId,
    });
}
