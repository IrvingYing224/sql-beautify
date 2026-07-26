export interface SupportedLanguage {
    readonly languageId: "sql" | "hive-sql";
    readonly supportsQueryFormatting: true;
    readonly supportsExperimentalDdl: boolean;
}

export const SUPPORTED_LANGUAGES: readonly SupportedLanguage[] = Object.freeze([
    Object.freeze({
        languageId: "sql",
        supportsQueryFormatting: true,
        supportsExperimentalDdl: true,
    }),
    Object.freeze({
        languageId: "hive-sql",
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

export function formatterSelector(): readonly string[] {
    return Object.freeze(SUPPORTED_LANGUAGES.map((value) => value.languageId));
}

export function commandLanguageIds(
    experimentalDdl: boolean = false
): readonly string[] {
    return Object.freeze(SUPPORTED_LANGUAGES
        .filter((value) =>
            experimentalDdl
                ? value.supportsExperimentalDdl
                : value.supportsQueryFormatting
        )
        .map((value) => value.languageId));
}
