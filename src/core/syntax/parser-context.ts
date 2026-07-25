import type { Dialect } from "../config/options";
import {
    isCapabilityIdentity,
    type CapabilityIdentity,
    type Diagnostic,
    type RecoveryAction,
} from "../diagnostics/diagnostic";
import type { SourceLeaf } from "../lexer/token";
import { freezeImmutableArray } from "../util/immutable-array";
import type { LeafRange } from "./leaf-range";
import type { NodeFactory } from "./node-factory";
import type {
    FormatRole,
    SyntaxLeafRole,
    SyntaxMarker,
    SyntaxMarkerId,
    SyntaxNodeFacts,
} from "./node";
import type { StructuralTokenTable } from "./token-table";
import type { ParseMode } from "./parser-backend";
import { isKeywordCaseRole } from "./contextual-fact-contract";

export type SyntaxDiagnosticCode =
    | "SYN_UNMODELED_CONSTRUCT"
    | "SYN_UNSUPPORTED_STATEMENT"
    | "SYN_UNEXPECTED_TOKEN"
    | "SYN_INCOMPLETE_CLAUSE"
    | "SYN_UNMATCHED_DELIMITER"
    | "SYN_MAX_DEPTH_EXCEEDED"
    | "SYN_INTERNAL_INVARIANT";

export interface ParserContext {
    readonly dialect: Dialect;
    readonly mode: ParseMode;
    readonly leaves: readonly SourceLeaf[];
    readonly table: StructuralTokenTable;
    readonly factory: NodeFactory;
    readonly diagnostics: Diagnostic[];
}

const EMPTY_SYNTAX_MARKERS: readonly SyntaxMarker[] = Object.freeze([]);
const INTRINSIC_CONTAINER_FACTS: SyntaxNodeFacts = Object.freeze({
    syntaxMarkers: EMPTY_SYNTAX_MARKERS,
    capabilityId: null,
    formatRole: "intrinsic-container",
});
const INTRINSIC_PRIMITIVE_FACTS: SyntaxNodeFacts = Object.freeze({
    syntaxMarkers: EMPTY_SYNTAX_MARKERS,
    capabilityId: null,
    formatRole: "intrinsic-primitive",
});

export function syntaxMarkers(
    leafIds: readonly number[],
    syntaxId: SyntaxMarkerId,
    syntaxRole: SyntaxLeafRole = "syntax-keyword",
    keywordCaseEligible: boolean = isKeywordCaseRole(syntaxRole)
): readonly SyntaxMarker[] {
    if (leafIds.length === 0) {
        return EMPTY_SYNTAX_MARKERS;
    }
    const markers: SyntaxMarker[] = new Array(leafIds.length);
    for (let partOrdinal = 0; partOrdinal < leafIds.length; partOrdinal++) {
        markers[partOrdinal] = {
            leafId: leafIds[partOrdinal]!,
            syntaxId,
            partOrdinal,
            syntaxRole,
            keywordCaseEligible,
        };
    }
    return markers;
}

export function mergeSyntaxMarkers(
    ...groups: readonly (readonly SyntaxMarker[])[]
): readonly SyntaxMarker[] {
    let onlyNonEmpty: readonly SyntaxMarker[] | null = null;
    for (const group of groups) {
        if (group.length === 0) {
            continue;
        }
        if (onlyNonEmpty !== null) {
            onlyNonEmpty = null;
            break;
        }
        onlyNonEmpty = group;
    }
    if (onlyNonEmpty !== null) {
        return onlyNonEmpty;
    }
    if (groups.every((group) => group.length === 0)) {
        return EMPTY_SYNTAX_MARKERS;
    }
    const sorted = groups.flat().slice().sort((left, right) => left.leafId - right.leafId);
    return sorted.filter((marker, index) => {
        const previous = sorted[index - 1];
        return previous === undefined ||
            previous.leafId !== marker.leafId ||
            previous.syntaxId !== marker.syntaxId ||
            previous.syntaxRole !== marker.syntaxRole ||
            previous.keywordCaseEligible !== marker.keywordCaseEligible;
    });
}

export function nodeFacts(
    capabilityId: CapabilityIdentity,
    formatRole: FormatRole,
    markers: readonly SyntaxMarker[] = []
): SyntaxNodeFacts {
    if (capabilityId === null && markers.length === 0) {
        if (formatRole === "intrinsic-container") {
            return INTRINSIC_CONTAINER_FACTS;
        }
        if (formatRole === "intrinsic-primitive") {
            return INTRINSIC_PRIMITIVE_FACTS;
        }
    }
    return {
        syntaxMarkers: markers,
        capabilityId,
        formatRole,
    };
}

export class ParserSyntaxError extends Error {
    readonly code: SyntaxDiagnosticCode;
    readonly range: LeafRange;
    readonly minimumBoundary: "local" | "statement";
    readonly capabilityId: CapabilityIdentity;

    constructor(
        code: SyntaxDiagnosticCode,
        range: LeafRange,
        message: string,
        minimumBoundary: "local" | "statement" = "local",
        capabilityId: CapabilityIdentity = null
    ) {
        super(message);
        if (!isCapabilityIdentity(capabilityId)) {
            throw new Error(`Invalid capability identity: ${String(capabilityId)}`);
        }
        this.name = "ParserSyntaxError";
        this.code = code;
        this.range = Object.freeze({ start: range.start, end: range.end });
        this.minimumBoundary = minimumBoundary;
        this.capabilityId = capabilityId;
    }
}

export function isSyntaxLeaf(leaf: SourceLeaf): boolean {
    return leaf.channel === "code" || leaf.channel === "protected";
}

export function isAliasNameLeaf(leaf: SourceLeaf): boolean {
    return (
        leaf.kind === "identifier" ||
        leaf.kind === "keyword" ||
        leaf.kind === "quoted-identifier"
    );
}

export function trimToSyntax(
    leaves: readonly SourceLeaf[],
    range: LeafRange
): LeafRange | null {
    let start = range.start;
    let end = range.end;
    while (start < end && !isSyntaxLeaf(leaves[start]!)) {
        start += 1;
    }
    while (end > start && !isSyntaxLeaf(leaves[end - 1]!)) {
        end -= 1;
    }
    return start < end ? Object.freeze({ start, end }) : null;
}

export function firstSyntaxIndex(
    leaves: readonly SourceLeaf[],
    range: LeafRange
): number | null {
    for (let index = range.start; index < range.end; index++) {
        if (isSyntaxLeaf(leaves[index]!)) {
            return index;
        }
    }
    return null;
}

export function lastSyntaxIndex(
    leaves: readonly SourceLeaf[],
    range: LeafRange
): number | null {
    for (let index = range.end - 1; index >= range.start; index--) {
        if (isSyntaxLeaf(leaves[index]!)) {
            return index;
        }
    }
    return null;
}

export function nextSyntaxIndex(
    context: ParserContext,
    leafIndex: number,
    rangeEnd: number
): number | null {
    const leaf = context.leaves[leafIndex];
    let next: number | null = null;
    if (leaf && isSyntaxLeaf(leaf)) {
        next = context.table.nextSyntaxLeafIndex(leafIndex);
    } else {
        for (let i = leafIndex + 1; i < rangeEnd; i++) {
            if (isSyntaxLeaf(context.leaves[i]!)) {
                next = i;
                break;
            }
        }
    }
    return next !== null && next < rangeEnd ? next : null;
}

export function previousSyntaxIndex(
    context: ParserContext,
    leafIndex: number,
    rangeStart: number
): number | null {
    const leaf = context.leaves[leafIndex];
    let previous: number | null = null;
    if (leaf && isSyntaxLeaf(leaf)) {
        previous = context.table.previousSyntaxLeafIndex(leafIndex);
    } else {
        for (let i = leafIndex - 1; i >= rangeStart; i--) {
            if (isSyntaxLeaf(context.leaves[i]!)) {
                previous = i;
                break;
            }
        }
    }
    return previous !== null && previous >= rangeStart ? previous : null;
}

export function isDottedNamePart(
    context: ParserContext,
    leafIndex: number,
    rangeStart: number,
    rangeEnd: number
): boolean {
    const previous = previousSyntaxIndex(context, leafIndex, rangeStart);
    const next = nextSyntaxIndex(context, leafIndex, rangeEnd);
    return (
        (previous !== null && context.leaves[previous]!.raw === ".") ||
        (next !== null && context.leaves[next]!.raw === ".")
    );
}

export function isCodeWord(
    context: ParserContext,
    leafIndex: number,
    expected: string
): boolean {
    const leaf = context.leaves[leafIndex];
    return (
        leaf !== undefined &&
        leaf.channel === "code" &&
        context.table.normalizedWord(leafIndex) === expected.toLowerCase()
    );
}

export function isQueryLeadingRange(
    context: ParserContext,
    range: LeafRange
): boolean {
    let current = trimToSyntax(context.leaves, range);
    while (
        current !== null &&
        context.leaves[current.start]!.channel === "code" &&
        context.leaves[current.start]!.raw === "("
    ) {
        const close = context.table.matchingDelimiterIndex(current.start);
        if (close === null || close >= current.end) {
            return false;
        }
        current = trimToSyntax(context.leaves, {
            start: current.start + 1,
            end: close,
        });
    }
    return (
        current !== null &&
        (isCodeWord(context, current.start, "select") ||
            isCodeWord(context, current.start, "with"))
    );
}

export function matchesSyntaxWords(
    context: ParserContext,
    startLeafIndex: number,
    rangeEnd: number,
    words: readonly string[]
): readonly number[] | null {
    const indexes: number[] = [];
    let current: number | null = startLeafIndex;
    for (const word of words) {
        if (current === null || current >= rangeEnd || !isCodeWord(context, current, word)) {
            return null;
        }
        indexes.push(current);
        current = nextSyntaxIndex(context, current, rangeEnd);
    }
    return freezeImmutableArray(indexes);
}

export function syntaxIndexesInRange(
    context: ParserContext,
    range: LeafRange
): readonly number[] {
    const firstOrdinal = firstSyntaxOrdinalInRange(context, range);
    if (firstOrdinal === null) {
        return freezeImmutableArray([]);
    }
    const lastOrdinal = lastSyntaxOrdinalInRange(context, range)!;
    const indexes: number[] = [];
    for (let ordinal = firstOrdinal; ordinal <= lastOrdinal; ordinal++) {
        indexes.push(context.table.leafIndexOfSyntaxOrdinal(ordinal));
    }
    return freezeImmutableArray(indexes);
}

export function firstSyntaxOrdinalInRange(
    context: ParserContext,
    range: LeafRange
): number | null {
    const first = firstSyntaxIndex(context.leaves, range);
    return first === null ? null : context.table.syntaxOrdinalOfLeaf(first);
}

export function lastSyntaxOrdinalInRange(
    context: ParserContext,
    range: LeafRange
): number | null {
    const last = lastSyntaxIndex(context.leaves, range);
    return last === null ? null : context.table.syntaxOrdinalOfLeaf(last);
}

export function baseDepth(context: ParserContext, range: LeafRange): number {
    const first = firstSyntaxIndex(context.leaves, range);
    return first === null ? 0 : context.table.depthBefore(first);
}

export function topLevelSyntaxIndexes(
    context: ParserContext,
    range: LeafRange
): readonly number[] {
    const depth = baseDepth(context, range);
    const firstOrdinal = firstSyntaxOrdinalInRange(context, range);
    if (firstOrdinal === null) {
        return freezeImmutableArray([]);
    }
    const lastOrdinal = lastSyntaxOrdinalInRange(context, range)!;
    const indexes: number[] = [];
    for (let ordinal = firstOrdinal; ordinal <= lastOrdinal; ordinal++) {
        const index = context.table.leafIndexOfSyntaxOrdinal(ordinal);
        if (context.table.depthBefore(index) === depth) {
            indexes.push(index);
        }
    }
    return freezeImmutableArray(indexes);
}

export function syntaxLeavesAreSeparated(
    context: ParserContext,
    leftIndex: number,
    rightIndex: number
): boolean {
    return (
        context.leaves[leftIndex]!.span.end <
        context.leaves[rightIndex]!.span.start
    );
}

export function splitTopLevelByComma(
    context: ParserContext,
    range: LeafRange
): { readonly ranges: readonly LeafRange[]; readonly separators: readonly number[] } {
    const trimmed = trimToSyntax(context.leaves, range);
    if (trimmed === null) {
        return Object.freeze({
            ranges: freezeImmutableArray([]),
            separators: freezeImmutableArray([]),
        });
    }
    const depth = baseDepth(context, trimmed);
    const separators: number[] = [];
    const firstOrdinal = firstSyntaxOrdinalInRange(context, trimmed);
    if (firstOrdinal !== null) {
        const lastOrdinal = lastSyntaxOrdinalInRange(context, trimmed)!;
        for (let ordinal = firstOrdinal; ordinal <= lastOrdinal; ordinal++) {
            const index = context.table.leafIndexOfSyntaxOrdinal(ordinal);
            const leaf = context.leaves[index]!;
            if (
                leaf.channel === "code" &&
                leaf.raw === "," &&
                context.table.depthBefore(index) === depth
            ) {
                separators.push(index);
            }
        }
    }

    const ranges: LeafRange[] = [];
    let start = trimmed.start;
    for (const separator of separators) {
        const part = trimToSyntax(context.leaves, { start, end: separator });
        if (part === null) {
            throw new ParserSyntaxError(
                "SYN_UNEXPECTED_TOKEN",
                { start: separator, end: separator + 1 },
                "Empty list item around comma"
            );
        }
        ranges.push(part);
        start = separator + 1;
    }
    const last = trimToSyntax(context.leaves, { start, end: trimmed.end });
    if (last === null) {
        const anchor = separators.length > 0 ? separators[separators.length - 1]! : trimmed.end - 1;
        throw new ParserSyntaxError(
            "SYN_UNEXPECTED_TOKEN",
            { start: anchor, end: anchor + 1 },
            "List must not end with an empty item"
        );
    }
    ranges.push(last);

    return Object.freeze({
        ranges: freezeImmutableArray(ranges),
        separators: freezeImmutableArray(separators),
    });
}

export function addDiagnostic(
    context: ParserContext,
    code: SyntaxDiagnosticCode,
    range: LeafRange,
    message: string,
    recovery: RecoveryAction,
    severity: Diagnostic["severity"] = "warning",
    capabilityId: CapabilityIdentity = null
): Diagnostic {
    if (!isCapabilityIdentity(capabilityId)) {
        throw new Error(`Invalid capability identity: ${String(capabilityId)}`);
    }
    const diagnostic: Diagnostic = Object.freeze({
        code,
        severity,
        message,
        capabilityId,
        span: context.table.rangeToSpan(range),
        recovery,
    });
    context.diagnostics.push(diagnostic);
    return diagnostic;
}

export function finalizeDiagnostics(values: readonly Diagnostic[]): readonly Diagnostic[] {
    const severityRank: Readonly<Record<Diagnostic["severity"], number>> = Object.freeze({
        error: 0,
        warning: 1,
        info: 2,
    });
    const sorted = Array.from(values).sort((left, right) => {
        if (left.span.start !== right.span.start) {
            return left.span.start - right.span.start;
        }
        if (left.span.end !== right.span.end) {
            return left.span.end - right.span.end;
        }
        if (severityRank[left.severity] !== severityRank[right.severity]) {
            return severityRank[left.severity] - severityRank[right.severity];
        }
        if (left.code !== right.code) {
            return left.code < right.code ? -1 : 1;
        }
        if (left.message !== right.message) {
            return left.message < right.message ? -1 : 1;
        }
        if (left.recovery !== right.recovery) {
            return left.recovery < right.recovery ? -1 : 1;
        }
        if (left.capabilityId === right.capabilityId) {
            return 0;
        }
        if (left.capabilityId === null) {
            return -1;
        }
        if (right.capabilityId === null) {
            return 1;
        }
        return left.capabilityId < right.capabilityId ? -1 : 1;
    });

    const deduped: Diagnostic[] = [];
    let previousKey = "";
    for (const diagnostic of sorted) {
        const key = [
            diagnostic.span.start,
            diagnostic.span.end,
            diagnostic.severity,
            diagnostic.code,
            diagnostic.recovery,
            diagnostic.message,
            diagnostic.capabilityId,
        ].join("\0");
        if (key === previousKey) {
            continue;
        }
        previousKey = key;
        deduped.push(Object.freeze({ ...diagnostic }));
    }
    return freezeImmutableArray(deduped);
}
