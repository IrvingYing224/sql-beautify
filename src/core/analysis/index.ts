export type {
    AnalysisOutput,
    AnalysisStatus,
    CommentBinding,
    FailedAnalysisOutput,
    IndexedAnalysisOutput,
    OffsetLeafLocation,
    SeparatorOwnership,
    SourcePosition,
    StructuralIndex,
    StructuralIndexInput,
    StructuralIndexSnapshot,
    TriviaPlacement,
} from "./types";
export { analyzeSql } from "./analyze";
export { buildStructuralIndex } from "./structural-index";
