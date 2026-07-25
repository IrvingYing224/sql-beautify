export type RenderNewline = "\n" | "\r\n" | "\r";

export interface RenderEnvironment {
    readonly newline: RenderNewline;
}

const LF_ENVIRONMENT: RenderEnvironment = Object.freeze({ newline: "\n" });
const CRLF_ENVIRONMENT: RenderEnvironment = Object.freeze({ newline: "\r\n" });
const CR_ENVIRONMENT: RenderEnvironment = Object.freeze({ newline: "\r" });
const CANONICAL_ENVIRONMENTS = new WeakSet<object>([
    LF_ENVIRONMENT,
    CRLF_ENVIRONMENT,
    CR_ENVIRONMENT,
]);

export function isRenderNewline(value: unknown): value is RenderNewline {
    return value === "\n" || value === "\r\n" || value === "\r";
}

export function renderEnvironmentForNewline(
    newline: RenderNewline
): RenderEnvironment {
    if (newline === "\r\n") {
        return CRLF_ENVIRONMENT;
    }
    if (newline === "\r") {
        return CR_ENVIRONMENT;
    }
    return LF_ENVIRONMENT;
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
    fallback: RenderNewline = "\n"
): RenderEnvironment {
    return renderEnvironmentForNewline(inferRenderNewline(source, fallback));
}
