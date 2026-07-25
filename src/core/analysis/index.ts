export type {
    AnalysisArtifact,
    AnalysisArtifactBase,
    AnalysisOutput,
    AnalysisStatus,
    AnalyzedArtifact,
    CapabilityOccurrence,
    CommentBinding,
    ContextualLeafFacts,
    FailedAnalysisArtifact,
    FailedAnalysisOutput,
    IndexedAnalysisOutput,
    OffsetLeafLocation,
    PreservedAnalysisArtifact,
    SeparatorOwnership,
    SourcePosition,
    StructuralIndex,
    StructuralIndexInput,
    StructuralIndexSnapshot,
    SyntaxLeafOccurrence,
    TriviaPlacement,
} from "./types";
export { analyzeSql } from "./analyze";
export {
    isCanonicalAnalysisArtifact,
    isCanonicalAnalyzedArtifact,
} from "./artifact";
export { buildStructuralIndex } from "./structural-index";
