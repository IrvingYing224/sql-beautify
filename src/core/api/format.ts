import type {
    FormatResult,
    OriginalTextFormatResult,
    SafeFormatResult,
} from "./format-result";
import { MAX_FORMAT_SOURCE_CODE_UNITS } from "./limits";
import { analyzeSql } from "../analysis/analyze";
import type { AnalyzedArtifact } from "../analysis/types";
import type { FormatOptions } from "../config/options";
import type { Diagnostic } from "../diagnostics/diagnostic";
import {
    createDebugEvent,
    type DebugEvent,
} from "../diagnostics/debug-event";
import { resolveFormatOptions } from "../config/resolve-options";
import { lexSql } from "../lexer/lossless-lexer";
import { isTemplateFragment, type SourceLeaf, type TokenKind } from "../lexer/token";
import { compileLayoutPlan } from "../layout/compiler";
import type { LayoutArtifact } from "../layout/artifact";
import {
    applyLayoutAlignment,
    deriveLayoutAlignmentPlan,
} from "../layout/alignment-policy";
import type { LayoutPlan } from "../layout/plan";
import { buildLayoutPlan } from "../layout/policy";
import { applyKeywordCase } from "../renderer/keyword-case";
import {
    DEFAULT_RENDER_TAB_SIZE,
    inferRenderEnvironment,
    isRenderEnvironment,
    isRenderNewline,
    renderEnvironmentForNewline,
    type RenderEnvironment,
    type RenderNewline,
    type RenderTabSize,
} from "../renderer/environment";
import { renderLayoutArtifact } from "../renderer/render";
import type { RenderSuccess } from "../renderer/types";
import { isKeywordCaseRole } from "../syntax/contextual-fact-contract";
import type { ParseMode } from "../syntax/parser-backend";

export interface FormatSqlExecution {
    readonly result: FormatResult;
    readonly debugEvents: readonly DebugEvent[];
}

/** A non-whitespace source leaf, its rendered counterpart, and whether whitespace precedes each. */
export interface LeafPair {
    readonly source: SourceLeaf;
    readonly output: SourceLeaf;
    readonly sourceGap: boolean;
    readonly outputGap: boolean;
}

const WORD_KINDS: ReadonlySet<TokenKind> = new Set([
    "keyword",
    "identifier",
    "number",
    "parameter",
]);

function spanForSource(source: string) {
    return Object.freeze({ start: 0, end: source.length });
}

function diagnostic(
    source: string,
    code: string,
    message: string,
    severity: Diagnostic["severity"] = "error",
    recovery: Diagnostic["recovery"] = "preserve-target"
): Diagnostic {
    return Object.freeze({
        code,
        severity,
        message,
        capabilityId: null,
        span: spanForSource(source),
        recovery,
    });
}

function frozenDiagnostics(
    diagnostics: readonly Diagnostic[],
    extra?: Diagnostic
): readonly Diagnostic[] {
    return Object.freeze(
        extra === undefined ? Array.from(diagnostics) : [...diagnostics, extra]
    );
}

function originalResult(
    status: OriginalTextFormatResult["status"],
    source: string,
    diagnostics: readonly Diagnostic[]
): OriginalTextFormatResult {
    const values = frozenDiagnostics(diagnostics);
    return status === "preserved"
        ? Object.freeze({ status: "preserved", text: source, diagnostics: values })
        : Object.freeze({ status: "failed", text: source, diagnostics: values });
}

function safeResult(
    source: string,
    text: string,
    diagnostics: readonly Diagnostic[],
    sourceMap: SafeFormatResult["sourceMap"]
): SafeFormatResult {
    const values = frozenDiagnostics(diagnostics);
    return text === source
        ? Object.freeze({
              status: "unchanged",
              text,
              diagnostics: values,
              sourceMap,
          })
        : Object.freeze({
              status: "formatted",
              text,
              diagnostics: values,
              sourceMap,
          });
}

function isLayoutResourceFailure(code: string): boolean {
    return (
        code === "LAYOUT_PLAN_RESOURCE" ||
        code === "LAYOUT_COMPILE_RESOURCE" ||
        code === "RENDER_RESOURCE_BUDGET"
    );
}

interface StageFailure {
    readonly code: string;
    readonly message: string;
}

/** A rejected stage keeps its own code: a resource limit preserves the text, anything else fails. */
function stageFailure(
    source: string,
    diagnostics: readonly Diagnostic[],
    failure: StageFailure
): OriginalTextFormatResult {
    const resource = isLayoutResourceFailure(failure.code);
    const value = diagnostic(
        source,
        failure.code,
        failure.message,
        resource ? "warning" : "error"
    );
    return originalResult(
        resource ? "preserved" : "failed",
        source,
        frozenDiagnostics(diagnostics, value)
    );
}

type RenderedPlan =
    | { readonly ok: true; readonly artifact: LayoutArtifact; readonly rendered: RenderSuccess }
    | ({ readonly ok: false } & StageFailure);

function compileAndRender(plan: LayoutPlan, environment: RenderEnvironment): RenderedPlan {
    const compiled = compileLayoutPlan(plan);
    if (!compiled.ok) {
        return compiled;
    }
    const rendered = renderLayoutArtifact(compiled.artifact, environment);
    return rendered.ok
        ? { ok: true, artifact: compiled.artifact, rendered }
        : rendered;
}

/**
 * Safety floor 2 (plan §4) glue rules on token-equivalent pairs: adjacent word-like leaves keep
 * whether whitespace separates them, and a template fragment loses none of the whitespace around
 * it. The lexer makes each fragment one protected leaf, so token equivalence already keeps its
 * inside free of new whitespace and case changes.
 */
export function glueKept(pairs: readonly LeafPair[]): boolean {
    for (let index = 0; index < pairs.length; index += 1) {
        const pair = pairs[index]!;
        const previous = pairs[index - 1];
        if (
            previous !== undefined &&
            pair.sourceGap !== pair.outputGap &&
            ((WORD_KINDS.has(previous.source.kind) && WORD_KINDS.has(pair.source.kind)) ||
                (pair.sourceGap &&
                    (isTemplateFragment(previous.source) || isTemplateFragment(pair.source))))
        ) {
            return false;
        }
    }
    return true;
}

/**
 * Compares the re-lexed output with the source leaf by leaf: "token" when a token changed, "glue"
 * when only floor-2 glue broke, null when both hold. Exported for the golden runner's self-test.
 */
export function tokenEquivalent(
    analysis: AnalyzedArtifact,
    output: string,
    keywordCase: "upper" | "lower",
    plan: LayoutPlan
): "token" | "glue" | null {
    const lexed = lexSql(output, { dialect: analysis.dialect });
    if (lexed.diagnostics.some((value) => value.severity === "error")) {
        return "token";
    }
    const pairs: LeafPair[] = [];
    let sourceIndex = 0;
    let outputIndex = 0;
    let glued = false;
    // Removing whitespace beside a template fragment lets the fragment absorb its neighbours when
    // the output is lexed again: a glue violation (plan §4 floor 2), not a changed token. The check
    // then skips the absorbed source leaves and goes on, so a later changed token is still reported.
    const absorb = (outputLeaf: SourceLeaf): boolean => {
        if (!isTemplateFragment(outputLeaf)) {
            return false;
        }
        let text = "";
        let index = sourceIndex - 1;
        for (
            ;
            index < analysis.leaves.length && text.length < outputLeaf.raw.length;
            index += 1
        ) {
            const leaf = analysis.leaves[index]!;
            if (leaf.kind !== "whitespace" && leaf.kind !== "newline") {
                text += plan.leafEmissions[leaf.id] === "keyword-case"
                    ? applyKeywordCase(leaf.raw, keywordCase) ?? leaf.raw
                    : leaf.raw;
            }
        }
        if (text !== outputLeaf.raw) {
            return false;
        }
        glued = true;
        sourceIndex = index;
        return true;
    };
    while (true) {
        let sourceLeaf: SourceLeaf | null = null;
        let sourceGap = pairs.length === 0;
        while (sourceIndex < analysis.leaves.length) {
            const candidate = analysis.leaves[sourceIndex++]!;
            if (candidate.kind !== "whitespace" && candidate.kind !== "newline") {
                sourceLeaf = candidate;
                break;
            }
            sourceGap = true;
        }
        let outputLeaf: SourceLeaf | null = null;
        let outputGap = pairs.length === 0;
        while (outputIndex < lexed.leaves.length) {
            const candidate = lexed.leaves[outputIndex++]!;
            if (candidate.kind !== "whitespace" && candidate.kind !== "newline") {
                outputLeaf = candidate;
                break;
            }
            outputGap = true;
        }
        if (sourceLeaf === null || outputLeaf === null) {
            if (sourceLeaf !== null || outputLeaf !== null) {
                return "token";
            }
            return glued || !glueKept(pairs) ? "glue" : null;
        }
        if (
            sourceLeaf.kind !== outputLeaf.kind ||
            sourceLeaf.channel !== outputLeaf.channel
        ) {
            if (!absorb(outputLeaf)) {
                return "token";
            }
            continue;
        }
        const plannedTransform =
            plan.leafEmissions[sourceLeaf.id] === "keyword-case";
        if (plannedTransform) {
            const syntax = analysis.index.leafContext(sourceLeaf.id).syntax;
            if (
                sourceLeaf.channel !== "code" ||
                syntax === null ||
                syntax.keywordCaseEligible !== true ||
                !isKeywordCaseRole(syntax.syntaxRole)
            ) {
                return "token";
            }
        }
        const expected = plannedTransform
            ? applyKeywordCase(sourceLeaf.raw, keywordCase)
            : sourceLeaf.raw;
        if (expected === null || outputLeaf.raw !== expected) {
            if (!absorb(outputLeaf)) {
                return "token";
            }
            continue;
        }
        pairs.push({ source: sourceLeaf, output: outputLeaf, sourceGap, outputGap });
    }
}

function validMode(value: unknown): value is ParseMode {
    return value === "document" || value === "statement" || value === "fragment";
}

export function formatSql(
    sourceValue: string,
    optionsValue: FormatOptions | unknown = undefined,
    modeValue: ParseMode | unknown = "document",
    environmentValue: RenderEnvironment | RenderNewline | unknown = undefined,
    debugEvents: DebugEvent[] | undefined = undefined
): FormatResult {
    const source = typeof sourceValue === "string" ? sourceValue : "";
    try {
        if (typeof sourceValue !== "string") {
            const value = diagnostic(
                source,
                "FMT_SOURCE_TYPE",
                "Formatter source must be a primitive string"
            );
            return originalResult("failed", source, [value]);
        }
        if (!validMode(modeValue)) {
            const value = diagnostic(
                source,
                "FMT_PARSE_MODE",
                "Formatter parse mode is invalid"
            );
            return originalResult("failed", source, [value]);
        }
        const environment = environmentValue === undefined
            ? inferRenderEnvironment(source)
            : isRenderNewline(environmentValue)
                ? renderEnvironmentForNewline(environmentValue)
                : environmentValue;
        if (!isRenderEnvironment(environment)) {
            const value = diagnostic(
                source,
                "RENDER_NEWLINE_CONTRACT",
                "Formatter render environment is invalid"
            );
            return originalResult("failed", source, [value]);
        }
        const resolved = resolveFormatOptions(optionsValue);
        if (!resolved.ok) {
            const value = diagnostic(source, resolved.code, resolved.message);
            return originalResult("failed", source, [value]);
        }
        if (source.length > MAX_FORMAT_SOURCE_CODE_UNITS) {
            const value = diagnostic(
                source,
                "FMT_INPUT_LIMIT",
                "Formatter source exceeds the supported input limit",
                "warning"
            );
            return originalResult("preserved", source, [value]);
        }
        const options = resolved.options;
        const analysis = analyzeSql(source, {
            dialect: options.dialect,
            mode: modeValue,
        });
        if (analysis.status === "failed") {
            return originalResult("failed", source, analysis.diagnostics);
        }
        if (analysis.status === "preserved") {
            return originalResult("preserved", source, analysis.diagnostics);
        }
        if (
            options.unsupportedSyntaxPolicy === "bail_out" &&
            // Opaque syntax is the parser's proof that a range was recovered
            // rather than modeled. Capability IDs describe known features and
            // are absent for unknown syntax, malformed input and depth limits.
            analysis.index.nodes().some((node) => node.kind === "opaque")
        ) {
            const bail = diagnostic(
                source,
                "FMT_UNSUPPORTED_BAIL_OUT",
                "Unsupported syntax policy preserved the complete target",
                "warning"
            );
            return originalResult(
                    "preserved",
                    source,
                    frozenDiagnostics(analysis.diagnostics, bail)
                );
        }

        const planned = buildLayoutPlan(analysis, options);
        if (!planned.ok) {
            return stageFailure(source, analysis.diagnostics, planned);
        }
        let plan = planned.plan;
        let output = compileAndRender(plan, environment);
        if (!output.ok) {
            return stageFailure(source, analysis.diagnostics, output);
        }
        const alignment = deriveLayoutAlignmentPlan(
            output.artifact,
            output.rendered,
            environment.tabSize
        );
        if (alignment === null) {
            return stageFailure(source, analysis.diagnostics, {
                code: "LAYOUT_ALIGNMENT_FACTS",
                message: "Layout alignment measurement failed",
            });
        }
        if (alignment.targets.length > 0) {
            plan = applyLayoutAlignment(plan, alignment);
            output = compileAndRender(plan, environment);
            if (!output.ok) {
                return stageFailure(source, analysis.diagnostics, output);
            }
        }
        const rendered = output.rendered;
        const failure = tokenEquivalent(
            analysis,
            rendered.text,
            options.keywordCase,
            plan
        );
        if (failure === "token") {
            const value = diagnostic(
                source,
                "FMT_TOKEN_EQUIVALENCE",
                "Rendered output failed token-equivalence validation"
            );
            return originalResult(
                    "failed",
                    source,
                    frozenDiagnostics(analysis.diagnostics, value)
                );
        }
        if (failure === "glue") {
            const value = diagnostic(
                source,
                "FMT_GLUE_PRESERVED",
                "Rendered output would change spacing between glued tokens or inside a template fragment",
                "warning"
            );
            return originalResult(
                    "preserved",
                    source,
                    frozenDiagnostics(analysis.diagnostics, value)
                );
        }
        const resultDiagnostics =
            plan.commaFallback
                ? frozenDiagnostics(
                      analysis.diagnostics,
                      diagnostic(
                          source,
                          "LAYOUT_COMMA_FALLBACK",
                          "Trailing comma style fell back to a leading comma at one or more line-comment boundaries",
                          "info",
                          "none"
                      )
                  )
                : analysis.diagnostics;
        const result = safeResult(
            source,
            rendered.text,
            resultDiagnostics,
            rendered.sourceMap
        );
        return result;
    } catch (error) {
        debugEvents?.push(createDebugEvent("format", "FMT_INTERNAL", error));
        const value = diagnostic(
            source,
            "FMT_INTERNAL",
            "Formatter internal boundary failed"
        );
        return originalResult("failed", source, [value]);
    }
}

/** Internal executor entry; the public formatter continues to return FormatResult. */
export function executeFormatSql(
    source: string,
    options: FormatOptions | unknown = undefined,
    mode: ParseMode | unknown = "document",
    environment: RenderEnvironment | RenderNewline | unknown = undefined,
    debugEnabled = false,
    tabSize: RenderTabSize = DEFAULT_RENDER_TAB_SIZE
): FormatSqlExecution {
    const debugEvents: DebugEvent[] = [];
    const result = formatSql(
        source,
        options,
        mode,
        isRenderNewline(environment)
            ? renderEnvironmentForNewline(environment, tabSize)
            : environment,
        debugEnabled ? debugEvents : undefined
    );
    return Object.freeze({
        result,
        debugEvents: Object.freeze(debugEvents),
    });
}
