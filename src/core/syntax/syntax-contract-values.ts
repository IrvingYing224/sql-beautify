import type { ClauseKind } from "./node";

/** Canonical finite clause-kind registry shared by parser and validators. */
export const CLAUSE_KINDS: ReadonlySet<string> = new Set<ClauseKind>([
    "with",
    "select",
    "from",
    "where",
    "group-by",
    "having",
    "window",
    "order-by",
    "cluster-by",
    "distribute-by",
    "sort-by",
    "limit",
    "join-on",
    "join-using",
    "lateral-view",
    "insert",
    "partition",
    "set-operation",
]);
