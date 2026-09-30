import type { CanonicalFormatOptions } from "./options";

interface EnumDefinition<T extends string> {
    readonly type: "string";
    readonly enum: readonly T[];
    readonly default: T;
}

interface IntegerDefinition {
    readonly type: "integer";
    readonly minimum: number;
    readonly maximum: number;
    readonly default: number;
}

type OptionDefinitions = {
    readonly [K in keyof CanonicalFormatOptions]: CanonicalFormatOptions[K] extends string
        ? EnumDefinition<CanonicalFormatOptions[K]>
        : IntegerDefinition;
};

function enumeration<T extends string>(values: readonly T[], fallback: T): EnumDefinition<T> {
    return Object.freeze({ type: "string", enum: Object.freeze(values), default: fallback });
}

function integer(minimum: number, maximum: number, fallback: number): IntegerDefinition {
    return Object.freeze({ type: "integer", minimum, maximum, default: fallback });
}

/** Shared runtime constraints; manifest compatibility is checked against these. */
export const FORMAT_OPTION_DEFINITIONS: OptionDefinitions = Object.freeze({
    dialect: enumeration(["generic", "hive", "postgresql", "mysql"], "hive"),
    keywordCase: enumeration(["upper", "lower"], "upper"),
    commaStyle: enumeration(["leading", "trailing"], "leading"),
    indentStyle: enumeration(["tab", "space"], "space"),
    maxAlignWidth: integer(1, 500, 150),
    caseWhenThenWrapLength: integer(1, 300, 50),
    caseLayout: enumeration(["expanded", "compactShort"], "expanded"),
    unsupportedSyntaxPolicy: enumeration(["preserve", "warn", "bail_out"], "warn"),
});

export type FormatOptionKey = keyof CanonicalFormatOptions;

export const FORMAT_OPTION_KEYS: readonly FormatOptionKey[] = Object.freeze(
    Object.keys(FORMAT_OPTION_DEFINITIONS) as FormatOptionKey[]
);

export const DEFAULT_FORMAT_OPTIONS: CanonicalFormatOptions = Object.freeze(
    Object.fromEntries(FORMAT_OPTION_KEYS.map((key) => [
        key, FORMAT_OPTION_DEFINITIONS[key].default,
    ])) as unknown as CanonicalFormatOptions
);

export function isFormatOptionValue<K extends FormatOptionKey>(
    key: K,
    value: unknown
): value is CanonicalFormatOptions[K] {
    const definition = FORMAT_OPTION_DEFINITIONS[key];
    return definition.type === "integer"
        ? typeof value === "number" && Number.isSafeInteger(value) &&
            value >= definition.minimum && value <= definition.maximum
        : typeof value === "string" && (definition.enum as readonly string[]).includes(value);
}
