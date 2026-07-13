import type { SourceSpan } from "../source/source-span";
import type { LeafRange } from "./leaf-range";

export type { LeafRange } from "./leaf-range";

export interface SyntaxNodeBase<K extends string> {
    readonly id: number;
    readonly kind: K;
    readonly span: SourceSpan;
    readonly leafRange: LeafRange;
}

export interface AliasInfo {
    readonly keywordLeafId: number | null;
    readonly nameLeafRange: LeafRange;
}

export type StatementKind = "empty" | "query" | "insert-query" | "opaque";
export type QueryKind = "select" | "set" | "parenthesized";
export type ClauseKind =
    | "with"
    | "select"
    | "from"
    | "where"
    | "group-by"
    | "having"
    | "window"
    | "order-by"
    | "cluster-by"
    | "distribute-by"
    | "sort-by"
    | "limit"
    | "join-on"
    | "lateral-view"
    | "insert"
    | "partition"
    | "set-operation";

/**
 * Relation kinds. `opaque` means the relation wrapper contains exactly one
 * OpaqueNode child that carries reasonCode/boundary — not a second opaque form.
 */
export type RelationKind =
    | "table"
    | "subquery"
    | "join"
    | "lateral-view"
    | "table-function"
    | "opaque";

export type ListRole =
    | "select-items"
    | "group-by-items"
    | "order-by-items"
    | "cluster-by-items"
    | "distribute-by-items"
    | "sort-by-items"
    | "partition-columns"
    | "function-args"
    | "cte-columns"
    | "window-partition"
    | "window-order"
    | "type-args"
    | "type-members"
    | "values"
    | "other";

export type ListItemRole =
    | "select-item"
    | "group-by-item"
    | "order-by-item"
    | "cluster-by-item"
    | "distribute-by-item"
    | "sort-by-item"
    | "partition-column"
    | "function-arg"
    | "cte-column"
    | "window-partition-item"
    | "window-order-item"
    | "type-arg"
    | "type-member"
    | "value"
    | "other";

/**
 * Structured expression kinds only. Opaque expressions use OpaqueNode
 * (reasonCode + boundary) — never ExpressionKind "opaque".
 */
export type ExpressionKind =
    | "identifier"
    | "qualified-identifier"
    | "wildcard"
    | "literal"
    | "parameter"
    | "unary"
    | "binary"
    | "function-call"
    | "cast"
    | "case"
    | "subquery"
    | "parenthesized"
    | "collection"
    | "window"
    | "between"
    | "in"
    | "exists"
    | "is"
    | "typed-literal";

export type CaseBranchKind = "when" | "else";

export type OpaqueBoundary =
    | "expression"
    | "list-item"
    | "clause"
    | "relation"
    | "statement"
    | "target"
    | "type"
    | "window"
    | "other";

export interface ProgramNode extends SyntaxNodeBase<"program"> {
    /** Ordered statement children only (design §7.2). */
    readonly children: readonly StatementNode[];
}

export interface StatementNode extends SyntaxNodeBase<"statement"> {
    readonly statementKind: StatementKind;
    /**
     * Direct child id of the statement body (query / insert body / opaque),
     * or null for empty statements.
     */
    readonly bodyChildId: number | null;
    readonly children: readonly SyntaxNode[];
}

export interface QueryNode extends SyntaxNodeBase<"query"> {
    readonly queryKind: QueryKind;
    /** Leaf ids of set operators combining child queries (empty for non-set). */
    readonly setOperatorLeafIds: readonly number[];
    readonly children: readonly SyntaxNode[];
}

export interface CteNode extends SyntaxNodeBase<"cte"> {
    readonly nameLeafRange: LeafRange;
    /** Child id of the CTE query body (required). */
    readonly queryChildId: number;
    /** Child id of optional column list, or null. */
    readonly columnListChildId: number | null;
    readonly children: readonly SyntaxNode[];
}

export interface ClauseNode extends SyntaxNodeBase<"clause"> {
    readonly clauseKind: ClauseKind;
    readonly headLeafRange: LeafRange;
    readonly bodyLeafRange: LeafRange;
    readonly children: readonly SyntaxNode[];
}

export interface RelationNode extends SyntaxNodeBase<"relation"> {
    readonly relationKind: RelationKind;
    readonly alias: AliasInfo | null;
    /**
     * When relationKind is "opaque", bodyChildId must reference the unique
     * OpaqueNode child. Otherwise optional body (subquery/join payload).
     */
    readonly bodyChildId: number | null;
    readonly children: readonly SyntaxNode[];
}

export interface ListNode extends SyntaxNodeBase<"list"> {
    readonly listRole: ListRole;
    readonly separatorLeafIds: readonly number[];
    /** Ordered list-item children. */
    readonly children: readonly ListItemNode[];
}

export interface ListItemNode extends SyntaxNodeBase<"list-item"> {
    readonly itemRole: ListItemRole;
    readonly alias: AliasInfo | null;
    readonly modifierLeafIds: readonly number[];
    /** Child id of the item value (expression / opaque / subquery). */
    readonly valueChildId: number;
    readonly children: readonly SyntaxNode[];
}

export interface ExpressionNode extends SyntaxNodeBase<"expression"> {
    readonly expressionKind: ExpressionKind;
    readonly operatorLeafIds: readonly number[];
    readonly children: readonly SyntaxNode[];
}

export interface CaseBranchNode extends SyntaxNodeBase<"case-branch"> {
    readonly branchKind: CaseBranchKind;
    /** WHEN condition child id, or null for ELSE. */
    readonly conditionChildId: number | null;
    /** THEN/ELSE value child id. */
    readonly valueChildId: number;
    readonly children: readonly SyntaxNode[];
}

export interface WindowSpecNode extends SyntaxNodeBase<"window-spec"> {
    readonly partitionChildId: number | null;
    readonly orderChildId: number | null;
    readonly frameChildId: number | null;
    readonly children: readonly SyntaxNode[];
}

export interface TypeExpressionNode extends SyntaxNodeBase<"type-expression"> {
    readonly typeNameLeafRange: LeafRange;
    readonly argumentListChildId: number | null;
    readonly memberListChildId: number | null;
    readonly children: readonly SyntaxNode[];
}

/**
 * Sole opaque structure carrying reasonCode and boundary.
 * Must not declare a children property.
 */
export interface OpaqueNode extends SyntaxNodeBase<"opaque"> {
    readonly reasonCode: string;
    readonly boundary: OpaqueBoundary;
}

export type SyntaxNode =
    | ProgramNode
    | StatementNode
    | QueryNode
    | CteNode
    | ClauseNode
    | RelationNode
    | ListNode
    | ListItemNode
    | ExpressionNode
    | CaseBranchNode
    | WindowSpecNode
    | TypeExpressionNode
    | OpaqueNode;

/**
 * Structured kinds are derived from the SyntaxNode union excluding opaque.
 */
export type StructuredSyntaxKind = Exclude<SyntaxNode["kind"], "opaque">;

/** @deprecated Use specific node interfaces; retained name for Wave 0 type surface. */
export type StructuredNode = Exclude<SyntaxNode, OpaqueNode>;
