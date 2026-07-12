/**
 * Character-class predicates for the lossless lexer.
 * This module must not contain dialect keyword/operator tables.
 */

export function isAsciiDigit(ch: string): boolean {
    if (ch.length === 0) {
        return false;
    }
    const code = ch.charCodeAt(0);
    return code >= 0x30 && code <= 0x39;
}

export function isHexDigit(ch: string): boolean {
    if (ch.length === 0) {
        return false;
    }
    const code = ch.charCodeAt(0);
    return (
        (code >= 0x30 && code <= 0x39) ||
        (code >= 0x41 && code <= 0x46) ||
        (code >= 0x61 && code <= 0x66)
    );
}

export function isBinaryDigit(ch: string): boolean {
    return ch === "0" || ch === "1";
}

export function isAsciiLetter(ch: string): boolean {
    if (ch.length === 0) {
        return false;
    }
    const code = ch.charCodeAt(0);
    return (
        (code >= 0x41 && code <= 0x5a) ||
        (code >= 0x61 && code <= 0x7a)
    );
}

export function isIdentifierStart(ch: string): boolean {
    return isAsciiLetter(ch) || ch === "_";
}

export function isIdentifierContinue(ch: string): boolean {
    return isIdentifierStart(ch) || isAsciiDigit(ch) || ch === "$";
}

export function isHorizontalWhitespace(ch: string): boolean {
    return (
        ch === " " ||
        ch === "\t" ||
        ch === "\f" ||
        ch === "\v" ||
        ch === "\u00a0" ||
        ch === "\u1680" ||
        ch === "\u2000" ||
        ch === "\u2001" ||
        ch === "\u2002" ||
        ch === "\u2003" ||
        ch === "\u2004" ||
        ch === "\u2005" ||
        ch === "\u2006" ||
        ch === "\u2007" ||
        ch === "\u2008" ||
        ch === "\u2009" ||
        ch === "\u200a" ||
        ch === "\u202f" ||
        ch === "\u205f" ||
        ch === "\u3000"
    );
}

export function isNewlineChar(ch: string): boolean {
    return ch === "\n" || ch === "\r";
}

export function isQuoteChar(ch: string): boolean {
    return ch === "'" || ch === '"' || ch === "`";
}

export function isOperatorCandidateStart(ch: string): boolean {
    return (
        ch === "!" ||
        ch === "#" ||
        ch === "%" ||
        ch === "&" ||
        ch === "*" ||
        ch === "+" ||
        ch === "-" ||
        ch === "/" ||
        ch === ":" ||
        ch === "<" ||
        ch === "=" ||
        ch === ">" ||
        ch === "?" ||
        ch === "@" ||
        ch === "^" ||
        ch === "|" ||
        ch === "~"
    );
}

/** UTF-16 code-unit width of a Unicode code point. */
export function codePointWidth(codePoint: number): number {
    return codePoint > 0xffff ? 2 : 1;
}

/** Read the code point at a UTF-16 offset. */
export function codePointAt(source: string, index: number): number | undefined {
    return source.codePointAt(index);
}
