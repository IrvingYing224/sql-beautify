import type { SourceLeaf } from "../../core/lexer/token";
import { createDebugEvent, type DebugEvent } from "../../core/diagnostics/debug-event";
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
import {
    resolveHiveDdlFormatOptions,
    type ResolvedHiveDdlFormatOptions,
} from "./options";
import type {
    HiveDdlExecutionResult,
    HiveDdlFormatOptions,
    HiveDdlResult,
} from "./types";

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
const STORAGE_FORMATS: ReadonlySet<string> = new Set([
    "avro",
    "orc",
    "parquet",
    "rcfile",
    "sequencefile",
    "textfile",
]);

class HiveDdlParseError extends Error {
    readonly code: string;
    readonly span: SourceSpan;
    readonly debugCause: unknown | null;

    constructor(
        code: string,
        message: string,
        span: SourceSpan,
        debugCause: unknown | null = null
    ) {
        super(message);
        this.name = "HiveDdlParseError";
        this.code = code;
        this.span = span;
        this.debugCause = debugCause;
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
    readonly partitionColumns: readonly HiveDdlColumn[] | null;
    readonly storageFormat: string | null;
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
            const leaf = artifact.output.leaves[typeStart];
            throw new HiveDdlParseError(
                "DDL_COLUMN_TYPE",
                "Hive column type is not fully modeled",
                leaf === undefined
                    ? Object.freeze({ start: 0, end: artifact.source.length })
                    : leafSpan(leaf),
                error
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

interface HiveTableSuffixes {
    readonly partitionColumns: readonly HiveDdlColumn[] | null;
    readonly storageFormat: string | null;
}

function parseTableSuffixes(
    artifact: ParseArtifact,
    start: number | null,
    end: number
): HiveTableSuffixes {
    const leaves = artifact.output.leaves;
    let cursor = start;
    let partitionColumns: readonly HiveDdlColumn[] | null = null;
    let storageFormat: string | null = null;
    if (cursor !== null && wordAt(artifact, cursor) === "partitioned") {
        const byLeafId = nextSyntax(leaves, cursor + 1, end);
        if (byLeafId === null || wordAt(artifact, byLeafId) !== "by") {
            failAt(
                artifact,
                "DDL_PARTITION_LIST",
                "Hive PARTITIONED BY requires a column list",
                cursor
            );
        }
        const openLeafId = nextSyntax(leaves, byLeafId + 1, end);
        if (openLeafId === null || leaves[openLeafId]!.raw !== "(") {
            failAt(
                artifact,
                "DDL_PARTITION_LIST",
                "Hive PARTITIONED BY requires a column list",
                byLeafId
            );
        }
        const closeLeafId = artifact.tokenTable.matchingDelimiterIndex(openLeafId);
        if (closeLeafId === null || closeLeafId >= end) {
            failAt(
                artifact,
                "DDL_PARTITION_LIST",
                "Hive PARTITIONED BY column list is unbalanced",
                openLeafId
            );
        }
        partitionColumns = parseColumns(artifact, openLeafId, closeLeafId);
        cursor = nextSyntax(leaves, closeLeafId + 1, end);
    }
    if (cursor !== null && wordAt(artifact, cursor) === "stored") {
        const asLeafId = nextSyntax(leaves, cursor + 1, end);
        if (asLeafId === null || wordAt(artifact, asLeafId) !== "as") {
            failAt(
                artifact,
                "DDL_STORAGE_FORMAT",
                "Hive STORED AS requires a supported storage format",
                cursor
            );
        }
        const formatLeafId = nextSyntax(leaves, asLeafId + 1, end);
        const format = formatLeafId === null ? "" : wordAt(artifact, formatLeafId);
        if (!STORAGE_FORMATS.has(format)) {
            failAt(
                artifact,
                "DDL_STORAGE_FORMAT",
                "Hive storage format is not supported",
                formatLeafId ?? asLeafId
            );
        }
        storageFormat = format;
        cursor = nextSyntax(leaves, formatLeafId! + 1, end);
    }
    if (cursor !== null) {
        failAt(
            artifact,
            "DDL_UNMODELED_SUFFIX",
            "Hive table suffix is not fully modeled and was preserved",
            cursor
        );
    }
    return Object.freeze({ partitionColumns, storageFormat });
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
    const suffixes = parseTableSuffixes(
        artifact,
        nextSyntax(leaves, closeLeafId + 1, statement.end),
        statement.end
    );
    return Object.freeze({
        artifact,
        external,
        ifNotExists,
        terminator,
        tableNameRange: table.range,
        columns: parseColumns(artifact, table.openLeafId, closeLeafId),
        partitionColumns: suffixes.partitionColumns,
        storageFormat: suffixes.storageFormat,
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

function keyword(value: string, options: ResolvedHiveDdlFormatOptions): string {
    return options.keywordCase === "upper"
        ? value.toUpperCase()
        : value.toLowerCase();
}

function renderTypeList(
    artifact: ParseArtifact,
    list: ListNode,
    options: ResolvedHiveDdlFormatOptions
): string {
    return list.children.map((item) =>
        renderTypeItem(artifact, item, options)
    ).join(",");
}

function renderTypeItem(
    artifact: ParseArtifact,
    item: ListItemNode,
    options: ResolvedHiveDdlFormatOptions
): string {
    const value = childById(item, item.valueChildId);
    const renderedValue = value.kind === "type-expression"
        ? renderType(artifact, value, options)
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

function renderType(
    artifact: ParseArtifact,
    node: TypeExpressionNode,
    options: ResolvedHiveDdlFormatOptions
): string {
    const nameLeaf = artifact.output.leaves[node.typeNameLeafRange.start]!;
    const keywordEligible = node.syntaxMarkers.some(
        (marker) => marker.syntaxId === "type:name" && marker.keywordCaseEligible
    );
    const name = keywordEligible ? keyword(nameLeaf.raw, options) : nameLeaf.raw;
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
            return `${name}<${renderTypeList(artifact, list, options)}>`;
        }
        return `${name}(${renderTypeList(artifact, list, options)})`;
    }
    if (node.memberListChildId !== null) {
        const list = childById(node, node.memberListChildId);
        if (list.kind !== "list") {
            throw new Error("DDL type member list is invalid");
        }
        return `${name}<${renderTypeList(artifact, list, options)}>`;
    }
    const nestedList = node.children.find((child): child is ListNode => child.kind === "list");
    return nestedList === undefined
        ? name
        : `${name}<${renderTypeList(artifact, nestedList, options)}>`;
}

function renderColumns(
    cst: HiveCreateTableCst,
    columns: readonly HiveDdlColumn[],
    options: ResolvedHiveDdlFormatOptions
): readonly string[] {
    const indent = options.indentStyle === "tab" ? "\t" : "    ";
    const rows = columns.map((column) => {
        const name = cst.artifact.output.leaves[column.nameLeafId]!.raw;
        const type = renderType(cst.artifact, column.type, options);
        const comment = column.commentLiteralLeafId === null
            ? ""
            : ` ${keyword("comment", options)} ${
                  cst.artifact.output.leaves[column.commentLiteralLeafId]!.raw
              }`;
        return Object.freeze({ name, type, comment });
    });
    const maxName = rows.reduce((value, row) => Math.max(value, row.name.length), 0);
    return Object.freeze(rows.map((row, index) => {
        const padding = " ".repeat(maxName - row.name.length + 1);
        if (options.commaStyle === "leading") {
            const prefix = index === 0 ? `${indent} ` : `${indent},`;
            return `${prefix}${row.name}${padding}${row.type}${row.comment}`;
        }
        const comma = index + 1 < rows.length ? "," : "";
        return `${indent}${row.name}${padding}${row.type}${row.comment}${comma}`;
    }));
}

function renderHiveCreateTable(
    cst: HiveCreateTableCst,
    options: ResolvedHiveDdlFormatOptions
): string {
    const header = [
        keyword("create", options),
        ...(cst.external ? [keyword("external", options)] : []),
        keyword("table", options),
        ...(cst.ifNotExists
            ? ["if", "not", "exists"].map((value) => keyword(value, options))
            : []),
        renderQualifiedName(cst.artifact, cst.tableNameRange),
    ].join(" ");
    const lines = [header, "(", ...renderColumns(cst, cst.columns, options), ")"];
    if (cst.partitionColumns !== null) {
        lines.push(
            `${keyword("partitioned", options)} ${keyword("by", options)}`,
            "(",
            ...renderColumns(cst, cst.partitionColumns, options),
            ")"
        );
    }
    if (cst.storageFormat !== null) {
        lines.push(
            `${keyword("stored", options)} ${keyword("as", options)} ${
                keyword(cst.storageFormat, options)
            }`
        );
    }
    lines[lines.length - 1] = `${lines[lines.length - 1]!}${cst.terminator}`;
    return `${lines.join("\n")}\n`;
}

function executionResult(
    result: HiveDdlResult,
    debugEvents: readonly DebugEvent[]
): HiveDdlExecutionResult {
    return Object.freeze({
        ...result,
        ...(debugEvents.length === 0
            ? {}
            : { debugEvents: Object.freeze(Array.from(debugEvents)) }),
    });
}

export function executeFormatHiveDdl(
    source: string,
    options: HiveDdlFormatOptions | unknown = undefined,
    debugEnabled = false
): HiveDdlExecutionResult {
    if (typeof source !== "string") {
        return executionResult(hiveDdlResult(
            "failed",
            "",
            "",
            ddlDiagnostic("DDL_INPUT", "Hive DDL source must be a string", "")
        ), Object.freeze([]));
    }
    const resolved = resolveHiveDdlFormatOptions(options);
    if (resolved === null) {
        return executionResult(hiveDdlResult(
            "failed",
            source,
            source,
            ddlDiagnostic(
                "DDL_OPTIONS",
                "Hive DDL format options are invalid",
                source
            )
        ), Object.freeze([]));
    }
    try {
        const rendered = renderHiveCreateTable(parseHiveCreateTable(source), resolved);
        return executionResult(hiveDdlResult(
            rendered === source ? "unchanged" : "formatted",
            source,
            rendered
        ), Object.freeze([]));
    } catch (error) {
        if (error instanceof HiveDdlParseError) {
            const debugEvents = debugEnabled && error.debugCause !== null
                ? Object.freeze([
                      createDebugEvent("analysis", error.code, error.debugCause),
                  ])
                : Object.freeze([]);
            return executionResult(hiveDdlResult(
                "preserved",
                source,
                source,
                ddlDiagnostic(error.code, error.message, source, "warning", "preserve-target", error.span)
            ), debugEvents);
        }
        return executionResult(hiveDdlResult(
            "failed",
            source,
            source,
            ddlDiagnostic("DDL_INTERNAL", "Hive DDL formatting failed safely", source)
        ), debugEnabled
            ? Object.freeze([createDebugEvent("format", "DDL_INTERNAL", error)])
            : Object.freeze([]));
    }
}

export function formatHiveDdl(
    source: string,
    options?: HiveDdlFormatOptions
): HiveDdlResult;
export function formatHiveDdl(
    source: string,
    options: unknown = undefined
): HiveDdlResult {
    return executeFormatHiveDdl(source, options, false);
}
