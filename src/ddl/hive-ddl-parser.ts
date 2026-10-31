import type { SourceLeaf } from "../core/lexer/token";
import type { SourceSpan } from "../core/source/source-span";
import type { LeafRange } from "../core/syntax/leaf-range";
import type { TypeExpressionNode } from "../core/syntax/node";
import {
    parseSqlArtifact,
    parseTypePrefixFromArtifact,
    type ParseArtifact,
} from "../core/syntax/parser";
import { splitTopLevelTypeItems } from "../core/syntax/type-cursor";

// Words that start a table constraint inside the column list; any other word can name a column (K22).
const RESERVED_COLUMN_STARTS = new Set([
    "constraint",
    "foreign",
    "primary",
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

export class HiveDdlParseError extends Error {
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

export interface HiveDdlColumn {
    readonly nameLeafId: number;
    readonly type: TypeExpressionNode;
    /** The COMMENT keyword and its string literal. */
    readonly comment: readonly [number, number] | null;
}

// Keywords are kept as leaf ids: the renderer re-cases those leaves and reports them.
export interface HiveCreateTableCst {
    readonly artifact: ParseArtifact;
    /** CREATE [EXTERNAL] TABLE [IF NOT EXISTS] */
    readonly headerLeafIds: readonly number[];
    readonly terminator: string;
    readonly tableNameRange: LeafRange;
    readonly columns: readonly HiveDdlColumn[];
    /** PARTITIONED BY */
    readonly partitionLeafIds: readonly number[] | null;
    readonly partitionColumns: readonly HiveDdlColumn[] | null;
    /** STORED AS <format> */
    readonly storageLeafIds: readonly number[] | null;
}

export function isSyntaxLeaf(leaf: SourceLeaf): boolean {
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
                "Hive table constraints are not modeled as columns",
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
        let comment: readonly [number, number] | null = null;
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
            comment = [afterType, literal];
            afterType = nextSyntax(leaves, literal + 1, itemRange.end);
        }
        columns.push({ nameLeafId: cursor, type: parsedType.node, comment });
        if (afterType !== null) {
            failAt(
                artifact,
                "DDL_UNMODELED_COLUMN",
                "Hive column contains an unmodeled constraint or trailing token",
                afterType
            );
        }
    }
    return columns;
}

interface HiveTableSuffixes {
    readonly partitionLeafIds: readonly number[] | null;
    readonly partitionColumns: readonly HiveDdlColumn[] | null;
    readonly storageLeafIds: readonly number[] | null;
}

function parseTableSuffixes(
    artifact: ParseArtifact,
    start: number | null,
    end: number
): HiveTableSuffixes {
    const leaves = artifact.output.leaves;
    let cursor = start;
    let partitionLeafIds: readonly number[] | null = null;
    let partitionColumns: readonly HiveDdlColumn[] | null = null;
    let storageLeafIds: readonly number[] | null = null;
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
        partitionLeafIds = [cursor, byLeafId];
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
        storageLeafIds = [cursor, asLeafId, formatLeafId!];
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
    return { partitionLeafIds, partitionColumns, storageLeafIds };
}

export function parseHiveCreateTable(source: string): HiveCreateTableCst {
    const artifact = parseSqlArtifact(source, { mode: "document" });
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
    const headerLeafIds = [cursor];
    cursor = nextSyntax(leaves, cursor + 1, statement.end) ?? statement.end;
    if (cursor < statement.end && wordAt(artifact, cursor) === "external") {
        headerLeafIds.push(cursor);
        cursor = nextSyntax(leaves, cursor + 1, statement.end) ?? statement.end;
    }
    cursor = requireWord(artifact, cursor < statement.end ? cursor : null, "table");
    headerLeafIds.push(cursor);
    cursor = nextSyntax(leaves, cursor + 1, statement.end) ?? statement.end;
    if (cursor < statement.end && wordAt(artifact, cursor) === "if") {
        const notLeaf = requireWord(artifact, nextSyntax(leaves, cursor + 1, statement.end), "not");
        const existsLeaf = requireWord(artifact, nextSyntax(leaves, notLeaf + 1, statement.end), "exists");
        headerLeafIds.push(cursor, notLeaf, existsLeaf);
        cursor = nextSyntax(leaves, existsLeaf + 1, statement.end) ?? statement.end;
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
    return {
        artifact,
        headerLeafIds,
        terminator,
        tableNameRange: table.range,
        columns: parseColumns(artifact, table.openLeafId, closeLeafId),
        ...suffixes,
    };
}
