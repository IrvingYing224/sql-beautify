import type { SourceLeaf, TokenChannel, TokenKind } from "../lexer/token";
import type { SourceSpan } from "../source/source-span";
import { freezeImmutableArray } from "../util/immutable-array";
import type { LeafRange } from "./leaf-range";
import type { OpaqueBoundary, StatementKind, SyntaxNode } from "./node";
import type {
    InvariantFailure,
    InvariantFailureCode,
    InvariantResult,
} from "./invariant-types";

// ---------------------------------------------------------------------------
// Canonical leaf kind ↔ channel (mirrors Wave 1 lexer CHANNEL_BY_KIND)
// ---------------------------------------------------------------------------

export const CHANNEL_BY_KIND: Readonly<Record<TokenKind, TokenChannel>> = Object.freeze({
    keyword: "code",
    identifier: "code",
    number: "code",
    operator: "code",
    punctuation: "code",
    string: "protected",
    "quoted-identifier": "protected",
    parameter: "protected",
    unknown: "protected",
    "line-comment": "trivia",
    "block-comment": "trivia",
    "byte-order-mark": "trivia",
    whitespace: "trivia",
    newline: "trivia",
});

export const TOKEN_KINDS = new Set<string>(Object.keys(CHANNEL_BY_KIND));

export const SYNTAX_KINDS = new Set([
    "program",
    "statement",
    "query",
    "cte",
    "clause",
    "relation",
    "list",
    "list-item",
    "expression",
    "case-branch",
    "window-spec",
    "type-expression",
    "opaque",
]);

export const STATEMENT_KINDS = new Set<StatementKind>([
    "empty",
    "query",
    "insert-query",
    "opaque",
]);
export const QUERY_KINDS = new Set(["select", "set", "parenthesized"]);
export const CLAUSE_KINDS = new Set([
    "with",
    "select",
    "from",
    "where",
    "group-by",
    "having",
    "window",
    "order-by",
    "cluster-by",
    "distribute-by",
    "sort-by",
    "limit",
    "join-on",
    "join-using",
    "lateral-view",
    "insert",
    "partition",
    "set-operation",
]);
export const RELATION_KINDS = new Set([
    "table",
    "subquery",
    "join",
    "lateral-view",
    "table-function",
    "opaque",
]);
export const LIST_ROLES = new Set([
    "select-items",
    "group-by-items",
    "order-by-items",
    "cluster-by-items",
    "distribute-by-items",
    "sort-by-items",
    "partition-columns",
    "function-args",
    "cte-columns",
    "window-partition",
    "window-order",
    "type-args",
    "type-members",
    "values",
    "other",
]);
export const LIST_ITEM_ROLES = new Set([
    "select-item",
    "group-by-item",
    "order-by-item",
    "cluster-by-item",
    "distribute-by-item",
    "sort-by-item",
    "partition-column",
    "function-arg",
    "cte-column",
    "window-partition-item",
    "window-order-item",
    "type-arg",
    "type-member",
    "value",
    "other",
]);
export const EXPRESSION_KINDS = new Set([
    "identifier",
    "qualified-identifier",
    "wildcard",
    "literal",
    "parameter",
    "unary",
    "binary",
    "function-call",
    "cast",
    "case",
    "subquery",
    "parenthesized",
    "collection",
    "window",
    "between",
    "in",
    "exists",
    "is",
    "frame-bound",
    "typed-literal",
]);
export const CASE_BRANCH_KINDS = new Set(["when", "else"]);
export const OPAQUE_BOUNDARIES = new Set<OpaqueBoundary>([
    "expression",
    "list-item",
    "clause",
    "relation",
    "statement",
    "target",
    "type",
    "window",
    "other",
]);

export const OPENERS: Readonly<Record<string, string>> = Object.freeze({
    "(": ")",
    "[": "]",
});
export const CLOSERS: Readonly<Record<string, string>> = Object.freeze({
    ")": "(",
    "]": "[",
});

// ---------------------------------------------------------------------------
// Declarative relationship contracts
// ---------------------------------------------------------------------------

export type ChildRefSpec = {
    readonly field: string;
    readonly required: boolean | ((node: Record<string, unknown>) => boolean);
    readonly allowedKinds: readonly string[] | ((node: Record<string, unknown>) => readonly string[]);
    readonly allowedOpaqueBoundaries?:
        | readonly OpaqueBoundary[]
        | ((node: Record<string, unknown>) => readonly OpaqueBoundary[]);
};

export type NodeContract = {
    readonly kind: SyntaxNode["kind"];
    readonly childKinds?:
        | readonly string[]
        | ((node: Record<string, unknown>) => readonly string[]);
    readonly noUnreferencedChildren?:
        | boolean
        | ((node: Record<string, unknown>) => boolean);
    readonly refs?: readonly ChildRefSpec[];
    readonly distinctRefs?: readonly [string, string][];
};

type NodeContractsMap = { readonly [K in SyntaxNode["kind"]]: NodeContract };

const NO_CHILD_KINDS = Object.freeze([] as string[]);
const SUBQUERY_CHILD_KINDS = Object.freeze(["query", "opaque"]);
const JOIN_CHILD_KINDS = Object.freeze(["relation", "clause"]);
const LATERAL_CHILD_KINDS = Object.freeze(["relation", "list"]);
const TABLE_FUNCTION_CHILD_KINDS = Object.freeze(["opaque", "list", "expression"]);
const OPAQUE_RELATION_CHILD_KINDS = Object.freeze(["opaque"]);

/**
 * Exhaustive relationship contracts keyed by SyntaxNode kind.
 * Unknown kinds never appear here and always fail closed.
 */
export const NODE_CONTRACTS: NodeContractsMap = Object.freeze({
    program: Object.freeze({
        kind: "program" as const,
        childKinds: Object.freeze(["statement"]),
        noUnreferencedChildren: false,
        refs: Object.freeze([]),
    }),
    statement: Object.freeze({
        kind: "statement" as const,
        refs: Object.freeze([
            Object.freeze({
                field: "bodyChildId",
                required: (n: Record<string, unknown>) => n.statementKind !== "empty",
                allowedKinds: (n: Record<string, unknown>) => {
                    if (n.statementKind === "query" || n.statementKind === "insert-query") {
                        return ["query"];
                    }
                    if (n.statementKind === "opaque") {
                        return ["opaque"];
                    }
                    return [];
                },
                allowedOpaqueBoundaries: (n: Record<string, unknown>) => {
                    if (n.statementKind === "opaque") {
                        return ["statement", "target"] as const;
                    }
                    return [] as const;
                },
            }),
        ]),
        noUnreferencedChildren: true,
    }),
    query: Object.freeze({
        kind: "query" as const,
        noUnreferencedChildren: false,
        refs: Object.freeze([]),
    }),
    cte: Object.freeze({
        kind: "cte" as const,
        refs: Object.freeze([
            Object.freeze({
                field: "queryChildId",
                required: true,
                allowedKinds: Object.freeze(["query", "opaque"]),
                allowedOpaqueBoundaries: Object.freeze(["statement", "other"] as OpaqueBoundary[]),
            }),
            Object.freeze({
                field: "columnListChildId",
                required: false,
                allowedKinds: Object.freeze(["list"]),
            }),
        ]),
        noUnreferencedChildren: true,
        distinctRefs: Object.freeze([["queryChildId", "columnListChildId"]] as [string, string][]),
    }),
    clause: Object.freeze({
        kind: "clause" as const,
        noUnreferencedChildren: false,
        refs: Object.freeze([]),
    }),
    relation: Object.freeze({
        kind: "relation" as const,
        childKinds: (n: Record<string, unknown>) => {
            switch (n.relationKind) {
                case "table":
                    return NO_CHILD_KINDS;
                case "subquery":
                    return SUBQUERY_CHILD_KINDS;
                case "join":
                    return JOIN_CHILD_KINDS;
                case "lateral-view":
                    return LATERAL_CHILD_KINDS;
                case "table-function":
                    return TABLE_FUNCTION_CHILD_KINDS;
                case "opaque":
                    return OPAQUE_RELATION_CHILD_KINDS;
                default:
                    return NO_CHILD_KINDS;
            }
        },
        refs: Object.freeze([
            Object.freeze({
                field: "bodyChildId",
                required: (n: Record<string, unknown>) =>
                    n.relationKind !== "table",
                allowedKinds: (n: Record<string, unknown>) => {
                    if (n.relationKind === "opaque") {
                        return ["opaque"];
                    }
                    if (n.relationKind === "subquery") {
                        return ["query", "opaque"];
                    }
                    if (n.relationKind === "join" || n.relationKind === "lateral-view") {
                        return ["relation"];
                    }
                    if (n.relationKind === "table-function") {
                        return ["opaque", "list", "expression"];
                    }
                    return [];
                },
                allowedOpaqueBoundaries: (n: Record<string, unknown>) => {
                    if (n.relationKind === "opaque") {
                        return ["relation"] as const;
                    }
                    return ["relation", "expression", "other"] as const;
                },
            }),
        ]),
        // Join/lateral wrappers may own one typed extension child in addition
        // to bodyChildId; every other relation kind has only its body child.
        noUnreferencedChildren: (n: Record<string, unknown>) =>
            n.relationKind !== "join" && n.relationKind !== "lateral-view",
    }),
    list: Object.freeze({
        kind: "list" as const,
        childKinds: Object.freeze(["list-item"]),
        noUnreferencedChildren: false,
        refs: Object.freeze([]),
    }),
    "list-item": Object.freeze({
        kind: "list-item" as const,
        refs: Object.freeze([
            Object.freeze({
                field: "valueChildId",
                required: true,
                allowedKinds: Object.freeze([
                    "expression",
                    "opaque",
                    "query",
                    "case-branch",
                    "window-spec",
                    "type-expression",
                    "list",
                ]),
                allowedOpaqueBoundaries: Object.freeze([
                    "expression",
                    "list-item",
                    "type",
                    "window",
                ] as OpaqueBoundary[]),
            }),
        ]),
        noUnreferencedChildren: true,
    }),
    expression: Object.freeze({
        kind: "expression" as const,
        noUnreferencedChildren: false,
        refs: Object.freeze([]),
    }),
    "case-branch": Object.freeze({
        kind: "case-branch" as const,
        refs: Object.freeze([
            Object.freeze({
                field: "conditionChildId",
                required: (n: Record<string, unknown>) => n.branchKind === "when",
                allowedKinds: Object.freeze(["expression", "opaque"]),
                allowedOpaqueBoundaries: Object.freeze(["expression"] as OpaqueBoundary[]),
            }),
            Object.freeze({
                field: "valueChildId",
                required: true,
                allowedKinds: Object.freeze(["expression", "opaque"]),
                allowedOpaqueBoundaries: Object.freeze(["expression"] as OpaqueBoundary[]),
            }),
        ]),
        noUnreferencedChildren: true,
        distinctRefs: Object.freeze([["conditionChildId", "valueChildId"]] as [string, string][]),
    }),
    "window-spec": Object.freeze({
        kind: "window-spec" as const,
        refs: Object.freeze([
            Object.freeze({
                field: "partitionChildId",
                required: false,
                allowedKinds: Object.freeze(["list", "opaque"]),
                allowedOpaqueBoundaries: Object.freeze(["window"] as OpaqueBoundary[]),
            }),
            Object.freeze({
                field: "orderChildId",
                required: false,
                allowedKinds: Object.freeze(["list", "opaque"]),
                allowedOpaqueBoundaries: Object.freeze(["window"] as OpaqueBoundary[]),
            }),
            Object.freeze({
                field: "frameChildId",
                required: false,
                allowedKinds: Object.freeze(["expression", "opaque", "list"]),
                allowedOpaqueBoundaries: Object.freeze(["window", "expression"] as OpaqueBoundary[]),
            }),
        ]),
        noUnreferencedChildren: true,
        distinctRefs: Object.freeze([
            ["partitionChildId", "orderChildId"],
            ["partitionChildId", "frameChildId"],
            ["orderChildId", "frameChildId"],
        ] as [string, string][]),
    }),
    "type-expression": Object.freeze({
        kind: "type-expression" as const,
        refs: Object.freeze([
            Object.freeze({
                field: "argumentListChildId",
                required: false,
                allowedKinds: Object.freeze(["list"]),
            }),
            Object.freeze({
                field: "memberListChildId",
                required: false,
                allowedKinds: Object.freeze(["list"]),
            }),
        ]),
        noUnreferencedChildren: true,
        distinctRefs: Object.freeze([["argumentListChildId", "memberListChildId"]] as [string, string][]),
    }),
    opaque: Object.freeze({
        kind: "opaque" as const,
        refs: Object.freeze([]),
    }),
});

/**
 * Owner-kind → allowed direct OpaqueNode boundaries for free-form children
 * (not only ChildRefSpec fields). Statement/target are document-level and must
 * not hang under expression/list/case-branch/window-spec.
 */
export const FREE_FORM_OPAQUE_BOUNDARIES: Readonly<Record<string, readonly OpaqueBoundary[]>> =
    Object.freeze({
        expression: Object.freeze(["expression", "type"] as OpaqueBoundary[]),
        "case-branch": Object.freeze(["expression"] as OpaqueBoundary[]),
        list: Object.freeze(["expression", "list-item", "type", "window"] as OpaqueBoundary[]),
        "list-item": Object.freeze(["expression", "list-item", "type", "window"] as OpaqueBoundary[]),
        "window-spec": Object.freeze(["window", "expression"] as OpaqueBoundary[]),
        "type-expression": Object.freeze(["type"] as OpaqueBoundary[]),
        // Concrete 2B query/clause child shapes are enforced by
        // cst-invariants; this table owns the cross-wave opaque boundary rule.
        query: Object.freeze([
            "expression",
            "list-item",
            "clause",
            "relation",
            "type",
            "window",
            "other",
        ] as OpaqueBoundary[]),
        clause: Object.freeze([
            "expression",
            "list-item",
            "clause",
            "relation",
            "type",
            "window",
            "other",
        ] as OpaqueBoundary[]),
        cte: Object.freeze(["statement", "other"] as OpaqueBoundary[]),
        relation: Object.freeze(["relation", "expression", "other"] as OpaqueBoundary[]),
    });

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

export function resultOf(failures: InvariantFailure[]): InvariantResult {
    return Object.freeze({
        ok: failures.length === 0,
        failures: freezeImmutableArray(failures),
    });
}

export function fail(
    failures: InvariantFailure[],
    code: InvariantFailureCode,
    message: string,
    nodeId?: number
): void {
    failures.push(
        nodeId === undefined
            ? Object.freeze({ code, message })
            : Object.freeze({ code, message, nodeId })
    );
}

export function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isFiniteNonNegInt(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value >= 0 && Number.isFinite(value);
}

export function isDenseArray(value: unknown): value is unknown[] {
    if (!Array.isArray(value)) {
        return false;
    }
    // Reject sparse arrays / holes: every index in [0, length) must be own.
    for (let i = 0; i < value.length; i++) {
        if (!Object.prototype.hasOwnProperty.call(value, i)) {
            return false;
        }
    }
    return true;
}

export function isLeafRange(value: unknown): value is LeafRange {
    return (
        isObject(value) &&
        isFiniteNonNegInt(value.start) &&
        isFiniteNonNegInt(value.end) &&
        value.end >= value.start
    );
}

export function isSourceSpan(value: unknown): value is SourceSpan {
    return (
        isObject(value) &&
        isFiniteNonNegInt(value.start) &&
        isFiniteNonNegInt(value.end) &&
        value.end >= value.start
    );
}

export function rangeToSpan(
    leaves: readonly SourceLeaf[],
    source: string,
    range: LeafRange
): SourceSpan | null {
    if (range.start < 0 || range.end < range.start || range.end > leaves.length) {
        return null;
    }
    if (range.start === range.end) {
        if (leaves.length === 0) {
            return { start: 0, end: 0 };
        }
        if (range.start === 0) {
            return { start: 0, end: 0 };
        }
        if (range.start === leaves.length) {
            return { start: source.length, end: source.length };
        }
        const leaf = leaves[range.start];
        if (!leaf) {
            return null;
        }
        return { start: leaf.span.start, end: leaf.span.start };
    }
    const first = leaves[range.start];
    const last = leaves[range.end - 1];
    if (!first || !last) {
        return null;
    }
    return { start: first.span.start, end: last.span.end };
}

export function rangesOverlap(a: LeafRange, b: LeafRange): boolean {
    return a.start < b.end && b.start < a.end;
}

export function isSyntaxChannel(channel: string): boolean {
    return channel === "code" || channel === "protected";
}

export function isStructuralCodeLeaf(leaf: SourceLeaf): boolean {
    return leaf.channel === "code";
}

export function leavesEqual(a: SourceLeaf, b: SourceLeaf): boolean {
    return (
        a.id === b.id &&
        a.kind === b.kind &&
        a.channel === b.channel &&
        a.raw === b.raw &&
        a.span.start === b.span.start &&
        a.span.end === b.span.end
    );
}

export function canonicalNormalizedWord(leaf: SourceLeaf): string {
    return leaf.raw.toLowerCase();
}

export function safeCall<T>(
    failures: InvariantFailure[],
    label: string,
    fn: (() => T) | undefined
): { ok: true; value: T } | { ok: false } {
    if (typeof fn !== "function") {
        fail(failures, "INV_TOKEN_TABLE", `missing required API: ${label}`);
        return { ok: false };
    }
    try {
        return { ok: true, value: fn() };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        fail(failures, "INV_TOKEN_TABLE", `${label} threw: ${message}`);
        return { ok: false };
    }
}

export function safeCall1<A, T>(
    failures: InvariantFailure[],
    label: string,
    fn: ((arg: A) => T) | undefined,
    arg: A
): { ok: true; value: T } | { ok: false } {
    if (typeof fn !== "function") {
        fail(failures, "INV_TOKEN_TABLE", `missing required API: ${label}`);
        return { ok: false };
    }
    try {
        return { ok: true, value: fn(arg) };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        fail(failures, "INV_TOKEN_TABLE", `${label}(${String(arg)}) threw: ${message}`);
        return { ok: false };
    }
}

export function expectNonNegInt(
    failures: InvariantFailure[],
    label: string,
    value: unknown
): number | null {
    if (!isFiniteNonNegInt(value)) {
        fail(failures, "INV_TOKEN_TABLE", `${label} must be non-negative integer, got ${String(value)}`);
        return null;
    }
    return value;
}

/** O(1) representative: call must throw for illegal input. */
export function expectRejects(
    failures: InvariantFailure[],
    label: string,
    fn: () => unknown
): void {
    try {
        fn();
        fail(failures, "INV_TOKEN_TABLE", `${label} must reject illegal input`);
    } catch {
        // expected reject path
    }
}

export function expectSpanEqual(
    failures: InvariantFailure[],
    label: string,
    got: unknown,
    expected: SourceSpan
): void {
    if (!isObject(got as Record<string, unknown>) || !isSourceSpan(got)) {
        fail(failures, "INV_TOKEN_TABLE", `${label} must return a SourceSpan`);
        return;
    }
    if (got.start !== expected.start || got.end !== expected.end) {
        fail(
            failures,
            "INV_TOKEN_TABLE",
            `${label} expected span [${expected.start},${expected.end}), got [${got.start},${got.end})`
        );
    }
}
