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
 * Operator semantics for Wave 2C Pratt.
 * Lookup is (key, fixity) — the same lexical token may have multiple entries.
 * Wave 2A freezes schema + known shared keys; precedence may be null until 2C.
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
    readonly precedence: number | null;
    readonly associativity: OperatorAssociativity | null;
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
}

export interface DialectCapabilityRegistry {
    listDialects(): readonly Dialect[];
    getDialect(id: string): DialectCapabilityView;
    hasDialect(id: string): boolean;
}
