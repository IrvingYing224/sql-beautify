import type { ListItemRole, ListRole } from "./node";

const ITEM_ROLE_BY_LIST_ROLE: Readonly<Record<ListRole, ListItemRole>> = Object.freeze({
    "select-items": "select-item",
    "group-by-items": "group-by-item",
    "order-by-items": "order-by-item",
    "cluster-by-items": "cluster-by-item",
    "distribute-by-items": "distribute-by-item",
    "sort-by-items": "sort-by-item",
    "partition-columns": "partition-column",
    "function-args": "function-arg",
    "cte-columns": "cte-column",
    "window-partition": "window-partition-item",
    "window-order": "window-order-item",
    "type-args": "type-arg",
    "type-members": "type-member",
    values: "value",
    other: "other",
});

export function listItemRoleFor(listRole: ListRole): ListItemRole {
    return ITEM_ROLE_BY_LIST_ROLE[listRole];
}
