/**
 * Wave 2A CST foundation contracts (post-hardening).
 */
import type {
    AliasInfo,
    CaseBranchNode,
    ClauseNode,
    CteNode,
    ExpressionNode,
    LeafRange,
    ListItemNode,
    ListNode,
    OpaqueNode,
    ParserBackend,
    ParseOptions,
    ParseOutput,
    ProgramNode,
    QueryNode,
    RelationNode,
    StatementNode,
    StructuredSyntaxKind,
    SyntaxNode,
    TypeExpressionNode,
    WindowSpecNode,
} from "../../src/core/index";
import { lexSql } from "../../src/core/index";
import * as rootCore from "../../src/core/index";
import { parseSql, parserBackend } from "../../src/core/syntax";

const emptyRange: LeafRange = { start: 0, end: 0 };
const nonEmptyRange: LeafRange = { start: 0, end: 3 };
void emptyRange;
void nonEmptyRange;

const nodeFacts = {
    syntaxMarkers: [] as const,
    capabilityId: null,
    formatRole: "intrinsic-container" as const,
};
const opaqueFacts = {
    syntaxMarkers: [] as const,
    capabilityId: null,
    formatRole: "opaque" as const,
};

// @ts-expect-error LeafRange must not accept string indexes
const badRange: LeafRange = { start: "0", end: 1 };
void badRange;

const opaque: OpaqueNode = {
    ...opaqueFacts,
    id: 2,
    kind: "opaque",
    span: { start: 0, end: 6 },
    leafRange: { start: 0, end: 1 },
    reasonCode: "SYN_UNMODELED_CONSTRUCT",
    capabilityId: null,
    boundary: "statement",
};

const opaqueWithChildren: OpaqueNode = {
    ...opaqueFacts,
    id: 2,
    kind: "opaque",
    span: { start: 0, end: 6 },
    leafRange: { start: 0, end: 1 },
    reasonCode: "SYN_UNMODELED_CONSTRUCT",
    capabilityId: null,
    boundary: "statement",
    // @ts-expect-error OpaqueNode must not declare children
    children: [],
};
void opaqueWithChildren;

const statement: StatementNode = {
    ...nodeFacts,
    id: 1,
    kind: "statement",
    span: { start: 0, end: 6 },
    leafRange: { start: 0, end: 1 },
    statementKind: "opaque",
    bodyChildId: 2,
    children: [opaque],
};

const program: ProgramNode = {
    ...nodeFacts,
    id: 0,
    kind: "program",
    span: { start: 0, end: 6 },
    leafRange: { start: 0, end: 1 },
    children: [statement],
};

// Program children must be statements only
const badProgramChildren: ProgramNode = {
    ...nodeFacts,
    id: 0,
    kind: "program",
    span: { start: 0, end: 6 },
    leafRange: { start: 0, end: 1 },
    // @ts-expect-error program children must be StatementNode, not opaque
    children: [opaque],
};
void badProgramChildren;

const query: QueryNode = {
    ...nodeFacts,
    id: 3,
    kind: "query",
    span: { start: 0, end: 6 },
    leafRange: { start: 0, end: 1 },
    queryKind: "select",
    setOperatorLeafIds: [],
    children: [],
};

const listItem: ListItemNode = {
    ...nodeFacts,
    id: 8,
    kind: "list-item",
    span: { start: 0, end: 6 },
    leafRange: { start: 0, end: 1 },
    itemRole: "select-item",
    alias: null,
    modifierLeafIds: [],
    valueChildId: 2,
    children: [opaque],
};

const list: ListNode = {
    ...nodeFacts,
    id: 7,
    kind: "list",
    span: { start: 0, end: 6 },
    leafRange: { start: 0, end: 1 },
    listRole: "select-items",
    separatorLeafIds: [1],
    children: [listItem],
};

const cte: CteNode = {
    ...nodeFacts,
    id: 4,
    kind: "cte",
    span: { start: 0, end: 6 },
    leafRange: { start: 0, end: 1 },
    nameLeafRange: { start: 0, end: 1 },
    queryChildId: 3,
    columnListChildId: 7,
    children: [query, list],
};

const clause: ClauseNode = {
    ...nodeFacts,
    id: 5,
    kind: "clause",
    span: { start: 0, end: 6 },
    leafRange: { start: 0, end: 1 },
    clauseKind: "select",
    headLeafRange: { start: 0, end: 1 },
    bodyLeafRange: { start: 1, end: 1 },
    separatorLeafIds: [],
    children: [],
};

const alias: AliasInfo = {
    keywordLeafId: null,
    nameLeafRange: { start: 2, end: 3 },
};

const relation: RelationNode = {
    ...nodeFacts,
    id: 6,
    kind: "relation",
    span: { start: 0, end: 6 },
    leafRange: { start: 0, end: 1 },
    relationKind: "table",
    nameLeafRange: { start: 0, end: 1 },
    alias,
    bodyChildId: null,
    children: [],
};

const expression: ExpressionNode = {
    ...nodeFacts,
    id: 9,
    kind: "expression",
    span: { start: 0, end: 6 },
    leafRange: { start: 0, end: 1 },
    expressionKind: "binary",
    operatorLeafIds: [1],
    operatorOccurrences: [],
    children: [],
};

const opaqueExpr: ExpressionNode = {
    ...nodeFacts,
    id: 99,
    kind: "expression",
    span: { start: 0, end: 1 },
    leafRange: { start: 0, end: 1 },
    // @ts-expect-error ExpressionKind no longer includes opaque
    expressionKind: "opaque",
    operatorLeafIds: [],
    operatorOccurrences: [],
    children: [],
};
void opaqueExpr;

const caseBranch: CaseBranchNode = {
    ...nodeFacts,
    id: 10,
    kind: "case-branch",
    span: { start: 0, end: 6 },
    leafRange: { start: 0, end: 1 },
    branchKind: "when",
    conditionChildId: 9,
    valueChildId: 2,
    children: [expression, opaque],
};

const windowSpec: WindowSpecNode = {
    ...nodeFacts,
    id: 11,
    kind: "window-spec",
    span: { start: 0, end: 6 },
    leafRange: { start: 0, end: 1 },
    nameLeafRange: null,
    partitionChildId: null,
    orderChildId: null,
    frameChildId: null,
    children: [],
};

const typeExpression: TypeExpressionNode = {
    ...nodeFacts,
    id: 12,
    kind: "type-expression",
    span: { start: 0, end: 6 },
    leafRange: { start: 0, end: 1 },
    typeNameLeafRange: { start: 0, end: 1 },
    argumentListChildId: null,
    memberListChildId: null,
    children: [],
};

const nodes: readonly SyntaxNode[] = [
    program,
    statement,
    query,
    cte,
    clause,
    relation,
    list,
    listItem,
    expression,
    caseBranch,
    windowSpec,
    typeExpression,
    opaque,
];

function kindLabel(node: SyntaxNode): string {
    switch (node.kind) {
        case "program":
        case "statement":
        case "set-statement":
        case "set-payload":
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

const structuredKind: StructuredSyntaxKind = "program";
// @ts-expect-error opaque is not a structured syntax kind
const notStructured: StructuredSyntaxKind = "opaque";
void notStructured;
void structuredKind;

const badAliasRelation: RelationNode = {
    ...nodeFacts,
    id: 99,
    kind: "relation",
    span: { start: 0, end: 1 },
    leafRange: { start: 0, end: 1 },
    relationKind: "table",
    nameLeafRange: { start: 0, end: 1 },
    // @ts-expect-error alias must not be a bare string
    alias: "t",
    bodyChildId: null,
    children: [],
};
void badAliasRelation;

const badList: ListNode = {
    ...nodeFacts,
    id: 98,
    kind: "list",
    span: { start: 0, end: 1 },
    leafRange: { start: 0, end: 1 },
    listRole: "select-items",
    // @ts-expect-error separatorLeafIds must be number ids, not raw text
    separatorLeafIds: [","],
    children: [],
};
void badList;

const badStatement: StatementNode = {
    ...nodeFacts,
    id: 97,
    kind: "statement",
    span: { start: 0, end: 1 },
    leafRange: { start: 0, end: 1 },
    // @ts-expect-error illegal statementKind
    statementKind: "merge",
    bodyChildId: null,
    children: [],
};
void badStatement;

// @ts-expect-error legacy StructuredNode without leafRange is not assignable to SyntaxNode
const legacyNode: SyntaxNode = {
    id: 0,
    kind: "program",
    span: { start: 0, end: 1 },
    children: [],
};
void legacyNode;

const metadataNode: ProgramNode = {
    ...nodeFacts,
    id: 0,
    kind: "program",
    span: { start: 0, end: 1 },
    leafRange: { start: 0, end: 1 },
    children: [],
    // @ts-expect-error SyntaxNode must not accept arbitrary metadata bags
    metadata: { anything: true },
};
void metadataNode;

const backend: ParserBackend = {
    id: "wave2a-contract",
    version: "0.0.0",
    parse(input) {
        return {
            root: {
                ...program,
                span: { start: 0, end: input.source.length },
                leafRange: { start: 0, end: 0 },
            },
            leaves: [],
            diagnostics: [],
        };
    },
};

const defaultParseOptions: ParseOptions = {};
const documentParseOptions: ParseOptions = { dialect: "hive", mode: "document" };
const statementParseOptions: ParseOptions = { dialect: "hive", mode: "statement" };
const fragmentParseOptions: ParseOptions = { dialect: "hive", mode: "fragment" };
const parsed: ParseOutput = parseSql("SELECT 1", documentParseOptions);
const internalBackend: ParserBackend = parserBackend;

// @ts-expect-error parser implementation is internal and not a root runtime value export
rootCore.parseSql;
// @ts-expect-error unknown parse mode is rejected
const invalidParseMode: ParseOptions = { mode: "query" };
// @ts-expect-error legacy dialect alias is rejected
const invalidParseDialect: ParseOptions = { dialect: "postgres" };

const lexed = lexSql("SELECT 1");
void lexed;
void backend;
void defaultParseOptions;
void statementParseOptions;
void fragmentParseOptions;
void parsed;
void internalBackend;
void invalidParseMode;
void invalidParseDialect;
void kindLabel;
void nodes;
void alias;
void clause;
void cte;
void query;
void statement;
void expression;
void caseBranch;
void windowSpec;
void typeExpression;
void list;
void listItem;
void relation;
void opaque;
void program;
