/**
 * Wave 2A foundation invariant facade.
 *
 * Production responsibilities:
 * - validateSyntaxInvariants: CST topology, leaf partition, program coverage,
 *   owner facts (alias / opaque / clause / case), optional token-table valid-domain.
 * - validateTokenTableInvariants: structural facts vs independent expected oracle
 *   (O(n) valid domain) + fixed O(1) illegal-input samples.
 *
 * Test-only exhaustive misuse matrices live under tests/v2 and must not re-enter
 * the production per-leaf hot path.
 */

export type {
    InvariantFailure,
    InvariantFailureCode,
    InvariantResult,
    SyntaxInvariantInput,
} from "./invariant-types";

export { validateSyntaxInvariants } from "./cst-invariants";
export { validateTokenTableInvariants } from "./token-table-invariants";
export {
    NODE_KIND_REGISTRY,
    SYNTAX_KINDS,
} from "./invariant-shared";
export type {
    InvariantValidatorFamily,
    NodeKindRegistryEntry,
} from "./invariant-shared";
