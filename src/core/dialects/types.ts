import type { Dialect } from "../config/options";

/** Capability state is a fact about current implementation status. */
export type CapabilityState =
    | "recognized"
    | "structured"
    | "formatted"
    | "verbatim"
    | "diagnostic";

export type OperatorFixity = "prefix" | "infix" | "postfix";
export type OperatorAssociativity = "left" | "right" | "none";
export type OperatorFormatClass =
    | "prefix-word"
    | "prefix-symbol"
    | "infix-word"
    | "infix-word-continuation"
    | "infix-symbol"
    | "postfix-word"
    | "postfix-symbol"
    | "attached";

/**
 * How the operator is recognized in the leaf stream.
 * - symbol: single lexical operator token (key must exist in lexical operators)
 * - keyword: single keyword leaf sequence
 * - compound: multi-leaf word operator (e.g. IS NOT, NOT IN)
 * - special: non-standard / ternary parselet (e.g. BETWEEN ... AND)
 */
export type OperatorForm = "symbol" | "keyword" | "compound" | "special";

export interface CapabilityEntry {
    readonly id: string;
    readonly state: CapabilityState;
    readonly notes?: string;
}

/**
 * Final operator semantics consumed by the Wave 2C Pratt parser.
 * Lookup is (key, fixity) — the same lexical token may have multiple entries.
 */
export interface OperatorSemantics {
    /** Stable and unique within one dialect registry view. */
    readonly id: string;
    readonly key: string;
    readonly fixity: OperatorFixity;
    readonly form: OperatorForm;
    /**
     * For compound/special operators: ordered normalized word tokens
     * (e.g. ["is","not"], ["between","and"]). Empty for symbol form.
     */
    readonly words: readonly string[];
    readonly precedence: number;
    readonly associativity: OperatorAssociativity;
    readonly capabilityId: string | null;
    readonly formatClass: OperatorFormatClass;
}

export type QueryClauseSyntaxId =
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
    | "limit";

export interface QueryClauseSyntax {
    readonly id: QueryClauseSyntaxId;
    readonly words: readonly string[];
    readonly order: number;
    /** SELECT is an intrinsic container; query-level nodes own its authority. */
    readonly capabilityId: string | null;
}

export type SetOperatorSyntaxId = "union" | "intersect" | "except";

export interface SetOperatorSyntax {
    readonly id: SetOperatorSyntaxId;
    readonly word: string;
    readonly capabilityId: string;
}

export type JoinSyntaxId =
    | "join"
    | "cross-join"
    | "full-join"
    | "full-outer-join"
    | "inner-join"
    | "left-join"
    | "left-outer-join"
    | "left-semi-join"
    | "left-anti-join"
    | "right-join"
    | "right-outer-join";

export interface JoinSyntax {
    readonly id: JoinSyntaxId;
    readonly words: readonly string[];
    readonly capabilityId: "join";
}

export type UnsupportedSyntaxContext =
    | "statement-start"
    | "query-clause"
    | "relation-suffix";

/** Registry-owned signature for a recognized construct not yet structured. */
export interface UnsupportedSyntaxSignature {
    readonly capabilityId: string;
    readonly context: UnsupportedSyntaxContext;
    readonly words: readonly string[];
    /** Query-clause ordering slot; null outside query-clause context. */
    readonly order: number | null;
    /** Ordered top-level syntax-token evidence alternatives for relation constructs. */
    readonly bodyEvidence: readonly (readonly string[])[] | null;
}

/** @deprecated Use OperatorFixity; retained alias for arity naming. */
export type OperatorArity = OperatorFixity;

export interface DialectCapabilityView {
    readonly id: Dialect;
    getCapability(id: string): CapabilityEntry | null;
    listCapabilities(): readonly CapabilityEntry[];
    /**
     * Lookup by lexical key + fixity. A single key may have multiple fixities.
     */
    getOperatorSemantics(key: string, fixity: OperatorFixity): OperatorSemantics | null;
    listOperatorSemantics(): readonly OperatorSemantics[];
    listOperatorSemanticsForKey(key: string): readonly OperatorSemantics[];
    listQueryClauseSyntax(): readonly QueryClauseSyntax[];
    listSetOperatorSyntax(): readonly SetOperatorSyntax[];
    listJoinSyntax(): readonly JoinSyntax[];
    listUnsupportedSyntax(): readonly UnsupportedSyntaxSignature[];
}

export interface DialectCapabilityRegistry {
    listDialects(): readonly Dialect[];
    getDialect(id: string): DialectCapabilityView;
    hasDialect(id: string): boolean;
}
