import {
    EAST_ASIAN_WIDE_OR_FULLWIDTH,
    EMOJI,
    EMOJI_MODIFIER,
    EMOJI_MODIFIER_BASE,
    EMOJI_PRESENTATION,
    EXTENDED_PICTOGRAPHIC,
    GCB_CONTROL,
    GCB_EXTEND,
    GCB_L,
    GCB_LV,
    GCB_LVT,
    GCB_PREPEND,
    GCB_REGIONAL_INDICATOR,
    GCB_SPACING_MARK,
    GCB_T,
    GCB_V,
    GCB_ZWJ,
    INCB_CONSONANT,
    INCB_EXTEND,
    INCB_LINKER,
    UNICODE_VERSION,
    codePointInRanges,
} from "./unicode-width-data";

export { UNICODE_VERSION };

const TAB_STOP = 4;
const CR = 0x0D;
const LF = 0x0A;
const VARIATION_SELECTOR_16 = 0xFE0F;
const COMBINING_ENCLOSING_KEYCAP = 0x20E3;

const enum GraphemeBreak {
    Other,
    Control,
    Extend,
    Prepend,
    SpacingMark,
    ZWJ,
    RegionalIndicator,
    L,
    V,
    T,
    LV,
    LVT,
    CR,
    LF,
}

interface CodePointRecord {
    readonly value: number;
    readonly codeUnits: number;
}

interface ClusterState {
    previousBreak: GraphemeBreak;
    regionalIndicatorCount: number;
    extendedPictographicExtendSuffix: boolean;
    previousZwjFollowsExtendedPictographic: boolean;
    indicConsonantChain: boolean;
    indicLinkerSeen: boolean;
}

interface ClusterWidthState {
    hasWide: boolean;
    hasEmoji: boolean;
    hasEmojiPresentation: boolean;
    hasEmojiModifier: boolean;
    hasEmojiModifierBase: boolean;
    hasVariationSelector16: boolean;
    hasExtendedPictographic: boolean;
    hasExtendedPictographicZwjSequence: boolean;
    hasRegionalIndicator: boolean;
    firstIsKeycapBase: boolean;
    hasKeycapMark: boolean;
}

interface ClusterMeasurement {
    readonly end: number;
    readonly width: number;
}

export interface DisplayTextMeasurement {
    readonly endColumn: number;
    readonly maxColumn: number;
    readonly lineBreakCount: number;
    readonly containsLineBreak: boolean;
    readonly containsTab: boolean;
    readonly startsWithLineBreak: boolean;
    readonly endsWithLineBreak: boolean;
}

function readCodePoint(text: string, index: number): CodePointRecord {
    const first = text.charCodeAt(index);
    if (
        first >= 0xD800 &&
        first <= 0xDBFF &&
        index + 1 < text.length
    ) {
        const second = text.charCodeAt(index + 1);
        if (second >= 0xDC00 && second <= 0xDFFF) {
            return {
                value:
                    ((first - 0xD800) << 10) +
                    (second - 0xDC00) +
                    0x10000,
                codeUnits: 2,
            };
        }
    }
    return { value: first, codeUnits: 1 };
}

function graphemeBreakOf(codePoint: number): GraphemeBreak {
    if (codePoint === CR) {
        return GraphemeBreak.CR;
    }
    if (codePoint === LF) {
        return GraphemeBreak.LF;
    }
    if (codePointInRanges(codePoint, GCB_CONTROL)) {
        return GraphemeBreak.Control;
    }
    if (codePointInRanges(codePoint, GCB_EXTEND)) {
        return GraphemeBreak.Extend;
    }
    if (codePointInRanges(codePoint, GCB_PREPEND)) {
        return GraphemeBreak.Prepend;
    }
    if (codePointInRanges(codePoint, GCB_SPACING_MARK)) {
        return GraphemeBreak.SpacingMark;
    }
    if (codePointInRanges(codePoint, GCB_ZWJ)) {
        return GraphemeBreak.ZWJ;
    }
    if (codePointInRanges(codePoint, GCB_REGIONAL_INDICATOR)) {
        return GraphemeBreak.RegionalIndicator;
    }
    if (codePointInRanges(codePoint, GCB_L)) {
        return GraphemeBreak.L;
    }
    if (codePointInRanges(codePoint, GCB_V)) {
        return GraphemeBreak.V;
    }
    if (codePointInRanges(codePoint, GCB_T)) {
        return GraphemeBreak.T;
    }
    if (codePointInRanges(codePoint, GCB_LV)) {
        return GraphemeBreak.LV;
    }
    if (codePointInRanges(codePoint, GCB_LVT)) {
        return GraphemeBreak.LVT;
    }
    return GraphemeBreak.Other;
}

function isControl(value: GraphemeBreak): boolean {
    return (
        value === GraphemeBreak.Control ||
        value === GraphemeBreak.CR ||
        value === GraphemeBreak.LF
    );
}

function isExtendedPictographic(codePoint: number): boolean {
    return codePointInRanges(codePoint, EXTENDED_PICTOGRAPHIC);
}

function shouldBreakCluster(
    state: ClusterState,
    currentCodePoint: number,
    currentBreak: GraphemeBreak
): boolean {
    const previous = state.previousBreak;
    if (previous === GraphemeBreak.CR && currentBreak === GraphemeBreak.LF) {
        return false;
    }
    if (isControl(previous) || isControl(currentBreak)) {
        return true;
    }
    if (
        previous === GraphemeBreak.L &&
        (currentBreak === GraphemeBreak.L ||
            currentBreak === GraphemeBreak.V ||
            currentBreak === GraphemeBreak.LV ||
            currentBreak === GraphemeBreak.LVT)
    ) {
        return false;
    }
    if (
        (previous === GraphemeBreak.LV || previous === GraphemeBreak.V) &&
        (currentBreak === GraphemeBreak.V || currentBreak === GraphemeBreak.T)
    ) {
        return false;
    }
    if (
        (previous === GraphemeBreak.LVT || previous === GraphemeBreak.T) &&
        currentBreak === GraphemeBreak.T
    ) {
        return false;
    }
    if (
        currentBreak === GraphemeBreak.Extend ||
        currentBreak === GraphemeBreak.ZWJ ||
        currentBreak === GraphemeBreak.SpacingMark ||
        previous === GraphemeBreak.Prepend
    ) {
        return false;
    }
    if (
        codePointInRanges(currentCodePoint, INCB_CONSONANT) &&
        state.indicConsonantChain &&
        state.indicLinkerSeen
    ) {
        return false;
    }
    if (
        isExtendedPictographic(currentCodePoint) &&
        previous === GraphemeBreak.ZWJ &&
        state.previousZwjFollowsExtendedPictographic
    ) {
        return false;
    }
    if (
        previous === GraphemeBreak.RegionalIndicator &&
        currentBreak === GraphemeBreak.RegionalIndicator &&
        state.regionalIndicatorCount % 2 === 1
    ) {
        return false;
    }
    return true;
}

function updateClusterState(
    state: ClusterState,
    codePoint: number,
    currentBreak: GraphemeBreak
): void {
    if (currentBreak === GraphemeBreak.Extend) {
        state.previousZwjFollowsExtendedPictographic = false;
    } else if (currentBreak === GraphemeBreak.ZWJ) {
        state.previousZwjFollowsExtendedPictographic =
            state.extendedPictographicExtendSuffix;
        state.extendedPictographicExtendSuffix = false;
    } else {
        state.previousZwjFollowsExtendedPictographic = false;
        state.extendedPictographicExtendSuffix =
            isExtendedPictographic(codePoint);
    }

    const isIndicConsonant = codePointInRanges(codePoint, INCB_CONSONANT);
    if (isIndicConsonant) {
        state.indicConsonantChain = true;
        state.indicLinkerSeen = false;
    } else if (
        state.indicConsonantChain &&
        (codePointInRanges(codePoint, INCB_EXTEND) ||
            codePointInRanges(codePoint, INCB_LINKER))
    ) {
        if (codePointInRanges(codePoint, INCB_LINKER)) {
            state.indicLinkerSeen = true;
        }
    } else {
        state.indicConsonantChain = false;
        state.indicLinkerSeen = false;
    }

    if (currentBreak === GraphemeBreak.RegionalIndicator) {
        state.regionalIndicatorCount =
            state.previousBreak === GraphemeBreak.RegionalIndicator
                ? state.regionalIndicatorCount + 1
                : 1;
    } else {
        state.regionalIndicatorCount = 0;
    }
    state.previousBreak = currentBreak;
}

function isKeycapBase(codePoint: number): boolean {
    return (
        codePoint === 0x23 ||
        codePoint === 0x2A ||
        (codePoint >= 0x30 && codePoint <= 0x39)
    );
}

function updateWidthState(
    state: ClusterWidthState,
    codePoint: number,
    isFirst: boolean,
    previousZwjFollowsExtendedPictographic: boolean
): void {
    const extendedPictographic = isExtendedPictographic(codePoint);
    state.hasWide =
        state.hasWide ||
        codePointInRanges(codePoint, EAST_ASIAN_WIDE_OR_FULLWIDTH);
    state.hasEmoji = state.hasEmoji || codePointInRanges(codePoint, EMOJI);
    state.hasEmojiPresentation =
        state.hasEmojiPresentation ||
        codePointInRanges(codePoint, EMOJI_PRESENTATION);
    state.hasEmojiModifier =
        state.hasEmojiModifier || codePointInRanges(codePoint, EMOJI_MODIFIER);
    state.hasEmojiModifierBase =
        state.hasEmojiModifierBase ||
        codePointInRanges(codePoint, EMOJI_MODIFIER_BASE);
    state.hasVariationSelector16 =
        state.hasVariationSelector16 || codePoint === VARIATION_SELECTOR_16;
    state.hasExtendedPictographicZwjSequence =
        state.hasExtendedPictographicZwjSequence ||
        (extendedPictographic && previousZwjFollowsExtendedPictographic);
    state.hasExtendedPictographic =
        state.hasExtendedPictographic || extendedPictographic;
    state.hasRegionalIndicator =
        state.hasRegionalIndicator ||
        codePointInRanges(codePoint, GCB_REGIONAL_INDICATOR);
    state.firstIsKeycapBase =
        state.firstIsKeycapBase || (isFirst && isKeycapBase(codePoint));
    state.hasKeycapMark =
        state.hasKeycapMark || codePoint === COMBINING_ENCLOSING_KEYCAP;
}

function clusterWidth(state: ClusterWidthState): number {
    return (
        state.hasWide ||
        state.hasEmojiPresentation ||
        (state.hasVariationSelector16 &&
            (state.hasEmoji || state.hasExtendedPictographic)) ||
        (state.hasEmojiModifier && state.hasEmojiModifierBase) ||
        state.hasExtendedPictographicZwjSequence ||
        state.hasRegionalIndicator ||
        (state.firstIsKeycapBase && state.hasKeycapMark)
    )
        ? 2
        : 1;
}

function measureCluster(text: string, start: number): ClusterMeasurement {
    const first = readCodePoint(text, start);
    const firstBreak = graphemeBreakOf(first.value);
    const state: ClusterState = {
        previousBreak: firstBreak,
        regionalIndicatorCount:
            firstBreak === GraphemeBreak.RegionalIndicator ? 1 : 0,
        extendedPictographicExtendSuffix:
            isExtendedPictographic(first.value),
        previousZwjFollowsExtendedPictographic: false,
        indicConsonantChain: codePointInRanges(first.value, INCB_CONSONANT),
        indicLinkerSeen: false,
    };
    const widthState: ClusterWidthState = {
        hasWide: false,
        hasEmoji: false,
        hasEmojiPresentation: false,
        hasEmojiModifier: false,
        hasEmojiModifierBase: false,
        hasVariationSelector16: false,
        hasExtendedPictographic: false,
        hasExtendedPictographicZwjSequence: false,
        hasRegionalIndicator: false,
        firstIsKeycapBase: false,
        hasKeycapMark: false,
    };
    updateWidthState(widthState, first.value, true, false);

    let cursor = start + first.codeUnits;
    while (cursor < text.length) {
        const current = readCodePoint(text, cursor);
        if (current.value === CR || current.value === LF || current.value === 0x09) {
            break;
        }
        const currentBreak = graphemeBreakOf(current.value);
        if (shouldBreakCluster(state, current.value, currentBreak)) {
            break;
        }
        const followsExtendedPictographicZwj =
            currentBreak !== GraphemeBreak.Extend &&
            currentBreak !== GraphemeBreak.ZWJ &&
            state.previousBreak === GraphemeBreak.ZWJ &&
            state.previousZwjFollowsExtendedPictographic;
        updateWidthState(
            widthState,
            current.value,
            false,
            followsExtendedPictographicZwj
        );
        updateClusterState(state, current.value, currentBreak);
        cursor += current.codeUnits;
    }
    return { end: cursor, width: clusterWidth(widthState) };
}

/**
 * Deterministic Unicode 15.1 text advance. It does not call host ICU,
 * normalize source text or allocate grapheme substrings.
 */
export function measureDisplayText(
    text: string,
    startColumn = 0
): DisplayTextMeasurement | null {
    if (
        typeof text !== "string" ||
        !Number.isSafeInteger(startColumn) ||
        startColumn < 0
    ) {
        return null;
    }
    let column = startColumn;
    let maxColumn = startColumn;
    let lineBreakCount = 0;
    let containsTab = false;
    let cursor = 0;
    while (cursor < text.length) {
        const codeUnit = text.charCodeAt(cursor);
        if (codeUnit === CR || codeUnit === LF) {
            if (codeUnit === CR && text.charCodeAt(cursor + 1) === LF) {
                cursor += 2;
            } else {
                cursor += 1;
            }
            lineBreakCount += 1;
            maxColumn = Math.max(maxColumn, column);
            column = 0;
            continue;
        }
        if (codeUnit === 0x09) {
            containsTab = true;
            const advance = TAB_STOP - (column % TAB_STOP);
            if (column > Number.MAX_SAFE_INTEGER - advance) {
                return null;
            }
            column += advance;
            maxColumn = Math.max(maxColumn, column);
            cursor += 1;
            continue;
        }
        const cluster = measureCluster(text, cursor);
        if (column > Number.MAX_SAFE_INTEGER - cluster.width) {
            return null;
        }
        column += cluster.width;
        maxColumn = Math.max(maxColumn, column);
        cursor = cluster.end;
    }

    const startsWithLineBreak =
        text.length > 0 &&
        (text.charCodeAt(0) === CR || text.charCodeAt(0) === LF);
    const finalCodeUnit = text.length === 0 ? -1 : text.charCodeAt(text.length - 1);
    return Object.freeze({
        endColumn: column,
        maxColumn,
        lineBreakCount,
        containsLineBreak: lineBreakCount > 0,
        containsTab,
        startsWithLineBreak,
        endsWithLineBreak: finalCodeUnit === CR || finalCodeUnit === LF,
    });
}

/** Returns relative single-line width, or null when the text contains a line break. */
export function displayWidth(text: string, startColumn = 0): number | null {
    const measured = measureDisplayText(text, startColumn);
    if (measured === null || measured.containsLineBreak) {
        return null;
    }
    return measured.endColumn - startColumn;
}

/** Internal conformance hook for the pinned UAX #29 scanner. */
export function graphemeClusterCount(text: string): number | null {
    if (typeof text !== "string") {
        return null;
    }
    let count = 0;
    let cursor = 0;
    while (cursor < text.length) {
        const codeUnit = text.charCodeAt(cursor);
        if (codeUnit === CR && text.charCodeAt(cursor + 1) === LF) {
            cursor += 2;
        } else if (codeUnit === CR || codeUnit === LF || codeUnit === 0x09) {
            cursor += 1;
        } else {
            cursor = measureCluster(text, cursor).end;
        }
        count += 1;
    }
    return count;
}
