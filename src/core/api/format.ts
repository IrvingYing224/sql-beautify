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
import { resolveFormatOptions } from "../config/resolve-options";
import { lexSql } from "../lexer/lossless-lexer";
import type { SourceLeaf } from "../lexer/token";
import { compileLayoutPlan } from "../layout/compiler";
import { deriveLayoutAlignmentPlan } from "../layout/alignment-policy";
import type { LayoutPlan } from "../layout/plan";
import { buildLayoutPlan } from "../layout/policy";
import { applyKeywordCase } from "../renderer/keyword-case";
import {
    inferRenderEnvironment,
    isCanonicalRenderEnvironment,
    isRenderNewline,
    renderEnvironmentForNewline,
    type RenderEnvironment,
    type RenderNewline,
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

interface FormatClosureStatistics {
    readonly metricsDocVisitCount: number;
    readonly metricsSummaryLookupCount: number;
    readonly renderDocVisitCount: number;
    readonly renderMetricsLookupCount: number;
    readonly equivalence: TokenEquivalenceStatistics;
}

const ZERO_EQUIVALENCE_STATISTICS: TokenEquivalenceStatistics = Object.freeze({
    inputCodeUnits: 0,
    diagnosticVisitCount: 0,
    sourceLeafVisitCount: 0,
    outputLeafVisitCount: 0,
    comparisonCount: 0,
    directLookupCount: 0,
});

const ZERO_CLOSURE_STATISTICS: FormatClosureStatistics = Object.freeze({
    metricsDocVisitCount: 0,
    metricsSummaryLookupCount: 0,
    renderDocVisitCount: 0,
    renderMetricsLookupCount: 0,
    equivalence: ZERO_EQUIVALENCE_STATISTICS,
});

function spanForSource(source: string) {
    return Object.freeze({ start: 0, end: source.length });
}

function diagnostic(
    source: string,
    code: string,
    message: string,
    severity: Diagnostic["severity"] = "error"
): Diagnostic {
    return Object.freeze({
        code,
        severity,
        message,
        capabilityId: null,
        span: spanForSource(source),
        recovery: "preserve-target" as const,
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

function statistics(
    sourceCodeUnits: number,
    outputCodeUnits = sourceCodeUnits,
    leafCount = 0,
    syntaxNodeCount = 0,
    planActionCount = 0,
    maxPlanActions = 0,
    leafVisitCount = 0,
    leafEmissionCount = 0,
    directLookupCount = 0,
    docNodeCount = 0,
    scopeActionCount = 0,
    scopeActionVisitCount = 0,
    policyNodeVisitCount = 0,
    policyLeafVisitCount = 0,
    policyDirectLookupCount = 0,
    closure: FormatClosureStatistics = ZERO_CLOSURE_STATISTICS
): FormatPipelineStatistics {
    return Object.freeze({
        sourceCodeUnits,
        outputCodeUnits,
        leafCount,
        syntaxNodeCount,
        planActionCount,
        maxPlanActions,
        leafVisitCount,
        leafEmissionCount,
        directLookupCount,
        docNodeCount,
        scopeActionCount,
        scopeActionVisitCount,
        policyNodeVisitCount,
        policyLeafVisitCount,
        policyDirectLookupCount,
        metricsDocVisitCount: closure.metricsDocVisitCount,
        metricsSummaryLookupCount: closure.metricsSummaryLookupCount,
        renderDocVisitCount: closure.renderDocVisitCount,
        renderMetricsLookupCount: closure.renderMetricsLookupCount,
        equivalenceInputCodeUnits: closure.equivalence.inputCodeUnits,
        equivalenceDiagnosticVisitCount:
            closure.equivalence.diagnosticVisitCount,
        equivalenceSourceLeafVisitCount:
            closure.equivalence.sourceLeafVisitCount,
        equivalenceOutputLeafVisitCount:
            closure.equivalence.outputLeafVisitCount,
        equivalenceComparisonCount: closure.equivalence.comparisonCount,
        equivalenceDirectLookupCount: closure.equivalence.directLookupCount,
    });
}

function run(
    result: FormatResult,
    value: FormatPipelineStatistics
): FormatPipelineRun {
    return Object.freeze({ result, statistics: value });
}

function closureStatistics(
    rendered: RenderStatistics,
    equivalence: TokenEquivalenceStatistics = ZERO_EQUIVALENCE_STATISTICS
): FormatClosureStatistics {
    return Object.freeze({
        metricsDocVisitCount: rendered.metricsDocVisitCount,
        metricsSummaryLookupCount: rendered.metricsSummaryLookupCount,
        renderDocVisitCount: rendered.docVisitCount,
        renderMetricsLookupCount: rendered.metricsLookupCount,
        equivalence,
    });
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
    environmentValue: RenderEnvironment | RenderNewline | unknown = undefined
): FormatPipelineRun {
    const source = typeof sourceValue === "string" ? sourceValue : "";
    try {
        if (typeof sourceValue !== "string") {
            const value = diagnostic(
                source,
                "FMT_SOURCE_TYPE",
                "Formatter source must be a primitive string"
            );
            return run(
                originalResult("failed", source, [value]),
                statistics(source.length)
            );
        }
        if (!validMode(modeValue)) {
            const value = diagnostic(
                source,
                "FMT_PARSE_MODE",
                "Formatter parse mode is invalid"
            );
            return run(
                originalResult("failed", source, [value]),
                statistics(source.length)
            );
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
            return run(
                originalResult("failed", source, [value]),
                statistics(source.length)
            );
        }
        const resolved = resolveFormatOptions(optionsValue);
        if (!resolved.ok) {
            const value = diagnostic(source, resolved.code, resolved.message);
            return run(
                originalResult("failed", source, [value]),
                statistics(source.length)
            );
        }
        if (source.length > MAX_FORMAT_SOURCE_CODE_UNITS) {
            const value = diagnostic(
                source,
                "FMT_INPUT_LIMIT",
                "Formatter source exceeds the supported input limit",
                "warning"
            );
            return run(
                originalResult("preserved", source, [value]),
                statistics(source.length)
            );
        }
        const options = resolved.options;
        const analysis = analyzeSql(source, {
            dialect: options.dialect,
            mode: modeValue,
        });
        const leafCount = analysis.leaves.length;
        const syntaxNodeCount = analysis.index?.nodes().length ?? 0;
        if (analysis.status === "failed") {
            return run(
                originalResult("failed", source, analysis.diagnostics),
                statistics(
                    source.length,
                    source.length,
                    leafCount,
                    syntaxNodeCount
                )
            );
        }
        if (analysis.status === "preserved") {
            return run(
                originalResult("preserved", source, analysis.diagnostics),
                statistics(
                    source.length,
                    source.length,
                    leafCount,
                    syntaxNodeCount
                )
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
                statistics(
                    source.length,
                    source.length,
                    leafCount,
                    syntaxNodeCount
                )
            );
        }

        let planned = buildLayoutPlan(analysis, options);
        if (!planned.ok) {
            const value = diagnostic(source, planned.code, planned.message);
            return run(
                originalResult(
                    "failed",
                    source,
                    frozenDiagnostics(analysis.diagnostics, value)
                ),
                statistics(
                    source.length,
                    source.length,
                    leafCount,
                    syntaxNodeCount
                )
            );
        }
        let compiled = compileLayoutPlan(planned.plan);
        if (!compiled.ok) {
            const value = diagnostic(source, compiled.code, compiled.message);
            return run(
                originalResult(
                    "failed",
                    source,
                    frozenDiagnostics(analysis.diagnostics, value)
                ),
                statistics(
                    source.length,
                    source.length,
                    leafCount,
                    syntaxNodeCount,
                    planned.plan.statistics.actionCount,
                    planned.plan.budget.maxPlanActions,
                    planned.plan.statistics.leafVisitCount +
                        planned.plan.statistics.policyLeafVisitCount,
                    0,
                    planned.plan.statistics.directLookupCount +
                        planned.plan.statistics.policyDirectLookupCount,
                    0,
                    planned.plan.statistics.scopeActionCount,
                    0,
                    planned.plan.statistics.policyNodeVisitCount,
                    planned.plan.statistics.policyLeafVisitCount,
                    planned.plan.statistics.policyDirectLookupCount
                )
            );
        }
        let rendered = renderLayoutArtifact(compiled.artifact, environment);
        let leafVisitCount =
            planned.plan.statistics.leafVisitCount +
            planned.plan.statistics.policyLeafVisitCount +
            compiled.statistics.leafVisitCount;
        let directLookupCount =
            planned.plan.statistics.directLookupCount +
            planned.plan.statistics.policyDirectLookupCount +
            compiled.statistics.directLookupCount;
        if (!rendered.ok) {
            const value = diagnostic(source, rendered.code, rendered.message);
            return run(
                originalResult(
                    "failed",
                    source,
                    frozenDiagnostics(analysis.diagnostics, value)
                ),
                statistics(
                    source.length,
                    source.length,
                    leafCount,
                    syntaxNodeCount,
                    planned.plan.statistics.actionCount,
                    planned.plan.budget.maxPlanActions,
                    leafVisitCount,
                    compiled.statistics.leafEmissionCount,
                    directLookupCount,
                    0,
                    planned.plan.statistics.scopeActionCount,
                    compiled.statistics.scopeActionVisitCount,
                    planned.plan.statistics.policyNodeVisitCount,
                    planned.plan.statistics.policyLeafVisitCount,
                    planned.plan.statistics.policyDirectLookupCount
                )
            );
        }
        {
            const alignmentPlan = deriveLayoutAlignmentPlan(
                analysis,
                options,
                rendered
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
                    statistics(
                        source.length,
                        source.length,
                        leafCount,
                        syntaxNodeCount,
                        planned.plan.statistics.actionCount,
                        planned.plan.budget.maxPlanActions,
                        leafVisitCount,
                        compiled.statistics.leafEmissionCount,
                        directLookupCount,
                        rendered.statistics.docVisitCount,
                        planned.plan.statistics.scopeActionCount,
                        compiled.statistics.scopeActionVisitCount,
                        planned.plan.statistics.policyNodeVisitCount,
                        planned.plan.statistics.policyLeafVisitCount,
                        planned.plan.statistics.policyDirectLookupCount,
                        closureStatistics(rendered.statistics)
                    )
                );
            }
            if (alignmentPlan.targets.length > 0) {
                planned = buildLayoutPlan(
                    analysis,
                    options,
                    alignmentPlan
                );
                if (!planned.ok) {
                    const value = diagnostic(
                        source,
                        planned.code,
                        planned.message
                    );
                    return run(
                        originalResult(
                            "failed",
                            source,
                            frozenDiagnostics(analysis.diagnostics, value)
                        ),
                        statistics(source.length)
                    );
                }
                compiled = compileLayoutPlan(planned.plan);
                if (!compiled.ok) {
                    const value = diagnostic(
                        source,
                        compiled.code,
                        compiled.message
                    );
                    return run(
                        originalResult(
                            "failed",
                            source,
                            frozenDiagnostics(analysis.diagnostics, value)
                        ),
                        statistics(source.length)
                    );
                }
                rendered = renderLayoutArtifact(compiled.artifact, environment);
                if (!rendered.ok) {
                    const value = diagnostic(
                        source,
                        rendered.code,
                        rendered.message
                    );
                    return run(
                        originalResult(
                            "failed",
                            source,
                            frozenDiagnostics(analysis.diagnostics, value)
                        ),
                        statistics(source.length)
                    );
                }
                leafVisitCount =
                    planned.plan.statistics.leafVisitCount +
                    planned.plan.statistics.policyLeafVisitCount +
                    compiled.statistics.leafVisitCount;
                directLookupCount =
                    planned.plan.statistics.directLookupCount +
                    planned.plan.statistics.policyDirectLookupCount +
                    compiled.statistics.directLookupCount;
            }
        }
        const equivalence = tokenEquivalent(
            analysis,
            rendered.text,
            options.keywordCase,
            planned.plan
        );
        const completedClosure = closureStatistics(
            rendered.statistics,
            equivalence.statistics
        );
        const completedLeafVisitCount =
            leafVisitCount +
            equivalence.statistics.sourceLeafVisitCount +
            equivalence.statistics.outputLeafVisitCount;
        const completedDirectLookupCount =
            directLookupCount +
            rendered.statistics.metricsSummaryLookupCount +
            rendered.statistics.metricsLookupCount +
            equivalence.statistics.directLookupCount;
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
                statistics(
                    source.length,
                    source.length,
                    leafCount,
                    syntaxNodeCount,
                    planned.plan.statistics.actionCount,
                    planned.plan.budget.maxPlanActions,
                    completedLeafVisitCount,
                    compiled.statistics.leafEmissionCount,
                    completedDirectLookupCount,
                    rendered.statistics.docVisitCount,
                    planned.plan.statistics.scopeActionCount,
                    compiled.statistics.scopeActionVisitCount,
                    planned.plan.statistics.policyNodeVisitCount,
                    planned.plan.statistics.policyLeafVisitCount,
                    planned.plan.statistics.policyDirectLookupCount,
                    completedClosure
                )
            );
        }
        const result = safeResult(
            source,
            rendered.text,
            analysis.diagnostics,
            rendered.sourceMap
        );
        return run(
            result,
            statistics(
                source.length,
                rendered.text.length,
                leafCount,
                syntaxNodeCount,
                planned.plan.statistics.actionCount,
                planned.plan.budget.maxPlanActions,
                completedLeafVisitCount,
                compiled.statistics.leafEmissionCount,
                completedDirectLookupCount,
                rendered.statistics.docVisitCount,
                planned.plan.statistics.scopeActionCount,
                compiled.statistics.scopeActionVisitCount,
                planned.plan.statistics.policyNodeVisitCount,
                planned.plan.statistics.policyLeafVisitCount,
                planned.plan.statistics.policyDirectLookupCount,
                completedClosure
            )
        );
    } catch {
        const value = diagnostic(
            source,
            "FMT_INTERNAL",
            "Formatter internal boundary failed"
        );
        return run(
            originalResult("failed", source, [value]),
            statistics(source.length)
        );
    }
}

export function formatSql(
    source: string,
    options: FormatOptions | unknown = undefined,
    mode: ParseMode | unknown = "document",
    environment: RenderEnvironment | RenderNewline | unknown = undefined
): FormatResult {
    return formatSqlWithStatistics(source, options, mode, environment).result;
}
