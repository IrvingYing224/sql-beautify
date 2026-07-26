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

export interface IdentifierCharacterProfile {
    readonly isStart: (codePoint: number) => boolean;
    readonly isContinue: (codePoint: number) => boolean;
}

export interface LexicalProfile {
    readonly dialect: Dialect;
    readonly identifierCharacters: IdentifierCharacterProfile;
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

function isAsciiLetterCodePoint(codePoint: number): boolean {
    return (
        (codePoint >= 0x41 && codePoint <= 0x5a) ||
        (codePoint >= 0x61 && codePoint <= 0x7a)
    );
}

function isAsciiDigitCodePoint(codePoint: number): boolean {
    return codePoint >= 0x30 && codePoint <= 0x39;
}

const POSTGRES_UNICODE_LETTER = /^\p{Letter}$/u;

function isPostgresIdentifierLetter(codePoint: number): boolean {
    return Number.isInteger(codePoint) &&
        codePoint >= 0 &&
        codePoint <= 0x10ffff &&
        POSTGRES_UNICODE_LETTER.test(String.fromCodePoint(codePoint));
}

function isMysqlIdentifierWhitespace(codePoint: number): boolean {
    return (
        codePoint === 0x0085 ||
        codePoint === 0x00a0 ||
        codePoint === 0x1680 ||
        (codePoint >= 0x2000 && codePoint <= 0x200a) ||
        codePoint === 0x2028 ||
        codePoint === 0x2029 ||
        codePoint === 0x202f ||
        codePoint === 0x205f ||
        codePoint === 0x3000
    );
}

function isMysqlExtendedIdentifierCodePoint(codePoint: number): boolean {
    // MySQL's documented unquoted range is U+0080..U+FFFF. Supplementary
    // characters are not permitted. Exclude invalid UTF-16 surrogates, the
    // whitespace recognized by this lexer, and an interior BOM boundary.
    return codePoint >= 0x0080 &&
        codePoint <= 0xffff &&
        !(codePoint >= 0xd800 && codePoint <= 0xdfff) &&
        codePoint !== 0xfeff &&
        !isMysqlIdentifierWhitespace(codePoint);
}

function identifierCharacters(
    isStart: (codePoint: number) => boolean,
    isContinue: (codePoint: number) => boolean
): IdentifierCharacterProfile {
    return Object.freeze({ isStart, isContinue });
}

const ASCII_IDENTIFIER_CHARACTERS = identifierCharacters(
    (codePoint) => isAsciiLetterCodePoint(codePoint) || codePoint === 0x5f,
    (codePoint) =>
        isAsciiLetterCodePoint(codePoint) ||
        isAsciiDigitCodePoint(codePoint) ||
        codePoint === 0x5f ||
        codePoint === 0x24
);

const POSTGRES_IDENTIFIER_CHARACTERS = identifierCharacters(
    // Conservative PostgreSQL UTF-8 subset: Unicode letters are accepted,
    // while combining marks and non-ASCII numbers remain protected until the
    // scanner/encoding contract can justify a broader set.
    (codePoint) => codePoint === 0x5f ||
        isPostgresIdentifierLetter(codePoint),
    (codePoint) =>
        codePoint === 0x5f ||
        codePoint === 0x24 ||
        isAsciiDigitCodePoint(codePoint) ||
        isPostgresIdentifierLetter(codePoint)
);

const MYSQL_IDENTIFIER_CHARACTERS = identifierCharacters(
    // MySQL 8.4 "Schema Object Names" documents ASCII [0-9A-Za-z$_]
    // plus U+0080..U+FFFF for unquoted identifiers. The scanner resolves an
    // all-digit run as a number and a digit-started mixed run as an identifier.
    (codePoint) =>
        isAsciiLetterCodePoint(codePoint) ||
        isAsciiDigitCodePoint(codePoint) ||
        codePoint === 0x5f ||
        codePoint === 0x24 ||
        isMysqlExtendedIdentifierCodePoint(codePoint),
    (codePoint) =>
        isAsciiLetterCodePoint(codePoint) ||
        isAsciiDigitCodePoint(codePoint) ||
        codePoint === 0x5f ||
        codePoint === 0x24 ||
        isMysqlExtendedIdentifierCodePoint(codePoint)
);

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
    identifierCharacters: ASCII_IDENTIFIER_CHARACTERS,
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
    identifierCharacters: ASCII_IDENTIFIER_CHARACTERS,
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
    identifierCharacters: POSTGRES_IDENTIFIER_CHARACTERS,
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
    identifierCharacters: MYSQL_IDENTIFIER_CHARACTERS,
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
