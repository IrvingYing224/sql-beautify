import type { Diagnostic } from "../diagnostics/diagnostic";
import { isTemplateFragment, type SourceLeaf, type TokenChannel, type TokenKind } from "./token";
import { KEYWORDS, operatorsFor } from "./lexical-profile";
import {
    codePointAt,
    codePointWidth,
    isAsciiDigit,
    isBinaryDigit,
    isHexDigit,
    isHorizontalWhitespace,
    isIdentifierContinue,
    isIdentifierStart,
    isNewlineChar,
} from "./character-class";

export interface LexOutput {
    readonly leaves: readonly SourceLeaf[];
    readonly diagnostics: readonly Diagnostic[];
}

interface ScannerState {
    source: string;
    length: number;
    cursor: number;
    nextId: number;
    leaves: SourceLeaf[];
    diagnostics: Diagnostic[];
}

const CHANNEL_BY_KIND: Record<TokenKind, TokenChannel> = {
    keyword: "code",
    identifier: "code",
    number: "code",
    operator: "code",
    punctuation: "code",
    string: "protected",
    "quoted-identifier": "protected",
    parameter: "protected",
    unknown: "protected",
    "line-comment": "trivia",
    "block-comment": "trivia",
    "byte-order-mark": "trivia",
    whitespace: "trivia",
    newline: "trivia",
};

const PUNCTUATION = new Set([",", ";", "(", ")", "[", "]", "{", "}", ".", ":"]);
const FRAGMENT_STOPS = new Set([",", "(", ")", ";"]);
function emitLeaf(
    state: ScannerState,
    kind: TokenKind,
    start: number,
    end: number
): void {
    if (end <= start) {
        throw new Error("Lexer refused to emit an empty leaf");
    }
    const raw = state.source.slice(start, end);
    const leaf: SourceLeaf = Object.freeze({
        id: state.nextId,
        kind,
        channel: CHANNEL_BY_KIND[kind],
        raw,
        span: Object.freeze({ start, end }),
    });
    state.leaves.push(leaf);
    state.nextId += 1;
    state.cursor = end;
}

function emitDiagnostic(
    state: ScannerState,
    code: string,
    message: string,
    start: number,
    end: number
): void {
    state.diagnostics.push(Object.freeze({
        code,
        severity: "error",
        message,
        capabilityId: null,
        span: Object.freeze({ start, end }),
        recovery: "preserve-target",
    }));
}

function charAt(state: ScannerState, index: number): string {
    return state.source.charAt(index);
}

function startsWith(state: ScannerState, value: string, index: number = state.cursor): boolean {
    return state.source.startsWith(value, index);
}

/**
 * Scan a quoted body starting at `quoteIndex` (the opening quote).
 * Returns the exclusive end offset and whether the unit terminated.
 *
 * When allowBackslashEscape is true (Hive strings), a backslash skips the next
 * code unit so `\'` does not close the string.
 */
function scanQuotedBody(
    state: ScannerState,
    quoteIndex: number,
    quote: string,
    allowBackslashEscape: boolean
): { end: number; terminated: boolean } {
    let end = quoteIndex + 1;
    while (end < state.length) {
        const ch = charAt(state, end);
        if (allowBackslashEscape && ch === "\\" && end + 1 < state.length) {
            end += 2;
            continue;
        }
        if (ch === quote) {
            if (charAt(state, end + 1) === quote) {
                end += 2;
                continue;
            }
            return { end: end + 1, terminated: true };
        }
        end += codePointWidth(codePointAt(state.source, end) ?? 0);
    }
    return { end: state.length, terminated: false };
}

function emitQuotedUnit(
    state: ScannerState,
    leafStart: number,
    quoteIndex: number,
    quote: string,
    kind: "string" | "quoted-identifier",
    allowBackslashEscape: boolean
): void {
    const body = scanQuotedBody(state, quoteIndex, quote, allowBackslashEscape);
    let end = body.end;
    if (!body.terminated) {
        end = state.length;
        const code =
            kind === "string"
                ? "LEX_UNTERMINATED_STRING"
                : "LEX_UNTERMINATED_QUOTED_IDENTIFIER";
        const message =
            kind === "string"
                ? "Unterminated string literal."
                : "Unterminated quoted identifier.";
        emitDiagnostic(state, code, message, leafStart, end);
    }
    emitLeaf(state, kind, leafStart, end);
}

function scanNewline(state: ScannerState): boolean {
    const ch = charAt(state, state.cursor);
    if (ch === "\r" && charAt(state, state.cursor + 1) === "\n") {
        emitLeaf(state, "newline", state.cursor, state.cursor + 2);
        return true;
    }
    if (ch === "\n" || ch === "\r") {
        emitLeaf(state, "newline", state.cursor, state.cursor + 1);
        return true;
    }
    return false;
}

function scanBoundaryByteOrderMark(state: ScannerState): boolean {
    if (state.cursor !== 0 || charAt(state, state.cursor) !== "\uFEFF") {
        return false;
    }
    emitLeaf(state, "byte-order-mark", 0, 1);
    return true;
}

function scanWhitespace(state: ScannerState): boolean {
    if (!isHorizontalWhitespace(charAt(state, state.cursor))) {
        return false;
    }
    let end = state.cursor + 1;
    while (end < state.length && isHorizontalWhitespace(charAt(state, end))) {
        end += 1;
    }
    emitLeaf(state, "whitespace", state.cursor, end);
    return true;
}

function scanDashDashComment(state: ScannerState): boolean {
    if (!startsWith(state, "--")) {
        return false;
    }
    let end = state.cursor + 2;
    while (end < state.length && !isNewlineChar(charAt(state, end))) {
        end += 1;
    }
    emitLeaf(state, "line-comment", state.cursor, end);
    return true;
}

function scanBlockComment(state: ScannerState): boolean {
    if (!startsWith(state, "/*")) {
        return false;
    }
    const start = state.cursor;
    let end = start + 2;
    let terminated = false;
    while (end < state.length) {
        if (startsWith(state, "*/", end)) {
            end += 2;
            terminated = true;
            break;
        }
        end += codePointWidth(codePointAt(state.source, end) ?? 0);
    }

    if (!terminated) {
        end = state.length;
        emitDiagnostic(
            state,
            "LEX_UNTERMINATED_BLOCK_COMMENT",
            "Unterminated block comment.",
            start,
            end
        );
    }
    emitLeaf(state, "block-comment", start, end);
    return true;
}

function scanTemplateParameter(state: ScannerState): boolean {
    if (!startsWith(state, "${")) {
        return false;
    }
    const start = state.cursor;
    let end = start + 2;
    let depth = 1;
    let terminated = false;
    while (end < state.length) {
        if (startsWith(state, "${", end)) {
            depth += 1;
            end += 2;
            continue;
        }
        if (charAt(state, end) === "}") {
            end += 1;
            depth -= 1;
            if (depth === 0) {
                terminated = true;
                break;
            }
            continue;
        }
        end += codePointWidth(codePointAt(state.source, end) ?? 0);
    }
    if (!terminated) {
        end = state.length;
        emitDiagnostic(
            state,
            "LEX_UNTERMINATED_TEMPLATE",
            "Unterminated template parameter.",
            start,
            end
        );
    }
    emitLeaf(state, "parameter", start, end);
    return true;
}

/** Hive binary and bit string literals `X'…'` and `B'…'`: single quote only, no escapes. */
function scanPrefixedLiteral(state: ScannerState): boolean {
    const first = charAt(state, state.cursor).toUpperCase();
    if ((first === "X" || first === "B") && charAt(state, state.cursor + 1) === "'") {
        emitQuotedUnit(state, state.cursor, state.cursor + 1, "'", "string", false);
        return true;
    }
    return false;
}

/** Hive strings take either quote and backslash escapes; backticks quote identifiers. */
function scanQuoted(state: ScannerState): boolean {
    const ch = charAt(state, state.cursor);
    if (ch === "'" || ch === '"') {
        emitQuotedUnit(state, state.cursor, state.cursor, ch, "string", true);
        return true;
    }
    if (ch === "`") {
        emitQuotedUnit(state, state.cursor, state.cursor, "`", "quoted-identifier", false);
        return true;
    }
    return false;
}

function scanNumber(state: ScannerState): boolean {
    const start = state.cursor;
    const ch = charAt(state, start);

    if (ch === "0" && (charAt(state, start + 1) === "x" || charAt(state, start + 1) === "X")) {
        if (isHexDigit(charAt(state, start + 2))) {
            let end = start + 3;
            while (end < state.length && isHexDigit(charAt(state, end))) {
                end += 1;
            }
            emitLeaf(state, "number", start, end);
            return true;
        }
    }

    if (ch === "0" && (charAt(state, start + 1) === "b" || charAt(state, start + 1) === "B")) {
        if (isBinaryDigit(charAt(state, start + 2))) {
            let end = start + 3;
            while (end < state.length && isBinaryDigit(charAt(state, end))) {
                end += 1;
            }
            emitLeaf(state, "number", start, end);
            return true;
        }
    }

    let end = start;

    if (ch === ".") {
        if (!isAsciiDigit(charAt(state, start + 1))) {
            return false;
        }
        end = start + 1;
        while (end < state.length && isAsciiDigit(charAt(state, end))) {
            end += 1;
        }
    } else if (isAsciiDigit(ch)) {
        while (end < state.length && isAsciiDigit(charAt(state, end))) {
            end += 1;
        }
        if (charAt(state, end) === ".") {
            end += 1;
            while (end < state.length && isAsciiDigit(charAt(state, end))) {
                end += 1;
            }
        }
    } else {
        return false;
    }

    const exp = charAt(state, end);
    if (
        (exp === "e" || exp === "E") &&
        (isAsciiDigit(charAt(state, end + 1)) ||
            ((charAt(state, end + 1) === "+" || charAt(state, end + 1) === "-") &&
                isAsciiDigit(charAt(state, end + 2))))
    ) {
        end += 1;
        if (charAt(state, end) === "+" || charAt(state, end) === "-") {
            end += 1;
        }
        while (end < state.length && isAsciiDigit(charAt(state, end))) {
            end += 1;
        }
    }

    if (end > start) {
        emitLeaf(state, "number", start, end);
        return true;
    }
    return false;
}

function scanIdentifierOrKeyword(state: ScannerState): boolean {
    const start = state.cursor;
    if (!isIdentifierStart(charAt(state, start))) {
        return false;
    }
    let end = start + 1;
    // `$` continues a Hive identifier, but `${` always starts a template: `tbl_${dt}`.
    while (isIdentifierContinue(charAt(state, end)) && !startsWith(state, "${", end)) {
        end += 1;
    }
    // Identifier leaves are ASCII, so upper-casing them cannot change their length.
    const kind = KEYWORDS.has(state.source.slice(start, end).toUpperCase()) ? "keyword" : "identifier";
    emitLeaf(state, kind, start, end);
    return true;
}

function scanOperator(state: ScannerState): boolean {
    for (const op of operatorsFor(charAt(state, state.cursor))) {
        if (startsWith(state, op)) {
            emitLeaf(state, "operator", state.cursor, state.cursor + op.length);
            return true;
        }
    }
    return false;
}

/** Hive prepared-statement parameter `?`; `${…}` templates are scanned separately. */
function scanParameter(state: ScannerState): boolean {
    if (charAt(state, state.cursor) !== "?") {
        return false;
    }
    emitLeaf(state, "parameter", state.cursor, state.cursor + 1);
    return true;
}

function scanPunctuation(state: ScannerState): boolean {
    const ch = charAt(state, state.cursor);
    if (!PUNCTUATION.has(ch)) {
        return false;
    }
    emitLeaf(state, "punctuation", state.cursor, state.cursor + 1);
    return true;
}

function knownLeafStartsAfterUnknown(
    state: ScannerState,
    index: number
): boolean {
    const codePoint = codePointAt(state.source, index);
    if (codePoint === undefined) {
        return false;
    }
    const ch = charAt(state, index);
    if (codePoint > 0x7f) {
        return isHorizontalWhitespace(ch);
    }
    if (
        isNewlineChar(ch) ||
        isHorizontalWhitespace(ch) ||
        isAsciiDigit(ch) ||
        isIdentifierStart(ch) ||
        ch === "'" ||
        ch === '"' ||
        ch === "`" ||
        ch === "?" ||
        PUNCTUATION.has(ch) ||
        state.source.startsWith("${", index)
    ) {
        return true;
    }
    return operatorsFor(ch).some((operator) => state.source.startsWith(operator, index));
}

function scanUnknown(state: ScannerState): void {
    const start = state.cursor;
    const firstCodePoint = codePointAt(state.source, start);
    let end = start + Math.max(codePointWidth(firstCodePoint ?? 0), 1);
    while (
        end < state.length &&
        !knownLeafStartsAfterUnknown(state, end)
    ) {
        const codePoint = codePointAt(state.source, end);
        end += Math.max(codePointWidth(codePoint ?? 0), 1);
    }
    emitLeaf(state, "unknown", start, end);
}

function advanceOneLeaf(state: ScannerState): void {
    const startCursor = state.cursor;

    if (scanBoundaryByteOrderMark(state)) {
        return;
    }
    if (scanNewline(state)) {
        return;
    }
    if (scanWhitespace(state)) {
        return;
    }
    if (scanDashDashComment(state)) {
        return;
    }
    if (scanBlockComment(state)) {
        return;
    }
    if (scanTemplateParameter(state)) {
        return;
    }
    if (scanPrefixedLiteral(state)) {
        return;
    }
    if (scanQuoted(state)) {
        return;
    }
    if (scanNumber(state)) {
        return;
    }
    if (scanIdentifierOrKeyword(state)) {
        return;
    }
    if (scanOperator(state)) {
        return;
    }
    if (scanParameter(state)) {
        return;
    }
    if (scanPunctuation(state)) {
        return;
    }
    scanUnknown(state);

    if (state.cursor <= startCursor) {
        // Hard guarantee: cursor always advances.
        const forcedEnd = Math.min(state.length, startCursor + 1);
        if (forcedEnd > startCursor && state.cursor <= startCursor) {
            emitLeaf(state, "unknown", startCursor, forcedEnd);
        }
    }
}

export function lexSql(source: string): LexOutput {
    if (source.length === 0) {
        return {
            leaves: Object.freeze([]) as readonly SourceLeaf[],
            diagnostics: [],
        };
    }

    const state: ScannerState = {
        source,
        length: source.length,
        cursor: 0,
        nextId: 0,
        leaves: [],
        diagnostics: [],
    };

    while (state.cursor < state.length) {
        advanceOneLeaf(state);
    }
    return {
        leaves: Object.freeze(mergeTemplateFragments(source, state.leaves)),
        diagnostics: state.diagnostics,
    };
}

function fragmentAbsorbs(leaf: SourceLeaf): boolean {
    if (leaf.kind === "punctuation") {
        return !FRAGMENT_STOPS.has(leaf.raw);
    }
    return leaf.channel !== "trivia";
}

/**
 * Safety floor 5 (plan §4): a `${…}` template together with its zero-gap neighbours, up to
 * whitespace, a comment or `,` `(` `)` `;`, is one template fragment, such as `${p}desc`,
 * `ds=${dt}` or `db_${env}.tbl_${dt}`. Hive substitutes the text before lexing it, so the token
 * boundaries inside a fragment are unknown: the fragment becomes one protected parameter leaf.
 */
function mergeTemplateFragments(source: string, leaves: SourceLeaf[]): SourceLeaf[] {
    if (!leaves.some(isTemplateFragment)) {
        return leaves;
    }
    const merged: SourceLeaf[] = [];
    let index = 0;
    while (index < leaves.length) {
        let end = index + 1;
        let template = isTemplateFragment(leaves[index]!);
        if (fragmentAbsorbs(leaves[index]!)) {
            while (end < leaves.length && fragmentAbsorbs(leaves[end]!)) {
                template ||= isTemplateFragment(leaves[end]!);
                end += 1;
            }
        }
        if (template && end - index > 1) {
            const span = Object.freeze({
                start: leaves[index]!.span.start,
                end: leaves[end - 1]!.span.end,
            });
            merged.push(Object.freeze({
                id: merged.length,
                kind: "parameter",
                channel: CHANNEL_BY_KIND.parameter,
                raw: source.slice(span.start, span.end),
                span,
            }));
        } else {
            for (let leafIndex = index; leafIndex < end; leafIndex += 1) {
                const leaf = leaves[leafIndex]!;
                merged.push(leaf.id === merged.length
                    ? leaf
                    : Object.freeze({ ...leaf, id: merged.length }));
            }
        }
        index = end;
    }
    return merged;
}
