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
