import { getDialect } from "../dialects/registry";
import type { CapabilityEntry, DialectCapabilityView } from "../dialects/types";
import {
    canonicalSourceLeafPartitionDialect,
    isImmutableSourceLeafPartition,
} from "../lexer/lossless-lexer";
import type { SourceLeaf } from "../lexer/token";
import type { SourceSpan } from "../source/source-span";
import type { LeafRange } from "../syntax/leaf-range";
import {
    canonicalProgramNodeCount,
    canonicalProgramNodeCountForLeaves,
} from "../syntax/node-factory";
import { isCanonicalParseArtifact } from "../syntax/parser";
import type { ParseArtifact } from "../syntax/parser";
import { isCanonicalStructuralTokenTableForLeaves } from "../syntax/token-table";
import type {
    ClauseNode,
    ListItemNode,
    ListNode,
    QueryNode,
    StatementNode,
    SyntaxNode,
} from "../syntax/node";
import { EMPTY_FROZEN_ARRAY } from "../util/immutable-array";
import {
    TRIVIA_LEADING_PRIORITY,
    TRIVIA_TRAILING_PRIORITY,
    bindCommentTriviaFromFacts,
} from "./trivia-binding";
import type { PreparedTriviaFacts } from "./trivia-binding";
import type {
    CommentBinding,
    OffsetLeafLocation,
    SeparatorOwnership,
    SourcePosition,
    StructuralIndex,
    StructuralIndexInput,
    StructuralIndexSnapshot,
} from "./types";

interface TraversalMeta {
    readonly node: SyntaxNode;
    readonly depth: number;
}

const EMPTY_NODES = EMPTY_FROZEN_ARRAY as readonly SyntaxNode[];
const EMPTY_CLAUSES = EMPTY_FROZEN_ARRAY as readonly ClauseNode[];
const EMPTY_BINDINGS = EMPTY_FROZEN_ARRAY as readonly CommentBinding[];
const EMPTY_BINDING_GROUPS = EMPTY_FROZEN_ARRAY as readonly (readonly CommentBinding[])[];
// Recovery fuzz locks the parser to this linear node budget. Enforce the same
// bound before any attacker-controlled id can expand a direct-address array.
const MAX_NODES_PER_LEAF = 16;

function invariantFailure(message: string): never {
    throw new Error(`Structural index invariant failed: ${message}`);
}

function isComment(leaf: SourceLeaf): boolean {
    return leaf.kind === "line-comment" || leaf.kind === "block-comment";
}

function isSyntax(leaf: SourceLeaf): boolean {
    return leaf.channel === "code" || leaf.channel === "protected";
}

function nodeChildren(node: SyntaxNode): readonly SyntaxNode[] {
    return "children" in node ? node.children : EMPTY_NODES;
}

function isStableFrozenDataArray(value: unknown): value is readonly unknown[] {
    if (!Array.isArray(value) || !Object.isFrozen(value)) {
        return false;
    }
    for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, index);
        if (descriptor === undefined || !("value" in descriptor)) {
            return false;
        }
    }
    return true;
}

function validateRange(
    range: LeafRange,
    leafCount: number,
    nodeId: number | null
): void {
    if (
        !Number.isInteger(range.start) ||
        !Number.isInteger(range.end) ||
        range.start < 0 ||
        range.end < range.start ||
        range.end > leafCount
    ) {
        const label = nodeId === null ? "root" : `node ${nodeId}`;
        invariantFailure(
            `${label} has invalid leaf range [${String(range.start)}, ${String(range.end)})`
        );
    }
}

function selectBoundaryOwner(
    owners: Array<TraversalMeta | undefined>,
    boundary: number,
    candidate: TraversalMeta,
    priorities: Readonly<Record<SyntaxNode["kind"], number>>
): void {
    if (candidate.node.kind === "opaque") {
        return;
    }
    const selected = owners[boundary];
    if (
        selected === undefined ||
        priorities[candidate.node.kind] > priorities[selected.node.kind] ||
        (priorities[candidate.node.kind] === priorities[selected.node.kind] &&
            candidate.depth > selected.depth)
    ) {
        owners[boundary] = candidate;
    }
}

function capabilityIdOf(value: object, label: string): string | null {
    if (!Object.prototype.hasOwnProperty.call(value, "capabilityId")) {
        invariantFailure(`${label} is missing required capabilityId`);
    }
    const candidate = (value as { readonly capabilityId?: unknown }).capabilityId;
    if (candidate === null) {
        return null;
    }
    if (typeof candidate !== "string" || candidate.length === 0) {
        invariantFailure(`${label} capabilityId must be a non-empty string or null`);
    }
    return candidate;
}

function resolveCapability(
    dialect: DialectCapabilityView,
    capabilityId: string | null,
    label: string
): CapabilityEntry | null {
    if (capabilityId === null) {
        return null;
    }
    const capability = dialect.getCapability(capabilityId);
    if (capability === null) {
        invariantFailure(`${label} references unknown capability ${capabilityId}`);
    }
    return capability;
}

function resolvePreservationCapability(
    dialect: DialectCapabilityView,
    capabilityId: string | null,
    label: string
): CapabilityEntry | null {
    const capability = resolveCapability(dialect, capabilityId, label);
    if (
        capability !== null &&
        capability.state !== "verbatim" &&
        capability.state !== "diagnostic"
    ) {
        invariantFailure(
            `${label} capability ${capability.id} has non-preservation state ${capability.state}`
        );
    }
    return capability;
}

function freezeSparseNullableIds(
    values: readonly (number | null | undefined)[],
    length: number
): readonly (number | null)[] {
    return Object.freeze(
        Array.from({ length }, (_, index) => values[index] ?? null)
    );
}

function freezeEncodedNullableIds(
    values: Uint32Array
): readonly (number | null)[] {
    return Object.freeze(
        Array.from(values, (value) => (value === 0 ? null : value - 1))
    );
}

function diagnosticIdentityKey(
    capabilityId: string | null,
    code: string,
    span: SourceSpan,
    recovery: StructuralIndexInput["diagnostics"][number]["recovery"]
): string {
    // JSON preserves null as a distinct value and avoids delimiter collisions.
    return JSON.stringify([capabilityId, code, span.start, span.end, recovery]);
}

/**
 * Builds all Wave 2E structural facts with one CST traversal and one canonical
 * leaf/source traversal. Construction uses direct-address arrays that are
 * frozen before exposure; no mutable backing collection escapes.
 */
export function buildStructuralIndex(
    input: StructuralIndexInput,
    parseArtifactProof?: ParseArtifact
): StructuralIndex {
    if (input === null || typeof input !== "object") {
        invariantFailure("input must be an object");
    }
    const { root, leaves, tokenTable, diagnostics } = input;
    const trustedParserArtifact =
        parseArtifactProof !== undefined &&
        isCanonicalParseArtifact(parseArtifactProof) &&
        parseArtifactProof.output.root === root &&
        parseArtifactProof.output.leaves === leaves &&
        parseArtifactProof.output.diagnostics === diagnostics &&
        parseArtifactProof.tokenTable === tokenTable &&
        parseArtifactProof.dialect === input.dialect &&
        parseArtifactProof.hasCommentTrivia === input.hasCommentTrivia;
    if (!isImmutableSourceLeafPartition(leaves)) {
        invariantFailure("leaves must be an immutable canonical lexer partition");
    }
    if (canonicalSourceLeafPartitionDialect(leaves) !== input.dialect) {
        invariantFailure("dialect must match the canonical lexer partition");
    }
    if (!trustedParserArtifact && !isStableFrozenDataArray(diagnostics)) {
        invariantFailure("diagnostics must be a stable frozen data array");
    }
    if (!trustedParserArtifact) {
        for (let diagnosticIndex = 0; diagnosticIndex < diagnostics.length; diagnosticIndex++) {
            const diagnostic = diagnostics[diagnosticIndex]!;
            if (!Object.isFrozen(diagnostic) || !Object.isFrozen(diagnostic.span)) {
                invariantFailure(
                    `diagnostic ${diagnosticIndex} and its span must be frozen`
                );
            }
        }
    }
    if (
        input.hasCommentTrivia !== undefined &&
        typeof input.hasCommentTrivia !== "boolean"
    ) {
        invariantFailure("hasCommentTrivia must be a boolean when provided");
    }
    const hasCommentTrivia = input.hasCommentTrivia ?? leaves.some(isComment);
    if (root === null || typeof root !== "object" || root.kind !== "program" || root.id !== 0) {
        invariantFailure("root must be ProgramNode id 0");
    }
    if (
        !isCanonicalStructuralTokenTableForLeaves(tokenTable, leaves) ||
        typeof tokenTable.leafCount !== "function" ||
        tokenTable.leafCount() !== leaves.length
    ) {
        invariantFailure("token table must describe the same canonical leaf stream");
    }
    const dialect = getDialect(input.dialect);
    const leafCount = leaves.length;
    const canonicalSourceLength =
        leafCount === 0 ? 0 : leaves[leafCount - 1]!.span.end;
    const maxNodeCount = MAX_NODES_PER_LEAF * Math.max(1, leafCount) + 1;
    const canonicalNodeCount = canonicalProgramNodeCount(root);
    const exactCanonicalNodeCount = canonicalProgramNodeCountForLeaves(root, leaves);
    if (canonicalNodeCount !== null && exactCanonicalNodeCount === null) {
        invariantFailure("canonical ProgramNode belongs to a different leaf partition");
    }
    const trustedNodeCount = trustedParserArtifact
        ? exactCanonicalNodeCount
        : null;
    if (
        trustedParserArtifact &&
        (trustedNodeCount === null ||
            !Number.isInteger(trustedNodeCount) ||
            trustedNodeCount < 1 ||
            trustedNodeCount > maxNodeCount)
    ) {
        invariantFailure("canonical parser artifact is missing a valid node-count proof");
    }
    if (!trustedParserArtifact) {
        validateRange(root.leafRange, leafCount, null);
    }

    const recordsById: Array<SyntaxNode | undefined> =
        trustedNodeCount === null ? [] : new Array(trustedNodeCount);
    const parentById: Array<number | null | undefined> | null =
        trustedNodeCount === null ? [] : null;
    const statementByNodeId: Array<number | null | undefined> | null =
        trustedNodeCount === null ? [] : null;
    const queryByNodeId: Array<number | null | undefined> | null =
        trustedNodeCount === null ? [] : null;
    const listByMemberNodeId: Array<number | null | undefined> | null =
        trustedNodeCount === null ? [] : null;
    const parentNodeIdCodes =
        trustedNodeCount === null ? null : new Uint32Array(trustedNodeCount);
    const statementNodeIdCodes =
        trustedNodeCount === null ? null : new Uint32Array(trustedNodeCount);
    const queryNodeIdCodes =
        trustedNodeCount === null ? null : new Uint32Array(trustedNodeCount);
    const listNodeIdCodes =
        trustedNodeCount === null ? null : new Uint32Array(trustedNodeCount);
    const clausesByQueryId = new Map<number, ClauseNode[]>();
    const statements: StatementNode[] = [];
    const queries: QueryNode[] = [];
    const lists: ListNode[] = [];
    const opaqueNodeIds: number[] = [];
    const separatorOwnershipByLeaf = new Map<number, SeparatorOwnership>();
    let visitedNodeCount = 0;

    const startEvents: Array<TraversalMeta[] | undefined> = hasCommentTrivia
        ? new Array(leafCount + 1)
        : [];
    const endEvents: Array<TraversalMeta[] | undefined> = hasCommentTrivia
        ? new Array(leafCount + 1)
        : [];
    const leadingOwners: Array<TraversalMeta | undefined> = hasCommentTrivia
        ? new Array(leafCount + 1)
        : [];
    const trailingOwners: Array<TraversalMeta | undefined> = hasCommentTrivia
        ? new Array(leafCount + 1)
        : [];
    const statementOwnersByEnd: Array<TraversalMeta | undefined> = hasCommentTrivia
        ? new Array(leafCount + 1)
        : [];
    const separatorTrailingOwners: Array<TraversalMeta | undefined> =
        hasCommentTrivia ? new Array(leafCount) : [];

    const workNodes: SyntaxNode[] = [root];
    const workParentNodeIds: number[] = [-1];
    const workDepths: number[] = [0];
    const workStatementNodeIds: number[] = [-1];
    const workQueryNodeIds: number[] = [-1];

    while (workNodes.length > 0) {
        const node = workNodes.pop()!;
        const rawParentNodeId = workParentNodeIds.pop()!;
        const depth = workDepths.pop()!;
        const rawStatementNodeId = workStatementNodeIds.pop()!;
        const rawQueryNodeId = workQueryNodeIds.pop()!;
        const parentNodeId = rawParentNodeId < 0 ? null : rawParentNodeId;
        const inheritedStatementNodeId =
            rawStatementNodeId < 0 ? null : rawStatementNodeId;
        const inheritedQueryNodeId = rawQueryNodeId < 0 ? null : rawQueryNodeId;
        if (node === null || typeof node !== "object") {
            invariantFailure("tree contains a non-object node");
        }
        if (
            !Number.isInteger(node.id) ||
            node.id < 0 ||
            node.id >= maxNodeCount ||
            (trustedNodeCount !== null && node.id >= trustedNodeCount)
        ) {
            invariantFailure(
                `node id must be within the linear budget [0, ${maxNodeCount}), got ${String(node.id)}`
            );
        }
        if (recordsById[node.id] !== undefined) {
            invariantFailure(`duplicate node id, shared child, or cycle at ${node.id}`);
        }
        if (!trustedParserArtifact) {
            validateRange(node.leafRange, leafCount, node.id);
            if (node.kind !== "program" && node.leafRange.start === node.leafRange.end) {
                invariantFailure(`non-program node ${node.id} must own at least one leaf`);
            }
            if (
                !Number.isInteger(node.span.start) ||
                !Number.isInteger(node.span.end) ||
                node.span.start < 0 ||
                node.span.end < node.span.start
            ) {
                invariantFailure(`node ${node.id} has invalid source span`);
            }

            const expectedSpanStart =
                node.leafRange.start === node.leafRange.end
                    ? node.leafRange.start === 0
                        ? 0
                        : node.leafRange.start === leafCount
                          ? canonicalSourceLength
                          : leaves[node.leafRange.start]!.span.start
                    : leaves[node.leafRange.start]!.span.start;
            const expectedSpanEnd =
                node.leafRange.start === node.leafRange.end
                    ? expectedSpanStart
                    : leaves[node.leafRange.end - 1]!.span.end;
            if (
                node.span.start !== expectedSpanStart ||
                node.span.end !== expectedSpanEnd
            ) {
                invariantFailure(`node ${node.id} span does not match its leaf range`);
            }
        }

        const children = nodeChildren(node);
        if (
            !trustedParserArtifact &&
            (!Object.isFrozen(node) ||
                !Object.isFrozen(node.span) ||
                !Object.isFrozen(node.leafRange) ||
                !isStableFrozenDataArray(children))
        ) {
            invariantFailure(
                `node ${node.id}, its range/span, and children must be stable and frozen`
            );
        }
        recordsById[node.id] = node;
        visitedNodeCount += 1;

        const statementNodeId =
            node.kind === "statement" ? node.id : inheritedStatementNodeId;
        const queryNodeId = node.kind === "query" ? node.id : inheritedQueryNodeId;
        if (
            parentNodeIdCodes !== null &&
            statementNodeIdCodes !== null &&
            queryNodeIdCodes !== null
        ) {
            parentNodeIdCodes[node.id] =
                parentNodeId === null ? 0 : parentNodeId + 1;
            statementNodeIdCodes[node.id] =
                statementNodeId === null ? 0 : statementNodeId + 1;
            queryNodeIdCodes[node.id] =
                queryNodeId === null ? 0 : queryNodeId + 1;
        } else {
            parentById![node.id] = parentNodeId;
            statementByNodeId![node.id] = statementNodeId;
            queryByNodeId![node.id] = queryNodeId;
        }

        const meta: TraversalMeta | null = hasCommentTrivia
            ? { node, depth }
            : null;
        if (meta !== null) {
            const starting = startEvents[node.leafRange.start];
            if (starting === undefined) {
                startEvents[node.leafRange.start] = [meta];
            } else {
                starting.push(meta);
            }
            const ending = endEvents[node.leafRange.end];
            if (ending === undefined) {
                endEvents[node.leafRange.end] = [meta];
            } else {
                ending.push(meta);
            }
            selectBoundaryOwner(
                leadingOwners,
                node.leafRange.start,
                meta,
                TRIVIA_LEADING_PRIORITY
            );
            selectBoundaryOwner(
                trailingOwners,
                node.leafRange.end,
                meta,
                TRIVIA_TRAILING_PRIORITY
            );
        }

        if (node.kind === "statement") {
            statements.push(node);
            const selected = statementOwnersByEnd[node.leafRange.end];
            if (
                meta !== null &&
                (selected === undefined || depth > selected.depth)
            ) {
                statementOwnersByEnd[node.leafRange.end] = meta;
            }
        } else if (node.kind === "query") {
            queries.push(node);
            clausesByQueryId.set(node.id, []);
        } else if (node.kind === "clause") {
            if (queryNodeId === null) {
                invariantFailure(`clause ${node.id} has no containing query`);
            }
            const clauses = clausesByQueryId.get(queryNodeId);
            if (clauses === undefined) {
                invariantFailure(`clause ${node.id} references unknown query ${queryNodeId}`);
            }
            clauses.push(node);
        } else if (node.kind === "list") {
            lists.push(node);
            const members = node.children;
            if (node.separatorLeafIds.length !== Math.max(0, members.length - 1)) {
                invariantFailure(
                    `list ${node.id} separator count must equal member count minus one`
                );
            }
            for (let ordinal = 0; ordinal < members.length; ordinal++) {
                const member = members[ordinal]!;
                if (member.kind !== "list-item") {
                    invariantFailure(`list ${node.id} child ${member.id} is not a list-item`);
                }
                if (
                    !Number.isInteger(member.id) ||
                    member.id < 0 ||
                    member.id >= maxNodeCount
                ) {
                    invariantFailure(
                        `list ${node.id} member id exceeds the linear node budget: ${String(member.id)}`
                    );
                }
                if (listNodeIdCodes !== null) {
                    if (listNodeIdCodes[member.id] !== 0) {
                        invariantFailure(`list item ${member.id} has multiple list owners`);
                    }
                    listNodeIdCodes[member.id] = node.id + 1;
                } else {
                    if (listByMemberNodeId![member.id] !== undefined) {
                        invariantFailure(`list item ${member.id} has multiple list owners`);
                    }
                    listByMemberNodeId![member.id] = node.id;
                }
            }
            for (let ordinal = 0; ordinal < node.separatorLeafIds.length; ordinal++) {
                const separatorLeafId = node.separatorLeafIds[ordinal]!;
                if (
                    !Number.isInteger(separatorLeafId) ||
                    separatorLeafId < 0 ||
                    separatorLeafId >= leafCount
                ) {
                    invariantFailure(
                        `list ${node.id} has invalid separator leaf id ${separatorLeafId}`
                    );
                }
                const separatorLeaf = leaves[separatorLeafId];
                if (
                    separatorLeaf === undefined ||
                    separatorLeaf.channel !== "code" ||
                    separatorLeaf.raw !== ","
                ) {
                    invariantFailure(
                        `list ${node.id} separator ${separatorLeafId} is not a code comma`
                    );
                }
                if (separatorOwnershipByLeaf.has(separatorLeafId)) {
                    invariantFailure(`separator leaf ${separatorLeafId} has multiple list owners`);
                }
                const left = members[ordinal];
                const right = members[ordinal + 1];
                if (left === undefined || right === undefined) {
                    invariantFailure(`list ${node.id} separator ${separatorLeafId} lacks neighbors`);
                }
                const ownership: SeparatorOwnership = Object.freeze({
                    separatorLeafId,
                    listNodeId: node.id,
                    ordinal,
                    leftMemberNodeId: left.id,
                    rightMemberNodeId: right.id,
                });
                separatorOwnershipByLeaf.set(separatorLeafId, ownership);
                if (hasCommentTrivia) {
                    separatorTrailingOwners[separatorLeafId] = {
                        node: left,
                        depth: depth + 1,
                    };
                }
            }
        } else if (node.kind === "opaque") {
            const capabilityId = capabilityIdOf(node, `opaque node ${node.id}`);
            resolvePreservationCapability(dialect, capabilityId, `opaque node ${node.id}`);
            opaqueNodeIds.push(node.id);
        }

        for (let childIndex = children.length - 1; childIndex >= 0; childIndex--) {
            const child = children[childIndex]!;
            if (
                !trustedParserArtifact &&
                (child.leafRange.start < node.leafRange.start ||
                    child.leafRange.end > node.leafRange.end)
            ) {
                invariantFailure(`child ${child.id} is outside parent ${node.id}`);
            }
            workNodes.push(child);
            workParentNodeIds.push(node.id);
            workDepths.push(depth + 1);
            workStatementNodeIds.push(statementNodeId ?? -1);
            workQueryNodeIds.push(queryNodeId ?? -1);
        }
    }

    const nodeCount = visitedNodeCount;
    if (
        recordsById.length !== nodeCount ||
        (trustedNodeCount !== null && trustedNodeCount !== nodeCount)
    ) {
        invariantFailure(
            `node ids must be contiguous; visited=${nodeCount}, max=${recordsById.length - 1}`
        );
    }

    for (let nodeId = 0; nodeId < nodeCount; nodeId++) {
        const node = recordsById[nodeId];
        if (node === undefined) {
            invariantFailure(`node ids must be contiguous; missing ${nodeId}`);
        }
        if (parentById !== null) {
            if (parentById[nodeId] === undefined) {
                invariantFailure(`node ${nodeId} is missing its parent fact`);
            }
            if (statementByNodeId![nodeId] === undefined) {
                invariantFailure(`node ${nodeId} is missing its statement fact`);
            }
            if (queryByNodeId![nodeId] === undefined) {
                invariantFailure(`node ${nodeId} is missing its query fact`);
            }
        }
    }

    const frozenNodesById = Object.freeze(recordsById) as readonly SyntaxNode[];
    const frozenParentById =
        parentById === null
            ? null
            : (Object.freeze(parentById) as readonly (number | null)[]);
    const frozenStatementByNodeId =
        statementByNodeId === null
            ? null
            : (Object.freeze(statementByNodeId) as readonly (number | null)[]);
    const frozenQueryByNodeId =
        queryByNodeId === null
            ? null
            : (Object.freeze(queryByNodeId) as readonly (number | null)[]);
    const frozenListByMemberNodeId =
        listByMemberNodeId === null
            ? null
            : Object.freeze(listByMemberNodeId);
    const frozenStatements = Object.freeze(statements);
    const frozenQueries = Object.freeze(queries);
    const frozenLists = Object.freeze(lists);
    const frozenClausesByQuery = new Map<number, readonly ClauseNode[]>();
    for (const [queryNodeId, clauses] of clausesByQueryId) {
        frozenClausesByQuery.set(queryNodeId, Object.freeze(clauses));
    }
    const parentNodeIdAt = (nodeId: number): number | null => {
        if (parentNodeIdCodes !== null) {
            const code = parentNodeIdCodes[nodeId]!;
            return code === 0 ? null : code - 1;
        }
        return frozenParentById![nodeId] ?? null;
    };
    const statementNodeIdAt = (nodeId: number): number | null => {
        if (statementNodeIdCodes !== null) {
            const code = statementNodeIdCodes[nodeId]!;
            return code === 0 ? null : code - 1;
        }
        return frozenStatementByNodeId![nodeId] ?? null;
    };
    const queryNodeIdAt = (nodeId: number): number | null => {
        if (queryNodeIdCodes !== null) {
            const code = queryNodeIdCodes[nodeId]!;
            return code === 0 ? null : code - 1;
        }
        return frozenQueryByNodeId![nodeId] ?? null;
    };
    const listNodeIdAt = (nodeId: number): number | null => {
        if (listNodeIdCodes !== null) {
            const code = listNodeIdCodes[nodeId]!;
            return code === 0 ? null : code - 1;
        }
        return frozenListByMemberNodeId![nodeId] ?? null;
    };

    const startLineByLeaf = new Uint32Array(leafCount);
    const endLineByLeaf: number[] = hasCommentTrivia ? new Array(leafCount) : [];
    const previousSyntaxByLeaf: Array<number | null | undefined> = hasCommentTrivia
        ? new Array(leafCount)
        : [];
    const nextSyntaxByLeaf: Array<number | null | undefined> = hasCommentTrivia
        ? new Array(leafCount)
        : [];
    const deepestContainerNodeIdByLeaf: Array<number | null | undefined> = new Array(
        hasCommentTrivia ? leafCount : 0
    );
    const deepestOpaqueNodeIdByLeaf: Array<number | null | undefined> = new Array(
        hasCommentTrivia ? leafCount : 0
    );
    const commentLeafIndexes: number[] = [];
    const lineStarts: number[] = [0];
    const lineHasContent: boolean[] = hasCommentTrivia ? [false] : [];
    const pendingComments: number[] = [];
    const activeByDepth: Array<TraversalMeta | undefined> = [];
    const activeOpaqueByDepth: Array<TraversalMeta | undefined> = [];
    let deepestActiveDepth = -1;
    let deepestOpaqueDepth = -1;
    let previousSyntax: number | null = null;
    let currentLine = 0;
    let expectedSourceOffset = 0;

    for (let leafIndex = 0; leafIndex < leafCount; leafIndex++) {
        const leaf = leaves[leafIndex];
        if (leaf === undefined || leaf.id !== leafIndex) {
            invariantFailure(`leaf id/index mismatch at ${leafIndex}`);
        }
        if (
            leaf.span.start !== expectedSourceOffset ||
            leaf.span.end <= leaf.span.start ||
            leaf.span.end - leaf.span.start !== leaf.raw.length
        ) {
            invariantFailure(`leaf ${leafIndex} does not form a contiguous UTF-16 partition`);
        }
        expectedSourceOffset = leaf.span.end;

        if (hasCommentTrivia) {
            const endingAtLeaf = endEvents[leafIndex];
            if (endingAtLeaf !== undefined) {
                for (const ending of endingAtLeaf) {
                    activeByDepth[ending.depth] = undefined;
                    if (ending.node.kind === "opaque") {
                        activeOpaqueByDepth[ending.depth] = undefined;
                    }
                }
            }
            while (
                deepestActiveDepth >= 0 &&
                activeByDepth[deepestActiveDepth] === undefined
            ) {
                deepestActiveDepth -= 1;
            }
            while (
                deepestOpaqueDepth >= 0 &&
                activeOpaqueByDepth[deepestOpaqueDepth] === undefined
            ) {
                deepestOpaqueDepth -= 1;
            }
            const startingAtLeaf = startEvents[leafIndex];
            if (startingAtLeaf !== undefined) {
                for (const starting of startingAtLeaf) {
                    activeByDepth[starting.depth] = starting;
                    if (starting.depth > deepestActiveDepth) {
                        deepestActiveDepth = starting.depth;
                    }
                    if (starting.node.kind === "opaque") {
                        activeOpaqueByDepth[starting.depth] = starting;
                        if (starting.depth > deepestOpaqueDepth) {
                            deepestOpaqueDepth = starting.depth;
                        }
                    }
                }
            }

            if (isSyntax(leaf)) {
                if (leaf.channel === "code" && leaf.raw === ",") {
                    previousSyntaxByLeaf[leafIndex] = previousSyntax;
                }
                for (const pendingComment of pendingComments) {
                    nextSyntaxByLeaf[pendingComment] = leafIndex;
                }
                pendingComments.length = 0;
                previousSyntax = leafIndex;
            }
            if (isComment(leaf)) {
                previousSyntaxByLeaf[leafIndex] = previousSyntax;
                commentLeafIndexes.push(leafIndex);
                pendingComments.push(leafIndex);
                deepestContainerNodeIdByLeaf[leafIndex] =
                    activeByDepth[deepestActiveDepth]?.node.id ?? root.id;
                deepestOpaqueNodeIdByLeaf[leafIndex] =
                    activeOpaqueByDepth[deepestOpaqueDepth]?.node.id ?? null;
            }
        } else if (isComment(leaf)) {
            invariantFailure("hasCommentTrivia=false but canonical leaves contain a comment");
        }

        startLineByLeaf[leafIndex] = currentLine;
        const content = leaf.kind !== "whitespace" && leaf.kind !== "newline";
        if (hasCommentTrivia && content && leaf.raw.length > 0) {
            lineHasContent[currentLine] = true;
        }
        if (leaf.raw.indexOf("\n") !== -1 || leaf.raw.indexOf("\r") !== -1) {
            for (let relativeOffset = 0; relativeOffset < leaf.raw.length; relativeOffset++) {
                const code = leaf.raw.charCodeAt(relativeOffset);
                if (code !== 10 && code !== 13) {
                    continue;
                }
                const width =
                    code === 13 && leaf.raw.charCodeAt(relativeOffset + 1) === 10 ? 2 : 1;
                currentLine += 1;
                lineStarts.push(leaf.span.start + relativeOffset + width);
                if (hasCommentTrivia) {
                    lineHasContent[currentLine] = false;
                }
                if (
                    hasCommentTrivia &&
                    content &&
                    relativeOffset + width < leaf.raw.length
                ) {
                    lineHasContent[currentLine] = true;
                }
                relativeOffset += width - 1;
            }
        }
        if (hasCommentTrivia) {
            endLineByLeaf[leafIndex] = currentLine;
        }

    }

    if (hasCommentTrivia !== (commentLeafIndexes.length > 0)) {
        invariantFailure(
            `hasCommentTrivia disagrees with canonical leaves: ${hasCommentTrivia}`
        );
    }

    const sourceLength = canonicalSourceLength;
    if (
        expectedSourceOffset !== sourceLength ||
        root.span.start !== 0 ||
        root.span.end !== sourceLength
    ) {
        invariantFailure(
            `root/source coverage mismatch: partition=${expectedSourceOffset}, root=[${root.span.start}, ${root.span.end})`
        );
    }

    const frozenStartLineByLeaf = startLineByLeaf;
    let bindings: readonly CommentBinding[] = EMPTY_BINDINGS;
    if (commentLeafIndexes.length > 0) {
        const blankLinePrefix: number[] = [0];
        for (let lineIndex = 0; lineIndex < lineHasContent.length; lineIndex++) {
            blankLinePrefix.push(
                blankLinePrefix[lineIndex]! +
                    (lineHasContent[lineIndex] === true ? 0 : 1)
            );
        }
        const ownerIds = (
            values: readonly (TraversalMeta | undefined)[]
        ): readonly (number | null)[] =>
            freezeSparseNullableIds(
                values.map((value) => value?.node.id),
                values.length
            );
        const preparedTriviaFacts: PreparedTriviaFacts = Object.freeze({
            root,
            leaves,
            nodesById: frozenNodesById,
            commentLeafIndexes: Object.freeze(commentLeafIndexes),
            previousSyntaxByLeaf: freezeSparseNullableIds(
                previousSyntaxByLeaf,
                leafCount
            ),
            nextSyntaxByLeaf: freezeSparseNullableIds(nextSyntaxByLeaf, leafCount),
            startLineByLeaf: frozenStartLineByLeaf,
            endLineByLeaf: Object.freeze(endLineByLeaf),
            blankLinePrefix: Object.freeze(blankLinePrefix),
            deepestContainerNodeIdByLeaf: freezeSparseNullableIds(
                deepestContainerNodeIdByLeaf,
                leafCount
            ),
            deepestOpaqueNodeIdByLeaf: freezeSparseNullableIds(
                deepestOpaqueNodeIdByLeaf,
                leafCount
            ),
            leadingOwnerNodeIdByBoundary: ownerIds(leadingOwners),
            trailingOwnerNodeIdByBoundary: ownerIds(trailingOwners),
            statementOwnerNodeIdByEnd: ownerIds(statementOwnersByEnd),
            separatorTrailingOwnerNodeIdByLeaf: ownerIds(separatorTrailingOwners),
        });
        bindings = bindCommentTriviaFromFacts(preparedTriviaFacts);
    }
    if (bindings.length !== commentLeafIndexes.length) {
        invariantFailure("every comment must have exactly one binding");
    }
    const bindingByCommentLeaf: Array<CommentBinding | undefined> = new Array(
        bindings.length === 0 ? 0 : leafCount
    );
    const bindingsByOwner: Array<CommentBinding[] | undefined> = new Array(
        bindings.length === 0 ? 0 : nodeCount
    );
    for (const binding of bindings) {
        const leaf = leaves[binding.commentLeafId];
        if (leaf === undefined || !isComment(leaf)) {
            invariantFailure(`comment binding references non-comment leaf ${binding.commentLeafId}`);
        }
        if (bindingByCommentLeaf[binding.commentLeafId] !== undefined) {
            invariantFailure(`comment leaf ${binding.commentLeafId} has multiple bindings`);
        }
        if (recordsById[binding.ownerNodeId] === undefined) {
            invariantFailure(`comment binding references missing owner ${binding.ownerNodeId}`);
        }
        bindingByCommentLeaf[binding.commentLeafId] = binding;
        const ownerBindings = bindingsByOwner[binding.ownerNodeId];
        if (ownerBindings === undefined) {
            bindingsByOwner[binding.ownerNodeId] = [binding];
        } else {
            ownerBindings.push(binding);
        }
    }
    for (const commentLeafIndex of commentLeafIndexes) {
        if (bindingByCommentLeaf[commentLeafIndex] === undefined) {
            invariantFailure(`comment leaf ${commentLeafIndex} has no binding`);
        }
    }

    const frozenLineStarts = Object.freeze(lineStarts);
    const frozenBindingByCommentLeaf = Object.freeze(bindingByCommentLeaf);
    const frozenBindingsByOwner: readonly (readonly CommentBinding[])[] =
        bindings.length === 0
            ? EMPTY_BINDING_GROUPS
            : Object.freeze(
                  Array.from({ length: nodeCount }, (_, nodeId) => {
                      const values = bindingsByOwner[nodeId];
                      return values === undefined
                          ? EMPTY_BINDINGS
                          : Object.freeze(values);
                  })
              );

    const diagnosticCapabilityIds = Object.freeze(
        diagnostics.map((diagnostic, diagnosticIndex) => {
            const capabilityId = capabilityIdOf(
                diagnostic,
                `diagnostic ${diagnosticIndex}`
            );
            resolvePreservationCapability(
                dialect,
                capabilityId,
                `diagnostic ${diagnosticIndex}`
            );
            return capabilityId;
        })
    );

    const diagnosticKeys = new Set<string>();
    for (let diagnosticIndex = 0; diagnosticIndex < diagnostics.length; diagnosticIndex++) {
        const diagnostic = diagnostics[diagnosticIndex]!;
        const capabilityId = diagnosticCapabilityIds[diagnosticIndex] ?? null;
        diagnosticKeys.add(
            diagnosticIdentityKey(
                capabilityId,
                diagnostic.code,
                diagnostic.span,
                diagnostic.recovery
            )
        );
    }
    for (const nodeId of opaqueNodeIds) {
        const node = frozenNodesById[nodeId]!;
        if (node.kind !== "opaque") {
            invariantFailure(`opaque occurrence index points to ${node.kind} node ${nodeId}`);
        }
        const capabilityId = capabilityIdOf(node, `opaque node ${node.id}`);
        const allowedRecoveries =
            node.boundary === "target"
                ? (["preserve-target"] as const)
                : node.boundary === "statement"
                  ? (["preserve-statement", "verbatim-node"] as const)
                  : (["verbatim-node"] as const);
        const hasExactDiagnostic = allowedRecoveries.some((recovery) =>
            diagnosticKeys.has(
                diagnosticIdentityKey(
                    capabilityId,
                    node.reasonCode,
                    node.span,
                    recovery
                )
            )
        );
        if (!hasExactDiagnostic) {
            invariantFailure(
                `opaque node ${node.id} capability ${capabilityId} lacks an exact matching diagnostic`
            );
        }
    }

    let snapshotCache: StructuralIndexSnapshot | null = null;

    function assertNodeId(nodeId: number): SyntaxNode {
        if (!Number.isInteger(nodeId) || nodeId < 0 || nodeId >= frozenNodesById.length) {
            throw new Error(`Node id out of range: ${String(nodeId)}`);
        }
        return frozenNodesById[nodeId]!;
    }

    function assertLeafId(leafId: number): SourceLeaf {
        if (!Number.isInteger(leafId) || leafId < 0 || leafId >= leafCount) {
            throw new Error(`Leaf id out of range: ${String(leafId)}`);
        }
        return leaves[leafId]!;
    }

    function assertQueryNodeId(queryNodeId: number): QueryNode {
        const node = assertNodeId(queryNodeId);
        if (node.kind !== "query") {
            throw new Error(`Expected query node id, got ${queryNodeId}:${node.kind}`);
        }
        return node;
    }

    function assertListNodeId(listNodeId: number): ListNode {
        const node = assertNodeId(listNodeId);
        if (node.kind !== "list") {
            throw new Error(`Expected list node id, got ${listNodeId}:${node.kind}`);
        }
        return node;
    }

    const index: StructuralIndex = Object.freeze({
        nodes(): readonly SyntaxNode[] {
            return frozenNodesById;
        },
        nodeById(nodeId: number): SyntaxNode {
            return assertNodeId(nodeId);
        },
        parentOf(nodeId: number): SyntaxNode | null {
            assertNodeId(nodeId);
            const parentNodeId = parentNodeIdAt(nodeId);
            return parentNodeId === null ? null : frozenNodesById[parentNodeId]!;
        },
        childrenOf(nodeId: number): readonly SyntaxNode[] {
            return nodeChildren(assertNodeId(nodeId));
        },
        nearestAncestor(nodeId: number, kind: SyntaxNode["kind"]): SyntaxNode | null {
            assertNodeId(nodeId);
            if (typeof kind !== "string") {
                throw new Error(`Ancestor kind must be a string, got ${String(kind)}`);
            }
            let current = parentNodeIdAt(nodeId);
            while (current !== null) {
                const node = frozenNodesById[current]!;
                if (node.kind === kind) {
                    return node;
                }
                current = parentNodeIdAt(current);
            }
            return null;
        },
        statements(): readonly StatementNode[] {
            return frozenStatements;
        },
        statementOfNode(nodeId: number): StatementNode | null {
            assertNodeId(nodeId);
            const statementNodeId = statementNodeIdAt(nodeId);
            if (statementNodeId === null) {
                return null;
            }
            const node = frozenNodesById[statementNodeId]!;
            if (node.kind !== "statement") {
                invariantFailure(`statement index points to ${node.kind} node ${node.id}`);
            }
            return node;
        },
        queries(): readonly QueryNode[] {
            return frozenQueries;
        },
        clausesOfQuery(queryNodeId: number): readonly ClauseNode[] {
            assertQueryNodeId(queryNodeId);
            return frozenClausesByQuery.get(queryNodeId) ?? EMPTY_CLAUSES;
        },
        queryOfClause(clauseNodeId: number): QueryNode {
            const clause = assertNodeId(clauseNodeId);
            if (clause.kind !== "clause") {
                throw new Error(`Expected clause node id, got ${clauseNodeId}:${clause.kind}`);
            }
            const queryNodeId = queryNodeIdAt(clauseNodeId);
            if (queryNodeId === null) {
                invariantFailure(`clause ${clauseNodeId} has no query owner`);
            }
            return assertQueryNodeId(queryNodeId);
        },
        lists(): readonly ListNode[] {
            return frozenLists;
        },
        membersOfList(listNodeId: number): readonly ListItemNode[] {
            return assertListNodeId(listNodeId).children;
        },
        listOfMember(memberNodeId: number): ListNode {
            const member = assertNodeId(memberNodeId);
            if (member.kind !== "list-item") {
                throw new Error(
                    `Expected list-item node id, got ${memberNodeId}:${member.kind}`
                );
            }
            const listNodeId = listNodeIdAt(memberNodeId);
            if (listNodeId === null) {
                invariantFailure(`list item ${memberNodeId} has no list owner`);
            }
            return assertListNodeId(listNodeId);
        },
        separatorOwner(separatorLeafId: number): SeparatorOwnership | null {
            assertLeafId(separatorLeafId);
            return separatorOwnershipByLeaf.get(separatorLeafId) ?? null;
        },
        matchingDelimiter(leafId: number): number | null {
            assertLeafId(leafId);
            return tokenTable.matchingDelimiterIndex(leafId);
        },
        depthBefore(leafId: number): number {
            assertLeafId(leafId);
            return tokenTable.depthBefore(leafId);
        },
        depthAfter(leafId: number): number {
            assertLeafId(leafId);
            return tokenTable.depthAfter(leafId);
        },
        lineStarts(): readonly number[] {
            return frozenLineStarts;
        },
        leafPosition(leafId: number): SourcePosition {
            const leaf = assertLeafId(leafId);
            const line = frozenStartLineByLeaf[leafId]!;
            return Object.freeze({
                line,
                column: leaf.span.start - frozenLineStarts[line]!,
            });
        },
        offsetToLeaf(offset: number): OffsetLeafLocation | null {
            if (!Number.isInteger(offset) || offset < 0 || offset > sourceLength) {
                throw new Error(
                    `Source offset out of range: ${String(offset)} (sourceLength=${sourceLength})`
                );
            }
            if (leafCount === 0) {
                return null;
            }
            if (offset === sourceLength) {
                const finalLeaf = leaves[leafCount - 1]!;
                return Object.freeze({
                    leafId: finalLeaf.id,
                    relativeOffset: finalLeaf.raw.length,
                    atEnd: true,
                });
            }
            let low = 0;
            let high = leafCount - 1;
            while (low <= high) {
                const middle = low + Math.floor((high - low) / 2);
                const leaf = leaves[middle]!;
                if (offset < leaf.span.start) {
                    high = middle - 1;
                } else if (offset >= leaf.span.end) {
                    low = middle + 1;
                } else {
                    return Object.freeze({
                        leafId: leaf.id,
                        relativeOffset: offset - leaf.span.start,
                        atEnd: false,
                    });
                }
            }
            invariantFailure(`offset ${offset} is not covered by the canonical leaf partition`);
        },
        spanOf(nodeId: number): SourceSpan {
            return assertNodeId(nodeId).span;
        },
        leafRangeOf(nodeId: number): LeafRange {
            return assertNodeId(nodeId).leafRange;
        },
        commentBindings(): readonly CommentBinding[] {
            return bindings;
        },
        commentBinding(commentLeafId: number): CommentBinding | null {
            assertLeafId(commentLeafId);
            return frozenBindingByCommentLeaf[commentLeafId] ?? null;
        },
        commentsForOwner(ownerNodeId: number): readonly CommentBinding[] {
            assertNodeId(ownerNodeId);
            return frozenBindingsByOwner[ownerNodeId] ?? EMPTY_BINDINGS;
        },
        capability(capabilityId: string): CapabilityEntry | null {
            if (typeof capabilityId !== "string" || capabilityId.length === 0) {
                throw new Error("Capability id must be a non-empty string");
            }
            return dialect.getCapability(capabilityId);
        },
        capabilityForOpaque(opaqueNodeId: number): CapabilityEntry | null {
            const node = assertNodeId(opaqueNodeId);
            if (node.kind !== "opaque") {
                throw new Error(
                    `Expected opaque node id, got ${opaqueNodeId}:${node.kind}`
                );
            }
            return resolvePreservationCapability(
                dialect,
                capabilityIdOf(node, `opaque node ${opaqueNodeId}`),
                `opaque node ${opaqueNodeId}`
            );
        },
        capabilityForDiagnostic(diagnosticIndex: number): CapabilityEntry | null {
            if (
                !Number.isInteger(diagnosticIndex) ||
                diagnosticIndex < 0 ||
                diagnosticIndex >= diagnosticCapabilityIds.length
            ) {
                throw new Error(
                    `Diagnostic index out of range: ${String(diagnosticIndex)}`
                );
            }
            return resolvePreservationCapability(
                dialect,
                diagnosticCapabilityIds[diagnosticIndex] ?? null,
                `diagnostic ${diagnosticIndex}`
            );
        },
        snapshot(): StructuralIndexSnapshot {
            if (snapshotCache === null) {
                snapshotCache = Object.freeze({
                    nodeIds: Object.freeze(frozenNodesById.map((node) => node.id)),
                    parentNodeIds:
                        parentNodeIdCodes === null
                            ? frozenParentById!
                            : freezeEncodedNullableIds(parentNodeIdCodes),
                    statementNodeIds:
                        statementNodeIdCodes === null
                            ? frozenStatementByNodeId!
                            : freezeEncodedNullableIds(statementNodeIdCodes),
                    queryNodeIds:
                        queryNodeIdCodes === null
                            ? frozenQueryByNodeId!
                            : freezeEncodedNullableIds(queryNodeIdCodes),
                    listNodeIds:
                        listNodeIdCodes === null
                            ? freezeSparseNullableIds(
                                  frozenListByMemberNodeId!,
                                  nodeCount
                              )
                            : freezeEncodedNullableIds(listNodeIdCodes),
                    separatorOwnerships: Object.freeze(
                        Array.from(separatorOwnershipByLeaf.values()).sort(
                            (left, right) =>
                                left.separatorLeafId - right.separatorLeafId
                        )
                    ),
                    commentBindings: bindings,
                    lineStarts: frozenLineStarts,
                });
            }
            return snapshotCache;
        },
    });

    return index;
}
