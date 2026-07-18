import type { LeafRange } from "../syntax/leaf-range";
import type {
    AliasInfo,
    ListItemNode,
    ListNode,
    SyntaxMarker,
    SyntaxNode,
} from "../syntax/node";
import {
    authorityForNode,
    wrapLayoutRange,
} from "./query-layout-context";
import type { QueryLayoutContext } from "./query-layout-context";
import {
    commentGapRequiresHardLine,
    EMPTY,
    HARD_LINE,
    isCommentLeaf,
    isLayoutTrivia,
    replaceStructuralGap,
    SPACE,
} from "./trivia-policy";

const INDENT = Object.freeze({ kind: "indent" as const, levels: 1 });
const CONTENT_ALIGN = Object.freeze({ kind: "align" as const, columns: 2 });
const SPACE_LEADING_CONTENT_ALIGN = Object.freeze({
    kind: "align" as const,
    columns: 6,
});

export function markerSequenceInRange(
    context: QueryLayoutContext,
    markers: readonly SyntaxMarker[],
    range: LeafRange
): readonly SyntaxMarker[] {
    const result: SyntaxMarker[] = [];
    for (const marker of markers) {
        context.statistics.directLookupCount += 1;
        if (marker.leafId >= range.start && marker.leafId < range.end) {
            result.push(marker);
        }
    }
    return result;
}

export function normalizeMarkerSequence(
    context: QueryLayoutContext,
    authorityNodeId: number,
    markers: readonly SyntaxMarker[]
): boolean {
    for (let index = 1; index < markers.length; index++) {
        context.statistics.directLookupCount += 2;
        const left = markers[index - 1]!;
        const right = markers[index]!;
        if (
            !replaceStructuralGap(
                context,
                authorityNodeId,
                left.leafId + 1,
                right.leafId,
                SPACE
            )
        ) {
            return false;
        }
    }
    return true;
}

export function matchingDelimitersAround(
    context: QueryLayoutContext,
    outer: LeafRange,
    inner: LeafRange
): readonly [number, number] | null {
    for (let leafId = inner.start - 1; leafId >= outer.start; leafId--) {
        context.statistics.leafVisitCount += 1;
        if (
            isLayoutTrivia(context.analysis, leafId) ||
            isCommentLeaf(context.analysis, leafId)
        ) {
            continue;
        }
        const closeLeafId = context.analysis.index.matchingDelimiter(leafId);
        context.statistics.directLookupCount += 1;
        if (
            closeLeafId !== null &&
            closeLeafId >= inner.end &&
            closeLeafId < outer.end
        ) {
            return Object.freeze([leafId, closeLeafId]);
        }
        break;
    }
    return null;
}

export function formatAlias(
    context: QueryLayoutContext,
    authorityNodeId: number,
    valueEndLeafId: number,
    alias: AliasInfo | null
): boolean {
    if (alias === null) {
        return true;
    }
    if (alias.keywordLeafId === null) {
        return replaceStructuralGap(
            context,
            authorityNodeId,
            valueEndLeafId,
            alias.nameLeafRange.start,
            SPACE
        );
    }
    return (
        replaceStructuralGap(
            context,
            authorityNodeId,
            valueEndLeafId,
            alias.keywordLeafId,
            SPACE
        ) &&
        replaceStructuralGap(
            context,
            authorityNodeId,
            alias.keywordLeafId + 1,
            alias.nameLeafRange.start,
            SPACE
        )
    );
}

export function formatFlatList(
    context: QueryLayoutContext,
    authorityNodeId: number,
    list: ListNode
): boolean {
    const members = list.children;
    context.statistics.nodeVisitCount += members.length;
    if (list.separatorLeafIds.length !== Math.max(0, members.length - 1)) {
        return false;
    }
    for (let index = 0; index < list.separatorLeafIds.length; index++) {
        const separatorLeafId = list.separatorLeafIds[index]!;
        const left = members[index]!;
        const right = members[index + 1]!;
        if (
            !replaceStructuralGap(
                context,
                authorityNodeId,
                left.leafRange.end,
                separatorLeafId,
                EMPTY
            ) ||
            !replaceStructuralGap(
                context,
                authorityNodeId,
                separatorLeafId + 1,
                right.leafRange.start,
                SPACE
            )
        ) {
            return false;
        }
    }
    return true;
}

function wrapFirstMultilineMember(
    context: QueryLayoutContext,
    authorityNodeId: number,
    prefixLeafId: number,
    member: SyntaxNode
): boolean {
    if (
        !wrapLayoutRange(
            context,
            authorityNodeId,
            prefixLeafId,
            member.leafRange.end,
            INDENT
        )
    ) {
        return false;
    }
    return context.plan.options.commaStyle !== "leading" ||
        wrapLayoutRange(
            context,
            authorityNodeId,
            prefixLeafId,
            member.leafRange.end,
            CONTENT_ALIGN
        );
}

function needsLeadingContinuationAlign(member: SyntaxNode): boolean {
    return (
        member.kind === "cte" ||
        (member.kind === "relation" && member.relationKind === "subquery")
    );
}

function rangeHasLineComment(
    context: QueryLayoutContext,
    startLeafId: number,
    endLeafId: number
): boolean {
    for (let leafId = startLeafId; leafId < endLeafId; leafId++) {
        context.statistics.leafVisitCount += 1;
        if (context.analysis.leafKind(leafId) === "line-comment") {
            return true;
        }
    }
    return false;
}

export function formatMultilineSequence(
    context: QueryLayoutContext,
    authorityNodeId: number,
    prefixLeafId: number,
    members: readonly SyntaxNode[],
    separatorLeafIds: readonly number[]
): boolean {
    if (
        members.length === 0 ||
        separatorLeafIds.length !== members.length - 1
    ) {
        return false;
    }
    context.statistics.nodeVisitCount += members.length;
    const first = members[0]!;
    const singleSpaceLeading =
        members.length === 1 &&
        context.plan.options.commaStyle === "leading" &&
        context.plan.options.indentStyle === "space";
    if (
        !replaceStructuralGap(
            context,
            authorityNodeId,
            prefixLeafId,
            first.leafRange.start,
            HARD_LINE
        ) ||
        !wrapLayoutRange(
            context,
            authorityNodeId,
            prefixLeafId,
            members[members.length - 1]!.leafRange.end,
            singleSpaceLeading ? SPACE_LEADING_CONTENT_ALIGN : INDENT
        )
    ) {
        return false;
    }
    if (
        context.plan.options.commaStyle === "leading" &&
        !singleSpaceLeading &&
        !wrapLayoutRange(
            context,
            authorityNodeId,
            prefixLeafId,
            first.leafRange.end,
            CONTENT_ALIGN
        )
    ) {
        return false;
    }
    for (let index = 0; index < separatorLeafIds.length; index++) {
        const separatorLeafId = separatorLeafIds[index]!;
        const left = members[index]!;
        const right = members[index + 1]!;
        const beforeSeparator = context.plan.options.commaStyle === "leading"
            ? HARD_LINE
            : EMPTY;
        const afterSeparator = context.plan.options.commaStyle === "leading"
            ? SPACE
            : HARD_LINE;
        if (
            !replaceStructuralGap(
                context,
                authorityNodeId,
                left.leafRange.end,
                separatorLeafId,
                beforeSeparator
            ) ||
            !replaceStructuralGap(
                context,
                authorityNodeId,
                separatorLeafId + 1,
                right.leafRange.start,
                afterSeparator
            ) ||
            (context.plan.options.commaStyle === "leading" &&
                (needsLeadingContinuationAlign(right) ||
                    rangeHasLineComment(
                        context,
                        separatorLeafId + 1,
                        right.leafRange.start
                    )) &&
                !wrapLayoutRange(
                    context,
                    authorityNodeId,
                    right.leafRange.start,
                    right.leafRange.end,
                    CONTENT_ALIGN
                ))
        ) {
            return false;
        }
    }
    return true;
}

export function formatMixedRelationSequence(
    context: QueryLayoutContext,
    authorityNodeId: number,
    prefixLeafId: number,
    members: readonly SyntaxNode[],
    separatorLeafIds: readonly number[]
): boolean {
    if (members.length === 0) {
        return false;
    }
    context.statistics.nodeVisitCount += members.length;
    if (
        separatorLeafIds.length > 0 &&
        separatorLeafIds.length === members.length - 1
    ) {
        return formatMultilineSequence(
            context,
            authorityNodeId,
            prefixLeafId,
            members,
            separatorLeafIds
        );
    }
    const first = members[0]!;
    const commentBreak = commentGapRequiresHardLine(
        context,
        prefixLeafId,
        first.leafRange.start
    );
    if (commentBreak === null) {
        return false;
    }
    const multiline = separatorLeafIds.length > 0 || commentBreak;
    if (
        !replaceStructuralGap(
            context,
            authorityNodeId,
            prefixLeafId,
            first.leafRange.start,
            multiline ? HARD_LINE : SPACE
        )
    ) {
        return false;
    }
    if (multiline) {
        const wrapped = separatorLeafIds.length === 0
            ? wrapLayoutRange(
                  context,
                  authorityNodeId,
                  prefixLeafId,
                  first.leafRange.end,
                  INDENT
              )
            : wrapFirstMultilineMember(
                  context,
                  authorityNodeId,
                  prefixLeafId,
                  first
              );
        if (!wrapped) {
            return false;
        }
    }
    let separatorIndex = 0;
    for (let index = 1; index < members.length; index++) {
        const left = members[index - 1]!;
        const right = members[index]!;
        const separatorLeafId = separatorLeafIds[separatorIndex];
        if (
            separatorLeafId !== undefined &&
            separatorLeafId >= left.leafRange.end &&
            separatorLeafId < right.leafRange.start
        ) {
            const leading = context.plan.options.commaStyle === "leading";
            const scopeStart = leading
                ? left.leafRange.end
                : separatorLeafId + 1;
            if (
                !replaceStructuralGap(
                    context,
                    authorityNodeId,
                    left.leafRange.end,
                    separatorLeafId,
                    leading ? HARD_LINE : EMPTY
                ) ||
                !replaceStructuralGap(
                    context,
                    authorityNodeId,
                    separatorLeafId + 1,
                    right.leafRange.start,
                    leading ? SPACE : HARD_LINE
                ) ||
                !wrapLayoutRange(
                    context,
                    authorityNodeId,
                    scopeStart,
                    right.leafRange.end,
                    INDENT
                ) ||
                (leading &&
                    !wrapLayoutRange(
                        context,
                        authorityNodeId,
                        right.leafRange.start,
                        right.leafRange.end,
                        CONTENT_ALIGN
                    ))
            ) {
                return false;
            }
            separatorIndex += 1;
            continue;
        }
        if (
            !replaceStructuralGap(
                context,
                authorityNodeId,
                left.leafRange.end,
                right.leafRange.start,
                HARD_LINE
            )
        ) {
            return false;
        }
    }
    return separatorIndex === separatorLeafIds.length;
}

export function formatDelimitedList(
    context: QueryLayoutContext,
    authorityNodeId: number,
    outerRange: LeafRange,
    headEndLeafId: number | null,
    list: ListNode,
    spaceBeforeOpen: boolean
): boolean {
    const delimiters = matchingDelimitersAround(
        context,
        outerRange,
        list.leafRange
    );
    if (delimiters === null) {
        return false;
    }
    const [openLeafId, closeLeafId] = delimiters;
    return (
        (headEndLeafId === null ||
            replaceStructuralGap(
                context,
                authorityNodeId,
                headEndLeafId,
                openLeafId,
                spaceBeforeOpen ? SPACE : EMPTY
            )) &&
        replaceStructuralGap(
            context,
            authorityNodeId,
            openLeafId + 1,
            list.leafRange.start,
            EMPTY
        ) &&
        formatFlatList(context, authorityNodeId, list) &&
        replaceStructuralGap(
            context,
            authorityNodeId,
            list.leafRange.end,
            closeLeafId,
            EMPTY
        )
    );
}

export function formatListItemAlias(
    context: QueryLayoutContext,
    item: ListItemNode
): boolean {
    if (item.alias === null || item.itemRole === "type-member") {
        return true;
    }
    const authorityNodeId = authorityForNode(context, item.id);
    if (authorityNodeId === null) {
        return true;
    }
    const value = context.analysis.index.nodeById(item.valueChildId);
    context.statistics.directLookupCount += 1;
    return formatAlias(
        context,
        authorityNodeId,
        value.leafRange.end,
        item.alias
    );
}

export function formatQueryList(
    context: QueryLayoutContext,
    list: ListNode
): boolean {
    const authorityNodeId = authorityForNode(context, list.id);
    if (authorityNodeId === null) {
        return true;
    }
    const parent = context.analysis.index.parentOf(list.id);
    context.statistics.directLookupCount += 1;
    if (parent === null || parent.kind !== "clause") {
        return false;
    }
    if (list.listRole === "select-items" && list.children.length === 1) {
        context.statistics.directLookupCount += 1;
        if (
            context.analysis.index.queryOfClause(parent.id).capabilityId ===
            "select-without-from"
        ) {
            return replaceStructuralGap(
                context,
                authorityNodeId,
                parent.headLeafRange.end,
                list.children[0]!.leafRange.start,
                SPACE
            );
        }
    }
    return formatMultilineSequence(
        context,
        authorityNodeId,
        parent.headLeafRange.end,
        list.children,
        list.separatorLeafIds
    );
}
