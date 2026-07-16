import {
    isCapabilityIdentity,
    type CapabilityIdentity,
} from "../diagnostics/diagnostic";
import {
    EMPTY_FROZEN_ARRAY,
    freezeImmutableArray,
} from "../util/immutable-array";
import type { SourceLeaf } from "../lexer/token";
import type { LeafRange } from "./leaf-range";
import type {
    AliasInfo,
    CaseBranchKind,
    CaseBranchNode,
    ClauseKind,
    ClauseNode,
    CteNode,
    ExpressionKind,
    ExpressionNode,
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
    TypeExpressionNode,
    WindowSpecNode,
} from "./node";
import {
    canonicalRangeToSpan,
    canonicalStructuralTokenTableLeaves,
} from "./token-table";
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
    createExpression(
        range: LeafRange,
        expressionKind: ExpressionKind,
        operatorLeafIds: readonly number[],
        children: readonly SyntaxNode[]
    ): ExpressionNode;
    createCaseBranch(
        range: LeafRange,
        branchKind: CaseBranchKind,
        condition: ExpressionNode | OpaqueNode | null,
        value: ExpressionNode | OpaqueNode
    ): CaseBranchNode;
    createWindowSpec(
        range: LeafRange,
        nameLeafRange: LeafRange | null,
        partition: ListNode | OpaqueNode | null,
        order: ListNode | OpaqueNode | null,
        frame: ExpressionNode | ListNode | OpaqueNode | null
    ): WindowSpecNode;
    createTypeExpression(
        range: LeafRange,
        typeNameLeafRange: LeafRange,
        argumentList: ListNode | null,
        memberList: ListNode | null
    ): TypeExpressionNode;
    createOpaque(
        range: LeafRange,
        reasonCode: string,
        boundary: OpaqueBoundary,
        capabilityId?: CapabilityIdentity
    ): OpaqueNode;
}

interface CanonicalProgramProof {
    readonly nodeCount: number;
    readonly leaves: readonly SourceLeaf[];
}

const CANONICAL_PROGRAM_PROOFS = new WeakMap<object, CanonicalProgramProof>();

/** Internal provenance for ProgramNodes completed by the canonical factory. */
export function canonicalProgramNodeCount(value: unknown): number | null {
    if (typeof value !== "object" || value === null) {
        return null;
    }
    return CANONICAL_PROGRAM_PROOFS.get(value)?.nodeCount ?? null;
}

/** Internal proof that a canonical ProgramNode belongs to this exact leaf partition. */
export function canonicalProgramNodeCountForLeaves(
    value: unknown,
    leaves: readonly SourceLeaf[]
): number | null {
    if (typeof value !== "object" || value === null) {
        return null;
    }
    const proof = CANONICAL_PROGRAM_PROOFS.get(value);
    return proof?.leaves === leaves ? proof.nodeCount : null;
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
    if (values.length === 0) {
        return EMPTY_FROZEN_ARRAY;
    }
    const copy: number[] = [];
    for (const value of values) {
        if (!Number.isInteger(value) || value < 0 || value >= leafCount) {
            throw new Error(`Invalid ${label} leaf id: ${String(value)}`);
        }
        copy.push(value);
    }
    return Object.freeze(copy);
}

export function createNodeFactory(table: StructuralTokenTable): NodeFactory {
    return createNodeFactoryInternal(table, false);
}

/** Parser-only factory; deliberately not re-exported from the syntax facade. */
export function createParserNodeFactory(table: StructuralTokenTable): NodeFactory {
    return createNodeFactoryInternal(table, true);
}

function createNodeFactoryInternal(
    table: StructuralTokenTable,
    grantCanonicalProgramProvenance: boolean
): NodeFactory {
    const leafCount = table.leafCount();
    const trustedRangeToSpan = canonicalRangeToSpan(table);
    const canonicalLeaves = grantCanonicalProgramProvenance
        ? canonicalStructuralTokenTableLeaves(table)
        : null;
    if (grantCanonicalProgramProvenance && canonicalLeaves === null) {
        throw new Error("Parser node factory requires a canonical structural token table");
    }
    const spanForRange = trustedRangeToSpan ?? ((range: LeafRange) => table.rangeToSpan(range));
    let nextId = 1;
    let programCreated = false;

    const allocateId = (): number => {
        const id = nextId;
        nextId += 1;
        return id;
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
            const leafRange = freezeRange(range, leafCount, true);
            const span = spanForRange(leafRange);
            const program = Object.freeze({
                id: 0,
                kind: "program" as const,
                span,
                leafRange,
                children: freezeImmutableArray(children),
            });
            if (grantCanonicalProgramProvenance) {
                CANONICAL_PROGRAM_PROOFS.set(
                    program,
                    Object.freeze({ nodeCount: nextId, leaves: canonicalLeaves! })
                );
            }
            return program;
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
            const leafRange = freezeRange(range, leafCount, false);
            const span = spanForRange(leafRange);
            return Object.freeze({
                id: allocateId(),
                kind: "statement" as const,
                span,
                leafRange,
                statementKind,
                bodyChildId: body === null ? null : body.id,
                children: body === null ? freezeImmutableArray([]) : freezeImmutableArray([body]),
            });
        },

        createQuery(range, queryKind, setOperatorLeafIds, children): QueryNode {
            const leafRange = freezeRange(range, leafCount, false);
            const span = spanForRange(leafRange);
            return Object.freeze({
                id: allocateId(),
                kind: "query" as const,
                span,
                leafRange,
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
            const leafRange = freezeRange(range, leafCount, false);
            const span = spanForRange(leafRange);
            const children: SyntaxNode[] = [];
            if (columnList !== null) {
                children.push(columnList);
            }
            children.push(query);
            return Object.freeze({
                id: allocateId(),
                kind: "cte" as const,
                span,
                leafRange,
                nameLeafRange: freezeRange(nameLeafRange, leafCount, false),
                queryChildId: query.id,
                columnListChildId: columnList === null ? null : columnList.id,
                children: freezeImmutableArray(children),
            });
        },

        createClause(range, clauseKind, headLeafRange, bodyLeafRange, children): ClauseNode {
            const leafRange = freezeRange(range, leafCount, false);
            const span = spanForRange(leafRange);
            return Object.freeze({
                id: allocateId(),
                kind: "clause" as const,
                span,
                leafRange,
                clauseKind,
                headLeafRange: freezeRange(headLeafRange, leafCount, true),
                bodyLeafRange: freezeRange(bodyLeafRange, leafCount, true),
                children: freezeImmutableArray(children),
            });
        },

        createRelation(range, relationKind, alias, body, children): RelationNode {
            const leafRange = freezeRange(range, leafCount, false);
            const span = spanForRange(leafRange);
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
                span,
                leafRange,
                relationKind,
                alias: freezeAlias(alias, leafCount),
                bodyChildId: body === null ? null : body.id,
                children: freezeImmutableArray(children),
            });
        },

        createList(range, listRole, separatorLeafIds, children): ListNode {
            const leafRange = freezeRange(range, leafCount, false);
            const span = spanForRange(leafRange);
            return Object.freeze({
                id: allocateId(),
                kind: "list" as const,
                span,
                leafRange,
                listRole,
                separatorLeafIds: freezeIds(separatorLeafIds, leafCount, "separator"),
                children: freezeImmutableArray(children),
            });
        },

        createListItem(range, itemRole, alias, modifierLeafIds, value): ListItemNode {
            const leafRange = freezeRange(range, leafCount, false);
            const span = spanForRange(leafRange);
            return Object.freeze({
                id: allocateId(),
                kind: "list-item" as const,
                span,
                leafRange,
                itemRole,
                alias: freezeAlias(alias, leafCount),
                modifierLeafIds: freezeIds(modifierLeafIds, leafCount, "modifier"),
                valueChildId: value.id,
                children: freezeImmutableArray([value]),
            });
        },

        createExpression(range, expressionKind, operatorLeafIds, children): ExpressionNode {
            const leafRange = freezeRange(range, leafCount, false);
            const span = spanForRange(leafRange);
            return Object.freeze({
                id: allocateId(),
                kind: "expression" as const,
                span,
                leafRange,
                expressionKind,
                operatorLeafIds: freezeIds(
                    operatorLeafIds,
                    leafCount,
                    "expression operator"
                ),
                children: freezeImmutableArray(children),
            });
        },

        createCaseBranch(range, branchKind, condition, value): CaseBranchNode {
            if (branchKind === "when" && condition === null) {
                throw new Error("WHEN branch requires a condition");
            }
            if (branchKind === "else" && condition !== null) {
                throw new Error("ELSE branch must not have a condition");
            }
            const leafRange = freezeRange(range, leafCount, false);
            const span = spanForRange(leafRange);
            const children: SyntaxNode[] = [];
            if (condition !== null) {
                children.push(condition);
            }
            children.push(value);
            return Object.freeze({
                id: allocateId(),
                kind: "case-branch" as const,
                span,
                leafRange,
                branchKind,
                conditionChildId: condition === null ? null : condition.id,
                valueChildId: value.id,
                children: freezeImmutableArray(children),
            });
        },

        createWindowSpec(
            range,
            nameLeafRange,
            partition,
            order,
            frame
        ): WindowSpecNode {
            const leafRange = freezeRange(range, leafCount, false);
            const span = spanForRange(leafRange);
            const children: SyntaxNode[] = [];
            if (partition !== null) {
                children.push(partition);
            }
            if (order !== null) {
                children.push(order);
            }
            if (frame !== null) {
                children.push(frame);
            }
            return Object.freeze({
                id: allocateId(),
                kind: "window-spec" as const,
                span,
                leafRange,
                nameLeafRange:
                    nameLeafRange === null
                        ? null
                        : freezeRange(nameLeafRange, leafCount, false),
                partitionChildId: partition === null ? null : partition.id,
                orderChildId: order === null ? null : order.id,
                frameChildId: frame === null ? null : frame.id,
                children: freezeImmutableArray(children),
            });
        },

        createTypeExpression(
            range,
            typeNameLeafRange,
            argumentList,
            memberList
        ): TypeExpressionNode {
            if (argumentList !== null && memberList !== null) {
                throw new Error("Type expression cannot own argument and member lists together");
            }
            const leafRange = freezeRange(range, leafCount, false);
            const span = spanForRange(leafRange);
            const children: SyntaxNode[] = [];
            if (argumentList !== null) {
                children.push(argumentList);
            }
            if (memberList !== null) {
                children.push(memberList);
            }
            return Object.freeze({
                id: allocateId(),
                kind: "type-expression" as const,
                span,
                leafRange,
                typeNameLeafRange: freezeRange(typeNameLeafRange, leafCount, false),
                argumentListChildId: argumentList === null ? null : argumentList.id,
                memberListChildId: memberList === null ? null : memberList.id,
                children: freezeImmutableArray(children),
            });
        },

        createOpaque(range, reasonCode, boundary, capabilityId = null): OpaqueNode {
            if (reasonCode.length === 0) {
                throw new Error("Opaque reasonCode must be non-empty");
            }
            if (!isCapabilityIdentity(capabilityId)) {
                throw new Error(
                    `Invalid opaque capability identity: ${String(capabilityId)}`
                );
            }
            const leafRange = freezeRange(range, leafCount, false);
            const span = spanForRange(leafRange);
            return Object.freeze({
                id: allocateId(),
                kind: "opaque" as const,
                span,
                leafRange,
                reasonCode,
                capabilityId,
                boundary,
            });
        },
    };

    return Object.freeze(factory);
}
