import { isCapabilityIdentity } from "../diagnostics/diagnostic";
import {
    isImmutableSourceLeafPartition,
    isImmutableSourceLeafPartitionForSource,
} from "../lexer/lossless-lexer";
import type { SourceLeaf, TokenKind } from "../lexer/token";
import type { LeafRange } from "./leaf-range";
import type { OpaqueBoundary, StatementKind } from "./node";
import {
    canonicalProgramNodeCount,
    canonicalProgramNodeCountForLeaves,
} from "./node-factory";
import { validateContainerRelationships } from "./cst-container-invariants";
import type {
    InvariantFailure,
    InvariantResult,
    SyntaxInvariantInput,
} from "./invariant-types";
import {
    CASE_BRANCH_KINDS,
    CHANNEL_BY_KIND,
    CLAUSE_KINDS,
    EXPRESSION_KINDS,
    FREE_FORM_OPAQUE_BOUNDARIES,
    LIST_ITEM_ROLES,
    LIST_ROLES,
    NODE_CONTRACTS,
    OPAQUE_BOUNDARIES,
    QUERY_KINDS,
    RELATION_KINDS,
    STATEMENT_KINDS,
    SYNTAX_KINDS,
    TOKEN_KINDS,
    type ChildRefSpec,
    type NodeContract,
    fail,
    isDenseArray,
    isFiniteNonNegInt,
    isLeafRange,
    isObject,
    isSourceSpan,
    isSyntaxChannel,
    rangesOverlap,
    resultOf,
} from "./invariant-shared";
import { deriveExpectedTable } from "./token-table-expected";
import type { StructuralTokenTable } from "./token-table";
import {
    validateTokenTableInvariants,
    validateTokenTableInvariantsFromExpected,
} from "./token-table-invariants";

function validateLeafPartition(
    leaves: unknown,
    source: unknown,
    failures: InvariantFailure[]
): {
    leaves: SourceLeaf[];
    source: string;
    immutableLeafPartition: boolean;
} | null {
    if (typeof source !== "string") {
        fail(
            failures,
            "INV_SOURCE_TYPE",
            `source must be a primitive string, got ${typeof source}`
        );
        return null;
    }
    if (!Array.isArray(leaves)) {
        fail(failures, "INV_LEAF_PARTITION", "leaves must be a dense array");
        return null;
    }

    if (leaves.length === 0) {
        if (source.length !== 0) {
            fail(failures, "INV_LEAF_PARTITION", "empty leaves require empty source");
        }
        return {
            leaves: leaves as SourceLeaf[],
            source,
            immutableLeafPartition: isImmutableSourceLeafPartition(leaves),
        };
    }

    if (isImmutableSourceLeafPartitionForSource(leaves, source)) {
        return {
            leaves: leaves as SourceLeaf[],
            source,
            immutableLeafPartition: true,
        };
    }

    let reconstructed = "";
    for (let i = 0; i < leaves.length; i++) {
        const leaf = leaves[i];
        if (!isObject(leaf)) {
            fail(failures, "INV_LEAF_PARTITION", `leaf ${i} is not an object`);
            return null;
        }
        if (leaf.id !== i) {
            fail(
                failures,
                "INV_LEAF_PARTITION",
                `leaf.id must equal index at ${i}, got ${String(leaf.id)}`
            );
        }
        if (typeof leaf.kind !== "string" || !TOKEN_KINDS.has(leaf.kind)) {
            fail(
                failures,
                "INV_LEAF_PARTITION",
                `leaf ${i} has illegal kind: ${String(leaf.kind)}`
            );
            continue;
        }
        if (typeof leaf.channel !== "string") {
            fail(failures, "INV_LEAF_PARTITION", `leaf ${i} has missing channel`);
            continue;
        }
        const expectedChannel = CHANNEL_BY_KIND[leaf.kind as TokenKind];
        if (leaf.channel !== expectedChannel) {
            fail(
                failures,
                "INV_LEAF_PARTITION",
                `leaf ${i} kind/channel mismatch: kind=${leaf.kind} channel=${leaf.channel} expected=${expectedChannel}`
            );
        }
        if (!isSourceSpan(leaf.span)) {
            fail(failures, "INV_LEAF_PARTITION", `leaf ${i} has invalid span`);
            continue;
        }
        if (typeof leaf.raw !== "string") {
            fail(failures, "INV_LEAF_PARTITION", `leaf ${i} raw must be string`);
            continue;
        }
        if (leaf.raw.length !== leaf.span.end - leaf.span.start) {
            fail(
                failures,
                "INV_LEAF_PARTITION",
                `leaf ${i} raw length must equal span width`
            );
        }
        if (source.slice(leaf.span.start, leaf.span.end) !== leaf.raw) {
            fail(
                failures,
                "INV_LEAF_PARTITION",
                `leaf ${i} raw must equal source.slice(span)`
            );
        }
        if (i === 0 && leaf.span.start !== 0) {
            fail(failures, "INV_LEAF_PARTITION", "first leaf must start at 0");
        }
        if (i > 0) {
            const prev = leaves[i - 1];
            if (
                isObject(prev) &&
                isSourceSpan(prev.span) &&
                prev.span.end !== leaf.span.start
            ) {
                fail(
                    failures,
                    "INV_LEAF_PARTITION",
                    `leaves not contiguous at index ${i}`
                );
            }
        }
        reconstructed += leaf.raw;
    }
    const last = leaves[leaves.length - 1];
    if (isObject(last) && isSourceSpan(last.span) && last.span.end !== source.length) {
        fail(failures, "INV_LEAF_PARTITION", "final leaf must end at source.length");
    }
    if (reconstructed !== source) {
        fail(
            failures,
            "INV_LEAF_PARTITION",
            "leaves.map(raw).join('') must equal source"
        );
    }
    return {
        leaves: leaves as SourceLeaf[],
        source,
        immutableLeafPartition: isImmutableSourceLeafPartition(leaves),
    };
}

// ---------------------------------------------------------------------------
// Shape validation (required fields / enums)
// ---------------------------------------------------------------------------

function validateIntArray(
    value: unknown,
    field: string,
    nodeId: number,
    failures: InvariantFailure[],
    leafRange: LeafRange | null,
    leavesLen: number
): void {
    if (!isDenseArray(value)) {
        fail(failures, "INV_SHAPE", `${field} must be a dense array on node ${nodeId}`, nodeId);
        return;
    }
    for (let i = 0; i < value.length; i++) {
        const item = value[i];
        if (!isFiniteNonNegInt(item)) {
            fail(
                failures,
                "INV_SHAPE",
                `${field}[${i}] must be a non-negative integer on node ${nodeId}`,
                nodeId
            );
            continue;
        }
        if (item >= leavesLen) {
            fail(
                failures,
                "INV_OWNER_REFERENCE",
                `${field}[${i}]=${item} out of leaves on node ${nodeId}`,
                nodeId
            );
        } else if (leafRange && (item < leafRange.start || item >= leafRange.end)) {
            fail(
                failures,
                "INV_OWNER_REFERENCE",
                `${field}[${i}]=${item} outside owner leafRange on node ${nodeId}`,
                nodeId
            );
        }
    }
}

function validateOperatorLeafIds(
    value: unknown,
    nodeId: number,
    failures: InvariantFailure[],
    leafRange: LeafRange | null,
    leaves: readonly SourceLeaf[]
): void {
    validateIntArray(
        value,
        "operatorLeafIds",
        nodeId,
        failures,
        leafRange,
        leaves.length
    );
    if (!isDenseArray(value)) {
        return;
    }

    let previous = -1;
    for (let i = 0; i < value.length; i++) {
        const leafId = value[i];
        if (!isFiniteNonNegInt(leafId) || leafId >= leaves.length) {
            continue;
        }
        if (leafId <= previous) {
            fail(
                failures,
                "INV_OWNER_REFERENCE",
                `operatorLeafIds must be unique and strictly source-ordered on node ${nodeId}`,
                nodeId
            );
        }
        previous = leafId;
        if (leaves[leafId]!.channel !== "code") {
            fail(
                failures,
                "INV_OWNER_REFERENCE",
                `operatorLeafIds[${i}]=${leafId} must reference a code leaf on node ${nodeId}`,
                nodeId
            );
        }
    }
}

function validateSubRange(
    value: unknown,
    field: string,
    nodeId: number,
    owner: LeafRange | null,
    leavesLen: number,
    failures: InvariantFailure[]
): void {
    if (!isLeafRange(value)) {
        fail(failures, "INV_SHAPE", `${field} invalid on node ${nodeId}`, nodeId);
        return;
    }
    if (value.end > leavesLen) {
        fail(
            failures,
            "INV_OWNER_REFERENCE",
            `${field} out of global leaves on node ${nodeId}`,
            nodeId
        );
    }
    if (owner && (value.start < owner.start || value.end > owner.end)) {
        fail(
            failures,
            "INV_OWNER_REFERENCE",
            `${field} outside owner leafRange on node ${nodeId}`,
            nodeId
        );
    }
}

function validateAtomicNameRange(
    value: unknown,
    field: string,
    nodeId: number,
    owner: LeafRange | null,
    leaves: readonly SourceLeaf[],
    allowParameter: boolean,
    failures: InvariantFailure[]
): void {
    validateSubRange(value, field, nodeId, owner, leaves.length, failures);
    if (!isLeafRange(value) || value.end > leaves.length) {
        return;
    }
    if (value.end !== value.start + 1) {
        fail(
            failures,
            "INV_RELATIONSHIP",
            `${field} must reference exactly one atomic name leaf on node ${nodeId}`,
            nodeId
        );
        return;
    }
    const leaf = leaves[value.start]!;
    if (
        leaf.kind !== "identifier" &&
        leaf.kind !== "keyword" &&
        leaf.kind !== "quoted-identifier" &&
        !(allowParameter && leaf.kind === "parameter")
    ) {
        fail(
            failures,
            "INV_RELATIONSHIP",
            `${field} must reference a name leaf on node ${nodeId}`,
            nodeId
        );
    }
}

function validateAlias(
    value: unknown,
    nodeId: number,
    leafRange: LeafRange | null,
    leaves: readonly SourceLeaf[],
    failures: InvariantFailure[]
): void {
    if (value === null) {
        return;
    }
    if (!isObject(value)) {
        fail(failures, "INV_SHAPE", `alias must be null or AliasInfo on node ${nodeId}`, nodeId);
        return;
    }
    const leavesLen = leaves.length;
    if (!isLeafRange(value.nameLeafRange)) {
        fail(failures, "INV_SHAPE", `alias.nameLeafRange invalid on node ${nodeId}`, nodeId);
        return;
    }
    const nameRange = value.nameLeafRange;
    if (nameRange.start === nameRange.end) {
        fail(
            failures,
            "INV_RELATIONSHIP",
            `alias.nameLeafRange must be non-empty on node ${nodeId}`,
            nodeId
        );
        return;
    }
    validateSubRange(nameRange, "alias.nameLeafRange", nodeId, leafRange, leavesLen, failures);

    // name range must contain at least one syntax leaf (not trivia-only)
    let hasSyntaxName = false;
    for (let i = nameRange.start; i < nameRange.end && i < leavesLen; i++) {
        if (isSyntaxChannel(leaves[i]!.channel)) {
            hasSyntaxName = true;
            break;
        }
    }
    if (!hasSyntaxName) {
        fail(
            failures,
            "INV_RELATIONSHIP",
            `alias.nameLeafRange must contain at least one syntax leaf on node ${nodeId}`,
            nodeId
        );
    }

    if (value.keywordLeafId === null) {
        // implicit alias: name range already validated non-empty
        return;
    }
    if (!isFiniteNonNegInt(value.keywordLeafId)) {
        fail(failures, "INV_SHAPE", `alias.keywordLeafId invalid on node ${nodeId}`, nodeId);
        return;
    }
    const kid = value.keywordLeafId;
    if (kid >= leavesLen) {
        fail(
            failures,
            "INV_OWNER_REFERENCE",
            `alias.keywordLeafId ${kid} out of leaves on node ${nodeId}`,
            nodeId
        );
        return;
    }
    if (leafRange && (kid < leafRange.start || kid >= leafRange.end)) {
        fail(
            failures,
            "INV_OWNER_REFERENCE",
            `alias.keywordLeafId ${kid} outside owner on node ${nodeId}`,
            nodeId
        );
        return;
    }
    const leaf = leaves[kid];
    if (!leaf) {
        fail(
            failures,
            "INV_OWNER_REFERENCE",
            `alias.keywordLeafId ${kid} missing leaf on node ${nodeId}`,
            nodeId
        );
        return;
    }
    if (leaf.channel !== "code" || leaf.kind !== "keyword") {
        fail(
            failures,
            "INV_RELATIONSHIP",
            `alias.keywordLeafId ${kid} must be a code/keyword AS leaf on node ${nodeId}, got ${leaf.kind}/${leaf.channel}`,
            nodeId
        );
        return;
    }
    if (leaf.raw.toLowerCase() !== "as") {
        fail(
            failures,
            "INV_RELATIONSHIP",
            `alias.keywordLeafId ${kid} raw must equal AS (case-insensitive) on node ${nodeId}, got ${leaf.raw}`,
            nodeId
        );
        return;
    }
    // keyword must strictly precede name range and not overlap
    if (kid >= nameRange.start) {
        fail(
            failures,
            "INV_RELATIONSHIP",
            `alias.keywordLeafId ${kid} must be strictly before nameLeafRange.start ${nameRange.start} on node ${nodeId}`,
            nodeId
        );
    }
}

const EMPTY_CHILDREN_RAW: readonly unknown[] = Object.freeze([]);

type ChildrenSnapshotState = {
    dense: boolean;
    stableFrozenData: boolean;
};

function snapshotChildren(
    raw: Record<string, unknown>,
    state: ChildrenSnapshotState
): readonly unknown[] {
    if (raw.kind === "opaque") {
        state.dense = true;
        state.stableFrozenData = true;
        return EMPTY_CHILDREN_RAW;
    }
    const binding = raw.children;
    if (!Array.isArray(binding)) {
        state.dense = false;
        state.stableFrozenData = false;
        return EMPTY_CHILDREN_RAW;
    }
    let dense = true;
    let stableFrozenData = Object.isFrozen(binding);
    for (let index = 0; index < binding.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(binding, index);
        if (descriptor === undefined) {
            dense = false;
            stableFrozenData = false;
        } else if (!("value" in descriptor)) {
            stableFrozenData = false;
        }
    }
    state.dense = dense;
    state.stableFrozenData = dense && stableFrozenData;
    return dense ? binding : EMPTY_CHILDREN_RAW;
}

function validateNodeShape(
    raw: Record<string, unknown>,
    childrenRaw: readonly unknown[],
    childrenDense: boolean,
    leaves: readonly SourceLeaf[],
    failures: InvariantFailure[]
): void {
    const leavesLen = leaves.length;
    if (!isFiniteNonNegInt(raw.id)) {
        fail(failures, "INV_SHAPE", `node id must be non-negative integer, got ${String(raw.id)}`);
        return;
    }
    const nodeId = raw.id;
    if (typeof raw.kind !== "string" || !SYNTAX_KINDS.has(raw.kind)) {
        fail(
            failures,
            "INV_SHAPE",
            `unknown or missing syntax kind: ${String(raw.kind)}`,
            nodeId
        );
        return;
    }
    if (!(raw.kind in NODE_CONTRACTS)) {
        fail(failures, "INV_SHAPE", `no contract for kind ${raw.kind}`, nodeId);
    }
    if (!isSourceSpan(raw.span)) {
        fail(failures, "INV_SHAPE", `invalid span on node ${nodeId}`, nodeId);
    }
    if (!isLeafRange(raw.leafRange)) {
        fail(failures, "INV_SHAPE", `invalid leafRange on node ${nodeId}`, nodeId);
        return;
    }
    if (raw.leafRange.end > leavesLen) {
        fail(
            failures,
            "INV_LEAF_RANGE_BOUNDS",
            `leafRange out of bounds on node ${nodeId}`,
            nodeId
        );
    }

    // Non-program syntax nodes must always own a non-empty leafRange.
    // Empty source / trivia-only programs use empty Program.children, never
    // a zero-leaf Statement.
    if (raw.kind !== "program" && raw.leafRange.start === raw.leafRange.end) {
        fail(
            failures,
            "INV_EMPTY_RANGE",
            `non-program node ${nodeId} must own at least one leaf`,
            nodeId
        );
    }

    const leafRange = isLeafRange(raw.leafRange) ? raw.leafRange : null;

    switch (raw.kind) {
        case "program": {
            if (!childrenDense) {
                fail(failures, "INV_SHAPE", "program children must be a dense array", nodeId);
            }
            break;
        }
        case "statement": {
            if (
                typeof raw.statementKind !== "string" ||
                !STATEMENT_KINDS.has(raw.statementKind as StatementKind)
            ) {
                fail(failures, "INV_ENUM", `illegal statementKind on node ${nodeId}`, nodeId);
            }
            if (raw.bodyChildId !== null && !isFiniteNonNegInt(raw.bodyChildId)) {
                fail(failures, "INV_SHAPE", `bodyChildId invalid on node ${nodeId}`, nodeId);
            }
            if (!childrenDense) {
                fail(failures, "INV_SHAPE", `statement children must be array on node ${nodeId}`, nodeId);
            }
            // empty statements: body null + empty children (enforced in relationships too)
            if (raw.statementKind === "empty") {
                if (raw.bodyChildId !== null) {
                    fail(
                        failures,
                        "INV_RELATIONSHIP",
                        `empty statement ${nodeId} must have bodyChildId null`,
                        nodeId
                    );
                }
                if (childrenDense && childrenRaw.length !== 0) {
                    fail(
                        failures,
                        "INV_RELATIONSHIP",
                        `empty statement ${nodeId} must have empty children`,
                        nodeId
                    );
                }
            }
            break;
        }
        case "query": {
            if (typeof raw.queryKind !== "string" || !QUERY_KINDS.has(raw.queryKind)) {
                fail(failures, "INV_ENUM", `illegal queryKind on node ${nodeId}`, nodeId);
            }
            validateIntArray(
                raw.setOperatorLeafIds,
                "setOperatorLeafIds",
                nodeId,
                failures,
                leafRange,
                leavesLen
            );
            if (!childrenDense) {
                fail(failures, "INV_SHAPE", `query children must be array on node ${nodeId}`, nodeId);
            }
            break;
        }
        case "cte": {
            validateSubRange(raw.nameLeafRange, "nameLeafRange", nodeId, leafRange, leavesLen, failures);
            if (!isFiniteNonNegInt(raw.queryChildId)) {
                fail(failures, "INV_SHAPE", `cte queryChildId required on node ${nodeId}`, nodeId);
            }
            if (raw.columnListChildId !== null && !isFiniteNonNegInt(raw.columnListChildId)) {
                fail(failures, "INV_SHAPE", `cte columnListChildId invalid on node ${nodeId}`, nodeId);
            }
            if (!childrenDense) {
                fail(failures, "INV_SHAPE", `cte children must be array on node ${nodeId}`, nodeId);
            }
            break;
        }
        case "clause": {
            if (typeof raw.clauseKind !== "string" || !CLAUSE_KINDS.has(raw.clauseKind)) {
                fail(failures, "INV_ENUM", `illegal clauseKind on node ${nodeId}`, nodeId);
            }
            validateSubRange(raw.headLeafRange, "headLeafRange", nodeId, leafRange, leavesLen, failures);
            validateSubRange(raw.bodyLeafRange, "bodyLeafRange", nodeId, leafRange, leavesLen, failures);
            // head must end at or before body start (trivia gap allowed; overlap/reorder forbidden)
            if (isLeafRange(raw.headLeafRange) && isLeafRange(raw.bodyLeafRange)) {
                if (raw.headLeafRange.end > raw.bodyLeafRange.start) {
                    fail(
                        failures,
                        "INV_RELATIONSHIP",
                        `clause ${nodeId} headLeafRange must end at or before bodyLeafRange.start (no overlap/reorder)`,
                        nodeId
                    );
                }
            }
            if (!childrenDense) {
                fail(failures, "INV_SHAPE", `clause children must be array on node ${nodeId}`, nodeId);
            }
            break;
        }
        case "relation": {
            if (typeof raw.relationKind !== "string" || !RELATION_KINDS.has(raw.relationKind)) {
                fail(failures, "INV_ENUM", `illegal relationKind on node ${nodeId}`, nodeId);
            }
            validateAlias(raw.alias, nodeId, leafRange, leaves, failures);
            if (raw.bodyChildId !== null && !isFiniteNonNegInt(raw.bodyChildId)) {
                fail(failures, "INV_SHAPE", `relation bodyChildId invalid on node ${nodeId}`, nodeId);
            }
            if (!childrenDense) {
                fail(failures, "INV_SHAPE", `relation children must be array on node ${nodeId}`, nodeId);
            }
            break;
        }
        case "list": {
            if (typeof raw.listRole !== "string" || !LIST_ROLES.has(raw.listRole)) {
                fail(failures, "INV_ENUM", `illegal or missing listRole on node ${nodeId}`, nodeId);
            }
            if (!Object.prototype.hasOwnProperty.call(raw, "separatorLeafIds")) {
                fail(failures, "INV_SHAPE", `list separatorLeafIds required on node ${nodeId}`, nodeId);
            } else {
                validateIntArray(
                    raw.separatorLeafIds,
                    "separatorLeafIds",
                    nodeId,
                    failures,
                    leafRange,
                    leavesLen
                );
            }
            if (!childrenDense) {
                fail(failures, "INV_SHAPE", `list children must be array on node ${nodeId}`, nodeId);
            }
            break;
        }
        case "list-item": {
            if (typeof raw.itemRole !== "string" || !LIST_ITEM_ROLES.has(raw.itemRole)) {
                fail(failures, "INV_ENUM", `illegal itemRole on node ${nodeId}`, nodeId);
            }
            validateAlias(raw.alias, nodeId, leafRange, leaves, failures);
            validateIntArray(
                raw.modifierLeafIds,
                "modifierLeafIds",
                nodeId,
                failures,
                leafRange,
                leavesLen
            );
            if (!isFiniteNonNegInt(raw.valueChildId)) {
                fail(failures, "INV_SHAPE", `list-item valueChildId required on node ${nodeId}`, nodeId);
            }
            if (!childrenDense) {
                fail(failures, "INV_SHAPE", `list-item children must be array on node ${nodeId}`, nodeId);
            }
            break;
        }
        case "expression": {
            if (
                typeof raw.expressionKind !== "string" ||
                !EXPRESSION_KINDS.has(raw.expressionKind)
            ) {
                fail(failures, "INV_ENUM", `illegal expressionKind on node ${nodeId}`, nodeId);
            }
            validateOperatorLeafIds(
                raw.operatorLeafIds,
                nodeId,
                failures,
                leafRange,
                leaves
            );
            if (!childrenDense) {
                fail(failures, "INV_SHAPE", `expression children must be array on node ${nodeId}`, nodeId);
            }
            break;
        }
        case "case-branch": {
            if (typeof raw.branchKind !== "string" || !CASE_BRANCH_KINDS.has(raw.branchKind)) {
                fail(failures, "INV_ENUM", `illegal branchKind on node ${nodeId}`, nodeId);
            }
            if (raw.conditionChildId !== null && !isFiniteNonNegInt(raw.conditionChildId)) {
                fail(failures, "INV_SHAPE", `conditionChildId invalid on node ${nodeId}`, nodeId);
            }
            // ELSE must force conditionChildId === null; WHEN requires non-null (via required).
            if (raw.branchKind === "else" && raw.conditionChildId !== null) {
                fail(
                    failures,
                    "INV_RELATIONSHIP",
                    `else case-branch ${nodeId} must have conditionChildId null`,
                    nodeId
                );
            }
            if (!isFiniteNonNegInt(raw.valueChildId)) {
                fail(failures, "INV_SHAPE", `valueChildId required on case-branch ${nodeId}`, nodeId);
            }
            if (!childrenDense) {
                fail(failures, "INV_SHAPE", `case-branch children must be array on node ${nodeId}`, nodeId);
            }
            break;
        }
        case "window-spec": {
            if (raw.nameLeafRange !== null) {
                validateAtomicNameRange(
                    raw.nameLeafRange,
                    "nameLeafRange",
                    nodeId,
                    leafRange,
                    leaves,
                    false,
                    failures
                );
            }
            for (const field of ["partitionChildId", "orderChildId", "frameChildId"] as const) {
                if (raw[field] !== null && !isFiniteNonNegInt(raw[field])) {
                    fail(failures, "INV_SHAPE", `${field} invalid on node ${nodeId}`, nodeId);
                }
            }
            if (!childrenDense) {
                fail(failures, "INV_SHAPE", `window-spec children must be array on node ${nodeId}`, nodeId);
            }
            break;
        }
        case "type-expression": {
            validateAtomicNameRange(
                raw.typeNameLeafRange,
                "typeNameLeafRange",
                nodeId,
                leafRange,
                leaves,
                true,
                failures
            );
            for (const field of ["argumentListChildId", "memberListChildId"] as const) {
                if (raw[field] !== null && !isFiniteNonNegInt(raw[field])) {
                    fail(failures, "INV_SHAPE", `${field} invalid on node ${nodeId}`, nodeId);
                }
            }
            if (!childrenDense) {
                fail(
                    failures,
                    "INV_SHAPE",
                    `type-expression children must be array on node ${nodeId}`,
                    nodeId
                );
            }
            break;
        }
        case "opaque": {
            if (typeof raw.reasonCode !== "string" || raw.reasonCode.length === 0) {
                fail(
                    failures,
                    "INV_SHAPE",
                    `opaque reasonCode must be non-empty string on node ${nodeId}`,
                    nodeId
                );
            }
            if (!isCapabilityIdentity(raw.capabilityId)) {
                fail(
                    failures,
                    "INV_SHAPE",
                    `opaque capabilityId must be null or kebab-case on node ${nodeId}`,
                    nodeId
                );
            }
            if (
                typeof raw.boundary !== "string" ||
                !OPAQUE_BOUNDARIES.has(raw.boundary as OpaqueBoundary)
            ) {
                fail(failures, "INV_ENUM", `illegal opaque boundary on node ${nodeId}`, nodeId);
            }
            if (Object.prototype.hasOwnProperty.call(raw, "children")) {
                fail(
                    failures,
                    "INV_OPAQUE_CHILDREN",
                    `Opaque node ${nodeId} must not declare children property`,
                    nodeId
                );
            }
            break;
        }
        default:
            fail(failures, "INV_SHAPE", `unhandled kind ${String(raw.kind)}`, nodeId);
            break;
    }
}

// ---------------------------------------------------------------------------
// Relationship contract enforcement
// ---------------------------------------------------------------------------

function resolveRequired(
    spec: ChildRefSpec,
    node: Record<string, unknown>
): boolean {
    return typeof spec.required === "function" ? spec.required(node) : spec.required;
}

function resolveAllowedKinds(
    spec: ChildRefSpec,
    node: Record<string, unknown>
): readonly string[] {
    return typeof spec.allowedKinds === "function"
        ? spec.allowedKinds(node)
        : spec.allowedKinds;
}

function resolveAllowedOpaqueBoundaries(
    spec: ChildRefSpec,
    node: Record<string, unknown>
): readonly OpaqueBoundary[] | null {
    if (spec.allowedOpaqueBoundaries === undefined) {
        return null;
    }
    return typeof spec.allowedOpaqueBoundaries === "function"
        ? spec.allowedOpaqueBoundaries(node)
        : spec.allowedOpaqueBoundaries;
}

function resolveChildKinds(
    contract: NodeContract,
    node: Record<string, unknown>
): readonly string[] | null {
    if (contract.childKinds === undefined) {
        return null;
    }
    return typeof contract.childKinds === "function"
        ? contract.childKinds(node)
        : contract.childKinds;
}

function rejectsUnreferencedChildren(
    contract: NodeContract,
    node: Record<string, unknown>
): boolean {
    return typeof contract.noUnreferencedChildren === "function"
        ? contract.noUnreferencedChildren(node)
        : contract.noUnreferencedChildren === true;
}

/**
 * Empty statements may only own semicolon code leaves and trivia.
 * They must not claim real SQL syntax (keywords, identifiers, literals, …).
 */
function validateEmptyStatementContent(
    raw: Record<string, unknown>,
    leaves: readonly SourceLeaf[],
    failures: InvariantFailure[]
): void {
    if (raw.kind !== "statement" || raw.statementKind !== "empty") {
        return;
    }
    if (!isFiniteNonNegInt(raw.id) || !isLeafRange(raw.leafRange)) {
        return;
    }
    const nodeId = raw.id;
    for (let i = raw.leafRange.start; i < raw.leafRange.end && i < leaves.length; i++) {
        const leaf = leaves[i]!;
        if (leaf.channel === "trivia") {
            continue;
        }
        if (leaf.channel === "code" && leaf.raw === ";") {
            continue;
        }
        // Any other syntax leaf is illegal under an empty statement.
        fail(
            failures,
            "INV_RELATIONSHIP",
            `empty statement ${nodeId} must not own non-semicolon syntax leaf ${i} (${leaf.kind}:${leaf.raw})`,
            nodeId
        );
        return;
    }
}

function enforceRelationships(
    raw: Record<string, unknown>,
    directChildren: readonly Record<string, unknown>[],
    leaves: readonly SourceLeaf[],
    failures: InvariantFailure[]
): void {
    if (typeof raw.kind !== "string" || !isFiniteNonNegInt(raw.id)) {
        return;
    }
    const contract = (NODE_CONTRACTS as Readonly<Record<string, NodeContract>>)[raw.kind];
    if (!contract) {
        fail(failures, "INV_RELATIONSHIP", `no relationship contract for kind ${raw.kind}`, raw.id);
        return;
    }
    const nodeId = raw.id;
    validateEmptyStatementContent(raw, leaves, failures);
    const refs = contract.refs ?? [];
    const allowedChildKinds = resolveChildKinds(contract, raw);
    for (const child of directChildren) {
        if (allowedChildKinds !== null && typeof child.kind === "string") {
            if (allowedChildKinds.indexOf(child.kind) < 0) {
                fail(
                    failures,
                    "INV_RELATIONSHIP",
                    `${raw.kind} children must be ${allowedChildKinds.join("|") || "none"}, got ${child.kind}`,
                    nodeId
                );
            }
        }
        // ProgramNode is root-only; any nested Program must fail.
        if (child.kind === "program") {
            fail(
                failures,
                "INV_RELATIONSHIP",
                `ProgramNode may only be root; nested program under ${raw.kind} node ${nodeId}`,
                nodeId
            );
        }
        // StatementNode is document-level and may only hang under Program.
        if (child.kind === "statement" && raw.kind !== "program") {
            fail(
                failures,
                "INV_RELATIONSHIP",
                `StatementNode may only be a direct child of Program; nested statement under ${raw.kind} node ${nodeId}`,
                nodeId
            );
        }

        // Free-form direct Opaque children: boundary must match owner kind policy.
        if (child.kind === "opaque" && typeof child.boundary === "string") {
            if (
                raw.kind === "statement" &&
                child.boundary === "target" &&
                (!isLeafRange(raw.leafRange) ||
                    raw.leafRange.start !== 0 ||
                    raw.leafRange.end !== leaves.length ||
                    !isLeafRange(child.leafRange) ||
                    child.leafRange.start !== 0 ||
                    child.leafRange.end !== leaves.length)
            ) {
                fail(
                    failures,
                    "INV_RELATIONSHIP",
                    `target opaque under statement ${nodeId} must cover the complete leaf stream`,
                    nodeId
                );
            }
            const allowed = FREE_FORM_OPAQUE_BOUNDARIES[raw.kind as string];
            if (allowed && (allowed as readonly string[]).indexOf(child.boundary) < 0) {
                fail(
                    failures,
                    "INV_RELATIONSHIP",
                    `OpaqueNode boundary under ${raw.kind} must be ${allowed.join("|")}, got ${child.boundary} on node ${nodeId}`,
                    nodeId
                );
            } else if (
                !allowed &&
                (child.boundary === "statement" || child.boundary === "target") &&
                raw.kind !== "program" &&
                raw.kind !== "statement"
            ) {
                // Fail closed for document-level boundaries under unknown free-form parents
                fail(
                    failures,
                    "INV_RELATIONSHIP",
                    `OpaqueNode boundary ${child.boundary} is not allowed under ${raw.kind} node ${nodeId}`,
                    nodeId
                );
            }
        }
    }

    let referencedChildIds: number[] | null = null;
    for (const spec of refs) {
        const value = raw[spec.field];
        const required = resolveRequired(spec, raw);
        if (value === null || value === undefined) {
            if (required) {
                fail(
                    failures,
                    "INV_RELATIONSHIP",
                    `${spec.field} is required on ${raw.kind} node ${nodeId}`,
                    nodeId
                );
            }
            // optional ref: null is the only null policy (required=false)
            continue;
        }
        if (!isFiniteNonNegInt(value)) {
            fail(
                failures,
                "INV_CHILD_REFERENCE",
                `${spec.field} must be a non-negative integer on node ${nodeId}`,
                nodeId
            );
            continue;
        }
        let child: Record<string, unknown> | undefined;
        for (const candidate of directChildren) {
            if (candidate.id === value) {
                child = candidate;
                break;
            }
        }
        if (!child) {
            fail(
                failures,
                "INV_CHILD_REFERENCE",
                `${spec.field}=${value} is not a direct child of node ${nodeId}`,
                nodeId
            );
            continue;
        }
        if (referencedChildIds === null) {
            referencedChildIds = [value];
        } else {
            referencedChildIds.push(value);
        }
        const allowed = resolveAllowedKinds(spec, raw);
        if (typeof child.kind === "string" && allowed.indexOf(child.kind) < 0) {
            fail(
                failures,
                "INV_RELATIONSHIP",
                `${spec.field} must point to ${allowed.join("|")}, got ${child.kind} on node ${nodeId}`,
                nodeId
            );
        }
        // Opaque boundary must match owner-role allowed boundaries when opaque is permitted.
        if (child.kind === "opaque" && allowed.indexOf("opaque") >= 0) {
            const allowedBounds = resolveAllowedOpaqueBoundaries(spec, raw);
            if (allowedBounds === null) {
                fail(
                    failures,
                    "INV_RELATIONSHIP",
                    `${spec.field} allows opaque but has no allowedOpaqueBoundaries on node ${nodeId}`,
                    nodeId
                );
            } else if (typeof child.boundary === "string") {
                if ((allowedBounds as readonly string[]).indexOf(child.boundary) < 0) {
                    fail(
                        failures,
                        "INV_RELATIONSHIP",
                        `${spec.field} OpaqueNode boundary must be ${allowedBounds.join("|")}, got ${child.boundary} on node ${nodeId}`,
                        nodeId
                    );
                }
            }
        }
    }

    // Distinctness
    if (contract.distinctRefs) {
        for (const [a, b] of contract.distinctRefs) {
            const av = raw[a];
            const bv = raw[b];
            if (isFiniteNonNegInt(av) && isFiniteNonNegInt(bv) && av === bv) {
                fail(
                    failures,
                    "INV_RELATIONSHIP",
                    `${a} and ${b} must refer to distinct children on node ${nodeId}`,
                    nodeId
                );
            }
        }
    }

    // Unreferenced children policy
    if (rejectsUnreferencedChildren(contract, raw)) {
        for (const child of directChildren) {
            if (!isFiniteNonNegInt(child.id)) {
                continue;
            }
            let referenced = false;
            if (referencedChildIds !== null) {
                for (const referencedId of referencedChildIds) {
                    if (referencedId === child.id) {
                        referenced = true;
                        break;
                    }
                }
            }
            if (!referenced) {
                fail(
                    failures,
                    "INV_EXTRA_CHILD",
                    `unreferenced child ${child.id} under ${raw.kind} node ${nodeId}`,
                    nodeId
                );
            }
        }
    }

    validateContainerRelationships(raw, directChildren, leaves, failures);
}

// ---------------------------------------------------------------------------
// Tree walk
// ---------------------------------------------------------------------------

/**
 * Validate foundation CST invariants with full runtime shape + relationship
 * contracts. Ordinary illegal objects return structured failures; does not throw.
 */
export function validateSyntaxInvariants(input: SyntaxInvariantInput): InvariantResult {
    const failures: InvariantFailure[] = [];

    try {
        if (!input || !isObject(input as unknown as Record<string, unknown>)) {
            fail(failures, "INV_MALFORMED_NODE", "Invariant input is missing or not an object");
            return resultOf(failures);
        }

        const partition = validateLeafPartition(input.leaves, input.source, failures);
        if (!partition) {
            return resultOf(failures);
        }
        const { leaves, source, immutableLeafPartition } = partition;

        if (!isObject(input.root)) {
            fail(failures, "INV_MALFORMED_NODE", "root is missing required node fields");
            return resultOf(failures);
        }

        const root = input.root;
        const rootChildrenState: ChildrenSnapshotState = {
            dense: false,
            stableFrozenData: false,
        };
        const rootChildren = snapshotChildren(root, rootChildrenState);
        validateNodeShape(
            root,
            rootChildren,
            rootChildrenState.dense,
            leaves,
            failures
        );

        if (root.kind !== "program") {
            fail(
                failures,
                "INV_MALFORMED_NODE",
                `Root kind must be program, got ${String(root.kind)}`
            );
        }
        if (root.id !== 0) {
            fail(
                failures,
                "INV_ROOT_ID",
                `Root id must be 0, got ${String(root.id)}`,
                typeof root.id === "number" ? root.id : undefined
            );
        }

        // Independently derive expected statement ranges from canonical leaves.
        // Never trust a caller-supplied token table for this truth.
        const expectedTable = deriveExpectedTable(leaves);
        const expectedStatementRanges = expectedTable.statementRanges;

        // Program direct Statement children must match expected statement ranges
        // 1:1 in count, order, and exact leafRange (fail-closed coverage).
        if (root.kind === "program" && rootChildrenState.dense) {
            validateProgramStatementCoverage(
                rootChildren as unknown[],
                expectedStatementRanges,
                leaves,
                failures
            );
        }

        const canonicalNodeCount = canonicalProgramNodeCountForLeaves(root, leaves);
        if (
            canonicalNodeCount === null &&
            canonicalProgramNodeCount(root) !== null
        ) {
            fail(
                failures,
                "INV_LEAF_PARTITION",
                "Canonical ProgramNode belongs to a different leaf partition"
            );
        }
        const seenIdBitmap =
            canonicalNodeCount === null ? null : new Uint8Array(canonicalNodeCount);
        const seenIds = seenIdBitmap === null ? new Set<number>() : null;
        const seenObjects = seenIdBitmap === null ? new WeakSet<object>() : null;
        const childSnapshotState: ChildrenSnapshotState = {
            dense: false,
            stableFrozenData: false,
        };
        let validIdOccurrenceCount = 0;
        let maximumSeenId = -1;

        type VisitFrame = {
            raw: Record<string, unknown>;
            childrenRaw: readonly unknown[];
            childObjects: Record<string, unknown>[] | null;
            previousChildObject: Record<string, unknown> | null;
            index: number;
        };
        const visitStack: VisitFrame[] = [];
        const freeVisitFrames: VisitFrame[] = [];

        const enterNode = (
            rawValue: unknown,
            parent: Record<string, unknown> | null,
            childrenRawOverride?: readonly unknown[],
            childrenDenseOverride?: boolean,
            childrenStableOverride?: boolean
        ): void => {
            const raw = rawValue;
            if (!isObject(raw)) {
                fail(failures, "INV_MALFORMED_NODE", "child is not an object");
                return;
            }
            if (seenObjects?.has(raw)) {
                fail(
                    failures,
                    "INV_SHARED_CHILD",
                    `Shared child or cycle detected at node id ${String(raw.id)}`,
                    isFiniteNonNegInt(raw.id) ? raw.id : undefined
                );
                return;
            }
            seenObjects?.add(raw);
            let childrenRaw = childrenRawOverride;
            let childrenDense = childrenDenseOverride;
            let childrenStable = childrenStableOverride;
            if (
                childrenRaw === undefined ||
                childrenDense === undefined ||
                childrenStable === undefined
            ) {
                childrenRaw = snapshotChildren(raw, childSnapshotState);
                childrenDense = childSnapshotState.dense;
                childrenStable = childSnapshotState.stableFrozenData;
            }
            validateNodeShape(raw, childrenRaw, childrenDense, leaves, failures);

            if (isFiniteNonNegInt(raw.id)) {
                validIdOccurrenceCount += 1;
                if (raw.id > maximumSeenId) {
                    maximumSeenId = raw.id;
                }
                const duplicateId =
                    seenIdBitmap === null
                        ? seenIds!.has(raw.id)
                        : raw.id >= seenIdBitmap.length || seenIdBitmap[raw.id] !== 0;
                if (duplicateId) {
                    fail(failures, "INV_ID_UNIQUE", `Duplicate node id ${raw.id}`, raw.id);
                    if (seenIdBitmap !== null) {
                        fail(
                            failures,
                            "INV_SHARED_CHILD",
                            `Shared child or cycle detected at node id ${raw.id}`,
                            raw.id
                        );
                        return;
                    }
                }
                if (seenIdBitmap === null) {
                    seenIds!.add(raw.id);
                } else if (raw.id < seenIdBitmap.length) {
                    seenIdBitmap[raw.id] = 1;
                }
            }

            if (isLeafRange(raw.leafRange) && isSourceSpan(raw.span)) {
                if (
                    raw.leafRange.end > leaves.length ||
                    raw.leafRange.start < 0 ||
                    raw.leafRange.end < raw.leafRange.start
                ) {
                    fail(
                        failures,
                        "INV_LEAF_RANGE_BOUNDS",
                        `Leaf range out of bounds for node ${String(raw.id)}`,
                        isFiniteNonNegInt(raw.id) ? raw.id : undefined
                    );
                } else {
                    const rangeStart = raw.leafRange.start;
                    const rangeEnd = raw.leafRange.end;
                    let expectedStart: number;
                    let expectedEnd: number;
                    if (rangeStart === rangeEnd) {
                        if (leaves.length === 0 || rangeStart === 0) {
                            expectedStart = 0;
                        } else if (rangeStart === leaves.length) {
                            expectedStart = source.length;
                        } else {
                            expectedStart = leaves[rangeStart]!.span.start;
                        }
                        expectedEnd = expectedStart;
                    } else {
                        expectedStart = leaves[rangeStart]!.span.start;
                        expectedEnd = leaves[rangeEnd - 1]!.span.end;
                    }
                    if (
                        raw.span.start !== expectedStart ||
                        raw.span.end !== expectedEnd
                    ) {
                        fail(
                            failures,
                            "INV_SPAN_LEAFRANGE_MISMATCH",
                            `span/leafRange mismatch for node ${String(raw.id)}`,
                            isFiniteNonNegInt(raw.id) ? raw.id : undefined
                        );
                    }
                }
            }

            if (
                parent &&
                isSourceSpan(parent.span) &&
                isSourceSpan(raw.span) &&
                isLeafRange(parent.leafRange) &&
                isLeafRange(raw.leafRange) &&
                (raw.span.start < parent.span.start ||
                    raw.span.end > parent.span.end ||
                    raw.leafRange.start < parent.leafRange.start ||
                    raw.leafRange.end > parent.leafRange.end)
            ) {
                fail(
                    failures,
                    "INV_PARENT_CONTAINMENT",
                    `Child ${String(raw.id)} not contained by parent ${String(parent.id)}`,
                    isFiniteNonNegInt(raw.id) ? raw.id : undefined
                );
            }

            const recycledFrame = freeVisitFrames.pop();
            if (recycledFrame === undefined) {
                visitStack.push({
                    raw,
                    childrenRaw,
                    childObjects: childrenStable ? null : [],
                    previousChildObject: null,
                    index: 0,
                });
            } else {
                recycledFrame.raw = raw;
                recycledFrame.childrenRaw = childrenRaw;
                recycledFrame.childObjects = childrenStable
                    ? null
                    : [];
                recycledFrame.previousChildObject = null;
                recycledFrame.index = 0;
                visitStack.push(recycledFrame);
            }
        };

        enterNode(
            root,
            null,
            rootChildren,
            rootChildrenState.dense,
            rootChildrenState.stableFrozenData
        );
        while (visitStack.length > 0) {
            const frame = visitStack[visitStack.length - 1]!;
            if (frame.index >= frame.childrenRaw.length) {
                visitStack.pop();
                // Relationship contracts run post-order, after every child visit.
                enforceRelationships(
                    frame.raw,
                    frame.childObjects ??
                        (frame.childrenRaw as readonly Record<string, unknown>[]),
                    leaves,
                    failures
                );
                freeVisitFrames.push(frame);
                continue;
            }
            const childIndex = frame.index;
            frame.index += 1;
            const child = frame.childrenRaw[childIndex];
            if (!isObject(child)) {
                if (frame.childObjects === null) {
                    frame.childObjects = frame.childrenRaw
                        .slice(0, childIndex)
                        .filter(isObject);
                }
                fail(
                    failures,
                    "INV_MALFORMED_NODE",
                    `Malformed child at index ${childIndex} of node ${String(frame.raw.id)}`,
                    isFiniteNonNegInt(frame.raw.id) ? frame.raw.id : undefined
                );
                continue;
            }
            const previous = frame.previousChildObject;
            if (
                previous !== null &&
                isLeafRange(previous.leafRange) &&
                isLeafRange(child.leafRange) &&
                isSourceSpan(previous.span) &&
                isSourceSpan(child.span) &&
                (child.leafRange.start < previous.leafRange.end ||
                    child.span.start < previous.span.end)
            ) {
                if (rangesOverlap(previous.leafRange, child.leafRange)) {
                    fail(
                        failures,
                        "INV_SIBLING_OVERLAP",
                        `Sibling overlap between ${String(previous.id)} and ${String(child.id)}`,
                        isFiniteNonNegInt(child.id) ? child.id : undefined
                    );
                } else {
                    fail(
                        failures,
                        "INV_CHILDREN_ORDER",
                        `Children out of source order under ${String(frame.raw.id)}`,
                        isFiniteNonNegInt(child.id) ? child.id : undefined
                    );
                }
            }
            if (frame.childObjects !== null) {
                frame.childObjects.push(child);
            }
            frame.previousChildObject = child;
            enterNode(child, frame.raw);
        }

        // Root coverage
        if (isLeafRange(root.leafRange) && isSourceSpan(root.span)) {
            if (leaves.length === 0) {
                if (
                    source.length === 0 &&
                    (root.span.start !== 0 || root.span.end !== 0)
                ) {
                    fail(failures, "INV_ROOT_COVERAGE", "Empty source root span must be {0,0}", 0);
                }
            } else {
                if (root.leafRange.start !== 0 || root.leafRange.end !== leaves.length) {
                    fail(
                        failures,
                        "INV_ROOT_COVERAGE",
                        `Root leafRange must cover all leaves [0, ${leaves.length})`,
                        0
                    );
                }
                if (root.span.start !== 0 || root.span.end !== source.length) {
                    fail(
                        failures,
                        "INV_ROOT_COVERAGE",
                        `Root span must cover full source [0, ${source.length})`,
                        0
                    );
                }
            }
        }

        // Contiguous ids 0..n-1. The healthy path is O(1) after traversal;
        // scan the Set only after evidence already proves a gap/duplicate.
        if (
            validIdOccurrenceCount > 0 &&
            ((seenIds !== null && seenIds.size !== validIdOccurrenceCount) ||
                (seenIdBitmap !== null &&
                    canonicalNodeCount !== validIdOccurrenceCount) ||
                maximumSeenId !== validIdOccurrenceCount - 1)
        ) {
            for (let expectedId = 0; expectedId < validIdOccurrenceCount; expectedId++) {
                const present =
                    seenIdBitmap === null
                        ? seenIds!.has(expectedId)
                        : expectedId < seenIdBitmap.length &&
                          seenIdBitmap[expectedId] !== 0;
                if (!present) {
                    fail(
                        failures,
                        "INV_ID_CONTIGUOUS",
                        `Node ids must be unique and contiguous from 0; missing or gap at ${expectedId}`
                    );
                    break;
                }
            }
        }

        // tokenTable: undefined / absent → skip; explicit null/false/0/object → validate fail-closed
        if (Object.prototype.hasOwnProperty.call(input, "tokenTable") && input.tokenTable !== undefined) {
            const tableResult = immutableLeafPartition
                ? validateTokenTableInvariantsFromExpected(
                      input.tokenTable as StructuralTokenTable | null,
                      leaves,
                      expectedTable,
                      source.length
                  )
                : validateTokenTableInvariants(
                      input.tokenTable as StructuralTokenTable | null,
                      leaves
                  );
            for (const f of tableResult.failures) {
                failures.push(f);
            }
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        fail(failures, "INV_MALFORMED_NODE", `Invariant validation aborted: ${message}`);
    }

    return resultOf(failures);
}

/**
 * Program children must be Statements whose leafRanges exactly match the
 * independently derived expected statement ranges (count, order, bounds).
 * Trailing trivia may sit outside Statement ranges; every code/protected
 * syntax leaf must belong to exactly one expected range.
 */
function validateProgramStatementCoverage(
    children: unknown[],
    expectedRanges: readonly LeafRange[],
    leaves: readonly SourceLeaf[],
    failures: InvariantFailure[]
): void {
    if (
        leaves.length > 0 &&
        children.length === 1 &&
        isObject(children[0]) &&
        children[0].kind === "statement" &&
        children[0].statementKind === "opaque" &&
        isLeafRange(children[0].leafRange) &&
        children[0].leafRange.start === 0 &&
        children[0].leafRange.end === leaves.length &&
        isDenseArray(children[0].children) &&
        children[0].children.length === 1 &&
        isObject(children[0].children[0]) &&
        children[0].children[0].kind === "opaque" &&
        children[0].children[0].boundary === "target" &&
        isLeafRange(children[0].children[0].leafRange) &&
        children[0].children[0].leafRange.start === 0 &&
        children[0].children[0].leafRange.end === leaves.length
    ) {
        return;
    }

    const statements: Record<string, unknown>[] = [];
    for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (!isObject(child)) {
            fail(failures, "INV_MALFORMED_NODE", `Program child ${i} is not an object`);
            continue;
        }
        if (child.kind !== "statement") {
            fail(
                failures,
                "INV_RELATIONSHIP",
                `Program children must be statement, got ${String(child.kind)} at index ${i}`
            );
        }
        statements.push(child);
    }

    // Exact 1:1 with independently derived expected ranges proves:
    // count, order, no false splits, no missing statements, and full syntax coverage
    // (expected derivation already places every code/protected leaf in some range).
    if (statements.length !== expectedRanges.length) {
        fail(
            failures,
            "INV_ROOT_COVERAGE",
            `Program statement count ${statements.length} !== expected ${expectedRanges.length} from canonical leaves`
        );
    }

    const limit = Math.max(statements.length, expectedRanges.length);
    for (let i = 0; i < limit; i++) {
        const stmt = statements[i];
        const exp = expectedRanges[i];
        if (!stmt || !exp) {
            continue;
        }
        if (!isLeafRange(stmt.leafRange)) {
            continue;
        }
        if (stmt.leafRange.start !== exp.start || stmt.leafRange.end !== exp.end) {
            fail(
                failures,
                "INV_ROOT_COVERAGE",
                `Statement ${String(stmt.id)} leafRange [${stmt.leafRange.start},${stmt.leafRange.end}) !== expected [${exp.start},${exp.end}) at program child ${i}`,
                isFiniteNonNegInt(stmt.id) ? stmt.id : undefined
            );
        }
    }
    void leaves; // leaves available for future owner checks; coverage is range-exact
}

// ---------------------------------------------------------------------------
// -
