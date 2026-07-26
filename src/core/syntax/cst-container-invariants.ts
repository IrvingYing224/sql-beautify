import { isProxy } from "node:util/types";
import type { SourceLeaf } from "../lexer/token";
import type { CstDialectInvariantContext } from "./cst-dialect-context";
import type { InvariantFailure } from "./invariant-types";
import { listItemRoleFor } from "./list-role-contract";
import type { ListRole } from "./node";
import {
    fail,
    isDenseArray,
    isFiniteNonNegInt,
    isLeafRange,
    isObject,
} from "./invariant-shared";

const EMPTY_VALUES: readonly unknown[] = Object.freeze([]);

function readNodeArray(
    raw: Record<string, unknown>,
    field: string,
    trustedCanonicalShape: boolean
): readonly unknown[] {
    const value = trustedCanonicalShape
        ? raw[field]
        : Object.getOwnPropertyDescriptor(raw, field)?.value;
    if (trustedCanonicalShape) {
        return Array.isArray(value) ? value : EMPTY_VALUES;
    }
    if (
        (typeof value === "object" && value !== null && isProxy(value)) ||
        !isDenseArray(value)
    ) {
        return EMPTY_VALUES;
    }
    return value;
}

function failRelationship(
    failures: InvariantFailure[],
    raw: Record<string, unknown>,
    message: string
): void {
    fail(
        failures,
        "INV_RELATIONSHIP",
        message,
        isFiniteNonNegInt(raw.id) ? raw.id : undefined
    );
}

const INSERT_OVERWRITE_CAPABILITY = "insert-overwrite-partition-select";
const INSERT_INTO_CAPABILITY = "insert-into-partition-select";

function insertCapabilityFromHead(
    insertClause: Record<string, unknown>,
    leaves: readonly SourceLeaf[]
): string | null {
    if (!isLeafRange(insertClause.headLeafRange)) {
        return null;
    }
    const words: string[] = [];
    for (
        let leafId = insertClause.headLeafRange.start;
        leafId < insertClause.headLeafRange.end && leafId < leaves.length;
        leafId++
    ) {
        const leaf = leaves[leafId]!;
        if (leaf.channel !== "code" && leaf.channel !== "protected") {
            continue;
        }
        if (leaf.channel !== "code" || !/^[A-Za-z]+$/.test(leaf.raw)) {
            return null;
        }
        words.push(leaf.raw.toLowerCase());
    }
    if (words.length === 3 && words.join(" ") === "insert overwrite table") {
        return INSERT_OVERWRITE_CAPABILITY;
    }
    if (
        (words.length === 2 && words.join(" ") === "insert into") ||
        (words.length === 3 && words.join(" ") === "insert into table")
    ) {
        return INSERT_INTO_CAPABILITY;
    }
    return null;
}

function querySourceBeginsWithInsert(
    query: Record<string, unknown>,
    trustedCanonicalShape: boolean
): boolean {
    const children = readNodeArray(
        query,
        "children",
        trustedCanonicalShape
    );
    const first = children[0];
    if (!isObject(first) || first.kind !== "clause") {
        return false;
    }
    if (first.clauseKind === "insert") {
        return true;
    }
    if (first.clauseKind !== "with") {
        return false;
    }
    const main = children[1];
    return isObject(main) &&
        main.kind === "query" &&
        querySourceBeginsWithInsert(main, trustedCanonicalShape);
}

function validateQueryRelationships(
    raw: Record<string, unknown>,
    directChildren: readonly Record<string, unknown>[],
    leaves: readonly SourceLeaf[],
    failures: InvariantFailure[],
    dialectContext: CstDialectInvariantContext,
    trustedCanonicalShape: boolean
): void {
    if (raw.kind !== "query" || typeof raw.queryKind !== "string") {
        return;
    }
    const first = directChildren[0];
    const operatorIds = readNodeArray(
        raw,
        "setOperatorLeafIds",
        trustedCanonicalShape
    );

    if (first?.kind === "clause" && first.clauseKind === "with") {
        const main = directChildren[1];
        if (
            directChildren.length !== 2 ||
            main?.kind !== "query" ||
            operatorIds.length !== 0
        ) {
            failRelationship(
                failures,
                raw,
                `WITH query ${String(raw.id)} must contain exactly a WITH clause and one query child`
            );
        } else if (main.queryKind !== raw.queryKind) {
            failRelationship(
                failures,
                raw,
                `WITH query ${String(raw.id)} kind must match its main query child`
            );
        }
        if (raw.capabilityId !== "with-cte" || raw.formatRole !== "capability") {
            failRelationship(
                failures,
                raw,
                `WITH query ${String(raw.id)} must use with-cte capability authority`
            );
        }
        return;
    }

    if (first?.kind === "clause" && first.clauseKind === "insert") {
        const hasPartition =
            directChildren.length === 3 &&
            directChildren[1]?.kind === "clause" &&
            directChildren[1]?.clauseKind === "partition";
        const query = directChildren[hasPartition ? 2 : 1];
        if (
            raw.queryKind !== "select" ||
            operatorIds.length !== 0 ||
            (directChildren.length !== 2 && !hasPartition) ||
            query?.kind !== "query" ||
            (query !== undefined &&
                querySourceBeginsWithInsert(query, trustedCanonicalShape))
        ) {
            failRelationship(
                failures,
                raw,
                `INSERT query ${String(raw.id)} must contain INSERT, optional PARTITION, and one query child`
            );
        }
        const expectedCapability = insertCapabilityFromHead(first, leaves);
        const partition = hasPartition ? directChildren[1] : null;
        if (
            expectedCapability === null ||
            raw.capabilityId !== expectedCapability ||
            first.capabilityId !== expectedCapability ||
            (partition !== null &&
                partition !== undefined &&
                partition.capabilityId !== expectedCapability) ||
            raw.formatRole !== "capability"
        ) {
            failRelationship(
                failures,
                raw,
                `INSERT query ${String(raw.id)} must use the capability proved by its exact head`
            );
        }
        return;
    }

    if (raw.queryKind === "parenthesized") {
        if (
            directChildren.length !== 1 ||
            directChildren[0]?.kind !== "query" ||
            operatorIds.length !== 0
        ) {
            failRelationship(
                failures,
                raw,
                `parenthesized query ${String(raw.id)} must contain exactly one query child`
            );
        }
        if (raw.capabilityId !== "subquery" || raw.formatRole !== "capability") {
            failRelationship(
                failures,
                raw,
                `parenthesized query ${String(raw.id)} must use subquery capability authority`
            );
        }
        return;
    }

    if (raw.queryKind === "set") {
        let coreLength = directChildren.length;
        while (
            coreLength > 0 &&
            directChildren[coreLength - 1]?.kind === "clause" &&
            (directChildren[coreLength - 1]?.clauseKind === "order-by" ||
                directChildren[coreLength - 1]?.clauseKind === "limit")
        ) {
            coreLength -= 1;
        }
        const tail = directChildren.slice(coreLength);
        let previousTailOrder = Number.NEGATIVE_INFINITY;
        for (const child of tail) {
            const order =
                typeof child.clauseKind === "string"
                    ? dialectContext.queryClauseOrder(child.clauseKind)
                    : null;
            if (order === null || order <= previousTailOrder) {
                failRelationship(
                    failures,
                    raw,
                    `set query ${String(raw.id)} has an invalid tail clause sequence`
                );
                break;
            }
            previousTailOrder = order;
        }
        const expectedOperators = Math.floor(coreLength / 2);
        if (
            coreLength < 3 ||
            coreLength % 2 === 0 ||
            operatorIds.length !== expectedOperators
        ) {
            failRelationship(
                failures,
                raw,
                `set query ${String(raw.id)} must alternate query/operator-clause/query`
            );
            return;
        }
        for (let i = 0; i < coreLength; i++) {
            const child = directChildren[i]!;
            if (i % 2 === 0) {
                if (child.kind !== "query") {
                    failRelationship(
                        failures,
                        raw,
                        `set query ${String(raw.id)} operand ${i / 2} must be a query`
                    );
                }
                continue;
            }
            const operatorPosition = (i - 1) / 2;
            const operatorId = operatorIds[operatorPosition];
            const operatorLeaf = isFiniteNonNegInt(operatorId)
                ? leaves[operatorId]
                : undefined;
            if (
                child.kind !== "clause" ||
                child.clauseKind !== "set-operation" ||
                !isLeafRange(child.headLeafRange) ||
                child.headLeafRange.start !== operatorId ||
                operatorLeaf?.channel !== "code" ||
                !dialectContext.isSetOperatorWord(operatorLeaf.raw.toLowerCase())
            ) {
                failRelationship(
                    failures,
                    raw,
                    `set query ${String(raw.id)} operator ${operatorPosition} has an invalid clause or leaf reference`
                );
            }
        }
        if (raw.capabilityId !== "set-operations" || raw.formatRole !== "capability") {
            failRelationship(
                failures,
                raw,
                `set query ${String(raw.id)} must use set-operations capability authority`
            );
        }
        return;
    }

    if (raw.queryKind === "select") {
        if (
            directChildren.length === 0 ||
            first?.kind !== "clause" ||
            first.clauseKind !== "select" ||
            operatorIds.length !== 0
        ) {
            failRelationship(
                failures,
                raw,
                `select query ${String(raw.id)} must begin with a SELECT clause`
            );
            return;
        }
        let previousOrder = -1;
        for (const child of directChildren) {
            const order =
                child.kind === "clause" && typeof child.clauseKind === "string"
                    ? dialectContext.queryClauseOrder(child.clauseKind)
                    : null;
            if (order === null || order <= previousOrder) {
                failRelationship(
                    failures,
                    raw,
                    `select query ${String(raw.id)} has an illegal or out-of-order clause child`
                );
                return;
            }
            previousOrder = order;
        }
        const hasFromClause = directChildren.some(
            (child) => child.kind === "clause" && child.clauseKind === "from"
        );
        const expectedCapability = hasFromClause ? "from" : "select-without-from";
        if (
            raw.capabilityId !== expectedCapability ||
            raw.formatRole !== "capability"
        ) {
            failRelationship(
                failures,
                raw,
                `select query ${String(raw.id)} must use ${expectedCapability} capability authority`
            );
        }
    }
}

function validateSetPayloadRelationships(
    raw: Record<string, unknown>,
    directChildren: readonly Record<string, unknown>[],
    leaves: readonly SourceLeaf[],
    failures: InvariantFailure[]
): void {
    if (raw.kind !== "set-payload") {
        return;
    }
    if (
        directChildren.length !== 0 ||
        !isLeafRange(raw.leafRange) ||
        !isLeafRange(raw.keyLeafRange) ||
        raw.keyLeafRange.start !== raw.leafRange.start ||
        raw.keyLeafRange.start === raw.keyLeafRange.end
    ) {
        failRelationship(
            failures,
            raw,
            `SET payload ${String(raw.id)} must own one non-empty key and no children`
        );
        return;
    }
    let expectWord = true;
    for (
        let leafId = raw.keyLeafRange.start;
        leafId < raw.keyLeafRange.end && leafId < leaves.length;
        leafId++
    ) {
        const leaf = leaves[leafId]!;
        const word = leaf.channel === "code" &&
            (leaf.kind === "identifier" ||
                leaf.kind === "keyword" ||
                (leaf.kind === "number" && leafId > raw.keyLeafRange.start));
        const separator = leaf.channel === "code" &&
            (leaf.raw === "." || leaf.raw === ":");
        if ((expectWord && !word) || (!expectWord && !separator)) {
            failRelationship(
                failures,
                raw,
                `SET payload ${String(raw.id)} key is not a dotted or namespaced word sequence`
            );
            return;
        }
        expectWord = !expectWord;
    }
    if (expectWord) {
        failRelationship(
            failures,
            raw,
            `SET payload ${String(raw.id)} key ends with a separator`
        );
    }

    const assignmentLeafId = raw.assignmentLeafId;
    const valueLeafRange = raw.valueLeafRange;
    if (assignmentLeafId === null || assignmentLeafId === undefined) {
        if (valueLeafRange !== null) {
            failRelationship(
                failures,
                raw,
                `SET key-only payload ${String(raw.id)} must not own a value range`
            );
        }
        for (
            let leafId = raw.keyLeafRange.end;
            leafId < raw.leafRange.end && leafId < leaves.length;
            leafId++
        ) {
            if (leaves[leafId]!.channel === "code" || leaves[leafId]!.channel === "protected") {
                failRelationship(
                    failures,
                    raw,
                    `SET key-only payload ${String(raw.id)} has unclaimed syntax`
                );
                break;
            }
        }
        return;
    }
    if (
        !isFiniteNonNegInt(assignmentLeafId) ||
        assignmentLeafId < raw.keyLeafRange.end ||
        assignmentLeafId >= raw.leafRange.end ||
        leaves[assignmentLeafId]?.channel !== "code" ||
        leaves[assignmentLeafId]?.raw !== "=" ||
        !isLeafRange(valueLeafRange) ||
        valueLeafRange.start !== assignmentLeafId + 1 ||
        valueLeafRange.end !== raw.leafRange.end
    ) {
        failRelationship(
            failures,
            raw,
            `SET assignment payload ${String(raw.id)} has inconsistent key/operator/value bounds`
        );
        return;
    }
    for (
        let leafId = raw.keyLeafRange.end;
        leafId < assignmentLeafId && leafId < leaves.length;
        leafId++
    ) {
        const channel = leaves[leafId]!.channel;
        if (channel === "code" || channel === "protected") {
            failRelationship(
                failures,
                raw,
                `SET assignment payload ${String(raw.id)} has unclaimed syntax before its operator`
            );
            return;
        }
    }
    let hasValueSyntax = false;
    for (
        let leafId = valueLeafRange.start;
        leafId < valueLeafRange.end && leafId < leaves.length;
        leafId++
    ) {
        const channel = leaves[leafId]!.channel;
        hasValueSyntax ||= channel === "code" || channel === "protected";
    }
    if (!hasValueSyntax) {
        failRelationship(
            failures,
            raw,
            `SET assignment payload ${String(raw.id)} requires a non-empty value`
        );
    }
}

function validateSetStatementRelationships(
    raw: Record<string, unknown>,
    directChildren: readonly Record<string, unknown>[],
    leaves: readonly SourceLeaf[],
    failures: InvariantFailure[]
): void {
    if (raw.kind !== "set-statement" || !isLeafRange(raw.leafRange)) {
        return;
    }
    const payload = raw.payloadChildId === null
        ? null
        : directChildren.find((child) => child.id === raw.payloadChildId) ?? null;
    if (
        (raw.payloadChildId === null && directChildren.length !== 0) ||
        (raw.payloadChildId !== null &&
            (directChildren.length !== 1 || payload?.kind !== "set-payload"))
    ) {
        failRelationship(
            failures,
            raw,
            `SET command ${String(raw.id)} has an invalid payload reference`
        );
        return;
    }
    let directSetCount = 0;
    let directSetLeafId: number | null = null;
    let firstSyntaxLeafId: number | null = null;
    for (
        let leafId = raw.leafRange.start;
        leafId < raw.leafRange.end && leafId < leaves.length;
        leafId++
    ) {
        const leaf = leaves[leafId]!;
        if (
            firstSyntaxLeafId === null &&
            (leaf.channel === "code" || leaf.channel === "protected")
        ) {
            firstSyntaxLeafId = leafId;
        }
        if (
            payload !== null &&
            isLeafRange(payload.leafRange) &&
            leafId >= payload.leafRange.start &&
            leafId < payload.leafRange.end
        ) {
            continue;
        }
        if (leaf.channel !== "code" && leaf.channel !== "protected") {
            continue;
        }
        if (
            leaf.channel === "code" &&
            leaf.raw.toLowerCase() === "set" &&
            directSetCount === 0
        ) {
            directSetCount += 1;
            directSetLeafId = leafId;
            continue;
        }
        failRelationship(
            failures,
            raw,
            `SET command ${String(raw.id)} has unclaimed direct syntax at leaf ${leafId}`
        );
        return;
    }
    if (directSetCount !== 1) {
        failRelationship(
            failures,
            raw,
            `SET command ${String(raw.id)} must own exactly one SET head`
        );
        return;
    }
    if (
        directSetLeafId === null ||
        directSetLeafId !== firstSyntaxLeafId ||
        (payload !== null &&
            isLeafRange(payload.leafRange) &&
            directSetLeafId >= payload.leafRange.start)
    ) {
        failRelationship(
            failures,
            raw,
            `SET command ${String(raw.id)} head must be its first syntax leaf and precede its payload`
        );
    }
}

function validateRelationRelationships(
    raw: Record<string, unknown>,
    directChildren: readonly Record<string, unknown>[],
    failures: InvariantFailure[]
): void {
    if (raw.kind !== "relation" || typeof raw.relationKind !== "string") {
        return;
    }
    let body: Record<string, unknown> | undefined;
    if (isFiniteNonNegInt(raw.bodyChildId)) {
        for (const child of directChildren) {
            if (child.id === raw.bodyChildId) {
                body = child;
                break;
            }
        }
    }
    let extensionCount = 0;
    let firstExtension: Record<string, unknown> | undefined;
    let invalidJoinExtension = false;
    for (const child of directChildren) {
        if (child === body) {
            continue;
        }
        extensionCount += 1;
        firstExtension ??= child;
        if (
            child.kind !== "clause" ||
            (child.clauseKind !== "join-on" && child.clauseKind !== "join-using")
        ) {
            invalidJoinExtension = true;
        }
    }

    if (raw.relationKind === "join") {
        if (
            body?.kind !== "relation" ||
            extensionCount > 1 ||
            invalidJoinExtension
        ) {
            failRelationship(
                failures,
                raw,
                `join relation ${String(raw.id)} must contain its right relation and at most one JOIN ON/USING clause`
            );
        }
        return;
    }

    if (raw.relationKind === "lateral-view") {
        if (
            body?.kind !== "relation" ||
            body.relationKind !== "table-function" ||
            extensionCount !== 1 ||
            firstExtension?.kind !== "list"
        ) {
            failRelationship(
                failures,
                raw,
                `lateral-view relation ${String(raw.id)} must contain one table-function and one output list`
            );
        }
    }
}

function isChild(
    child: Record<string, unknown> | undefined,
    kind: string,
    subtypeField?: string,
    subtype?: string
): boolean {
    return (
        child?.kind === kind &&
        (subtypeField === undefined || child[subtypeField] === subtype)
    );
}

function validateClauseRelationships(
    raw: Record<string, unknown>,
    directChildren: readonly Record<string, unknown>[],
    leaves: readonly SourceLeaf[],
    failures: InvariantFailure[],
    trustedCanonicalShape: boolean
): void {
    if (raw.kind !== "clause" || typeof raw.clauseKind !== "string") {
        return;
    }
    if (isLeafRange(raw.bodyLeafRange)) {
        for (const child of directChildren) {
            if (
                isLeafRange(child.leafRange) &&
                (child.leafRange.start < raw.bodyLeafRange.start ||
                    child.leafRange.end > raw.bodyLeafRange.end)
            ) {
                failRelationship(
                    failures,
                    raw,
                    `clause ${String(raw.id)} child ${String(child.id)} must be contained by bodyLeafRange`
                );
            }
        }
    }

    validateClauseSeparatorOwnership(
        raw,
        directChildren,
        leaves,
        failures,
        trustedCanonicalShape
    );

    const only = directChildren[0];
    // Every clause kind may use one clause-boundary opaque child for local recovery.
    let valid =
        directChildren.length === 1 &&
        only?.kind === "opaque" &&
        only.boundary === "clause";
    if (valid) {
        return;
    }
    switch (raw.clauseKind) {
        case "with":
            valid =
                directChildren.length > 0 &&
                directChildren.every((child) => child.kind === "cte");
            break;
        case "select":
            valid =
                directChildren.length === 1 &&
                isChild(only, "list", "listRole", "select-items");
            break;
        case "from":
            valid =
                directChildren.length > 0 &&
                directChildren[0]?.kind === "relation" &&
                directChildren.every(
                    (child) =>
                        child.kind === "relation" ||
                        isChild(child, "clause", "clauseKind", "lateral-view")
                );
            break;
        case "where":
        case "having":
        case "limit":
        case "join-on":
            valid =
                directChildren.length === 1 &&
                (only?.kind === "opaque" || only?.kind === "expression");
            break;
        case "join-using":
            valid =
                directChildren.length === 1 &&
                isChild(only, "list", "listRole", "other");
            break;
        case "group-by":
            valid =
                directChildren.length === 1 &&
                isChild(only, "list", "listRole", "group-by-items");
            break;
        case "window":
            valid =
                directChildren.length === 1 &&
                isChild(only, "list", "listRole", "other");
            break;
        case "order-by":
            valid =
                directChildren.length === 1 &&
                isChild(only, "list", "listRole", "order-by-items");
            break;
        case "cluster-by":
            valid =
                directChildren.length === 1 &&
                isChild(only, "list", "listRole", "cluster-by-items");
            break;
        case "distribute-by":
            valid =
                directChildren.length === 1 &&
                isChild(only, "list", "listRole", "distribute-by-items");
            break;
        case "sort-by":
            valid =
                directChildren.length === 1 &&
                isChild(only, "list", "listRole", "sort-by-items");
            break;
        case "lateral-view":
            valid =
                directChildren.length === 1 &&
                isChild(only, "relation", "relationKind", "lateral-view");
            break;
        case "insert":
            valid =
                directChildren.length === 1 &&
                only?.kind === "relation" &&
                only.relationKind === "table" &&
                only.alias === null &&
                only.bodyChildId === null &&
                readNodeArray(only, "children", trustedCanonicalShape).length === 0;
            break;
        case "partition":
            valid =
                directChildren.length === 1 &&
                isChild(only, "list", "listRole", "partition-columns");
            break;
        case "set-operation":
            valid = directChildren.length === 0;
            break;
        default:
            return;
    }
    if (!valid) {
        failRelationship(
            failures,
            raw,
            `${raw.clauseKind} clause ${String(raw.id)} has an invalid child structure`
        );
    }
}

function validateClauseSeparatorOwnership(
    raw: Record<string, unknown>,
    directChildren: readonly Record<string, unknown>[],
    leaves: readonly SourceLeaf[],
    failures: InvariantFailure[],
    trustedCanonicalShape: boolean
): void {
    const separators = readNodeArray(
        raw,
        "separatorLeafIds",
        trustedCanonicalShape
    ).filter(isFiniteNonNegInt);
    if (raw.clauseKind !== "with" && raw.clauseKind !== "from") {
        if (separators.length !== 0) {
            failRelationship(
                failures,
                raw,
                `${String(raw.clauseKind)} clause ${String(raw.id)} must not own direct comma separators`
            );
        }
        return;
    }

    const expected: number[] = [];
    for (let childIndex = 0; childIndex + 1 < directChildren.length; childIndex++) {
        const left = directChildren[childIndex];
        const right = directChildren[childIndex + 1];
        if (!isLeafRange(left?.leafRange) || !isLeafRange(right?.leafRange)) {
            continue;
        }
        let gapComma: number | null = null;
        for (
            let leafId = left.leafRange.end;
            leafId < right.leafRange.start && leafId < leaves.length;
            leafId++
        ) {
            const leaf = leaves[leafId]!;
            if (leaf.channel === "code" && leaf.raw === ",") {
                if (gapComma !== null) {
                    failRelationship(
                        failures,
                        raw,
                        `${String(raw.clauseKind)} clause ${String(raw.id)} has multiple comma claims between direct children ${String(left.id)} and ${String(right.id)}`
                    );
                    break;
                }
                gapComma = leafId;
            }
        }
        if (gapComma !== null) {
            expected.push(gapComma);
        }
    }
    if (
        separators.length !== expected.length ||
        separators.some((leafId, index) => leafId !== expected[index])
    ) {
        failRelationship(
            failures,
            raw,
            `${String(raw.clauseKind)} clause ${String(raw.id)} separatorLeafIds must exactly own every direct-child comma gap`
        );
    }
}

function validateListRelationships(
    raw: Record<string, unknown>,
    directChildren: readonly Record<string, unknown>[],
    leaves: readonly SourceLeaf[],
    failures: InvariantFailure[],
    trustedCanonicalShape: boolean
): void {
    if (raw.kind !== "list" || typeof raw.listRole !== "string") {
        return;
    }
    const expectedItemRole = listItemRoleFor(raw.listRole as ListRole);
    const separators = readNodeArray(
        raw,
        "separatorLeafIds",
        trustedCanonicalShape
    );
    if (
        directChildren.length === 0 ||
        directChildren.some(
            (child) => child.kind !== "list-item" || child.itemRole !== expectedItemRole
        ) ||
        separators.length !== directChildren.length - 1
    ) {
        failRelationship(
            failures,
            raw,
            `list ${String(raw.id)} role/items/separator count is inconsistent`
        );
        return;
    }
    for (let i = 0; i < separators.length; i++) {
        const separator = separators[i];
        const leaf = isFiniteNonNegInt(separator) ? leaves[separator] : undefined;
        const left = directChildren[i];
        const right = directChildren[i + 1];
        if (
            leaf?.channel !== "code" ||
            leaf.raw !== "," ||
            !isLeafRange(left?.leafRange) ||
            !isLeafRange(right?.leafRange) ||
            !isFiniteNonNegInt(separator) ||
            separator < left.leafRange.end ||
            separator >= right.leafRange.start
        ) {
            failRelationship(
                failures,
                raw,
                `list ${String(raw.id)} separator ${i} must own the comma between adjacent items`
            );
        }
    }
}

function validateExpressionRelationships(
    raw: Record<string, unknown>,
    directChildren: readonly Record<string, unknown>[],
    leaves: readonly SourceLeaf[],
    failures: InvariantFailure[],
    trustedCanonicalShape: boolean
): void {
    if (raw.kind !== "expression" || typeof raw.expressionKind !== "string") {
        return;
    }
    const operatorIds = readNodeArray(
        raw,
        "operatorLeafIds",
        trustedCanonicalShape
    );
    const operatorCount = operatorIds.length;
    const markers = readNodeArray(
        raw,
        "syntaxMarkers",
        trustedCanonicalShape
    );
    let isWindowFrameExpression = false;
    let hasOperatorMarker = false;
    for (const marker of markers) {
        if (marker === null || typeof marker !== "object") {
            continue;
        }
        const syntaxId = (marker as Record<string, unknown>).syntaxId;
        if (syntaxId === "operator") {
            hasOperatorMarker = true;
        }
        if (
            syntaxId === "window:rows" ||
            syntaxId === "window:range" ||
            syntaxId === "window:groups"
        ) {
            isWindowFrameExpression = true;
            break;
        }
    }
    for (const operatorId of operatorIds) {
        if (!isFiniteNonNegInt(operatorId) || operatorId >= leaves.length) {
            continue;
        }
        for (const child of directChildren) {
            if (
                child.kind !== "expression" ||
                !isLeafRange(child.leafRange) ||
                (raw.expressionKind === "in" &&
                    child.expressionKind === "subquery" &&
                    isDenseArray(child.operatorLeafIds) &&
                    child.operatorLeafIds.includes(operatorId))
            ) {
                continue;
            }
            if (
                operatorId >= child.leafRange.start &&
                operatorId < child.leafRange.end
            ) {
                failRelationship(
                    failures,
                    raw,
                    `expression ${String(raw.id)} operator leaf ${operatorId} overlaps operand child ${String(child.id)}`
                );
                break;
            }
        }
    }
    let valid = false;

    switch (raw.expressionKind) {
        case "identifier":
        case "wildcard":
        case "literal":
        case "parameter":
            valid = directChildren.length === 0 && operatorCount === 0;
            break;
        case "qualified-identifier":
            valid =
                directChildren.length === 2 &&
                directChildren.every((child) => child.kind === "expression");
            break;
        case "unary":
            valid =
                directChildren.length === 1 &&
                isExpressionValue(directChildren[0]) &&
                (operatorCount >= 1 || isWindowFrameExpression);
            break;
        case "binary":
            valid =
                directChildren.length === 2 &&
                isExpressionValue(directChildren[0]) &&
                isExpressionValue(directChildren[1]) &&
                operatorCount >= 1;
            break;
        case "function-call":
            valid =
                (directChildren.length === 1 || directChildren.length === 2) &&
                directChildren[0]?.kind === "expression" &&
                (directChildren.length === 1 ||
                    (directChildren[1]?.kind === "list" &&
                        directChildren[1]?.listRole === "function-args"));
            break;
        case "cast":
            valid =
                directChildren.length === 2 &&
                (directChildren[0]?.kind === "expression" ||
                    directChildren[0]?.kind === "opaque") &&
                (directChildren[1]?.kind === "type-expression" ||
                    (directChildren[1]?.kind === "opaque" &&
                        directChildren[1]?.boundary === "type"));
            break;
        case "case": {
            const branchStart = directChildren[0]?.kind === "case-branch" ? 0 : 1;
            valid =
                directChildren.length > branchStart &&
                (branchStart === 0 ||
                    directChildren[0]?.kind === "expression" ||
                    directChildren[0]?.kind === "opaque") &&
                directChildren
                    .slice(branchStart)
                    .every((child) => child.kind === "case-branch");
            break;
        }
        case "subquery":
            valid =
                directChildren.length === 1 &&
                directChildren[0]?.kind === "query";
            break;
        case "parenthesized":
            valid =
                directChildren.length === 1 &&
                isExpressionValue(directChildren[0]);
            break;
        case "collection":
            valid =
                directChildren.length <= 2 &&
                (directChildren.length === 0 ||
                    directChildren[0]?.kind === "expression" ||
                    directChildren[0]?.kind === "list") &&
                (directChildren.length < 2 ||
                    (directChildren[0]?.kind === "expression" &&
                        directChildren[1]?.kind === "list"));
            break;
        case "window":
            valid =
                directChildren.length === 2 &&
                directChildren[0]?.kind === "expression" &&
                directChildren[1]?.kind === "window-spec";
            break;
        case "between":
            valid =
                (directChildren.length === 2 || directChildren.length === 3) &&
                directChildren.every(isExpressionValue) &&
                (operatorCount >= 2 || isWindowFrameExpression);
            break;
        case "in":
            valid =
                directChildren.length === 2 &&
                (directChildren[0]?.kind === "expression" ||
                    directChildren[0]?.kind === "opaque") &&
                (directChildren[1]?.kind === "list" ||
                    (directChildren[1]?.kind === "expression" &&
                        directChildren[1]?.expressionKind === "subquery")) &&
                operatorCount >= 1;
            break;
        case "exists":
            valid =
                directChildren.length === 1 &&
                directChildren[0]?.kind === "expression" &&
                directChildren[0]?.expressionKind === "subquery" &&
                operatorCount === 0 &&
                hasOperatorMarker;
            break;
        case "is":
            valid =
                directChildren.length === 1 &&
                isExpressionValue(directChildren[0]) &&
                operatorCount >= 2;
            break;
        case "frame-bound":
            valid =
                directChildren.length <= 1 &&
                (directChildren.length === 0 ||
                    isExpressionValue(directChildren[0]));
            break;
        case "typed-literal":
            valid =
                directChildren.length === 1 &&
                directChildren[0]?.kind === "expression" &&
                directChildren[0]?.expressionKind === "literal";
            break;
        default:
            return;
    }

    if (!valid) {
        failRelationship(
            failures,
            raw,
            `expression ${String(raw.id)} has children/operators inconsistent with ${raw.expressionKind}`
        );
    }
}

function isExpressionValue(child: Record<string, unknown> | undefined): boolean {
    return child?.kind === "expression" || child?.kind === "opaque";
}

function referencedChild(
    raw: Record<string, unknown>,
    field: string,
    directChildren: readonly Record<string, unknown>[]
): Record<string, unknown> | null {
    const childId = raw[field];
    return isFiniteNonNegInt(childId)
        ? directChildren.find((child) => child.id === childId) ?? null
        : null;
}

function validateWindowRelationships(
    raw: Record<string, unknown>,
    directChildren: readonly Record<string, unknown>[],
    failures: InvariantFailure[]
): void {
    if (raw.kind !== "window-spec") {
        return;
    }
    const partition = referencedChild(raw, "partitionChildId", directChildren);
    const order = referencedChild(raw, "orderChildId", directChildren);
    const frame = referencedChild(raw, "frameChildId", directChildren);
    if (partition !== null && (partition.kind !== "list" || partition.listRole !== "window-partition")) {
        failRelationship(failures, raw, `window-spec ${String(raw.id)} partition child has an invalid role`);
    }
    if (order !== null && (order.kind !== "list" || order.listRole !== "window-order")) {
        failRelationship(failures, raw, `window-spec ${String(raw.id)} order child has an invalid role`);
    }
    if (
        frame !== null &&
        (frame.kind !== "expression" ||
            (frame.expressionKind !== "between" && frame.expressionKind !== "unary"))
    ) {
        failRelationship(failures, raw, `window-spec ${String(raw.id)} frame child has an invalid shape`);
    }
}

function validateTypeRelationships(
    raw: Record<string, unknown>,
    directChildren: readonly Record<string, unknown>[],
    failures: InvariantFailure[]
): void {
    if (raw.kind !== "type-expression") {
        return;
    }
    if (raw.argumentListChildId !== null && raw.memberListChildId !== null) {
        failRelationship(
            failures,
            raw,
            `type-expression ${String(raw.id)} cannot own argument and member lists together`
        );
    }
    const argumentsList = referencedChild(raw, "argumentListChildId", directChildren);
    const membersList = referencedChild(raw, "memberListChildId", directChildren);
    if (
        argumentsList !== null &&
        (argumentsList.kind !== "list" || argumentsList.listRole !== "type-args")
    ) {
        failRelationship(failures, raw, `type-expression ${String(raw.id)} argument child has an invalid role`);
    }
    if (
        membersList !== null &&
        (membersList.kind !== "list" || membersList.listRole !== "type-members")
    ) {
        failRelationship(failures, raw, `type-expression ${String(raw.id)} member child has an invalid role`);
    }
}

export function validateContainerRelationships(
    raw: Record<string, unknown>,
    directChildren: readonly Record<string, unknown>[],
    leaves: readonly SourceLeaf[],
    failures: InvariantFailure[],
    dialectContext: CstDialectInvariantContext,
    trustedCanonicalShape: boolean
): void {
    switch (raw.kind) {
        case "query":
            validateQueryRelationships(
                raw,
                directChildren,
                leaves,
                failures,
                dialectContext,
                trustedCanonicalShape
            );
            break;
        case "relation":
            validateRelationRelationships(raw, directChildren, failures);
            break;
        case "clause":
            validateClauseRelationships(
                raw,
                directChildren,
                leaves,
                failures,
                trustedCanonicalShape
            );
            break;
        case "list":
            validateListRelationships(
                raw,
                directChildren,
                leaves,
                failures,
                trustedCanonicalShape
            );
            break;
        case "expression":
            validateExpressionRelationships(
                raw,
                directChildren,
                leaves,
                failures,
                trustedCanonicalShape
            );
            break;
        case "window-spec":
            validateWindowRelationships(raw, directChildren, failures);
            break;
        case "type-expression":
            validateTypeRelationships(raw, directChildren, failures);
            break;
        case "set-payload":
            validateSetPayloadRelationships(
                raw,
                directChildren,
                leaves,
                failures
            );
            break;
        case "set-statement":
            validateSetStatementRelationships(
                raw,
                directChildren,
                leaves,
                failures
            );
            break;
        default:
            break;
    }
}
