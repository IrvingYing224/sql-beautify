import type { LeafRange } from "../syntax/leaf-range";
import type { LayoutGapDecision } from "./plan";
import type {
    AliasInfo,
    ListItemNode,
    ListNode,
    SyntaxMarker,
    SyntaxNode,
} from "../syntax/node";
import {
    authorityForNode,
    leadingCommentStart,
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
    markers: readonly SyntaxMarker[],
    range: LeafRange
): readonly SyntaxMarker[] {
    const result: SyntaxMarker[] = [];
    for (const marker of markers) {
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
        if (
            isLayoutTrivia(context.analysis, leafId) ||
            isCommentLeaf(context.analysis, leafId)
        ) {
            continue;
        }
        const closeLeafId = context.analysis.index.matchingDelimiter(leafId);
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
    list: ListNode,
    afterSeparator: LayoutGapDecision = SPACE
): boolean {
    const members = list.children;
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
                afterSeparator
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

interface RangeCommentFacts {
    readonly hasLineComment: boolean;
    readonly hasTrailingComment: boolean;
    /** A comment here ends a line: a line comment, or a comment with a source line break. */
    readonly breaksLine: boolean;
}

function rangeCommentFacts(
    context: QueryLayoutContext,
    startLeafId: number,
    endLeafId: number
): RangeCommentFacts | null {
    let hasComment = false;
    let hasLineComment = false;
    let hasTrailingComment = false;
    for (let leafId = startLeafId; leafId < endLeafId; leafId++) {
        const kind = context.analysis.leafKind(leafId);
        if (kind === "line-comment") {
            hasLineComment = true;
        }
        if (kind === "line-comment" || kind === "block-comment") {
            const binding = context.analysis.index.commentBinding(leafId);
            if (binding === null || binding.commentLeafId !== leafId) {
                return null;
            }
            hasComment = true;
            hasTrailingComment ||= binding.placement === "trailing";
        }
    }
    let breaksLine = hasLineComment;
    if (!breaksLine && hasComment) {
        try {
            breaksLine = context.analysis.index.rangeContainsLineBreak({
                start: startLeafId,
                end: endLeafId,
            });
        } catch {
            return null;
        }
    }
    return Object.freeze({ hasLineComment, hasTrailingComment, breaksLine });
}

interface SeparatorComments {
    readonly before: RangeCommentFacts;
    readonly after: RangeCommentFacts;
}

function separatorComments(
    context: QueryLayoutContext,
    leftEndLeafId: number,
    separatorLeafId: number,
    rightStartLeafId: number
): SeparatorComments | null {
    const before = rangeCommentFacts(context, leftEndLeafId, separatorLeafId);
    const after = rangeCommentFacts(context, separatorLeafId + 1, rightStartLeafId);
    return before === null || after === null ? null : { before, after };
}

/** A comment written after the comma stays with the left member, so the comma cannot lead. */
function separatorCanLead(comments: SeparatorComments): boolean {
    return !comments.after.hasTrailingComment && !comments.after.breaksLine;
}

/** A comment before the comma that ends the line leaves the comma to lead the next one. */
function separatorCanTrail(comments: SeparatorComments): boolean {
    return !comments.before.breaksLine;
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
    const separators: SeparatorComments[] = [];
    for (let index = 0; index < separatorLeafIds.length; index++) {
        const comments = separatorComments(
            context,
            members[index]!.leafRange.end,
            separatorLeafIds[index]!,
            members[index + 1]!.leafRange.start
        );
        if (comments === null) {
            return false;
        }
        separators.push(comments);
    }
    // The whole list takes the configured comma style when every comma allows it, else the
    // other style when every comma allows that (K1, K2); only when neither fits does each comma
    // choose on its own. Members line up on the content column whenever any comma leads.
    const preferred = context.plan.options.commaStyle;
    const allLead = separators.every(separatorCanLead);
    const allTrail = separators.every(separatorCanTrail);
    const listStyle = preferred === "leading"
        ? (allLead ? "leading" : allTrail ? "trailing" : null)
        : (allTrail ? "trailing" : allLead ? "leading" : null);
    const leads = separators.map((comments) =>
        listStyle !== null
            ? listStyle === "leading"
            : preferred === "leading"
              ? separatorCanLead(comments)
              : !separatorCanTrail(comments)
    );
    const contentAligned = preferred === "leading" || leads.includes(true);
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
        contentAligned &&
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
        const useLeadingSeparator = leads[index]!;
        if (useLeadingSeparator && preferred === "trailing") {
            context.state.commaFallback = true;
        }
        const beforeSeparator = useLeadingSeparator
            ? HARD_LINE
            : EMPTY;
        const afterSeparator = useLeadingSeparator
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
            // Every member sits on the content column, so lines inside a later member line up with
            // the same lines in the first one (K5).
            contentAligned &&
                !wrapLayoutRange(
                    context,
                    authorityNodeId,
                    leadingCommentStart(context, separatorLeafId + 1, right.leafRange.start),
                    right.leafRange.end,
                    CONTENT_ALIGN
                )
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
            const comments = separatorComments(
                context,
                left.leafRange.end,
                separatorLeafId,
                right.leafRange.start
            );
            if (comments === null) {
                return false;
            }
            const preferred = context.plan.options.commaStyle;
            const leading = preferred === "leading"
                ? separatorCanLead(comments)
                : !separatorCanTrail(comments);
            if (leading && preferred === "trailing") {
                context.state.commaFallback = true;
            }
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
                ((leading || preferred === "leading") &&
                    !wrapLayoutRange(
                        context,
                        authorityNodeId,
                        leading
                            ? right.leafRange.start
                            : leadingCommentStart(context, separatorLeafId + 1, right.leafRange.start),
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
    if (parent === null || parent.kind !== "clause") {
        return false;
    }
    if (list.listRole === "select-items" && list.children.length === 1) {
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
