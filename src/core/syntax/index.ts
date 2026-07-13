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
    ParseOutput,
    ParserBackend,
} from "./parser-backend";
export type {
    StructuralIssue,
    StructuralIssueCode,
    StructuralTokenTable,
} from "./token-table";
export { buildStructuralTokenTable } from "./token-table";
export type { TokenCursor } from "./cursor";
export { createTokenCursor } from "./cursor";
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
