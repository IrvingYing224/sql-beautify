import type { LayoutDoc } from "../layout/doc";
import type { SourceMap } from "../source/source-map";

export interface FlatLayoutSummary {
    readonly flatWidth: number | null;
    readonly hasSourceEmission: boolean;
    readonly endsWithUnterminatedLineComment: boolean;
    readonly containsHardLine: boolean;
    readonly containsMultilineSource: boolean;
    readonly containsTab: boolean;
    readonly containsContextualWidth: boolean;
    readonly containsLineSuffix: boolean;
}

export interface LayoutMetrics {
    readonly summary: FlatLayoutSummary;
    readonly docNodeCount: number;
    summaryOf(doc: LayoutDoc): FlatLayoutSummary | null;
}

export type LayoutMetricsFailureCode =
    | "METRICS_ARTIFACT_PROVENANCE"
    | "METRICS_DOC_PROVENANCE"
    | "METRICS_SOURCE_RANGE"
    | "METRICS_OVERFLOW"
    | "METRICS_INTERNAL";

export interface LayoutMetricsFailure {
    readonly ok: false;
    readonly code: LayoutMetricsFailureCode;
    readonly message: string;
}

export interface LayoutMetricsSuccess {
    readonly ok: true;
    readonly metrics: LayoutMetrics;
}

export type LayoutMetricsResult = LayoutMetricsSuccess | LayoutMetricsFailure;

export type RenderFailureCode =
    | "RENDER_ARTIFACT_PROVENANCE"
    | "RENDER_METRICS"
    | "RENDER_KEYWORD_TRANSFORM"
    | "RENDER_RESOURCE_BUDGET"
    | "RENDER_SOURCE_MAP"
    | "RENDER_NEWLINE_CONTRACT"
    | "RENDER_INTERNAL";

export interface RenderStatistics {
    readonly docVisitCount: number;
    readonly sourceEmissionCount: number;
    readonly chunkCount: number;
    readonly sourceMapEntryCount: number;
    readonly generatedWhitespaceCodeUnits: number;
}

export interface RenderSuccess {
    readonly ok: true;
    readonly text: string;
    readonly sourceMap: SourceMap;
    readonly statistics: RenderStatistics;
}

export interface RenderFailure {
    readonly ok: false;
    readonly code: RenderFailureCode;
    readonly message: string;
}

export type RenderResult = RenderSuccess | RenderFailure;
