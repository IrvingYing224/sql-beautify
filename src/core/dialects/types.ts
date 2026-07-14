import type { Dialect } from "../config/options";

/**
 * Capability state is a fact about current implementation status.
 * Wave 2A must not declare `formatted` (reserved for Wave 3).
 */
export type CapabilityState =
    | "recognized"
    | "structured"
    | "formatted"
    | "verbatim"
    | "diagnostic";

export type OperatorFixity = "prefix" | "infix" | "postfix";
export type OperatorAssociativity = "left" | "right" | "none";

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
    readonly capabilityId: string;
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
}

export interface DialectCapabilityRegistry {
    listDialects(): readonly Dialect[];
    getDialect(id: string): DialectCapabilityView;
    hasDialect(id: string): boolean;
}
