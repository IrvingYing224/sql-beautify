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
                (child) => child.kind !== "clause" || child.clauseKind !== "join-on"
            )
        ) {
            failRelationship(
                failures,
                raw,
                `join relation ${String(raw.id)} must contain its right relation and at most one JOIN ON clause`
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
    let valid = false;
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
}
