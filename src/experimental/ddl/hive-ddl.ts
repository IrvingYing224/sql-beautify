import type { SourceLeaf } from "../../core/lexer/token";
import type { SourceSpan } from "../../core/source/source-span";
import type { LeafRange } from "../../core/syntax/leaf-range";
import type {
    ListItemNode,
    ListNode,
    SyntaxNode,
    TypeExpressionNode,
} from "../../core/syntax/node";
import {
    parseSqlArtifact,
    parseTypePrefixFromArtifact,
    type ParseArtifact,
} from "../../core/syntax/parser";
import { splitTopLevelTypeItems } from "../../core/syntax/type-cursor";
import { ddlDiagnostic, hiveDdlResult } from "./result";
import type { HiveDdlResult } from "./types";

const RESERVED_COLUMN_STARTS = new Set([
    "clustered",
    "constraint",
    "foreign",
    "location",
    "partitioned",
    "primary",
    "row",
    "sorted",
    "stored",
    "tblproperties",
    "unique",
]);

class HiveDdlParseError extends Error {
    readonly code: string;
    readonly span: SourceSpan;

    constructor(code: string, message: string, span: SourceSpan) {
        super(message);
        this.name = "HiveDdlParseError";
        this.code = code;
        this.span = span;
    }
}

interface HiveDdlColumn {
    readonly nameLeafId: number;
    readonly type: TypeExpressionNode;
    readonly commentLiteralLeafId: number | null;
}

interface HiveCreateTableCst {
    readonly artifact: ParseArtifact;
    readonly external: boolean;
    readonly ifNotExists: boolean;
    readonly terminator: string;
    readonly tableNameRange: LeafRange;
    readonly columns: readonly HiveDdlColumn[];
}

function isSyntaxLeaf(leaf: SourceLeaf): boolean {
    return leaf.channel === "code" || leaf.channel === "protected";
}

function nextSyntax(
    leaves: readonly SourceLeaf[],
    start: number,
    end: number
): number | null {
    for (let index = start; index < end; index++) {
        if (isSyntaxLeaf(leaves[index]!)) {
            return index;
        }
    }
    return null;
}

function trimSyntaxRange(
    leaves: readonly SourceLeaf[],
    range: LeafRange
): LeafRange | null {
    const start = nextSyntax(leaves, range.start, range.end);
    if (start === null) {
        return null;
    }
    let end = range.end;
    while (end > start && !isSyntaxLeaf(leaves[end - 1]!)) {
        end -= 1;
    }
    return Object.freeze({ start, end });
}

function leafSpan(leaf: SourceLeaf): SourceSpan {
    return Object.freeze({ start: leaf.span.start, end: leaf.span.end });
}

function failAt(artifact: ParseArtifact, code: string, message: string, leafId: number): never {
    const leaf = artifact.output.leaves[leafId];
    throw new HiveDdlParseError(
        code,
        message,
        leaf === undefined
            ? Object.freeze({ start: 0, end: artifact.source.length })
            : leafSpan(leaf)
    );
}

function isNameLeaf(leaf: SourceLeaf | undefined): boolean {
    return (
        leaf !== undefined &&
        (leaf.kind === "identifier" ||
            leaf.kind === "keyword" ||
            leaf.kind === "quoted-identifier")
    );
}

function wordAt(artifact: ParseArtifact, leafId: number): string {
    const leaf = artifact.output.leaves[leafId];
    return leaf?.channel === "code"
        ? artifact.tokenTable.normalizedWord(leafId)
        : "";
}

function requireWord(
    artifact: ParseArtifact,
    leafId: number | null,
    expected: string
): number {
    if (leafId === null || wordAt(artifact, leafId) !== expected) {
        failAt(
            artifact,
            "DDL_UNSUPPORTED_STATEMENT",
            `Expected ${expected.toUpperCase()} in Hive CREATE TABLE`,
            leafId ?? 0
        );
    }
    return leafId;
}

function tableNameEnd(
    artifact: ParseArtifact,
    start: number,
    end: number
): { readonly range: LeafRange; readonly openLeafId: number } {
    const leaves = artifact.output.leaves;
    let cursor = start;
    let expectName = true;
    let lastName = -1;
    while (cursor < end) {
        const leaf = leaves[cursor]!;
        if (leaf.channel === "code" && leaf.raw === "(" && !expectName) {
            return Object.freeze({
                range: Object.freeze({ start, end: lastName + 1 }),
                openLeafId: cursor,
            });
        }
        if (expectName) {
            if (!isNameLeaf(leaf)) {
                failAt(artifact, "DDL_TABLE_NAME", "Hive table name is invalid", cursor);
            }
            lastName = cursor;
            expectName = false;
        } else if (leaf.channel === "code" && leaf.raw === ".") {
            expectName = true;
        } else {
            failAt(
                artifact,
                "DDL_UNSUPPORTED_HEADER",
                "Hive CREATE TABLE header contains an unmodeled token",
                cursor
            );
        }
        const next = nextSyntax(leaves, cursor + 1, end);
        if (next === null) {
            break;
        }
        cursor = next;
    }
    failAt(artifact, "DDL_COLUMN_LIST", "Hive CREATE TABLE requires a column list", start);
}

function parseColumns(
    artifact: ParseArtifact,
    openLeafId: number,
    closeLeafId: number
): readonly HiveDdlColumn[] {
    const leaves = artifact.output.leaves;
    const columns: HiveDdlColumn[] = [];
    let cursor = nextSyntax(leaves, openLeafId + 1, closeLeafId);
    if (cursor === null) {
        failAt(artifact, "DDL_EMPTY_COLUMNS", "Hive column list must not be empty", openLeafId);
    }
    const itemRanges = splitTopLevelTypeItems(
        leaves,
        artifact.tokenTable,
        Object.freeze({ start: openLeafId + 1, end: closeLeafId })
    );
    for (const itemRange of itemRanges) {
        cursor = nextSyntax(leaves, itemRange.start, itemRange.end);
        if (cursor === null) {
            failAt(artifact, "DDL_EMPTY_COLUMN", "Hive column item is empty", openLeafId);
        }
        const nameLeaf = leaves[cursor]!;
        if (!isNameLeaf(nameLeaf)) {
            failAt(artifact, "DDL_COLUMN_NAME", "Hive column name is invalid", cursor);
        }
        if (
            nameLeaf.kind !== "quoted-identifier" &&
            RESERVED_COLUMN_STARTS.has(wordAt(artifact, cursor))
        ) {
            failAt(
                artifact,
                "DDL_UNMODELED_COLUMN",
                "Hive table constraints and suffix clauses are not modeled as columns",
                cursor
            );
        }
        const typeStart = nextSyntax(leaves, cursor + 1, itemRange.end);
        if (typeStart === null) {
            failAt(artifact, "DDL_COLUMN_TYPE", "Hive column requires a type", cursor);
        }
        let parsedType: ReturnType<typeof parseTypePrefixFromArtifact>;
        try {
            parsedType = parseTypePrefixFromArtifact(
                artifact,
                Object.freeze({ start: typeStart, end: itemRange.end })
            );
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            failAt(
                artifact,
                "DDL_COLUMN_TYPE",
                `Hive column type is not fully modeled: ${message}`,
                typeStart
            );
        }
        let afterType = nextSyntax(leaves, parsedType.endLeafIndex, itemRange.end);
        let commentLiteralLeafId: number | null = null;
        if (afterType !== null && wordAt(artifact, afterType) === "comment") {
            const literal = nextSyntax(leaves, afterType + 1, itemRange.end);
            if (literal === null || leaves[literal]!.kind !== "string") {
                failAt(
                    artifact,
                    "DDL_COLUMN_COMMENT",
                    "Hive column COMMENT requires one string literal",
                    afterType
                );
            }
            commentLiteralLeafId = literal;
            afterType = nextSyntax(leaves, literal + 1, itemRange.end);
        }
        columns.push(
            Object.freeze({
                nameLeafId: cursor,
                type: parsedType.node,
                commentLiteralLeafId,
            })
        );
        if (afterType !== null) {
            failAt(
                artifact,
                "DDL_UNMODELED_COLUMN",
                "Hive column contains an unmodeled constraint or trailing token",
                afterType
            );
        }
    }
    return Object.freeze(columns);
}

function parseHiveCreateTable(source: string): HiveCreateTableCst {
    const artifact = parseSqlArtifact(source, { dialect: "hive", mode: "document" });
    const leaves = artifact.output.leaves;
    if (
        artifact.output.diagnostics.some(
            (diagnostic) =>
                diagnostic.severity === "error" &&
                diagnostic.recovery === "preserve-target"
        ) ||
        !artifact.tokenTable.statementBoundariesReliable()
    ) {
        throw new HiveDdlParseError(
            "DDL_LEXICAL_STRUCTURE",
            "Lexical or delimiter errors prevent safe Hive DDL parsing",
            Object.freeze({ start: 0, end: source.length })
        );
    }
    const ranges = artifact.tokenTable.statementRanges();
    if (ranges.length !== 1) {
        throw new HiveDdlParseError(
            "DDL_MULTI_STATEMENT",
            "Hive DDL formatter requires exactly one statement",
            Object.freeze({ start: 0, end: source.length })
        );
    }
    for (const leaf of leaves) {
        if (leaf.kind === "line-comment" || leaf.kind === "block-comment") {
            throw new HiveDdlParseError(
                "DDL_COMMENT_TRIVIA",
                "SQL comments in Hive DDL are preserved until their ownership is modeled",
                leafSpan(leaf)
            );
        }
    }
    let statement = trimSyntaxRange(leaves, ranges[0]!);
    if (statement === null) {
        throw new HiveDdlParseError(
            "DDL_EMPTY",
            "Hive DDL source is empty",
            Object.freeze({ start: 0, end: source.length })
        );
    }
    let terminator = "";
    if (leaves[statement.end - 1]!.channel === "code" && leaves[statement.end - 1]!.raw === ";") {
        terminator = leaves[statement.end - 1]!.raw;
        statement = trimSyntaxRange(
            leaves,
            Object.freeze({ start: statement.start, end: statement.end - 1 })
        );
    }
    if (statement === null) {
        throw new HiveDdlParseError(
            "DDL_EMPTY",
            "Hive DDL source is empty",
            Object.freeze({ start: 0, end: source.length })
        );
    }
    let cursor = requireWord(artifact, statement.start, "create");
    cursor = nextSyntax(leaves, cursor + 1, statement.end) ?? statement.end;
    let external = false;
    if (cursor < statement.end && wordAt(artifact, cursor) === "external") {
        external = true;
        cursor = nextSyntax(leaves, cursor + 1, statement.end) ?? statement.end;
    }
    cursor = requireWord(artifact, cursor < statement.end ? cursor : null, "table");
    cursor = nextSyntax(leaves, cursor + 1, statement.end) ?? statement.end;
    let ifNotExists = false;
    if (cursor < statement.end && wordAt(artifact, cursor) === "if") {
        const notLeaf = nextSyntax(leaves, cursor + 1, statement.end);
        requireWord(artifact, notLeaf, "not");
        const existsLeaf = nextSyntax(leaves, notLeaf! + 1, statement.end);
        requireWord(artifact, existsLeaf, "exists");
        ifNotExists = true;
        cursor = nextSyntax(leaves, existsLeaf! + 1, statement.end) ?? statement.end;
    }
    if (cursor >= statement.end) {
        failAt(artifact, "DDL_TABLE_NAME", "Hive CREATE TABLE requires a table name", statement.start);
    }
    const table = tableNameEnd(artifact, cursor, statement.end);
    const closeLeafId = artifact.tokenTable.matchingDelimiterIndex(table.openLeafId);
    if (closeLeafId === null || closeLeafId >= statement.end) {
        failAt(
            artifact,
            "DDL_COLUMN_LIST",
            "Hive CREATE TABLE column list is unbalanced",
            table.openLeafId
        );
    }
    const trailing = nextSyntax(leaves, closeLeafId + 1, statement.end);
    if (trailing !== null) {
        failAt(
            artifact,
            "DDL_UNMODELED_SUFFIX",
            "Hive table suffix is not fully modeled and was preserved",
            trailing
        );
    }
    return Object.freeze({
        artifact,
        external,
        ifNotExists,
        terminator,
        tableNameRange: table.range,
        columns: parseColumns(artifact, table.openLeafId, closeLeafId),
    });
}

function syntaxRaw(artifact: ParseArtifact, range: LeafRange): readonly string[] {
    const values: string[] = [];
    for (let index = range.start; index < range.end; index++) {
        const leaf = artifact.output.leaves[index]!;
        if (isSyntaxLeaf(leaf)) {
            values.push(leaf.raw);
        }
    }
    return Object.freeze(values);
}

function renderQualifiedName(artifact: ParseArtifact, range: LeafRange): string {
    return syntaxRaw(artifact, range).join("");
}

function childById(node: { readonly children: readonly SyntaxNode[] }, id: number): SyntaxNode {
    const child = node.children.find((candidate) => candidate.id === id);
    if (child === undefined) {
        throw new Error("DDL type CST child is missing");
    }
    return child;
}

function renderTypeList(artifact: ParseArtifact, list: ListNode): string {
    return list.children.map((item) => renderTypeItem(artifact, item)).join(",");
}

function renderTypeItem(artifact: ParseArtifact, item: ListItemNode): string {
    const value = childById(item, item.valueChildId);
    const renderedValue = value.kind === "type-expression"
        ? renderType(artifact, value)
        : renderPrimitiveTypeArgument(artifact, value);
    if (item.alias === null) {
        return renderedValue;
    }
    return `${renderQualifiedName(artifact, item.alias.nameLeafRange)}:${renderedValue}`;
}

function renderPrimitiveTypeArgument(artifact: ParseArtifact, node: SyntaxNode): string {
    if (node.kind !== "expression") {
        throw new Error("DDL type argument is not an expression");
    }
    return syntaxRaw(artifact, node.leafRange).join("");
}

function renderType(artifact: ParseArtifact, node: TypeExpressionNode): string {
    const nameLeaf = artifact.output.leaves[node.typeNameLeafRange.start]!;
    const keywordEligible = node.syntaxMarkers.some(
        (marker) => marker.syntaxId === "type:name" && marker.keywordCaseEligible
    );
    const name = keywordEligible ? nameLeaf.raw.toUpperCase() : nameLeaf.raw;
    if (node.argumentListChildId !== null) {
        const list = childById(node, node.argumentListChildId);
        if (list.kind !== "list") {
            throw new Error("DDL type argument list is invalid");
        }
        const delimiter = syntaxRaw(
            artifact,
            Object.freeze({ start: node.typeNameLeafRange.end, end: node.leafRange.end })
        ).find((raw) => raw === "(" || raw === "<");
        if (delimiter === "<") {
            return `${name}<${renderTypeList(artifact, list)}>`;
        }
        return `${name}(${renderTypeList(artifact, list)})`;
    }
    if (node.memberListChildId !== null) {
        const list = childById(node, node.memberListChildId);
        if (list.kind !== "list") {
            throw new Error("DDL type member list is invalid");
        }
        return `${name}<${renderTypeList(artifact, list)}>`;
    }
    const nestedList = node.children.find((child): child is ListNode => child.kind === "list");
    return nestedList === undefined ? name : `${name}<${renderTypeList(artifact, nestedList)}>`;
}

function renderHiveCreateTable(cst: HiveCreateTableCst): string {
    const header = [
        "CREATE",
        ...(cst.external ? ["EXTERNAL"] : []),
        "TABLE",
        ...(cst.ifNotExists ? ["IF", "NOT", "EXISTS"] : []),
        renderQualifiedName(cst.artifact, cst.tableNameRange),
    ].join(" ");
    const rows = cst.columns.map((column) => {
        const name = cst.artifact.output.leaves[column.nameLeafId]!.raw;
        const type = renderType(cst.artifact, column.type);
        const comment = column.commentLiteralLeafId === null
            ? ""
            : ` COMMENT ${cst.artifact.output.leaves[column.commentLiteralLeafId]!.raw}`;
        return Object.freeze({ name, type, comment });
    });
    const maxName = rows.reduce((value, row) => Math.max(value, row.name.length), 0);
    const lines = rows.map((row, index) => {
        const prefix = index === 0 ? "     " : "    ,";
        return `${prefix}${row.name}${" ".repeat(maxName - row.name.length + 1)}${row.type}${row.comment}`;
    });
    return `${header}\n(\n${lines.join("\n")}\n)${cst.terminator}\n`;
}

export function formatHiveDdl(source: string): HiveDdlResult {
    if (typeof source !== "string") {
        return hiveDdlResult(
            "failed",
            "",
            "",
            ddlDiagnostic("DDL_INPUT", "Hive DDL source must be a string", "")
        );
    }
    try {
        const rendered = renderHiveCreateTable(parseHiveCreateTable(source));
        return hiveDdlResult(rendered === source ? "unchanged" : "formatted", source, rendered);
    } catch (error) {
        if (error instanceof HiveDdlParseError) {
            return hiveDdlResult(
                "preserved",
                source,
                source,
                ddlDiagnostic(error.code, error.message, source, "warning", "preserve-target", error.span)
            );
        }
        const message = error instanceof Error ? error.message : String(error);
        return hiveDdlResult(
            "failed",
            source,
            source,
            ddlDiagnostic("DDL_INTERNAL", `Hive DDL formatter failed: ${message}`, source)
        );
    }
}
