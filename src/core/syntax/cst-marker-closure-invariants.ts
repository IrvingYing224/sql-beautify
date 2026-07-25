import type { SourceLeaf } from "../lexer/token";
import type {
    ContextualFactClaims,
    ContextualInvariantContext,
    NameRangeClaim,
} from "./cst-contextual-invariant-context";
import {
    MISSING_DATA_FIELD,
    hasExactFrozenDataShape,
    isStableFrozenDataArray,
    leafIdInAnyChild,
    leafIdInRange,
    readRequiredDataField,
} from "./cst-contextual-invariant-support";
import {
    hasAsciiKeywordCaseShape,
    isBuiltinTypeName,
    isGrammarKeywordMarkerId,
    isKeywordCaseRole,
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
    SyntaxLeafRole,
    SyntaxMarkerId,
} from "./node";

const EMPTY_VALIDATED_MARKERS: readonly Record<string, unknown>[] = Object.freeze([]);
const MARKER_BY_LEAF_INDEX = new WeakMap<
    object,
    ReadonlyMap<number, Record<string, unknown>>
>();
const SMALL_MARKER_SCAN_LIMIT = 8;

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
    context: ContextualInvariantContext,
    facts: ContextualFactClaims,
    trustedCanonicalShape: boolean
): readonly Record<string, unknown>[] {
    const {
        raw,
        nodeId,
        ownerRange,
        directChildren,
        leaves,
        failures,
    } = context;
    const {
        nameClaims,
        separatorLeafIds,
        operatorLeafIds,
    } = facts;
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
                raw.relationKind !== "lateral-view" &&
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
    if (
        nodeKind === "relation" &&
        raw.relationKind === "lateral-view" &&
        isLeafRange(raw.leafRange)
    ) {
        let ordinal = 0;
        for (
            let leafId = raw.leafRange.start;
            leafId < raw.leafRange.end && leafId < leaves.length;
            leafId++
        ) {
            if (leafIdInAnyChild(leafId, directChildren)) {
                continue;
            }
            const leaf = leaves[leafId]!;
            if (leaf.channel !== "code" || leaf.raw.toLowerCase() !== "as") {
                continue;
            }
            requireExactSyntaxMarker(
                markers,
                leafId,
                "lateral-view-output-as",
                ordinal,
                "syntax-keyword",
                true,
                nodeId,
                "LATERAL VIEW output AS",
                failures
            );
            ordinal += 1;
            expectedMarkerCount += 1;
        }
        if (ordinal !== 1) {
            fail(
                failures,
                "INV_RELATIONSHIP",
                `lateral-view relation ${nodeId} must contain one direct output AS marker`,
                nodeId
            );
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

export function validateExactMarkerClosure(
    context: ContextualInvariantContext,
    facts: ContextualFactClaims
): void {
    const {
        raw,
        directChildren,
        leaves,
        failures,
        trustedCanonicalShape,
    } = context;
    const markers = trustedCanonicalShape
        ? (raw.syntaxMarkers as readonly Record<string, unknown>[])
        : validateSyntaxMarkers(context, facts, false);
    validateRequiredMarkerClosure(
        raw,
        directChildren,
        markers,
        leaves,
        failures,
        trustedCanonicalShape
    );
    if (context.nodeKind === "relation" && raw.relationKind === "table") {
        validateTableRelationClaimCoverage(
            raw,
            context.nodeId,
            facts.nameClaims,
            markers,
            leaves,
            failures
        );
    }
}
