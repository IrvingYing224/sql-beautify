import type { SourceLeaf } from "../lexer/token";
import { getDialect } from "../dialects/registry";
import type { InvariantFailure } from "./invariant-types";
import { listItemRoleFor } from "./list-role-contract";
import type { ListRole } from "./node";
import {
    fail,
    isDenseArray,
    isFiniteNonNegInt,
    isLeafRange,
} from "./invariant-shared";

const SELECT_CLAUSE_ORDER: Readonly<Record<string, number>> = Object.freeze(
    Object.fromEntries(
        getDialect("hive")
            .listQueryClauseSyntax()
            .map((clause) => [clause.id, clause.order])
    )
);
const SET_OPERATOR_WORDS = new Set(
    getDialect("hive").listSetOperatorSyntax().map((operator) => operator.word)
);

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

function validateQueryRelationships(
    raw: Record<string, unknown>,
    directChildren: Record<string, unknown>[],
    leaves: readonly SourceLeaf[],
    failures: InvariantFailure[]
): void {
    if (raw.kind !== "query" || typeof raw.queryKind !== "string") {
        return;
    }
    const first = directChildren[0];
    const operatorIds = isDenseArray(raw.setOperatorLeafIds)
        ? raw.setOperatorLeafIds
        : [];

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
            query?.kind !== "query"
        ) {
            failRelationship(
                failures,
                raw,
                `INSERT query ${String(raw.id)} must contain INSERT, optional PARTITION, and one query child`
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
                    ? SELECT_CLAUSE_ORDER[child.clauseKind]
                    : undefined;
            if (order === undefined || order <= previousTailOrder) {
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
                !SET_OPERATOR_WORDS.has(operatorLeaf.raw.toLowerCase())
            ) {
                failRelationship(
                    failures,
                    raw,
                    `set query ${String(raw.id)} operator ${operatorPosition} has an invalid clause or leaf reference`
                );
            }
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
                    ? SELECT_CLAUSE_ORDER[child.clauseKind]
                    : undefined;
            if (order === undefined || order <= previousOrder) {
                failRelationship(
                    failures,
                    raw,
                    `select query ${String(raw.id)} has an illegal or out-of-order clause child`
                );
                return;
            }
            previousOrder = order;
        }
    }
}

function validateRelationRelationships(
    raw: Record<string, unknown>,
    directChildren: Record<string, unknown>[],
    failures: InvariantFailure[]
): void {
    if (raw.kind !== "relation" || typeof raw.relationKind !== "string") {
        return;
    }
    const body = isFiniteNonNegInt(raw.bodyChildId)
        ? directChildren.find((child) => child.id === raw.bodyChildId)
        : undefined;
    const extensions = directChildren.filter((child) => child !== body);

    if (raw.relationKind === "join") {
        if (
            body?.kind !== "relation" ||
            extensions.length > 1 ||
            extensions.some(
                (child) =>
                    child.kind !== "clause" ||
                    (child.clauseKind !== "join-on" &&
                        child.clauseKind !== "join-using")
            )
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
            extensions.length !== 1 ||
            extensions[0]?.kind !== "list"
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
    directChildren: Record<string, unknown>[],
    failures: InvariantFailure[]
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
            valid = directChildren.length === 1 && only?.kind === "relation";
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

function validateListRelationships(
    raw: Record<string, unknown>,
    directChildren: Record<string, unknown>[],
    leaves: readonly SourceLeaf[],
    failures: InvariantFailure[]
): void {
    if (raw.kind !== "list" || typeof raw.listRole !== "string") {
        return;
    }
    const expectedItemRole = listItemRoleFor(raw.listRole as ListRole);
    const separators = isDenseArray(raw.separatorLeafIds)
        ? raw.separatorLeafIds
        : [];
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
    directChildren: Record<string, unknown>[],
    leaves: readonly SourceLeaf[],
    failures: InvariantFailure[]
): void {
    if (raw.kind !== "expression" || typeof raw.expressionKind !== "string") {
        return;
    }
    const operatorCount = isDenseArray(raw.operatorLeafIds)
        ? raw.operatorLeafIds.length
        : 0;
    const operatorIds = isDenseArray(raw.operatorLeafIds)
        ? raw.operatorLeafIds
        : [];
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
    const allExpressionValues = directChildren.every(
        (child) => child.kind === "expression" || child.kind === "opaque"
    );
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
                directChildren.every((child) => child.kind === "expression") &&
                operatorCount >= 1;
            break;
        case "unary":
            valid = directChildren.length === 1 && allExpressionValues && operatorCount >= 1;
            break;
        case "binary":
            valid = directChildren.length === 2 && allExpressionValues && operatorCount >= 1;
            break;
        case "function-call":
            valid =
                (directChildren.length === 1 || directChildren.length === 2) &&
                directChildren[0]?.kind === "expression" &&
                (directChildren.length === 1 ||
                    (directChildren[1]?.kind === "list" &&
                        directChildren[1]?.listRole === "function-args")) &&
                operatorCount >= 2;
            break;
        case "cast":
            valid =
                directChildren.length === 2 &&
                (directChildren[0]?.kind === "expression" ||
                    directChildren[0]?.kind === "opaque") &&
                (directChildren[1]?.kind === "type-expression" ||
                    (directChildren[1]?.kind === "opaque" &&
                        directChildren[1]?.boundary === "type")) &&
                operatorCount >= 1;
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
                    .every((child) => child.kind === "case-branch") &&
                operatorCount >= 3;
            break;
        }
        case "subquery":
            valid =
                directChildren.length === 1 &&
                directChildren[0]?.kind === "query" &&
                operatorCount >= 2;
            break;
        case "parenthesized":
            valid = directChildren.length === 1 && allExpressionValues && operatorCount >= 2;
            break;
        case "collection":
            valid =
                directChildren.length <= 2 &&
                (directChildren.length === 0 ||
                    directChildren[0]?.kind === "expression" ||
                    directChildren[0]?.kind === "list") &&
                (directChildren.length < 2 ||
                    (directChildren[0]?.kind === "expression" &&
                        directChildren[1]?.kind === "list")) &&
                operatorCount >= 2;
            break;
        case "window":
            valid =
                directChildren.length === 2 &&
                directChildren[0]?.kind === "expression" &&
                directChildren[1]?.kind === "window-spec" &&
                operatorCount >= 1;
            break;
        case "between":
            valid =
                (directChildren.length === 2 || directChildren.length === 3) &&
                allExpressionValues &&
                operatorCount >= 2;
            break;
        case "in":
            valid =
                directChildren.length === 2 &&
                (directChildren[0]?.kind === "expression" ||
                    directChildren[0]?.kind === "opaque") &&
                (directChildren[1]?.kind === "list" ||
                    (directChildren[1]?.kind === "expression" &&
                        directChildren[1]?.expressionKind === "subquery")) &&
                operatorCount >= 3;
            break;
        case "exists":
            valid =
                directChildren.length === 1 &&
                directChildren[0]?.kind === "expression" &&
                directChildren[0]?.expressionKind === "subquery" &&
                operatorCount >= 1;
            break;
        case "is":
            valid = directChildren.length === 1 && allExpressionValues && operatorCount >= 2;
            break;
        case "frame-bound":
            valid =
                directChildren.length <= 1 &&
                allExpressionValues &&
                operatorCount >= 1;
            break;
        case "typed-literal":
            valid =
                directChildren.length === 1 &&
                directChildren[0]?.kind === "expression" &&
                directChildren[0]?.expressionKind === "literal" &&
                operatorCount >= 1;
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

function referencedChild(
    raw: Record<string, unknown>,
    field: string,
    directChildren: Record<string, unknown>[]
): Record<string, unknown> | null {
    const childId = raw[field];
    return isFiniteNonNegInt(childId)
        ? directChildren.find((child) => child.id === childId) ?? null
        : null;
}

function validateWindowRelationships(
    raw: Record<string, unknown>,
    directChildren: Record<string, unknown>[],
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
    directChildren: Record<string, unknown>[],
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
    directChildren: Record<string, unknown>[],
    leaves: readonly SourceLeaf[],
    failures: InvariantFailure[]
): void {
    validateQueryRelationships(raw, directChildren, leaves, failures);
    validateRelationRelationships(raw, directChildren, failures);
    validateClauseRelationships(raw, directChildren, failures);
    validateListRelationships(raw, directChildren, leaves, failures);
    validateExpressionRelationships(raw, directChildren, leaves, failures);
    validateWindowRelationships(raw, directChildren, failures);
    validateTypeRelationships(raw, directChildren, failures);
}
