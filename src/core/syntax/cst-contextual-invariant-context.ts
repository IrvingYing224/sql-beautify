import type { SourceLeaf } from "../lexer/token";
import type { CstDialectInvariantContext } from "./cst-dialect-context";
import type { InvariantFailure } from "./invariant-types";
import type { LeafRange } from "./leaf-range";
import { isFiniteNonNegInt, isLeafRange } from "./invariant-shared";

export interface ContextualInvariantContext {
    readonly raw: Record<string, unknown>;
    readonly directChildren: readonly Record<string, unknown>[];
    readonly leaves: readonly SourceLeaf[];
    readonly failures: InvariantFailure[];
    readonly dialectContext: CstDialectInvariantContext;
    readonly trustedCanonicalShape: boolean;
    readonly nodeId: number;
    readonly nodeKind: string;
    readonly ownerRange: LeafRange | null;
}

export type ContextualInvariantScratch = {
    -readonly [Key in keyof ContextualInvariantContext]:
        ContextualInvariantContext[Key];
};

export interface NameRangeClaim {
    readonly field: string;
    readonly range: LeafRange;
    readonly allowsTypeNameMarker: boolean;
}

export interface ContextualFactClaims {
    readonly nameClaims: readonly NameRangeClaim[];
    readonly separatorLeafIds: readonly number[];
    readonly operatorLeafIds: readonly number[];
}

const EMPTY_CONTEXTUAL_RAW: Record<string, unknown> = Object.freeze({});
const EMPTY_CONTEXTUAL_CHILDREN: readonly Record<string, unknown>[] =
    Object.freeze([]);

export function createContextualInvariantScratch(
    leaves: readonly SourceLeaf[],
    failures: InvariantFailure[],
    dialectContext: CstDialectInvariantContext
): ContextualInvariantScratch {
    return {
        raw: EMPTY_CONTEXTUAL_RAW,
        directChildren: EMPTY_CONTEXTUAL_CHILDREN,
        leaves,
        failures,
        dialectContext,
        trustedCanonicalShape: false,
        nodeId: 0,
        nodeKind: "",
        ownerRange: null,
    };
}

export function createContextualInvariantContext(
    raw: Record<string, unknown>,
    directChildren: readonly Record<string, unknown>[],
    leaves: readonly SourceLeaf[],
    failures: InvariantFailure[],
    dialectContext: CstDialectInvariantContext,
    trustedCanonicalShape: boolean,
    scratch?: ContextualInvariantScratch
): ContextualInvariantContext | null {
    if (!isFiniteNonNegInt(raw.id) || typeof raw.kind !== "string") {
        return null;
    }
    const nodeId = raw.id;
    const nodeKind = raw.kind;
    const ownerRange = isLeafRange(raw.leafRange) ? raw.leafRange : null;
    const context = scratch ?? createContextualInvariantScratch(
        leaves,
        failures,
        dialectContext
    );
    context.raw = raw;
    context.directChildren = directChildren;
    context.leaves = leaves;
    context.failures = failures;
    context.dialectContext = dialectContext;
    context.trustedCanonicalShape = trustedCanonicalShape;
    context.nodeId = nodeId;
    context.nodeKind = nodeKind;
    context.ownerRange = ownerRange;
    return context;
}
