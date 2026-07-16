import type { ParseOptions } from "../syntax/parser-backend";
import {
    canonicalSourceLeafPartitionDialect,
    isImmutableSourceLeafPartitionForSource,
} from "../lexer/lossless-lexer";
import {
    canonicalParseModeForRoot,
    parseSqlArtifact,
    preserveParseArtifactTarget,
} from "../syntax/parser";
import type { ParseArtifact } from "../syntax/parser";
import { isCanonicalStructuralTokenTableForLeaves } from "../syntax/token-table";
import { buildStructuralIndex } from "./structural-index";
import type {
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

function buildIndex(artifact: ParseArtifact): StructuralIndex {
    return buildStructuralIndex(
        {
            root: artifact.output.root,
            leaves: artifact.output.leaves,
            tokenTable: artifact.tokenTable,
            dialect: artifact.dialect,
            diagnostics: artifact.output.diagnostics,
            hasCommentTrivia: artifact.hasCommentTrivia,
        },
        artifact
    );
}

function outputWithIndex(
    status: Extract<AnalysisStatus, "analyzed" | "preserved">,
    artifact: ParseArtifact,
    index: StructuralIndex
): AnalysisOutput {
    return Object.freeze({
        status,
        root: artifact.output.root,
        leaves: artifact.output.leaves,
        diagnostics: artifact.output.diagnostics,
        index,
    });
}

function failedOutput(artifact: ParseArtifact): AnalysisOutput {
    return Object.freeze({
        status: "failed",
        root: artifact.output.root,
        leaves: artifact.output.leaves,
        diagnostics: artifact.output.diagnostics,
        index: null,
    });
}

function artifactProvenanceIsConsistent(artifact: ParseArtifact): boolean {
    const leaves = artifact.output.leaves;
    const canonicalMode = canonicalParseModeForRoot(artifact.output.root);
    return (
        isImmutableSourceLeafPartitionForSource(leaves, artifact.source) &&
        canonicalSourceLeafPartitionDialect(leaves) === artifact.dialect &&
        (canonicalMode === null || canonicalMode === artifact.mode) &&
        isCanonicalStructuralTokenTableForLeaves(artifact.tokenTable, leaves)
    );
}

function failedProvenanceOutput(artifact: ParseArtifact): AnalysisOutput {
    try {
        return failedOutput(
            preserveParseArtifactTarget(
                artifact,
                "Analysis artifact source/dialect/mode provenance mismatch"
            )
        );
    } catch {
        return failedOutput(artifact);
    }
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
        if (!artifactProvenanceIsConsistent(artifact)) {
            return failedProvenanceOutput(artifact);
        }
        return outputWithIndex("analyzed", artifact, buildIndex(artifact));
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
            return outputWithIndex("preserved", preserved, buildIndex(preserved));
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
