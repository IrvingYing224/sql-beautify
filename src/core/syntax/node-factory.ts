import {
    isCapabilityIdentity,
    type CapabilityIdentity,
} from "../diagnostics/diagnostic";
import {
    EMPTY_FROZEN_ARRAY,
    freezeImmutableArray,
} from "../util/immutable-array";
import type { SourceLeaf } from "../lexer/token";
import type { Dialect } from "../config/options";
import type { LeafRange } from "./leaf-range";
import type {
    AliasInfo,
    CaseBranchKind,
    CaseBranchNode,
    ClauseNodeFacts,
    ClauseKind,
    ClauseNode,
    CteNode,
    ExpressionKind,
    ExpressionNode,
    ExpressionNodeFacts,
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
    RelationNodeFacts,
    SetPayloadNode,
    SetStatementNode,
    StatementKind,
    StatementNode,
    SyntaxNode,
    SyntaxNodeFacts,
    SyntaxMarker,
    TypeExpressionNode,
    WindowSpecNode,
} from "./node";
import {
    canonicalRangeToSpan,
    canonicalStructuralTokenTableLeaves,
} from "./token-table";
import type { StructuralTokenTable } from "./token-table";
import {
    isFormatRole,
    isKeywordCaseRole,
    isSyntaxLeafRole,
    isSyntaxMarkerId,
} from "./contextual-fact-contract";

export interface NodeFactory {
    checkpoint(): number;
    rollback(checkpoint: number): void;
    createProgram(range: LeafRange, children: readonly StatementNode[], facts?: SyntaxNodeFacts): ProgramNode;
    createStatement(
        range: LeafRange,
        statementKind: StatementKind,
        body: QueryNode | SetStatementNode | OpaqueNode | null,
        facts?: SyntaxNodeFacts
    ): StatementNode;
    createSetStatement(
        range: LeafRange,
        payload: SetPayloadNode | null,
        facts?: SyntaxNodeFacts
    ): SetStatementNode;
    createSetPayload(
        range: LeafRange,
        keyLeafRange: LeafRange,
        assignmentLeafId: number | null,
        valueLeafRange: LeafRange | null,
        facts?: SyntaxNodeFacts
    ): SetPayloadNode;
    createQuery(
        range: LeafRange,
        queryKind: QueryKind,
        setOperatorLeafIds: readonly number[],
        children: readonly SyntaxNode[],
        facts?: SyntaxNodeFacts
    ): QueryNode;
    createCte(
        range: LeafRange,
        nameLeafRange: LeafRange,
        columnList: ListNode | null,
        query: QueryNode | OpaqueNode,
        facts?: SyntaxNodeFacts
    ): CteNode;
    createClause(
        range: LeafRange,
        clauseKind: ClauseKind,
        headLeafRange: LeafRange,
        bodyLeafRange: LeafRange,
        children: readonly SyntaxNode[],
        facts?: ClauseNodeFacts
    ): ClauseNode;
    createRelation(
        range: LeafRange,
        relationKind: RelationKind,
        alias: AliasInfo | null,
        body: SyntaxNode | null,
        children: readonly SyntaxNode[],
        facts?: RelationNodeFacts
    ): RelationNode;
    createList(
        range: LeafRange,
        listRole: ListRole,
        separatorLeafIds: readonly number[],
        children: readonly ListItemNode[],
        facts?: SyntaxNodeFacts
    ): ListNode;
    createListItem(
        range: LeafRange,
        itemRole: ListItemRole,
        alias: AliasInfo | null,
        modifierLeafIds: readonly number[],
        value: SyntaxNode,
        facts?: SyntaxNodeFacts
    ): ListItemNode;
    createExpression(
        range: LeafRange,
        expressionKind: ExpressionKind,
        operatorLeafIds: readonly number[],
        children: readonly SyntaxNode[],
        facts?: ExpressionNodeFacts
    ): ExpressionNode;
    createCaseBranch(
        range: LeafRange,
        branchKind: CaseBranchKind,
        condition: ExpressionNode | OpaqueNode | null,
        value: ExpressionNode | OpaqueNode,
        facts?: SyntaxNodeFacts
    ): CaseBranchNode;
    createWindowSpec(
        range: LeafRange,
        nameLeafRange: LeafRange | null,
        partition: ListNode | OpaqueNode | null,
        order: ListNode | OpaqueNode | null,
        frame: ExpressionNode | ListNode | OpaqueNode | null,
        facts?: SyntaxNodeFacts
    ): WindowSpecNode;
    createTypeExpression(
        range: LeafRange,
        typeNameLeafRange: LeafRange,
        argumentList: ListNode | null,
        memberList: ListNode | null,
        facts?: SyntaxNodeFacts
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
    readonly dialect: Dialect;
    readonly validation: CanonicalProgramValidationProof;
}

export interface CanonicalProgramValidationProof {
    readonly nodeCount: number;
    ownsNode(value: unknown): boolean;
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

/** Internal whole-graph identity proof for the parser factory and leaf partition. */
export function canonicalProgramValidationProofForLeaves(
    value: unknown,
    leaves: readonly SourceLeaf[],
    dialect: Dialect
): CanonicalProgramValidationProof | null {
    if (typeof value !== "object" || value === null) {
        return null;
    }
    const proof = CANONICAL_PROGRAM_PROOFS.get(value);
    return proof?.leaves === leaves && proof.dialect === dialect
        ? proof.validation
        : null;
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

const INTRINSIC_CONTAINER_FACTS: SyntaxNodeFacts = Object.freeze({
    syntaxMarkers: EMPTY_FROZEN_ARRAY as readonly SyntaxMarker[],
    capabilityId: null,
    formatRole: "intrinsic-container",
});
const INTRINSIC_PRIMITIVE_FACTS: SyntaxNodeFacts = Object.freeze({
    syntaxMarkers: EMPTY_FROZEN_ARRAY as readonly SyntaxMarker[],
    capabilityId: null,
    formatRole: "intrinsic-primitive",
});
const EMPTY_CAPABILITY_FACTS = new Map<string, SyntaxNodeFacts>();

function fallbackFacts(formatRole: "intrinsic-container" | "intrinsic-primitive"): SyntaxNodeFacts {
    return formatRole === "intrinsic-container"
        ? INTRINSIC_CONTAINER_FACTS
        : INTRINSIC_PRIMITIVE_FACTS;
}

function freezeFacts(
    facts: SyntaxNodeFacts | undefined,
    ownerRange: LeafRange,
    leafCount: number,
    defaultRole: "intrinsic-container" | "intrinsic-primitive"
): SyntaxNodeFacts {
    const value = facts ?? fallbackFacts(defaultRole);
    if (
        !isCapabilityIdentity(value.capabilityId) ||
        !isFormatRole(value.formatRole) ||
        value.formatRole === "opaque" ||
        (value.formatRole === "capability") !== (value.capabilityId !== null) ||
        !Array.isArray(value.syntaxMarkers)
    ) {
        throw new Error("Invalid syntax node facts");
    }
    if (value.syntaxMarkers.length === 0) {
        if (value.capabilityId === null) {
            if (value.formatRole === "intrinsic-container") {
                return INTRINSIC_CONTAINER_FACTS;
            }
            if (value.formatRole === "intrinsic-primitive") {
                return INTRINSIC_PRIMITIVE_FACTS;
            }
        }
        const cached = EMPTY_CAPABILITY_FACTS.get(value.capabilityId!);
        if (cached !== undefined) {
            return cached;
        }
        const canonical = Object.freeze({
            syntaxMarkers: EMPTY_FROZEN_ARRAY as readonly SyntaxMarker[],
            capabilityId: value.capabilityId,
            formatRole: value.formatRole,
        });
        EMPTY_CAPABILITY_FACTS.set(value.capabilityId!, canonical);
        return canonical;
    }
    const markers: SyntaxMarker[] = [];
    let previousLeafId = -1;
    for (const marker of value.syntaxMarkers) {
        if (
            marker === null ||
            typeof marker !== "object" ||
            !Number.isInteger(marker.leafId) ||
            marker.leafId < ownerRange.start ||
            marker.leafId >= ownerRange.end ||
            marker.leafId >= leafCount ||
            marker.leafId <= previousLeafId ||
            !isSyntaxMarkerId(marker.syntaxId) ||
            !Number.isInteger(marker.partOrdinal) ||
            marker.partOrdinal < 0 ||
            !isSyntaxLeafRole(marker.syntaxRole) ||
            typeof marker.keywordCaseEligible !== "boolean" ||
            (marker.keywordCaseEligible && !isKeywordCaseRole(marker.syntaxRole))
        ) {
            throw new Error("Invalid syntax marker");
        }
        previousLeafId = marker.leafId;
        markers.push(Object.freeze({
            leafId: marker.leafId,
            syntaxId: marker.syntaxId,
            partOrdinal: marker.partOrdinal,
            syntaxRole: marker.syntaxRole,
            keywordCaseEligible: marker.keywordCaseEligible,
        }));
    }
    return Object.freeze({
        syntaxMarkers: Object.freeze(markers),
        capabilityId: value.capabilityId,
        formatRole: value.formatRole,
    });
}

function freezeOperatorOccurrences(
    inputs: ExpressionNodeFacts["operatorOccurrences"] | undefined,
    ownerNodeId: number,
    ownerRange: LeafRange,
    operatorLeafIds: readonly number[],
    leafCount: number
): ExpressionNode["operatorOccurrences"] {
    if (inputs === undefined || inputs.length === 0) {
        return EMPTY_FROZEN_ARRAY as ExpressionNode["operatorOccurrences"];
    }
    if (!Array.isArray(inputs)) {
        throw new Error("Expression operator occurrences must be an array");
    }
    const operatorIds = new Set(operatorLeafIds);
    const claimedLeaves = new Set<number>();
    const occurrences: ExpressionNode["operatorOccurrences"][number][] = [];
    for (const input of inputs) {
        const semantics = input.semantics;
        const leafIds = freezeIds(input.leafIds, leafCount, "operator occurrence");
        if (
            semantics === null ||
            typeof semantics !== "object" ||
            !Object.isFrozen(semantics) ||
            typeof semantics.id !== "string" ||
            semantics.id.length === 0 ||
            leafIds.length === 0
        ) {
            throw new Error("Invalid operator occurrence semantics");
        }
        let previous = -1;
        for (const leafId of leafIds) {
            if (
                leafId < ownerRange.start ||
                leafId >= ownerRange.end ||
                leafId <= previous ||
                !operatorIds.has(leafId) ||
                claimedLeaves.has(leafId)
            ) {
                throw new Error("Invalid or duplicate operator occurrence leaf");
            }
            previous = leafId;
            claimedLeaves.add(leafId);
        }
        occurrences.push(Object.freeze({
            ownerNodeId,
            leafIds,
            operatorId: semantics.id,
            capabilityId: semantics.capabilityId,
            fixity: semantics.fixity,
            formatClass: semantics.formatClass,
            semantics,
        }));
    }
    return Object.freeze(occurrences);
}

export function createNodeFactory(table: StructuralTokenTable): NodeFactory {
    return createNodeFactoryInternal(table, false, null);
}

/** Parser-only factory; deliberately not re-exported from the syntax facade. */
export function createParserNodeFactory(
    table: StructuralTokenTable,
    dialect: Dialect
): NodeFactory {
    return createNodeFactoryInternal(table, true, dialect);
}

function createNodeFactoryInternal(
    table: StructuralTokenTable,
    grantCanonicalProgramProvenance: boolean,
    canonicalDialect: Dialect | null
): NodeFactory {
    const leafCount = table.leafCount();
    const trustedRangeToSpan = canonicalRangeToSpan(table);
    const canonicalLeaves = grantCanonicalProgramProvenance
        ? canonicalStructuralTokenTableLeaves(table)
        : null;
    if (grantCanonicalProgramProvenance && canonicalLeaves === null) {
        throw new Error("Parser node factory requires a canonical structural token table");
    }
    if (grantCanonicalProgramProvenance && canonicalDialect === null) {
        throw new Error("Parser node factory requires a canonical dialect");
    }
    const spanForRange = trustedRangeToSpan ?? ((range: LeafRange) => table.rangeToSpan(range));
    const createdNodes: (SyntaxNode | undefined)[] = [];
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
            if (grantCanonicalProgramProvenance) {
                createdNodes.length = checkpoint;
            }
            nextId = checkpoint;
        },

        createProgram(range, children, facts): ProgramNode {
            if (programCreated) {
                throw new Error("Node factory may create ProgramNode only once");
            }
            programCreated = true;
            const leafRange = freezeRange(range, leafCount, true);
            const span = spanForRange(leafRange);
            const nodeFacts = freezeFacts(facts, leafRange, leafCount, "intrinsic-container");
            const program = Object.freeze({
                id: 0,
                kind: "program" as const,
                span,
                leafRange,
                ...nodeFacts,
                children: freezeImmutableArray(children),
            });
            if (grantCanonicalProgramProvenance) {
                createdNodes[program.id] = program;
                const canonicalNodes = Object.freeze(
                    createdNodes as readonly SyntaxNode[]
                );
                const validation: CanonicalProgramValidationProof = Object.freeze({
                    nodeCount: nextId,
                    ownsNode(value: unknown): boolean {
                        return (
                            typeof value === "object" &&
                            value !== null &&
                            Number.isInteger((value as { id?: unknown }).id) &&
                            canonicalNodes[(value as { id: number }).id] === value
                        );
                    },
                });
                CANONICAL_PROGRAM_PROOFS.set(
                    program,
                    Object.freeze({
                        nodeCount: nextId,
                        leaves: canonicalLeaves!,
                        dialect: canonicalDialect!,
                        validation,
                    })
                );
            }
            return program;
        },

        createStatement(range, statementKind, body, facts): StatementNode {
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
                        body.kind !== "query") ||
                    (statementKind === "set" && body.kind !== "set-statement"))
            ) {
                throw new Error(`Invalid ${statementKind} statement body kind: ${body.kind}`);
            }
            const leafRange = freezeRange(range, leafCount, false);
            const span = spanForRange(leafRange);
            const nodeFacts = freezeFacts(facts, leafRange, leafCount, "intrinsic-container");
            const node = Object.freeze({
                id: allocateId(),
                kind: "statement" as const,
                span,
                leafRange,
                ...nodeFacts,
                statementKind,
                bodyChildId: body === null ? null : body.id,
                children: body === null ? freezeImmutableArray([]) : freezeImmutableArray([body]),
            });
            if (grantCanonicalProgramProvenance) {
                createdNodes[node.id] = node;
            }
            return node;
        },

        createSetStatement(range, payload, facts): SetStatementNode {
            const leafRange = freezeRange(range, leafCount, false);
            if (
                payload !== null &&
                (payload.leafRange.start < leafRange.start ||
                    payload.leafRange.end > leafRange.end)
            ) {
                throw new Error("SET payload must belong to its command");
            }
            const span = spanForRange(leafRange);
            const nodeFacts = freezeFacts(
                facts,
                leafRange,
                leafCount,
                "intrinsic-container"
            );
            const node = Object.freeze({
                id: allocateId(),
                kind: "set-statement" as const,
                span,
                leafRange,
                ...nodeFacts,
                payloadChildId: payload === null ? null : payload.id,
                children: payload === null
                    ? freezeImmutableArray([]) as readonly SetPayloadNode[]
                    : freezeImmutableArray([payload]),
            });
            if (grantCanonicalProgramProvenance) {
                createdNodes[node.id] = node;
            }
            return node;
        },

        createSetPayload(
            range,
            keyLeafRange,
            assignmentLeafId,
            valueLeafRange,
            facts
        ): SetPayloadNode {
            const leafRange = freezeRange(range, leafCount, false);
            const frozenKeyRange = freezeRange(keyLeafRange, leafCount, false);
            if (
                frozenKeyRange.start < leafRange.start ||
                frozenKeyRange.end > leafRange.end
            ) {
                throw new Error("SET key range must belong to its payload");
            }
            if (
                assignmentLeafId !== null &&
                (!Number.isInteger(assignmentLeafId) ||
                    assignmentLeafId < frozenKeyRange.end ||
                    assignmentLeafId >= leafRange.end)
            ) {
                throw new Error("Invalid SET assignment leaf id");
            }
            if ((assignmentLeafId === null) !== (valueLeafRange === null)) {
                throw new Error("SET assignment and value range must appear together");
            }
            const frozenValueRange = valueLeafRange === null
                ? null
                : freezeRange(valueLeafRange, leafCount, true);
            if (
                frozenValueRange !== null &&
                (assignmentLeafId === null ||
                    frozenValueRange.start !== assignmentLeafId + 1 ||
                    frozenValueRange.end !== leafRange.end)
            ) {
                throw new Error("SET value range must follow assignment through payload end");
            }
            const span = spanForRange(leafRange);
            const nodeFacts = freezeFacts(
                facts,
                leafRange,
                leafCount,
                "intrinsic-container"
            );
            const node = Object.freeze({
                id: allocateId(),
                kind: "set-payload" as const,
                span,
                leafRange,
                ...nodeFacts,
                keyLeafRange: frozenKeyRange,
                assignmentLeafId,
                valueLeafRange: frozenValueRange,
                children: freezeImmutableArray([]) as readonly [],
            });
            if (grantCanonicalProgramProvenance) {
                createdNodes[node.id] = node;
            }
            return node;
        },

        createQuery(range, queryKind, setOperatorLeafIds, children, facts): QueryNode {
            const leafRange = freezeRange(range, leafCount, false);
            const span = spanForRange(leafRange);
            const nodeFacts = freezeFacts(facts, leafRange, leafCount, "intrinsic-container");
            const node = Object.freeze({
                id: allocateId(),
                kind: "query" as const,
                span,
                leafRange,
                ...nodeFacts,
                queryKind,
                setOperatorLeafIds: freezeIds(
                    setOperatorLeafIds,
                    leafCount,
                    "set operator"
                ),
                children: freezeImmutableArray(children),
            });
            if (grantCanonicalProgramProvenance) {
                createdNodes[node.id] = node;
            }
            return node;
        },

        createCte(range, nameLeafRange, columnList, query, facts): CteNode {
            const leafRange = freezeRange(range, leafCount, false);
            const span = spanForRange(leafRange);
            const nodeFacts = freezeFacts(facts, leafRange, leafCount, "intrinsic-container");
            const children: SyntaxNode[] = [];
            if (columnList !== null) {
                children.push(columnList);
            }
            children.push(query);
            const node = Object.freeze({
                id: allocateId(),
                kind: "cte" as const,
                span,
                leafRange,
                ...nodeFacts,
                nameLeafRange: freezeRange(nameLeafRange, leafCount, false),
                queryChildId: query.id,
                columnListChildId: columnList === null ? null : columnList.id,
                children: freezeImmutableArray(children),
            });
            if (grantCanonicalProgramProvenance) {
                createdNodes[node.id] = node;
            }
            return node;
        },

        createClause(range, clauseKind, headLeafRange, bodyLeafRange, children, facts): ClauseNode {
            const leafRange = freezeRange(range, leafCount, false);
            const span = spanForRange(leafRange);
            const nodeFacts = freezeFacts(facts, leafRange, leafCount, "intrinsic-container");
            const node = Object.freeze({
                id: allocateId(),
                kind: "clause" as const,
                span,
                leafRange,
                ...nodeFacts,
                clauseKind,
                headLeafRange: freezeRange(headLeafRange, leafCount, true),
                bodyLeafRange: freezeRange(bodyLeafRange, leafCount, true),
                separatorLeafIds: freezeIds(
                    facts?.separatorLeafIds ?? [],
                    leafCount,
                    "clause separator"
                ),
                children: freezeImmutableArray(children),
            });
            if (grantCanonicalProgramProvenance) {
                createdNodes[node.id] = node;
            }
            return node;
        },

        createRelation(range, relationKind, alias, body, children, facts): RelationNode {
            const leafRange = freezeRange(range, leafCount, false);
            const span = spanForRange(leafRange);
            const nodeFacts = freezeFacts(facts, leafRange, leafCount, "intrinsic-container");
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
            const node = Object.freeze({
                id: allocateId(),
                kind: "relation" as const,
                span,
                leafRange,
                ...nodeFacts,
                relationKind,
                nameLeafRange:
                    facts?.nameLeafRange === null || facts?.nameLeafRange === undefined
                        ? null
                        : freezeRange(facts.nameLeafRange, leafCount, false),
                alias: freezeAlias(alias, leafCount),
                bodyChildId: body === null ? null : body.id,
                children: freezeImmutableArray(children),
            });
            if (grantCanonicalProgramProvenance) {
                createdNodes[node.id] = node;
            }
            return node;
        },

        createList(range, listRole, separatorLeafIds, children, facts): ListNode {
            const leafRange = freezeRange(range, leafCount, false);
            const span = spanForRange(leafRange);
            const nodeFacts = freezeFacts(facts, leafRange, leafCount, "intrinsic-container");
            const node = Object.freeze({
                id: allocateId(),
                kind: "list" as const,
                span,
                leafRange,
                ...nodeFacts,
                listRole,
                separatorLeafIds: freezeIds(separatorLeafIds, leafCount, "separator"),
                children: freezeImmutableArray(children),
            });
            if (grantCanonicalProgramProvenance) {
                createdNodes[node.id] = node;
            }
            return node;
        },

        createListItem(range, itemRole, alias, modifierLeafIds, value, facts): ListItemNode {
            const leafRange = freezeRange(range, leafCount, false);
            const span = spanForRange(leafRange);
            const nodeFacts = freezeFacts(facts, leafRange, leafCount, "intrinsic-container");
            const node = Object.freeze({
                id: allocateId(),
                kind: "list-item" as const,
                span,
                leafRange,
                ...nodeFacts,
                itemRole,
                alias: freezeAlias(alias, leafCount),
                modifierLeafIds: freezeIds(modifierLeafIds, leafCount, "modifier"),
                valueChildId: value.id,
                children: freezeImmutableArray([value]),
            });
            if (grantCanonicalProgramProvenance) {
                createdNodes[node.id] = node;
            }
            return node;
        },

        createExpression(range, expressionKind, operatorLeafIds, children, facts): ExpressionNode {
            const leafRange = freezeRange(range, leafCount, false);
            const span = spanForRange(leafRange);
            const nodeId = allocateId();
            const nodeFacts = freezeFacts(facts, leafRange, leafCount, "intrinsic-primitive");
            const frozenOperatorLeafIds = freezeIds(
                operatorLeafIds,
                leafCount,
                "expression operator"
            );
            const node = Object.freeze({
                id: nodeId,
                kind: "expression" as const,
                span,
                leafRange,
                ...nodeFacts,
                expressionKind,
                operatorLeafIds: frozenOperatorLeafIds,
                operatorOccurrences: freezeOperatorOccurrences(
                    facts?.operatorOccurrences,
                    nodeId,
                    leafRange,
                    frozenOperatorLeafIds,
                    leafCount
                ),
                children: freezeImmutableArray(children),
            });
            if (grantCanonicalProgramProvenance) {
                createdNodes[node.id] = node;
            }
            return node;
        },

        createCaseBranch(range, branchKind, condition, value, facts): CaseBranchNode {
            if (branchKind === "when" && condition === null) {
                throw new Error("WHEN branch requires a condition");
            }
            if (branchKind === "else" && condition !== null) {
                throw new Error("ELSE branch must not have a condition");
            }
            const leafRange = freezeRange(range, leafCount, false);
            const span = spanForRange(leafRange);
            const nodeFacts = freezeFacts(facts, leafRange, leafCount, "intrinsic-container");
            const children: SyntaxNode[] = [];
            if (condition !== null) {
                children.push(condition);
            }
            children.push(value);
            const node = Object.freeze({
                id: allocateId(),
                kind: "case-branch" as const,
                span,
                leafRange,
                ...nodeFacts,
                branchKind,
                conditionChildId: condition === null ? null : condition.id,
                valueChildId: value.id,
                children: freezeImmutableArray(children),
            });
            if (grantCanonicalProgramProvenance) {
                createdNodes[node.id] = node;
            }
            return node;
        },

        createWindowSpec(
            range,
            nameLeafRange,
            partition,
            order,
            frame,
            facts
        ): WindowSpecNode {
            const leafRange = freezeRange(range, leafCount, false);
            const span = spanForRange(leafRange);
            const nodeFacts = freezeFacts(facts, leafRange, leafCount, "intrinsic-container");
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
            const node = Object.freeze({
                id: allocateId(),
                kind: "window-spec" as const,
                span,
                leafRange,
                ...nodeFacts,
                nameLeafRange:
                    nameLeafRange === null
                        ? null
                        : freezeRange(nameLeafRange, leafCount, false),
                partitionChildId: partition === null ? null : partition.id,
                orderChildId: order === null ? null : order.id,
                frameChildId: frame === null ? null : frame.id,
                children: freezeImmutableArray(children),
            });
            if (grantCanonicalProgramProvenance) {
                createdNodes[node.id] = node;
            }
            return node;
        },

        createTypeExpression(
            range,
            typeNameLeafRange,
            argumentList,
            memberList,
            facts
        ): TypeExpressionNode {
            if (argumentList !== null && memberList !== null) {
                throw new Error("Type expression cannot own argument and member lists together");
            }
            const leafRange = freezeRange(range, leafCount, false);
            const span = spanForRange(leafRange);
            const nodeFacts = freezeFacts(facts, leafRange, leafCount, "intrinsic-primitive");
            const children: SyntaxNode[] = [];
            if (argumentList !== null) {
                children.push(argumentList);
            }
            if (memberList !== null) {
                children.push(memberList);
            }
            const node = Object.freeze({
                id: allocateId(),
                kind: "type-expression" as const,
                span,
                leafRange,
                ...nodeFacts,
                typeNameLeafRange: freezeRange(typeNameLeafRange, leafCount, false),
                argumentListChildId: argumentList === null ? null : argumentList.id,
                memberListChildId: memberList === null ? null : memberList.id,
                children: freezeImmutableArray(children),
            });
            if (grantCanonicalProgramProvenance) {
                createdNodes[node.id] = node;
            }
            return node;
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
            const node = Object.freeze({
                id: allocateId(),
                kind: "opaque" as const,
                span,
                leafRange,
                syntaxMarkers: EMPTY_FROZEN_ARRAY as readonly SyntaxMarker[],
                capabilityId,
                formatRole: "opaque" as const,
                reasonCode,
                boundary,
            });
            if (grantCanonicalProgramProvenance) {
                createdNodes[node.id] = node;
            }
            return node;
        },
    };

    return Object.freeze(factory);
}
