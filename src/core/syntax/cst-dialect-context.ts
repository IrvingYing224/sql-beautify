import type { Dialect } from "../config/options";
import { getDialect } from "../dialects/registry";
import type {
    CapabilityEntry,
    OperatorSemantics,
} from "../dialects/types";

export interface CstDialectInvariantContext {
    readonly dialect: Dialect;
    capability(capabilityId: string): CapabilityEntry | null;
    ownsOperatorSemantics(value: unknown): value is OperatorSemantics;
    queryClauseOrder(clauseId: string): number | null;
    isSetOperatorWord(word: string): boolean;
}

const CONTEXTS: Partial<Record<Dialect, CstDialectInvariantContext>> = {};

export function getCstDialectInvariantContext(
    dialect: Dialect
): CstDialectInvariantContext {
    const cached = CONTEXTS[dialect];
    if (cached !== undefined) {
        return cached;
    }

    const view = getDialect(dialect);
    const capabilities = new Map(
        view.listCapabilities().map((capability) => [capability.id, capability])
    );
    const operatorSemantics = new WeakSet<object>();
    for (const semantics of view.listOperatorSemantics()) {
        operatorSemantics.add(semantics);
    }
    const queryClauseOrders = new Map<string, number>(
        view.listQueryClauseSyntax().map((clause) => [clause.id, clause.order])
    );
    const setOperatorWords = new Set(
        view.listSetOperatorSyntax().map((operator) => operator.word)
    );

    const context: CstDialectInvariantContext = Object.freeze({
        dialect,
        capability(capabilityId: string): CapabilityEntry | null {
            return capabilities.get(capabilityId) ?? null;
        },
        ownsOperatorSemantics(value: unknown): value is OperatorSemantics {
            return (
                typeof value === "object" &&
                value !== null &&
                operatorSemantics.has(value)
            );
        },
        queryClauseOrder(clauseId: string): number | null {
            return queryClauseOrders.get(clauseId) ?? null;
        },
        isSetOperatorWord(word: string): boolean {
            return setOperatorWords.has(word);
        },
    });
    CONTEXTS[dialect] = context;
    return context;
}
