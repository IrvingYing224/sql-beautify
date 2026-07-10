import type { SourceSpan } from "../source/source-span";

export type StructuredSyntaxKind =
    | "program"
    | "statement"
    | "query"
    | "with-clause"
    | "select-clause"
    | "from-clause"
    | "where-clause"
    | "group-by-clause"
    | "having-clause"
    | "order-by-clause"
    | "insert-clause"
    | "list"
    | "expression";

export interface StructuredNode {
    readonly id: number;
    readonly kind: StructuredSyntaxKind;
    readonly span: SourceSpan;
    readonly children: readonly SyntaxNode[];
}

export interface OpaqueNode {
    readonly id: number;
    readonly kind: "opaque";
    readonly span: SourceSpan;
    readonly reasonCode: string;
}

export type SyntaxNode = StructuredNode | OpaqueNode;
