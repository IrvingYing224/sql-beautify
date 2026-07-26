export type { LeafRange } from "./leaf-range";
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
    SetPayloadNode,
    SetStatementNode,
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
} from "./node";
export type {
    ParseInput,
    ParseMode,
    ParseOptions,
    ParseOutput,
    ParserBackend,
} from "./parser-backend";
export type { SyntaxDiagnosticCode } from "./parser-context";
export { parseSql, parseTypePrefixFromArtifact, parserBackend } from "./parser";
export type {
    StructuralIssue,
    StructuralIssueCode,
    StructuralTokenTable,
} from "./token-table";
export { buildStructuralTokenTable } from "./token-table";
export type { TokenCursor } from "./cursor";
export { createTokenCursor } from "./cursor";
export { splitTopLevelTypeItems } from "./type-cursor";
export type {
    ExpressionQueryParser,
    ExpressionValueNode,
} from "./expression-parser";
export { parseExpressionRange } from "./expression-parser";
export type { WindowValueParser } from "./window-parser";
export {
    parseWindowDeclaration,
    parseWindowSpecRange,
} from "./window-parser";
export type { ParsedTypePrefix } from "./type-parser";
export {
    parseTypeExpression,
    parseTypeExpressionPrefix,
} from "./type-parser";
export type { ParserCheckpoint } from "./recovery";
export {
    createOpaqueWithDiagnostic,
    createParserCheckpoint,
    recoverOpaqueFromError,
    rollbackParserCheckpoint,
} from "./recovery";
// Note: token table uses bounded multi-pass O(n) scans (not a single combined scan).
export type {
    InvariantFailure,
    InvariantFailureCode,
    InvariantResult,
    SyntaxInvariantInput,
} from "./invariants";
export {
    validateSyntaxInvariants,
    validateTokenTableInvariants,
} from "./invariants";
