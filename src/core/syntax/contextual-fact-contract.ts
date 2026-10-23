import type { OperatorSemantics } from "../dialects/types";
import type { SourceLeaf } from "../lexer/token";
import type { SyntaxLeafRole } from "./node";

const BUILTIN_TYPE_NAMES: ReadonlySet<string> = new Set([
    "array", "bigint", "binary", "boolean", "char", "date", "decimal",
    "double", "float", "int", "integer", "interval", "map", "numeric",
    "real", "smallint", "string", "struct", "timestamp", "tinyint",
    "varchar",
]);

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

export function hasAsciiKeywordCaseShape(value: unknown): value is string {
    return (
        typeof value === "string" &&
        /^[A-Za-z]+(?:_[A-Za-z]+)*$/.test(value)
    );
}

/** Shared exact leaf projection for a registry-owned operator occurrence. */
export function operatorSemanticsMatchLeaves(
    semantics: OperatorSemantics,
    leaves: readonly SourceLeaf[]
): boolean {
    if (semantics.form === "symbol") {
        return (
            leaves.length === 1 &&
            leaves[0]!.kind === "operator" &&
            leaves[0]!.raw === semantics.key
        );
    }
    return (
        leaves.length === semantics.words.length &&
        leaves.every(
            (leaf, index) => leaf.raw.toLowerCase() === semantics.words[index]
        )
    );
}

export type AliasKeywordLeafFailure = "missing" | "not-keyword" | "not-as";

/** Shared lexical contract for the optional explicit AS owned by an alias. */
export function aliasKeywordLeafFailure(
    leaves: readonly SourceLeaf[],
    leafId: number
): AliasKeywordLeafFailure | null {
    const leaf = leaves[leafId];
    if (leaf === undefined) {
        return "missing";
    }
    if (leaf.channel !== "code" || leaf.kind !== "keyword") {
        return "not-keyword";
    }
    return leaf.raw.toLowerCase() === "as" ? null : "not-as";
}
