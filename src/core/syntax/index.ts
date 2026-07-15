export type { LeafRange } from "./leaf-range";
export type {
    AliasInfo,
    CaseBranchKind,
    CaseBranchNode,
    ClauseKind,
    ClauseNode,
    CteNode,
    ExpressionKind,
    ExpressionNode,
    ListItemNode,
    ListItemRole,
    ListNode,
    ListRole,
    OpaqueBoundary,
    OpaqueNode,
    ProgramNode,
    QueryKind,
    QueryNode,
    RelationKind,
    RelationNode,
    StatementKind,
    StatementNode,
    StructuredNode,
    StructuredSyntaxKind,
    SyntaxNode,
    SyntaxNodeBase,
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
export { parseSql, parserBackend } from "./parser";
export type {
    StructuralIssue,
    StructuralIssueCode,
    StructuralTokenTable,
} from "./token-table";
export { buildStructuralTokenTable } from "./token-table";
export type { TokenCursor } from "./cursor";
export { createTokenCursor } from "./cursor";
export type { NodeFactory } from "./node-factory";
export { createNodeFactory } from "./node-factory";
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
