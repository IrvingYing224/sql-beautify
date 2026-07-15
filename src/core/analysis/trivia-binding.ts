import type { SourceLeaf } from "../lexer/token";
import type { ProgramNode, SyntaxNode } from "../syntax/node";
import { freezeImmutableArray } from "../util/immutable-array";

export type TriviaPlacement = "leading" | "trailing" | "dangling";

export interface CommentBinding {
    readonly commentLeafId: number;
    readonly ownerNodeId: number;
    readonly placement: TriviaPlacement;
}

interface NodeMeta {
    readonly node: SyntaxNode;
    readonly depth: number;
}

interface LineFacts {
    readonly startLineByLeaf: readonly number[];
    readonly endLineByLeaf: readonly number[];
    readonly blankLinePrefix: readonly number[];
}

const LEADING_PRIORITY: Readonly<Record<SyntaxNode["kind"], number>> = Object.freeze({
    program: 0,
    statement: 100,
    query: 70,
    cte: 90,
    clause: 95,
    relation: 85,
    list: 60,
    "list-item": 80,
    expression: 50,
    "case-branch": 88,
    "window-spec": 65,
    "type-expression": 55,
    opaque: 0,
});

const TRAILING_PRIORITY: Readonly<Record<SyntaxNode["kind"], number>> = Object.freeze({
    program: 0,
    statement: 20,
    query: 40,
    cte: 75,
    clause: 50,
    relation: 80,
    list: 45,
    "list-item": 100,
    expression: 70,
    "case-branch": 90,
    "window-spec": 65,
    "type-expression": 70,
    opaque: 0,
});

function isComment(leaf: SourceLeaf): boolean {
    return leaf.kind === "line-comment" || leaf.kind === "block-comment";
}

function isSyntax(leaf: SourceLeaf): boolean {
    return leaf.channel === "code" || leaf.channel === "protected";
}

function isProvenContainerOpener(leaf: SourceLeaf, container: SyntaxNode): boolean {
    if (leaf.channel !== "code") {
        return false;
    }
    if (leaf.raw === "(" || leaf.raw === "[") {
        return true;
    }
    return leaf.raw === "<" && container.kind === "type-expression";
}

function addMeta(
    byBoundary: Map<number, NodeMeta[]>,
    boundary: number,
    meta: NodeMeta
): void {
    const existing = byBoundary.get(boundary);
    if (existing === undefined) {
        byBoundary.set(boundary, [meta]);
    } else {
        existing.push(meta);
    }
}

function updatePreferredOwner(
    owners: Map<number, NodeMeta>,
    boundary: number,
    candidate: NodeMeta,
    priorities: Readonly<Record<SyntaxNode["kind"], number>>
): void {
    if (candidate.node.kind === "opaque") {
        return;
    }
    const selected = owners.get(boundary);
    if (
        selected === undefined ||
        priorities[candidate.node.kind] > priorities[selected.node.kind] ||
        (priorities[candidate.node.kind] === priorities[selected.node.kind] &&
            candidate.depth > selected.depth)
    ) {
        owners.set(boundary, candidate);
    }
}

function buildLineFacts(leaves: readonly SourceLeaf[]): LineFacts {
    const startLineByLeaf: number[] = [];
    const endLineByLeaf: number[] = [];
    const lineHasContent: boolean[] = [false];
    let line = 0;

    for (let leafIndex = 0; leafIndex < leaves.length; leafIndex++) {
        const leaf = leaves[leafIndex]!;
        const content = leaf.kind !== "whitespace" && leaf.kind !== "newline";
        startLineByLeaf.push(line);
        if (content && leaf.raw.length > 0) {
            lineHasContent[line] = true;
        }

        for (let offset = 0; offset < leaf.raw.length; offset++) {
            const code = leaf.raw.charCodeAt(offset);
            if (code !== 10 && code !== 13) {
                continue;
            }
            if (code === 13 && leaf.raw.charCodeAt(offset + 1) === 10) {
                offset += 1;
            }
            line += 1;
            lineHasContent[line] = false;
            if (content && offset + 1 < leaf.raw.length) {
                lineHasContent[line] = true;
            }
        }
        endLineByLeaf.push(line);
    }

    const blankLinePrefix: number[] = [0];
    for (let lineIndex = 0; lineIndex < lineHasContent.length; lineIndex++) {
        blankLinePrefix.push(
            blankLinePrefix[lineIndex]! + (lineHasContent[lineIndex] === true ? 0 : 1)
        );
    }

    return Object.freeze({
        startLineByLeaf: freezeImmutableArray(startLineByLeaf),
        endLineByLeaf: freezeImmutableArray(endLineByLeaf),
        blankLinePrefix: freezeImmutableArray(blankLinePrefix),
    });
}

function hasBlankLineBeforeNextSyntax(
    commentIndex: number,
    nextSyntaxIndex: number,
    lineFacts: LineFacts
): boolean {
    const commentEndLine = lineFacts.endLineByLeaf[commentIndex]!;
    const nextStartLine = lineFacts.startLineByLeaf[nextSyntaxIndex]!;
    const firstLineAfterComment = commentEndLine + 1;
    return firstLineAfterComment < nextStartLine &&
        lineFacts.blankLinePrefix[nextStartLine]! >
            lineFacts.blankLinePrefix[firstLineAfterComment]!;
}

function createBinding(
    commentLeafId: number,
    ownerNodeId: number,
    placement: TriviaPlacement
): CommentBinding {
    return Object.freeze({ commentLeafId, ownerNodeId, placement });
}

/**
 * Assigns every canonical comment leaf to exactly one CST node. Whitespace and
 * newline trivia remain represented only by SourceLeaf and are never bound.
 * The tree/event and leaf passes are linear in nodes, leaves, and source raw.
 */
export function bindCommentTrivia(
    root: ProgramNode,
    leaves: readonly SourceLeaf[]
): readonly CommentBinding[] {
    const commentIndexes: number[] = [];
    const previousSyntaxByLeaf: Array<number | null> = new Array(leaves.length);
    const nextSyntaxByLeaf: Array<number | null> = new Array(leaves.length);
    const leafIndexById = new Map<number, number>();
    let previousSyntax: number | null = null;

    for (let leafIndex = 0; leafIndex < leaves.length; leafIndex++) {
        const leaf = leaves[leafIndex]!;
        leafIndexById.set(leaf.id, leafIndex);
        previousSyntaxByLeaf[leafIndex] = previousSyntax;
        if (isComment(leaf)) {
            commentIndexes.push(leafIndex);
        }
        if (isSyntax(leaf)) {
            previousSyntax = leafIndex;
        }
    }

    let nextSyntax: number | null = null;
    for (let leafIndex = leaves.length - 1; leafIndex >= 0; leafIndex--) {
        const leaf = leaves[leafIndex]!;
        nextSyntaxByLeaf[leafIndex] = nextSyntax;
        if (isSyntax(leaf)) {
            nextSyntax = leafIndex;
        }
    }

    if (commentIndexes.length === 0) {
        return freezeImmutableArray([]);
    }

    const startNodes = new Map<number, NodeMeta[]>();
    const endNodes = new Map<number, NodeMeta[]>();
    const leadingOwners = new Map<number, NodeMeta>();
    const trailingOwners = new Map<number, NodeMeta>();
    const statementOwnersByEnd = new Map<number, NodeMeta>();
    const separatorTrailingOwners = new Map<number, NodeMeta>();
    const deepestContainer: Array<NodeMeta | null> = new Array(commentIndexes.length).fill(null);
    const deepestOpaque: Array<NodeMeta | null> = new Array(commentIndexes.length).fill(null);
    const work: Array<{ readonly node: SyntaxNode; readonly depth: number }> = [
        { node: root, depth: 0 },
    ];

    while (work.length > 0) {
        const current = work.pop()!;
        const meta: NodeMeta = Object.freeze({
            node: current.node,
            depth: current.depth,
        });
        addMeta(startNodes, current.node.leafRange.start, meta);
        addMeta(endNodes, current.node.leafRange.end, meta);
        updatePreferredOwner(
            leadingOwners,
            current.node.leafRange.start,
            meta,
            LEADING_PRIORITY
        );
        updatePreferredOwner(
            trailingOwners,
            current.node.leafRange.end,
            meta,
            TRAILING_PRIORITY
        );
        if (current.node.kind === "statement") {
            const existing = statementOwnersByEnd.get(current.node.leafRange.end);
            if (existing === undefined || meta.depth > existing.depth) {
                statementOwnersByEnd.set(current.node.leafRange.end, meta);
            }
        }

        if (current.node.kind === "list") {
            for (
                let separatorOrdinal = 0;
                separatorOrdinal < current.node.separatorLeafIds.length;
                separatorOrdinal++
            ) {
                const separatorLeafId = current.node.separatorLeafIds[separatorOrdinal]!;
                const separatorIndex = leafIndexById.get(separatorLeafId);
                const leftItem = current.node.children[separatorOrdinal];
                if (separatorIndex !== undefined && leftItem !== undefined) {
                    const itemMeta: NodeMeta = Object.freeze({
                        node: leftItem,
                        depth: current.depth + 1,
                    });
                    const existing = separatorTrailingOwners.get(separatorIndex);
                    if (existing === undefined || itemMeta.depth > existing.depth) {
                        separatorTrailingOwners.set(separatorIndex, itemMeta);
                    }
                }
            }
        }

        if ("children" in current.node) {
            for (let childIndex = current.node.children.length - 1; childIndex >= 0; childIndex--) {
                work.push({
                    node: current.node.children[childIndex]!,
                    depth: current.depth + 1,
                });
            }
        }
    }

    const activeByDepth: Array<NodeMeta | undefined> = [];
    const activeOpaqueByDepth: Array<NodeMeta | undefined> = [];
    let deepestActiveDepth = -1;
    let deepestOpaqueDepth = -1;
    let commentOrdinal = 0;

    // End is exclusive: retire closing ranges before activating ranges that
    // start at the current leaf, then snapshot the deepest active owner.
    for (let leafIndex = 0; leafIndex < leaves.length; leafIndex++) {
        for (const ending of endNodes.get(leafIndex) ?? []) {
            activeByDepth[ending.depth] = undefined;
            if (ending.node.kind === "opaque") {
                activeOpaqueByDepth[ending.depth] = undefined;
            }
        }
        while (deepestActiveDepth >= 0 && activeByDepth[deepestActiveDepth] === undefined) {
            deepestActiveDepth -= 1;
        }
        while (
            deepestOpaqueDepth >= 0 &&
            activeOpaqueByDepth[deepestOpaqueDepth] === undefined
        ) {
            deepestOpaqueDepth -= 1;
        }

        for (const starting of startNodes.get(leafIndex) ?? []) {
            activeByDepth[starting.depth] = starting;
            if (starting.depth > deepestActiveDepth) {
                deepestActiveDepth = starting.depth;
            }
            if (starting.node.kind === "opaque") {
                activeOpaqueByDepth[starting.depth] = starting;
                if (starting.depth > deepestOpaqueDepth) {
                    deepestOpaqueDepth = starting.depth;
                }
            }
        }

        if (isComment(leaves[leafIndex]!)) {
            deepestContainer[commentOrdinal] = activeByDepth[deepestActiveDepth] ?? null;
            deepestOpaque[commentOrdinal] = activeOpaqueByDepth[deepestOpaqueDepth] ?? null;
            commentOrdinal += 1;
        }
    }

    const lineFacts = buildLineFacts(leaves);
    const bindings: CommentBinding[] = [];

    for (let ordinal = 0; ordinal < commentIndexes.length; ordinal++) {
        const commentIndex = commentIndexes[ordinal]!;
        const commentLeaf = leaves[commentIndex]!;
        const opaque = deepestOpaque[ordinal];
        if (opaque != null) {
            bindings.push(createBinding(commentLeaf.id, opaque.node.id, "dangling"));
            continue;
        }

        const container = deepestContainer[ordinal] ?? Object.freeze({ node: root, depth: 0 });
        const previousIndex = previousSyntaxByLeaf[commentIndex]!;
        const followingIndex = nextSyntaxByLeaf[commentIndex]!;

        if (previousIndex !== null) {
            const previousLeaf = leaves[previousIndex]!;
            if (isProvenContainerOpener(previousLeaf, container.node)) {
                bindings.push(createBinding(commentLeaf.id, container.node.id, "dangling"));
                continue;
            }

            const separatorOwner = separatorTrailingOwners.get(previousIndex);
            if (
                separatorOwner !== undefined &&
                lineFacts.endLineByLeaf[previousIndex] === lineFacts.startLineByLeaf[commentIndex]
            ) {
                bindings.push(createBinding(commentLeaf.id, separatorOwner.node.id, "trailing"));
                continue;
            }

            if (
                previousLeaf.channel === "code" &&
                previousLeaf.raw === "," &&
                lineFacts.endLineByLeaf[previousIndex] === lineFacts.startLineByLeaf[commentIndex]
            ) {
                const leftSyntaxIndex = previousSyntaxByLeaf[previousIndex];
                const ownerBeforeComma =
                    leftSyntaxIndex === null || leftSyntaxIndex === undefined
                    ? undefined
                    : trailingOwners.get(leftSyntaxIndex + 1);
                if (ownerBeforeComma !== undefined) {
                    bindings.push(
                        createBinding(commentLeaf.id, ownerBeforeComma.node.id, "trailing")
                    );
                    continue;
                }
            }

            if (
                previousLeaf.channel === "code" &&
                previousLeaf.raw === ";" &&
                lineFacts.endLineByLeaf[previousIndex] === lineFacts.startLineByLeaf[commentIndex]
            ) {
                const statement = statementOwnersByEnd.get(previousIndex + 1);
                if (statement !== undefined) {
                    bindings.push(createBinding(commentLeaf.id, statement.node.id, "trailing"));
                    continue;
                }
            }

            if (
                lineFacts.endLineByLeaf[previousIndex] === lineFacts.startLineByLeaf[commentIndex]
            ) {
                const owner = trailingOwners.get(previousIndex + 1);
                if (owner !== undefined) {
                    bindings.push(createBinding(commentLeaf.id, owner.node.id, "trailing"));
                    continue;
                }
            }
        }

        if (
            followingIndex !== null &&
            !hasBlankLineBeforeNextSyntax(commentIndex, followingIndex, lineFacts)
        ) {
            if (container.node.kind === "statement") {
                bindings.push(createBinding(commentLeaf.id, container.node.id, "leading"));
                continue;
            }
            const owner = leadingOwners.get(followingIndex);
            if (owner !== undefined) {
                bindings.push(createBinding(commentLeaf.id, owner.node.id, "leading"));
                continue;
            }
        }

        bindings.push(createBinding(commentLeaf.id, container.node.id, "dangling"));
    }

    return freezeImmutableArray(bindings);
}
