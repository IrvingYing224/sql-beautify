/**
 * Hive vocabulary of the lossless lexer: keywords and fixed operators. Every other lexical rule
 * (quotes, comments, templates, parameters) is fixed in the scanner.
 */

/** Upper-case Hive keywords; an identifier-shaped ASCII leaf in this set is a keyword leaf. */
export const KEYWORDS: ReadonlySet<string> = new Set([
    "SELECT", "FROM", "WHERE", "AND", "OR", "NOT", "IN", "IS", "NULL", "AS", "ON", "JOIN", "LEFT",
    "RIGHT", "INNER", "OUTER", "FULL", "CROSS", "GROUP", "BY", "ORDER", "HAVING", "LIMIT", "OFFSET",
    "UNION", "ALL", "DISTINCT", "INSERT", "INTO", "VALUES", "UPDATE", "DELETE", "CREATE", "TABLE",
    "VIEW", "WITH", "CASE", "WHEN", "THEN", "ELSE", "END", "OVER", "PARTITION", "BETWEEN", "LIKE",
    "EXISTS", "CAST", "TRUE", "FALSE", "ASC", "DESC", "SET", "DROP", "ALTER", "ADD", "COLUMN",
    "PRIMARY", "KEY", "FOREIGN", "REFERENCES", "DEFAULT", "IF", "ELSEIF", "WHILE", "LOOP", "RETURN",
    "FUNCTION", "PROCEDURE", "BEGIN", "COMMIT", "ROLLBACK", "TRUNCATE", "REPLACE", "MERGE", "USING",
    "MATCHED", "LATERAL", "EXPLODE", "ARRAY", "MAP", "STRUCT", "NAMED_STRUCT", "OVERWRITE",
    "CLUSTER", "DISTRIBUTE", "SORT", "WINDOW", "ROW", "ROWS", "RANGE", "UNBOUNDED", "PRECEDING",
    "FOLLOWING", "CURRENT", "ROW_NUMBER", "RANK", "DENSE_RANK", "COMMENT", "DECIMAL", "STRING",
    "INT", "BIGINT", "BOOLEAN", "DOUBLE", "FLOAT", "DATE", "TIMESTAMP", "INTERVAL", "MSCK",
    "REPAIR", "EXTERNAL", "PARTITIONED", "STORED", "LOCATION", "TBLPROPERTIES", "SERDE", "FORMAT",
    "DELIMITED", "FIELDS", "TERMINATED", "COLLECTION", "ITEMS", "KEYS", "LINES", "PARQUET", "ORC",
    "TEXTFILE", "SEQUENCEFILE", "RCFILE", "AVRO", "JSONFILE",
]);

// HiveLexer has no shift operators: `>>` is two `>` (for example closing `map<string,array<int>>`).
const OPERATORS = [
    "<=>",
    "==",
    "<>",
    "!=",
    "<=",
    ">=",
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
];

const EMPTY_OPERATOR_BUCKET: readonly string[] = Object.freeze([]);

/** Operators by first UTF-16 code unit, each bucket longest-first. */
const OPERATORS_BY_FIRST = ((): ReadonlyMap<string, readonly string[]> => {
    const sorted = [...OPERATORS].sort((left, right) => {
        if (right.length !== left.length) {
            return right.length - left.length;
        }
        return left < right ? -1 : left > right ? 1 : 0;
    });
    const buckets = new Map<string, string[]>();
    for (const operator of sorted) {
        const first = operator.charAt(0);
        const bucket = buckets.get(first);
        if (bucket === undefined) {
            buckets.set(first, [operator]);
        } else {
            bucket.push(operator);
        }
    }
    return buckets;
})();

/** Longest-first operators whose first UTF-16 code unit is `value`. */
export function operatorsFor(value: string): readonly string[] {
    return value.length === 1
        ? OPERATORS_BY_FIRST.get(value) ?? EMPTY_OPERATOR_BUCKET
        : EMPTY_OPERATOR_BUCKET;
}
