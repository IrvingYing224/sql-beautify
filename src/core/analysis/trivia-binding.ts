import type { SourceLeaf } from "../lexer/token";
import type { ProgramNode, SyntaxNode } from "../syntax/node";
import { freezeImmutableArray } from "../util/immutable-array";
import type { CommentBinding, TriviaPlacement } from "./types";

export type { CommentBinding, TriviaPlacement } from "./types";

/**
 * Internal direct-address facts prepared by structural-index's one tree pass
 * and one leaf/source pass. Arrays are indexed by leaf boundary, leaf id, or
 * node id as documented by the field name.
 */
export interface PreparedTriviaFacts {
    readonly root: ProgramNode;
    readonly leaves: readonly SourceLeaf[];
    readonly nodesById: readonly SyntaxNode[];
    readonly commentLeafIndexes: readonly number[];
    readonly previousSyntaxByLeaf: readonly (number | null)[];
    readonly nextSyntaxByLeaf: readonly (number | null)[];
    readonly startLineByLeaf: ArrayLike<number>;
    readonly endLineByLeaf: readonly number[];
    readonly blankLinePrefix: readonly number[];
    readonly deepestContainerNodeIdByLeaf: readonly (number | null)[];
    readonly deepestOpaqueNodeIdByLeaf: readonly (number | null)[];
    readonly leadingOwnerNodeIdByBoundary: readonly (number | null)[];
    readonly trailingOwnerNodeIdByBoundary: readonly (number | null)[];
    readonly statementOwnerNodeIdByEnd: readonly (number | null)[];
    readonly separatorTrailingOwnerNodeIdByLeaf: readonly (number | null)[];
}

interface LineFacts {
    readonly startLineByLeaf: ArrayLike<number>;
    readonly endLineByLeaf: readonly number[];
    readonly blankLinePrefix: readonly number[];
}

export const TRIVIA_LEADING_PRIORITY: Readonly<Record<SyntaxNode["kind"], number>> = Object.freeze({
    program: 0,
    statement: 100,
    "set-statement": 98,
    "set-payload": 80,
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

export const TRIVIA_TRAILING_PRIORITY: Readonly<Record<SyntaxNode["kind"], number>> = Object.freeze({
    program: 0,
    statement: 20,
    "set-statement": 45,
    "set-payload": 95,
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

function isProvenContainerOpener(leaf: SourceLeaf, container: SyntaxNode): boolean {
    if (leaf.channel !== "code") {
        return false;
    }
    if (leaf.raw === "(" || leaf.raw === "[") {
        return true;
    }
    return leaf.raw === "<" && container.kind === "type-expression";
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

function nodeFromPreparedFacts(
    facts: PreparedTriviaFacts,
    nodeId: number | null | undefined,
    label: string
): SyntaxNode | null {
    if (nodeId === null || nodeId === undefined) {
        return null;
    }
    const node = facts.nodesById[nodeId];
    if (node === undefined || node.id !== nodeId) {
        throw new Error(`${label} references missing node id ${String(nodeId)}`);
    }
    return node;
}

/**
 * Binds comments from structural-index facts without re-traversing the CST or
 * canonical leaf stream. Only the comment subset is visited here.
 */
export function bindCommentTriviaFromFacts(
    facts: PreparedTriviaFacts
): readonly CommentBinding[] {
    if (facts.commentLeafIndexes.length === 0) {
        return freezeImmutableArray([]);
    }
    const lineFacts: LineFacts = Object.freeze({
        startLineByLeaf: facts.startLineByLeaf,
        endLineByLeaf: facts.endLineByLeaf,
        blankLinePrefix: facts.blankLinePrefix,
    });
    const bindings: CommentBinding[] = [];

    for (const commentIndex of facts.commentLeafIndexes) {
        const commentLeaf = facts.leaves[commentIndex];
        if (
            commentLeaf === undefined ||
            commentLeaf.id !== commentIndex ||
            !isComment(commentLeaf)
        ) {
            throw new Error(`Prepared trivia comment index is invalid: ${commentIndex}`);
        }

        const opaque = nodeFromPreparedFacts(
            facts,
            facts.deepestOpaqueNodeIdByLeaf[commentIndex],
            "deepest opaque owner"
        );
        if (opaque !== null) {
            if (opaque.kind !== "opaque") {
                throw new Error(`Prepared opaque owner ${opaque.id} is not opaque`);
            }
            bindings.push(createBinding(commentLeaf.id, opaque.id, "dangling"));
            continue;
        }

        const container =
            nodeFromPreparedFacts(
                facts,
                facts.deepestContainerNodeIdByLeaf[commentIndex],
                "deepest container owner"
            ) ?? facts.root;
        const previousIndex = facts.previousSyntaxByLeaf[commentIndex] ?? null;
        const followingIndex = facts.nextSyntaxByLeaf[commentIndex] ?? null;

        if (previousIndex !== null) {
            const previousLeaf = facts.leaves[previousIndex];
            if (previousLeaf === undefined) {
                throw new Error(`Prepared previous syntax index is invalid: ${previousIndex}`);
            }
            if (isProvenContainerOpener(previousLeaf, container)) {
                bindings.push(createBinding(commentLeaf.id, container.id, "dangling"));
                continue;
            }

            const separatorOwner = nodeFromPreparedFacts(
                facts,
                facts.separatorTrailingOwnerNodeIdByLeaf[previousIndex],
                "separator trailing owner"
            );
            if (
                separatorOwner !== null &&
                lineFacts.endLineByLeaf[previousIndex] ===
                    lineFacts.startLineByLeaf[commentIndex]
            ) {
                bindings.push(createBinding(commentLeaf.id, separatorOwner.id, "trailing"));
                continue;
            }

            if (
                previousLeaf.channel === "code" &&
                previousLeaf.raw === "," &&
                lineFacts.endLineByLeaf[previousIndex] ===
                    lineFacts.startLineByLeaf[commentIndex]
            ) {
                const leftSyntaxIndex = facts.previousSyntaxByLeaf[previousIndex] ?? null;
                const ownerBeforeComma =
                    leftSyntaxIndex === null
                        ? null
                        : nodeFromPreparedFacts(
                              facts,
                              facts.trailingOwnerNodeIdByBoundary[leftSyntaxIndex + 1],
                              "owner before comma"
                          );
                if (ownerBeforeComma !== null) {
                    bindings.push(
                        createBinding(commentLeaf.id, ownerBeforeComma.id, "trailing")
                    );
                    continue;
                }
            }

            if (
                previousLeaf.channel === "code" &&
                previousLeaf.raw === ";" &&
                lineFacts.endLineByLeaf[previousIndex] ===
                    lineFacts.startLineByLeaf[commentIndex]
            ) {
                const statement = nodeFromPreparedFacts(
                    facts,
                    facts.statementOwnerNodeIdByEnd[previousIndex + 1],
                    "statement trailing owner"
                );
                if (statement !== null) {
                    bindings.push(createBinding(commentLeaf.id, statement.id, "trailing"));
                    continue;
                }
            }

            if (
                lineFacts.endLineByLeaf[previousIndex] ===
                lineFacts.startLineByLeaf[commentIndex]
            ) {
                const owner = nodeFromPreparedFacts(
                    facts,
                    facts.trailingOwnerNodeIdByBoundary[previousIndex + 1],
                    "trailing owner"
                );
                if (owner !== null) {
                    bindings.push(createBinding(commentLeaf.id, owner.id, "trailing"));
                    continue;
                }
            }
        }

        if (
            followingIndex !== null &&
            !hasBlankLineBeforeNextSyntax(commentIndex, followingIndex, lineFacts)
        ) {
            if (container.kind === "statement") {
                bindings.push(createBinding(commentLeaf.id, container.id, "leading"));
                continue;
            }
            const owner = nodeFromPreparedFacts(
                facts,
                facts.leadingOwnerNodeIdByBoundary[followingIndex],
                "leading owner"
            );
            if (owner !== null) {
                bindings.push(createBinding(commentLeaf.id, owner.id, "leading"));
                continue;
            }
        }

        bindings.push(createBinding(commentLeaf.id, container.id, "dangling"));
    }

    return freezeImmutableArray(bindings);
}
