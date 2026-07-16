import type {
    AliasInfo,
    AnalysisOutput,
    CanonicalFormatOptions,
    Diagnostic,
    FailedAnalysisArtifact,
    FormatResult,
    LayoutDoc,
    LeafRange,
    LexOptions,
    LexOutput,
    OpaqueNode,
    ParserBackend,
    ProgramNode,
    SourceLeaf,
    SourceSpan,
    StructuredSyntaxKind,
    StructuralIndex,
    SyntaxNode,
} from "../../src/core/index";
import { lexSql } from "../../src/core/index";

const span: SourceSpan = { start: 0, end: 6 };
const leafRange: LeafRange = { start: 0, end: 1 };
const containerFacts = {
    syntaxMarkers: [] as const,
    capabilityId: null,
    formatRole: "intrinsic-container" as const,
};
const opaqueFacts = {
    syntaxMarkers: [] as const,
    capabilityId: null,
    formatRole: "opaque" as const,
};
const leaf: SourceLeaf = {
    id: 0,
    kind: "keyword",
    channel: "code",
    raw: "SELECT",
    span,
};
const opaqueNode: OpaqueNode = {
    ...opaqueFacts,
    id: 2,
    kind: "opaque",
    span,
    leafRange,
    reasonCode: "UNMODELED_CONSTRUCT",
    capabilityId: null,
    boundary: "statement",
};
const root: ProgramNode = {
    ...containerFacts,
    id: 0,
    kind: "program",
    span,
    leafRange,
    children: [
        {
            ...containerFacts,
            id: 1,
            kind: "statement",
            span,
            leafRange,
            statementKind: "opaque",
            bodyChildId: 2,
            children: [opaqueNode],
        },
    ],
};
const diagnostic: Diagnostic = {
    code: "UNMODELED_CONSTRUCT",
    severity: "warning",
    message: "The construct is preserved verbatim.",
    capabilityId: null,
    span,
    recovery: "verbatim-node",
};

// @ts-expect-error capability identity is a required field, even when absent.
const opaqueWithoutCapabilityId: OpaqueNode = {
    syntaxMarkers: [],
    formatRole: "opaque",
    id: 3,
    kind: "opaque",
    span,
    leafRange,
    reasonCode: "UNMODELED_CONSTRUCT",
    boundary: "statement",
};

// @ts-expect-error capability identity is a required field, even when absent.
const diagnosticWithoutCapabilityId: Diagnostic = {
    code: "UNMODELED_CONSTRUCT",
    severity: "warning",
    message: "The construct is preserved verbatim.",
    span,
    recovery: "verbatim-node",
};
const doc: LayoutDoc = {
    kind: "leaf",
    leafId: 0,
    transform: "raw",
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
            root: {
                ...root,
                span: sourceLeaf.span,
                leafRange: { start: 0, end: 1 },
            },
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
const failedAnalysis: FailedAnalysisArtifact = {
    status: "failed",
    source: "SELECT",
    dialect: "hive",
    mode: "document",
    root,
    leaves: [leaf],
    diagnostics: [diagnostic],
    index: null,
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

function syntaxKindLabel(node: SyntaxNode): string {
    switch (node.kind) {
        case "program":
        case "statement":
        case "query":
        case "cte":
        case "clause":
        case "relation":
        case "list":
        case "list-item":
        case "expression":
        case "case-branch":
        case "window-spec":
        case "type-expression":
        case "opaque":
            return node.kind;
        default: {
            const exhaustive: never = node;
            return exhaustive;
        }
    }
}

function analysisStatusLabel(value: AnalysisOutput): string {
    if (value.status === "failed") {
        const failedIndex: null = value.index;
        void failedIndex;
    } else {
        const trustedIndex: StructuralIndex = value.index;
        void trustedIndex;
    }
    return value.status;
}

const defaultLexOptions: LexOptions = {};
const hiveLexOptions: LexOptions = { dialect: "hive" };
const postgresLexOptions: LexOptions = { dialect: "postgresql" };
const mysqlLexOptions: LexOptions = { dialect: "mysql" };
const genericLexOptions: LexOptions = { dialect: "generic" };

const lexOutput: LexOutput = lexSql("SELECT 1");
const explicitLexOutput: LexOutput = lexSql("SELECT 1", hiveLexOptions);
const readonlyLeaves: readonly SourceLeaf[] = lexOutput.leaves;
const readonlyDiagnostics: readonly Diagnostic[] = lexOutput.diagnostics;
const canonicalLeaf: SourceLeaf = {
    id: 0,
    kind: "keyword",
    channel: "code",
    raw: "SELECT",
    span: { start: 0, end: 6 },
};

const alias: AliasInfo = {
    keywordLeafId: null,
    nameLeafRange: { start: 0, end: 1 },
};
const structuredKind: StructuredSyntaxKind = "program";

// @ts-expect-error legacy postgres alias is not a Wave 0 canonical dialect
const invalidDialect: LexOptions = { dialect: "postgres" };
// @ts-expect-error unknown dialect values are rejected
const unknownDialect: LexOptions = { dialect: "oracle" };
// @ts-expect-error opaque is not a structured kind
const opaqueAsStructured: StructuredSyntaxKind = "opaque";

void backend;
void doc;
void options;
void statusLabel(result);
void syntaxKindLabel(root);
void analysisStatusLabel(failedAnalysis);
void defaultLexOptions;
void postgresLexOptions;
void mysqlLexOptions;
void genericLexOptions;
void explicitLexOutput;
void readonlyLeaves;
void readonlyDiagnostics;
void canonicalLeaf;
void invalidDialect;
void unknownDialect;
void alias;
void structuredKind;
void opaqueAsStructured;
void opaqueNode;
