import type {
    FormatResult,
    OriginalTextFormatResult,
    SafeFormatResult,
} from "./format-result";
import { analyzeSql } from "../analysis/analyze";
import type { AnalyzedArtifact } from "../analysis/types";
import type { FormatOptions } from "../config/options";
import type { Diagnostic } from "../diagnostics/diagnostic";
import { resolveFormatOptions } from "../config/resolve-options";
import { lexSql } from "../lexer/lossless-lexer";
import type { SourceLeaf } from "../lexer/token";
import { compileLayoutPlan } from "../layout/compiler";
import type { LayoutPlan } from "../layout/plan";
import { buildLayoutPlan } from "../layout/policy";
import { applyKeywordCase } from "../renderer/keyword-case";
import { renderLayoutArtifact } from "../renderer/render";
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
}

export interface FormatPipelineRun {
    readonly result: FormatResult;
    readonly statistics: FormatPipelineStatistics;
}

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
    docNodeCount = 0
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
    });
}

function run(
    result: FormatResult,
    value: FormatPipelineStatistics
): FormatPipelineRun {
    return Object.freeze({ result, statistics: value });
}

function significantLeaves(
    leaves: readonly SourceLeaf[]
): readonly SourceLeaf[] {
    return leaves.filter(
        (leaf) => leaf.kind !== "whitespace" && leaf.kind !== "newline"
    );
}

function tokenEquivalent(
    analysis: AnalyzedArtifact,
    output: string,
    keywordCase: "upper" | "lower",
    plan: LayoutPlan
): boolean {
    const lexed = lexSql(output, { dialect: analysis.dialect });
    if (lexed.diagnostics.some((value) => value.severity === "error")) {
        return false;
    }
    const before = significantLeaves(analysis.leaves);
    const after = significantLeaves(lexed.leaves);
    if (before.length !== after.length) {
        return false;
    }
    for (let index = 0; index < before.length; index++) {
        const sourceLeaf = before[index]!;
        const outputLeaf = after[index]!;
        if (
            sourceLeaf.kind !== outputLeaf.kind ||
            sourceLeaf.channel !== outputLeaf.channel
        ) {
            return false;
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
                return false;
            }
        }
        const expected = plannedTransform
            ? applyKeywordCase(sourceLeaf.raw, keywordCase)
            : sourceLeaf.raw;
        if (expected === null || outputLeaf.raw !== expected) {
            return false;
        }
    }
    return true;
}

function validMode(value: unknown): value is ParseMode {
    return value === "document" || value === "statement" || value === "fragment";
}

/** Internal Wave 3 orchestration; deliberately not exported from core/index.ts. */
export function formatSqlWithStatistics(
    sourceValue: string,
    optionsValue: FormatOptions | unknown = undefined,
    modeValue: ParseMode | unknown = "document"
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
        const resolved = resolveFormatOptions(optionsValue);
        if (!resolved.ok) {
            const value = diagnostic(source, resolved.code, resolved.message);
            return run(
                originalResult("failed", source, [value]),
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

        const planned = buildLayoutPlan(analysis, options);
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
        const compiled = compileLayoutPlan(planned.plan);
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
                    planned.plan.statistics.leafVisitCount,
                    0,
                    planned.plan.statistics.directLookupCount
                )
            );
        }
        const rendered = renderLayoutArtifact(compiled.artifact);
        const leafVisitCount =
            planned.plan.statistics.leafVisitCount +
            compiled.statistics.leafVisitCount;
        const directLookupCount =
            planned.plan.statistics.directLookupCount +
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
                    directLookupCount
                )
            );
        }
        if (!tokenEquivalent(
            analysis,
            rendered.text,
            options.keywordCase,
            planned.plan
        )) {
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
                    leafVisitCount,
                    compiled.statistics.leafEmissionCount,
                    directLookupCount,
                    rendered.statistics.docVisitCount
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
                leafVisitCount,
                compiled.statistics.leafEmissionCount,
                directLookupCount,
                rendered.statistics.docVisitCount
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
    mode: ParseMode | unknown = "document"
): FormatResult {
    return formatSqlWithStatistics(source, options, mode).result;
}
