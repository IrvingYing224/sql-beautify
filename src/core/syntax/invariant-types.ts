import type { StructuralTokenTable } from "./token-table";

export type InvariantFailureCode =
    | "INV_LEAF_RANGE_BOUNDS"
    | "INV_SPAN_LEAFRANGE_MISMATCH"
    | "INV_ROOT_ID"
    | "INV_ID_UNIQUE"
    | "INV_ID_CONTIGUOUS"
    | "INV_CHILDREN_ORDER"
    | "INV_SIBLING_OVERLAP"
    | "INV_PARENT_CONTAINMENT"
    | "INV_SHARED_CHILD"
    | "INV_OPAQUE_CHILDREN"
    | "INV_OWNER_REFERENCE"
    | "INV_CHILD_REFERENCE"
    | "INV_RELATIONSHIP"
    | "INV_SHAPE"
    | "INV_ENUM"
    | "INV_DELIMITER_PAIR"
    | "INV_DEPTH_CONSISTENCY"
    | "INV_ADJACENCY"
    | "INV_ORDINAL"
    | "INV_STATEMENT_RANGES"
    | "INV_LEAF_PARTITION"
    | "INV_MALFORMED_NODE"
    | "INV_ROOT_COVERAGE"
    | "INV_EMPTY_RANGE"
    | "INV_SOURCE_TYPE"
    | "INV_TOKEN_TABLE"
    | "INV_EXTRA_CHILD";

export interface InvariantFailure {
    readonly code: InvariantFailureCode;
    readonly message: string;
    readonly nodeId?: number;
}

export interface InvariantResult {
    readonly ok: boolean;
    readonly failures: readonly InvariantFailure[];
}

export interface SyntaxInvariantInput {
    readonly root: unknown;
    readonly leaves: unknown;
    readonly source: unknown;
    /**
     * Optional. Absent or `undefined` skips table validation.
     * Explicit `null` / non-object / incomplete table must fail closed.
     */
    readonly tokenTable?: StructuralTokenTable | null;
}
