import type { OperatorSemantics } from "../dialects/types";
import type { SourceLeaf } from "../lexer/token";
import type { CstDialectInvariantContext } from "./cst-dialect-context";
import type {
    ContextualFactClaims,
    ContextualInvariantContext,
    NameRangeClaim,
} from "./cst-contextual-invariant-context";
import {
    isOperatorFixity,
    isOperatorFormatClass,
} from "./contextual-fact-contract";
import {
    MISSING_DATA_FIELD,
    hasExactFrozenDataShape,
    isStableFrozenDataArray,
    isStableFrozenRange,
    leafIdInAnyChild,
    leafIdInRange,
    rangeOverlapsAnyChild,
    rangeOverlapsRange,
    readRequiredDataField,
    validateSubRange,
} from "./cst-contextual-invariant-support";
import {
    fail,
    isFiniteNonNegInt,
    isLeafRange,
    isObject,
    isSyntaxChannel,
} from "./invariant-shared";
import type { InvariantFailure } from "./invariant-types";
import type { LeafRange } from "./leaf-range";

const EMPTY_NAME_RANGE_CLAIMS: readonly NameRangeClaim[] = Object.freeze([]);
const EMPTY_LEAF_IDS: readonly number[] = Object.freeze([]);
const EMPTY_CONTEXTUAL_FACT_CLAIMS: ContextualFactClaims = Object.freeze({
    nameClaims: EMPTY_NAME_RANGE_CLAIMS,
    separatorLeafIds: EMPTY_LEAF_IDS,
    operatorLeafIds: EMPTY_LEAF_IDS,
});

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

export function validateContextualFactShape(
    context: ContextualInvariantContext
): ContextualFactClaims {
    const {
        raw,
        directChildren,
        leaves,
        failures,
        trustedCanonicalShape,
        nodeId,
        nodeKind,
        ownerRange,
        dialectContext,
    } = context;
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
    if (
        nameClaims.length === 0 &&
        separatorLeafIds.length === 0 &&
        operatorLeafIds.length === 0
    ) {
        return EMPTY_CONTEXTUAL_FACT_CLAIMS;
    }
    return {
        nameClaims,
        separatorLeafIds,
        operatorLeafIds,
    };
}
