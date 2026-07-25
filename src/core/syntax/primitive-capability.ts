import type { Dialect } from "../config/options";
import type { SourceLeaf } from "../lexer/token";
import type { ExpressionKind } from "./node";

function isMysqlPrefixedLiteral(raw: string): boolean {
    if (raw.charAt(0) === "_") {
        return true;
    }
    const prefix = raw.charAt(0).toUpperCase();
    return (
        (prefix === "N" || prefix === "X" || prefix === "B") &&
        raw.charAt(1) === "'"
    );
}

/**
 * Exact dialect capability identity for primitive leaves whose syntax is
 * already atomic in the lossless lexer. Ordinary parameters and literals stay
 * intrinsic; only the dialect-owned lexical forms receive capability authority.
 */
export function primitiveExpressionCapabilityId(
    dialect: Dialect,
    expressionKind: ExpressionKind | unknown,
    leaf: SourceLeaf | undefined
): string | null {
    if (leaf === undefined) {
        return null;
    }
    if (expressionKind === "parameter" && leaf.kind === "parameter") {
        if (
            dialect === "hive" &&
            leaf.raw.charAt(0) === "$" &&
            leaf.raw.charAt(1) === "{"
        ) {
            return "template-parameter";
        }
        if (dialect === "mysql" && leaf.raw.charAt(0) === "@") {
            return "mysql-variables";
        }
    }
    if (
        expressionKind === "literal" &&
        dialect === "mysql" &&
        leaf.kind === "string" &&
        isMysqlPrefixedLiteral(leaf.raw)
    ) {
        return "mysql-prefixed-literals";
    }
    return null;
}
