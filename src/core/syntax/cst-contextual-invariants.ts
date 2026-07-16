import { isProxy } from "node:util/types";
import { isParserStructuredCapabilityState } from "../dialects/capability-state";
import type { OperatorSemantics } from "../dialects/types";
import { isCapabilityIdentity } from "../diagnostics/diagnostic";
import type { SourceLeaf } from "../lexer/token";
import type { CstDialectInvariantContext } from "./cst-dialect-context";
import {
    hasAsciiKeywordCaseShape,
    isBuiltinTypeName,
    isFormatRole,
    isGrammarKeywordMarkerId,
    isKeywordCaseRole,
    isOperatorFixity,
    isOperatorFormatClass,
    isSyntaxLeafRole,
    isSyntaxMarkerId,
} from "./contextual-fact-contract";
import type { InvariantFailure } from "./invariant-types";
import {
    fail,
    isFiniteNonNegInt,
    isLeafRange,
    isObject,
    isSyntaxChannel,
} from "./invariant-shared";
import type { LeafRange } from "./leaf-range";
import type {
    FormatRole,
    SyntaxLeafRole,
    SyntaxMarkerId,
} from "./node";
import { primitiveExpressionCapabilityId } from "./primitive-capability";

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

const STABLE_FROZEN_ARRAY_CACHE = new WeakSet<object>();
const MISSING_DATA_FIELD = Symbol("missing-data-field");

function hasExactFrozenDataShape(
    value: unknown,
    expectedKeys: readonly string[]
): value is Record<string, unknown> {
    if (
        !isObject(value) ||
        isProxy(value) ||
        Object.getPrototypeOf(value) !== Object.prototype ||
        !Object.isFrozen(value)
    ) {
        return false;
    }
    const keys = Reflect.ownKeys(value);
    if (
        keys.length !== expectedKeys.length ||
        keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))
    ) {
        return false;
    }
    for (const key of expectedKeys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (
            descriptor === undefined ||
            !("value" in descriptor) ||
            descriptor.enumerable !== true ||
            descriptor.writable !== false ||
            descriptor.configurable !== false
        ) {
            return false;
        }
    }
    return true;
}

function isStableFrozenDataArray(value: unknown): value is readonly unknown[] {
    if (typeof value !== "object" || value === null || isProxy(value)) {
        return false;
    }
    if (STABLE_FROZEN_ARRAY_CACHE.has(value)) {
        return true;
    }
    if (!Array.isArray(value) || !Object.isFrozen(value)) {
        return false;
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length !== value.length + 1 || keys[keys.length - 1] !== "length") {
        return false;
    }
    for (let index = 0; index < value.length; index++) {
        if (keys[index] !== String(index)) {
            return false;
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, index);
        if (
            descriptor === undefined ||
            !("value" in descriptor) ||
            descriptor.enumerable !== true ||
            descriptor.writable !== false ||
            descriptor.configurable !== false
        ) {
            return false;
        }
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    const stable =
        lengthDescriptor !== undefined &&
        "value" in lengthDescriptor &&
        lengthDescriptor.value === value.length &&
        lengthDescriptor.enumerable === false &&
        lengthDescriptor.writable === false &&
        lengthDescriptor.configurable === false;
    if (stable) {
        STABLE_FROZEN_ARRAY_CACHE.add(value);
    }
    return stable;
}

function readRequiredDataField(
    raw: Record<string, unknown>,
    field: string,
    nodeId: number,
    failures: InvariantFailure[],
    trustedCanonicalShape = false
): unknown | typeof MISSING_DATA_FIELD {
    if (trustedCanonicalShape) {
        return raw[field];
    }
    const descriptor = Object.getOwnPropertyDescriptor(raw, field);
    if (descriptor === undefined || !("value" in descriptor)) {
        fail(
            failures,
            "INV_SHAPE",
            `${field} must be an own data property on node ${nodeId}`,
            nodeId
        );
        return MISSING_DATA_FIELD;
    }
    return descriptor.value;
}

function isStableFrozenRange(value: unknown): value is LeafRange {
    return (
        hasExactFrozenDataShape(value, ["start", "end"]) &&
        isFiniteNonNegInt(value.start) &&
        isFiniteNonNegInt(value.end) &&
        value.start <= value.end
    );
}

function leafIdInRange(leafId: number, range: LeafRange): boolean {
    return leafId >= range.start && leafId < range.end;
}

function rangeOverlapsRange(left: LeafRange, right: LeafRange): boolean {
    return left.start < right.end && right.start < left.end;
}

interface ChildIntervalIndex {
    readonly starts: readonly number[];
    readonly prefixMaximumEnds: readonly number[];
}

const DIRECT_CHILD_INTERVAL_INDEX = new WeakMap<object, ChildIntervalIndex>();
const MARKER_BY_LEAF_INDEX = new WeakMap<
    object,
    ReadonlyMap<number, Record<string, unknown>>
>();
const SMALL_DIRECT_CHILD_SCAN_LIMIT = 8;
const SMALL_MARKER_SCAN_LIMIT = 8;

function buildChildIntervalIndex(
    directChildren: readonly Record<string, unknown>[]
): ChildIntervalIndex {
    const ranges: LeafRange[] = [];
    for (const child of directChildren) {
        if (isLeafRange(child.leafRange)) {
            ranges.push(child.leafRange);
        }
    }
    ranges.sort((left, right) => left.start - right.start || left.end - right.end);
    const starts = new Array<number>(ranges.length);
    const prefixMaximumEnds = new Array<number>(ranges.length);
    let maximumEnd = -1;
    for (let index = 0; index < ranges.length; index++) {
        const range = ranges[index]!;
        starts[index] = range.start;
        maximumEnd = Math.max(maximumEnd, range.end);
        prefixMaximumEnds[index] = maximumEnd;
    }
    return Object.freeze({
        starts: Object.freeze(starts),
        prefixMaximumEnds: Object.freeze(prefixMaximumEnds),
    });
}

function childIntervalIndex(
    directChildren: readonly Record<string, unknown>[]
): ChildIntervalIndex {
    const cached = DIRECT_CHILD_INTERVAL_INDEX.get(directChildren);
    if (cached !== undefined) {
        return cached;
    }
    const built = buildChildIntervalIndex(directChildren);
    if (Object.isFrozen(directChildren)) {
        DIRECT_CHILD_INTERVAL_INDEX.set(directChildren, built);
    }
    return built;
}

function lastStartBefore(
    starts: readonly number[],
    exclusiveEnd: number
): number {
    let low = 0;
    let high = starts.length - 1;
    let found = -1;
    while (low <= high) {
        const middle = low + Math.floor((high - low) / 2);
        if (starts[middle]! < exclusiveEnd) {
            found = middle;
            low = middle + 1;
        } else {
            high = middle - 1;
        }
    }
    return found;
}

function leafIdInAnyChild(
    leafId: number,
    directChildren: readonly Record<string, unknown>[]
): boolean {
    if (directChildren.length <= SMALL_DIRECT_CHILD_SCAN_LIMIT) {
        for (const child of directChildren) {
            if (
                isLeafRange(child.leafRange) &&
                leafIdInRange(leafId, child.leafRange)
            ) {
                return true;
            }
        }
        return false;
    }
    const index = childIntervalIndex(directChildren);
    const candidate = lastStartBefore(index.starts, leafId + 1);
    return (
        candidate >= 0 &&
        index.prefixMaximumEnds[candidate]! > leafId
    );
}

function rangeOverlapsAnyChild(
    range: LeafRange,
    directChildren: readonly Record<string, unknown>[]
): boolean {
    if (directChildren.length <= SMALL_DIRECT_CHILD_SCAN_LIMIT) {
        for (const child of directChildren) {
            if (
                isLeafRange(child.leafRange) &&
                rangeOverlapsRange(range, child.leafRange)
            ) {
                return true;
            }
        }
        return false;
    }
    const index = childIntervalIndex(directChildren);
    const candidate = lastStartBefore(index.starts, range.end);
    return (
        candidate >= 0 &&
        index.prefixMaximumEnds[candidate]! > range.start
    );
}

type NameRangeClaim = {
    field: string;
    range: LeafRange;
    allowsTypeNameMarker: boolean;
};

const EMPTY_NAME_RANGE_CLAIMS: readonly NameRangeClaim[] = Object.freeze([]);
const EMPTY_LEAF_IDS: readonly number[] = Object.freeze([]);
const EMPTY_VALIDATED_MARKERS: readonly Record<string, unknown>[] = Object.freeze([]);
const CLAUSE_CAPABILITY_BY_KIND: Readonly<Record<string, string>> = Object.freeze({
    from: "from",
    where: "where",
    "group-by": "group-by",
    having: "having",
    window: "window",
    "order-by": "order-by",
    "cluster-by": "cluster-by",
    "distribute-by": "distribute-by",
    "sort-by": "sort-by",
    limit: "limit",
    "join-on": "join",
    "join-using": "join",
    "lateral-view": "lateral-view",
    insert: "insert-overwrite-partition-select",
    partition: "insert-overwrite-partition-select",
    "set-operation": "set-operations",
});
const RELATION_CAPABILITY_BY_KIND: Readonly<Record<string, string>> = Object.freeze({
    subquery: "subquery",
    join: "join",
    "lateral-view": "lateral-view",
    "table-function": "table-function",
});
const COLLECTION_EXPRESSION_CAPABILITIES: readonly string[] = Object.freeze([
    "collection-expression",
    "postgres-array-subset",
    "generic-array-subset",
]);
const SELECT_QUERY_CAPABILITIES: readonly string[] = Object.freeze([
    "select-without-from",
    "from",
]);
const EXPRESSION_CAPABILITY_BY_KIND: Readonly<
    Record<string, string | readonly string[]>
> = Object.freeze({
    "function-call": "function-call",
    cast: "cast-type",
    case: "case-expression",
    subquery: "subquery-expression",
    window: "window-expression",
    collection: COLLECTION_EXPRESSION_CAPABILITIES,
});

function hasStructuredCapabilityState(
    dialectContext: CstDialectInvariantContext,
    capabilityId: string
): boolean {
    return isParserStructuredCapabilityState(
        dialectContext.capability(capabilityId)?.state
    );
}

function hasPreservationCapabilityState(
    dialectContext: CstDialectInvariantContext,
    capabilityId: string
): boolean {
    const state = dialectContext.capability(capabilityId)?.state;
    return state === "verbatim" || state === "diagnostic";
}

function matchesRoleCapability(
    formatRole: FormatRole,
    capabilityId: string | null,
    expectedRole: FormatRole,
    expectedCapability: string | null | readonly string[]
): boolean {
    return (
        formatRole === expectedRole &&
        (Array.isArray(expectedCapability)
            ? capabilityId !== null && expectedCapability.includes(capabilityId)
            : capabilityId === expectedCapability)
    );
}

function validateRoleCapabilityAllowlist(
    raw: Record<string, unknown>,
    directChildren: readonly Record<string, unknown>[],
    leaves: readonly SourceLeaf[],
    nodeId: number,
    formatRole: unknown,
    capabilityId: unknown,
    failures: InvariantFailure[],
    dialectContext: CstDialectInvariantContext
): void {
    if (!isFormatRole(formatRole)) {
        fail(
            failures,
            "INV_ENUM",
            `formatRole has an illegal value on node ${nodeId}: ${String(formatRole)}`,
            nodeId
        );
        return;
    }
    if (!isCapabilityIdentity(capabilityId)) {
        fail(
            failures,
            "INV_SHAPE",
            `capabilityId must be null or a canonical identity on node ${nodeId}`,
            nodeId
        );
        return;
    }
    const role = formatRole;
    if (
        capabilityId !== null &&
        dialectContext.capability(capabilityId) === null
    ) {
        fail(
            failures,
            "INV_RELATIONSHIP",
            `capabilityId ${capabilityId} is not owned by ${dialectContext.dialect} on node ${nodeId}`,
            nodeId
        );
        return;
    }
    if (
        (role === "capability" && capabilityId === null) ||
        ((role === "intrinsic-container" || role === "intrinsic-primitive") &&
            capabilityId !== null) ||
        ((raw.kind === "opaque") !== (role === "opaque"))
    ) {
        fail(
            failures,
            "INV_RELATIONSHIP",
            `illegal formatRole/capabilityId combination ${role}/${String(capabilityId)} on node ${nodeId}`,
            nodeId
        );
        return;
    }
    if (
        role === "capability" &&
        capabilityId !== null &&
        !hasStructuredCapabilityState(dialectContext, capabilityId)
    ) {
        fail(
            failures,
            "INV_RELATIONSHIP",
            `capability node ${nodeId} requires a parser-structured capability, got ${capabilityId}`,
            nodeId
        );
    }
    if (
        role === "opaque" &&
        capabilityId !== null &&
        !hasPreservationCapabilityState(dialectContext, capabilityId)
    ) {
        fail(
            failures,
            "INV_RELATIONSHIP",
            `opaque node ${nodeId} cannot use structured capability ${capabilityId}`,
            nodeId
        );
    }

    let allowed = false;
    switch (raw.kind) {
        case "program":
            allowed =
                matchesRoleCapability(role, capabilityId, "intrinsic-container", null) ||
                matchesRoleCapability(role, capabilityId, "capability", "multi-statement");
            break;
        case "statement":
            allowed = matchesRoleCapability(
                role,
                capabilityId,
                "intrinsic-container",
                null
            );
            break;
        case "query":
            if (
                directChildren[0]?.kind === "clause" &&
                directChildren[0]?.clauseKind === "with"
            ) {
                allowed = matchesRoleCapability(
                    role,
                    capabilityId,
                    "capability",
                    "with-cte"
                );
            } else if (
                directChildren[0]?.kind === "clause" &&
                directChildren[0]?.clauseKind === "insert"
            ) {
                allowed = matchesRoleCapability(
                    role,
                    capabilityId,
                    "capability",
                    "insert-overwrite-partition-select"
                );
            } else if (raw.queryKind === "parenthesized") {
                allowed = matchesRoleCapability(role, capabilityId, "capability", "subquery");
            } else if (raw.queryKind === "set") {
                allowed = matchesRoleCapability(
                    role,
                    capabilityId,
                    "capability",
                    "set-operations"
                );
            } else if (raw.queryKind === "select") {
                allowed = matchesRoleCapability(
                    role,
                    capabilityId,
                    "capability",
                    SELECT_QUERY_CAPABILITIES
                );
            }
            break;
        case "cte":
        case "list":
        case "list-item":
        case "case-branch":
        case "window-spec":
            allowed = matchesRoleCapability(
                role,
                capabilityId,
                "intrinsic-container",
                null
            );
            break;
        case "clause": {
            const intrinsic = raw.clauseKind === "select" || raw.clauseKind === "with";
            allowed = intrinsic
                ? matchesRoleCapability(
                      role,
                      capabilityId,
                      "intrinsic-container",
                      null
                  )
                : typeof raw.clauseKind === "string" &&
                  matchesRoleCapability(
                      role,
                      capabilityId,
                      "capability",
                      CLAUSE_CAPABILITY_BY_KIND[raw.clauseKind] ?? []
                  );
            break;
        }
        case "relation": {
            if (raw.relationKind === "table") {
                allowed = matchesRoleCapability(
                    role,
                    capabilityId,
                    "intrinsic-primitive",
                    null
                );
            } else if (raw.relationKind === "opaque") {
                allowed = matchesRoleCapability(
                    role,
                    capabilityId,
                    "intrinsic-container",
                    null
                );
            } else if (typeof raw.relationKind === "string") {
                allowed = matchesRoleCapability(
                    role,
                    capabilityId,
                    "capability",
                    RELATION_CAPABILITY_BY_KIND[raw.relationKind] ?? []
                );
            }
            break;
        }
        case "expression": {
            const primitive =
                raw.expressionKind === "identifier" ||
                raw.expressionKind === "wildcard" ||
                raw.expressionKind === "literal" ||
                raw.expressionKind === "parameter" ||
                raw.expressionKind === "typed-literal";
            const expectedCapability =
                typeof raw.expressionKind === "string"
                    ? EXPRESSION_CAPABILITY_BY_KIND[raw.expressionKind]
                    : undefined;
            const primitiveCapability =
                (raw.expressionKind === "literal" ||
                    raw.expressionKind === "parameter") &&
                isLeafRange(raw.leafRange)
                    ? primitiveExpressionCapabilityId(
                          dialectContext.dialect,
                          raw.expressionKind,
                          leaves[raw.leafRange.start]
                      )
                    : null;
            allowed =
                raw.expressionKind === "frame-bound"
                    ? matchesRoleCapability(
                          role,
                          capabilityId,
                          "intrinsic-primitive",
                          null
                      ) ||
                      matchesRoleCapability(
                          role,
                          capabilityId,
                          "intrinsic-container",
                          null
                      )
                    : primitiveCapability !== null
                    ? matchesRoleCapability(
                          role,
                          capabilityId,
                          "capability",
                          primitiveCapability
                      )
                    : expectedCapability !== undefined
                    ? matchesRoleCapability(
                          role,
                          capabilityId,
                          "capability",
                          expectedCapability
                      )
                    : matchesRoleCapability(
                          role,
                          capabilityId,
                          primitive ? "intrinsic-primitive" : "intrinsic-container",
                          null
                      );
            break;
        }
        case "type-expression":
            allowed = matchesRoleCapability(
                role,
                capabilityId,
                "intrinsic-primitive",
                null
            );
            break;
        case "opaque":
            allowed = role === "opaque";
            break;
        default:
            return;
    }
    if (!allowed) {
        fail(
            failures,
            "INV_RELATIONSHIP",
            `node ${nodeId} kind ${String(raw.kind)} does not allow ${role}/${String(capabilityId)}`,
            nodeId
        );
    }
}

function readStableNameRange(
    raw: Record<string, unknown>,
    field: string,
    nodeId: number,
    ownerRange: LeafRange | null,
    leaves: readonly SourceLeaf[],
    allowNull: boolean,
    failures: InvariantFailure[],
    trustedCanonicalShape: boolean
): LeafRange | null {
    const value = readRequiredDataField(
        raw,
        field,
        nodeId,
        failures,
        trustedCanonicalShape
    );
    if (value === MISSING_DATA_FIELD) {
        return null;
    }
    if (value === null && allowNull) {
        return null;
    }
    if (
        !isLeafRange(value) ||
        (!trustedCanonicalShape && !isStableFrozenRange(value))
    ) {
        fail(
            failures,
            "INV_SHAPE",
            `${field} must be a stable frozen range${allowNull ? " or null" : ""} on node ${nodeId}`,
            nodeId
        );
        return null;
    }
    validateSubRange(value, field, nodeId, ownerRange, leaves.length, failures);
    if (value.start === value.end) {
        fail(
            failures,
            "INV_EMPTY_RANGE",
            `${field} must be non-empty on node ${nodeId}`,
            nodeId
        );
    }
    return value;
}

function validateStableAliasClaim(
    raw: Record<string, unknown>,
    nodeId: number,
    ownerRange: LeafRange | null,
    leaves: readonly SourceLeaf[],
    failures: InvariantFailure[],
    trustedCanonicalShape: boolean
): NameRangeClaim | null {
    if (raw.kind !== "relation" && raw.kind !== "list-item") {
        return null;
    }
    const aliasValue = readRequiredDataField(
        raw,
        "alias",
        nodeId,
        failures,
        trustedCanonicalShape
    );
    if (aliasValue === MISSING_DATA_FIELD || aliasValue === null) {
        return null;
    }
    if (
        !isObject(aliasValue) ||
        (!trustedCanonicalShape &&
            !hasExactFrozenDataShape(aliasValue, ["keywordLeafId", "nameLeafRange"])) ||
        !isLeafRange(aliasValue.nameLeafRange) ||
        (!trustedCanonicalShape &&
            !isStableFrozenRange(aliasValue.nameLeafRange))
    ) {
        fail(
            failures,
            "INV_SHAPE",
            `alias and alias.nameLeafRange must be stable frozen data records on node ${nodeId}`,
            nodeId
        );
        return null;
    }
    validateSubRange(
        aliasValue.nameLeafRange,
        "alias.nameLeafRange",
        nodeId,
        ownerRange,
        leaves.length,
        failures
    );
    return {
        field: "alias.nameLeafRange",
        range: aliasValue.nameLeafRange,
        allowsTypeNameMarker: false,
    };
}

function validateQualifiedRelationName(
    range: LeafRange,
    nodeId: number,
    leaves: readonly SourceLeaf[],
    failures: InvariantFailure[]
): void {
    let ordinal = 0;
    for (let leafId = range.start; leafId < range.end && leafId < leaves.length; leafId++) {
        const leaf = leaves[leafId]!;
        if (!isSyntaxChannel(leaf.channel)) {
            continue;
        }
        const valid =
            ordinal % 2 === 0
                ? leaf.kind === "identifier" ||
                  leaf.kind === "keyword" ||
                  leaf.kind === "quoted-identifier" ||
                  leaf.kind === "parameter"
                : leaf.channel === "code" && leaf.raw === ".";
        if (!valid) {
            fail(
                failures,
                "INV_RELATIONSHIP",
                `relation ${nodeId} nameLeafRange is not a complete qualified name at leaf ${leafId}`,
                nodeId
            );
            return;
        }
        ordinal += 1;
    }
    if (ordinal === 0 || ordinal % 2 === 0) {
        fail(
            failures,
            "INV_RELATIONSHIP",
            `relation ${nodeId} nameLeafRange must contain an odd non-zero qualified-name sequence`,
            nodeId
        );
    }
}

function collectNameRangeClaims(
    raw: Record<string, unknown>,
    nodeId: number,
    ownerRange: LeafRange | null,
    directChildren: readonly Record<string, unknown>[],
    leaves: readonly SourceLeaf[],
    failures: InvariantFailure[],
    trustedCanonicalShape: boolean
): readonly NameRangeClaim[] {
    if (
        raw.kind !== "cte" &&
        raw.kind !== "relation" &&
        raw.kind !== "window-spec" &&
        raw.kind !== "type-expression" &&
        raw.kind !== "list-item"
    ) {
        return EMPTY_NAME_RANGE_CLAIMS;
    }
    if (
        trustedCanonicalShape &&
        raw.kind === "list-item" &&
        raw.alias === null
    ) {
        return EMPTY_NAME_RANGE_CLAIMS;
    }
    const claims: NameRangeClaim[] = [];
    const add = (field: string, range: LeafRange | null, allowsTypeNameMarker = false): void => {
        if (range !== null) {
            claims.push({ field, range, allowsTypeNameMarker });
        }
    };

    if (raw.kind === "cte") {
        add(
            "nameLeafRange",
            readStableNameRange(
                raw,
                "nameLeafRange",
                nodeId,
                ownerRange,
                leaves,
                false,
                failures,
                trustedCanonicalShape
            )
        );
    } else if (raw.kind === "relation") {
        const nameRange = readStableNameRange(
            raw,
            "nameLeafRange",
            nodeId,
            ownerRange,
            leaves,
            true,
            failures,
            trustedCanonicalShape
        );
        if (raw.relationKind === "table") {
            if (nameRange === null) {
                fail(
                    failures,
                    "INV_RELATIONSHIP",
                    `table relation ${nodeId} must own a complete nameLeafRange`,
                    nodeId
                );
            } else {
                validateQualifiedRelationName(nameRange, nodeId, leaves, failures);
                add("nameLeafRange", nameRange);
            }
        } else if (nameRange !== null) {
            fail(
                failures,
                "INV_RELATIONSHIP",
                `non-table relation ${nodeId} must have nameLeafRange null`,
                nodeId
            );
            add("nameLeafRange", nameRange);
        }
    } else if (raw.kind === "window-spec") {
        add(
            "nameLeafRange",
            readStableNameRange(
                raw,
                "nameLeafRange",
                nodeId,
                ownerRange,
                leaves,
                true,
                failures,
                trustedCanonicalShape
            )
        );
    } else if (raw.kind === "type-expression") {
        add(
            "typeNameLeafRange",
            readStableNameRange(
                raw,
                "typeNameLeafRange",
                nodeId,
                ownerRange,
                leaves,
                false,
                failures,
                trustedCanonicalShape
            ),
            true
        );
    }

    const alias = validateStableAliasClaim(
        raw,
        nodeId,
        ownerRange,
        leaves,
        failures,
        trustedCanonicalShape
    );
    if (alias !== null) {
        claims.push(alias);
    }

    for (let leftIndex = 0; leftIndex < claims.length; leftIndex++) {
        const left = claims[leftIndex]!;
        if (rangeOverlapsAnyChild(left.range, directChildren)) {
            fail(
                failures,
                "INV_OWNER_REFERENCE",
                `${left.field} overlaps a direct child on node ${nodeId}`,
                nodeId
            );
        }
        for (let rightIndex = leftIndex + 1; rightIndex < claims.length; rightIndex++) {
            const right = claims[rightIndex]!;
            if (rangeOverlapsRange(left.range, right.range)) {
                fail(
                    failures,
                    "INV_OWNER_REFERENCE",
                    `${left.field} overlaps ${right.field} on node ${nodeId}`,
                    nodeId
                );
            }
        }
    }
    return claims;
}

function readStableLeafIdArray(
    raw: Record<string, unknown>,
    field: string,
    nodeId: number,
    ownerRange: LeafRange | null,
    leaves: readonly SourceLeaf[],
    failures: InvariantFailure[],
    trustedCanonicalShape: boolean
): readonly number[] {
    const value = readRequiredDataField(
        raw,
        field,
        nodeId,
        failures,
        trustedCanonicalShape
    );
    if (value === MISSING_DATA_FIELD) {
        return EMPTY_LEAF_IDS;
    }
    if (
        !Array.isArray(value) ||
        (!trustedCanonicalShape && !isStableFrozenDataArray(value))
    ) {
        fail(
            failures,
            "INV_SHAPE",
            `${field} must be a stable frozen dense data array on node ${nodeId}`,
            nodeId
        );
        return EMPTY_LEAF_IDS;
    }
    if (value.length === 0) {
        return EMPTY_LEAF_IDS;
    }
    let previous = -1;
    const ids: number[] | null = trustedCanonicalShape ? null : [];
    for (let index = 0; index < value.length; index++) {
        const leafId = value[index];
        if (!isFiniteNonNegInt(leafId)) {
            fail(
                failures,
                "INV_SHAPE",
                `${field}[${index}] must be a finite non-negative integer on node ${nodeId}`,
                nodeId
            );
            continue;
        }
        if (leafId <= previous) {
            fail(
                failures,
                "INV_OWNER_REFERENCE",
                `${field} must be unique and strictly source ordered on node ${nodeId}`,
                nodeId
            );
        }
        previous = leafId;
        if (
            leafId >= leaves.length ||
            (ownerRange !== null && !leafIdInRange(leafId, ownerRange))
        ) {
            fail(
                failures,
                "INV_OWNER_REFERENCE",
                `${field}[${index}]=${leafId} is outside its owner on node ${nodeId}`,
                nodeId
            );
            continue;
        }
        ids?.push(leafId);
    }
    return ids ?? (value as readonly number[]);
}

function validateSeparatorLeafIds(
    raw: Record<string, unknown>,
    nodeId: number,
    ownerRange: LeafRange | null,
    directChildren: readonly Record<string, unknown>[],
    nameClaims: readonly NameRangeClaim[],
    leaves: readonly SourceLeaf[],
    failures: InvariantFailure[],
    trustedCanonicalShape: boolean
): readonly number[] {
    if (raw.kind !== "clause" && raw.kind !== "list") {
        return EMPTY_LEAF_IDS;
    }
    const ids = readStableLeafIdArray(
        raw,
        "separatorLeafIds",
        nodeId,
        ownerRange,
        leaves,
        failures,
        trustedCanonicalShape
    );
    for (const leafId of ids) {
        const leaf = leaves[leafId];
        if (leaf?.channel !== "code" || leaf.raw !== ",") {
            fail(
                failures,
                "INV_RELATIONSHIP",
                `separator leaf ${leafId} must be a code comma on node ${nodeId}`,
                nodeId
            );
        }
        if (leafIdInAnyChild(leafId, directChildren)) {
            fail(
                failures,
                "INV_OWNER_REFERENCE",
                `separator leaf ${leafId} overlaps a direct child on node ${nodeId}`,
                nodeId
            );
        }
        if (nameClaims.some((claim) => leafIdInRange(leafId, claim.range))) {
            fail(
                failures,
                "INV_OWNER_REFERENCE",
                `separator leaf ${leafId} overlaps a name range on node ${nodeId}`,
                nodeId
            );
        }
        if (
            raw.kind === "clause" &&
            isLeafRange(raw.bodyLeafRange) &&
            !leafIdInRange(leafId, raw.bodyLeafRange)
        ) {
            fail(
                failures,
                "INV_OWNER_REFERENCE",
                `clause separator leaf ${leafId} must be inside bodyLeafRange on node ${nodeId}`,
                nodeId
            );
        }
    }
    return ids;
}

function validateCanonicalOperatorOccurrences(
    raw: Record<string, unknown>,
    nodeId: number,
    ownerRange: LeafRange | null,
    leaves: readonly SourceLeaf[],
    failures: InvariantFailure[],
    trustedCanonicalShape: boolean,
    dialectContext: CstDialectInvariantContext
): readonly number[] {
    if (raw.kind !== "expression") {
        return EMPTY_LEAF_IDS;
    }
    const operatorLeafIds = readStableLeafIdArray(
        raw,
        "operatorLeafIds",
        nodeId,
        ownerRange,
        leaves,
        failures,
        trustedCanonicalShape
    );
    const occurrenceValue = readRequiredDataField(
        raw,
        "operatorOccurrences",
        nodeId,
        failures,
        trustedCanonicalShape
    );
    if (
        occurrenceValue === MISSING_DATA_FIELD ||
        !Array.isArray(occurrenceValue) ||
        (!trustedCanonicalShape &&
            !isStableFrozenDataArray(occurrenceValue))
    ) {
        if (occurrenceValue !== MISSING_DATA_FIELD) {
            fail(
                failures,
                "INV_SHAPE",
                `operatorOccurrences must be a stable frozen dense data array on expression ${nodeId}`,
                nodeId
            );
        }
        return operatorLeafIds;
    }

    if (operatorLeafIds.length === 0 && occurrenceValue.length === 0) {
        return EMPTY_LEAF_IDS;
    }

    const operatorSet = new Set(operatorLeafIds);
    const claimed = new Set<number>();
    let previousFirstLeafId = -1;
    for (let occurrenceIndex = 0; occurrenceIndex < occurrenceValue.length; occurrenceIndex++) {
        const occurrence = occurrenceValue[occurrenceIndex];
        if (
            !isObject(occurrence) ||
            (!trustedCanonicalShape &&
                !hasExactFrozenDataShape(occurrence, [
                    "ownerNodeId",
                    "leafIds",
                    "operatorId",
                    "capabilityId",
                    "fixity",
                    "formatClass",
                    "semantics",
                ]))
        ) {
            fail(
                failures,
                "INV_SHAPE",
                `operatorOccurrences[${occurrenceIndex}] must be an exact frozen data record on expression ${nodeId}`,
                nodeId
            );
            continue;
        }
        const semantics = occurrence.semantics;
        if (
            !isObject(semantics) ||
            !dialectContext.ownsOperatorSemantics(semantics) ||
            occurrence.ownerNodeId !== nodeId ||
            occurrence.operatorId !== semantics.id ||
            occurrence.capabilityId !== semantics.capabilityId ||
            occurrence.fixity !== semantics.fixity ||
            occurrence.formatClass !== semantics.formatClass ||
            !isOperatorFixity(occurrence.fixity) ||
            !isOperatorFormatClass(occurrence.formatClass)
        ) {
            fail(
                failures,
                "INV_RELATIONSHIP",
                `operator occurrence ${occurrenceIndex} has forged semantics identity or projection on expression ${nodeId}`,
                nodeId
            );
            continue;
        }
        if (
            !Array.isArray(occurrence.leafIds) ||
            (!trustedCanonicalShape &&
                !isStableFrozenDataArray(occurrence.leafIds)) ||
            occurrence.leafIds.length === 0
        ) {
            fail(
                failures,
                "INV_SHAPE",
                `operator occurrence ${occurrenceIndex} leafIds must be a non-empty stable frozen data array on expression ${nodeId}`,
                nodeId
            );
            continue;
        }
        let previousLeafId = -1;
        const wordLeaves: SourceLeaf[] = [];
        for (let leafOrdinal = 0; leafOrdinal < occurrence.leafIds.length; leafOrdinal++) {
            const leafId = occurrence.leafIds[leafOrdinal];
            if (!isFiniteNonNegInt(leafId)) {
                fail(
                    failures,
                    "INV_SHAPE",
                    `operator occurrence ${occurrenceIndex} leaf ${leafOrdinal} is not a finite id`,
                    nodeId
                );
                continue;
            }
            if (
                leafId <= previousLeafId ||
                !operatorSet.has(leafId) ||
                claimed.has(leafId)
            ) {
                fail(
                    failures,
                    "INV_OWNER_REFERENCE",
                    `operator occurrence ${occurrenceIndex} has duplicate, unordered, or unowned leaf ${leafId} on expression ${nodeId}`,
                    nodeId
                );
            }
            previousLeafId = leafId;
            claimed.add(leafId);
            const leaf = leaves[leafId];
            if (leaf === undefined || leaf.channel !== "code") {
                fail(
                    failures,
                    "INV_OWNER_REFERENCE",
                    `operator occurrence ${occurrenceIndex} leaf ${leafId} must be code on expression ${nodeId}`,
                    nodeId
                );
            } else {
                wordLeaves.push(leaf);
            }
        }
        const firstLeafId = occurrence.leafIds[0];
        if (isFiniteNonNegInt(firstLeafId) && firstLeafId <= previousFirstLeafId) {
            fail(
                failures,
                "INV_OWNER_REFERENCE",
                `operator occurrences must be strictly source ordered on expression ${nodeId}`,
                nodeId
            );
        }
        if (isFiniteNonNegInt(firstLeafId)) {
            previousFirstLeafId = firstLeafId;
        }

        const canonicalSemantics = semantics as unknown as OperatorSemantics;
        if (canonicalSemantics.form === "symbol") {
            if (
                wordLeaves.length !== 1 ||
                wordLeaves[0]!.kind !== "operator" ||
                wordLeaves[0]!.raw !== canonicalSemantics.key
            ) {
                fail(
                    failures,
                    "INV_RELATIONSHIP",
                    `symbol operator occurrence ${occurrenceIndex} does not match ${canonicalSemantics.id} on expression ${nodeId}`,
                    nodeId
                );
            }
        } else if (
            wordLeaves.length !== canonicalSemantics.words.length ||
            wordLeaves.some(
                (leaf, index) => leaf.raw.toLowerCase() !== canonicalSemantics.words[index]
            )
        ) {
            fail(
                failures,
                "INV_RELATIONSHIP",
                `word operator occurrence ${occurrenceIndex} does not match ${canonicalSemantics.id} on expression ${nodeId}`,
                nodeId
            );
        }
    }
    if (claimed.size !== operatorSet.size) {
        fail(
            failures,
            "INV_OWNER_REFERENCE",
            `every operatorLeafId must belong to exactly one canonical occurrence on expression ${nodeId}`,
            nodeId
        );
    }
    return operatorLeafIds;
}

function validateMarkerRole(
    marker: Record<string, unknown>,
    leaf: SourceLeaf,
    nodeId: number,
    failures: InvariantFailure[]
): void {
    const syntaxId = marker.syntaxId as SyntaxMarkerId;
    const syntaxRole = marker.syntaxRole as SyntaxLeafRole;
    const eligible = marker.keywordCaseEligible;
    if (eligible === true && !isKeywordCaseRole(syntaxRole)) {
        fail(
            failures,
            "INV_RELATIONSHIP",
            `marker ${syntaxId} has keywordCaseEligible=true for non-keyword role ${syntaxRole} on node ${nodeId}`,
            nodeId
        );
    }
    if (
        eligible === true &&
        (leaf.channel !== "code" || !hasAsciiKeywordCaseShape(leaf.raw))
    ) {
        fail(
            failures,
            "INV_RELATIONSHIP",
            `marker ${syntaxId} keyword-case proof must reference an ASCII code word on node ${nodeId}`,
            nodeId
        );
    }
    if (
        isGrammarKeywordMarkerId(syntaxId) &&
        (syntaxRole !== "syntax-keyword" || eligible !== true)
    ) {
        fail(
            failures,
            "INV_RELATIONSHIP",
            `grammar keyword marker ${syntaxId} must use syntax-keyword with case proof on node ${nodeId}`,
            nodeId
        );
    } else if (
        syntaxId === "statement-terminator" &&
        (syntaxRole !== "punctuation" || eligible !== false)
    ) {
        fail(
            failures,
            "INV_RELATIONSHIP",
            `statement terminator marker has an invalid role on node ${nodeId}`,
            nodeId
        );
    } else if (
        syntaxId === "delimiter" &&
        ((syntaxRole !== "delimiter" && syntaxRole !== "punctuation") ||
            eligible !== false)
    ) {
        fail(
            failures,
            "INV_RELATIONSHIP",
            `delimiter marker has an invalid role on node ${nodeId}`,
            nodeId
        );
    } else if (
        syntaxId === "separator" &&
        (syntaxRole !== "separator" || eligible !== false)
    ) {
        fail(
            failures,
            "INV_RELATIONSHIP",
            `separator marker has an invalid role on node ${nodeId}`,
            nodeId
        );
    } else if (
        syntaxId === "type:name" &&
        !(
            (syntaxRole === "builtin-type-keyword" && eligible === true) ||
            (syntaxRole === "user-type-name" && eligible === false)
        )
    ) {
        fail(
            failures,
            "INV_RELATIONSHIP",
            `type:name marker has an invalid role/case proof on node ${nodeId}`,
            nodeId
        );
    }
}

function validateSyntaxMarkers(
    raw: Record<string, unknown>,
    nodeId: number,
    ownerRange: LeafRange | null,
    directChildren: readonly Record<string, unknown>[],
    nameClaims: readonly NameRangeClaim[],
    separatorLeafIds: readonly number[],
    operatorLeafIds: readonly number[],
    leaves: readonly SourceLeaf[],
    failures: InvariantFailure[],
    trustedCanonicalShape: boolean
): readonly Record<string, unknown>[] {
    const markerValue = readRequiredDataField(
        raw,
        "syntaxMarkers",
        nodeId,
        failures,
        trustedCanonicalShape
    );
    if (
        markerValue === MISSING_DATA_FIELD ||
        !Array.isArray(markerValue) ||
        (!trustedCanonicalShape && !isStableFrozenDataArray(markerValue))
    ) {
        if (markerValue !== MISSING_DATA_FIELD) {
            fail(
                failures,
                "INV_SHAPE",
                `syntaxMarkers must be a stable frozen dense data array on node ${nodeId}`,
                nodeId
            );
        }
        return EMPTY_VALIDATED_MARKERS;
    }
    if (markerValue.length === 0) {
        return EMPTY_VALIDATED_MARKERS;
    }
    if (trustedCanonicalShape) {
        // The parser factory has already frozen, range-checked and source-
        // ordered every marker field. The exact marker closure below then
        // proves the complete node-specific leaf/id/role/ordinal ledger, so
        // repeating the generic untrusted-record walk here would add no
        // independent evidence on the canonical parser path.
        return markerValue as readonly Record<string, unknown>[];
    }
    const separatorSet =
        separatorLeafIds.length === 0 ? null : new Set(separatorLeafIds);
    const operatorSet =
        operatorLeafIds.length === 0 ? null : new Set(operatorLeafIds);
    const ordinalsBySyntaxId = markerValue.length > SMALL_MARKER_SCAN_LIMIT
        ? new Map<string, number>()
        : null;
    const validatedMarkers: Record<string, unknown>[] = [];
    let previousLeafId = -1;
    for (let markerIndex = 0; markerIndex < markerValue.length; markerIndex++) {
        const rawMarker = markerValue[markerIndex];
        if (
            !trustedCanonicalShape &&
            (!isObject(rawMarker) ||
                !hasExactFrozenDataShape(rawMarker, [
                    "leafId",
                    "syntaxId",
                    "partOrdinal",
                    "syntaxRole",
                    "keywordCaseEligible",
                ]))
        ) {
            fail(
                failures,
                "INV_SHAPE",
                `syntaxMarkers[${markerIndex}] must be an exact frozen data record on node ${nodeId}`,
                nodeId
            );
            continue;
        }
        const marker = rawMarker as Record<string, unknown>;
        validatedMarkers.push(marker);
        const leafId = marker.leafId as number;
        const syntaxId = marker.syntaxId as SyntaxMarkerId;
        const partOrdinal = marker.partOrdinal as number;
        const syntaxRole = marker.syntaxRole as SyntaxLeafRole;
        if (
            !trustedCanonicalShape &&
            (!isFiniteNonNegInt(leafId) ||
                ownerRange === null ||
                !leafIdInRange(leafId, ownerRange) ||
                leafId >= leaves.length ||
                leafId <= previousLeafId)
        ) {
            fail(
                failures,
                "INV_OWNER_REFERENCE",
                `syntax marker ${markerIndex} has an invalid, duplicate, or out-of-order leafId on node ${nodeId}`,
                nodeId
            );
            continue;
        }
        previousLeafId = leafId;
        if (!trustedCanonicalShape && !isSyntaxMarkerId(syntaxId)) {
            fail(
                failures,
                "INV_ENUM",
                `syntax marker ${markerIndex} has non-finite syntaxId ${String(syntaxId)} on node ${nodeId}`,
                nodeId
            );
            continue;
        }
        if (!trustedCanonicalShape) {
            if (!isFiniteNonNegInt(partOrdinal)) {
                fail(
                    failures,
                    "INV_SHAPE",
                    `syntax marker ${markerIndex} partOrdinal must be a finite non-negative integer on node ${nodeId}`,
                    nodeId
                );
            } else {
                let expectedOrdinal = 0;
                if (ordinalsBySyntaxId === null) {
                    for (let prior = 0; prior < markerIndex; prior++) {
                        const priorMarker = markerValue[prior];
                        if (
                            isObject(priorMarker) &&
                            priorMarker.syntaxId === syntaxId
                        ) {
                            expectedOrdinal += 1;
                        }
                    }
                } else {
                    expectedOrdinal = ordinalsBySyntaxId.get(syntaxId) ?? 0;
                }
                if (partOrdinal !== expectedOrdinal) {
                    fail(
                        failures,
                        "INV_ORDINAL",
                        `syntax marker ${syntaxId} expected partOrdinal ${expectedOrdinal}, got ${partOrdinal} on node ${nodeId}`,
                        nodeId
                    );
                }
                ordinalsBySyntaxId?.set(syntaxId, expectedOrdinal + 1);
            }
        }
        if (!trustedCanonicalShape && !isSyntaxLeafRole(syntaxRole)) {
            fail(
                failures,
                "INV_ENUM",
                `syntax marker ${markerIndex} has illegal syntaxRole ${String(syntaxRole)} on node ${nodeId}`,
                nodeId
            );
            continue;
        }
        if (
            !trustedCanonicalShape &&
            typeof marker.keywordCaseEligible !== "boolean"
        ) {
            fail(
                failures,
                "INV_SHAPE",
                `syntax marker ${markerIndex} keywordCaseEligible must be boolean on node ${nodeId}`,
                nodeId
            );
            continue;
        }
        const leaf = leaves[leafId]!;
        if (leaf.channel !== "code") {
            fail(
                failures,
                "INV_OWNER_REFERENCE",
                `syntax marker ${syntaxId} must reference a code grammar leaf, got ${leaf.channel} on node ${nodeId}`,
                nodeId
            );
        }
        validateMarkerRole(marker, leaf, nodeId, failures);
        if (leafIdInAnyChild(leafId, directChildren)) {
            fail(
                failures,
                "INV_OWNER_REFERENCE",
                `syntax marker leaf ${leafId} overlaps a direct child on node ${nodeId}`,
                nodeId
            );
        }
        const overlappingName = nameClaims.find((claim) =>
            leafIdInRange(leafId, claim.range)
        );
        if (
            overlappingName !== undefined &&
            !(
                overlappingName.allowsTypeNameMarker &&
                raw.kind === "type-expression" &&
                syntaxId === "type:name"
            )
        ) {
            fail(
                failures,
                "INV_OWNER_REFERENCE",
                `syntax marker leaf ${leafId} overlaps ${overlappingName.field} on node ${nodeId}`,
                nodeId
            );
        }
        if (separatorSet?.has(leafId)) {
            fail(
                failures,
                "INV_OWNER_REFERENCE",
                `syntax marker leaf ${leafId} also claims a separator on node ${nodeId}`,
                nodeId
            );
        }
        if (operatorSet?.has(leafId)) {
            fail(
                failures,
                "INV_OWNER_REFERENCE",
                `syntax marker leaf ${leafId} also claims an operator occurrence on node ${nodeId}`,
                nodeId
            );
        }
    }
    return Object.freeze(validatedMarkers);
}

function markerAtLeaf(
    markers: readonly Record<string, unknown>[],
    leafId: number
): Record<string, unknown> | null {
    if (markers.length <= SMALL_MARKER_SCAN_LIMIT) {
        for (const marker of markers) {
            if (marker.leafId === leafId) {
                return marker;
            }
        }
        return null;
    }
    let byLeaf = MARKER_BY_LEAF_INDEX.get(markers);
    if (byLeaf === undefined) {
        const built = new Map<number, Record<string, unknown>>();
        for (const marker of markers) {
            if (typeof marker.leafId === "number" && !built.has(marker.leafId)) {
                built.set(marker.leafId, marker);
            }
        }
        byLeaf = built;
        if (Object.isFrozen(markers)) {
            MARKER_BY_LEAF_INDEX.set(markers, byLeaf);
        }
    }
    return byLeaf.get(leafId) ?? null;
}

function requireExactSyntaxMarker(
    markers: readonly Record<string, unknown>[],
    leafId: number,
    syntaxId: SyntaxMarkerId,
    partOrdinal: number,
    syntaxRole: SyntaxLeafRole,
    keywordCaseEligible: boolean,
    nodeId: number,
    label: string,
    failures: InvariantFailure[]
): void {
    const marker = markerAtLeaf(markers, leafId);
    if (
        marker === null ||
        marker.syntaxId !== syntaxId ||
        marker.partOrdinal !== partOrdinal ||
        marker.syntaxRole !== syntaxRole ||
        marker.keywordCaseEligible !== keywordCaseEligible
    ) {
        fail(
            failures,
            "INV_RELATIONSHIP",
            `${label} leaf ${leafId} must have exact ${syntaxId} marker ordinal ${partOrdinal} on node ${nodeId}`,
            nodeId
        );
    }
}

function requireDirectKeywordSequence(
    range: LeafRange,
    directChildren: readonly Record<string, unknown>[],
    excludedRange: LeafRange | null,
    leaves: readonly SourceLeaf[],
    markers: readonly Record<string, unknown>[],
    expectedWords: readonly string[],
    syntaxId: SyntaxMarkerId,
    nodeId: number,
    label: string,
    failures: InvariantFailure[]
): void {
    let ordinal = 0;
    for (
        let leafId = range.start;
        leafId < range.end && leafId < leaves.length && ordinal < expectedWords.length;
        leafId++
    ) {
        if (
            leafIdInAnyChild(leafId, directChildren) ||
            (excludedRange !== null && leafIdInRange(leafId, excludedRange))
        ) {
            continue;
        }
        const leaf = leaves[leafId]!;
        if (
            leaf.channel !== "code" ||
            leaf.raw.toLowerCase() !== expectedWords[ordinal]
        ) {
            continue;
        }
        requireExactSyntaxMarker(
            markers,
            leafId,
            syntaxId,
            ordinal,
            "syntax-keyword",
            true,
            nodeId,
            label,
            failures
        );
        ordinal += 1;
    }
    if (ordinal !== expectedWords.length) {
        fail(
            failures,
            "INV_RELATIONSHIP",
            `${label} on node ${nodeId} must contain direct ${expectedWords.join(" ").toUpperCase()} grammar leaves`,
            nodeId
        );
    }
}

function directChildById(
    directChildren: readonly Record<string, unknown>[],
    childId: unknown
): Record<string, unknown> | null {
    if (!isFiniteNonNegInt(childId)) {
        return null;
    }
    for (const child of directChildren) {
        if (child.id === childId) {
            return child;
        }
    }
    return null;
}

function untrustedDataField(
    value: Record<string, unknown>,
    field: string,
    trustedCanonicalShape: boolean
): unknown {
    if (trustedCanonicalShape) {
        return value[field];
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    return descriptor !== undefined && "value" in descriptor
        ? descriptor.value
        : undefined;
}

function requireDirectDelimiterMarkers(
    range: LeafRange,
    directChildren: readonly Record<string, unknown>[],
    leaves: readonly SourceLeaf[],
    markers: readonly Record<string, unknown>[],
    nodeId: number,
    label: string,
    failures: InvariantFailure[],
    allowDot: boolean = false,
    allowAngle: boolean = false
): number {
    let ordinal = 0;
    for (
        let leafId = range.start;
        leafId < range.end && leafId < leaves.length;
        leafId++
    ) {
        if (leafIdInAnyChild(leafId, directChildren)) {
            continue;
        }
        const leaf = leaves[leafId]!;
        if (leaf.channel !== "code") {
            continue;
        }
        const punctuationDot = allowDot && leaf.raw === ".";
        const structuralDelimiter =
            leaf.raw === "(" ||
            leaf.raw === ")" ||
            leaf.raw === "[" ||
            leaf.raw === "]" ||
            (allowAngle &&
                (leaf.raw === "<" ||
                    leaf.raw === ">" ||
                    leaf.raw === "<<" ||
                    leaf.raw === ">>"));
        if (!punctuationDot && !structuralDelimiter) {
            continue;
        }
        requireExactSyntaxMarker(
            markers,
            leafId,
            "delimiter",
            ordinal,
            punctuationDot ? "punctuation" : "delimiter",
            false,
            nodeId,
            label,
            failures
        );
        ordinal += 1;
    }
    return ordinal;
}

function requireExactMarkerCount(
    markers: readonly Record<string, unknown>[],
    expectedCount: number,
    nodeId: number,
    failures: InvariantFailure[]
): void {
    if (markers.length !== expectedCount) {
        fail(
            failures,
            "INV_RELATIONSHIP",
            `node ${nodeId} must have exact syntax marker closure: expected ${expectedCount}, got ${markers.length}`,
            nodeId
        );
    }
}

function validateRequiredMarkerClosure(
    raw: Record<string, unknown>,
    directChildren: readonly Record<string, unknown>[],
    markers: readonly Record<string, unknown>[],
    leaves: readonly SourceLeaf[],
    failures: InvariantFailure[],
    trustedCanonicalShape: boolean
): void {
    if (!isFiniteNonNegInt(raw.id)) {
        return;
    }
    const nodeId = raw.id;
    const nodeKind = raw.kind;
    let expectedMarkerCount = 0;
    switch (nodeKind) {
        case "program":
        case "clause":
        case "query":
        case "expression":
        case "case-branch":
        case "window-spec":
        case "type-expression":
        case "statement":
        case "relation":
        case "list":
        case "list-item":
        case "cte":
        case "opaque":
            break;
        default:
            return;
    }

    if (markers.length === 0) {
        if (
            nodeKind === "program" ||
            nodeKind === "list" ||
            nodeKind === "opaque" ||
            (nodeKind === "query" && raw.queryKind !== "parenthesized")
        ) {
            return;
        }
        if (nodeKind === "expression") {
            switch (raw.expressionKind) {
                case "identifier":
                case "wildcard":
                case "literal":
                case "parameter":
                case "binary":
                case "subquery":
                case "is":
                    return;
                case "unary":
                    if (
                        directChildren.length !== 1 ||
                        directChildren[0]?.kind !== "expression" ||
                        directChildren[0]?.expressionKind !== "frame-bound"
                    ) {
                        return;
                    }
                    break;
                case "between":
                    if (
                        directChildren.length !== 2 ||
                        !directChildren.every(
                            (child) =>
                                child.kind === "expression" &&
                                child.expressionKind === "frame-bound"
                        )
                    ) {
                        return;
                    }
                    break;
                case "cast": {
                    const operatorLeafIds = untrustedDataField(
                        raw,
                        "operatorLeafIds",
                        trustedCanonicalShape
                    );
                    if (
                        Array.isArray(operatorLeafIds) &&
                        operatorLeafIds.length > 0
                    ) {
                        return;
                    }
                    break;
                }
                case "in":
                    if (
                        directChildren.length === 2 &&
                        directChildren[1]?.kind === "expression" &&
                        directChildren[1]?.expressionKind === "subquery"
                    ) {
                        return;
                    }
                    break;
            }
        } else if (nodeKind === "relation") {
            const aliasValue = untrustedDataField(
                raw,
                "alias",
                trustedCanonicalShape
            );
            const keywordLeafId = isObject(aliasValue)
                ? untrustedDataField(
                      aliasValue,
                      "keywordLeafId",
                      trustedCanonicalShape
                  )
                : null;
            if (
                raw.relationKind !== "join" &&
                !isFiniteNonNegInt(keywordLeafId)
            ) {
                return;
            }
        } else if (nodeKind === "list-item") {
            const aliasValue = untrustedDataField(
                raw,
                "alias",
                trustedCanonicalShape
            );
            const keywordLeafId = isObject(aliasValue)
                ? untrustedDataField(
                      aliasValue,
                      "keywordLeafId",
                      trustedCanonicalShape
                  )
                : null;
            const modifierLeafIds = untrustedDataField(
                raw,
                "modifierLeafIds",
                trustedCanonicalShape
            );
            if (
                raw.itemRole !== "type-member" &&
                !isFiniteNonNegInt(keywordLeafId) &&
                Array.isArray(modifierLeafIds) &&
                modifierLeafIds.length === 0
            ) {
                return;
            }
        }
    }

    if (nodeKind === "program" || nodeKind === "list" || nodeKind === "opaque") {
        requireExactMarkerCount(markers, 0, nodeId, failures);
        return;
    }

    if (nodeKind === "query") {
        if (raw.queryKind === "parenthesized" && isLeafRange(raw.leafRange)) {
            expectedMarkerCount += requireDirectDelimiterMarkers(
                raw.leafRange,
                directChildren,
                leaves,
                markers,
                nodeId,
                "parenthesized query delimiter",
                failures
            );
        }
        requireExactMarkerCount(
            markers,
            expectedMarkerCount,
            nodeId,
            failures
        );
        return;
    }

    if (
        nodeKind === "clause" &&
        typeof raw.clauseKind === "string" &&
        isLeafRange(raw.headLeafRange)
    ) {
        const expectedSyntaxId = raw.clauseKind === "set-operation"
            ? "set-operator"
            : `clause:${raw.clauseKind}`;
        if (isSyntaxMarkerId(expectedSyntaxId)) {
            let ordinal = 0;
            for (
                let leafId = raw.headLeafRange.start;
                leafId < raw.headLeafRange.end && leafId < leaves.length;
                leafId++
            ) {
                const leaf = leaves[leafId]!;
                if (
                    leaf.channel !== "code" ||
                    !hasAsciiKeywordCaseShape(leaf.raw)
                ) {
                    continue;
                }
                requireExactSyntaxMarker(
                    markers,
                    leafId,
                    expectedSyntaxId,
                    ordinal,
                    "syntax-keyword",
                    true,
                    nodeId,
                    `${raw.clauseKind} clause head`,
                    failures
                );
                ordinal += 1;
                expectedMarkerCount += 1;
            }
        }
    }
    if (nodeKind === "clause") {
        if (isLeafRange(raw.headLeafRange)) {
            expectedMarkerCount += requireDirectDelimiterMarkers(
                raw.headLeafRange,
                directChildren,
                leaves,
                markers,
                nodeId,
                "clause head delimiter",
                failures
            );
        }
        requireExactMarkerCount(
            markers,
            expectedMarkerCount,
            nodeId,
            failures
        );
        return;
    }

    if (
        nodeKind === "expression" &&
        raw.expressionKind === "case" &&
        isLeafRange(raw.leafRange)
    ) {
        requireDirectKeywordSequence(
            raw.leafRange,
            directChildren,
            null,
            leaves,
            markers,
            ["case"],
            "case:start",
            nodeId,
            "CASE expression start",
            failures
        );
        expectedMarkerCount += 1;
        requireDirectKeywordSequence(
            raw.leafRange,
            directChildren,
            null,
            leaves,
            markers,
            ["end"],
            "case:end",
            nodeId,
            "CASE expression end",
            failures
        );
        expectedMarkerCount += 1;
    }

    if (nodeKind === "case-branch" && isLeafRange(raw.leafRange)) {
        if (raw.branchKind === "when") {
            requireDirectKeywordSequence(
                raw.leafRange,
                directChildren,
                null,
                leaves,
                markers,
                ["when"],
                "case:when",
                nodeId,
                "CASE WHEN branch",
                failures
            );
            expectedMarkerCount += 1;
            requireDirectKeywordSequence(
                raw.leafRange,
                directChildren,
                null,
                leaves,
                markers,
                ["then"],
                "case:then",
                nodeId,
                "CASE THEN branch",
                failures
            );
            expectedMarkerCount += 1;
        } else if (raw.branchKind === "else") {
            requireDirectKeywordSequence(
                raw.leafRange,
                directChildren,
                null,
                leaves,
                markers,
                ["else"],
                "case:else",
                nodeId,
                "CASE ELSE branch",
                failures
            );
            expectedMarkerCount += 1;
        }
    }
    if (nodeKind === "case-branch") {
        requireExactMarkerCount(
            markers,
            expectedMarkerCount,
            nodeId,
            failures
        );
        return;
    }

    if (
        nodeKind === "expression" &&
        raw.expressionKind === "window" &&
        isLeafRange(raw.leafRange)
    ) {
        requireDirectKeywordSequence(
            raw.leafRange,
            directChildren,
            null,
            leaves,
            markers,
            ["over"],
            "window:over",
            nodeId,
            "window expression OVER",
            failures
        );
        expectedMarkerCount += 1;
    }

    if (nodeKind === "window-spec" && isLeafRange(raw.leafRange)) {
        const nameRange = isLeafRange(raw.nameLeafRange)
            ? raw.nameLeafRange
            : null;
        const partitionChild = directChildById(
            directChildren,
            untrustedDataField(raw, "partitionChildId", trustedCanonicalShape)
        );
        const orderChild = directChildById(
            directChildren,
            untrustedDataField(raw, "orderChildId", trustedCanonicalShape)
        );
        if (partitionChild !== null && isLeafRange(partitionChild.leafRange)) {
            requireDirectKeywordSequence(
                {
                    start: raw.leafRange.start,
                    end: partitionChild.leafRange.start,
                },
                directChildren,
                nameRange,
                leaves,
                markers,
                ["partition", "by"],
                "window:partition-by",
                nodeId,
                "window PARTITION BY head",
                failures
            );
            expectedMarkerCount += 2;
        }
        if (orderChild !== null && isLeafRange(orderChild.leafRange)) {
            const orderHeadStart =
                partitionChild !== null && isLeafRange(partitionChild.leafRange)
                    ? partitionChild.leafRange.end
                    : raw.leafRange.start;
            requireDirectKeywordSequence(
                {
                    start: orderHeadStart,
                    end: orderChild.leafRange.start,
                },
                directChildren,
                nameRange,
                leaves,
                markers,
                ["order", "by"],
                "window:order-by",
                nodeId,
                "window ORDER BY head",
                failures
            );
            expectedMarkerCount += 2;
        }
        let hasDirectAs = false;
        for (
            let leafId = raw.leafRange.start;
            leafId < raw.leafRange.end && leafId < leaves.length;
            leafId++
        ) {
            if (
                leafIdInAnyChild(leafId, directChildren) ||
                (nameRange !== null && leafIdInRange(leafId, nameRange))
            ) {
                continue;
            }
            const leaf = leaves[leafId]!;
            if (leaf.channel === "code" && leaf.raw.toLowerCase() === "as") {
                requireExactSyntaxMarker(
                    markers,
                    leafId,
                    "alias-as",
                    0,
                    "syntax-keyword",
                    true,
                    nodeId,
                    "named window declaration AS",
                    failures
                );
                hasDirectAs = true;
                expectedMarkerCount += 1;
            }
        }
        if (nameRange !== null && directChildren.length > 0 && !hasDirectAs) {
            fail(
                failures,
                "INV_RELATIONSHIP",
                `named window declaration ${nodeId} must contain a direct AS leaf`,
                nodeId
            );
        }
    }
    if (nodeKind === "window-spec") {
        if (isLeafRange(raw.leafRange)) {
            expectedMarkerCount += requireDirectDelimiterMarkers(
                raw.leafRange,
                directChildren,
                leaves,
                markers,
                nodeId,
                "window specification delimiter",
                failures
            );
        }
        requireExactMarkerCount(
            markers,
            expectedMarkerCount,
            nodeId,
            failures
        );
        return;
    }

    const windowFrame =
        nodeKind === "expression" &&
        ((raw.expressionKind === "between" &&
            directChildren.length === 2 &&
            directChildren.every(
                (child) =>
                    child.kind === "expression" &&
                    child.expressionKind === "frame-bound"
            )) ||
            (raw.expressionKind === "unary" &&
                directChildren.length === 1 &&
                directChildren[0]?.kind === "expression" &&
                directChildren[0]?.expressionKind === "frame-bound"));
    if (windowFrame && isLeafRange(raw.leafRange)) {
        let unitCount = 0;
        let betweenCount = 0;
        let andCount = 0;
        for (
            let leafId = raw.leafRange.start;
            leafId < raw.leafRange.end && leafId < leaves.length;
            leafId++
        ) {
            if (leafIdInAnyChild(leafId, directChildren)) {
                continue;
            }
            const leaf = leaves[leafId]!;
            if (leaf.channel !== "code") {
                continue;
            }
            const word = leaf.raw.toLowerCase();
            const unitSyntaxId = word === "rows"
                ? "window:rows"
                : word === "range"
                  ? "window:range"
                  : word === "groups"
                    ? "window:groups"
                    : null;
            if (unitSyntaxId !== null) {
                requireExactSyntaxMarker(
                    markers,
                    leafId,
                    unitSyntaxId,
                    unitCount,
                    "syntax-keyword",
                    true,
                    nodeId,
                    "window frame unit",
                    failures
                );
                unitCount += 1;
            } else if (word === "between") {
                requireExactSyntaxMarker(
                    markers,
                    leafId,
                    "window:between",
                    betweenCount,
                    "syntax-keyword",
                    true,
                    nodeId,
                    "window frame BETWEEN",
                    failures
                );
                betweenCount += 1;
            } else if (word === "and") {
                requireExactSyntaxMarker(
                    markers,
                    leafId,
                    "window:and",
                    andCount,
                    "syntax-keyword",
                    true,
                    nodeId,
                    "window frame AND",
                    failures
                );
                andCount += 1;
            }
        }
        if (
            unitCount !== 1 ||
            (raw.expressionKind === "between" &&
                (betweenCount !== 1 || andCount !== 1))
        ) {
            fail(
                failures,
                "INV_RELATIONSHIP",
                `window frame expression ${nodeId} has incomplete direct grammar markers`,
                nodeId
            );
        }
        expectedMarkerCount += unitCount + betweenCount + andCount;
    }

    if (
        nodeKind === "expression" &&
        raw.expressionKind === "frame-bound" &&
        isLeafRange(raw.leafRange)
    ) {
        let recognizedWordCount = 0;
        let currentRowOrdinal = 0;
        for (
            let leafId = raw.leafRange.start;
            leafId < raw.leafRange.end && leafId < leaves.length;
            leafId++
        ) {
            if (leafIdInAnyChild(leafId, directChildren)) {
                continue;
            }
            const leaf = leaves[leafId]!;
            if (leaf.channel !== "code") {
                continue;
            }
            const word = leaf.raw.toLowerCase();
            let syntaxId: SyntaxMarkerId | null = null;
            let ordinal = 0;
            if (word === "current" || word === "row") {
                syntaxId = "window:current-row";
                ordinal = currentRowOrdinal;
                currentRowOrdinal += 1;
            } else if (word === "unbounded") {
                syntaxId = "window:unbounded";
            } else if (word === "preceding") {
                syntaxId = "window:preceding";
            } else if (word === "following") {
                syntaxId = "window:following";
            }
            if (syntaxId !== null) {
                requireExactSyntaxMarker(
                    markers,
                    leafId,
                    syntaxId,
                    ordinal,
                    "syntax-keyword",
                    true,
                    nodeId,
                    "window frame bound",
                    failures
                );
                recognizedWordCount += 1;
            }
        }
        if (recognizedWordCount === 0) {
            fail(
                failures,
                "INV_RELATIONSHIP",
                `window frame-bound expression ${nodeId} has no direct bound keyword marker`,
                nodeId
            );
        }
        expectedMarkerCount += recognizedWordCount;
    }
    if (nodeKind === "expression") {
        if (isLeafRange(raw.leafRange)) {
            const expressionKind = raw.expressionKind;
            if (
                expressionKind === "qualified-identifier" ||
                expressionKind === "function-call" ||
                expressionKind === "collection" ||
                expressionKind === "parenthesized" ||
                expressionKind === "cast" ||
                expressionKind === "in"
            ) {
                expectedMarkerCount += requireDirectDelimiterMarkers(
                    raw.leafRange,
                    directChildren,
                    leaves,
                    markers,
                    nodeId,
                    "expression delimiter",
                    failures,
                    expressionKind === "qualified-identifier"
                );
            }
            if (expressionKind === "cast") {
                let castCount = 0;
                let asCount = 0;
                for (
                    let leafId = raw.leafRange.start;
                    leafId < raw.leafRange.end && leafId < leaves.length;
                    leafId++
                ) {
                    if (leafIdInAnyChild(leafId, directChildren)) {
                        continue;
                    }
                    const leaf = leaves[leafId]!;
                    if (leaf.channel !== "code") {
                        continue;
                    }
                    const word = leaf.raw.toLowerCase();
                    if (word === "cast") {
                        requireExactSyntaxMarker(
                            markers,
                            leafId,
                            "type:cast",
                            castCount,
                            "syntax-keyword",
                            true,
                            nodeId,
                            "CAST expression head",
                            failures
                        );
                        castCount += 1;
                    } else if (word === "as") {
                        requireExactSyntaxMarker(
                            markers,
                            leafId,
                            "type:as",
                            asCount,
                            "syntax-keyword",
                            true,
                            nodeId,
                            "CAST expression AS",
                            failures
                        );
                        asCount += 1;
                    }
                }
                if (castCount !== asCount || castCount > 1) {
                    fail(
                        failures,
                        "INV_RELATIONSHIP",
                        `cast expression ${nodeId} has inconsistent direct CAST/AS grammar`,
                        nodeId
                    );
                }
                expectedMarkerCount += castCount + asCount;
            } else if (expressionKind === "typed-literal") {
                let typeNameCount = 0;
                for (
                    let leafId = raw.leafRange.start;
                    leafId < raw.leafRange.end && leafId < leaves.length;
                    leafId++
                ) {
                    if (leafIdInAnyChild(leafId, directChildren)) {
                        continue;
                    }
                    const leaf = leaves[leafId]!;
                    if (leaf.channel !== "code" || !isBuiltinTypeName(leaf.raw)) {
                        continue;
                    }
                    requireExactSyntaxMarker(
                        markers,
                        leafId,
                        "type:name",
                        typeNameCount,
                        "builtin-type-keyword",
                        true,
                        nodeId,
                        "typed literal type name",
                        failures
                    );
                    typeNameCount += 1;
                }
                if (typeNameCount !== 1) {
                    fail(
                        failures,
                        "INV_RELATIONSHIP",
                        `typed-literal expression ${nodeId} must contain one direct builtin type name`,
                        nodeId
                    );
                }
                expectedMarkerCount += typeNameCount;
            }
            if (expressionKind === "exists") {
                let existsCount = 0;
                for (
                    let leafId = raw.leafRange.start;
                    leafId < raw.leafRange.end && leafId < leaves.length;
                    leafId++
                ) {
                    if (leafIdInAnyChild(leafId, directChildren)) {
                        continue;
                    }
                    const leaf = leaves[leafId]!;
                    if (
                        leaf.channel !== "code" ||
                        leaf.raw.toLowerCase() !== "exists"
                    ) {
                        continue;
                    }
                    requireExactSyntaxMarker(
                        markers,
                        leafId,
                        "operator",
                        existsCount,
                        "word-operator-keyword",
                        true,
                        nodeId,
                        "EXISTS operator",
                        failures
                    );
                    existsCount += 1;
                }
                if (existsCount !== 1) {
                    fail(
                        failures,
                        "INV_RELATIONSHIP",
                        `EXISTS expression ${nodeId} must contain one direct operator marker`,
                        nodeId
                    );
                }
                expectedMarkerCount += existsCount;
            } else if (
                expressionKind === "function-call" ||
                expressionKind === "collection"
            ) {
                let modifierCount = 0;
                for (
                    let leafId = raw.leafRange.start;
                    leafId < raw.leafRange.end && leafId < leaves.length;
                    leafId++
                ) {
                    if (leafIdInAnyChild(leafId, directChildren)) {
                        continue;
                    }
                    const leaf = leaves[leafId]!;
                    if (
                        leaf.channel !== "code" ||
                        leaf.raw.toLowerCase() !== "distinct"
                    ) {
                        continue;
                    }
                    requireExactSyntaxMarker(
                        markers,
                        leafId,
                        "operator",
                        modifierCount,
                        "syntax-keyword",
                        true,
                        nodeId,
                        "function DISTINCT modifier",
                        failures
                    );
                    modifierCount += 1;
                }
                expectedMarkerCount += modifierCount;
            }
        }
        requireExactMarkerCount(
            markers,
            expectedMarkerCount,
            nodeId,
            failures
        );
        return;
    }

    if (nodeKind === "type-expression" && isLeafRange(raw.typeNameLeafRange)) {
        let ordinal = 0;
        for (
            let leafId = raw.typeNameLeafRange.start;
            leafId < raw.typeNameLeafRange.end && leafId < leaves.length;
            leafId++
        ) {
            const leaf = leaves[leafId]!;
            if (leaf.channel !== "code") {
                continue;
            }
            const builtin = isBuiltinTypeName(leaf.raw);
            requireExactSyntaxMarker(
                markers,
                leafId,
                "type:name",
                ordinal,
                builtin ? "builtin-type-keyword" : "user-type-name",
                builtin,
                nodeId,
                "code type name",
                failures
            );
            ordinal += 1;
            expectedMarkerCount += 1;
        }
    }
    if (nodeKind === "type-expression") {
        if (isLeafRange(raw.leafRange)) {
            expectedMarkerCount += requireDirectDelimiterMarkers(
                raw.leafRange,
                directChildren,
                leaves,
                markers,
                nodeId,
                "type expression delimiter",
                failures,
                false,
                true
            );
        }
        requireExactMarkerCount(
            markers,
            expectedMarkerCount,
            nodeId,
            failures
        );
        return;
    }

    if (nodeKind === "statement" && isLeafRange(raw.leafRange)) {
        let ordinal = 0;
        for (
            let leafId = raw.leafRange.start;
            leafId < raw.leafRange.end && leafId < leaves.length;
            leafId++
        ) {
            const leaf = leaves[leafId]!;
            if (
                leaf.channel !== "code" ||
                leaf.raw !== ";" ||
                leafIdInAnyChild(leafId, directChildren)
            ) {
                continue;
            }
            requireExactSyntaxMarker(
                markers,
                leafId,
                "statement-terminator",
                ordinal,
                "punctuation",
                false,
                nodeId,
                "direct statement terminator",
                failures
            );
            ordinal += 1;
            expectedMarkerCount += 1;
        }
    }
    if (nodeKind === "statement") {
        requireExactMarkerCount(
            markers,
            expectedMarkerCount,
            nodeId,
            failures
        );
        return;
    }

    if (nodeKind === "relation" || nodeKind === "list-item") {
        const aliasValue = untrustedDataField(
            raw,
            "alias",
            trustedCanonicalShape
        );
        if (isObject(aliasValue)) {
            const keywordLeafId = untrustedDataField(
                aliasValue,
                "keywordLeafId",
                trustedCanonicalShape
            );
            if (isFiniteNonNegInt(keywordLeafId)) {
                requireExactSyntaxMarker(
                    markers,
                    keywordLeafId,
                    "alias-as",
                    0,
                    "syntax-keyword",
                    true,
                    nodeId,
                    "explicit alias AS",
                    failures
                );
                expectedMarkerCount += 1;
            }
        }
    }

    if (nodeKind === "cte" && isLeafRange(raw.nameLeafRange)) {
        const queryChild = directChildById(
            directChildren,
            untrustedDataField(raw, "queryChildId", trustedCanonicalShape)
        );
        const columnListChild = directChildById(
            directChildren,
            untrustedDataField(raw, "columnListChildId", trustedCanonicalShape)
        );
        if (queryChild !== null && isLeafRange(queryChild.leafRange)) {
            const start = columnListChild !== null && isLeafRange(columnListChild.leafRange)
                ? columnListChild.leafRange.end
                : raw.nameLeafRange.end;
            let ordinal = 0;
            for (
                let leafId = start;
                leafId < queryChild.leafRange.start && leafId < leaves.length;
                leafId++
            ) {
                const leaf = leaves[leafId]!;
                if (leaf.channel !== "code" || leaf.raw.toLowerCase() !== "as") {
                    continue;
                }
                requireExactSyntaxMarker(
                    markers,
                    leafId,
                    "cte-as",
                    ordinal,
                    "syntax-keyword",
                    true,
                    nodeId,
                    "CTE AS",
                    failures
                );
                ordinal += 1;
                expectedMarkerCount += 1;
            }
            if (ordinal === 0) {
                fail(
                    failures,
                    "INV_RELATIONSHIP",
                    `CTE ${nodeId} must contain a direct AS leaf before its query child`,
                    nodeId
                );
            }
        }
    }
    if (nodeKind === "cte") {
        requireExactMarkerCount(
            markers,
            expectedMarkerCount,
            nodeId,
            failures
        );
        return;
    }

    if (nodeKind === "relation" && raw.relationKind === "join") {
        const rightRelation = directChildById(
            directChildren,
            untrustedDataField(raw, "bodyChildId", trustedCanonicalShape)
        );
        if (isLeafRange(raw.leafRange) && rightRelation !== null && isLeafRange(rightRelation.leafRange)) {
            let ordinal = 0;
            for (
                let leafId = raw.leafRange.start;
                leafId < rightRelation.leafRange.start && leafId < leaves.length;
                leafId++
            ) {
                const leaf = leaves[leafId]!;
                if (
                    leaf.channel !== "code" ||
                    !hasAsciiKeywordCaseShape(leaf.raw)
                ) {
                    continue;
                }
                requireExactSyntaxMarker(
                    markers,
                    leafId,
                    "join-head",
                    ordinal,
                    "syntax-keyword",
                    true,
                    nodeId,
                    "JOIN head",
                    failures
                );
                ordinal += 1;
                expectedMarkerCount += 1;
            }
            if (ordinal === 0) {
                fail(
                    failures,
                    "INV_RELATIONSHIP",
                    `join relation ${nodeId} must contain a direct keyword head`,
                    nodeId
                );
            }
        }
    }
    if (nodeKind === "relation") {
        requireExactMarkerCount(
            markers,
            expectedMarkerCount,
            nodeId,
            failures
        );
        return;
    }

    if (nodeKind === "list-item") {
        const modifierLeafIds = untrustedDataField(
            raw,
            "modifierLeafIds",
            trustedCanonicalShape
        );
        if (Array.isArray(modifierLeafIds)) {
            for (
                let ordinal = 0;
                ordinal < modifierLeafIds.length;
                ordinal++
            ) {
                const leafId = modifierLeafIds[ordinal];
                if (!isFiniteNonNegInt(leafId)) {
                    continue;
                }
                requireExactSyntaxMarker(
                    markers,
                    leafId,
                    "operator",
                    ordinal,
                    "syntax-keyword",
                    true,
                    nodeId,
                    "list-item modifier",
                    failures
                );
                expectedMarkerCount += 1;
            }
        }
    }

    if (nodeKind === "list-item" && raw.itemRole === "type-member") {
        const aliasValue = untrustedDataField(
            raw,
            "alias",
            trustedCanonicalShape
        );
        const valueChild = directChildById(
            directChildren,
            untrustedDataField(raw, "valueChildId", trustedCanonicalShape)
        );
        if (isObject(aliasValue) && valueChild !== null && isLeafRange(valueChild.leafRange)) {
            const nameLeafRange = untrustedDataField(
                aliasValue,
                "nameLeafRange",
                trustedCanonicalShape
            );
            if (isLeafRange(nameLeafRange)) {
                let ordinal = 0;
                for (
                    let leafId = nameLeafRange.end;
                    leafId < valueChild.leafRange.start && leafId < leaves.length;
                    leafId++
                ) {
                    const leaf = leaves[leafId]!;
                    if (leaf.channel !== "code" || leaf.raw !== ":") {
                        continue;
                    }
                    requireExactSyntaxMarker(
                        markers,
                        leafId,
                        "type:member-colon",
                        ordinal,
                        "punctuation",
                        false,
                        nodeId,
                        "STRUCT member colon",
                        failures
                    );
                    ordinal += 1;
                    expectedMarkerCount += 1;
                }
                if (ordinal === 0) {
                    fail(
                        failures,
                        "INV_RELATIONSHIP",
                        `type-member list item ${nodeId} must contain a direct colon leaf`,
                        nodeId
                    );
                }
            }
        }
    }
    requireExactMarkerCount(
        markers,
        expectedMarkerCount,
        nodeId,
        failures
    );
}

function validateTableRelationClaimCoverage(
    raw: Record<string, unknown>,
    nodeId: number,
    nameClaims: readonly NameRangeClaim[],
    markers: readonly Record<string, unknown>[],
    leaves: readonly SourceLeaf[],
    failures: InvariantFailure[]
): void {
    if (
        raw.kind !== "relation" ||
        raw.relationKind !== "table" ||
        !isLeafRange(raw.leafRange)
    ) {
        return;
    }
    const aliasKeywordLeafId =
        isObject(raw.alias) && isFiniteNonNegInt(raw.alias.keywordLeafId)
            ? raw.alias.keywordLeafId
            : null;
    for (let leafId = raw.leafRange.start; leafId < raw.leafRange.end; leafId++) {
        const leaf = leaves[leafId];
        if (leaf === undefined || !isSyntaxChannel(leaf.channel)) {
            continue;
        }
        const claimedByName = nameClaims.some((claim) => leafIdInRange(leafId, claim.range));
        if (
            !claimedByName &&
            markerAtLeaf(markers, leafId) === null &&
            aliasKeywordLeafId !== leafId
        ) {
            fail(
                failures,
                "INV_OWNER_REFERENCE",
                `table relation ${nodeId} has unclaimed syntax leaf ${leafId} outside its complete name/alias facts`,
                nodeId
            );
        }
    }
}

export function validateContextualNodeFacts(
    raw: Record<string, unknown>,
    directChildren: readonly Record<string, unknown>[],
    leaves: readonly SourceLeaf[],
    failures: InvariantFailure[],
    dialectContext: CstDialectInvariantContext,
    trustedCanonicalShape: boolean
): void {
    if (!isFiniteNonNegInt(raw.id) || typeof raw.kind !== "string") {
        return;
    }
    const nodeId = raw.id;
    const nodeKind = raw.kind;
    const ownerRange = isLeafRange(raw.leafRange) ? raw.leafRange : null;
    const capabilityId = trustedCanonicalShape
        ? raw.capabilityId
        : readRequiredDataField(
              raw,
              "capabilityId",
              nodeId,
              failures,
              false
          );
    const formatRole = trustedCanonicalShape
        ? raw.formatRole
        : readRequiredDataField(
              raw,
              "formatRole",
              nodeId,
              failures,
              false
          );
    if (
        capabilityId !== MISSING_DATA_FIELD &&
        formatRole !== MISSING_DATA_FIELD
    ) {
        validateRoleCapabilityAllowlist(
            raw,
            directChildren,
            leaves,
            nodeId,
            formatRole,
            capabilityId,
            failures,
            dialectContext
        );
    }
    const ownsNameClaims =
        nodeKind === "cte" ||
        nodeKind === "relation" ||
        nodeKind === "window-spec" ||
        nodeKind === "type-expression" ||
        nodeKind === "list-item";
    const nameClaims = ownsNameClaims
        ? collectNameRangeClaims(
              raw,
              nodeId,
              ownerRange,
              directChildren,
              leaves,
              failures,
              trustedCanonicalShape
          )
        : EMPTY_NAME_RANGE_CLAIMS;
    const ownsSeparators = nodeKind === "clause" || nodeKind === "list";
    const hasNoCanonicalSeparators =
        trustedCanonicalShape &&
        ownsSeparators &&
        Array.isArray(raw.separatorLeafIds) &&
        raw.separatorLeafIds.length === 0;
    const separatorLeafIds = ownsSeparators && !hasNoCanonicalSeparators
        ? validateSeparatorLeafIds(
              raw,
              nodeId,
              ownerRange,
              directChildren,
              nameClaims,
              leaves,
              failures,
              trustedCanonicalShape
          )
        : EMPTY_LEAF_IDS;
    const hasNoCanonicalOperators =
        trustedCanonicalShape &&
        nodeKind === "expression" &&
        Array.isArray(raw.operatorLeafIds) &&
        raw.operatorLeafIds.length === 0 &&
        Array.isArray(raw.operatorOccurrences) &&
        raw.operatorOccurrences.length === 0;
    const operatorLeafIds =
        nodeKind === "expression" && !hasNoCanonicalOperators
        ? validateCanonicalOperatorOccurrences(
              raw,
              nodeId,
              ownerRange,
              leaves,
              failures,
              trustedCanonicalShape,
              dialectContext
          )
        : EMPTY_LEAF_IDS;
    const markers = trustedCanonicalShape
        ? (raw.syntaxMarkers as readonly Record<string, unknown>[])
        : validateSyntaxMarkers(
              raw,
              nodeId,
              ownerRange,
              directChildren,
              nameClaims,
              separatorLeafIds,
              operatorLeafIds,
              leaves,
              failures,
              false
          );
    validateRequiredMarkerClosure(
        raw,
        directChildren,
        markers,
        leaves,
        failures,
        trustedCanonicalShape
    );
    if (nodeKind === "relation" && raw.relationKind === "table") {
        validateTableRelationClaimCoverage(
            raw,
            nodeId,
            nameClaims,
            markers,
            leaves,
            failures
        );
    }
}
