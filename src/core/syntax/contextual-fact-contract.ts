import type { OperatorFixity, OperatorFormatClass } from "../dialects/types";
import type {
    ClauseKind,
    FormatRole,
    SyntaxLeafRole,
    SyntaxMarkerId,
} from "./node";

const CLAUSE_KINDS: ReadonlySet<string> = new Set<ClauseKind>([
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

type NonClauseSyntaxMarkerId = Exclude<SyntaxMarkerId, `clause:${ClauseKind}`>;

const NON_CLAUSE_MARKER_IDS: Readonly<Record<NonClauseSyntaxMarkerId, true>> =
    Object.freeze({
        "statement-terminator": true,
        "cte-as": true,
        "alias-as": true,
        "join-head": true,
        "set-operator": true,
        "case:start": true,
        "case:when": true,
        "case:then": true,
        "case:else": true,
        "case:end": true,
        "window:over": true,
        "window:partition-by": true,
        "window:order-by": true,
        "window:rows": true,
        "window:range": true,
        "window:groups": true,
        "window:between": true,
        "window:and": true,
        "window:unbounded": true,
        "window:current-row": true,
        "window:preceding": true,
        "window:following": true,
        "type:name": true,
        "type:cast": true,
        "type:as": true,
        "type:member-colon": true,
        delimiter: true,
        separator: true,
        operator: true,
    });

const GRAMMAR_KEYWORD_MARKER_IDS: ReadonlySet<string> = new Set([
    "cte-as",
    "alias-as",
    "join-head",
    "set-operator",
    "case:start",
    "case:when",
    "case:then",
    "case:else",
    "case:end",
    "window:over",
    "window:partition-by",
    "window:order-by",
    "window:rows",
    "window:range",
    "window:groups",
    "window:between",
    "window:and",
    "window:unbounded",
    "window:current-row",
    "window:preceding",
    "window:following",
    "type:cast",
    "type:as",
]);

const SYNTAX_LEAF_ROLES: ReadonlySet<string> = new Set<SyntaxLeafRole>([
    "syntax-keyword",
    "word-operator-keyword",
    "builtin-type-keyword",
    "identifier-name",
    "alias-name",
    "relation-name",
    "user-type-name",
    "literal",
    "parameter",
    "symbol-operator",
    "delimiter",
    "separator",
    "punctuation",
    "unknown-preserved",
]);

const FORMAT_ROLES: ReadonlySet<string> = new Set<FormatRole>([
    "capability",
    "intrinsic-container",
    "intrinsic-primitive",
    "opaque",
]);

const OPERATOR_FIXITIES: ReadonlySet<string> = new Set<OperatorFixity>([
    "prefix",
    "infix",
    "postfix",
]);

const OPERATOR_FORMAT_CLASSES: ReadonlySet<string> =
    new Set<OperatorFormatClass>([
        "prefix-word",
        "prefix-symbol",
        "infix-word",
        "infix-symbol",
        "postfix-word",
        "postfix-symbol",
        "attached",
    ]);

const BUILTIN_TYPE_NAMES: ReadonlySet<string> = new Set([
    "array", "bigint", "binary", "boolean", "char", "date", "decimal",
    "double", "float", "int", "integer", "interval", "map", "numeric",
    "real", "smallint", "string", "struct", "timestamp", "tinyint",
    "varchar",
]);

export function isFormatRole(value: unknown): value is FormatRole {
    return typeof value === "string" && FORMAT_ROLES.has(value);
}

export function isSyntaxLeafRole(value: unknown): value is SyntaxLeafRole {
    return typeof value === "string" && SYNTAX_LEAF_ROLES.has(value);
}

export function isKeywordCaseRole(
    value: unknown
): value is Extract<
    SyntaxLeafRole,
    "syntax-keyword" | "word-operator-keyword" | "builtin-type-keyword"
> {
    return (
        value === "syntax-keyword" ||
        value === "word-operator-keyword" ||
        value === "builtin-type-keyword"
    );
}

export function isBuiltinTypeName(value: unknown): value is string {
    return typeof value === "string" && BUILTIN_TYPE_NAMES.has(value.toLowerCase());
}

export function isSyntaxMarkerId(value: unknown): value is SyntaxMarkerId {
    if (typeof value !== "string") {
        return false;
    }
    if (value.startsWith("clause:")) {
        return CLAUSE_KINDS.has(value.slice("clause:".length));
    }
    return Object.prototype.hasOwnProperty.call(NON_CLAUSE_MARKER_IDS, value);
}

export function isGrammarKeywordMarkerId(
    value: SyntaxMarkerId
): boolean {
    return (
        value.startsWith("clause:") ||
        GRAMMAR_KEYWORD_MARKER_IDS.has(value)
    );
}

export function isOperatorFixity(value: unknown): value is OperatorFixity {
    return typeof value === "string" && OPERATOR_FIXITIES.has(value);
}

export function isOperatorFormatClass(
    value: unknown
): value is OperatorFormatClass {
    return typeof value === "string" && OPERATOR_FORMAT_CLASSES.has(value);
}

export function hasAsciiKeywordCaseShape(value: unknown): value is string {
    return (
        typeof value === "string" &&
        /^[A-Za-z]+(?:_[A-Za-z]+)*$/.test(value)
    );
}
