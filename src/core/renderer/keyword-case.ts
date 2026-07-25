import type { KeywordCase } from "../config/options";

/** Length-preserving ASCII keyword transform shared by render and equivalence. */
export function applyKeywordCase(
    raw: string,
    mode: KeywordCase
): string | null {
    let output = "";
    let chunkStart = 0;
    for (let index = 0; index < raw.length; index++) {
        const code = raw.charCodeAt(index);
        if (code > 0x7F) {
            return null;
        }
        let replacement = code;
        if (mode === "upper" && code >= 0x61 && code <= 0x7A) {
            replacement = code - 0x20;
        } else if (mode === "lower" && code >= 0x41 && code <= 0x5A) {
            replacement = code + 0x20;
        }
        if (replacement !== code) {
            output += raw.slice(chunkStart, index) +
                String.fromCharCode(replacement);
            chunkStart = index + 1;
        }
    }
    return output.length === 0 ? raw : output + raw.slice(chunkStart);
}
