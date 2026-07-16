import {
    isCanonicalStructuralIndexForParseArtifact,
} from "./structural-index";
import type {
    AnalysisArtifact,
    AnalysisStatus,
    AnalyzedArtifact,
    StructuralIndex,
} from "./types";
import {
    isCanonicalParseArtifact,
} from "../syntax/parser";
import type { ParseArtifact } from "../syntax/parser";

const CANONICAL_ANALYSIS_PARSE_ARTIFACTS = new WeakMap<object, ParseArtifact>();

/**
 * Internal construction boundary. A frozen result is always returned, but only
 * exact canonical parse/index provenance receives layout-eligible identity.
 */
export function createAnalysisArtifact(
    parseArtifact: ParseArtifact,
    status: AnalysisStatus,
    index: StructuralIndex | null
): AnalysisArtifact {
    if (
        status !== "analyzed" &&
        status !== "preserved" &&
        status !== "failed"
    ) {
        throw new Error(`Unknown analysis artifact status: ${String(status)}`);
    }
    if (status === "failed" && index !== null) {
        throw new Error("Failed analysis artifact must not carry a structural index");
    }
    if (status !== "failed" && index === null) {
        throw new Error(`${status} analysis artifact requires a structural index`);
    }

    const output = parseArtifact.output;
    const artifact = Object.freeze({
        status,
        source: parseArtifact.source,
        dialect: parseArtifact.dialect,
        mode: parseArtifact.mode,
        root: output.root,
        leaves: output.leaves,
        diagnostics: output.diagnostics,
        index,
    }) as AnalysisArtifact;

    const canonicalIndex =
        index === null ||
        isCanonicalStructuralIndexForParseArtifact(index, parseArtifact);
    const preservesTarget = output.diagnostics.some(
        (diagnostic) => diagnostic.recovery === "preserve-target"
    );
    const statusMatchesDiagnostics =
        status === "failed" ||
        (status === "preserved" ? preservesTarget : !preservesTarget);
    if (
        isCanonicalParseArtifact(parseArtifact) &&
        canonicalIndex &&
        statusMatchesDiagnostics
    ) {
        CANONICAL_ANALYSIS_PARSE_ARTIFACTS.set(artifact, parseArtifact);
    }
    return artifact;
}

/** Exact identity proof for any canonical analysis status. */
export function isCanonicalAnalysisArtifact(
    value: unknown
): value is AnalysisArtifact {
    return (
        typeof value === "object" &&
        value !== null &&
        CANONICAL_ANALYSIS_PARSE_ARTIFACTS.has(value)
    );
}

/** Layout accepts analyzed artifacts only; preserved/failed return source directly. */
export function isCanonicalAnalyzedArtifact(
    value: unknown
): value is AnalyzedArtifact {
    return isCanonicalAnalysisArtifact(value) && value.status === "analyzed";
}

/** Internal exact parse provenance used by LayoutArtifact validation. */
export function canonicalParseArtifactForAnalysis(
    value: AnalyzedArtifact
): ParseArtifact | null {
    return CANONICAL_ANALYSIS_PARSE_ARTIFACTS.get(value) ?? null;
}
