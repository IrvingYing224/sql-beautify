/** Encode generated text for Hive's backslash-based SQL string decoder. */
export function hiveStringLiteral(value: string): string {
    const escaped = value.replace(/[\\'\u0000-\u001f]/g, (character) => {
        switch (character) {
            case "\\": return "\\\\";
            case "'": return "\\'";
            // A short \0 followed by two octal digits would become one byte.
            case "\0": return "\\u0000";
            case "\b": return "\\b";
            case "\n": return "\\n";
            case "\r": return "\\r";
            case "\t": return "\\t";
            case "\u001a": return "\\Z";
            default:
                return `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
        }
    });
    return `'${escaped}'`;
}
