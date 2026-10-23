import type { ParseOptions } from "../syntax/parser-backend";
import {
    parseSqlArtifact,
    preserveParseArtifactTarget,
} from "../syntax/parser";
import type { ParseArtifact } from "../syntax/parser";
import { buildStructuralIndex } from "./structural-index";
import type {
    AnalysisArtifact,
    AnalysisOutput,
    AnalysisStatus,
    StructuralIndex,
} from "./types";

const MAX_INTERNAL_MESSAGE_LENGTH = 512;

function internalMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.length <= MAX_INTERNAL_MESSAGE_LENGTH
        ? message
        : `${message.slice(0, MAX_INTERNAL_MESSAGE_LENGTH)}…`;
}

function analysisArtifact(
    artifact: ParseArtifact,
    status: AnalysisStatus,
    index: StructuralIndex | null
): AnalysisArtifact {
    const output = artifact.output;
    return Object.freeze({
        status,
        source: artifact.source,
        dialect: artifact.dialect,
        mode: artifact.mode,
        root: output.root,
        leaves: output.leaves,
        diagnostics: output.diagnostics,
        index,
    }) as AnalysisArtifact;
}

function outputWithIndex(
    status: Extract<AnalysisStatus, "analyzed" | "preserved">,
    artifact: ParseArtifact,
    index: StructuralIndex
): AnalysisOutput {
    return analysisArtifact(artifact, status, index);
}

function failedOutput(artifact: ParseArtifact): AnalysisOutput {
    return analysisArtifact(artifact, "failed", null);
}

function artifactPreservesTarget(artifact: ParseArtifact): boolean {
    return artifact.output.diagnostics.some(
        (diagnostic) => diagnostic.recovery === "preserve-target"
    );
}

/**
 * Internal Wave 2 analysis entry. It consumes the exact token table retained
 * by the parse artifact and never re-lexes, reparses, or rebuilds grammar facts.
 */
export function analyzeSql(
    source: string,
    options: ParseOptions = {}
): AnalysisOutput {
    const artifact = parseSqlArtifact(source, options);
    return analyzeParseArtifact(artifact);
}

/** Internal integration seam used to verify fail-closed artifact handling. */
export function analyzeParseArtifact(artifact: ParseArtifact): AnalysisOutput {
    try {
        return outputWithIndex(
            artifactPreservesTarget(artifact) ? "preserved" : "analyzed",
            artifact,
            buildStructuralIndex(artifact)
        );
    } catch (error) {
        let preserved: ParseArtifact;
        try {
            preserved = preserveParseArtifactTarget(
                artifact,
                `Analysis invariant failure: ${internalMessage(error)}`
            );
        } catch {
            return failedOutput(artifact);
        }
        try {
            return outputWithIndex("preserved", preserved, buildStructuralIndex(preserved));
        } catch (fallbackError) {
            try {
                const failed = preserveParseArtifactTarget(
                    preserved,
                    `Analysis fallback failure: ${internalMessage(fallbackError)}`
                );
                return failedOutput(failed);
            } catch {
                return failedOutput(preserved);
            }
        }
    }
}
