import type { AnalyzedArtifact, CommentBinding } from "../analysis/types";
import { isCanonicalAnalyzedArtifact } from "../analysis/artifact";
import type { CanonicalFormatOptions } from "../config/options";
import { isCanonicalFormatOptions } from "../config/resolve-options";
import type {
    ListItemNode,
    ListNode,
} from "../syntax/node";
import type { LeafRange } from "../syntax/leaf-range";
import { measureDisplayText } from "../renderer/display-width";
import { canonicalLayoutArtifactForRenderSuccess } from "../renderer/render";
import type { RenderSuccess } from "../renderer/types";
import { dominatingVerbatimClaims } from "./verbatim-claims";
import type { DominatingVerbatimClaims } from "./verbatim-claims";

export interface LayoutAlignmentTarget {
    readonly leafId: number;
    readonly targetColumn: number;
}

export interface LayoutAlignmentPlan {
    readonly targets: readonly LayoutAlignmentTarget[];
}

interface OutputPosition {
    readonly line: number;
    readonly column: number;
}

interface AlignmentCandidate {
    readonly leafId: number;
    readonly column: number;
    readonly line: number;
}

interface ItemOutputShape {
    readonly firstLine: number;
    readonly lastLine: number;
    readonly lastSyntaxLeafId: number;
    readonly hasMultilineSyntax: boolean;
    readonly hasVerbatim: boolean;
}

interface AlignmentCandidateScope {
    readonly itemIds: ReadonlySet<number>;
    readonly leafRanges: readonly LeafRange[];
}

interface CanonicalAlignmentProof {
    readonly analysis: AnalyzedArtifact;
    readonly options: CanonicalFormatOptions;
}

const CANONICAL_ALIGNMENT_PLANS =
    new WeakMap<object, CanonicalAlignmentProof>();

function canonicalPlan(
    analysis: AnalyzedArtifact,
    options: CanonicalFormatOptions,
    values: readonly LayoutAlignmentTarget[]
): LayoutAlignmentPlan {
    const targets = Object.freeze(values.map((value) => Object.freeze({
        leafId: value.leafId,
        targetColumn: value.targetColumn,
    })));
    const plan = Object.freeze({ targets });
    CANONICAL_ALIGNMENT_PLANS.set(
        plan,
        Object.freeze({ analysis, options })
    );
    return plan;
}

export function isCanonicalLayoutAlignmentPlan(
    value: unknown,
    analysisValue?: unknown,
    optionsValue?: unknown
): value is LayoutAlignmentPlan {
    if (typeof value !== "object" || value === null) {
        return false;
    }
    const proof = CANONICAL_ALIGNMENT_PLANS.get(value);
    return proof !== undefined &&
        (analysisValue === undefined || proof.analysis === analysisValue) &&
        (optionsValue === undefined || proof.options === optionsValue);
}

function firstSourceMapEntryAfter(
    entries: RenderSuccess["sourceMap"]["entries"],
    sourceOffset: number
): number {
    let low = 0;
    let high = entries.length;
    while (low < high) {
        const middle = low + Math.floor((high - low) / 2);
        if (entries[middle]!.source.end <= sourceOffset) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    return low;
}

function sourceLeafOutputStarts(
    analysis: AnalyzedArtifact,
    rendered: RenderSuccess,
    leafRanges: readonly LeafRange[]
): ReadonlyMap<number, number> | null {
    const starts = new Map<number, number>();
    const entries = rendered.sourceMap.entries;
    for (const range of leafRanges) {
        const firstLeaf = analysis.leaves[range.start];
        if (firstLeaf === undefined) {
            return null;
        }
        let entryIndex = firstSourceMapEntryAfter(
            entries,
            firstLeaf.span.start
        );
        for (let leafId = range.start; leafId < range.end; leafId++) {
            const leaf = analysis.leaves[leafId];
            if (leaf === undefined) {
                return null;
            }
            while (
                entryIndex < entries.length &&
                entries[entryIndex]!.source.end <= leaf.span.start
            ) {
                entryIndex += 1;
            }
            const entry = entries[entryIndex];
            if (
                entry === undefined ||
                entry.source.start > leaf.span.start ||
                entry.source.end < leaf.span.end
            ) {
                continue;
            }
            const outputStart =
                entry.output.start + leaf.span.start - entry.source.start;
            if (
                outputStart < 0 ||
                outputStart > rendered.text.length -
                    (leaf.span.end - leaf.span.start)
            ) {
                return null;
            }
            starts.set(leaf.id, outputStart);
        }
    }
    return starts;
}

function outputLineStarts(text: string): readonly number[] {
    const starts = [0];
    for (let offset = 0; offset < text.length; offset++) {
        const code = text.charCodeAt(offset);
        if (code !== 10 && code !== 13) {
            continue;
        }
        const width =
            code === 13 && text.charCodeAt(offset + 1) === 10 ? 2 : 1;
        starts.push(offset + width);
        offset += width - 1;
    }
    return Object.freeze(starts);
}

function outputPositions(
    text: string,
    lineStarts: readonly number[],
    outputStarts: ReadonlyMap<number, number>
): ReadonlyMap<number, OutputPosition> | null {
    const positions = new Map<number, OutputPosition>();
    const offsets = Array.from(new Set(outputStarts.values()))
        .sort((left, right) => left - right);
    let line = 0;
    let cursor = 0;
    let column = 0;
    for (const offset of offsets) {
        if (offset < 0 || offset > text.length) {
            return null;
        }
        while (
            line + 1 < lineStarts.length &&
            lineStarts[line + 1]! <= offset
        ) {
            line += 1;
            cursor = lineStarts[line]!;
            column = 0;
        }
        if (offset < cursor) {
            return null;
        }
        const measured = measureDisplayText(
            text.slice(cursor, offset),
            column
        );
        if (measured === null || measured.containsLineBreak) {
            return null;
        }
        column = measured.endColumn;
        cursor = offset;
        positions.set(offset, Object.freeze({ line, column }));
    }
    return positions;
}

function buildCandidateItemShapes(
    analysis: AnalyzedArtifact,
    items: readonly ListItemNode[],
    outputStarts: ReadonlyMap<number, number>,
    positionOf: (offset: number) => OutputPosition | null
): ReadonlyMap<number, Omit<ItemOutputShape, "hasVerbatim">> | null {
    const shapes = new Map<number, Omit<ItemOutputShape, "hasVerbatim">>();
    for (const item of items) {
        let firstLine = -1;
        let lastLine = -1;
        let lastSyntaxLeafId = -1;
        let hasMultilineSyntax = false;
        for (
            let leafId = item.leafRange.start;
            leafId < item.leafRange.end;
            leafId++
        ) {
            if (analysis.index.leafContext(leafId).syntax === null) {
                continue;
            }
            const outputStart = outputStarts.get(leafId);
            const position = outputStart === undefined
                ? null
                : positionOf(outputStart);
            if (position === null) {
                return null;
            }
            if (firstLine < 0) {
                firstLine = position.line;
            }
            lastLine = position.line;
            lastSyntaxLeafId = leafId;
            hasMultilineSyntax ||=
                analysis.index.leafContainsLineBreak(leafId);
        }
        if (firstLine < 0 || lastLine < 0 || lastSyntaxLeafId < 0) {
            return null;
        }
        shapes.set(item.id, Object.freeze({
            firstLine,
            lastLine,
            lastSyntaxLeafId,
            hasMultilineSyntax,
        }));
    }
    return shapes;
}

function rangeHasVerbatimClaim(
    claims: DominatingVerbatimClaims,
    range: LeafRange
): boolean {
    let low = 0;
    let high = claims.claims.length;
    while (low < high) {
        const middle = low + Math.floor((high - low) / 2);
        if (claims.claims[middle]!.leafRange.end <= range.start) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    const claim = claims.claims[low];
    return claim !== undefined && claim.leafRange.start < range.end;
}

function flushCandidateGroup(
    candidates: AlignmentCandidate[],
    maximumColumn: number,
    targets: Map<number, number>
): void {
    if (candidates.length < 2) {
        candidates.length = 0;
        return;
    }
    let targetColumn = 0;
    for (const candidate of candidates) {
        targetColumn = Math.max(targetColumn, candidate.column);
    }
    if (targetColumn > 0 && targetColumn < maximumColumn) {
        for (const candidate of candidates) {
            if (candidate.column < targetColumn) {
                targets.set(candidate.leafId, targetColumn);
            }
        }
    }
    candidates.length = 0;
}

function appendCandidateGroup(
    candidates: AlignmentCandidate[],
    candidate: AlignmentCandidate | null,
    maximumColumn: number,
    targets: Map<number, number>
): void {
    if (candidate === null) {
        flushCandidateGroup(candidates, maximumColumn, targets);
        return;
    }
    const previous = candidates[candidates.length - 1];
    if (previous !== undefined && candidate.line !== previous.line + 1) {
        flushCandidateGroup(candidates, maximumColumn, targets);
    }
    candidates.push(candidate);
}

function explicitAliasCandidate(
    shape: ItemOutputShape | null,
    outputStarts: ReadonlyMap<number, number>,
    positionOf: (offset: number) => OutputPosition | null,
    item: ListItemNode,
    maximumColumn: number
): AlignmentCandidate | null {
    const asLeafId = item.alias?.keywordLeafId ?? null;
    if (asLeafId === null) {
        return null;
    }
    const outputStart = outputStarts.get(asLeafId);
    const position = outputStart === undefined ? null : positionOf(outputStart);
    if (
        shape === null ||
        position === null ||
        shape.hasMultilineSyntax ||
        shape.hasVerbatim ||
        shape.firstLine !== shape.lastLine ||
        shape.firstLine !== position.line ||
        position.column >= maximumColumn
    ) {
        return null;
    }
    return Object.freeze({
        leafId: asLeafId,
        column: position.column,
        line: position.line,
    });
}

function trailingCommentsByItem(
    analysis: AnalyzedArtifact
): ReadonlyMap<number, readonly CommentBinding[]> | null {
    const mutable = new Map<number, CommentBinding[]>();
    for (const binding of analysis.index.commentBindings()) {
        if (binding.placement !== "trailing") {
            continue;
        }
        const owner = analysis.index.nodeById(binding.ownerNodeId);
        const item = owner.kind === "list-item"
            ? owner
            : analysis.index.nearestAncestor(owner.id, "list-item");
        if (item === null || item.kind !== "list-item") {
            continue;
        }
        const values = mutable.get(item.id) ?? [];
        values.push(binding);
        mutable.set(item.id, values);
    }
    const frozen = new Map<number, readonly CommentBinding[]>();
    for (const [itemId, values] of mutable) {
        frozen.set(itemId, Object.freeze(values));
    }
    return frozen;
}

function mergedLeafRanges(values: readonly LeafRange[]): readonly LeafRange[] {
    const sorted = values.slice().sort((left, right) =>
        left.start - right.start || left.end - right.end
    );
    const merged: LeafRange[] = [];
    for (const range of sorted) {
        const previous = merged[merged.length - 1];
        if (previous !== undefined && range.start <= previous.end) {
            merged[merged.length - 1] = Object.freeze({
                start: previous.start,
                end: Math.max(previous.end, range.end),
            });
        } else {
            merged.push(Object.freeze({ ...range }));
        }
    }
    return Object.freeze(merged);
}

function candidateScope(
    lists: readonly ListNode[],
    comments: ReadonlyMap<number, readonly CommentBinding[]>
): AlignmentCandidateScope {
    const itemIds = new Set<number>();
    const itemsById = new Map<number, ListItemNode>();
    const flush = (run: ListItemNode[]): void => {
        if (run.length >= 2) {
            for (const item of run) {
                itemIds.add(item.id);
                itemsById.set(item.id, item);
            }
        }
        run.length = 0;
    };
    for (const list of lists) {
        const aliasRun: ListItemNode[] = [];
        const commentRun: ListItemNode[] = [];
        for (const item of list.children) {
            if (item.alias !== null && item.alias.keywordLeafId !== null) {
                aliasRun.push(item);
            } else {
                flush(aliasRun);
            }
            if (comments.get(item.id)?.length === 1) {
                commentRun.push(item);
            } else {
                flush(commentRun);
            }
        }
        flush(aliasRun);
        flush(commentRun);
    }
    const ranges: LeafRange[] = [];
    for (const item of itemsById.values()) {
        ranges.push(item.leafRange);
        for (const binding of comments.get(item.id) ?? []) {
            ranges.push(Object.freeze({
                start: binding.commentLeafId,
                end: binding.commentLeafId + 1,
            }));
        }
    }
    return Object.freeze({
        itemIds,
        leafRanges: mergedLeafRanges(ranges),
    });
}

function trailingCommentCandidate(
    analysis: AnalyzedArtifact,
    shape: ItemOutputShape | null,
    outputStarts: ReadonlyMap<number, number>,
    positionOf: (offset: number) => OutputPosition | null,
    bindings: readonly CommentBinding[] | undefined,
    maximumColumn: number
): AlignmentCandidate | null {
    if (bindings?.length !== 1) {
        return null;
    }
    const binding = bindings[0]!;
    if (analysis.index.leafContainsLineBreak(binding.commentLeafId)) {
        return null;
    }
    const outputStart = outputStarts.get(binding.commentLeafId);
    const position = outputStart === undefined ? null : positionOf(outputStart);
    if (
        shape === null ||
        position === null ||
        shape.hasMultilineSyntax ||
        shape.hasVerbatim ||
        shape.firstLine !== shape.lastLine ||
        shape.lastLine !== position.line ||
        binding.commentLeafId <= shape.lastSyntaxLeafId ||
        position.column >= maximumColumn
    ) {
        return null;
    }
    return Object.freeze({
        leafId: binding.commentLeafId,
        column: position.column,
        line: position.line,
    });
}

/** Derives renderer-column targets without inspecting SQL text or source raw. */
export function deriveLayoutAlignmentPlan(
    analysis: AnalyzedArtifact,
    options: CanonicalFormatOptions,
    rendered: RenderSuccess
): LayoutAlignmentPlan | null {
    try {
        if (
            !isCanonicalAnalyzedArtifact(analysis) ||
            !isCanonicalFormatOptions(options)
        ) {
            return null;
        }
        const renderedArtifact =
            canonicalLayoutArtifactForRenderSuccess(rendered);
        if (
            renderedArtifact === null ||
            renderedArtifact.analysis !== analysis ||
            renderedArtifact.options !== options
        ) {
            return null;
        }
        const lists = analysis.index.lists();
        const comments = trailingCommentsByItem(analysis);
        if (comments === null) {
            return null;
        }
        const scope = candidateScope(lists, comments);
        if (scope.itemIds.size === 0) {
            return canonicalPlan(analysis, options, []);
        }
        const outputStarts = sourceLeafOutputStarts(
            analysis,
            rendered,
            scope.leafRanges
        );
        if (outputStarts === null) {
            return null;
        }
        const claims = dominatingVerbatimClaims(analysis);
        if (claims === null) {
            return null;
        }
        const lineStarts = outputLineStarts(rendered.text);
        const positions = outputPositions(
            rendered.text,
            lineStarts,
            outputStarts
        );
        if (positions === null) {
            return null;
        }
        const positionOf = (offset: number): OutputPosition | null =>
            positions.get(offset) ?? null;
        const candidateItems: ListItemNode[] = [];
        const seenCandidateItemIds = new Set<number>();
        for (const list of lists) {
            for (const item of list.children) {
                if (
                    scope.itemIds.has(item.id) &&
                    !seenCandidateItemIds.has(item.id)
                ) {
                    candidateItems.push(item);
                    seenCandidateItemIds.add(item.id);
                }
            }
        }
        if (candidateItems.length !== scope.itemIds.size) {
            return null;
        }
        const baseShapes = buildCandidateItemShapes(
            analysis,
            candidateItems,
            outputStarts,
            positionOf
        );
        if (baseShapes === null) {
            return null;
        }
        const shapes = new Map<number, ItemOutputShape>();
        for (const item of candidateItems) {
            const baseShape = baseShapes.get(item.id);
            if (baseShape === undefined) {
                return null;
            }
            shapes.set(item.id, Object.freeze({
                ...baseShape,
                hasVerbatim: rangeHasVerbatimClaim(claims, item.leafRange),
            }));
        }
        const targets = new Map<number, number>();
        for (const list of lists) {
            const aliasGroup: AlignmentCandidate[] = [];
            const commentGroup: AlignmentCandidate[] = [];
            for (const item of list.children) {
                const alias = explicitAliasCandidate(
                    shapes.get(item.id) ?? null,
                    outputStarts,
                    positionOf,
                    item,
                    options.maxAlignWidth
                );
                appendCandidateGroup(
                    aliasGroup,
                    alias,
                    options.maxAlignWidth,
                    targets
                );
                const comment = trailingCommentCandidate(
                    analysis,
                    shapes.get(item.id) ?? null,
                    outputStarts,
                    positionOf,
                    comments.get(item.id),
                    options.maxAlignWidth
                );
                appendCandidateGroup(
                    commentGroup,
                    comment,
                    options.maxAlignWidth,
                    targets
                );
            }
            flushCandidateGroup(aliasGroup, options.maxAlignWidth, targets);
            flushCandidateGroup(commentGroup, options.maxAlignWidth, targets);
        }
        const values: LayoutAlignmentTarget[] = Array.from(targets)
            .sort(([leftLeafId], [rightLeafId]) =>
                leftLeafId - rightLeafId
            )
            .map(([leafId, targetColumn]) => ({ leafId, targetColumn }));
        return canonicalPlan(analysis, options, values);
    } catch {
        return null;
    }
}
