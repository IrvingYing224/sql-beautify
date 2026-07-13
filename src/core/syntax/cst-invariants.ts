import type { SourceLeaf, TokenKind } from "../lexer/token";
import type { LeafRange } from "./leaf-range";
import type { OpaqueBoundary, StatementKind } from "./node";
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
    rangeToSpan,
    rangesOverlap,
    resultOf,
} from "./invariant-shared";
import { deriveExpectedTable } from "./token-table-expected";
import type { StructuralTokenTable } from "./token-table";
import { validateTokenTableInvariants } from "./token-table-invariants";

function validateLeafPartition(
    leaves: unknown,
    source: unknown,
    failures: InvariantFailure[]
): { leaves: SourceLeaf[]; source: string } | null {
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
        return { leaves: leaves as SourceLeaf[], source };
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
    return { leaves: leaves as SourceLeaf[], source };
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

function validateNodeShape(
    raw: Record<string, unknown>,
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
            if (!isDenseArray(raw.children)) {
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
            if (!isDenseArray(raw.children)) {
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
                if (isDenseArray(raw.children) && raw.children.length !== 0) {
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
            if (!isDenseArray(raw.children)) {
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
            if (!isDenseArray(raw.children)) {
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
            if (!isDenseArray(raw.children)) {
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
            if (!isDenseArray(raw.children)) {
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
            if (!isDenseArray(raw.children)) {
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
            if (!isDenseArray(raw.children)) {
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
            validateIntArray(
                raw.operatorLeafIds,
                "operatorLeafIds",
                nodeId,
                failures,
                leafRange,
                leavesLen
            );
            if (!isDenseArray(raw.children)) {
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
            if (!isDenseArray(raw.children)) {
                fail(failures, "INV_SHAPE", `case-branch children must be array on node ${nodeId}`, nodeId);
            }
            break;
        }
        case "window-spec": {
            for (const field of ["partitionChildId", "orderChildId", "frameChildId"] as const) {
                if (raw[field] !== null && !isFiniteNonNegInt(raw[field])) {
                    fail(failures, "INV_SHAPE", `${field} invalid on node ${nodeId}`, nodeId);
                }
            }
            if (!isDenseArray(raw.children)) {
                fail(failures, "INV_SHAPE", `window-spec children must be array on node ${nodeId}`, nodeId);
            }
            break;
        }
        case "type-expression": {
            validateSubRange(
                raw.typeNameLeafRange,
                "typeNameLeafRange",
                nodeId,
                leafRange,
                leavesLen,
                failures
            );
            for (const field of ["argumentListChildId", "memberListChildId"] as const) {
                if (raw[field] !== null && !isFiniteNonNegInt(raw[field])) {
                    fail(failures, "INV_SHAPE", `${field} invalid on node ${nodeId}`, nodeId);
                }
            }
            if (!isDenseArray(raw.children)) {
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
    directChildren: Record<string, unknown>[],
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
    const byId = new Map<number, Record<string, unknown>>();
    for (const child of directChildren) {
        if (isFiniteNonNegInt(child.id)) {
            byId.set(child.id, child);
        }
        if (contract.childKinds && typeof child.kind === "string") {
            if (contract.childKinds.indexOf(child.kind) < 0) {
                fail(
                    failures,
                    "INV_RELATIONSHIP",
                    `${raw.kind} children must be ${contract.childKinds.join("|")}, got ${child.kind}`,
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

    const referenced = new Set<number>();
    const refs = contract.refs ?? [];
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
        const child = byId.get(value);
        if (!child) {
            fail(
                failures,
                "INV_CHILD_REFERENCE",
                `${spec.field}=${value} is not a direct child of node ${nodeId}`,
                nodeId
            );
            continue;
        }
        referenced.add(value);
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
    if (contract.noUnreferencedChildren) {
        for (const child of directChildren) {
            if (isFiniteNonNegInt(child.id) && !referenced.has(child.id)) {
                fail(
                    failures,
                    "INV_EXTRA_CHILD",
                    `unreferenced child ${child.id} under ${raw.kind} node ${nodeId}`,
                    nodeId
                );
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Tree walk
// ---------------------------------------------------------------------------

function getChildrenRaw(raw: Record<string, unknown>): unknown[] {
    if (raw.kind === "opaque") {
        return [];
    }
    return isDenseArray(raw.children) ? raw.children : [];
}

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
        const { leaves, source } = partition;

        if (!isObject(input.root)) {
            fail(failures, "INV_MALFORMED_NODE", "root is missing required node fields");
            return resultOf(failures);
        }

        const root = input.root;
        validateNodeShape(root, leaves, failures);

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
        if (root.kind === "program" && isDenseArray(root.children)) {
            validateProgramStatementCoverage(
                root.children,
                expectedStatementRanges,
                leaves,
                failures
            );
        }

        const seenIds = new Set<number>();
        const seenObjects = new WeakSet<object>();
        const allNodes: Record<string, unknown>[] = [];

        function visit(raw: unknown, parent: Record<string, unknown> | null): void {
            if (!isObject(raw)) {
                fail(failures, "INV_MALFORMED_NODE", "child is not an object");
                return;
            }
            if (seenObjects.has(raw)) {
                fail(
                    failures,
                    "INV_SHARED_CHILD",
                    `Shared child or cycle detected at node id ${String(raw.id)}`,
                    isFiniteNonNegInt(raw.id) ? raw.id : undefined
                );
                return;
            }
            seenObjects.add(raw);
            validateNodeShape(raw, leaves, failures);
            allNodes.push(raw);

            if (isFiniteNonNegInt(raw.id)) {
                if (seenIds.has(raw.id)) {
                    fail(failures, "INV_ID_UNIQUE", `Duplicate node id ${raw.id}`, raw.id);
                }
                seenIds.add(raw.id);
            }

            // Span / leafRange consistency
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
                    const expected = rangeToSpan(leaves, source, raw.leafRange);
                    if (
                        !expected ||
                        raw.span.start !== expected.start ||
                        raw.span.end !== expected.end
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

            // Parent containment
            if (
                parent &&
                isSourceSpan(parent.span) &&
                isSourceSpan(raw.span) &&
                isLeafRange(parent.leafRange) &&
                isLeafRange(raw.leafRange)
            ) {
                if (
                    raw.span.start < parent.span.start ||
                    raw.span.end > parent.span.end ||
                    raw.leafRange.start < parent.leafRange.start ||
                    raw.leafRange.end > parent.leafRange.end
                ) {
                    fail(
                        failures,
                        "INV_PARENT_CONTAINMENT",
                        `Child ${String(raw.id)} not contained by parent ${String(parent.id)}`,
                        isFiniteNonNegInt(raw.id) ? raw.id : undefined
                    );
                }
            }

            const childrenRaw = getChildrenRaw(raw);
            const childObjects: Record<string, unknown>[] = [];
            for (let i = 0; i < childrenRaw.length; i++) {
                const child = childrenRaw[i];
                if (!isObject(child)) {
                    fail(
                        failures,
                        "INV_MALFORMED_NODE",
                        `Malformed child at index ${i} of node ${String(raw.id)}`,
                        isFiniteNonNegInt(raw.id) ? raw.id : undefined
                    );
                    continue;
                }
                childObjects.push(child);
                if (i > 0) {
                    const prev = childObjects[i - 1]!;
                    if (
                        isLeafRange(prev.leafRange) &&
                        isLeafRange(child.leafRange) &&
                        isSourceSpan(prev.span) &&
                        isSourceSpan(child.span)
                    ) {
                        if (
                            child.leafRange.start < prev.leafRange.end ||
                            child.span.start < prev.span.end
                        ) {
                            if (rangesOverlap(prev.leafRange, child.leafRange)) {
                                fail(
                                    failures,
                                    "INV_SIBLING_OVERLAP",
                                    `Sibling overlap between ${String(prev.id)} and ${String(child.id)}`,
                                    isFiniteNonNegInt(child.id) ? child.id : undefined
                                );
                            } else {
                                fail(
                                    failures,
                                    "INV_CHILDREN_ORDER",
                                    `Children out of source order under ${String(raw.id)}`,
                                    isFiniteNonNegInt(child.id) ? child.id : undefined
                                );
                            }
                        }
                    }
                }
                visit(child, raw);
            }

            // Relationship contracts (after children visited so shapes known)
            enforceRelationships(raw, childObjects, leaves, failures);
        }

        visit(root, null);

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

        // Contiguous ids 0..n-1
        if (allNodes.length > 0) {
            const ids = allNodes
                .map((n) => n.id)
                .filter((id): id is number => isFiniteNonNegInt(id))
                .sort((a, b) => a - b);
            for (let i = 0; i < ids.length; i++) {
                if (ids[i] !== i) {
                    fail(
                        failures,
                        "INV_ID_CONTIGUOUS",
                        `Node ids must be unique and contiguous from 0; missing or gap at ${i}`
                    );
                    break;
                }
            }
        }

        // tokenTable: undefined / absent → skip; explicit null/false/0/object → validate fail-closed
        if (Object.prototype.hasOwnProperty.call(input, "tokenTable") && input.tokenTable !== undefined) {
            const tableResult = validateTokenTableInvariants(
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
