export type RenderNewline = "\n" | "\r\n" | "\r";
export type RenderTabSize = number;

export const DEFAULT_RENDER_TAB_SIZE: RenderTabSize = 4;
export const MAX_RENDER_TAB_SIZE: RenderTabSize = 256;

export interface RenderEnvironment {
    readonly newline: RenderNewline;
    readonly tabSize: RenderTabSize;
}

const CANONICAL_ENVIRONMENTS = new WeakSet<object>();
const ENVIRONMENTS = new Map<string, RenderEnvironment>();

export function isRenderNewline(value: unknown): value is RenderNewline {
    return value === "\n" || value === "\r\n" || value === "\r";
}

export function isRenderTabSize(value: unknown): value is RenderTabSize {
    return Number.isSafeInteger(value) &&
        (value as number) >= 1 &&
        (value as number) <= MAX_RENDER_TAB_SIZE;
}

export function renderEnvironmentForNewline(
    newline: RenderNewline,
    tabSize: RenderTabSize = DEFAULT_RENDER_TAB_SIZE
): RenderEnvironment {
    if (!isRenderNewline(newline) || !isRenderTabSize(tabSize)) {
        throw new TypeError("Render environment values are invalid");
    }
    const key = `${newline}\0${tabSize}`;
    const existing = ENVIRONMENTS.get(key);
    if (existing !== undefined) {
        return existing;
    }
    const environment = Object.freeze({ newline, tabSize });
    ENVIRONMENTS.set(key, environment);
    CANONICAL_ENVIRONMENTS.add(environment);
    return environment;
}

export function isCanonicalRenderEnvironment(
    value: unknown
): value is RenderEnvironment {
    return typeof value === "object" &&
        value !== null &&
        CANONICAL_ENVIRONMENTS.has(value);
}

export function inferRenderNewline(
    source: string,
    fallback: RenderNewline = "\n"
): RenderNewline {
    for (let index = 0; index < source.length; index++) {
        const code = source.charCodeAt(index);
        if (code === 0x0D) {
            return source.charCodeAt(index + 1) === 0x0A ? "\r\n" : "\r";
        }
        if (code === 0x0A) {
            return "\n";
        }
    }
    return fallback;
}

export function inferRenderEnvironment(
    source: string,
    fallback: RenderNewline = "\n",
    tabSize: RenderTabSize = DEFAULT_RENDER_TAB_SIZE
): RenderEnvironment {
    return renderEnvironmentForNewline(
        inferRenderNewline(source, fallback),
        tabSize
    );
}
