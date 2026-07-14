import { freezeImmutableArray } from "../util/immutable-array";
import type { LeafRange } from "./leaf-range";
import type {
    AliasInfo,
    ClauseKind,
    ClauseNode,
    CteNode,
    ListItemNode,
    ListItemRole,
    ListNode,
    ListRole,
    OpaqueBoundary,
    OpaqueNode,
    ProgramNode,
    QueryKind,
    QueryNode,
    RelationKind,
    RelationNode,
    StatementKind,
    StatementNode,
    SyntaxNode,
} from "./node";
import type { StructuralTokenTable } from "./token-table";

export interface NodeFactory {
    checkpoint(): number;
    rollback(checkpoint: number): void;
    createProgram(range: LeafRange, children: readonly StatementNode[]): ProgramNode;
    createStatement(
        range: LeafRange,
        statementKind: StatementKind,
        body: QueryNode | OpaqueNode | null
    ): StatementNode;
    createQuery(
        range: LeafRange,
        queryKind: QueryKind,
        setOperatorLeafIds: readonly number[],
        children: readonly SyntaxNode[]
    ): QueryNode;
    createCte(
        range: LeafRange,
        nameLeafRange: LeafRange,
        columnList: ListNode | null,
        query: QueryNode | OpaqueNode
    ): CteNode;
    createClause(
        range: LeafRange,
        clauseKind: ClauseKind,
        headLeafRange: LeafRange,
        bodyLeafRange: LeafRange,
        children: readonly SyntaxNode[]
    ): ClauseNode;
    createRelation(
        range: LeafRange,
        relationKind: RelationKind,
        alias: AliasInfo | null,
        body: SyntaxNode | null,
        children: readonly SyntaxNode[]
    ): RelationNode;
    createList(
        range: LeafRange,
        listRole: ListRole,
        separatorLeafIds: readonly number[],
        children: readonly ListItemNode[]
    ): ListNode;
    createListItem(
        range: LeafRange,
        itemRole: ListItemRole,
        alias: AliasInfo | null,
        modifierLeafIds: readonly number[],
        value: SyntaxNode
    ): ListItemNode;
    createOpaque(
        range: LeafRange,
        reasonCode: string,
        boundary: OpaqueBoundary
    ): OpaqueNode;
}

function freezeRange(range: LeafRange, leafCount: number, allowEmpty: boolean): LeafRange {
    if (
        !Number.isInteger(range.start) ||
        !Number.isInteger(range.end) ||
        range.start < 0 ||
        range.end < range.start ||
        range.end > leafCount ||
        (!allowEmpty && range.start === range.end)
    ) {
        throw new Error(
            `Invalid node leaf range [${String(range.start)}, ${String(range.end)}) for leafCount=${leafCount}`
        );
    }
    return Object.freeze({ start: range.start, end: range.end });
}

function freezeAlias(alias: AliasInfo | null, leafCount: number): AliasInfo | null {
    if (alias === null) {
        return null;
    }
    if (
        alias.keywordLeafId !== null &&
        (!Number.isInteger(alias.keywordLeafId) ||
            alias.keywordLeafId < 0 ||
            alias.keywordLeafId >= leafCount)
    ) {
        throw new Error(`Invalid alias keyword leaf id: ${String(alias.keywordLeafId)}`);
    }
    return Object.freeze({
        keywordLeafId: alias.keywordLeafId,
        nameLeafRange: freezeRange(alias.nameLeafRange, leafCount, false),
    });
}

function freezeIds(values: readonly number[], leafCount: number, label: string): readonly number[] {
    const copy: number[] = [];
    for (const value of values) {
        if (!Number.isInteger(value) || value < 0 || value >= leafCount) {
            throw new Error(`Invalid ${label} leaf id: ${String(value)}`);
        }
        copy.push(value);
    }
    return freezeImmutableArray(copy);
}

export function createNodeFactory(table: StructuralTokenTable): NodeFactory {
    const leafCount = table.leafCount();
    let nextId = 1;
    let programCreated = false;

    const allocateId = (): number => {
        const id = nextId;
        nextId += 1;
        return id;
    };

    const spanFor = (range: LeafRange, allowEmpty: boolean): {
        readonly range: LeafRange;
        readonly span: ReturnType<StructuralTokenTable["rangeToSpan"]>;
    } => {
        const frozenRange = freezeRange(range, leafCount, allowEmpty);
        return Object.freeze({ range: frozenRange, span: table.rangeToSpan(frozenRange) });
    };

    const factory: NodeFactory = {
        checkpoint(): number {
            return nextId;
        },

        rollback(checkpoint): void {
            if (
                programCreated ||
                !Number.isInteger(checkpoint) ||
                checkpoint < 1 ||
                checkpoint > nextId
            ) {
                throw new Error(`Invalid node factory rollback checkpoint: ${checkpoint}`);
            }
            nextId = checkpoint;
        },

        createProgram(range, children): ProgramNode {
            if (programCreated) {
                throw new Error("Node factory may create ProgramNode only once");
            }
            programCreated = true;
            const base = spanFor(range, true);
            return Object.freeze({
                id: 0,
                kind: "program" as const,
                span: base.span,
                leafRange: base.range,
                children: freezeImmutableArray(children),
            });
        },

        createStatement(range, statementKind, body): StatementNode {
            if (statementKind === "empty" && body !== null) {
                throw new Error("Empty statement must not have a body");
            }
            if (statementKind !== "empty" && body === null) {
                throw new Error(`${statementKind} statement requires a body`);
            }
            if (
                body !== null &&
                ((statementKind === "opaque" && body.kind !== "opaque") ||
                    ((statementKind === "query" || statementKind === "insert-query") &&
                        body.kind !== "query"))
            ) {
                throw new Error(`Invalid ${statementKind} statement body kind: ${body.kind}`);
            }
            const base = spanFor(range, false);
            return Object.freeze({
                id: allocateId(),
                kind: "statement" as const,
                span: base.span,
                leafRange: base.range,
                statementKind,
                bodyChildId: body === null ? null : body.id,
                children: body === null ? freezeImmutableArray([]) : freezeImmutableArray([body]),
            });
        },

        createQuery(range, queryKind, setOperatorLeafIds, children): QueryNode {
            const base = spanFor(range, false);
            return Object.freeze({
                id: allocateId(),
                kind: "query" as const,
                span: base.span,
                leafRange: base.range,
                queryKind,
                setOperatorLeafIds: freezeIds(
                    setOperatorLeafIds,
                    leafCount,
                    "set operator"
                ),
                children: freezeImmutableArray(children),
            });
        },

        createCte(range, nameLeafRange, columnList, query): CteNode {
            const base = spanFor(range, false);
            const children: SyntaxNode[] = [];
            if (columnList !== null) {
                children.push(columnList);
            }
            children.push(query);
            return Object.freeze({
                id: allocateId(),
                kind: "cte" as const,
                span: base.span,
                leafRange: base.range,
                nameLeafRange: freezeRange(nameLeafRange, leafCount, false),
                queryChildId: query.id,
                columnListChildId: columnList === null ? null : columnList.id,
                children: freezeImmutableArray(children),
            });
        },

        createClause(range, clauseKind, headLeafRange, bodyLeafRange, children): ClauseNode {
            const base = spanFor(range, false);
            return Object.freeze({
                id: allocateId(),
                kind: "clause" as const,
                span: base.span,
                leafRange: base.range,
                clauseKind,
                headLeafRange: freezeRange(headLeafRange, leafCount, true),
                bodyLeafRange: freezeRange(bodyLeafRange, leafCount, true),
                children: freezeImmutableArray(children),
            });
        },

        createRelation(range, relationKind, alias, body, children): RelationNode {
            const base = spanFor(range, false);
            if (body !== null) {
                let occurrences = 0;
                for (const child of children) {
                    if (child === body) {
                        occurrences += 1;
                    }
                }
                if (occurrences !== 1) {
                    throw new Error(
                        `${relationKind} relation body must appear exactly once in children`
                    );
                }
            }
            return Object.freeze({
                id: allocateId(),
                kind: "relation" as const,
                span: base.span,
                leafRange: base.range,
                relationKind,
                alias: freezeAlias(alias, leafCount),
                bodyChildId: body === null ? null : body.id,
                children: freezeImmutableArray(children),
            });
        },

        createList(range, listRole, separatorLeafIds, children): ListNode {
            const base = spanFor(range, false);
            return Object.freeze({
                id: allocateId(),
                kind: "list" as const,
                span: base.span,
                leafRange: base.range,
                listRole,
                separatorLeafIds: freezeIds(separatorLeafIds, leafCount, "separator"),
                children: freezeImmutableArray(children),
            });
        },

        createListItem(range, itemRole, alias, modifierLeafIds, value): ListItemNode {
            const base = spanFor(range, false);
            return Object.freeze({
                id: allocateId(),
                kind: "list-item" as const,
                span: base.span,
                leafRange: base.range,
                itemRole,
                alias: freezeAlias(alias, leafCount),
                modifierLeafIds: freezeIds(modifierLeafIds, leafCount, "modifier"),
                valueChildId: value.id,
                children: freezeImmutableArray([value]),
            });
        },

        createOpaque(range, reasonCode, boundary): OpaqueNode {
            if (reasonCode.length === 0) {
                throw new Error("Opaque reasonCode must be non-empty");
            }
            const base = spanFor(range, false);
            return Object.freeze({
                id: allocateId(),
                kind: "opaque" as const,
                span: base.span,
                leafRange: base.range,
                reasonCode,
                boundary,
            });
        },
    };

    return Object.freeze(factory);
}
