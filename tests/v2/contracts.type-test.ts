import type {
    CanonicalFormatOptions,
    Diagnostic,
    FormatResult,
    LayoutDoc,
    ParserBackend,
    SourceLeaf,
    SourceSpan,
    SyntaxNode,
} from "../../src/core/index";

const span: SourceSpan = { start: 0, end: 6 };
const leaf: SourceLeaf = {
    id: 0,
    kind: "keyword",
    channel: "code",
    raw: "SELECT",
    span,
};
const opaqueNode: SyntaxNode = {
    id: 1,
    kind: "opaque",
    span,
    reasonCode: "UNMODELED_CONSTRUCT",
};
const root: SyntaxNode = {
    id: 0,
    kind: "program",
    span,
    children: [opaqueNode],
};
const diagnostic: Diagnostic = {
    code: "UNMODELED_CONSTRUCT",
    severity: "warning",
    message: "The construct is preserved verbatim.",
    span,
    recovery: "verbatim-node",
};
const doc: LayoutDoc = {
    kind: "group",
    content: {
        kind: "concat",
        parts: [
            { kind: "text", value: "SELECT" },
            { kind: "line", mode: "soft" },
            { kind: "verbatim", span },
        ],
    },
};
const options: CanonicalFormatOptions = {
    dialect: "hive",
    keywordCase: "upper",
    commaStyle: "leading",
    indentStyle: "space",
    maxAlignWidth: 150,
    caseWhenThenWrapLength: 50,
    caseLayout: "expanded",
    unsupportedSyntaxPolicy: "warn",
};
const backend: ParserBackend = {
    id: "contract-test",
    version: "0.0.0",
    parse(input) {
        const sourceLeaf: SourceLeaf = {
            ...leaf,
            raw: input.source,
            span: { start: 0, end: input.source.length },
        };
        return {
            root: { ...root, span: sourceLeaf.span },
            leaves: [sourceLeaf],
            diagnostics: [],
        };
    },
};
const result: FormatResult = {
    status: "preserved",
    text: "SELECT",
    diagnostics: [diagnostic],
    sourceMap: {
        entries: [{ source: span, output: span }],
    },
};

function statusLabel(value: FormatResult): string {
    switch (value.status) {
        case "formatted":
        case "unchanged":
        case "preserved":
        case "failed":
            return value.status;
        default: {
            const exhaustive: never = value.status;
            return exhaustive;
        }
    }
}

void backend;
void doc;
void options;
void statusLabel(result);
