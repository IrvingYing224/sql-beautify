import type { SourceSpan } from "../source/source-span";

export type LayoutDoc =
    | { readonly kind: "text"; readonly value: string }
    | { readonly kind: "verbatim"; readonly span: SourceSpan }
    | { readonly kind: "line"; readonly mode: "hard" | "soft" }
    | { readonly kind: "concat"; readonly parts: readonly LayoutDoc[] }
    | { readonly kind: "indent"; readonly content: LayoutDoc }
    | { readonly kind: "align"; readonly columns: number; readonly content: LayoutDoc }
    | { readonly kind: "group"; readonly content: LayoutDoc };
