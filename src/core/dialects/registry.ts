import { EMPTY_FROZEN_ARRAY, freezeImmutableArray } from "../util/immutable-array";
import type {
    CapabilityEntry,
    CapabilityRegistry,
    JoinSyntax,
    OperatorFixity,
    OperatorFormatClass,
    OperatorForm,
    OperatorSemantics,
    QueryClauseSyntax,
    SetOperatorSyntax,
    UnsupportedSyntaxSignature,
} from "./types";

type OperatorDefinition = Readonly<{
    key: string;
    fixity: OperatorFixity;
    form: OperatorForm;
    words: readonly string[];
    precedence: number;
    associativity: "left" | "right" | "none";
}>;

const PRECEDENCE = Object.freeze({
    or: 10,
    and: 20,
    not: 25,
    predicate: 30,
    bitOr: 40,
    bitXor: 45,
    bitAnd: 50,
    additive: 60,
    access: 65,
    multiplicative: 70,
    prefix: 80,
});

function symbol(
    key: string,
    fixity: OperatorFixity,
    precedence: number,
    associativity: "left" | "right" | "none"
): OperatorDefinition {
    return Object.freeze({
        key,
        fixity,
        form: "symbol" as const,
        words: freezeImmutableArray([] as string[]),
        precedence,
        associativity,
    });
}

function wordOperator(
    key: string,
    fixity: OperatorFixity,
    form: OperatorForm,
    words: readonly string[],
    precedence: number,
    associativity: "left" | "right" | "none"
): OperatorDefinition {
    return Object.freeze({
        key,
        fixity,
        form,
        words: freezeImmutableArray(words),
        precedence,
        associativity,
    });
}

/** The complete Pratt authority. Parser code never duplicates these numbers. */
const SYMBOL_OPERATORS: readonly OperatorDefinition[] = freezeImmutableArray([
    symbol("+", "prefix", PRECEDENCE.prefix, "right"),
    symbol("+", "infix", PRECEDENCE.additive, "left"),
    symbol("-", "prefix", PRECEDENCE.prefix, "right"),
    symbol("-", "infix", PRECEDENCE.additive, "left"),
    symbol("*", "infix", PRECEDENCE.multiplicative, "left"),
    symbol("/", "infix", PRECEDENCE.multiplicative, "left"),
    symbol("%", "infix", PRECEDENCE.multiplicative, "left"),
    symbol("=", "infix", PRECEDENCE.predicate, "none"),
    symbol("==", "infix", PRECEDENCE.predicate, "none"),
    symbol("<=>", "infix", PRECEDENCE.predicate, "none"),
    symbol("<", "infix", PRECEDENCE.predicate, "none"),
    symbol(">", "infix", PRECEDENCE.predicate, "none"),
    symbol("<=", "infix", PRECEDENCE.predicate, "none"),
    symbol(">=", "infix", PRECEDENCE.predicate, "none"),
    symbol("<>", "infix", PRECEDENCE.predicate, "none"),
    symbol("!=", "infix", PRECEDENCE.predicate, "none"),
    symbol("!", "prefix", PRECEDENCE.prefix, "right"),
    symbol("~", "prefix", PRECEDENCE.prefix, "right"),
    symbol("|", "infix", PRECEDENCE.bitOr, "left"),
    symbol("^", "infix", PRECEDENCE.bitXor, "left"),
    symbol("&", "infix", PRECEDENCE.bitAnd, "left"),
    symbol("&&", "infix", PRECEDENCE.and, "left"),
    symbol("||", "infix", PRECEDENCE.access, "left"),
]);

/**
 * Keyword / compound / special operators (schema frozen for 2C).
 * Validated via lexical keyword membership, not operator token view.
 */
const WORD_OPERATORS: readonly OperatorDefinition[] = freezeImmutableArray([
    wordOperator("not", "prefix", "keyword", ["not"], PRECEDENCE.not, "right"),
    wordOperator("or", "infix", "keyword", ["or"], PRECEDENCE.or, "left"),
    wordOperator("and", "infix", "keyword", ["and"], PRECEDENCE.and, "left"),
    wordOperator("like", "infix", "keyword", ["like"], PRECEDENCE.predicate, "none"),
    wordOperator("not-like", "infix", "compound", ["not", "like"], PRECEDENCE.predicate, "none"),
    wordOperator("in", "infix", "special", ["in"], PRECEDENCE.predicate, "none"),
    wordOperator("not-in", "infix", "compound", ["not", "in"], PRECEDENCE.predicate, "none"),
    wordOperator("between", "infix", "special", ["between", "and"], PRECEDENCE.predicate, "none"),
    wordOperator("not-between", "infix", "special", ["not", "between", "and"], PRECEDENCE.predicate, "none"),
    wordOperator("is-null", "postfix", "compound", ["is", "null"], PRECEDENCE.predicate, "none"),
    wordOperator("is-not-null", "postfix", "compound", ["is", "not", "null"], PRECEDENCE.predicate, "none"),
    wordOperator("is-true", "postfix", "compound", ["is", "true"], PRECEDENCE.predicate, "none"),
    wordOperator("is-not-true", "postfix", "compound", ["is", "not", "true"], PRECEDENCE.predicate, "none"),
    wordOperator("is-false", "postfix", "compound", ["is", "false"], PRECEDENCE.predicate, "none"),
    wordOperator("is-not-false", "postfix", "compound", ["is", "not", "false"], PRECEDENCE.predicate, "none"),
    wordOperator("rlike", "infix", "keyword", ["rlike"], PRECEDENCE.predicate, "none"),
    wordOperator("not-rlike", "infix", "compound", ["not", "rlike"], PRECEDENCE.predicate, "none"),
    wordOperator("regexp", "infix", "keyword", ["regexp"], PRECEDENCE.predicate, "none"),
    wordOperator("not-regexp", "infix", "compound", ["not", "regexp"], PRECEDENCE.predicate, "none"),
]);

type FormattedCapability = Readonly<{
    id: string;
    state: "structured" | "formatted";
}>;

const FORMATTED_CAPABILITIES: readonly FormattedCapability[] = freezeImmutableArray([
    ...[
        "multi-statement",
        "with-cte",
        "from",
        "join",
        "subquery",
        "table-function",
        "lateral-view",
        "where",
        "group-by",
        "having",
        "window",
        "order-by",
        "cluster-by",
        "distribute-by",
        "sort-by",
        "limit",
        "set-operations",
        "insert-overwrite-partition-select",
        "insert-into-partition-select",
        "set-command",
        "generic-statement",
    ].map((id): FormattedCapability => Object.freeze({
        id,
        state: "formatted",
    })),
    Object.freeze({ id: "select-without-from", state: "formatted" as const }),
]);

const EXPRESSION_FORMATTED: readonly string[] = freezeImmutableArray([
    "case-expression",
    "function-call",
    "collection-expression",
    "cast-type",
    "subquery-expression",
    "window-expression",
]);

const EXPRESSION_STRUCTURED: readonly string[] = freezeImmutableArray([
    "template-parameter",
]);

const QUERY_CLAUSES: readonly QueryClauseSyntax[] = freezeImmutableArray([
    Object.freeze({ id: "select", words: freezeImmutableArray(["select"]), order: 0, capabilityId: null }),
    Object.freeze({ id: "from", words: freezeImmutableArray(["from"]), order: 10, capabilityId: "from" }),
    Object.freeze({ id: "where", words: freezeImmutableArray(["where"]), order: 20, capabilityId: "where" }),
    Object.freeze({ id: "group-by", words: freezeImmutableArray(["group", "by"]), order: 30, capabilityId: "group-by" }),
    Object.freeze({ id: "having", words: freezeImmutableArray(["having"]), order: 40, capabilityId: "having" }),
    Object.freeze({ id: "window", words: freezeImmutableArray(["window"]), order: 50, capabilityId: "window" }),
    Object.freeze({ id: "order-by", words: freezeImmutableArray(["order", "by"]), order: 60, capabilityId: "order-by" }),
    Object.freeze({ id: "cluster-by", words: freezeImmutableArray(["cluster", "by"]), order: 70, capabilityId: "cluster-by" }),
    Object.freeze({ id: "distribute-by", words: freezeImmutableArray(["distribute", "by"]), order: 80, capabilityId: "distribute-by" }),
    Object.freeze({ id: "sort-by", words: freezeImmutableArray(["sort", "by"]), order: 90, capabilityId: "sort-by" }),
    Object.freeze({ id: "limit", words: freezeImmutableArray(["limit"]), order: 100, capabilityId: "limit" }),
]);

const SET_OPERATORS: readonly SetOperatorSyntax[] = freezeImmutableArray([
    Object.freeze({ id: "union", word: "union", capabilityId: "set-operations" }),
    Object.freeze({ id: "intersect", word: "intersect", capabilityId: "set-operations" }),
    Object.freeze({ id: "except", word: "except", capabilityId: "set-operations" }),
]);

const JOIN_SYNTAX: readonly JoinSyntax[] = freezeImmutableArray([
    Object.freeze({ id: "join", words: freezeImmutableArray(["join"]), capabilityId: "join" }),
    Object.freeze({ id: "cross-join", words: freezeImmutableArray(["cross", "join"]), capabilityId: "join" }),
    Object.freeze({ id: "full-join", words: freezeImmutableArray(["full", "join"]), capabilityId: "join" }),
    Object.freeze({ id: "full-outer-join", words: freezeImmutableArray(["full", "outer", "join"]), capabilityId: "join" }),
    Object.freeze({ id: "inner-join", words: freezeImmutableArray(["inner", "join"]), capabilityId: "join" }),
    Object.freeze({ id: "left-join", words: freezeImmutableArray(["left", "join"]), capabilityId: "join" }),
    Object.freeze({ id: "left-outer-join", words: freezeImmutableArray(["left", "outer", "join"]), capabilityId: "join" }),
    Object.freeze({ id: "right-join", words: freezeImmutableArray(["right", "join"]), capabilityId: "join" }),
    Object.freeze({ id: "right-outer-join", words: freezeImmutableArray(["right", "outer", "join"]), capabilityId: "join" }),
    Object.freeze({ id: "left-semi-join", words: freezeImmutableArray(["left", "semi", "join"]), capabilityId: "join" }),
    Object.freeze({ id: "left-anti-join", words: freezeImmutableArray(["left", "anti", "join"]), capabilityId: "join" }),
]);

const UNSUPPORTED_SYNTAX: readonly UnsupportedSyntaxSignature[] = freezeImmutableArray([
    Object.freeze({
        capabilityId: "merge",
        context: "statement-start" as const,
        words: freezeImmutableArray(["merge"]),
        order: null,
        bodyEvidence: null,
    }),
    Object.freeze({
        capabilityId: "match-recognize",
        context: "relation-suffix" as const,
        words: freezeImmutableArray(["match_recognize"]),
        order: null,
        bodyEvidence: freezeImmutableArray([
            freezeImmutableArray(["pattern", "("]),
        ]),
    }),
    Object.freeze({
        capabilityId: "pivot",
        context: "relation-suffix" as const,
        words: freezeImmutableArray(["pivot"]),
        order: null,
        bodyEvidence: freezeImmutableArray([
            freezeImmutableArray(["(", "for", "in", "("]),
        ]),
    }),
    Object.freeze({
        capabilityId: "unpivot",
        context: "relation-suffix" as const,
        words: freezeImmutableArray(["unpivot"]),
        order: null,
        bodyEvidence: freezeImmutableArray([freezeImmutableArray(["for", "in", "("])]),
    }),
    Object.freeze({
        capabilityId: "unpivot",
        context: "relation-suffix" as const,
        words: freezeImmutableArray(["unpivot", "include", "nulls"]),
        order: null,
        bodyEvidence: freezeImmutableArray([freezeImmutableArray(["for", "in", "("])]),
    }),
    Object.freeze({
        capabilityId: "unpivot",
        context: "relation-suffix" as const,
        words: freezeImmutableArray(["unpivot", "exclude", "nulls"]),
        order: null,
        bodyEvidence: freezeImmutableArray([freezeImmutableArray(["for", "in", "("])]),
    }),
    Object.freeze({
        capabilityId: "qualify",
        context: "query-clause" as const,
        words: freezeImmutableArray(["qualify"]),
        order: 55,
        bodyEvidence: null,
    }),
    ...(["explain", "update", "delete"] as const).map((word) => Object.freeze({
        capabilityId: word,
        context: "statement-start" as const,
        words: freezeImmutableArray([word]),
        order: null,
        bodyEvidence: null,
    })),
    ...["create", "alter", "drop", "truncate"].map((word) => Object.freeze({
        capabilityId: "hive-ddl",
        context: "statement-start" as const,
        words: freezeImmutableArray([word]),
        order: null,
        bodyEvidence: null,
    })),
    Object.freeze({
        capabilityId: "grouping-sets",
        context: "group-by-suffix" as const,
        words: freezeImmutableArray(["grouping", "sets"]),
        order: null,
        bodyEvidence: null,
    }),
    Object.freeze({
        capabilityId: "transform",
        context: "select-item-prefix" as const,
        words: freezeImmutableArray(["transform"]),
        order: null,
        bodyEvidence: null,
    }),
]);

const PRESERVATION_CAPABILITIES: readonly Readonly<{
    id: string;
    state: "verbatim" | "diagnostic";
}>[] = freezeImmutableArray([
    Object.freeze({ id: "delete", state: "verbatim" as const }),
    Object.freeze({ id: "explain", state: "verbatim" as const }),
    Object.freeze({ id: "grouping-sets", state: "verbatim" as const }),
    Object.freeze({ id: "hive-ddl", state: "verbatim" as const }),
    Object.freeze({ id: "transform", state: "verbatim" as const }),
    Object.freeze({ id: "update", state: "verbatim" as const }),
    Object.freeze({ id: "merge", state: "diagnostic" as const }),
    Object.freeze({ id: "match-recognize", state: "diagnostic" as const }),
    Object.freeze({ id: "pivot", state: "diagnostic" as const }),
    Object.freeze({ id: "qualify", state: "diagnostic" as const }),
    Object.freeze({ id: "unpivot", state: "diagnostic" as const }),
]);

const CAPABILITIES: readonly CapabilityEntry[] = freezeImmutableArray([
    ...FORMATTED_CAPABILITIES,
    ...EXPRESSION_FORMATTED.map((id) => Object.freeze({ id, state: "formatted" as const })),
    ...EXPRESSION_STRUCTURED.map((id) => Object.freeze({ id, state: "structured" as const })),
    ...PRESERVATION_CAPABILITIES,
].map(({ id, state }) => Object.freeze({ id, state })));

function operatorFormatClass(item: OperatorDefinition): OperatorFormatClass {
    const word = item.form !== "symbol";
    if (item.fixity === "prefix") {
        return word ? "prefix-word" : "prefix-symbol";
    }
    if (item.fixity === "postfix") {
        return word ? "postfix-word" : "postfix-symbol";
    }
    if (item.key === "and" || item.key === "or") {
        return "infix-word-continuation";
    }
    return word ? "infix-word" : "infix-symbol";
}

const OPERATORS: readonly OperatorSemantics[] = freezeImmutableArray(
    [...SYMBOL_OPERATORS, ...WORD_OPERATORS].map((item) => Object.freeze({
        ...item,
        id: `${item.fixity}:${item.key}`,
        formatClass: operatorFormatClass(item),
    }))
);

function createRegistry(): CapabilityRegistry {
    const capabilityById = new Map(CAPABILITIES.map((c) => [c.id, c]));
    const operatorsByKeyFixity = new Map<string, OperatorSemantics>();
    const operatorsByKey = new Map<string, OperatorSemantics[]>();

    for (const op of OPERATORS) {
        operatorsByKeyFixity.set(`${op.key}\0${op.fixity}`, op);
        const list = operatorsByKey.get(op.key) ?? [];
        list.push(op);
        operatorsByKey.set(op.key, list);
    }

    // Cache frozen per-key lists
    const frozenByKey = new Map<string, readonly OperatorSemantics[]>();
    for (const [key, list] of operatorsByKey) {
        frozenByKey.set(key, freezeImmutableArray(list));
    }

    return Object.freeze({
        getCapability(id: string): CapabilityEntry | null {
            return capabilityById.get(id) ?? null;
        },
        getOperatorSemantics(key: string, fixity: OperatorFixity): OperatorSemantics | null {
            return operatorsByKeyFixity.get(`${key}\0${fixity}`) ?? null;
        },
        listOperatorSemantics(): readonly OperatorSemantics[] {
            return OPERATORS;
        },
        listOperatorSemanticsForKey(key: string): readonly OperatorSemantics[] {
            return frozenByKey.get(key) ?? (EMPTY_FROZEN_ARRAY as readonly OperatorSemantics[]);
        },
        listQueryClauseSyntax(): readonly QueryClauseSyntax[] {
            return QUERY_CLAUSES;
        },
        listSetOperatorSyntax(): readonly SetOperatorSyntax[] {
            return SET_OPERATORS;
        },
        listJoinSyntax(): readonly JoinSyntax[] {
            return JOIN_SYNTAX;
        },
        listUnsupportedSyntax(): readonly UnsupportedSyntaxSignature[] {
            return UNSUPPORTED_SYNTAX;
        },
    });
}

/** Hive capability states, operator semantics and clause syntax. */
export const HIVE_REGISTRY: CapabilityRegistry = createRegistry();
