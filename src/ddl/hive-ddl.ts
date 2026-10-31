import { MAX_FORMAT_SOURCE_CODE_UNITS } from "../core/api/limits";
import type { Diagnostic } from "../core/diagnostics/diagnostic";
import { createDebugEvent, type DebugEvent } from "../core/diagnostics/debug-event";
import type { LeafRange } from "../core/syntax/leaf-range";
import type {
    ListItemNode,
    ListNode,
    SyntaxNode,
    TypeExpressionNode,
} from "../core/syntax/node";
import type { ParseArtifact } from "../core/syntax/parser";
import {
    alignmentPaddings,
    ddlOutputWithinBudget,
    layoutStartColumn,
    layoutText,
} from "./alignment";
import {
    HiveDdlParseError,
    isSyntaxLeaf,
    parseHiveCreateTable,
    type HiveCreateTableCst,
    type HiveDdlColumn,
} from "./hive-ddl-parser";
import { resolveHiveDdlFormatOptions, type ResolvedHiveDdlFormatOptions } from "./options";
import { ddlDiagnostic } from "./result";
import type { DdlLayout, HiveDdlResult, HiveDdlStatus } from "./types";

function syntaxRaw(artifact: ParseArtifact, range: LeafRange): readonly string[] {
    const values: string[] = [];
    for (let index = range.start; index < range.end; index++) {
        const leaf = artifact.output.leaves[index]!;
        if (isSyntaxLeaf(leaf)) {
            values.push(leaf.raw);
        }
    }
    return values;
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

function renderPrimitiveTypeArgument(artifact: ParseArtifact, node: SyntaxNode): string {
    if (node.kind !== "expression") {
        throw new Error("DDL type argument is not an expression");
    }
    return syntaxRaw(artifact, node.leafRange).join("");
}

/** The keyword case DDL output uses; computeEdits checks the output against it (floor 2). */
export function caseKeyword(raw: string, keywordCase: ResolvedHiveDdlFormatOptions["keywordCase"]): string {
    return keywordCase === "upper" ? raw.toUpperCase() : raw.toLowerCase();
}

/** Renders leaves for one statement and records the ids of the leaves it re-cases. */
class DdlRenderer {
    readonly recased: number[] = [];

    constructor(
        readonly artifact: ParseArtifact,
        readonly options: ResolvedHiveDdlFormatOptions
    ) {}

    keyword(leafId: number): string {
        this.recased.push(leafId);
        return caseKeyword(this.artifact.output.leaves[leafId]!.raw, this.options.keywordCase);
    }

    keywords(leafIds: readonly number[]): string {
        return leafIds.map((leafId) => this.keyword(leafId)).join(" ");
    }

    typeList(list: ListNode): string {
        return list.children.map((item) => this.typeItem(item)).join(",");
    }

    typeItem(item: ListItemNode): string {
        const value = childById(item, item.valueChildId);
        const renderedValue = value.kind === "type-expression"
            ? this.type(value)
            : renderPrimitiveTypeArgument(this.artifact, value);
        if (item.alias === null) {
            return renderedValue;
        }
        return `${renderQualifiedName(this.artifact, item.alias.nameLeafRange)}:${renderedValue}`;
    }

    type(node: TypeExpressionNode): string {
        const nameLeafId = node.typeNameLeafRange.start;
        const keywordEligible = node.syntaxMarkers.some(
            (marker) => marker.syntaxId === "type:name" && marker.keywordCaseEligible
        );
        const name = keywordEligible
            ? this.keyword(nameLeafId)
            : this.artifact.output.leaves[nameLeafId]!.raw;
        if (node.argumentListChildId !== null) {
            const list = childById(node, node.argumentListChildId);
            if (list.kind !== "list") {
                throw new Error("DDL type argument list is invalid");
            }
            const delimiter = syntaxRaw(
                this.artifact,
                { start: node.typeNameLeafRange.end, end: node.leafRange.end }
            ).find((raw) => raw === "(" || raw === "<");
            if (delimiter === "<") {
                return `${name}<${this.typeList(list)}>`;
            }
            return `${name}(${this.typeList(list)})`;
        }
        if (node.memberListChildId !== null) {
            const list = childById(node, node.memberListChildId);
            if (list.kind !== "list") {
                throw new Error("DDL type member list is invalid");
            }
            return `${name}<${this.typeList(list)}>`;
        }
        const nestedList = node.children.find((child): child is ListNode => child.kind === "list");
        return nestedList === undefined ? name : `${name}<${this.typeList(nestedList)}>`;
    }

    columns(columns: readonly HiveDdlColumn[], tabSize: number, startColumn: number): readonly string[] {
        const options = this.options;
        const leaves = this.artifact.output.leaves;
        const indent = options.indentStyle === "tab" ? "\t" : "    ";
        const rows = columns.map((column) => ({
            name: leaves[column.nameLeafId]!.raw,
            type: this.type(column.type),
            comment: column.comment === null
                ? ""
                : ` ${this.keyword(column.comment[0])} ${leaves[column.comment[1]]!.raw}`,
        }));
        const prefixes = rows.map((_, index) => options.commaStyle === "leading"
            ? index === 0 ? `${indent} ` : `${indent},`
            : indent);
        const paddings = alignmentPaddings(
            rows.map((row, index) => ({ prefix: prefixes[index]!, name: row.name })),
            this.artifact.source.length,
            options.maxAlignWidth,
            tabSize,
            startColumn
        );
        return rows.map((row, index) => {
            const padding = " ".repeat(paddings[index]!);
            const comma = options.commaStyle === "trailing" && index + 1 < rows.length ? "," : "";
            return `${prefixes[index]!}${row.name}${padding}${row.type}${row.comment}${comma}`;
        });
    }

    /** The statement as lines without indentation or line breaks. */
    createTable(cst: HiveCreateTableCst, tabSize: number, startColumn: number): string[] {
        const lines = [
            `${this.keywords(cst.headerLeafIds)} ${renderQualifiedName(cst.artifact, cst.tableNameRange)}`,
            "(",
            ...this.columns(cst.columns, tabSize, startColumn),
            ")",
        ];
        if (cst.partitionLeafIds !== null) {
            lines.push(
                this.keywords(cst.partitionLeafIds),
                "(",
                ...this.columns(cst.partitionColumns!, tabSize, startColumn),
                ")"
            );
        }
        if (cst.storageLeafIds !== null) {
            lines.push(this.keywords(cst.storageLeafIds));
        }
        lines[lines.length - 1] = `${lines[lines.length - 1]!}${cst.terminator}`;
        return lines;
    }
}

function result(
    status: HiveDdlStatus,
    text: string,
    diagnostic: Diagnostic | null = null,
    recased: readonly number[] = []
): HiveDdlResult {
    return { status, text, diagnostics: diagnostic === null ? [] : [diagnostic], recased };
}

/**
 * Formats one Hive CREATE TABLE statement into `layout`. The status compares the laid-out output
 * with the source, so an already formatted target is unchanged in any layout (K35).
 */
export function formatHiveDdl(
    source: string,
    options: unknown,
    layout: DdlLayout,
    debugEvents: DebugEvent[] | undefined = undefined
): HiveDdlResult {
    if (source.length > MAX_FORMAT_SOURCE_CODE_UNITS) {
        return result("failed", source, ddlDiagnostic(
            "DDL_RESOURCE_LIMIT",
            "Hive DDL input exceeded the safe resource budget",
            source
        ));
    }
    const resolved = resolveHiveDdlFormatOptions(options);
    if (resolved === null) {
        return result("failed", source, ddlDiagnostic(
            "DDL_OPTIONS",
            "Hive DDL format options are invalid",
            source
        ));
    }
    try {
        const cst = parseHiveCreateTable(source);
        const renderer = new DdlRenderer(cst.artifact, resolved);
        const lines = renderer.createTable(cst, layout.tabSize, layoutStartColumn(layout));
        const rendered = `${lines.join("\n")}\n`;
        const rowCount = cst.columns.length + (cst.partitionColumns?.length ?? 0);
        if (!ddlOutputWithinBudget(source.length, rowCount, rendered.length)) {
            return result("failed", source, ddlDiagnostic(
                "DDL_RESOURCE_LIMIT",
                "Hive DDL output exceeded the safe resource budget",
                source
            ));
        }
        const text = layoutText(lines, layout, source);
        return text === source
            ? result("unchanged", source)
            : result("formatted", text, null, renderer.recased);
    } catch (error) {
        if (error instanceof HiveDdlParseError) {
            if (error.debugCause !== null) {
                debugEvents?.push(createDebugEvent("analysis", error.code, error.debugCause));
            }
            return result("preserved", source, ddlDiagnostic(
                error.code,
                error.message,
                source,
                "warning",
                error.span
            ));
        }
        debugEvents?.push(createDebugEvent("format", "DDL_INTERNAL", error));
        return result("failed", source, ddlDiagnostic(
            "DDL_INTERNAL",
            "Hive DDL formatting failed safely",
            source
        ));
    }
}
