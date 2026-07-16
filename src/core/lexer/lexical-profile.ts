import type { Dialect } from "../config/options";

export type DoubleQuoteSemantics = "string" | "identifier";

export type PrefixedLiteralForm =
    | "E"
    | "U&"
    | "N"
    | "X"
    | "B"
    | "_charset";

export type ParameterForm = "$n" | ":id" | "@name" | "?" | "${}";

/**
 * Line-comment policy for `--`.
 * - standard: `--` always starts a line comment (Hive / PostgreSQL / generic)
 * - mysql: second `-` must be followed by whitespace or a control character
 */
export type DashDashCommentPolicy = "standard" | "mysql";

/** Runtime-readonly membership lookup that does not expose mutators. */
export interface ReadonlyLookup<T extends string> {
    readonly has: (value: T) => boolean;
}

export interface LexicalProfile {
    readonly dialect: Dialect;
    readonly doubleQuote: DoubleQuoteSemantics;
    readonly backtickIdentifiers: boolean;
    readonly hashComments: boolean;
    readonly dashDashComments: DashDashCommentPolicy;
    readonly nestedBlockComments: boolean;
    readonly dollarStrings: boolean;
    readonly backslashStringEscapes: boolean;
    readonly templateParameters: boolean;
    readonly parameters: ReadonlyLookup<ParameterForm>;
    readonly prefixedLiterals: ReadonlyLookup<PrefixedLiteralForm>;
    readonly keywords: ReadonlyLookup<string>;
    /** Syntax-only word operators that must not change Wave 1 token kinds. */
    readonly syntaxOperatorWords: ReadonlyLookup<string>;
    /** Multi-character operators sorted longest-first for maximal-munch. */
    readonly operators: readonly string[];
}

const COMMON_KEYWORDS = [
    "SELECT",
    "FROM",
    "WHERE",
    "AND",
    "OR",
    "NOT",
    "IN",
    "IS",
    "NULL",
    "AS",
    "ON",
    "JOIN",
    "LEFT",
    "RIGHT",
    "INNER",
    "OUTER",
    "FULL",
    "CROSS",
    "GROUP",
    "BY",
    "ORDER",
    "HAVING",
    "LIMIT",
    "OFFSET",
    "UNION",
    "ALL",
    "DISTINCT",
    "INSERT",
    "INTO",
    "VALUES",
    "UPDATE",
    "DELETE",
    "CREATE",
    "TABLE",
    "VIEW",
    "WITH",
    "CASE",
    "WHEN",
    "THEN",
    "ELSE",
    "END",
    "OVER",
    "PARTITION",
    "BETWEEN",
    "LIKE",
    "EXISTS",
    "CAST",
    "TRUE",
    "FALSE",
    "ASC",
    "DESC",
    "SET",
    "DROP",
    "ALTER",
    "ADD",
    "COLUMN",
    "PRIMARY",
    "KEY",
    "FOREIGN",
    "REFERENCES",
    "DEFAULT",
    "IF",
    "ELSEIF",
    "WHILE",
    "LOOP",
    "RETURN",
    "FUNCTION",
    "PROCEDURE",
    "BEGIN",
    "COMMIT",
    "ROLLBACK",
    "TRUNCATE",
    "REPLACE",
    "MERGE",
    "USING",
    "MATCHED",
    "LATERAL",
    "VIEW",
    "EXPLODE",
    "ARRAY",
    "MAP",
    "STRUCT",
    "NAMED_STRUCT",
    "OVERWRITE",
    "CLUSTER",
    "DISTRIBUTE",
    "SORT",
    "WINDOW",
    "ROW",
    "ROWS",
    "RANGE",
    "UNBOUNDED",
    "PRECEDING",
    "FOLLOWING",
    "CURRENT",
    "ROW_NUMBER",
    "RANK",
    "DENSE_RANK",
    "COMMENT",
    "DECIMAL",
    "STRING",
    "INT",
    "BIGINT",
    "BOOLEAN",
    "DOUBLE",
    "FLOAT",
    "DATE",
    "TIMESTAMP",
    "INTERVAL",
] as const;

const COMMON_OPERATORS = [
    "<=>",
    "<>",
    "!=",
    "<=",
    ">=",
    "<<",
    ">>",
    "||",
    "&&",
    "==",
    "->",
    "+",
    "-",
    "*",
    "/",
    "%",
    "=",
    "<",
    ">",
    "!",
    "|",
    "&",
    "^",
    "~",
] as const;

const POSTGRES_OPERATORS = [
    "!~*",
    "#>>",
    "->>",
    "?|",
    "?&",
    "@?",
    "@@",
    "@>",
    "<@",
    "#>",
    "->",
    "::",
    ":=",
    "=>",
    "~~*",
    "!~~*",
    "~~",
    "!~~",
    "~*",
    "!~",
    "~",
    "||",
    "&&",
    "<>",
    "!=",
    "<=",
    ">=",
    "<<",
    ">>",
    "+",
    "-",
    "*",
    "/",
    "%",
    "=",
    "<",
    ">",
    "!",
    "|",
    "&",
    "^",
    "?",
    "#",
] as const;

const MYSQL_OPERATORS = [
    "<=>",
    "->>",
    ":=",
    "->",
    "<>",
    "!=",
    "<=",
    ">=",
    "<<",
    ">>",
    "||",
    "&&",
    "==",
    "+",
    "-",
    "*",
    "/",
    "%",
    "=",
    "<",
    ">",
    "!",
    "|",
    "&",
    "^",
    "~",
] as const;

const HIVE_OPERATORS = [
    "<=>",
    "==",
    "<>",
    "!=",
    "<=",
    ">=",
    "<<",
    ">>",
    "||",
    "&&",
    "->",
    "+",
    "-",
    "*",
    "/",
    "%",
    "=",
    "<",
    ">",
    "!",
    "|",
    "&",
    "^",
    "~",
] as const;

function sortOperatorsLongestFirst(operators: readonly string[]): readonly string[] {
    return Object.freeze(
        [...operators].sort((left, right) => {
            if (right.length !== left.length) {
                return right.length - left.length;
            }
            return left < right ? -1 : left > right ? 1 : 0;
        })
    );
}

/**
 * Build a private Set and expose only `has`. Callers cannot add/delete/clear.
 * Keyword membership stays O(1).
 */
function createReadonlyLookup<T extends string>(values: Iterable<T>): ReadonlyLookup<T> {
    const privateSet = new Set<T>(values);
    const lookup: ReadonlyLookup<T> = Object.freeze({
        has(value: T): boolean {
            return privateSet.has(value);
        },
    });
    return lookup;
}

function freezeKeywords(extra: readonly string[] = []): ReadonlyLookup<string> {
    const values: string[] = [];
    for (const keyword of COMMON_KEYWORDS) {
        values.push(keyword);
    }
    for (const keyword of extra) {
        values.push(keyword.toUpperCase());
    }
    return createReadonlyLookup(values);
}

function freezeParameters(forms: readonly ParameterForm[]): ReadonlyLookup<ParameterForm> {
    return createReadonlyLookup(forms);
}

function freezePrefixed(forms: readonly PrefixedLiteralForm[]): ReadonlyLookup<PrefixedLiteralForm> {
    return createReadonlyLookup(forms);
}

function freezeSyntaxOperatorWords(words: readonly string[] = []): ReadonlyLookup<string> {
    return createReadonlyLookup(words.map((word) => word.toLowerCase()));
}

const HIVE_PROFILE: LexicalProfile = Object.freeze({
    dialect: "hive",
    doubleQuote: "string",
    backtickIdentifiers: true,
    hashComments: false,
    dashDashComments: "standard",
    nestedBlockComments: false,
    dollarStrings: false,
    backslashStringEscapes: true,
    templateParameters: true,
    // Hive-native substitution is `${...}` and prepared statements use `?`.
    // Do not claim `:id`: it conflicts with STRUCT<name : type> regardless of
    // whether trivia appears around the member colon.
    parameters: freezeParameters(["${}", "?"]),
    prefixedLiterals: freezePrefixed(["X", "B"]),
    keywords: freezeKeywords([
        "LATERAL",
        "EXPLODE",
        "OVERWRITE",
        "CLUSTER",
        "DISTRIBUTE",
        "SORT",
        "MSCK",
        "REPAIR",
        "EXTERNAL",
        "STORED",
        "LOCATION",
        "TBLPROPERTIES",
        "SERDE",
        "ROW",
        "FORMAT",
        "DELIMITED",
        "FIELDS",
        "TERMINATED",
        "COLLECTION",
        "ITEMS",
        "KEYS",
        "LINES",
        "STORED",
        "AS",
        "PARQUET",
        "ORC",
        "TEXTFILE",
        "SEQUENCEFILE",
        "RCFILE",
        "AVRO",
        "JSONFILE",
    ]),
    syntaxOperatorWords: freezeSyntaxOperatorWords(["rlike", "regexp"]),
    operators: sortOperatorsLongestFirst(HIVE_OPERATORS),
});

const GENERIC_PROFILE: LexicalProfile = Object.freeze({
    dialect: "generic",
    doubleQuote: "identifier",
    backtickIdentifiers: false,
    hashComments: false,
    dashDashComments: "standard",
    nestedBlockComments: false,
    dollarStrings: false,
    backslashStringEscapes: false,
    templateParameters: false,
    parameters: freezeParameters(["$n", ":id", "?", "@name"]),
    prefixedLiterals: freezePrefixed(["N", "X", "B"]),
    keywords: freezeKeywords(),
    syntaxOperatorWords: freezeSyntaxOperatorWords(),
    operators: sortOperatorsLongestFirst(COMMON_OPERATORS),
});

const POSTGRES_PROFILE: LexicalProfile = Object.freeze({
    dialect: "postgresql",
    doubleQuote: "identifier",
    backtickIdentifiers: false,
    hashComments: false,
    dashDashComments: "standard",
    nestedBlockComments: true,
    dollarStrings: true,
    backslashStringEscapes: false,
    templateParameters: false,
    // PostgreSQL uses `$n`; `?` is a JSON/existence operator and `:id` is not
    // server syntax (callers that need client-side named binds use generic).
    parameters: freezeParameters(["$n"]),
    prefixedLiterals: freezePrefixed(["E", "U&", "X", "B"]),
    keywords: freezeKeywords([
        "RETURNING",
        "ILIKE",
        "SIMILAR",
        "ANALYZE",
        "VACUUM",
        "EXPLAIN",
        "JSONB",
        "JSON",
        "ARRAY",
    ]),
    syntaxOperatorWords: freezeSyntaxOperatorWords(),
    operators: sortOperatorsLongestFirst(POSTGRES_OPERATORS),
});

const MYSQL_PROFILE: LexicalProfile = Object.freeze({
    dialect: "mysql",
    doubleQuote: "string",
    backtickIdentifiers: true,
    hashComments: true,
    dashDashComments: "mysql",
    nestedBlockComments: false,
    dollarStrings: false,
    backslashStringEscapes: true,
    templateParameters: false,
    parameters: freezeParameters(["@name", ":id", "?"]),
    prefixedLiterals: freezePrefixed(["_charset", "N", "X", "B"]),
    keywords: freezeKeywords([
        "FORCE",
        "USE",
        "INDEX",
        "KEY",
        "STRAIGHT_JOIN",
        "SQL_CALC_FOUND_ROWS",
        "DUPLICATE",
        "IGNORE",
        "LOW_PRIORITY",
        "HIGH_PRIORITY",
        "DELAYED",
        "QUICK",
    ]),
    syntaxOperatorWords: freezeSyntaxOperatorWords(["regexp"]),
    operators: sortOperatorsLongestFirst(MYSQL_OPERATORS),
});

const PROFILES: Readonly<Record<Dialect, LexicalProfile>> = Object.freeze({
    hive: HIVE_PROFILE,
    generic: GENERIC_PROFILE,
    postgresql: POSTGRES_PROFILE,
    mysql: MYSQL_PROFILE,
});

export function getLexicalProfile(dialect: Dialect): LexicalProfile {
    return PROFILES[dialect];
}

export function listLexicalProfiles(): readonly LexicalProfile[] {
    return Object.freeze([
        HIVE_PROFILE,
        GENERIC_PROFILE,
        POSTGRES_PROFILE,
        MYSQL_PROFILE,
    ]);
}
