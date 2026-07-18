import type { SourceLeaf } from "../lexer/token";
import { validateCapabilityAllowlist } from "./cst-capability-allowlist-invariants";
import type { CstDialectInvariantContext } from "./cst-dialect-context";
import {
    createContextualInvariantContext,
    type ContextualInvariantScratch,
} from "./cst-contextual-invariant-context";
import { validateContextualFactShape } from "./cst-contextual-fact-invariants";
import { validateExactMarkerClosure } from "./cst-marker-closure-invariants";
import type { InvariantFailure } from "./invariant-types";

export function validateContextualNodeFacts(
    raw: Record<string, unknown>,
    directChildren: readonly Record<string, unknown>[],
    leaves: readonly SourceLeaf[],
    failures: InvariantFailure[],
    dialectContext: CstDialectInvariantContext,
    trustedCanonicalShape: boolean,
    scratch?: ContextualInvariantScratch
): void {
    const context = createContextualInvariantContext(
        raw,
        directChildren,
        leaves,
        failures,
        dialectContext,
        trustedCanonicalShape,
        scratch
    );
    if (context === null) {
        return;
    }
    validateCapabilityAllowlist(context);
    const facts = validateContextualFactShape(context);
    validateExactMarkerClosure(context, facts);
}
