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
import type { SourceLeaf } from "../lexer/token";
import { compileLayoutPlan } from "../layout/compiler";
import { deriveLayoutAlignmentPlan } from "../layout/alignment-policy";
import type { LayoutPlan } from "../layout/plan";
import { buildLayoutPlan } from "../layout/policy";
import { applyKeywordCase } from "../renderer/keyword-case";
import {
    DEFAULT_RENDER_TAB_SIZE,
    inferRenderEnvironment,
    isCanonicalRenderEnvironment,
    isRenderNewline,
    renderEnvironmentForNewline,
    type RenderEnvironment,
    type RenderNewline,
    type RenderTabSize,
} from "../renderer/environment";
import { renderLayoutArtifact } from "../renderer/render";
import type { RenderStatistics } from "../renderer/types";
import { isKeywordCaseRole } from "../syntax/contextual-fact-contract";
import type { ParseMode } from "../syntax/parser-backend";

export interface FormatPipelineStatistics {
    readonly sourceCodeUnits: number;
    readonly outputCodeUnits: number;
    readonly leafCount: number;
    readonly syntaxNodeCount: number;
    readonly planActionCount: number;
    readonly maxPlanActions: number;
    readonly leafVisitCount: number;
    readonly leafEmissionCount: number;
    readonly directLookupCount: number;
    readonly docNodeCount: number;
    readonly scopeActionCount: number;
    readonly scopeActionVisitCount: number;
    readonly policyNodeVisitCount: number;
    readonly policyLeafVisitCount: number;
    readonly policyDirectLookupCount: number;
    readonly metricsDocVisitCount: number;
    readonly metricsSummaryLookupCount: number;
    readonly renderDocVisitCount: number;
    readonly renderMetricsLookupCount: number;
    readonly equivalenceInputCodeUnits: number;
    readonly equivalenceDiagnosticVisitCount: number;
    readonly equivalenceSourceLeafVisitCount: number;
    readonly equivalenceOutputLeafVisitCount: number;
    readonly equivalenceComparisonCount: number;
    readonly equivalenceDirectLookupCount: number;
}

export interface FormatPipelineRun {
    readonly result: FormatResult;
    readonly statistics: FormatPipelineStatistics;
}

export interface FormatSqlExecution {
    readonly result: FormatResult;
    readonly debugEvents: readonly DebugEvent[];
}

interface TokenEquivalenceStatistics {
    readonly inputCodeUnits: number;
    readonly diagnosticVisitCount: number;
    readonly sourceLeafVisitCount: number;
    readonly outputLeafVisitCount: number;
    readonly comparisonCount: number;
    readonly directLookupCount: number;
}

interface TokenEquivalenceCheck {
    readonly equivalent: boolean;
    readonly statistics: TokenEquivalenceStatistics;
}

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

type MutableFormatPipelineStatistics = {
    -readonly [Key in keyof FormatPipelineStatistics]: FormatPipelineStatistics[Key];
};

function statisticsAccumulator(
    sourceCodeUnits: number
): MutableFormatPipelineStatistics {
    return {
        sourceCodeUnits,
        outputCodeUnits: sourceCodeUnits,
        leafCount: 0,
        syntaxNodeCount: 0,
        planActionCount: 0,
        maxPlanActions: 0,
        leafVisitCount: 0,
        leafEmissionCount: 0,
        directLookupCount: 0,
        docNodeCount: 0,
        scopeActionCount: 0,
        scopeActionVisitCount: 0,
        policyNodeVisitCount: 0,
        policyLeafVisitCount: 0,
        policyDirectLookupCount: 0,
        metricsDocVisitCount: 0,
        metricsSummaryLookupCount: 0,
        renderDocVisitCount: 0,
        renderMetricsLookupCount: 0,
        equivalenceInputCodeUnits: 0,
        equivalenceDiagnosticVisitCount: 0,
        equivalenceSourceLeafVisitCount: 0,
        equivalenceOutputLeafVisitCount: 0,
        equivalenceComparisonCount: 0,
        equivalenceDirectLookupCount: 0,
    };
}

function freezeStatistics(
    value: MutableFormatPipelineStatistics
): FormatPipelineStatistics {
    return Object.freeze({ ...value });
}

function recordAnalysisStatistics(
    value: MutableFormatPipelineStatistics,
    leafCount: number,
    syntaxNodeCount: number
): void {
    value.leafCount = leafCount;
    value.syntaxNodeCount = syntaxNodeCount;
}

function recordPlanStatistics(
    value: MutableFormatPipelineStatistics,
    plan: LayoutPlan
): void {
    const planStatistics = plan.statistics;
    value.planActionCount += planStatistics.actionCount;
    value.maxPlanActions += plan.budget.maxPlanActions;
    value.leafVisitCount +=
        planStatistics.leafVisitCount + planStatistics.policyLeafVisitCount;
    value.directLookupCount +=
        planStatistics.directLookupCount +
        planStatistics.policyDirectLookupCount;
    value.scopeActionCount += planStatistics.scopeActionCount;
    value.policyNodeVisitCount += planStatistics.policyNodeVisitCount;
    value.policyLeafVisitCount += planStatistics.policyLeafVisitCount;
    value.policyDirectLookupCount += planStatistics.policyDirectLookupCount;
}

function recordCompiledStatistics(
    value: MutableFormatPipelineStatistics,
    compiled: Readonly<{
        leafVisitCount: number;
        leafEmissionCount: number;
        directLookupCount: number;
        scopeActionVisitCount: number;
    }>
): void {
    value.leafVisitCount += compiled.leafVisitCount;
    value.leafEmissionCount += compiled.leafEmissionCount;
    value.directLookupCount += compiled.directLookupCount;
    value.scopeActionVisitCount += compiled.scopeActionVisitCount;
}

function recordRenderedStatistics(
    value: MutableFormatPipelineStatistics,
    rendered: RenderStatistics
): void {
    value.docNodeCount += rendered.docVisitCount;
    value.metricsDocVisitCount += rendered.metricsDocVisitCount;
    value.metricsSummaryLookupCount += rendered.metricsSummaryLookupCount;
    value.renderDocVisitCount += rendered.docVisitCount;
    value.renderMetricsLookupCount += rendered.metricsLookupCount;
    value.directLookupCount +=
        rendered.metricsSummaryLookupCount + rendered.metricsLookupCount;
}

function recordEquivalenceStatistics(
    value: MutableFormatPipelineStatistics,
    equivalence: TokenEquivalenceStatistics
): void {
    value.equivalenceInputCodeUnits = equivalence.inputCodeUnits;
    value.equivalenceDiagnosticVisitCount = equivalence.diagnosticVisitCount;
    value.equivalenceSourceLeafVisitCount = equivalence.sourceLeafVisitCount;
    value.equivalenceOutputLeafVisitCount = equivalence.outputLeafVisitCount;
    value.equivalenceComparisonCount = equivalence.comparisonCount;
    value.equivalenceDirectLookupCount = equivalence.directLookupCount;
}

function recordCompletedStatistics(
    value: MutableFormatPipelineStatistics,
    equivalence: TokenEquivalenceStatistics
): void {
    value.leafVisitCount +=
        equivalence.sourceLeafVisitCount + equivalence.outputLeafVisitCount;
    value.directLookupCount += equivalence.directLookupCount;
    recordEquivalenceStatistics(value, equivalence);
}

function isLayoutResourceFailure(code: string): boolean {
    return (
        code === "LAYOUT_PLAN_RESOURCE" ||
        code === "LAYOUT_COMPILE_RESOURCE" ||
        code === "RENDER_RESOURCE_BUDGET"
    );
}

function resourcePreservedResult(
    source: string,
    diagnostics: readonly Diagnostic[],
    code: string,
    message: string
): OriginalTextFormatResult {
    const value = diagnostic(source, code, message, "warning");
    return originalResult(
        "preserved",
        source,
        frozenDiagnostics(diagnostics, value)
    );
}

function run(
    result: FormatResult,
    value: MutableFormatPipelineStatistics
): FormatPipelineRun {
    return Object.freeze({ result, statistics: freezeStatistics(value) });
}

function tokenEquivalenceCheck(
    equivalent: boolean,
    statistics: {
        inputCodeUnits: number;
        diagnosticVisitCount: number;
        sourceLeafVisitCount: number;
        outputLeafVisitCount: number;
        comparisonCount: number;
        directLookupCount: number;
    }
): TokenEquivalenceCheck {
    return Object.freeze({
        equivalent,
        statistics: Object.freeze({ ...statistics }),
    });
}

function tokenEquivalent(
    analysis: AnalyzedArtifact,
    output: string,
    keywordCase: "upper" | "lower",
    plan: LayoutPlan
): TokenEquivalenceCheck {
    const statistics = {
        inputCodeUnits: output.length,
        diagnosticVisitCount: 0,
        sourceLeafVisitCount: 0,
        outputLeafVisitCount: 0,
        comparisonCount: 0,
        directLookupCount: 0,
    };
    const lexed = lexSql(output, { dialect: analysis.dialect });
    for (const value of lexed.diagnostics) {
        statistics.diagnosticVisitCount += 1;
        if (value.severity === "error") {
            return tokenEquivalenceCheck(false, statistics);
        }
    }
    let sourceIndex = 0;
    let outputIndex = 0;
    while (true) {
        let sourceLeaf: SourceLeaf | null = null;
        while (sourceIndex < analysis.leaves.length) {
            const candidate = analysis.leaves[sourceIndex++]!;
            statistics.sourceLeafVisitCount += 1;
            if (candidate.kind !== "whitespace" && candidate.kind !== "newline") {
                sourceLeaf = candidate;
                break;
            }
        }
        let outputLeaf: SourceLeaf | null = null;
        while (outputIndex < lexed.leaves.length) {
            const candidate = lexed.leaves[outputIndex++]!;
            statistics.outputLeafVisitCount += 1;
            if (candidate.kind !== "whitespace" && candidate.kind !== "newline") {
                outputLeaf = candidate;
                break;
            }
        }
        if (sourceLeaf === null || outputLeaf === null) {
            return tokenEquivalenceCheck(
                sourceLeaf === null && outputLeaf === null,
                statistics
            );
        }
        statistics.comparisonCount += 1;
        if (
            sourceLeaf.kind !== outputLeaf.kind ||
            sourceLeaf.channel !== outputLeaf.channel
        ) {
            return tokenEquivalenceCheck(false, statistics);
        }
        statistics.directLookupCount += 1;
        const plannedTransform =
            plan.leafEmissions[sourceLeaf.id] === "keyword-case";
        if (plannedTransform) {
            statistics.directLookupCount += 1;
            const syntax = analysis.index.leafContext(sourceLeaf.id).syntax;
            if (
                sourceLeaf.channel !== "code" ||
                syntax === null ||
                syntax.keywordCaseEligible !== true ||
                !isKeywordCaseRole(syntax.syntaxRole)
            ) {
                return tokenEquivalenceCheck(false, statistics);
            }
        }
        const expected = plannedTransform
            ? applyKeywordCase(sourceLeaf.raw, keywordCase)
            : sourceLeaf.raw;
        if (expected === null || outputLeaf.raw !== expected) {
            return tokenEquivalenceCheck(false, statistics);
        }
    }
}

function validMode(value: unknown): value is ParseMode {
    return value === "document" || value === "statement" || value === "fragment";
}

/** Internal Wave 3 orchestration; deliberately not exported from core/index.ts. */
export function formatSqlWithStatistics(
    sourceValue: string,
    optionsValue: FormatOptions | unknown = undefined,
    modeValue: ParseMode | unknown = "document",
    environmentValue: RenderEnvironment | RenderNewline | unknown = undefined,
    debugEvents: DebugEvent[] | undefined = undefined
): FormatPipelineRun {
    const source = typeof sourceValue === "string" ? sourceValue : "";
    const statistics = statisticsAccumulator(source.length);
    try {
        if (typeof sourceValue !== "string") {
            const value = diagnostic(
                source,
                "FMT_SOURCE_TYPE",
                "Formatter source must be a primitive string"
            );
            return run(originalResult("failed", source, [value]), statistics);
        }
        if (!validMode(modeValue)) {
            const value = diagnostic(
                source,
                "FMT_PARSE_MODE",
                "Formatter parse mode is invalid"
            );
            return run(originalResult("failed", source, [value]), statistics);
        }
        const environment = environmentValue === undefined
            ? inferRenderEnvironment(source)
            : isRenderNewline(environmentValue)
                ? renderEnvironmentForNewline(environmentValue)
                : environmentValue;
        if (!isCanonicalRenderEnvironment(environment)) {
            const value = diagnostic(
                source,
                "RENDER_NEWLINE_CONTRACT",
                "Formatter render environment is invalid"
            );
            return run(originalResult("failed", source, [value]), statistics);
        }
        const resolved = resolveFormatOptions(optionsValue);
        if (!resolved.ok) {
            const value = diagnostic(source, resolved.code, resolved.message);
            return run(originalResult("failed", source, [value]), statistics);
        }
        if (source.length > MAX_FORMAT_SOURCE_CODE_UNITS) {
            const value = diagnostic(
                source,
                "FMT_INPUT_LIMIT",
                "Formatter source exceeds the supported input limit",
                "warning"
            );
            return run(originalResult("preserved", source, [value]), statistics);
        }
        const options = resolved.options;
        const analysis = analyzeSql(source, {
            dialect: options.dialect,
            mode: modeValue,
        });
        const leafCount = analysis.leaves.length;
        const syntaxNodeCount = analysis.index?.nodes().length ?? 0;
        recordAnalysisStatistics(statistics, leafCount, syntaxNodeCount);
        if (analysis.status === "failed") {
            return run(
                originalResult("failed", source, analysis.diagnostics),
                statistics
            );
        }
        if (analysis.status === "preserved") {
            return run(
                originalResult("preserved", source, analysis.diagnostics),
                statistics
            );
        }
        if (
            options.unsupportedSyntaxPolicy === "bail_out" &&
            analysis.diagnostics.some((value) => value.capabilityId !== null)
        ) {
            const bail = diagnostic(
                source,
                "FMT_UNSUPPORTED_BAIL_OUT",
                "Unsupported syntax policy preserved the complete target",
                "warning"
            );
            return run(
                originalResult(
                    "preserved",
                    source,
                    frozenDiagnostics(analysis.diagnostics, bail)
                ),
                statistics
            );
        }

        let planned = buildLayoutPlan(analysis, options);
        if (!planned.ok) {
            if (isLayoutResourceFailure(planned.code)) {
                return run(
                    resourcePreservedResult(
                        source,
                        analysis.diagnostics,
                        planned.code,
                        planned.message
                    ),
                    statistics
                );
            }
            const value = diagnostic(source, planned.code, planned.message);
            return run(
                originalResult(
                    "failed",
                    source,
                    frozenDiagnostics(analysis.diagnostics, value)
                ),
                statistics
            );
        }
        recordPlanStatistics(statistics, planned.plan);
        let compiled = compileLayoutPlan(planned.plan);
        if (!compiled.ok) {
            if (isLayoutResourceFailure(compiled.code)) {
                return run(
                    resourcePreservedResult(
                        source,
                        analysis.diagnostics,
                        compiled.code,
                        compiled.message
                    ),
                    statistics
                );
            }
            const value = diagnostic(source, compiled.code, compiled.message);
            return run(
                originalResult(
                    "failed",
                    source,
                    frozenDiagnostics(analysis.diagnostics, value)
                ),
                statistics
            );
        }
        recordCompiledStatistics(statistics, compiled.statistics);
        let rendered = renderLayoutArtifact(compiled.artifact, environment);
        if (!rendered.ok) {
            if (isLayoutResourceFailure(rendered.code)) {
                return run(
                    resourcePreservedResult(
                        source,
                        analysis.diagnostics,
                        rendered.code,
                        rendered.message
                    ),
                    statistics
                );
            }
            const value = diagnostic(source, rendered.code, rendered.message);
            return run(
                originalResult(
                    "failed",
                    source,
                    frozenDiagnostics(analysis.diagnostics, value)
                ),
                statistics
            );
        }
        recordRenderedStatistics(
            statistics,
            rendered.statistics
        );
        {
            const alignmentPlan = deriveLayoutAlignmentPlan(
                analysis,
                options,
                rendered,
                environment.tabSize
            );
            if (alignmentPlan === null) {
                const value = diagnostic(
                    source,
                    "LAYOUT_ALIGNMENT_FACTS",
                    "Layout alignment measurement failed"
                );
                return run(
                    originalResult(
                        "failed",
                        source,
                        frozenDiagnostics(analysis.diagnostics, value)
                    ),
                    statistics
                );
            }
            if (alignmentPlan.targets.length > 0) {
                const alignedPlan = buildLayoutPlan(
                    analysis,
                    options,
                    alignmentPlan
                );
                if (!alignedPlan.ok) {
                    if (isLayoutResourceFailure(alignedPlan.code)) {
                        return run(
                            resourcePreservedResult(
                                source,
                                analysis.diagnostics,
                                alignedPlan.code,
                                alignedPlan.message
                            ),
                            statistics
                        );
                    }
                    const value = diagnostic(
                        source,
                        alignedPlan.code,
                        alignedPlan.message
                    );
                    return run(
                        originalResult(
                            "failed",
                            source,
                            frozenDiagnostics(analysis.diagnostics, value)
                        ),
                        statistics
                    );
                }
                recordPlanStatistics(statistics, alignedPlan.plan);
                const alignedCompiled = compileLayoutPlan(alignedPlan.plan);
                if (!alignedCompiled.ok) {
                    if (isLayoutResourceFailure(alignedCompiled.code)) {
                        return run(
                            resourcePreservedResult(
                                source,
                                analysis.diagnostics,
                                alignedCompiled.code,
                                alignedCompiled.message
                            ),
                            statistics
                        );
                    }
                    const value = diagnostic(
                        source,
                        alignedCompiled.code,
                        alignedCompiled.message
                    );
                    return run(
                        originalResult(
                            "failed",
                            source,
                            frozenDiagnostics(analysis.diagnostics, value)
                        ),
                        statistics
                    );
                }
                recordCompiledStatistics(
                    statistics,
                    alignedCompiled.statistics
                );
                const alignedRendered = renderLayoutArtifact(
                    alignedCompiled.artifact,
                    environment
                );
                if (!alignedRendered.ok) {
                    if (isLayoutResourceFailure(alignedRendered.code)) {
                        return run(
                            resourcePreservedResult(
                                source,
                                analysis.diagnostics,
                                alignedRendered.code,
                                alignedRendered.message
                            ),
                            statistics
                        );
                    }
                    const value = diagnostic(
                        source,
                        alignedRendered.code,
                        alignedRendered.message
                    );
                    return run(
                        originalResult(
                            "failed",
                            source,
                            frozenDiagnostics(analysis.diagnostics, value)
                        ),
                        statistics
                    );
                }
                planned = alignedPlan;
                compiled = alignedCompiled;
                rendered = alignedRendered;
                recordRenderedStatistics(
                    statistics,
                    rendered.statistics
                );
            }
        }
        const equivalence = tokenEquivalent(
            analysis,
            rendered.text,
            options.keywordCase,
            planned.plan
        );
        recordCompletedStatistics(
            statistics,
            equivalence.statistics
        );
        if (!equivalence.equivalent) {
            const value = diagnostic(
                source,
                "FMT_TOKEN_EQUIVALENCE",
                "Rendered output failed token-equivalence validation"
            );
            return run(
                originalResult(
                    "failed",
                    source,
                    frozenDiagnostics(analysis.diagnostics, value)
                ),
                statistics
            );
        }
        const resultDiagnostics =
            planned.plan.statistics.commaFallbackCount > 0
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
        statistics.outputCodeUnits = rendered.text.length;
        return run(result, statistics);
    } catch (error) {
        debugEvents?.push(createDebugEvent("format", "FMT_INTERNAL", error));
        const value = diagnostic(
            source,
            "FMT_INTERNAL",
            "Formatter internal boundary failed"
        );
        return run(originalResult("failed", source, [value]), statistics);
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
    const result = formatSqlWithStatistics(
        source,
        options,
        mode,
        isRenderNewline(environment)
            ? renderEnvironmentForNewline(environment, tabSize)
            : environment,
        debugEnabled ? debugEvents : undefined
    ).result;
    return Object.freeze({
        result,
        debugEvents: Object.freeze(debugEvents),
    });
}

export function formatSql(
    source: string,
    options: FormatOptions | unknown = undefined,
    mode: ParseMode | unknown = "document",
    environment: RenderEnvironment | RenderNewline | unknown = undefined
): FormatResult {
    return formatSqlWithStatistics(source, options, mode, environment).result;
}
