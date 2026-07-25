import type { Dialect } from "../config/options";
import type { Diagnostic } from "../diagnostics/diagnostic";
import type { SourceLeaf, TokenChannel, TokenKind } from "./token";
import { getLexicalProfile } from "./lexical-profile";
import {
    codePointAt,
    codePointWidth,
    isAsciiDigit,
    isAsciiLetter,
    isBinaryDigit,
    isHexDigit,
    isHorizontalWhitespace,
    isIdentifierContinue,
    isIdentifierStart,
    isNewlineChar,
} from "./character-class";

export interface LexOptions {
    readonly dialect?: Dialect;
}

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
    profile: ReturnType<typeof getLexicalProfile>;
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

interface ImmutableSourceLeafPartitionProof {
    readonly source: string;
    readonly dialect: Dialect;
}

const IMMUTABLE_SOURCE_LEAF_PARTITIONS = new WeakMap<
    readonly SourceLeaf[],
    ImmutableSourceLeafPartitionProof
>();

const CANONICAL_DIALECTS: ReadonlySet<string> = new Set([
    "hive",
    "generic",
    "postgresql",
    "mysql",
]);

function resolveDialect(dialect: string | undefined): Dialect {
    if (dialect === undefined) {
        return "hive";
    }
    if (!CANONICAL_DIALECTS.has(dialect)) {
        throw new Error(
            'Unsupported dialect "' +
                dialect +
                '". Expected one of: hive, generic, postgresql, mysql.'
        );
    }
    return dialect as Dialect;
}

/** Dollar-quote tag body: [A-Za-z_][A-Za-z0-9_]* — must not treat `$` as continue. */
function isDollarTagStart(ch: string): boolean {
    return isAsciiLetter(ch) || ch === "_";
}

function isDollarTagContinue(ch: string): boolean {
    return isAsciiLetter(ch) || isAsciiDigit(ch) || ch === "_";
}

/**
 * MySQL requires whitespace or a control character after `--` to start a comment.
 * Followers: U+0000..U+001F (C0 controls including NUL/tab/CR/LF), space U+0020, DEL U+007F.
 * U+0080+ is not an ASCII control. EOF after `--` starts an empty comment.
 */
function isMysqlDashDashFollower(ch: string, atEof: boolean): boolean {
    if (atEof) {
        return true;
    }
    if (ch.length === 0) {
        return false;
    }
    const code = ch.charCodeAt(0);
    return code <= 0x1f || code === 0x20 || code === 0x7f;
}

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

function freezeSourceLeafPartition(
    values: SourceLeaf[],
    source: string,
    dialect: Dialect
): readonly SourceLeaf[] {
    const partition = Object.freeze(values);
    IMMUTABLE_SOURCE_LEAF_PARTITIONS.set(
        partition,
        Object.freeze({ source, dialect })
    );
    return partition;
}

/** Internal proof that lexer-created leaf records and their partition cannot mutate. */
export function isImmutableSourceLeafPartition(
    value: unknown
): value is readonly SourceLeaf[] {
    return (
        Array.isArray(value) &&
        IMMUTABLE_SOURCE_LEAF_PARTITIONS.has(value)
    );
}

/** Internal proof that a canonical immutable leaf partition came from this exact source. */
export function isImmutableSourceLeafPartitionForSource(
    value: unknown,
    source: string
): boolean {
    return (
        Array.isArray(value) &&
        IMMUTABLE_SOURCE_LEAF_PARTITIONS.get(value)?.source === source
    );
}

/** Internal provenance for the dialect that produced a canonical partition. */
export function canonicalSourceLeafPartitionDialect(
    value: unknown
): Dialect | null {
    if (!Array.isArray(value)) {
        return null;
    }
    return IMMUTABLE_SOURCE_LEAF_PARTITIONS.get(value)?.dialect ?? null;
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
 * When allowBackslashEscape is true (E'...' and Hive/MySQL strings), a backslash
 * skips the next code unit so `\'` does not close the string.
 * U& forms must pass false: backslash is a Unicode escape introducer, not a quote escape.
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

    if (state.profile.dashDashComments === "mysql") {
        const followerIndex = state.cursor + 2;
        const atEof = followerIndex >= state.length;
        const follower = atEof ? "" : charAt(state, followerIndex);
        if (!isMysqlDashDashFollower(follower, atEof)) {
            return false;
        }
    }

    let end = state.cursor + 2;
    while (end < state.length && !isNewlineChar(charAt(state, end))) {
        end += 1;
    }
    emitLeaf(state, "line-comment", state.cursor, end);
    return true;
}

function scanHashComment(state: ScannerState): boolean {
    if (!state.profile.hashComments || charAt(state, state.cursor) !== "#") {
        return false;
    }
    let end = state.cursor + 1;
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

    if (state.profile.nestedBlockComments) {
        let depth = 1;
        while (end < state.length) {
            if (startsWith(state, "/*", end)) {
                depth += 1;
                end += 2;
                continue;
            }
            if (startsWith(state, "*/", end)) {
                depth -= 1;
                end += 2;
                if (depth === 0) {
                    terminated = true;
                    break;
                }
                continue;
            }
            end += codePointWidth(codePointAt(state.source, end) ?? 0);
        }
    } else {
        while (end < state.length) {
            if (startsWith(state, "*/", end)) {
                end += 2;
                terminated = true;
                break;
            }
            end += codePointWidth(codePointAt(state.source, end) ?? 0);
        }
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

function scanDollarString(state: ScannerState): boolean {
    if (!state.profile.dollarStrings || charAt(state, state.cursor) !== "$") {
        return false;
    }

    const start = state.cursor;
    let tagEnd = start + 1;
    if (charAt(state, tagEnd) === "$") {
        tagEnd += 1;
    } else {
        if (!isDollarTagStart(charAt(state, tagEnd))) {
            return false;
        }
        tagEnd += 1;
        while (tagEnd < state.length && isDollarTagContinue(charAt(state, tagEnd))) {
            tagEnd += 1;
        }
        if (charAt(state, tagEnd) !== "$") {
            return false;
        }
        tagEnd += 1;
    }

    const tag = state.source.slice(start, tagEnd);
    let end = tagEnd;
    let terminated = false;
    while (end < state.length) {
        if (startsWith(state, tag, end)) {
            end += tag.length;
            terminated = true;
            break;
        }
        end += codePointWidth(codePointAt(state.source, end) ?? 0);
    }

    if (!terminated) {
        end = state.length;
        emitDiagnostic(
            state,
            "LEX_UNTERMINATED_DOLLAR_STRING",
            "Unterminated dollar-quoted string.",
            start,
            end
        );
    }

    emitLeaf(state, "string", start, end);
    return true;
}

function scanTemplateParameter(state: ScannerState): boolean {
    if (!state.profile.templateParameters || !startsWith(state, "${")) {
        return false;
    }
    const start = state.cursor;
    let end = start + 2;
    let terminated = false;
    while (end < state.length) {
        if (charAt(state, end) === "}") {
            end += 1;
            terminated = true;
            break;
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

/**
 * Prefixed string / Unicode quoted-identifier forms.
 * Single-quoted forms only for E/U&/N/X/B/_charset string literals.
 * PostgreSQL also accepts U&"..." as a quoted identifier (not a string).
 *
 * U& forms deliberately disable C-style backslash quote escaping: in PostgreSQL
 * U& strings, `\` introduces Unicode escapes and does not skip a closing quote.
 * Only E'...' uses allowBackslashEscape=true among prefixed forms.
 */
function scanPrefixedLiteral(state: ScannerState): boolean {
    const start = state.cursor;
    const first = charAt(state, start);
    const second = charAt(state, start + 1);
    const third = charAt(state, start + 2);
    const forms = state.profile.prefixedLiterals;

    if (forms.has("E") && (first === "E" || first === "e") && second === "'") {
        emitQuotedUnit(state, start, start + 1, "'", "string", true);
        return true;
    }

    if (forms.has("U&") && (first === "U" || first === "u") && second === "&") {
        if (third === "'") {
            // No C-style quote escape: closing quote always ends the leaf.
            emitQuotedUnit(state, start, start + 2, "'", "string", false);
            return true;
        }
        // PostgreSQL Unicode quoted identifier: U&"..."
        if (third === '"' && state.profile.doubleQuote === "identifier") {
            emitQuotedUnit(state, start, start + 2, '"', "quoted-identifier", false);
            return true;
        }
    }

    // N/X/B string prefixes accept single quote only — never double quote.
    if (forms.has("N") && (first === "N" || first === "n") && second === "'") {
        emitQuotedUnit(
            state,
            start,
            start + 1,
            "'",
            "string",
            state.profile.backslashStringEscapes
        );
        return true;
    }

    if (forms.has("X") && (first === "X" || first === "x") && second === "'") {
        emitQuotedUnit(state, start, start + 1, "'", "string", false);
        return true;
    }

    if (forms.has("B") && (first === "B" || first === "b") && second === "'") {
        emitQuotedUnit(state, start, start + 1, "'", "string", false);
        return true;
    }

    // _charset'...' — single quote only per Wave 1 design.
    if (forms.has("_charset") && first === "_") {
        let prefixEnd = start + 1;
        while (prefixEnd < state.length && isIdentifierContinue(charAt(state, prefixEnd))) {
            prefixEnd += 1;
        }
        if (prefixEnd > start + 1 && charAt(state, prefixEnd) === "'") {
            emitQuotedUnit(
                state,
                start,
                prefixEnd,
                "'",
                "string",
                state.profile.backslashStringEscapes
            );
            return true;
        }
    }

    return false;
}

function scanQuoted(state: ScannerState): boolean {
    const ch = charAt(state, state.cursor);
    if (ch === "'") {
        emitQuotedUnit(
            state,
            state.cursor,
            state.cursor,
            "'",
            "string",
            state.profile.backslashStringEscapes
        );
        return true;
    }
    if (ch === '"') {
        if (state.profile.doubleQuote === "identifier") {
            emitQuotedUnit(state, state.cursor, state.cursor, '"', "quoted-identifier", false);
            return true;
        }
        emitQuotedUnit(
            state,
            state.cursor,
            state.cursor,
            '"',
            "string",
            state.profile.backslashStringEscapes
        );
        return true;
    }
    if (ch === "`" && state.profile.backtickIdentifiers) {
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
    const ch = charAt(state, start);
    if (!isIdentifierStart(ch)) {
        return false;
    }
    let end = start + 1;
    while (end < state.length && isIdentifierContinue(charAt(state, end))) {
        end += 1;
    }
    const raw = state.source.slice(start, end);
    const kind = state.profile.keywords.has(raw.toUpperCase()) ? "keyword" : "identifier";
    emitLeaf(state, kind, start, end);
    return true;
}

function scanOperator(state: ScannerState): boolean {
    for (const op of state.profile.operators) {
        if (startsWith(state, op)) {
            emitLeaf(state, "operator", state.cursor, state.cursor + op.length);
            return true;
        }
    }
    return false;
}

function hasColonParameterLeftBoundary(state: ScannerState): boolean {
    const previous = state.leaves[state.leaves.length - 1];
    if (previous === undefined || previous.span.end !== state.cursor) {
        return true;
    }
    return (
        previous.kind !== "identifier" &&
        previous.kind !== "keyword" &&
        previous.kind !== "quoted-identifier"
    );
}

function scanNamedParameter(state: ScannerState): boolean {
    const ch = charAt(state, state.cursor);

    if (state.profile.parameters.has("$n") && ch === "$") {
        const next = charAt(state, state.cursor + 1);
        if (isAsciiDigit(next)) {
            let end = state.cursor + 2;
            while (end < state.length && isAsciiDigit(charAt(state, end))) {
                end += 1;
            }
            emitLeaf(state, "parameter", state.cursor, end);
            return true;
        }
    }

    if (
        state.profile.parameters.has(":id") &&
        ch === ":" &&
        hasColonParameterLeftBoundary(state)
    ) {
        const next = charAt(state, state.cursor + 1);
        if (isIdentifierStart(next)) {
            let end = state.cursor + 2;
            while (end < state.length && isIdentifierContinue(charAt(state, end))) {
                end += 1;
            }
            emitLeaf(state, "parameter", state.cursor, end);
            return true;
        }
    }

    if (state.profile.parameters.has("@name") && ch === "@") {
        const next = charAt(state, state.cursor + 1);
        if (isIdentifierStart(next)) {
            let end = state.cursor + 2;
            while (end < state.length && isIdentifierContinue(charAt(state, end))) {
                end += 1;
            }
            emitLeaf(state, "parameter", state.cursor, end);
            return true;
        }
    }

    if (state.profile.parameters.has("?") && ch === "?") {
        emitLeaf(state, "parameter", state.cursor, state.cursor + 1);
        return true;
    }

    return false;
}

function scanPunctuation(state: ScannerState): boolean {
    const ch = charAt(state, state.cursor);
    if (!PUNCTUATION.has(ch)) {
        return false;
    }
    emitLeaf(state, "punctuation", state.cursor, state.cursor + 1);
    return true;
}

function scanUnknown(state: ScannerState): void {
    const cp = codePointAt(state.source, state.cursor);
    const width = codePointWidth(cp ?? 0);
    emitLeaf(state, "unknown", state.cursor, state.cursor + Math.max(width, 1));
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
    if (scanHashComment(state)) {
        return;
    }
    if (scanBlockComment(state)) {
        return;
    }
    if (scanTemplateParameter(state)) {
        return;
    }
    if (scanDollarString(state)) {
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
    // operators before parameters so ::/:=/@>/?|/? win over :id/@name/? parameter
    if (scanOperator(state)) {
        return;
    }
    if (scanNamedParameter(state)) {
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

export function lexSql(source: string, options?: LexOptions): LexOutput {
    // Dialect must be validated before the empty-source fast path so that
    // empty and non-empty inputs reject illegal dialects consistently.
    const dialect = resolveDialect(options?.dialect);

    if (source.length === 0) {
        return {
            leaves: freezeSourceLeafPartition([], source, dialect),
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
        profile: getLexicalProfile(dialect),
    };

    while (state.cursor < state.length) {
        advanceOneLeaf(state);
    }

    return {
        leaves: freezeSourceLeafPartition(state.leaves, source, dialect),
        diagnostics: state.diagnostics,
    };
}
