import type { Dialect } from "../config/options";
import { getLexicalProfile } from "../lexer/lexical-profile";
import { EMPTY_FROZEN_ARRAY, freezeImmutableArray } from "../util/immutable-array";
import { isRecognizedCapabilityState } from "./capability-state";
import type {
    CapabilityEntry,
    CapabilityState,
    DialectCapabilityRegistry,
    DialectCapabilityView,
    JoinSyntax,
    OperatorFixity,
    OperatorFormatClass,
    OperatorForm,
    OperatorSemantics,
    QueryClauseSyntax,
    SetOperatorSyntax,
    UnsupportedSyntaxSignature,
} from "./types";

const CANONICAL_DIALECTS: readonly Dialect[] = freezeImmutableArray([
    "hive",
    "generic",
    "postgresql",
    "mysql",
]);

const CANONICAL_SET = new Set<string>(CANONICAL_DIALECTS);

const CAPABILITY_STATES: ReadonlySet<CapabilityState> = new Set([
    "recognized",
    "structured",
    "formatted",
    "verbatim",
    "diagnostic",
]);

const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

type OperatorDefinition = Readonly<{
    key: string;
    fixity: OperatorFixity;
    form: OperatorForm;
    words: readonly string[];
    precedence: number;
    associativity: "left" | "right" | "none";
}>;

const PRECEDENCE = Object.freeze({
    assignment: 5,
    or: 10,
    and: 20,
    not: 25,
    predicate: 30,
    // PostgreSQL assigns every non-special symbolic operator one shared tier:
    // below + / - and above comparison/predicate operators.
    otherOperator: 35,
    bitOr: 40,
    bitXor: 45,
    bitAnd: 50,
    shift: 55,
    additive: 60,
    access: 65,
    multiplicative: 70,
    power: 75,
    prefix: 80,
    postfix: 90,
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

/** The complete shared Pratt authority. Parser code never duplicates these numbers. */
const SHARED_SYMBOL_OPERATORS: readonly OperatorDefinition[] = freezeImmutableArray([
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
]);

const NON_POSTGRES_BITWISE_SYMBOL_OPERATORS: readonly OperatorDefinition[] =
    freezeImmutableArray([
        symbol("|", "infix", PRECEDENCE.bitOr, "left"),
        symbol("^", "infix", PRECEDENCE.bitXor, "left"),
        symbol("&", "infix", PRECEDENCE.bitAnd, "left"),
        symbol("<<", "infix", PRECEDENCE.shift, "left"),
        symbol(">>", "infix", PRECEDENCE.shift, "left"),
    ]);

const LOGICAL_AND_SYMBOL_OPERATOR: readonly OperatorDefinition[] = freezeImmutableArray([
    symbol("&&", "infix", PRECEDENCE.and, "left"),
]);

/**
 * Keyword / compound / special operators (schema frozen for 2C).
 * Validated via lexical keyword membership, not operator token view.
 */
const SHARED_WORD_OPERATORS: readonly OperatorDefinition[] = freezeImmutableArray([
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
]);

const HIVE_WORD_OPERATORS: readonly OperatorDefinition[] = freezeImmutableArray([
    wordOperator("rlike", "infix", "keyword", ["rlike"], PRECEDENCE.predicate, "none"),
    wordOperator("not-rlike", "infix", "compound", ["not", "rlike"], PRECEDENCE.predicate, "none"),
    wordOperator("regexp", "infix", "keyword", ["regexp"], PRECEDENCE.predicate, "none"),
    wordOperator("not-regexp", "infix", "compound", ["not", "regexp"], PRECEDENCE.predicate, "none"),
]);

const MYSQL_WORD_OPERATORS: readonly OperatorDefinition[] = freezeImmutableArray([
    wordOperator("regexp", "infix", "keyword", ["regexp"], PRECEDENCE.predicate, "none"),
    wordOperator("not-regexp", "infix", "compound", ["not", "regexp"], PRECEDENCE.predicate, "none"),
]);

const POSTGRES_WORD_OPERATORS: readonly OperatorDefinition[] = freezeImmutableArray([
    wordOperator("ilike", "infix", "keyword", ["ilike"], PRECEDENCE.predicate, "none"),
    wordOperator("not-ilike", "infix", "compound", ["not", "ilike"], PRECEDENCE.predicate, "none"),
]);

const CONCAT_SYMBOL_OPERATOR: readonly OperatorDefinition[] = freezeImmutableArray([
    symbol("||", "infix", PRECEDENCE.access, "left"),
]);

const POSTGRES_SYMBOL_OPERATORS: readonly OperatorDefinition[] = freezeImmutableArray([
    symbol("^", "infix", PRECEDENCE.power, "left"),
    symbol("|", "infix", PRECEDENCE.otherOperator, "left"),
    symbol("&", "infix", PRECEDENCE.otherOperator, "left"),
    symbol("<<", "infix", PRECEDENCE.otherOperator, "left"),
    symbol(">>", "infix", PRECEDENCE.otherOperator, "left"),
    symbol("||", "infix", PRECEDENCE.otherOperator, "left"),
    symbol("&&", "infix", PRECEDENCE.otherOperator, "left"),
    symbol("->", "infix", PRECEDENCE.otherOperator, "left"),
    symbol("->>", "infix", PRECEDENCE.otherOperator, "left"),
    symbol("#", "infix", PRECEDENCE.otherOperator, "left"),
    symbol("#>", "infix", PRECEDENCE.otherOperator, "left"),
    symbol("#>>", "infix", PRECEDENCE.otherOperator, "left"),
    symbol("@>", "infix", PRECEDENCE.otherOperator, "left"),
    symbol("<@", "infix", PRECEDENCE.otherOperator, "left"),
    symbol("?", "infix", PRECEDENCE.otherOperator, "left"),
    symbol("?|", "infix", PRECEDENCE.otherOperator, "left"),
    symbol("?&", "infix", PRECEDENCE.otherOperator, "left"),
    symbol("@?", "infix", PRECEDENCE.otherOperator, "left"),
    symbol("@@", "infix", PRECEDENCE.otherOperator, "left"),
    symbol("~~", "infix", PRECEDENCE.otherOperator, "left"),
    symbol("!~~", "infix", PRECEDENCE.otherOperator, "left"),
    symbol("~~*", "infix", PRECEDENCE.otherOperator, "left"),
    symbol("!~~*", "infix", PRECEDENCE.otherOperator, "left"),
    symbol("~", "infix", PRECEDENCE.otherOperator, "left"),
    symbol("~*", "infix", PRECEDENCE.otherOperator, "left"),
    symbol("!~", "infix", PRECEDENCE.otherOperator, "left"),
    symbol("!~*", "infix", PRECEDENCE.otherOperator, "left"),
    symbol("::", "postfix", PRECEDENCE.postfix, "left"),
]);

const MYSQL_SYMBOL_OPERATORS: readonly OperatorDefinition[] = freezeImmutableArray([
    symbol("->", "infix", PRECEDENCE.access, "left"),
    symbol("->>", "infix", PRECEDENCE.access, "left"),
    symbol(":=", "infix", PRECEDENCE.assignment, "right"),
    symbol("||", "infix", PRECEDENCE.or, "left"),
]);

type HiveQueryCapability = Readonly<{
    id: string;
    state: "structured" | "formatted";
}>;

const HIVE_QUERY_CAPABILITIES: readonly HiveQueryCapability[] = freezeImmutableArray([
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
    ].map((id): HiveQueryCapability => Object.freeze({
        id,
        state: "formatted",
    })),
    Object.freeze({ id: "select-without-from", state: "formatted" as const }),
]);

const HIVE_EXPRESSION_FORMATTED: readonly string[] = freezeImmutableArray([
    "case-expression",
    "function-call",
    "collection-expression",
    "cast-type",
    "subquery-expression",
    "window-expression",
]);

const HIVE_EXPRESSION_STRUCTURED: readonly string[] = freezeImmutableArray([
    "template-parameter",
]);

const SHARED_QUERY_CLAUSES: readonly QueryClauseSyntax[] = freezeImmutableArray([
    Object.freeze({ id: "select", words: freezeImmutableArray(["select"]), order: 0, capabilityId: null }),
    Object.freeze({ id: "from", words: freezeImmutableArray(["from"]), order: 10, capabilityId: "from" }),
    Object.freeze({ id: "where", words: freezeImmutableArray(["where"]), order: 20, capabilityId: "where" }),
    Object.freeze({ id: "group-by", words: freezeImmutableArray(["group", "by"]), order: 30, capabilityId: "group-by" }),
    Object.freeze({ id: "having", words: freezeImmutableArray(["having"]), order: 40, capabilityId: "having" }),
    Object.freeze({ id: "window", words: freezeImmutableArray(["window"]), order: 50, capabilityId: "window" }),
    Object.freeze({ id: "order-by", words: freezeImmutableArray(["order", "by"]), order: 60, capabilityId: "order-by" }),
    Object.freeze({ id: "limit", words: freezeImmutableArray(["limit"]), order: 100, capabilityId: "limit" }),
]);

const HIVE_QUERY_CLAUSES: readonly QueryClauseSyntax[] = freezeImmutableArray([
    ...SHARED_QUERY_CLAUSES.slice(0, SHARED_QUERY_CLAUSES.length - 1),
    Object.freeze({ id: "cluster-by", words: freezeImmutableArray(["cluster", "by"]), order: 70, capabilityId: "cluster-by" }),
    Object.freeze({ id: "distribute-by", words: freezeImmutableArray(["distribute", "by"]), order: 80, capabilityId: "distribute-by" }),
    Object.freeze({ id: "sort-by", words: freezeImmutableArray(["sort", "by"]), order: 90, capabilityId: "sort-by" }),
    SHARED_QUERY_CLAUSES[SHARED_QUERY_CLAUSES.length - 1]!,
]);

const SHARED_SET_OPERATORS: readonly SetOperatorSyntax[] = freezeImmutableArray([
    Object.freeze({ id: "union", word: "union", capabilityId: "set-operations" }),
    Object.freeze({ id: "intersect", word: "intersect", capabilityId: "set-operations" }),
    Object.freeze({ id: "except", word: "except", capabilityId: "set-operations" }),
]);

const SHARED_JOIN_SYNTAX: readonly JoinSyntax[] = freezeImmutableArray([
    Object.freeze({ id: "join", words: freezeImmutableArray(["join"]), capabilityId: "join" }),
    Object.freeze({ id: "cross-join", words: freezeImmutableArray(["cross", "join"]), capabilityId: "join" }),
    Object.freeze({ id: "full-join", words: freezeImmutableArray(["full", "join"]), capabilityId: "join" }),
    Object.freeze({ id: "full-outer-join", words: freezeImmutableArray(["full", "outer", "join"]), capabilityId: "join" }),
    Object.freeze({ id: "inner-join", words: freezeImmutableArray(["inner", "join"]), capabilityId: "join" }),
    Object.freeze({ id: "left-join", words: freezeImmutableArray(["left", "join"]), capabilityId: "join" }),
    Object.freeze({ id: "left-outer-join", words: freezeImmutableArray(["left", "outer", "join"]), capabilityId: "join" }),
    Object.freeze({ id: "right-join", words: freezeImmutableArray(["right", "join"]), capabilityId: "join" }),
    Object.freeze({ id: "right-outer-join", words: freezeImmutableArray(["right", "outer", "join"]), capabilityId: "join" }),
]);

const HIVE_JOIN_SYNTAX: readonly JoinSyntax[] = freezeImmutableArray([
    ...SHARED_JOIN_SYNTAX,
    Object.freeze({ id: "left-semi-join", words: freezeImmutableArray(["left", "semi", "join"]), capabilityId: "join" }),
    Object.freeze({ id: "left-anti-join", words: freezeImmutableArray(["left", "anti", "join"]), capabilityId: "join" }),
]);

const SHARED_UNSUPPORTED_SYNTAX: readonly UnsupportedSyntaxSignature[] = freezeImmutableArray([
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
]);

const HIVE_UNSUPPORTED_SYNTAX: readonly UnsupportedSyntaxSignature[] = freezeImmutableArray([
    ...SHARED_UNSUPPORTED_SYNTAX,
    ...["create", "alter", "drop", "truncate"].map((word) => Object.freeze({
        capabilityId: "hive-ddl",
        context: "statement-start" as const,
        words: freezeImmutableArray([word]),
        order: null,
        bodyEvidence: null,
    })),
]);

const SHARED_PRESERVATION_CAPABILITIES: readonly Readonly<{
    id: string;
    state: "diagnostic";
}>[] = freezeImmutableArray([
    Object.freeze({ id: "merge", state: "diagnostic" as const }),
    Object.freeze({ id: "match-recognize", state: "diagnostic" as const }),
    Object.freeze({ id: "pivot", state: "diagnostic" as const }),
    Object.freeze({ id: "qualify", state: "diagnostic" as const }),
    Object.freeze({ id: "unpivot", state: "diagnostic" as const }),
]);

const HIVE_PRESERVATION_CAPABILITIES: readonly Readonly<{
    id: string;
    state: "verbatim" | "diagnostic";
}>[] = freezeImmutableArray([
    Object.freeze({ id: "hive-ddl", state: "verbatim" as const }),
    ...SHARED_PRESERVATION_CAPABILITIES,
]);

const SHARED_STRUCTURED_CAPABILITIES: readonly string[] = freezeImmutableArray([
    "multi-statement",
    "with-cte",
    "select-without-from",
    "from",
    "join",
    "subquery",
    "table-function",
    "where",
    "group-by",
    "having",
    "window",
    "order-by",
    "limit",
    "set-operations",
    "case-expression",
    "function-call",
    "cast-type",
    "subquery-expression",
    "window-expression",
]);

function freezeEntry(id: string, state: CapabilityState, notes?: string): CapabilityEntry {
    if (!KEBAB_CASE.test(id)) {
        throw new Error(`Invalid capability id (expected kebab-case): ${id}`);
    }
    if (!CAPABILITY_STATES.has(state)) {
        throw new Error(`Invalid capability state for ${id}: ${state}`);
    }
    return notes
        ? Object.freeze({ id, state, notes })
        : Object.freeze({ id, state });
}

function buildCapabilityList(
    recognized: readonly string[],
    extra: readonly Readonly<{ id: string; state: CapabilityState; notes?: string }>[] = []
): readonly CapabilityEntry[] {
    const map = new Map<string, CapabilityEntry>();
    for (const id of recognized) {
        if (map.has(id)) {
            throw new Error(`Duplicate capability id: ${id}`);
        }
        map.set(id, freezeEntry(id, "recognized"));
    }
    for (const item of extra) {
        if (map.has(item.id)) {
            throw new Error(`Duplicate capability id: ${item.id}`);
        }
        map.set(item.id, freezeEntry(item.id, item.state, item.notes));
    }
    return freezeImmutableArray(Array.from(map.values()));
}

function buildOperatorList(dialect: Dialect): readonly OperatorSemantics[] {
    const profile = getLexicalProfile(dialect);
    const lexicalOps = new Set(profile.operators);
    const entries: OperatorSemantics[] = [];

    const definitions = [
        ...SHARED_SYMBOL_OPERATORS,
        ...(dialect === "postgresql" ? [] : NON_POSTGRES_BITWISE_SYMBOL_OPERATORS),
        ...(dialect === "postgresql" ? [] : LOGICAL_AND_SYMBOL_OPERATOR),
        ...SHARED_WORD_OPERATORS,
        ...(dialect === "mysql" || dialect === "postgresql"
            ? []
            : CONCAT_SYMBOL_OPERATOR),
        ...(dialect === "hive" ? HIVE_WORD_OPERATORS : []),
        ...(dialect === "mysql" ? MYSQL_WORD_OPERATORS : []),
        ...(dialect === "postgresql" ? POSTGRES_WORD_OPERATORS : []),
        ...(dialect === "postgresql" ? POSTGRES_SYMBOL_OPERATORS : []),
        ...(dialect === "mysql" ? MYSQL_SYMBOL_OPERATORS : []),
    ];
    const identities = new Set<string>();
    for (const item of definitions) {
        if (item.form === "symbol" && !lexicalOps.has(item.key)) {
            continue;
        }
        for (const word of item.words) {
            if (
                !profile.keywords.has(word.toUpperCase()) &&
                !profile.syntaxOperatorWords.has(word)
            ) {
                // Keyword not in profile — skip this word operator for dialect.
                // BETWEEN/AND/NOT/IN/IS are in COMMON_KEYWORDS for all dialects.
                throw new Error(
                    `Word operator "${item.key}" requires keyword "${word}" in lexical profile for ${dialect}`
                );
            }
        }
        const identity = `${item.key}\0${item.fixity}`;
        if (identities.has(identity)) {
            continue;
        }
        identities.add(identity);
        const capabilityId = operatorCapabilityId(dialect, item.key);
        const formatClass = operatorFormatClass(item);
        entries.push(Object.freeze({
            ...item,
            id: `${item.fixity}:${item.key}`,
            words: freezeImmutableArray(item.words),
            capabilityId,
            formatClass,
        }));
    }

    return freezeImmutableArray(entries);
}

function operatorCapabilityId(dialect: Dialect, key: string): string | null {
    if (dialect === "postgresql") {
        if (key === "::") {
            return "postgres-type-cast";
        }
        if (
            key === "->" ||
            key === "->>" ||
            key === "#>" ||
            key === "#>>" ||
            key === "@>" ||
            key === "<@" ||
            key === "?" ||
            key === "?|" ||
            key === "?&" ||
            key === "@?" ||
            key === "@@"
        ) {
            return "postgres-json-operators";
        }
    }
    if (dialect === "mysql" && (key === "->" || key === "->>")) {
        return "mysql-json-operators";
    }
    return null;
}

function operatorFormatClass(item: OperatorDefinition): OperatorFormatClass {
    if (item.key === "::") {
        return "attached";
    }
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

function validateSyntaxLists(
    dialect: Dialect,
    capabilityById: ReadonlyMap<string, CapabilityEntry>,
    queryClauses: readonly QueryClauseSyntax[],
    setOperators: readonly SetOperatorSyntax[],
    joins: readonly JoinSyntax[],
    unsupported: readonly UnsupportedSyntaxSignature[]
): void {
    const clauseIds = new Set<string>();
    let previousOrder = Number.NEGATIVE_INFINITY;
    for (const clause of queryClauses) {
        const capability =
            clause.capabilityId === null
                ? null
                : capabilityById.get(clause.capabilityId);
        if (
            clauseIds.has(clause.id) ||
            !Number.isInteger(clause.order) ||
            clause.order <= previousOrder ||
            clause.words.length === 0 ||
            !clause.words.every(
                (word) =>
                    word === word.toLowerCase() &&
                    /^[a-z_]+$/.test(word)
            ) ||
            (clause.id === "select"
                ? clause.capabilityId !== null
                : clause.capabilityId === null ||
                  capability === null ||
                  capability === undefined ||
                  !isRecognizedCapabilityState(capability.state))
        ) {
            throw new Error(`Invalid query clause syntax for ${dialect}: ${clause.id}`);
        }
        clauseIds.add(clause.id);
        previousOrder = clause.order;
    }
    if (!clauseIds.has("select")) {
        throw new Error(`Dialect ${dialect} query clause syntax must include SELECT`);
    }

    const setIds = new Set<string>();
    const setWords = new Set<string>();
    for (const operator of setOperators) {
        const capability = capabilityById.get(operator.capabilityId);
        if (
            setIds.has(operator.id) ||
            setWords.has(operator.word) ||
            operator.word !== operator.word.toLowerCase() ||
            !/^[a-z_]+$/.test(operator.word) ||
            !capability ||
            !isRecognizedCapabilityState(capability.state)
        ) {
            throw new Error(`Invalid set operator syntax for ${dialect}: ${operator.id}`);
        }
        setIds.add(operator.id);
        setWords.add(operator.word);
    }

    const joinIds = new Set<string>();
    const joinHeads = new Set<string>();
    for (const join of joins) {
        const head = join.words.join(" ");
        const capability = capabilityById.get(join.capabilityId);
        if (
            joinIds.has(join.id) ||
            joinHeads.has(head) ||
            join.words.length === 0 ||
            join.words[join.words.length - 1] !== "join" ||
            !join.words.every(
                (word) => word === word.toLowerCase() && /^[a-z_]+$/.test(word)
            ) ||
            !capability ||
            !isRecognizedCapabilityState(capability.state)
        ) {
            throw new Error(`Invalid JOIN syntax for ${dialect}: ${join.id}`);
        }
        joinIds.add(join.id);
        joinHeads.add(head);
    }

    const unsupportedKeys = new Set<string>();
    for (const signature of unsupported) {
        const capability = capabilityById.get(signature.capabilityId);
        const key = `${signature.context}\0${signature.words.join("\0")}`;
        if (
            unsupportedKeys.has(key) ||
            signature.words.length === 0 ||
            !signature.words.every(
                (word) => word === word.toLowerCase() && /^[a-z_]+$/.test(word)
            ) ||
            !capability ||
            (capability.state !== "verbatim" && capability.state !== "diagnostic") ||
            (signature.context === "query-clause"
                ? !Number.isInteger(signature.order)
                : signature.order !== null) ||
            (signature.context === "relation-suffix"
                ? signature.bodyEvidence === null ||
                    signature.bodyEvidence.length === 0 ||
                    signature.bodyEvidence.some(
                        (sequence) =>
                            sequence.length === 0 ||
                            !sequence.every(
                                (token) =>
                                    token === token.toLowerCase() &&
                                    /^(?:[a-z_]+|\()$/.test(token)
                            )
                    )
                : signature.bodyEvidence !== null)
        ) {
            throw new Error(
                `Invalid unsupported syntax for ${dialect}: ${signature.capabilityId}`
            );
        }
        unsupportedKeys.add(key);
    }
}

function createDialectView(
    dialect: Dialect,
    capabilities: readonly CapabilityEntry[],
    operators: readonly OperatorSemantics[],
    queryClauses: readonly QueryClauseSyntax[],
    setOperators: readonly SetOperatorSyntax[],
    joins: readonly JoinSyntax[],
    unsupported: readonly UnsupportedSyntaxSignature[]
): DialectCapabilityView {
    const capabilityById = new Map(capabilities.map((c) => [c.id, c]));
    validateSyntaxLists(
        dialect,
        capabilityById,
        queryClauses,
        setOperators,
        joins,
        unsupported
    );
    const operatorsByKeyFixity = new Map<string, OperatorSemantics>();
    const operatorsByKey = new Map<string, OperatorSemantics[]>();
    const recognitionSignatures = new Set<string>();
    const operatorIds = new Set<string>();

    for (const op of operators) {
        const mapKey = `${op.key}\0${op.fixity}`;
        const recognitionSignature =
            op.form === "symbol"
                ? `${op.fixity}\0symbol\0${op.key}`
                : `${op.fixity}\0words\0${op.words.join("\0")}`;
        if (
            typeof op.id !== "string" ||
            op.id.length === 0 ||
            operatorIds.has(op.id) ||
            operatorsByKeyFixity.has(mapKey) ||
            recognitionSignatures.has(recognitionSignature) ||
            !Number.isInteger(op.precedence) ||
            op.precedence <= 0 ||
            (op.associativity !== "left" &&
                op.associativity !== "right" &&
                op.associativity !== "none") ||
            (op.form === "symbol" ? op.words.length !== 0 : op.words.length === 0) ||
            (op.capabilityId !== null &&
                (capabilityById.get(op.capabilityId) === undefined ||
                    !isRecognizedCapabilityState(
                        capabilityById.get(op.capabilityId)!.state
                    ))) ||
            (op.formatClass !== "prefix-word" &&
                op.formatClass !== "prefix-symbol" &&
                op.formatClass !== "infix-word" &&
                op.formatClass !== "infix-word-continuation" &&
                op.formatClass !== "infix-symbol" &&
                op.formatClass !== "postfix-word" &&
                op.formatClass !== "postfix-symbol" &&
                op.formatClass !== "attached")
        ) {
            throw new Error(
                `Invalid or conflicting operator semantics for ${dialect}: ${op.key} / ${op.fixity}`
            );
        }
        operatorIds.add(op.id);
        recognitionSignatures.add(recognitionSignature);
        operatorsByKeyFixity.set(mapKey, op);
        const list = operatorsByKey.get(op.key) ?? [];
        list.push(op);
        operatorsByKey.set(op.key, list);
    }

    // Cache frozen per-key lists
    const frozenByKey = new Map<string, readonly OperatorSemantics[]>();
    for (const [key, list] of operatorsByKey) {
        frozenByKey.set(key, freezeImmutableArray(list));
    }

    const view: DialectCapabilityView = Object.freeze({
        id: dialect,
        getCapability(id: string): CapabilityEntry | null {
            return capabilityById.get(id) ?? null;
        },
        listCapabilities(): readonly CapabilityEntry[] {
            return capabilities;
        },
        getOperatorSemantics(key: string, fixity: OperatorFixity): OperatorSemantics | null {
            return operatorsByKeyFixity.get(`${key}\0${fixity}`) ?? null;
        },
        listOperatorSemantics(): readonly OperatorSemantics[] {
            return operators;
        },
        listOperatorSemanticsForKey(key: string): readonly OperatorSemantics[] {
            return frozenByKey.get(key) ?? (EMPTY_FROZEN_ARRAY as readonly OperatorSemantics[]);
        },
        listQueryClauseSyntax(): readonly QueryClauseSyntax[] {
            return queryClauses;
        },
        listSetOperatorSyntax(): readonly SetOperatorSyntax[] {
            return setOperators;
        },
        listJoinSyntax(): readonly JoinSyntax[] {
            return joins;
        },
        listUnsupportedSyntax(): readonly UnsupportedSyntaxSignature[] {
            return unsupported;
        },
    });
    return view;
}

function buildRegistry(): DialectCapabilityRegistry {
    const views = new Map<Dialect, DialectCapabilityView>();

    views.set(
        "hive",
        createDialectView(
            "hive",
            buildCapabilityList(
                [],
                freezeImmutableArray([
                    ...HIVE_QUERY_CAPABILITIES,
                    ...HIVE_EXPRESSION_FORMATTED.map((id) => Object.freeze({
                        id,
                        state: "formatted" as const,
                    })),
                    ...HIVE_EXPRESSION_STRUCTURED.map((id) => Object.freeze({
                        id,
                        state: "structured" as const,
                    })),
                    ...HIVE_PRESERVATION_CAPABILITIES,
                ])
            ),
            buildOperatorList("hive"),
            HIVE_QUERY_CLAUSES,
            SHARED_SET_OPERATORS,
            HIVE_JOIN_SYNTAX,
            HIVE_UNSUPPORTED_SYNTAX
        )
    );

    for (const dialect of ["generic", "postgresql", "mysql"] as const) {
        const extra: Readonly<{ id: string; state: CapabilityState }>[] =
            dialect === "postgresql"
                ? [
                      { id: "postgres-json-operators", state: "structured" },
                      { id: "postgres-type-cast", state: "structured" },
                      { id: "postgres-array-subset", state: "structured" },
                  ]
                : dialect === "mysql"
                  ? [
                        { id: "mysql-variables", state: "structured" },
                        { id: "mysql-prefixed-literals", state: "structured" },
                        { id: "mysql-json-operators", state: "structured" },
                    ]
                  : [{ id: "generic-array-subset", state: "structured" }];

        views.set(
            dialect,
            createDialectView(
                dialect,
                buildCapabilityList(
                    [],
                    freezeImmutableArray([
                        ...SHARED_STRUCTURED_CAPABILITIES.map((id) => Object.freeze({
                            id,
                            state: "structured" as const,
                        })),
                        ...SHARED_PRESERVATION_CAPABILITIES,
                        ...extra,
                    ])
                ),
                buildOperatorList(dialect),
                SHARED_QUERY_CLAUSES,
                SHARED_SET_OPERATORS,
                SHARED_JOIN_SYNTAX,
                SHARED_UNSUPPORTED_SYNTAX
            )
        );
    }

    const dialectList = CANONICAL_DIALECTS;

    const registry: DialectCapabilityRegistry = Object.freeze({
        listDialects(): readonly Dialect[] {
            return dialectList;
        },
        hasDialect(id: string): boolean {
            return CANONICAL_SET.has(id);
        },
        getDialect(id: string): DialectCapabilityView {
            if (!CANONICAL_SET.has(id)) {
                throw new Error(
                    `Unsupported dialect "${id}". Expected one of: hive, generic, postgresql, mysql.`
                );
            }
            const view = views.get(id as Dialect);
            if (!view) {
                throw new Error(`Internal registry missing dialect "${id}"`);
            }
            return view;
        },
    });

    return registry;
}

const REGISTRY: DialectCapabilityRegistry = buildRegistry();

export function getDialectCapabilityRegistry(): DialectCapabilityRegistry {
    return REGISTRY;
}

export function listDialects(): readonly Dialect[] {
    return REGISTRY.listDialects();
}

export function getDialect(id: string): DialectCapabilityView {
    return REGISTRY.getDialect(id);
}

export function hasDialect(id: string): boolean {
    return REGISTRY.hasDialect(id);
}
