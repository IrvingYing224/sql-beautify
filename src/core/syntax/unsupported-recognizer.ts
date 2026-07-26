import { getDialect } from "../dialects/registry";
import type {
    CapabilityState,
    UnsupportedSyntaxContext,
    UnsupportedSyntaxSignature,
} from "../dialects/types";
import {
    EMPTY_FROZEN_ARRAY,
    freezeImmutableArray,
} from "../util/immutable-array";
import type { LeafRange } from "./leaf-range";
import {
    ParserSyntaxError,
    isCodeWord,
    isDottedNamePart,
    matchesSyntaxWords,
    nextSyntaxIndex,
    topLevelSyntaxIndexes,
} from "./parser-context";
import type { ParserContext } from "./parser-context";

export interface UnsupportedConstructMatch {
    readonly signature: UnsupportedSyntaxSignature;
    readonly state: Extract<CapabilityState, "verbatim" | "diagnostic">;
    readonly range: LeafRange;
}

type UnsupportedSignatureView = Readonly<{
    signatures: readonly UnsupportedSyntaxSignature[];
    byFirstWord: Readonly<Record<string, readonly UnsupportedSyntaxSignature[]>>;
}>;

const UNSUPPORTED_SIGNATURE_CACHE: Partial<
    Record<
        ParserContext["dialect"],
        Partial<Record<UnsupportedSyntaxContext, UnsupportedSignatureView>>
    >
> = Object.create(null) as Partial<
    Record<
        ParserContext["dialect"],
        Partial<Record<UnsupportedSyntaxContext, UnsupportedSignatureView>>
    >
>;

function signatureViewFor(
    context: ParserContext,
    syntaxContext: UnsupportedSyntaxContext
): UnsupportedSignatureView {
    let dialectCache = UNSUPPORTED_SIGNATURE_CACHE[context.dialect];
    if (dialectCache === undefined) {
        dialectCache = Object.create(null) as Partial<
            Record<UnsupportedSyntaxContext, UnsupportedSignatureView>
        >;
        UNSUPPORTED_SIGNATURE_CACHE[context.dialect] = dialectCache;
    }
    const cached = dialectCache[syntaxContext];
    if (cached !== undefined) {
        return cached;
    }
    const signatures = freezeImmutableArray(
        getDialect(context.dialect)
        .listUnsupportedSyntax()
            .filter((signature) => signature.context === syntaxContext)
    );
    const mutableByFirstWord = Object.create(null) as Record<
        string,
        UnsupportedSyntaxSignature[]
    >;
    for (const signature of signatures) {
        const firstWord = signature.words[0];
        if (firstWord === undefined) {
            continue;
        }
        const candidates = mutableByFirstWord[firstWord];
        if (candidates === undefined) {
            mutableByFirstWord[firstWord] = [signature];
        } else {
            candidates.push(signature);
        }
    }
    const byFirstWord = Object.create(null) as Record<
        string,
        readonly UnsupportedSyntaxSignature[]
    >;
    for (const firstWord of Object.keys(mutableByFirstWord)) {
        byFirstWord[firstWord] = freezeImmutableArray(
            mutableByFirstWord[firstWord]!
        );
    }
    const view = Object.freeze({
        signatures,
        byFirstWord: Object.freeze(byFirstWord),
    });
    dialectCache[syntaxContext] = view;
    return view;
}

function candidateSignaturesAt(
    context: ParserContext,
    index: number,
    view: UnsupportedSignatureView
): readonly UnsupportedSyntaxSignature[] {
    const leaf = context.leaves[index];
    if (leaf?.channel !== "code") {
        return EMPTY_FROZEN_ARRAY;
    }
    return (
        view.byFirstWord[context.table.normalizedWord(index)] ??
        EMPTY_FROZEN_ARRAY
    );
}

function matchWordsAtSameDepth(
    context: ParserContext,
    start: number,
    end: number,
    words: readonly string[]
): readonly number[] | null {
    const matched = matchesSyntaxWords(context, start, end, words);
    if (matched === null) {
        return null;
    }
    const depth = context.table.depthBefore(start);
    return matched.every(
        (index) => context.table.depthBefore(index) === depth
    )
        ? matched
        : null;
}

function matchAt(
    context: ParserContext,
    range: LeafRange,
    start: number,
    signature: UnsupportedSyntaxSignature
): UnsupportedConstructMatch | null {
    const matched = matchWordsAtSameDepth(
        context,
        start,
        range.end,
        signature.words
    );
    if (matched === null) {
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
    const view = signatureViewFor(context, "statement-start");
    for (const signature of candidateSignaturesAt(context, range.start, view)) {
        const match = matchAt(context, range, range.start, signature);
        if (match !== null) {
            return match;
        }
    }
    return null;
}

function nextQueryClauseStart(
    context: ParserContext,
    indexes: readonly number[],
    after: number,
    rangeEnd: number,
    afterOrder: number
): number {
    const clauses = getDialect(context.dialect).listQueryClauseSyntax();
    for (const index of indexes) {
        if (index < after) {
            continue;
        }
        if (clauses.some(
            (syntax) =>
                syntax.order > afterOrder &&
                matchWordsAtSameDepth(
                    context,
                    index,
                    rangeEnd,
                    syntax.words
                ) !== null
        )) {
            return index;
        }
    }
    return rangeEnd;
}

export function classifyUnsupportedGroupBySuffix(
    context: ParserContext,
    range: LeafRange,
    topLevelIndexes: readonly number[] = topLevelSyntaxIndexes(context, range)
): UnsupportedConstructMatch | null {
    const view = signatureViewFor(context, "group-by-suffix");
    let groupByEnd: number | null = null;
    for (const index of topLevelIndexes) {
        const matched = matchWordsAtSameDepth(
            context,
            index,
            range.end,
            ["group", "by"]
        );
        if (matched !== null) {
            groupByEnd = matched[matched.length - 1]! + 1;
            break;
        }
    }
    if (groupByEnd === null) {
        return null;
    }
    const groupBySegmentEnd = nextQueryClauseStart(
        context,
        topLevelIndexes,
        groupByEnd,
        range.end,
        30
    );
    for (const index of topLevelIndexes) {
        if (index <= groupByEnd || index >= groupBySegmentEnd) {
            continue;
        }
        for (const signature of candidateSignaturesAt(context, index, view)) {
            const match = matchAt(context, range, index, signature);
            if (match === null) {
                continue;
            }
            const firstGroupExpression = nextSyntaxIndex(
                context,
                groupByEnd - 1,
                match.range.start
            );
            const open = nextSyntaxIndex(
                context,
                match.range.end - 1,
                groupBySegmentEnd
            );
            if (
                firstGroupExpression === null ||
                open === null ||
                context.leaves[open]?.channel !== "code" ||
                context.leaves[open]?.raw !== "(" ||
                context.table.depthBefore(open) !== context.table.depthBefore(index)
            ) {
                continue;
            }
            const close = context.table.matchingDelimiterIndex(open);
            if (close === null || close >= groupBySegmentEnd) {
                continue;
            }
            const after = nextSyntaxIndex(context, close, groupBySegmentEnd);
            if (after !== null && context.leaves[after]?.raw !== ";") {
                continue;
            }
            return match;
        }
    }
    return null;
}

export function classifyUnsupportedSelectItemPrefix(
    context: ParserContext,
    range: LeafRange,
    topLevelIndexes: readonly number[] = topLevelSyntaxIndexes(context, range)
): UnsupportedConstructMatch | null {
    if (
        topLevelIndexes.length < 2 ||
        !isCodeWord(context, topLevelIndexes[0]!, "select")
    ) {
        return null;
    }
    const index = topLevelIndexes[1]!;
    const view = signatureViewFor(context, "select-item-prefix");
    for (const signature of candidateSignaturesAt(context, index, view)) {
        const match = matchAt(context, range, index, signature);
        if (match === null) {
            continue;
        }
        const open = nextSyntaxIndex(
            context,
            match.range.end - 1,
            range.end
        );
        if (
            open === null ||
            context.leaves[open]?.channel !== "code" ||
            context.leaves[open]?.raw !== "(" ||
            context.table.depthBefore(open) !== context.table.depthBefore(index)
        ) {
            continue;
        }
        const close = context.table.matchingDelimiterIndex(open);
        const usingLeaf = close === null
            ? null
            : nextSyntaxIndex(context, close, range.end);
        const commandLeaf = usingLeaf === null
            ? null
            : nextSyntaxIndex(context, usingLeaf, range.end);
        const asLeaf = commandLeaf === null
            ? null
            : nextSyntaxIndex(context, commandLeaf, range.end);
        const outputOpen = asLeaf === null
            ? null
            : nextSyntaxIndex(context, asLeaf, range.end);
        if (
            close === null ||
            close >= range.end ||
            usingLeaf === null ||
            !isCodeWord(context, usingLeaf, "using") ||
            commandLeaf === null ||
            context.leaves[commandLeaf]?.kind !== "string" ||
            asLeaf === null ||
            !isCodeWord(context, asLeaf, "as") ||
            outputOpen === null ||
            context.leaves[outputOpen]?.channel !== "code" ||
            context.leaves[outputOpen]?.raw !== "("
        ) {
            continue;
        }
        const outputClose = context.table.matchingDelimiterIndex(outputOpen);
        if (outputClose === null || outputClose >= range.end) {
            continue;
        }
        const after = nextSyntaxIndex(context, outputClose, range.end);
        if (
            after !== null &&
            context.leaves[after]?.raw !== ";" &&
            !isCodeWord(context, after, "from")
        ) {
            continue;
        }
        return match;
    }
    return null;
}

export function rejectUnsupportedRelationConstructs(
    context: ParserContext,
    range: LeafRange,
    indexes: readonly number[]
): void {
    const view = signatureViewFor(context, "relation-suffix");
    for (let position = 1; position < indexes.length; position++) {
        const index = indexes[position]!;
        const signatures = candidateSignaturesAt(context, index, view);
        if (signatures.length === 0) {
            continue;
        }
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
                "statement",
                signature.capabilityId
            );
        }
    }
}

export function findUnsupportedQueryClauseCandidates(
    context: ParserContext,
    range: LeafRange,
    topLevelIndexes: readonly number[] = topLevelSyntaxIndexes(context, range)
): readonly UnsupportedConstructMatch[] {
    const view = signatureViewFor(context, "query-clause");
    const matches: UnsupportedConstructMatch[] = [];
    for (const index of topLevelIndexes) {
        const signatures = candidateSignaturesAt(context, index, view);
        if (signatures.length === 0) {
            continue;
        }
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
