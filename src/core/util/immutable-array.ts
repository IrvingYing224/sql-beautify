/**
 * Shared immutable array helper for v2 core public query surfaces.
 *
 * Contract:
 * - Runtime value is a real Array (Array.isArray === true).
 * - Result is Object.freeze'd: direct mutation fails in strict mode or is a no-op
 *   in non-strict; frozen contents should themselves be immutable values.
 * - Callbacks (map/forEach/filter/...) receive the same frozen array as the
 *   third argument — never a mutable backing copy.
 * - Prefer caching one frozen snapshot per logical collection rather than
 *   rebuilding on every lookup.
 */
export function freezeImmutableArray<T>(values: readonly T[]): readonly T[] {
    if (values.length === 0) {
        return EMPTY_FROZEN_ARRAY as readonly T[];
    }
    return Object.freeze(Array.from(values));
}

/** Shared stable empty frozen array for repeated empty lookups. */
export const EMPTY_FROZEN_ARRAY: readonly never[] = Object.freeze([]);
