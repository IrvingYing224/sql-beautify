import { getDialect } from "../dialects/registry";
import type {
    CapabilityState,
    UnsupportedSyntaxContext,
    UnsupportedSyntaxSignature,
} from "../dialects/types";
import { freezeImmutableArray } from "../util/immutable-array";
import type { LeafRange } from "./leaf-range";
import {
    ParserSyntaxError,
    isCodeWord,
    isDottedNamePart,
    matchesSyntaxWords,
    topLevelSyntaxIndexes,
} from "./parser-context";
import type { ParserContext } from "./parser-context";

export interface UnsupportedConstructMatch {
    readonly signature: UnsupportedSyntaxSignature;
    readonly state: Extract<CapabilityState, "verbatim" | "diagnostic">;
    readonly range: LeafRange;
}

function signaturesFor(
    context: ParserContext,
    syntaxContext: UnsupportedSyntaxContext
): readonly UnsupportedSyntaxSignature[] {
    return getDialect(context.dialect)
        .listUnsupportedSyntax()
        .filter((signature) => signature.context === syntaxContext);
}

function matchAt(
    context: ParserContext,
    range: LeafRange,
    start: number,
    signature: UnsupportedSyntaxSignature
): UnsupportedConstructMatch | null {
    const matched = matchesSyntaxWords(context, start, range.end, signature.words);
    if (
        matched === null ||
        matched.some(
            (index) => context.table.depthBefore(index) !== context.table.depthBefore(start)
        )
    ) {
        return null;
    }
    const capability = getDialect(context.dialect).getCapability(signature.capabilityId);
    if (
        capability === null ||
        (capability.state !== "verbatim" && capability.state !== "diagnostic")
    ) {
        return null;
    }
    return Object.freeze({
        signature,
        state: capability.state,
        range: Object.freeze({ start, end: matched[matched.length - 1]! + 1 }),
    });
}

function relationBodyHasEvidence(
    context: ParserContext,
    open: number,
    close: number,
    alternatives: readonly (readonly string[])[]
): boolean {
    const bodySyntax = topLevelSyntaxIndexes(context, {
        start: open + 1,
        end: close,
    }).flatMap((index) => {
        const leaf = context.leaves[index]!;
        return leaf.channel === "code"
            ? [context.table.normalizedWord(index)]
            : [];
    });
    return alternatives.some((sequence) => {
        let bodyPosition = 0;
        for (const expected of sequence) {
            while (
                bodyPosition < bodySyntax.length &&
                bodySyntax[bodyPosition] !== expected
            ) {
                bodyPosition += 1;
            }
            if (bodyPosition >= bodySyntax.length) {
                return false;
            }
            bodyPosition += 1;
        }
        return true;
    });
}

export function classifyUnsupportedStatementStart(
    context: ParserContext,
    range: LeafRange
): UnsupportedConstructMatch | null {
    for (const signature of signaturesFor(context, "statement-start")) {
        const match = matchAt(context, range, range.start, signature);
        if (match !== null) {
            return match;
        }
    }
    return null;
}

export function rejectUnsupportedRelationConstructs(
    context: ParserContext,
    range: LeafRange,
    indexes: readonly number[]
): void {
    const signatures = signaturesFor(context, "relation-suffix");
    for (let position = 1; position < indexes.length; position++) {
        const index = indexes[position]!;
        if (isDottedNamePart(context, index, range.start, range.end)) {
            continue;
        }
        for (const signature of signatures) {
            const match = matchAt(context, range, index, signature);
            if (match === null) {
                continue;
            }
            const previous = indexes[position - 1]!;
            const nextPosition = position + signature.words.length;
            const next = indexes[nextPosition];
            if (
                isCodeWord(context, previous, "as") ||
                context.leaves[previous]!.kind === "operator" ||
                context.leaves[previous]!.raw === "," ||
                next === undefined ||
                context.leaves[next]!.raw !== "("
            ) {
                continue;
            }
            const close = context.table.matchingDelimiterIndex(next);
            if (
                close === null ||
                close >= range.end ||
                signature.bodyEvidence === null ||
                !relationBodyHasEvidence(
                    context,
                    next,
                    close,
                    signature.bodyEvidence
                )
            ) {
                continue;
            }
            throw new ParserSyntaxError(
                "SYN_UNMODELED_CONSTRUCT",
                { start: index, end: range.end },
                `${context.dialect} relation construct ${signature.words.join(" ").toUpperCase()} is recognized but not structured`,
                "statement"
            );
        }
    }
}

export function findUnsupportedQueryClauseCandidates(
    context: ParserContext,
    range: LeafRange
): readonly UnsupportedConstructMatch[] {
    const signatures = signaturesFor(context, "query-clause");
    const matches: UnsupportedConstructMatch[] = [];
    for (const index of topLevelSyntaxIndexes(context, range)) {
        if (isDottedNamePart(context, index, range.start, range.end)) {
            continue;
        }
        for (const signature of signatures) {
            const match = matchAt(context, range, index, signature);
            if (match !== null) {
                matches.push(match);
                break;
            }
        }
    }
    return freezeImmutableArray(matches);
}
