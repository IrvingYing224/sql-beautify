import { isProxy } from "node:util/types";

type BridgeMode = "document" | "statement" | "fragment";
type BridgeSeverity = "info" | "warning" | "error";
type BridgeRecovery =
    | "none"
    | "verbatim-node"
    | "preserve-statement"
    | "preserve-target";

interface BridgeSpan {
    readonly start: number;
    readonly end: number;
}

interface BridgeSourceMapEntry {
    readonly source: BridgeSpan;
    readonly output: BridgeSpan;
}

interface BridgeSourceMap {
    readonly entries: readonly BridgeSourceMapEntry[];
}

interface BridgeDiagnostic {
    readonly code: string;
    readonly severity: BridgeSeverity;
    readonly message: string;
    readonly capabilityId: string | null;
    readonly span: BridgeSpan;
    readonly recovery: BridgeRecovery;
}

interface BridgeEditResult {
    readonly kind: "edit";
    readonly status: "formatted";
    readonly text: string;
    readonly diagnostics: readonly BridgeDiagnostic[];
    readonly sourceMap: BridgeSourceMap;
}

interface BridgeUnchangedResult {
    readonly kind: "unchanged";
    readonly status: "unchanged";
    readonly text: string;
    readonly diagnostics: readonly BridgeDiagnostic[];
    readonly sourceMap: BridgeSourceMap;
}

interface BridgeOriginalTextResult {
    readonly kind: "preserved" | "failed";
    readonly status: "preserved" | "failed";
    readonly text: string;
    readonly diagnostics: readonly BridgeDiagnostic[];
}

interface BridgeCancelledResult {
    readonly kind: "cancelled";
    readonly status: "cancelled";
    readonly text: string;
    readonly diagnostics: readonly [];
}

type BridgeResult =
    | BridgeEditResult
    | BridgeUnchangedResult
    | BridgeOriginalTextResult
    | BridgeCancelledResult;

interface BridgeRequest {
    readonly source?: unknown;
    readonly cancelled?: unknown;
    readonly isCancelled?: unknown;
    readonly mode?: unknown;
    readonly kind?: unknown;
    readonly options?: unknown;
}

interface BridgeFormatter {
    formatSqlTarget(
        source: string,
        options: Readonly<Record<string, unknown>>,
        mode: BridgeMode
    ): unknown;
}

interface BridgeDependencies {
    readonly formatter?: unknown;
}

interface RawSourceMap {
    readonly entries?: unknown;
}

interface RawSourceMapEntry {
    readonly source?: unknown;
    readonly output?: unknown;
}

interface RawDiagnostic {
    readonly code?: unknown;
    readonly severity?: unknown;
    readonly message?: unknown;
    readonly capabilityId?: unknown;
    readonly span?: unknown;
    readonly recovery?: unknown;
}

interface RawResult {
    readonly status?: unknown;
    readonly text?: unknown;
    readonly diagnostics?: unknown;
    readonly sourceMap?: unknown;
}

var V2_OPTION_KEYS = [
    "dialect",
    "keywordCase",
    "commaStyle",
    "indentStyle",
    "maxAlignWidth",
    "caseWhenThenWrapLength",
    "caseLayout",
    "unsupportedSyntaxPolicy",
] as const;

var V2_OPTION_KEY_SET: Record<string, true> = Object.create(null) as Record<
    string,
    true
>;
for (var optionKeyIndex = 0; optionKeyIndex < V2_OPTION_KEYS.length; optionKeyIndex++) {
    V2_OPTION_KEY_SET[V2_OPTION_KEYS[optionKeyIndex]!] = true;
}
V2_OPTION_KEY_SET.languageMode = true;

var DIALECTS: Record<string, string> = {
    generic: "generic",
    hive: "hive",
    postgres: "postgresql",
    postgresql: "postgresql",
    mysql: "mysql",
};

var RECOVERIES: Record<string, true> = {
    none: true,
    "verbatim-node": true,
    "preserve-statement": true,
    "preserve-target": true,
};

function failure_diagnostic(code: string, message: string): BridgeDiagnostic {
    return Object.freeze({
        code: code,
        severity: "error",
        message: message,
        capabilityId: null,
        span: Object.freeze({ start: 0, end: 0 }),
        recovery: "preserve-target",
    });
}

function failed_result(
    source: string,
    code: string,
    message: string
): BridgeOriginalTextResult {
    return Object.freeze({
        kind: "failed",
        status: "failed",
        text: source,
        diagnostics: Object.freeze([failure_diagnostic(code, message)]),
    });
}

function is_cancelled(request: BridgeRequest | null | undefined): boolean {
    if (!request) {
        return false;
    }
    if (request.cancelled === true) {
        return true;
    }
    if (typeof request.isCancelled === "function") {
        try {
            return (request as { isCancelled: () => unknown }).isCancelled() === true;
        } catch {
            return true;
        }
    }
    return false;
}

export function map_dialect(value: unknown): string | null {
    return Object.prototype.hasOwnProperty.call(DIALECTS, value as PropertyKey)
        ? DIALECTS[value as string]!
        : null;
}

export function create_options(
    config: unknown
): Readonly<Record<string, unknown>> | null {
    if (typeof config === "undefined") {
        return {};
    }
    if (!config || typeof config !== "object" || Array.isArray(config)) {
        return null;
    }

    try {
        if (isProxy(config)) {
            return null;
        }
        var prototype = Object.getPrototypeOf(config);
        if (prototype !== Object.prototype && prototype !== null) {
            return null;
        }
        var ownKeys = Reflect.ownKeys(config);
        var values: Record<string, unknown> = Object.create(null) as Record<
            string,
            unknown
        >;
        for (var ownIndex = 0; ownIndex < ownKeys.length; ownIndex++) {
            var ownKey = ownKeys[ownIndex];
            if (typeof ownKey !== "string" || !V2_OPTION_KEY_SET[ownKey]) {
                return null;
            }
            var descriptor = Object.getOwnPropertyDescriptor(config, ownKey);
            if (
                !descriptor ||
                descriptor.enumerable !== true ||
                !Object.prototype.hasOwnProperty.call(descriptor, "value")
            ) {
                return null;
            }
            values[ownKey] = descriptor.value;
        }

        var options: Record<string, unknown> = {};
        for (var i = 0; i < V2_OPTION_KEYS.length; i++) {
            var key = V2_OPTION_KEYS[i]!;
            if (key == "dialect") {
                if (typeof values[key] !== "undefined") {
                    var dialect = map_dialect(values[key]);
                    if (dialect === null) {
                        return null;
                    }
                    options.dialect = dialect;
                }
            } else if (typeof values[key] !== "undefined") {
                options[key] = values[key];
            }
        }
        return Object.freeze(options);
    } catch {
        return null;
    }
}

function valid_span(span: BridgeSpan | null, sourceLength: number): boolean | null {
    return (
        span &&
        Number.isSafeInteger(span.start) &&
        Number.isSafeInteger(span.end) &&
        span.start >= 0 &&
        span.end >= span.start &&
        span.end <= sourceLength
    );
}

export function normalize_source_map(
    sourceMap: unknown,
    sourceLength: number,
    outputLength: number
): BridgeSourceMap | null {
    try {
        if (!sourceMap || typeof sourceMap !== "object") {
            return null;
        }
        var sourceMapEntries = (sourceMap as RawSourceMap).entries;
        if (!Array.isArray(sourceMapEntries)) {
            return null;
        }
        var rawEntries: unknown[] = Array.from(sourceMapEntries);
        var entries: BridgeSourceMapEntry[] = [];
        var previousSourceEnd = 0;
        var previousOutputEnd = 0;
        for (var i = 0; i < rawEntries.length; i++) {
            var entry = rawEntries[i];
            if (!entry || typeof entry !== "object") {
                return null;
            }
            var entryRecord = entry as RawSourceMapEntry;
            var source = entryRecord.source;
            var output = entryRecord.output;
            var sourceSpan: BridgeSpan | null = source
                ? {
                      start: (source as { start: number }).start,
                      end: (source as { end: number }).end,
                  }
                : null;
            var outputSpan: BridgeSpan | null = output
                ? {
                      start: (output as { start: number }).start,
                      end: (output as { end: number }).end,
                  }
                : null;
            if (
                !sourceSpan ||
                !outputSpan ||
                !valid_span(sourceSpan, sourceLength) ||
                !valid_span(outputSpan, outputLength) ||
                sourceSpan.end === sourceSpan.start ||
                outputSpan.end === outputSpan.start ||
                sourceSpan.end - sourceSpan.start !=
                    outputSpan.end - outputSpan.start ||
                sourceSpan.start < previousSourceEnd ||
                outputSpan.start < previousOutputEnd
            ) {
                return null;
            }
            entries.push(
                Object.freeze({
                    source: Object.freeze(sourceSpan),
                    output: Object.freeze(outputSpan),
                })
            );
            previousSourceEnd = sourceSpan.end;
            previousOutputEnd = outputSpan.end;
        }
        return Object.freeze({ entries: Object.freeze(entries) });
    } catch {
        return null;
    }
}

function normalize_diagnostic(
    item: unknown,
    sourceLength: number
): BridgeDiagnostic | null {
    try {
        if (!item || typeof item !== "object") {
            return null;
        }
        var itemRecord = item as RawDiagnostic;
        var code = itemRecord.code;
        var severity = itemRecord.severity;
        var message = itemRecord.message;
        var capabilityId = itemRecord.capabilityId;
        var rawSpan = itemRecord.span;
        var recovery = itemRecord.recovery;
        var span: BridgeSpan | null = rawSpan
            ? {
                  start: (rawSpan as { start: number }).start,
                  end: (rawSpan as { end: number }).end,
              }
            : null;
        if (
            typeof code !== "string" ||
            typeof severity !== "string" ||
            typeof message !== "string" ||
            !span ||
            !valid_span(span, sourceLength) ||
            !Object.prototype.hasOwnProperty.call(
                RECOVERIES,
                recovery as PropertyKey
            )
        ) {
            return null;
        }
        if (severity != "info" && severity != "warning" && severity != "error") {
            return null;
        }
        if (capabilityId !== null && typeof capabilityId !== "string") {
            return null;
        }
        return Object.freeze({
            code: code.slice(0, 120),
            severity: severity as BridgeSeverity,
            message: message.slice(0, 500),
            capabilityId: capabilityId as string | null,
            span: Object.freeze(span),
            recovery: recovery as BridgeRecovery,
        });
    } catch {
        return null;
    }
}

export function normalize_result(source: string, result: unknown): BridgeResult {
    if (!result || typeof result !== "object") {
        return failed_result(
            source,
            "FMT_RESULT_SHAPE",
            "Formatter returned an invalid result"
        );
    }

    var resultRecord = result as RawResult;
    var status = resultRecord.status;
    var text = resultRecord.text;
    var rawDiagnostics = resultRecord.diagnostics;
    if (
        typeof status !== "string" ||
        typeof text !== "string" ||
        !Array.isArray(rawDiagnostics)
    ) {
        return failed_result(
            source,
            "FMT_RESULT_SHAPE",
            "Formatter returned an invalid result"
        );
    }
    var rawDiagnosticSnapshot: unknown[] = Array.from(rawDiagnostics);
    if (
        status != "formatted" &&
        status != "unchanged" &&
        status != "preserved" &&
        status != "failed"
    ) {
        return failed_result(
            source,
            "FMT_RESULT_STATUS",
            "Formatter returned an invalid status"
        );
    }

    var diagnostics: BridgeDiagnostic[] = [];
    for (var i = 0; i < rawDiagnosticSnapshot.length; i++) {
        var diagnostic = normalize_diagnostic(rawDiagnosticSnapshot[i], source.length);
        if (diagnostic === null) {
            return failed_result(
                source,
                "FMT_DIAGNOSTIC_SHAPE",
                "Formatter returned an invalid diagnostic"
            );
        }
        diagnostics.push(diagnostic);
    }

    if (status == "formatted" || status == "unchanged") {
        if (
            (status == "formatted" && text === source) ||
            (status == "unchanged" && text !== source)
        ) {
            return failed_result(
                source,
                "FMT_RESULT_STATUS",
                "Formatter returned an inconsistent result status"
            );
        }
        var rawSourceMap = resultRecord.sourceMap;
        var sourceMap = normalize_source_map(
            rawSourceMap,
            source.length,
            text.length
        );
        if (sourceMap === null) {
            return failed_result(
                source,
                "FMT_SOURCE_MAP_SHAPE",
                "Formatter returned an invalid source map"
            );
        }
        return Object.freeze({
            kind: status == "formatted" ? "edit" : "unchanged",
            status: status,
            text: text,
            diagnostics: Object.freeze(diagnostics),
            sourceMap: sourceMap,
        }) as BridgeEditResult | BridgeUnchangedResult;
    }
    if (status == "preserved" || status == "failed") {
        if (diagnostics.length === 0) {
            return failed_result(
                source,
                "FMT_RESULT_DIAGNOSTIC",
                "Formatter returned an original-text result without a diagnostic"
            );
        }
        return Object.freeze({
            kind: status,
            status: status,
            text: source,
            diagnostics: Object.freeze(diagnostics),
        });
    }
    return failed_result(
        source,
        "FMT_RESULT_STATUS",
        "Formatter returned an invalid status"
    );
}

function request_mode(request: BridgeRequest): BridgeMode | null {
    var mode = request.mode;
    if (mode == "document" || mode == "statement" || mode == "fragment") {
        return mode as BridgeMode;
    }
    if (request.kind == "document") {
        return "document";
    }
    if (request.kind == "range" || request.kind == "command-selection") {
        return "fragment";
    }
    return null;
}

export function create_v2_format_bridge(dependencies?: unknown): {
    format_request: (request: unknown) => BridgeResult;
} {
    var deps = (dependencies || {}) as BridgeDependencies;
    var formatter = deps.formatter;

    if (
        !formatter ||
        typeof (formatter as { formatSqlTarget?: unknown }).formatSqlTarget !==
            "function"
    ) {
        throw new Error("v2 formatter runtime is unavailable");
    }
    var formatterApi = formatter as BridgeFormatter;

    function format_request_unchecked(
        request: BridgeRequest | null | undefined
    ): BridgeResult {
        var source: unknown = request && request.source;
        var mode: BridgeMode | null;
        var options: Readonly<Record<string, unknown>> | null;
        var rawResult: unknown;

        if (typeof source !== "string") {
            return failed_result(
                "",
                "FMT_SOURCE_TYPE",
                "Formatter source must be a primitive string"
            );
        }
        if (is_cancelled(request)) {
            return Object.freeze({
                kind: "cancelled",
                status: "cancelled",
                text: source,
                diagnostics: Object.freeze([]) as readonly [],
            });
        }
        mode = request_mode(request || {});
        if (mode === null) {
            return failed_result(
                source,
                "FMT_PARSE_MODE",
                "Formatter request mode is invalid"
            );
        }
        options = create_options(request && request.options);
        if (options === null) {
            return failed_result(
                source,
                "FMT_OPTIONS_SHAPE",
                "Formatter options could not be mapped"
            );
        }
        try {
            rawResult = formatterApi.formatSqlTarget(source, options, mode);
        } catch {
            return failed_result(
                source,
                "FMT_RUNTIME",
                "Formatter runtime failed"
            );
        }
        if (is_cancelled(request)) {
            return Object.freeze({
                kind: "cancelled",
                status: "cancelled",
                text: source,
                diagnostics: Object.freeze([]) as readonly [],
            });
        }
        try {
            return normalize_result(source, rawResult);
        } catch {
            return failed_result(
                source,
                "FMT_RESULT_READ",
                "Formatter result could not be inspected"
            );
        }
    }

    return {
        format_request: function (request: unknown): BridgeResult {
            try {
                return format_request_unchecked(
                    request as BridgeRequest | null | undefined
                );
            } catch {
                return failed_result(
                    "",
                    "FMT_REQUEST_READ",
                    "Formatter request could not be inspected"
                );
            }
        },
    };
}
