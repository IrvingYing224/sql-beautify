import type { AnalyzedArtifact, CommentBinding } from "../analysis/types";
import { isCanonicalAnalyzedArtifact } from "../analysis/artifact";
import type { CanonicalFormatOptions } from "../config/options";
import { isCanonicalFormatOptions } from "../config/resolve-options";
import type {
    ListItemNode,
    ListNode,
    SyntaxNode,
} from "../syntax/node";
import { measureDisplayText } from "../renderer/display-width";
import { canonicalLayoutArtifactForRenderSuccess } from "../renderer/render";
import type { RenderSuccess } from "../renderer/types";
import { dominatingVerbatimClaims } from "./verbatim-claims";

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

interface ItemOutputShapeProjection {
    readonly firstLineByNodeId: Int32Array;
    readonly lastLineByNodeId: Int32Array;
    readonly lastSyntaxLeafByNodeId: Int32Array;
    readonly multilineSyntaxByNodeId: Uint8Array;
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

function sourceLeafOutputStarts(
    analysis: AnalyzedArtifact,
    rendered: RenderSuccess
): Int32Array | null {
    const starts = new Int32Array(analysis.leaves.length);
    starts.fill(-1);
    const entries = rendered.sourceMap.entries;
    let entryIndex = 0;
    for (const leaf of analysis.leaves) {
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
        starts[leaf.id] = outputStart;
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
    outputStarts: Int32Array
): ReadonlyMap<number, OutputPosition> | null {
    const positions = new Map<number, OutputPosition>();
    let previousOffset = -1;
    let line = 0;
    let cursor = 0;
    let column = 0;
    for (const offset of outputStarts) {
        if (offset < 0) {
            continue;
        }
        if (offset < previousOffset || offset > text.length) {
            return null;
        }
        previousOffset = offset;
        if (positions.has(offset)) {
            continue;
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

function buildItemOutputShapeProjection(
    analysis: AnalyzedArtifact,
    outputStarts: Int32Array,
    positionOf: (offset: number) => OutputPosition | null
): ItemOutputShapeProjection | null {
    const nodes = analysis.index.nodes();
    const firstLeafByNodeId = new Int32Array(nodes.length);
    const lastLeafByNodeId = new Int32Array(nodes.length);
    const firstLineByNodeId = new Int32Array(nodes.length);
    const lastLineByNodeId = new Int32Array(nodes.length);
    const multilineSyntaxByNodeId = new Uint8Array(nodes.length);
    firstLeafByNodeId.fill(-1);
    lastLeafByNodeId.fill(-1);
    firstLineByNodeId.fill(-1);
    lastLineByNodeId.fill(-1);

    for (let leafId = 0; leafId < analysis.leaves.length; leafId++) {
        const facts = analysis.index.leafContext(leafId);
        if (facts.syntax === null) {
            continue;
        }
        const ownerNodeId = facts.syntax.directOwnerNodeId;
        if (ownerNodeId < 0 || ownerNodeId >= nodes.length) {
            return null;
        }
        const outputStart = outputStarts[leafId]!;
        if (outputStart < 0) {
            return null;
        }
        const position = positionOf(outputStart);
        if (position === null) {
            return null;
        }
        if (firstLeafByNodeId[ownerNodeId]! < 0) {
            firstLeafByNodeId[ownerNodeId] = leafId;
            firstLineByNodeId[ownerNodeId] = position.line;
        }
        lastLeafByNodeId[ownerNodeId] = leafId;
        lastLineByNodeId[ownerNodeId] = position.line;
        if (analysis.index.leafContainsLineBreak(leafId)) {
            multilineSyntaxByNodeId[ownerNodeId] = 1;
        }
    }

    const order: SyntaxNode[] = [];
    const work: SyntaxNode[] = [analysis.root];
    while (work.length > 0) {
        const node = work.pop()!;
        order.push(node);
        const children = analysis.index.childrenOf(node.id);
        for (let index = children.length - 1; index >= 0; index--) {
            work.push(children[index]!);
        }
    }
    if (order.length !== nodes.length) {
        return null;
    }
    for (let index = order.length - 1; index >= 0; index--) {
        const node = order[index]!;
        for (const child of analysis.index.childrenOf(node.id)) {
            const childFirstLeaf = firstLeafByNodeId[child.id]!;
            if (
                childFirstLeaf >= 0 &&
                (firstLeafByNodeId[node.id]! < 0 ||
                    childFirstLeaf < firstLeafByNodeId[node.id]!)
            ) {
                firstLeafByNodeId[node.id] = childFirstLeaf;
                firstLineByNodeId[node.id] = firstLineByNodeId[child.id]!;
            }
            const childLastLeaf = lastLeafByNodeId[child.id]!;
            if (childLastLeaf > lastLeafByNodeId[node.id]!) {
                lastLeafByNodeId[node.id] = childLastLeaf;
                lastLineByNodeId[node.id] = lastLineByNodeId[child.id]!;
            }
            if (multilineSyntaxByNodeId[child.id] === 1) {
                multilineSyntaxByNodeId[node.id] = 1;
            }
        }
    }
    return Object.freeze({
        firstLineByNodeId,
        lastLineByNodeId,
        lastSyntaxLeafByNodeId: lastLeafByNodeId,
        multilineSyntaxByNodeId,
    });
}

function itemOutputShape(
    projection: ItemOutputShapeProjection,
    item: ListItemNode,
    verbatimPrefix: Int32Array
): ItemOutputShape | null {
    const firstLine = projection.firstLineByNodeId[item.id];
    const lastLine = projection.lastLineByNodeId[item.id];
    const lastSyntaxLeafId = projection.lastSyntaxLeafByNodeId[item.id];
    const hasMultilineSyntax = projection.multilineSyntaxByNodeId[item.id];
    return firstLine === undefined || firstLine < 0 ||
        lastLine === undefined || lastLine < 0 ||
        lastSyntaxLeafId === undefined || lastSyntaxLeafId < 0 ||
        hasMultilineSyntax === undefined
        ? null
        : Object.freeze({
              firstLine,
              lastLine,
              lastSyntaxLeafId,
              hasMultilineSyntax: hasMultilineSyntax === 1,
              hasVerbatim:
                  verbatimPrefix[item.leafRange.end]! -
                      verbatimPrefix[item.leafRange.start]! >
                  0,
          });
}

function flushCandidateGroup(
    candidates: AlignmentCandidate[],
    maximumColumn: number,
    targets: Int32Array
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
                targets[candidate.leafId] = targetColumn;
            }
        }
    }
    candidates.length = 0;
}

function appendCandidateGroup(
    candidates: AlignmentCandidate[],
    candidate: AlignmentCandidate | null,
    maximumColumn: number,
    targets: Int32Array
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
    projection: ItemOutputShapeProjection,
    outputStarts: Int32Array,
    positionOf: (offset: number) => OutputPosition | null,
    item: ListItemNode,
    maximumColumn: number,
    verbatimPrefix: Int32Array
): AlignmentCandidate | null {
    const asLeafId = item.alias?.keywordLeafId ?? null;
    if (asLeafId === null) {
        return null;
    }
    const shape = itemOutputShape(projection, item, verbatimPrefix);
    const outputStart = outputStarts[asLeafId]!;
    const position = outputStart < 0 ? null : positionOf(outputStart);
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

function nearestListItemProjection(
    analysis: AnalyzedArtifact,
): Int32Array | null {
    const nodes = analysis.index.nodes();
    const projection = new Int32Array(nodes.length);
    projection.fill(-1);
    const work: Array<readonly [SyntaxNode, number]> = [
        [analysis.root, -1],
    ];
    let visited = 0;
    while (work.length > 0) {
        const [node, inheritedListItemId] = work.pop()!;
        if (node.id < 0 || node.id >= projection.length) {
            return null;
        }
        const listItemId = node.kind === "list-item"
            ? node.id
            : inheritedListItemId;
        projection[node.id] = listItemId;
        visited += 1;
        const children = analysis.index.childrenOf(node.id);
        for (let index = children.length - 1; index >= 0; index--) {
            work.push([children[index]!, listItemId]);
        }
    }
    return visited === nodes.length ? projection : null;
}

function trailingCommentsByItem(
    analysis: AnalyzedArtifact
): ReadonlyMap<number, readonly CommentBinding[]> | null {
    const listItemByNodeId = nearestListItemProjection(analysis);
    if (listItemByNodeId === null) {
        return null;
    }
    const mutable = new Map<number, CommentBinding[]>();
    for (const binding of analysis.index.commentBindings()) {
        if (binding.placement !== "trailing") {
            continue;
        }
        const itemId = listItemByNodeId[binding.ownerNodeId];
        if (itemId === undefined || itemId < 0) {
            continue;
        }
        const values = mutable.get(itemId) ?? [];
        values.push(binding);
        mutable.set(itemId, values);
    }
    const frozen = new Map<number, readonly CommentBinding[]>();
    for (const [itemId, values] of mutable) {
        frozen.set(itemId, Object.freeze(values));
    }
    return frozen;
}

function hasPotentialAlignmentGroup(
    lists: readonly ListNode[],
    comments: ReadonlyMap<number, readonly CommentBinding[]>
): boolean {
    for (const list of lists) {
        let aliasRun = 0;
        let commentRun = 0;
        for (const item of list.children) {
            aliasRun =
                item.alias !== null && item.alias.keywordLeafId !== null
                    ? aliasRun + 1
                    : 0;
            commentRun = comments.get(item.id)?.length === 1
                ? commentRun + 1
                : 0;
            if (aliasRun >= 2 || commentRun >= 2) {
                return true;
            }
        }
    }
    return false;
}

function trailingCommentCandidate(
    analysis: AnalyzedArtifact,
    projection: ItemOutputShapeProjection,
    outputStarts: Int32Array,
    positionOf: (offset: number) => OutputPosition | null,
    item: ListItemNode,
    bindings: readonly CommentBinding[] | undefined,
    maximumColumn: number,
    verbatimPrefix: Int32Array
): AlignmentCandidate | null {
    if (bindings?.length !== 1) {
        return null;
    }
    const binding = bindings[0]!;
    if (analysis.index.leafContainsLineBreak(binding.commentLeafId)) {
        return null;
    }
    const shape = itemOutputShape(projection, item, verbatimPrefix);
    const outputStart = outputStarts[binding.commentLeafId]!;
    const position = outputStart < 0 ? null : positionOf(outputStart);
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
        if (!hasPotentialAlignmentGroup(lists, comments)) {
            return canonicalPlan(analysis, options, []);
        }
        const outputStarts = sourceLeafOutputStarts(analysis, rendered);
        if (outputStarts === null) {
            return null;
        }
        const claims = dominatingVerbatimClaims(analysis);
        if (claims === null) {
            return null;
        }
        const verbatimDeltas = new Int32Array(analysis.leaves.length + 1);
        for (const claim of claims.claims) {
            verbatimDeltas[claim.leafRange.start] =
                verbatimDeltas[claim.leafRange.start]! + 1;
            verbatimDeltas[claim.leafRange.end] =
                verbatimDeltas[claim.leafRange.end]! - 1;
        }
        const verbatimPrefix = new Int32Array(analysis.leaves.length + 1);
        let activeVerbatim = 0;
        for (let leafId = 0; leafId < analysis.leaves.length; leafId++) {
            activeVerbatim += verbatimDeltas[leafId]!;
            verbatimPrefix[leafId + 1] =
                verbatimPrefix[leafId]! + (activeVerbatim > 0 ? 1 : 0);
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
        const shapeProjection = buildItemOutputShapeProjection(
            analysis,
            outputStarts,
            positionOf
        );
        if (shapeProjection === null) {
            return null;
        }
        const targets = new Int32Array(analysis.leaves.length);
        for (const list of lists) {
            const aliasGroup: AlignmentCandidate[] = [];
            const commentGroup: AlignmentCandidate[] = [];
            for (const item of list.children) {
                const alias = explicitAliasCandidate(
                    shapeProjection,
                    outputStarts,
                    positionOf,
                    item,
                    options.maxAlignWidth,
                    verbatimPrefix
                );
                appendCandidateGroup(
                    aliasGroup,
                    alias,
                    options.maxAlignWidth,
                    targets
                );
                const comment = trailingCommentCandidate(
                    analysis,
                    shapeProjection,
                    outputStarts,
                    positionOf,
                    item,
                    comments.get(item.id),
                    options.maxAlignWidth,
                    verbatimPrefix
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
        const values: LayoutAlignmentTarget[] = [];
        for (let leafId = 0; leafId < targets.length; leafId++) {
            const targetColumn = targets[leafId]!;
            if (targetColumn > 0) {
                values.push({ leafId, targetColumn });
            }
        }
        return canonicalPlan(analysis, options, values);
    } catch {
        return null;
    }
}
