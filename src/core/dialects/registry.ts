import type { Dialect } from "../config/options";
import { getLexicalProfile } from "../lexer/lexical-profile";
import { EMPTY_FROZEN_ARRAY, freezeImmutableArray } from "../util/immutable-array";
import type {
    CapabilityEntry,
    CapabilityState,
    DialectCapabilityRegistry,
    DialectCapabilityView,
    OperatorFixity,
    OperatorForm,
    OperatorSemantics,
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

/** Shared symbol operators present across Hive-first lexical profiles. */
const SHARED_SYMBOL_OPERATORS: readonly {
    key: string;
    fixities: readonly OperatorFixity[];
}[] = freezeImmutableArray([
    { key: "+", fixities: freezeImmutableArray(["prefix", "infix"] as OperatorFixity[]) },
    { key: "-", fixities: freezeImmutableArray(["prefix", "infix"] as OperatorFixity[]) },
    { key: "*", fixities: freezeImmutableArray(["infix"] as OperatorFixity[]) },
    { key: "/", fixities: freezeImmutableArray(["infix"] as OperatorFixity[]) },
    { key: "%", fixities: freezeImmutableArray(["infix"] as OperatorFixity[]) },
    { key: "=", fixities: freezeImmutableArray(["infix"] as OperatorFixity[]) },
    { key: "<", fixities: freezeImmutableArray(["infix"] as OperatorFixity[]) },
    { key: ">", fixities: freezeImmutableArray(["infix"] as OperatorFixity[]) },
    { key: "<=", fixities: freezeImmutableArray(["infix"] as OperatorFixity[]) },
    { key: ">=", fixities: freezeImmutableArray(["infix"] as OperatorFixity[]) },
    { key: "<>", fixities: freezeImmutableArray(["infix"] as OperatorFixity[]) },
    { key: "!=", fixities: freezeImmutableArray(["infix"] as OperatorFixity[]) },
    { key: "||", fixities: freezeImmutableArray(["infix"] as OperatorFixity[]) },
    { key: "&&", fixities: freezeImmutableArray(["infix"] as OperatorFixity[]) },
    { key: "!", fixities: freezeImmutableArray(["prefix"] as OperatorFixity[]) },
    { key: "~", fixities: freezeImmutableArray(["prefix"] as OperatorFixity[]) },
]);

/**
 * Keyword / compound / special operators (schema frozen for 2C).
 * Validated via lexical keyword membership, not operator token view.
 */
const SHARED_WORD_OPERATORS: readonly {
    key: string;
    fixity: OperatorFixity;
    form: OperatorForm;
    words: readonly string[];
}[] = freezeImmutableArray([
    {
        key: "not",
        fixity: "prefix",
        form: "keyword",
        words: freezeImmutableArray(["not"]),
    },
    {
        key: "is-not",
        fixity: "infix",
        form: "compound",
        words: freezeImmutableArray(["is", "not"]),
    },
    {
        key: "not-in",
        fixity: "infix",
        form: "compound",
        words: freezeImmutableArray(["not", "in"]),
    },
    {
        key: "between",
        fixity: "infix",
        form: "special",
        words: freezeImmutableArray(["between", "and"]),
    },
]);

const HIVE_QUERY_RECOGNIZED: readonly string[] = freezeImmutableArray([
    "multi-statement",
    "with-cte",
    "select-without-from",
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
    "case-expression",
    "function-call",
    "collection-expression",
    "cast-type",
    "subquery-expression",
    "window-expression",
    "template-parameter",
]);

const HIVE_VERBATIM_OR_DIAGNOSTIC: readonly Readonly<{
    id: string;
    state: "verbatim" | "diagnostic";
}>[] = freezeImmutableArray([
    Object.freeze({ id: "hive-ddl", state: "verbatim" as const }),
    Object.freeze({ id: "merge", state: "diagnostic" as const }),
    Object.freeze({ id: "match-recognize", state: "verbatim" as const }),
    Object.freeze({ id: "pivot", state: "verbatim" as const }),
    Object.freeze({ id: "unpivot", state: "verbatim" as const }),
]);

const SHARED_QUERY_RECOGNIZED: readonly string[] = freezeImmutableArray([
    "multi-statement",
    "with-cte",
    "select-without-from",
    "from",
    "join",
    "subquery",
    "where",
    "group-by",
    "having",
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
    if (state === "formatted") {
        throw new Error(`Wave 2 must not declare formatted capability: ${id}`);
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

    for (const item of SHARED_SYMBOL_OPERATORS) {
        if (!lexicalOps.has(item.key)) {
            // Skip symbols not present in this dialect's lexical profile.
            continue;
        }
        for (const fixity of item.fixities) {
            entries.push(
                Object.freeze({
                    key: item.key,
                    fixity,
                    form: "symbol" as const,
                    words: freezeImmutableArray([] as string[]),
                    precedence: null,
                    associativity: null,
                })
            );
        }
    }

    for (const item of SHARED_WORD_OPERATORS) {
        for (const word of item.words) {
            if (!profile.keywords.has(word.toUpperCase())) {
                // Keyword not in profile — skip this word operator for dialect.
                // BETWEEN/AND/NOT/IN/IS are in COMMON_KEYWORDS for all dialects.
                throw new Error(
                    `Word operator "${item.key}" requires keyword "${word}" in lexical profile for ${dialect}`
                );
            }
        }
        entries.push(
            Object.freeze({
                key: item.key,
                fixity: item.fixity,
                form: item.form,
                words: freezeImmutableArray(item.words),
                precedence: null,
                associativity: null,
            })
        );
    }

    return freezeImmutableArray(entries);
}

function createDialectView(
    dialect: Dialect,
    capabilities: readonly CapabilityEntry[],
    operators: readonly OperatorSemantics[]
): DialectCapabilityView {
    const capabilityById = new Map(capabilities.map((c) => [c.id, c]));
    const operatorsByKeyFixity = new Map<string, OperatorSemantics>();
    const operatorsByKey = new Map<string, OperatorSemantics[]>();

    for (const op of operators) {
        const mapKey = `${op.key}\0${op.fixity}`;
        if (operatorsByKeyFixity.has(mapKey)) {
            throw new Error(
                `Duplicate operator semantics for ${dialect}: ${op.key} / ${op.fixity}`
            );
        }
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
    });
    return view;
}

function buildRegistry(): DialectCapabilityRegistry {
    const views = new Map<Dialect, DialectCapabilityView>();

    views.set(
        "hive",
        createDialectView(
            "hive",
            buildCapabilityList(HIVE_QUERY_RECOGNIZED, HIVE_VERBATIM_OR_DIAGNOSTIC),
            buildOperatorList("hive")
        )
    );

    for (const dialect of ["generic", "postgresql", "mysql"] as const) {
        const extra: Readonly<{ id: string; state: CapabilityState }>[] =
            dialect === "postgresql"
                ? [
                      { id: "postgres-json-operators", state: "recognized" },
                      { id: "postgres-type-cast", state: "recognized" },
                  ]
                : dialect === "mysql"
                  ? [
                        { id: "mysql-variables", state: "recognized" },
                        { id: "mysql-prefixed-literals", state: "recognized" },
                    ]
                  : [{ id: "generic-array-subset", state: "recognized" }];

        views.set(
            dialect,
            createDialectView(
                dialect,
                buildCapabilityList(SHARED_QUERY_RECOGNIZED, extra),
                buildOperatorList(dialect)
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
