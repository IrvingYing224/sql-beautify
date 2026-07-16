export type { SourceSpan } from "./source/source-span";
export type { SourceLeaf, TokenChannel, TokenKind } from "./lexer/token";
export type { LexOptions, LexOutput } from "./lexer/lossless-lexer";
export { lexSql } from "./lexer/lossless-lexer";
export type {
    CapabilityIdentity,
    Diagnostic,
    DiagnosticSeverity,
    RecoveryAction,
} from "./diagnostics/diagnostic";
export type {
    AliasInfo,
    CaseBranchKind,
    CaseBranchNode,
    ClauseKind,
    ClauseNode,
    ClauseNodeFacts,
    CteNode,
    ExpressionKind,
    ExpressionNode,
    ExpressionNodeFacts,
    FormatRole,
    LeafRange,
    ListItemNode,
    ListItemRole,
    ListNode,
    ListRole,
    OpaqueBoundary,
    OpaqueNode,
    OperatorOccurrence,
    OperatorOccurrenceInput,
    ProgramNode,
    QueryKind,
    QueryNode,
    RelationKind,
    RelationNode,
    RelationNodeFacts,
    StatementKind,
    StatementNode,
    StructuredNode,
    StructuredSyntaxKind,
    SyntaxNode,
    SyntaxNodeBase,
    SyntaxNodeFacts,
    SyntaxLeafRole,
    SyntaxMarker,
    SyntaxMarkerId,
    TypeExpressionNode,
    WindowSpecNode,
} from "./syntax/node";
export type {
    ParseInput,
    ParseMode,
    ParseOptions,
    ParseOutput,
    ParserBackend,
} from "./syntax/parser-backend";
export type {
    AlignDoc,
    AutoGroupDoc,
    ConcatDoc,
    ForcedGroupDoc,
    HardLineDoc,
    IndentDoc,
    LayoutDoc,
    LeafDoc,
    LeafTransform,
    LineSuffixDoc,
    LineSuffixSpacing,
    PadToColumnDoc,
    PositiveColumns,
    PositiveLevels,
    SoftLineDoc,
    SpaceDoc,
    VerbatimDoc,
    VerbatimTrigger,
} from "./layout/doc";
export type {
    LayoutDocFactory,
    LineSuffixSpacingInput,
} from "./layout/doc-factory";
export type {
    CreateLayoutArtifactResult,
    LayoutArtifact,
    LayoutArtifactFailure,
    LayoutArtifactFailureCode,
    LayoutArtifactSuccess,
} from "./layout/artifact";
export type {
    LayoutInvariantFailure,
    LayoutInvariantFailureCode,
    LayoutInvariantFailureResult,
    LayoutInvariantResult,
    LayoutInvariantSuccess,
} from "./layout/invariants";
export type { LayoutResourceBudget } from "./layout/resource-budget";
export type {
    DominatingVerbatimClaim,
    DominatingVerbatimClaims,
} from "./layout/verbatim-claims";
export type {
    CanonicalFormatOptions,
    CaseLayout,
    CommaStyle,
    Dialect,
    FormatOptions,
    IndentStyle,
    KeywordCase,
    UnsupportedSyntaxPolicy,
} from "./config/options";
export type {
    FormatConfigFailure,
    FormatConfigFailureCode,
    ResolveFormatOptionsResult,
    ResolvedFormatOptions,
} from "./config/resolve-options";
export type { FormatResult, FormatStatus, SourceMap, SourceMapEntry } from "./api/format-result";
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
    StructuralIndexSnapshot,
    SyntaxLeafOccurrence,
    TriviaPlacement,
} from "./analysis/types";
