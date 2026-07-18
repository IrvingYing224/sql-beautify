import type {
    ExpressionNode,
    ListItemNode,
    ListNode,
    SyntaxNode,
    TypeExpressionNode,
    WindowSpecNode,
} from "../syntax/node";
import { authorityForNode } from "./query-layout-context";
import type { QueryLayoutContext } from "./query-layout-context";
import { formatFlatList } from "./query-list-policy";
import {
    EMPTY,
    replaceStructuralGap,
    SPACE,
} from "./query-trivia-policy";

interface DirectAnchor {
    readonly start: number;
    readonly end: number;
}

function normalizedAnchors(
    children: readonly SyntaxNode[],
    markerLeafIds: readonly number[],
    extraRanges: readonly DirectAnchor[] = []
): readonly DirectAnchor[] | null {
    const anchors: DirectAnchor[] = children.map((child) => ({
        start: child.leafRange.start,
        end: child.leafRange.end,
    }));
    anchors.push(...extraRanges);
    for (const leafId of markerLeafIds) {
        if (
            anchors.some(
                (anchor) => leafId >= anchor.start && leafId < anchor.end
            )
        ) {
            continue;
        }
        anchors.push({ start: leafId, end: leafId + 1 });
    }
    anchors.sort((left, right) => left.start - right.start || right.end - left.end);
    const unique: DirectAnchor[] = [];
    for (const anchor of anchors) {
        const previous = unique[unique.length - 1];
        if (
            previous !== undefined &&
            previous.start === anchor.start &&
            previous.end === anchor.end
        ) {
            continue;
        }
        if (previous !== undefined && anchor.start < previous.end) {
            return null;
        }
        unique.push(anchor);
    }
    return Object.freeze(unique);
}

function normalizeSequence(
    context: QueryLayoutContext,
    authorityNodeId: number,
    anchors: readonly DirectAnchor[]
): boolean {
    for (let index = 1; index < anchors.length; index++) {
        if (
            !replaceStructuralGap(
                context,
                authorityNodeId,
                anchors[index - 1]!.end,
                anchors[index]!.start,
                SPACE
            )
        ) {
            return false;
        }
    }
    return true;
}

function delimiterPair(
    node: ExpressionNode | TypeExpressionNode | WindowSpecNode
): readonly [number, number] | null {
    const opens = node.syntaxMarkers.filter(
        (marker) => marker.syntaxId === "delimiter" && marker.partOrdinal === 0
    );
    const closes = node.syntaxMarkers.filter(
        (marker) => marker.syntaxId === "delimiter" && marker.partOrdinal === 1
    );
    return opens.length === 1 && closes.length === 1 &&
        opens[0]!.leafId < closes[0]!.leafId
        ? Object.freeze([opens[0]!.leafId, closes[0]!.leafId] as const)
        : null;
}

function normalizeDelimitedInterior(
    context: QueryLayoutContext,
    authorityNodeId: number,
    node: ExpressionNode | TypeExpressionNode | WindowSpecNode,
    openLeafId: number,
    closeLeafId: number,
    extraRanges: readonly DirectAnchor[] = []
): boolean {
    const children = node.children.filter(
        (child) =>
            child.leafRange.start > openLeafId &&
            child.leafRange.end <= closeLeafId
    );
    const markerLeafIds = node.syntaxMarkers
        .filter(
            (marker) =>
                marker.syntaxId !== "delimiter" &&
                marker.leafId > openLeafId &&
                marker.leafId < closeLeafId
        )
        .map((marker) => marker.leafId);
    const anchors = normalizedAnchors(
        children,
        markerLeafIds,
        extraRanges.filter(
            (range) => range.start > openLeafId && range.end <= closeLeafId
        )
    );
    if (anchors === null) {
        return false;
    }
    if (anchors.length === 0) {
        return replaceStructuralGap(
            context,
            authorityNodeId,
            openLeafId + 1,
            closeLeafId,
            EMPTY
        );
    }
    return (
        replaceStructuralGap(
            context,
            authorityNodeId,
            openLeafId + 1,
            anchors[0]!.start,
            EMPTY
        ) &&
        normalizeSequence(context, authorityNodeId, anchors) &&
        replaceStructuralGap(
            context,
            authorityNodeId,
            anchors[anchors.length - 1]!.end,
            closeLeafId,
            EMPTY
        )
    );
}

function formatCallLike(
    context: QueryLayoutContext,
    node: ExpressionNode,
    spaceBeforeOpen: boolean | null
): boolean {
    const authorityNodeId = authorityForNode(context, node.id);
    if (authorityNodeId === null) {
        return true;
    }
    const delimiters = delimiterPair(node);
    if (delimiters === null) {
        return false;
    }
    const [openLeafId, closeLeafId] = delimiters;
    if (spaceBeforeOpen !== null) {
        const previous = node.children
            .filter((child) => child.leafRange.end <= openLeafId)
            .sort((left, right) => right.leafRange.end - left.leafRange.end)[0];
        if (
            previous === undefined ||
            !replaceStructuralGap(
                context,
                authorityNodeId,
                previous.leafRange.end,
                openLeafId,
                spaceBeforeOpen ? SPACE : EMPTY
            )
        ) {
            return false;
        }
    }
    return normalizeDelimitedInterior(
        context,
        authorityNodeId,
        node,
        openLeafId,
        closeLeafId
    );
}

function formatCast(
    context: QueryLayoutContext,
    node: ExpressionNode
): boolean {
    const authorityNodeId = authorityForNode(context, node.id);
    if (authorityNodeId === null) {
        return true;
    }
    const delimiters = delimiterPair(node);
    const cast = node.syntaxMarkers.filter((marker) => marker.syntaxId === "type:cast");
    const as = node.syntaxMarkers.filter((marker) => marker.syntaxId === "type:as");
    const value = node.children[0];
    const type = node.children[1];
    if (
        delimiters === null ||
        cast.length !== 1 ||
        as.length !== 1 ||
        value === undefined ||
        type === undefined
    ) {
        return false;
    }
    const [openLeafId, closeLeafId] = delimiters;
    return (
        replaceStructuralGap(
            context,
            authorityNodeId,
            cast[0]!.leafId + 1,
            openLeafId,
            EMPTY
        ) &&
        replaceStructuralGap(
            context,
            authorityNodeId,
            openLeafId + 1,
            value.leafRange.start,
            EMPTY
        ) &&
        replaceStructuralGap(
            context,
            authorityNodeId,
            value.leafRange.end,
            as[0]!.leafId,
            SPACE
        ) &&
        replaceStructuralGap(
            context,
            authorityNodeId,
            as[0]!.leafId + 1,
            type.leafRange.start,
            SPACE
        ) &&
        replaceStructuralGap(
            context,
            authorityNodeId,
            type.leafRange.end,
            closeLeafId,
            EMPTY
        )
    );
}

function formatQualifiedIdentifier(
    context: QueryLayoutContext,
    node: ExpressionNode
): boolean {
    const authorityNodeId = authorityForNode(context, node.id);
    if (authorityNodeId === null) {
        return true;
    }
    const punctuation = node.syntaxMarkers.filter(
        (marker) =>
            marker.syntaxId === "delimiter" && marker.syntaxRole === "punctuation"
    );
    if (punctuation.length !== 1 || node.children.length !== 2) {
        return false;
    }
    return (
        replaceStructuralGap(
            context,
            authorityNodeId,
            node.children[0]!.leafRange.end,
            punctuation[0]!.leafId,
            EMPTY
        ) &&
        replaceStructuralGap(
            context,
            authorityNodeId,
            punctuation[0]!.leafId + 1,
            node.children[1]!.leafRange.start,
            EMPTY
        )
    );
}

function formatMarkerSequence(
    context: QueryLayoutContext,
    node: ExpressionNode,
    markerSyntaxIds: readonly string[]
): boolean {
    const authorityNodeId = authorityForNode(context, node.id);
    if (authorityNodeId === null) {
        return true;
    }
    const markers = node.syntaxMarkers
        .filter((marker) => markerSyntaxIds.includes(marker.syntaxId))
        .map((marker) => marker.leafId);
    const anchors = normalizedAnchors(node.children, markers);
    return anchors !== null && normalizeSequence(context, authorityNodeId, anchors);
}

export function formatExpressionContainer(
    context: QueryLayoutContext,
    node: ExpressionNode
): boolean {
    switch (node.expressionKind) {
        case "qualified-identifier":
            return formatQualifiedIdentifier(context, node);
        case "function-call":
        case "collection":
            return formatCallLike(context, node, false);
        case "parenthesized":
            return formatCallLike(context, node, null);
        case "in":
            return node.syntaxMarkers.some(
                (marker) => marker.syntaxId === "delimiter"
            )
                ? formatCallLike(context, node, null)
                : true;
        case "cast":
            return node.operatorOccurrences.length > 0
                ? true
                : formatCast(context, node);
        case "exists":
            return formatMarkerSequence(context, node, ["operator"]);
        case "window":
            return formatMarkerSequence(context, node, ["window:over"]);
        case "typed-literal":
            return formatMarkerSequence(context, node, ["type:name"]);
        case "frame-bound":
            return formatMarkerSequence(context, node, [
                "window:unbounded",
                "window:current-row",
                "window:preceding",
                "window:following",
            ]);
        case "between":
        case "unary":
            return node.operatorOccurrences.length > 0
                ? true
                : formatMarkerSequence(context, node, [
                      "window:rows",
                      "window:range",
                      "window:groups",
                      "window:between",
                      "window:and",
                  ]);
        case "identifier":
        case "wildcard":
        case "literal":
        case "parameter":
        case "binary":
        case "case":
        case "subquery":
        case "is":
            return true;
    }
}

export function formatExpressionList(
    context: QueryLayoutContext,
    node: ListNode
): boolean {
    return node.listRole === "function-args" ||
        node.listRole === "values" ||
        node.listRole === "type-args" ||
        node.listRole === "type-members" ||
        node.listRole === "window-partition" ||
        node.listRole === "window-order"
        ? (() => {
              const authorityNodeId = authorityForNode(context, node.id);
              return authorityNodeId === null ||
                  formatFlatList(context, authorityNodeId, node);
          })()
        : true;
}

export function formatExpressionListItem(
    context: QueryLayoutContext,
    node: ListItemNode
): boolean {
    const authorityNodeId = authorityForNode(context, node.id);
    if (authorityNodeId === null) {
        return true;
    }
    const value = context.analysis.index.nodeById(node.valueChildId);
    context.statistics.directLookupCount += 1;
    let leftEnd = value.leafRange.end;
    for (const modifierLeafId of node.modifierLeafIds) {
        if (
            !replaceStructuralGap(
                context,
                authorityNodeId,
                leftEnd,
                modifierLeafId,
                SPACE
            )
        ) {
            return false;
        }
        leftEnd = modifierLeafId + 1;
    }
    const colon = node.syntaxMarkers.filter(
        (marker) => marker.syntaxId === "type:member-colon"
    );
    if (colon.length === 0) {
        return true;
    }
    return (
        colon.length === 1 &&
        node.alias !== null &&
        replaceStructuralGap(
            context,
            authorityNodeId,
            node.alias.nameLeafRange.end,
            colon[0]!.leafId,
            EMPTY
        ) &&
        replaceStructuralGap(
            context,
            authorityNodeId,
            colon[0]!.leafId + 1,
            value.leafRange.start,
            SPACE
        )
    );
}

export function formatTypeExpression(
    context: QueryLayoutContext,
    node: TypeExpressionNode
): boolean {
    const authorityNodeId = authorityForNode(context, node.id);
    if (authorityNodeId === null) {
        return true;
    }
    if (node.argumentListChildId === null && node.memberListChildId === null) {
        return true;
    }
    const opens = node.syntaxMarkers.filter(
        (marker) => marker.syntaxId === "delimiter" && marker.partOrdinal === 0
    );
    const closes = node.syntaxMarkers.filter(
        (marker) => marker.syntaxId === "delimiter" && marker.partOrdinal === 1
    );
    const listChildId = node.argumentListChildId ?? node.memberListChildId;
    if (opens.length !== 1 || closes.length > 1 || listChildId === null) {
        return false;
    }
    const openLeafId = opens[0]!.leafId;
    const list = context.analysis.index.nodeById(listChildId);
    context.statistics.directLookupCount += 1;
    if (list.kind !== "list") {
        return false;
    }
    if (
        !replaceStructuralGap(
            context,
            authorityNodeId,
            node.typeNameLeafRange.end,
            openLeafId,
            EMPTY
        ) ||
        !replaceStructuralGap(
            context,
            authorityNodeId,
            openLeafId + 1,
            list.leafRange.start,
            EMPTY
        )
    ) {
        return false;
    }
    if (closes.length === 0) {
        return list.leafRange.end === node.leafRange.end;
    }
    return replaceStructuralGap(
        context,
        authorityNodeId,
        list.leafRange.end,
        closes[0]!.leafId,
        EMPTY
    );
}

export function formatWindowSpec(
    context: QueryLayoutContext,
    node: WindowSpecNode
): boolean {
    const authorityNodeId = authorityForNode(context, node.id);
    if (authorityNodeId === null) {
        return true;
    }
    const delimiters = delimiterPair(node);
    if (delimiters === null) {
        return node.nameLeafRange !== null;
    }
    const [openLeafId, closeLeafId] = delimiters;
    const declarationAs = node.syntaxMarkers.filter(
        (marker) => marker.syntaxId === "alias-as"
    );
    if (declarationAs.length > 0) {
        if (
            declarationAs.length !== 1 ||
            node.nameLeafRange === null ||
            !replaceStructuralGap(
                context,
                authorityNodeId,
                node.nameLeafRange.end,
                declarationAs[0]!.leafId,
                SPACE
            ) ||
            !replaceStructuralGap(
                context,
                authorityNodeId,
                declarationAs[0]!.leafId + 1,
                openLeafId,
                SPACE
            )
        ) {
            return false;
        }
    }
    return normalizeDelimitedInterior(
        context,
        authorityNodeId,
        node,
        openLeafId,
        closeLeafId
    );
}
