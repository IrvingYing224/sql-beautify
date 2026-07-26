import { isParserStructuredCapabilityState } from "../dialects/capability-state";
import { isCapabilityIdentity } from "../diagnostics/diagnostic";
import type { CstDialectInvariantContext } from "./cst-dialect-context";
import type { FormatRole } from "./node";
import type { ContextualInvariantContext } from "./cst-contextual-invariant-context";
import { isFormatRole } from "./contextual-fact-contract";
import { fail, isLeafRange } from "./invariant-shared";
import {
    MISSING_DATA_FIELD,
    readRequiredDataField,
} from "./cst-contextual-invariant-support";
import { primitiveExpressionCapabilityId } from "./primitive-capability";

const INSERT_CAPABILITIES: readonly string[] = Object.freeze([
    "insert-overwrite-partition-select",
    "insert-into-partition-select",
]);
const CLAUSE_CAPABILITY_BY_KIND: Readonly<
    Record<string, string | readonly string[]>
> = Object.freeze({
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
    insert: INSERT_CAPABILITIES,
    partition: INSERT_CAPABILITIES,
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
    context: ContextualInvariantContext
): void {
    const {
        raw,
        directChildren,
        leaves,
        failures,
        dialectContext,
        nodeId,
    } = context;
    const capabilityId = context.trustedCanonicalShape
        ? raw.capabilityId
        : readRequiredDataField(raw, "capabilityId", nodeId, failures, false);
    const formatRole = context.trustedCanonicalShape
        ? raw.formatRole
        : readRequiredDataField(raw, "formatRole", nodeId, failures, false);
    if (
        formatRole === MISSING_DATA_FIELD ||
        capabilityId === MISSING_DATA_FIELD
    ) {
        return;
    }
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
        case "set-statement":
            allowed = matchesRoleCapability(
                role,
                capabilityId,
                "capability",
                "set-command"
            );
            break;
        case "set-payload":
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
                    INSERT_CAPABILITIES
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

export function validateCapabilityAllowlist(
    context: ContextualInvariantContext
): void {
    validateRoleCapabilityAllowlist(context);
}
