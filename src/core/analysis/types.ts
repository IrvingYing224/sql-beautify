import type { Dialect } from "../config/options";
import type { Diagnostic } from "../diagnostics/diagnostic";
import type { CapabilityEntry } from "../dialects/types";
import type { SourceLeaf } from "../lexer/token";
import type { LeafRange } from "../syntax/leaf-range";
import type {
    ListItemNode,
    ListNode,
    OperatorOccurrence,
    ProgramNode,
    QueryNode,
    StatementNode,
    SyntaxNode,
} from "../syntax/node";
import type { ParseMode } from "../syntax/parser-backend";

export type TriviaPlacement = "leading" | "trailing" | "dangling";

export interface CommentBinding {
    readonly commentLeafId: number;
    readonly ownerNodeId: number;
    readonly placement: TriviaPlacement;
}

export interface OffsetLeafLocation {
    readonly leafId: number;
    readonly relativeOffset: number;
    /** True only for the source-length EOF position. */
    readonly atEnd: boolean;
}

export interface SyntaxLeafOccurrence {
    readonly leafId: number;
    readonly directOwnerNodeId: number;
    readonly syntaxRole: import("../syntax/node").SyntaxLeafRole;
    readonly syntaxId: import("../syntax/node").SyntaxMarkerId | null;
    readonly capabilityId: string | null;
    readonly keywordCaseEligible: boolean;
}

export interface ContextualLeafFacts {
    readonly leafId: number;
    readonly syntax: SyntaxLeafOccurrence | null;
    readonly opaqueOwnerNodeId: number | null;
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

    queryOfClause(clauseNodeId: number): QueryNode;

    lists(): readonly ListNode[];
    membersOfList(listNodeId: number): readonly ListItemNode[];

    matchingDelimiter(leafId: number): number | null;
    depthBefore(leafId: number): number;
    depthAfter(leafId: number): number;

    /** Counts source blank physical lines strictly between two leaf boundaries. */
    blankLineCountBetween(
        startLeafBoundary: number,
        endLeafBoundary: number
    ): number;
    leafContainsLineBreak(leafId: number): boolean;
    leafStartsWithLineBreak(leafId: number): boolean;
    leafEndsWithLineBreak(leafId: number): boolean;
    rangeContainsLineBreak(range: LeafRange): boolean;
    rangeStartsWithLineBreak(range: LeafRange): boolean;
    rangeEndsWithLineBreak(range: LeafRange): boolean;
    /**
     * Accepts 0..sourceLength. Empty-source offset 0 returns null. For a
     * non-empty source, sourceLength maps to the final leaf's exclusive end.
     */
    offsetToLeaf(offset: number): OffsetLeafLocation | null;

    commentBindings(): readonly CommentBinding[];
    commentBinding(commentLeafId: number): CommentBinding | null;
    commentsForOwner(ownerNodeId: number): readonly CommentBinding[];

    leafContext(leafId: number): ContextualLeafFacts;
    capabilityForNode(nodeId: number): CapabilityEntry | null;
    operatorOccurrencesOf(expressionNodeId: number): readonly OperatorOccurrence[];

    capability(capabilityId: string): CapabilityEntry | null;
}

export type AnalysisStatus = "analyzed" | "preserved" | "failed";

export interface AnalysisArtifactBase<S extends AnalysisStatus> {
    readonly status: S;
    readonly source: string;
    readonly dialect: Dialect;
    readonly mode: ParseMode;
    readonly root: ProgramNode;
    readonly leaves: readonly SourceLeaf[];
    readonly diagnostics: readonly Diagnostic[];
}

export interface AnalyzedArtifact extends AnalysisArtifactBase<"analyzed"> {
    readonly index: StructuralIndex;
}

export interface PreservedAnalysisArtifact
    extends AnalysisArtifactBase<"preserved"> {
    readonly index: StructuralIndex;
}

export interface FailedAnalysisArtifact extends AnalysisArtifactBase<"failed"> {
    readonly index: null;
}

export type IndexedAnalysisOutput = AnalyzedArtifact | PreservedAnalysisArtifact;
export type FailedAnalysisOutput = FailedAnalysisArtifact;
export type AnalysisArtifact =
    | AnalyzedArtifact
    | PreservedAnalysisArtifact
    | FailedAnalysisArtifact;
/** @deprecated Internal compatibility alias; use AnalysisArtifact. */
export type AnalysisOutput = AnalysisArtifact;
