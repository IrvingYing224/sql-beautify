export interface SupportedLanguage {
    readonly languageId: "sql" | "hive-sql";
    readonly dialect: "hive";
    readonly supportsQueryFormatting: true;
    readonly supportsExperimentalDdl: boolean;
}

export const SUPPORTED_LANGUAGES: readonly SupportedLanguage[] = Object.freeze([
    Object.freeze({
        languageId: "sql",
        dialect: "hive",
        supportsQueryFormatting: true,
        supportsExperimentalDdl: true,
    }),
    Object.freeze({
        languageId: "hive-sql",
        dialect: "hive",
        supportsQueryFormatting: true,
        supportsExperimentalDdl: true,
    }),
]);

export function supportedLanguage(
    languageId: unknown
): SupportedLanguage | null {
    if (typeof languageId !== "string") {
        return null;
    }
    for (const value of SUPPORTED_LANGUAGES) {
        if (value.languageId === languageId) {
            return value;
        }
    }
    return null;
}
