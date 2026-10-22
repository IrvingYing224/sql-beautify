import type { SourceSpan } from "../source/source-span";

export type TokenChannel = "code" | "trivia" | "protected";
export type TokenKind =
    | "keyword"
    | "identifier"
    | "quoted-identifier"
    | "number"
    | "string"
    | "parameter"
    | "operator"
    | "punctuation"
    | "line-comment"
    | "block-comment"
    | "byte-order-mark"
    | "whitespace"
    | "newline"
    | "unknown";

export interface SourceLeaf {
    readonly id: number;
    readonly kind: TokenKind;
    readonly channel: TokenChannel;
    readonly raw: string;
    readonly span: SourceSpan;
}

/** A Hive template fragment: the lexer merges `${…}` with its zero-gap neighbours (`tbl_${dt}`). */
export function isTemplateFragment(leaf: SourceLeaf): boolean {
    return leaf.kind === "parameter" && leaf.raw.includes("${");
}
