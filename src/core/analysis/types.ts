import type { Dialect } from "../config/options";
import type { Diagnostic } from "../diagnostics/diagnostic";
import type { CapabilityEntry } from "../dialects/types";
import type { SourceLeaf } from "../lexer/token";
import type { SourceSpan } from "../source/source-span";
import type { LeafRange } from "../syntax/leaf-range";
import type {
    ClauseNode,
    ListItemNode,
    ListNode,
    ProgramNode,
    QueryNode,
    StatementNode,
    SyntaxNode,
} from "../syntax/node";
import type { StructuralTokenTable } from "../syntax/token-table";

export type TriviaPlacement = "leading" | "trailing" | "dangling";

export interface CommentBinding {
    readonly commentLeafId: number;
    readonly ownerNodeId: number;
    readonly placement: TriviaPlacement;
}

export interface SourcePosition {
    /** Zero-based physical line. CRLF is one line break. */
    readonly line: number;
    /** Zero-based JavaScript UTF-16 code-unit column. */
    readonly column: number;
}

export interface OffsetLeafLocation {
    readonly leafId: number;
    readonly relativeOffset: number;
    /** True only for the source-length EOF position. */
    readonly atEnd: boolean;
}

export interface SeparatorOwnership {
    readonly separatorLeafId: number;
    readonly listNodeId: number;
    readonly ordinal: number;
    readonly leftMemberNodeId: number;
    readonly rightMemberNodeId: number;
}

export interface StructuralIndexSnapshot {
    readonly nodeIds: readonly number[];
    readonly parentNodeIds: readonly (number | null)[];
    readonly statementNodeIds: readonly (number | null)[];
    readonly queryNodeIds: readonly (number | null)[];
    readonly listNodeIds: readonly (number | null)[];
    readonly separatorOwnerships: readonly SeparatorOwnership[];
    readonly commentBindings: readonly CommentBinding[];
    readonly lineStarts: readonly number[];
}

export interface StructuralIndexInput {
    readonly root: ProgramNode;
    readonly leaves: readonly SourceLeaf[];
    /** The table built by the same parse pipeline; the builder never rebuilds it. */
    readonly tokenTable: StructuralTokenTable;
    readonly dialect: Dialect;
    readonly diagnostics: readonly Diagnostic[];
    /**
     * Parser-derived during the canonical lexer-output freeze pass. Internal
     * builder tests may omit it and pay one bounded comment-presence preflight.
     */
    readonly hasCommentTrivia?: boolean;
}

/**
 * Immutable, direct-address structural facts for Wave 3. Methods reject invalid
 * ids/offsets rather than silently returning facts for a different object.
 */
export interface StructuralIndex {
    nodes(): readonly SyntaxNode[];
    nodeById(nodeId: number): SyntaxNode;
    parentOf(nodeId: number): SyntaxNode | null;
    childrenOf(nodeId: number): readonly SyntaxNode[];
    nearestAncestor(nodeId: number, kind: SyntaxNode["kind"]): SyntaxNode | null;

    statements(): readonly StatementNode[];
    statementOfNode(nodeId: number): StatementNode | null;

    queries(): readonly QueryNode[];
    clausesOfQuery(queryNodeId: number): readonly ClauseNode[];
    queryOfClause(clauseNodeId: number): QueryNode;

    lists(): readonly ListNode[];
    membersOfList(listNodeId: number): readonly ListItemNode[];
    listOfMember(memberNodeId: number): ListNode;
    separatorOwner(separatorLeafId: number): SeparatorOwnership | null;

    matchingDelimiter(leafId: number): number | null;
    depthBefore(leafId: number): number;
    depthAfter(leafId: number): number;

    lineStarts(): readonly number[];
    leafPosition(leafId: number): SourcePosition;
    /**
     * Accepts 0..sourceLength. Empty-source offset 0 returns null. For a
     * non-empty source, sourceLength maps to the final leaf's exclusive end.
     */
    offsetToLeaf(offset: number): OffsetLeafLocation | null;

    spanOf(nodeId: number): SourceSpan;
    leafRangeOf(nodeId: number): LeafRange;

    commentBindings(): readonly CommentBinding[];
    commentBinding(commentLeafId: number): CommentBinding | null;
    commentsForOwner(ownerNodeId: number): readonly CommentBinding[];

    capability(capabilityId: string): CapabilityEntry | null;
    /** Only OpaqueNode carries an occurrence identity; structured nodes do not. */
    capabilityForOpaque(opaqueNodeId: number): CapabilityEntry | null;
    capabilityForDiagnostic(diagnosticIndex: number): CapabilityEntry | null;

    /** Stable immutable scalar projection used by invariants/determinism tests. */
    snapshot(): StructuralIndexSnapshot;
}

export type AnalysisStatus = "analyzed" | "preserved" | "failed";

interface AnalysisOutputBase<S extends AnalysisStatus> {
    readonly status: S;
    readonly root: ProgramNode;
    readonly leaves: readonly SourceLeaf[];
    readonly diagnostics: readonly Diagnostic[];
}

export interface IndexedAnalysisOutput
    extends AnalysisOutputBase<"analyzed" | "preserved"> {
    readonly index: StructuralIndex;
}

export interface FailedAnalysisOutput extends AnalysisOutputBase<"failed"> {
    readonly index: null;
}

export type AnalysisOutput = IndexedAnalysisOutput | FailedAnalysisOutput;
