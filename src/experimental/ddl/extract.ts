import type {
    ClauseNode,
    ExpressionNode,
    ListItemNode,
    ListNode,
    QueryNode,
    SyntaxNode,
} from "../../core/syntax/node";
import { analyzeSql } from "../../core/analysis/analyze";
import type {
    AnalysisArtifact,
    AnalyzedArtifact,
    CommentBinding,
} from "../../core/analysis/types";
import type { SourceLeaf } from "../../core/lexer/token";
import { ddlDiagnostic, extractDdlResult } from "./result";
import type {
    ExtractDdlOptions,
    ExtractDdlResult,
} from "./types";

interface ProjectionColumn {
    readonly name: string;
    readonly key: string;
    readonly commentLeafId: number | null;
}

interface ProjectionBranch {
    readonly columns: readonly ProjectionColumn[];
}

class ProjectionError extends Error {
    readonly code: string;

    constructor(code: string, message: string) {
        super(message);
        this.name = "ProjectionError";
        this.code = code;
    }
}

function asAnalyzed(artifact: AnalysisArtifact): AnalyzedArtifact {
    if (artifact.status !== "analyzed") {
        const fatal = artifact.diagnostics.some(
            (diagnostic) =>
                diagnostic.severity === "error" &&
                diagnostic.recovery === "preserve-target"
        );
        throw new ProjectionError(
            artifact.status === "failed" || fatal
                ? "EXTRACT_ANALYSIS_FAILED"
                : "EXTRACT_UNSUPPORTED",
            artifact.status === "failed" || fatal
                ? "Query analysis failed before Extract DDL projection"
                : "Query contains preserved syntax outside the Extract DDL contract"
        );
    }
    return artifact;
}

function directQueryChildren(query: QueryNode): readonly QueryNode[] {
    return Object.freeze(
        query.children.filter((child): child is QueryNode => child.kind === "query")
    );
}

function unwrapQueryEnvelope(
    query: QueryNode,
    artifact: AnalyzedArtifact
): QueryNode {
    const children = directQueryChildren(query);
    if (children.length === 0) {
        return query;
    }
    if (children.length !== 1 || query.queryKind === "set") {
        throw new ProjectionError(
            "EXTRACT_QUERY_SHAPE",
            "Query wrapper does not have one unambiguous body query"
        );
    }
    const child = children[0]!;
    if (child.id === query.id) {
        throw new ProjectionError("EXTRACT_QUERY_CYCLE", "Query wrapper contains itself");
    }
    return unwrapQueryEnvelope(child, artifact);
}

function collectOutputBranches(
    query: QueryNode,
    artifact: AnalyzedArtifact
): readonly QueryNode[] {
    if (query.queryKind !== "set") {
        const unwrapped = unwrapQueryEnvelope(query, artifact);
        return unwrapped.queryKind === "set"
            ? collectOutputBranches(unwrapped, artifact)
            : Object.freeze([unwrapped]);
    }
    const operands = directQueryChildren(query);
    if (operands.length < 2) {
        throw new ProjectionError(
            "EXTRACT_SET_SHAPE",
            "Set query must contain at least two query operands"
        );
    }
    const branches: QueryNode[] = [];
    for (const operand of operands) {
        const unwrapped = unwrapQueryEnvelope(operand, artifact);
        if (unwrapped.queryKind === "set") {
            branches.push(...collectOutputBranches(unwrapped, artifact));
        } else {
            branches.push(unwrapped);
        }
    }
    return Object.freeze(branches);
}

function nameLeaf(artifact: AnalyzedArtifact, leafId: number): SourceLeaf {
    const leaf = artifact.leaves[leafId];
    if (
        leaf === undefined ||
        (leaf.kind !== "identifier" &&
            leaf.kind !== "keyword" &&
            leaf.kind !== "quoted-identifier")
    ) {
        throw new ProjectionError("EXTRACT_NAME_SHAPE", "Projection name is not an identifier leaf");
    }
    return leaf;
}

function canonicalName(leaf: SourceLeaf): string {
    const value = leaf.kind === "quoted-identifier"
        ? leaf.raw.slice(1, -1).replace(/``/g, "`")
        : leaf.raw;
    return `identifier:${value.toLowerCase()}`;
}

function renderedName(leaf: SourceLeaf): string {
    return leaf.kind === "keyword" ? `\`${leaf.raw}\`` : leaf.raw;
}

function terminalExpression(
    node: ExpressionNode,
    artifact: AnalyzedArtifact
): ExpressionNode {
    if (node.expressionKind !== "qualified-identifier") {
        return node;
    }
    const children = node.children.filter(
        (child): child is ExpressionNode => child.kind === "expression"
    );
    if (children.length !== 2) {
        throw new ProjectionError(
            "EXTRACT_NAME_SHAPE",
            "Qualified projection does not have two identifier parts"
        );
    }
    return terminalExpression(children[1]!, artifact);
}

function syntaxText(artifact: AnalyzedArtifact, range: { readonly start: number; readonly end: number }): string {
    return artifact.leaves
        .slice(range.start, range.end)
        .filter((leaf) => leaf.channel === "code" || leaf.channel === "protected")
        .map((leaf) => leaf.raw)
        .join("");
}

function isAllowedCountStar(
    node: ExpressionNode,
    artifact: AnalyzedArtifact
): boolean {
    if (node.expressionKind !== "function-call") {
        return false;
    }
    const functionName = node.children.find(
        (child): child is ExpressionNode => child.kind === "expression" && child.expressionKind === "identifier"
    );
    const argumentList = node.children.find(
        (child): child is ListNode => child.kind === "list" && child.listRole === "function-args"
    );
    if (
        functionName === undefined ||
        syntaxText(artifact, functionName.leafRange).toLowerCase() !== "count" ||
        syntaxText(artifact, node.leafRange).toLowerCase() !== "count(*)" ||
        argumentList === undefined
    ) {
        return false;
    }
    const members = artifact.index.membersOfList(argumentList.id);
    if (members.length !== 1 || members[0]!.modifierLeafIds.length !== 0) {
        return false;
    }
    const value = artifact.index.nodeById(members[0]!.valueChildId);
    return value.kind === "expression" && value.expressionKind === "wildcard";
}

function projectionHasUnsafeWildcard(
    node: ExpressionNode,
    artifact: AnalyzedArtifact
): boolean {
    if (node.expressionKind === "wildcard") {
        return true;
    }
    if (node.expressionKind === "function-call" && isAllowedCountStar(node, artifact)) {
        return false;
    }
    const visit = (child: SyntaxNode): boolean => {
        if (child.kind === "expression") {
            return projectionHasUnsafeWildcard(child, artifact);
        }
        if (child.kind === "opaque") {
            return true;
        }
        return child.children.some(visit);
    };
    return node.children.some(visit);
}

function outputNameOfItem(
    item: ListItemNode,
    artifact: AnalyzedArtifact
): { readonly name: string; readonly key: string } {
    const value = artifact.index.nodeById(item.valueChildId);
    if (value.kind !== "expression") {
        throw new ProjectionError(
            "EXTRACT_VALUE_SHAPE",
            "Projection item has no structured expression value"
        );
    }
    if (projectionHasUnsafeWildcard(value, artifact)) {
        throw new ProjectionError("EXTRACT_WILDCARD", "Wildcard projections are ambiguous");
    }
    if (item.alias !== null) {
        const start = item.alias.nameLeafRange.start;
        const end = item.alias.nameLeafRange.end;
        const aliasLeaves = artifact.leaves.slice(start, end).filter(
            (leaf) => leaf.channel === "code" || leaf.channel === "protected"
        );
        if (aliasLeaves.length !== 1) {
            throw new ProjectionError(
                "EXTRACT_ALIAS_SHAPE",
                "Projection alias must contain exactly one identifier leaf"
            );
        }
        const alias = nameLeaf(artifact, aliasLeaves[0]!.id);
        return Object.freeze({ name: renderedName(alias), key: canonicalName(alias) });
    }
    const terminal = terminalExpression(value, artifact);
    if (
        terminal.expressionKind !== "identifier" &&
        terminal.expressionKind !== "qualified-identifier"
    ) {
        throw new ProjectionError(
            "EXTRACT_VALUE_SHAPE",
            "Expressions require an explicit alias for Extract DDL"
        );
    }
    const last = artifact.leaves
        .slice(terminal.leafRange.start, terminal.leafRange.end)
        .filter((leaf) => leaf.channel === "code" || leaf.channel === "protected")
        .at(-1);
    if (last === undefined || last.raw === "*") {
        throw new ProjectionError("EXTRACT_WILDCARD", "Wildcard projections are ambiguous");
    }
    const identifier = nameLeaf(artifact, last.id);
    return Object.freeze({ name: renderedName(identifier), key: canonicalName(identifier) });
}

function trailingCommentLeaf(
    itemId: number,
    artifact: AnalyzedArtifact
): number | null {
    const bindings = artifact.index.commentsForOwner(itemId);
    let trailing: CommentBinding | null = null;
    for (const binding of bindings) {
        if (binding.placement !== "trailing") {
            throw new ProjectionError(
                "EXTRACT_COMMENT_SHAPE",
                "Only one trailing line comment can become a column comment"
            );
        }
        if (trailing !== null) {
            throw new ProjectionError(
                "EXTRACT_COMMENT_SHAPE",
                "Multiple comments are ambiguous for Extract DDL"
            );
        }
        const leaf = artifact.leaves[binding.commentLeafId];
        if (leaf?.kind !== "line-comment") {
            throw new ProjectionError(
                "EXTRACT_COMMENT_SHAPE",
                "Only trailing line comments are supported"
            );
        }
        trailing = binding;
    }
    return trailing?.commentLeafId ?? null;
}

function projectSelectBranch(
    query: QueryNode,
    artifact: AnalyzedArtifact
): ProjectionBranch {
    const selectClauses = query.children.filter(
        (child): child is ClauseNode =>
            child.kind === "clause" && child.clauseKind === "select"
    );
    if (selectClauses.length !== 1) {
        throw new ProjectionError(
            "EXTRACT_SELECT_SHAPE",
            "Query does not have one direct SELECT clause"
        );
    }
    const lists = selectClauses[0]!.children.filter(
        (child) => child.kind === "list" && child.listRole === "select-items"
    );
    if (lists.length !== 1) {
        throw new ProjectionError(
            "EXTRACT_SELECT_SHAPE",
            "SELECT clause does not have one select-items list"
        );
    }
    const members = artifact.index.membersOfList(lists[0]!.id);
    const columns: ProjectionColumn[] = [];
    const seen = new Set<string>();
    for (const item of members) {
        const output = outputNameOfItem(item, artifact);
        if (seen.has(output.key)) {
            throw new ProjectionError(
                "EXTRACT_DUPLICATE_NAME",
                "Duplicate output names are ambiguous for Extract DDL"
            );
        }
        seen.add(output.key);
        columns.push(
            Object.freeze({
                name: output.name,
                key: output.key,
                commentLeafId: trailingCommentLeaf(item.id, artifact),
            })
        );
    }
    if (columns.length === 0) {
        throw new ProjectionError("EXTRACT_EMPTY", "SELECT list is empty");
    }
    return Object.freeze({ columns: Object.freeze(columns) });
}

function projectQuery(artifact: AnalyzedArtifact): readonly ProjectionBranch[] {
    const statements = artifact.index.statements();
    if (statements.length === 0) {
        throw new ProjectionError("EXTRACT_EMPTY", "Query source has no statement");
    }
    if (statements.length !== 1) {
        throw new ProjectionError(
            "EXTRACT_MULTI_STATEMENT",
            "Extract DDL requires exactly one query statement"
        );
    }
    const statement = statements[0]!;
    if (statement.statementKind !== "query" || statement.bodyChildId === null) {
        throw new ProjectionError(
            "EXTRACT_UNSUPPORTED_STATEMENT",
            "Extract DDL only accepts one structured SELECT query"
        );
    }
    const body = artifact.index.nodeById(statement.bodyChildId);
    if (body.kind !== "query") {
        throw new ProjectionError("EXTRACT_QUERY_SHAPE", "Statement body is not a query node");
    }
    const branches = collectOutputBranches(body, artifact);
    const projected = branches.map((branch) => projectSelectBranch(branch, artifact));
    const first = projected[0]!;
    for (let index = 1; index < projected.length; index++) {
        const current = projected[index]!;
        if (
            current.columns.length !== first.columns.length ||
            current.columns.some((column, columnIndex) => column.key !== first.columns[columnIndex]!.key)
        ) {
            throw new ProjectionError(
                "EXTRACT_SCHEMA_MISMATCH",
                "Set query branches do not have the same output schema"
            );
        }
    }
    return Object.freeze(projected);
}

function commentText(artifact: AnalyzedArtifact, leafId: number | null): string | null {
    if (leafId === null) {
        return null;
    }
    const raw = artifact.leaves[leafId]?.raw;
    if (raw === undefined) {
        throw new ProjectionError("EXTRACT_COMMENT_SHAPE", "Comment leaf is missing");
    }
    return raw.replace(/^--\s?/, "").replace(/\s+$/g, "");
}

function commentLiteral(value: string): string {
    return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "''").replace(/\r\n|\r|\n/g, "\\n")}'`;
}

function extractType(options: ExtractDdlOptions): string {
    const value = options.defaultType ?? "__TYPE_REQUIRED__";
    const normalized = value.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*(?:\(\d+(?:\s*,\s*\d+)?\))?$/.test(normalized)) {
        throw new ProjectionError(
            "EXTRACT_DEFAULT_TYPE",
            "defaultType must be a visible Hive type placeholder or bounded type name"
        );
    }
    return normalized;
}

function renderExtract(
    artifact: AnalyzedArtifact,
    branch: ProjectionBranch,
    type: string
): string {
    const maxName = branch.columns.reduce((value, column) => Math.max(value, column.name.length), 0);
    const lines = branch.columns.map((column, index) => {
        const comment = commentText(artifact, column.commentLeafId);
        const suffix = comment === null ? "" : ` COMMENT ${commentLiteral(comment)}`;
        return `${index === 0 ? "     " : "    ,"}${column.name}${" ".repeat(maxName - column.name.length + 1)}${type}${suffix}`;
    });
    return `${lines.join("\n")}\n`;
}

export function extractDdl(
    source: string,
    options: ExtractDdlOptions = {}
): ExtractDdlResult {
    if (typeof source !== "string") {
        return extractDdlResult(
            "failed",
            "",
            "",
            ddlDiagnostic("EXTRACT_INPUT", "Extract DDL source must be a string", "")
        );
    }
    let artifact: AnalysisArtifact;
    try {
        artifact = analyzeSql(source, { dialect: "hive", mode: "document" });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return extractDdlResult(
            "failed",
            source,
            source,
            ddlDiagnostic("EXTRACT_ANALYSIS_FAILED", `Extract DDL analysis failed: ${message}`, source)
        );
    }
    try {
        const analyzed = asAnalyzed(artifact);
        const branches = projectQuery(analyzed);
        const type = extractType(options);
        const rendered = renderExtract(analyzed, branches[0]!, type);
        if (rendered.length === 0) {
            throw new ProjectionError("EXTRACT_EMPTY", "Extract DDL result is empty");
        }
        return extractDdlResult(
            "extracted",
            source,
            rendered,
            null
        );
    } catch (error) {
        const code = error instanceof ProjectionError ? error.code : "EXTRACT_INTERNAL";
        const message = error instanceof Error ? error.message : String(error);
        const status = code === "EXTRACT_EMPTY"
            ? "empty"
            : code === "EXTRACT_UNSUPPORTED" || code === "EXTRACT_UNSUPPORTED_STATEMENT"
              ? "unsupported"
              : code === "EXTRACT_ANALYSIS_FAILED" ||
                  code === "EXTRACT_INTERNAL" ||
                  code === "EXTRACT_DEFAULT_TYPE"
                ? "failed"
                : "ambiguous";
        return extractDdlResult(
            status,
            source,
            source,
            ddlDiagnostic(code, message, source, status === "failed" ? "error" : "warning")
        );
    }
}
