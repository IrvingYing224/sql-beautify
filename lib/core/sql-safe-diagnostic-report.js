var sqlFormatDocument = require('./sql-format-document');
var sqlFormatNodes = require('./sql-format-nodes');
var sqlScopeModel = require('./sql-scope-model');

var REPORT_VERSION = 1;
var DEFAULT_SLOW_THRESHOLD_MS = 5000;
var CLASSIFICATIONS = {
    ok: true,
    unsupported_syntax: true,
    unsafe_range: true,
    formatter_throw: true,
    invariant_violation: true,
    vscode_rejected_edit: true,
    overlapping_selection: true,
    slow_format: true,
    unknown: true
};
var SAFE_LABELS = {
    MATCH_RECOGNIZE: true,
    UNPIVOT: true,
    PIVOT: true,
    MERGE: true,
    QUALIFY: true,
    DIALECT_UNSUPPORTED_CLAUSE: true,
    KNOWN_UNMODELED_CONSTRUCT: true,
    OPAQUE_CLAUSE: true
};
var SAFE_SOURCES = {
    opaque_protection: true,
    syntax_risk_detector: true
};
var SAFE_DIAGNOSTIC_CODES = {
    unsupported_syntax: true,
    unsafe_range: true,
    formatter_throw: true,
    invariant_violation: true,
    vscode_rejected_edit: true,
    overlapping_selection: true,
    slow_format: true,
    unknown: true
};
var SAFE_TELEMETRY_PHASES = {
    syntax_risk_detection: true,
    protect_input: true,
    format_document: true,
    scope_model: true,
    format_nodes: true,
    mutation_plan: true,
    render: true,
    restore: true,
    unknown: true
};
var SAFE_TELEMETRY_STATUSES = {
    ok: true,
    error: true,
    unknown: true
};
var SAFE_REPORT_PHASES = {
    core_format: true,
    command_format: true,
    document_format: true,
    range_format: true,
    unknown: true
};
var SAFE_DIALECTS = {
    generic: true,
    hive: true,
    unknown: true
};
var SAFE_UNSUPPORTED_POLICIES = {
    preserve: true,
    warn: true,
    bail_out: true,
    unknown: true
};

function own_keys(object) {
    var keys = [];
    var source = object || {};
    var key;

    for (key in source) {
        if (Object.prototype.hasOwnProperty.call(source, key)) {
            keys.push(key);
        }
    }

    return keys;
}

function unique_sorted(values) {
    var seen = {};
    var output = [];
    var i;
    var value;

    for (i = 0; i < (values || []).length; i++) {
        value = String(values[i] || '');
        if (!value || seen[value]) {
            continue;
        }
        seen[value] = true;
        output.push(value);
    }

    output.sort();
    return output;
}

function count_lines(text) {
    var value = String(text || '');
    if (value.length == 0) {
        return 0;
    }
    return value.replace(/\r\n|\r/g, '\n').split('\n').length;
}

function is_code_token(token) {
    return !!(token && token.isCode);
}

function token_upper(token) {
    return String(token && token.value || '').toUpperCase();
}

function active_code_tokens(tokens) {
    var output = [];
    var i;

    for (i = 0; i < (tokens || []).length; i++) {
        if (is_code_token(tokens[i])) {
            output.push(tokens[i]);
        }
    }

    return output;
}

function count_word(tokens, word) {
    var total = 0;
    var target = String(word || '').toUpperCase();
    var i;

    for (i = 0; i < (tokens || []).length; i++) {
        if (tokens[i].type == 'word' && token_upper(tokens[i]) == target) {
            total += 1;
        }
    }

    return total;
}

function count_word_pair(tokens, first, second) {
    var total = 0;
    var codeTokens = active_code_tokens(tokens);
    var i;

    for (i = 0; i < codeTokens.length - 1; i++) {
        if (token_upper(codeTokens[i]) == first && token_upper(codeTokens[i + 1]) == second) {
            total += 1;
        }
    }

    return total;
}

function count_subquery(document) {
    var total = 0;
    var scopes = document && document.scopes ? document.scopes : [];
    var i;

    for (i = 0; i < scopes.length; i++) {
        if (scopes[i] && scopes[i].kind == 'query') {
            total += 1;
        }
    }

    return total > 0 ? total - 1 : 0;
}

function input_stats(text, options) {
    var document = sqlFormatDocument.from_text(text, options || {});
    var tokens = document.tokens || [];
    var stats = {
        chars: String(text || '').length,
        lines: count_lines(text),
        tokens: tokens.length,
        codeTokens: 0,
        commentTokens: 0,
        stringLiterals: 0,
        quotedIdentifiers: 0
    };
    var i;

    for (i = 0; i < tokens.length; i++) {
        if (tokens[i].isCode) {
            stats.codeTokens += 1;
        }
        if (tokens[i].type == 'line_comment' || tokens[i].type == 'block_comment') {
            stats.commentTokens += 1;
        }
        if (tokens[i].type == 'string_literal') {
            stats.stringLiterals += 1;
        }
        if (tokens[i].type == 'quoted_identifier') {
            stats.quotedIdentifiers += 1;
        }
    }

    return {
        document: document,
        stats: stats
    };
}

function structure_counts(document, options) {
    var nodes;
    var structure = {
        SELECT: 0,
        JOIN: 0,
        CASE: 0,
        WINDOW: 0,
        CTE: 0,
        SUBQUERY: 0
    };

    try {
        document.scopes = sqlScopeModel.build(document, options || {});
        nodes = sqlFormatNodes.extract(document, options || {});
        structure.CASE = nodes && nodes.caseExpressions ? nodes.caseExpressions.length : 0;
        structure.SUBQUERY = count_subquery(document);
    } catch (error) {
        nodes = null;
    }

    structure.SELECT = count_word(document.tokens, 'SELECT');
    structure.JOIN = count_word(document.tokens, 'JOIN');
    structure.WINDOW = count_word(document.tokens, 'OVER');
    structure.CTE = count_word(document.tokens, 'WITH') + count_word_pair(document.tokens, 'WITH', 'RECURSIVE');

    return structure;
}

function safe_number(value) {
    return typeof value == 'number' && isFinite(value) ? value : 0;
}

function safe_integer(value) {
    var number = safe_number(value);
    return number < 0 ? 0 : Math.floor(number);
}

function safe_identifier(value) {
    var text = String(value || 'unknown').replace(/[^A-Za-z0-9_:-]+/g, '_').replace(/^_+|_+$/g, '');
    return text || 'unknown';
}

function safe_label(value) {
    var label = safe_identifier(value).toUpperCase();
    return SAFE_LABELS[label] ? label : '';
}

function safe_source(value) {
    var source = safe_identifier(value).toLowerCase();
    return SAFE_SOURCES[source] ? source : '';
}

function safe_diagnostic_code(value) {
    var code = safe_identifier(value).toLowerCase();
    return SAFE_DIAGNOSTIC_CODES[code] ? code : 'unknown';
}

function safe_telemetry_phase(value) {
    var phase = safe_identifier(value).toLowerCase();
    return SAFE_TELEMETRY_PHASES[phase] ? phase : 'unknown';
}

function safe_telemetry_status(value) {
    var status = safe_identifier(value).toLowerCase();
    return SAFE_TELEMETRY_STATUSES[status] ? status : 'unknown';
}

function safe_report_phase(value) {
    var phase = safe_identifier(value).toLowerCase();
    return SAFE_REPORT_PHASES[phase] ? phase : 'unknown';
}

function safe_dialect(value) {
    var dialect = safe_identifier(value).toLowerCase();
    return SAFE_DIALECTS[dialect] ? dialect : 'unknown';
}

function safe_unsupported_policy(value) {
    var policy = safe_identifier(value).toLowerCase();
    return SAFE_UNSUPPORTED_POLICIES[policy] ? policy : 'unknown';
}

function safe_extension_version(value) {
    var version = String(value || '');
    if (/^\d+\.\d+\.\d+$/.test(version)) {
        return version;
    }
    return 'unknown';
}

function safe_report_version(value) {
    return safe_integer(value) || REPORT_VERSION;
}

function normalize_input_stats(stats) {
    var source = stats || {};
    return {
        chars: safe_integer(source.chars),
        lines: safe_integer(source.lines),
        tokens: safe_integer(source.tokens),
        codeTokens: safe_integer(source.codeTokens),
        commentTokens: safe_integer(source.commentTokens),
        stringLiterals: safe_integer(source.stringLiterals),
        quotedIdentifiers: safe_integer(source.quotedIdentifiers)
    };
}

function normalize_structure(structure) {
    var source = structure || {};
    return {
        SELECT: safe_integer(source.SELECT),
        JOIN: safe_integer(source.JOIN),
        CASE: safe_integer(source.CASE),
        WINDOW: safe_integer(source.WINDOW),
        CTE: safe_integer(source.CTE),
        SUBQUERY: safe_integer(source.SUBQUERY)
    };
}

function normalize_phase(phase) {
    return {
        name: safe_telemetry_phase(phase && phase.name),
        ms: safe_number(phase && phase.ms),
        status: safe_telemetry_status(phase && phase.status)
    };
}

function normalize_telemetry(telemetry) {
    var source = telemetry || {};
    var phases = [];
    var i;

    for (i = 0; i < (source.phases || []).length; i++) {
        phases.push(normalize_phase(source.phases[i]));
    }

    return {
        totalMs: safe_number(source.totalMs),
        phases: phases
    };
}

function normalize_diagnostic_summary(diagnostic) {
    return {
        code: safe_diagnostic_code(diagnostic && diagnostic.code),
        labels: unique_sorted((diagnostic && diagnostic.labels || []).map(safe_label)),
        sources: unique_sorted((diagnostic && diagnostic.sources || []).map(safe_source)),
        count: safe_integer(diagnostic && diagnostic.count)
    };
}

function normalize_diagnostics(diagnostics) {
    var output = [];
    var items = diagnostics || [];
    var i;
    var j;
    var segments;
    var labels;
    var sources;
    var label;
    var source;

    for (i = 0; i < items.length; i++) {
        segments = items[i] && items[i].unsupportedSegments ? items[i].unsupportedSegments : [];
        labels = [];
        sources = [];

        for (j = 0; j < segments.length; j++) {
            label = safe_label(segments[j] && segments[j].label);
            source = safe_source(segments[j] && segments[j].source);
            if (label) {
                labels.push(label);
            }
            if (source) {
                sources.push(source);
            }
        }

        output.push({
            code: safe_diagnostic_code(items[i] && items[i].code),
            labels: unique_sorted(labels),
            sources: unique_sorted(sources),
            count: segments.length
        });
    }

    return output;
}

function normalize_diagnostic_summaries(diagnostics) {
    var output = [];
    var items = diagnostics || [];
    var i;

    for (i = 0; i < items.length; i++) {
        output.push(normalize_diagnostic_summary(items[i]));
    }

    return output;
}

function error_message(error) {
    return error && error.message ? String(error.message) : String(error || '');
}

function normalize_classification(value) {
    var normalized = String(value || 'unknown');
    return CLASSIFICATIONS[normalized] ? normalized : 'unknown';
}

function has_unsupported_diagnostic(diagnostics) {
    var i;

    for (i = 0; i < (diagnostics || []).length; i++) {
        if (diagnostics[i] && diagnostics[i].code == 'unsupported_syntax') {
            return true;
        }
    }

    return false;
}

function result_from_input(source) {
    if (source && source.result) {
        return source.result;
    }
    return source || {};
}

function classify_result(input) {
    var source = input || {};
    var result = result_from_input(source);
    var diagnostics = result.diagnostics || source.diagnostics || [];
    var telemetry = result.telemetry || source.telemetry;
    var threshold = typeof source.slowThresholdMs == 'number' ? source.slowThresholdMs : DEFAULT_SLOW_THRESHOLD_MS;
    var message;

    if (source.failureType) {
        return normalize_classification(source.failureType);
    }

    if (has_unsupported_diagnostic(diagnostics)) {
        return 'unsupported_syntax';
    }

    if (source.error || result.error) {
        message = error_message(source.error || result.error);
        if (/Unsupported SQL fragment/i.test(message)) {
            return 'unsupported_syntax';
        }
        if (/invariant|assert/i.test(message)) {
            return 'invariant_violation';
        }
        return 'formatter_throw';
    }

    if (telemetry && typeof telemetry.totalMs == 'number' && telemetry.totalMs > threshold) {
        return 'slow_format';
    }

    if (result && (typeof result.text != 'undefined' || result.diagnostics || result.telemetry)) {
        return 'ok';
    }

    return 'unknown';
}

function build_reproduction_hints(structure) {
    return [
        'Build an anonymized SQL with roughly '
            + (structure.CTE || 0) + ' CTEs, '
            + (structure.JOIN || 0) + ' JOINs, '
            + (structure.CASE || 0) + ' CASE expressions, and '
            + (structure.WINDOW || 0) + ' window expressions.'
    ];
}

function create_report(input) {
    var source = input || {};
    var options = source.options || {};
    var result = source.result || {};
    var statsResult = input_stats(source.text || '', options);
    var report = {
        extensionVersion: safe_extension_version(source.extensionVersion),
        reportVersion: REPORT_VERSION,
        phase: safe_report_phase(source.phase),
        classification: classify_result(source),
        dialect: safe_dialect(options.dialect || 'generic'),
        unsupportedSyntaxPolicy: safe_unsupported_policy(options.unsupportedSyntaxPolicy || 'preserve'),
        input: statsResult.stats,
        structure: structure_counts(statsResult.document, options),
        diagnostics: normalize_diagnostics(result.diagnostics || source.diagnostics),
        telemetry: normalize_telemetry(result.telemetry || source.telemetry),
        reproductionHints: []
    };

    report.reproductionHints = build_reproduction_hints(report.structure);
    return report;
}

function normalize_report(report) {
    var source = report || {};
    var structure = normalize_structure(source.structure);
    return {
        extensionVersion: safe_extension_version(source.extensionVersion),
        reportVersion: safe_report_version(source.reportVersion),
        phase: safe_report_phase(source.phase),
        classification: normalize_classification(source.classification),
        dialect: safe_dialect(source.dialect),
        unsupportedSyntaxPolicy: safe_unsupported_policy(source.unsupportedSyntaxPolicy),
        input: normalize_input_stats(source.input),
        structure: structure,
        diagnostics: normalize_diagnostic_summaries(source.diagnostics),
        telemetry: normalize_telemetry(source.telemetry),
        reproductionHints: build_reproduction_hints(structure)
    };
}

function render_object_lines(lines, prefix, object) {
    own_keys(object).forEach(function(key) {
        lines.push(prefix + '- ' + key + ': ' + object[key]);
    });
}

function render_markdown(report) {
    var safeReport = normalize_report(report);
    var lines = [
        '# SQL Beautify Safe Diagnostic Report',
        '',
        '- extensionVersion: ' + safeReport.extensionVersion,
        '- reportVersion: ' + safeReport.reportVersion,
        '- phase: ' + safeReport.phase,
        '- classification: ' + safeReport.classification,
        '- dialect: ' + safeReport.dialect,
        '- unsupportedSyntaxPolicy: ' + safeReport.unsupportedSyntaxPolicy,
        '- input:'
    ];

    render_object_lines(lines, '  ', safeReport.input || {});
    lines.push('- structure:');
    render_object_lines(lines, '  ', safeReport.structure || {});
    lines.push('- diagnostics:');
    (safeReport.diagnostics || []).forEach(function(item) {
        lines.push('  - code: ' + item.code);
        lines.push('    labels: ' + item.labels.join(', '));
        lines.push('    sources: ' + item.sources.join(', '));
        lines.push('    count: ' + item.count);
    });
    if ((safeReport.diagnostics || []).length == 0) {
        lines.push('  - none');
    }
    lines.push('- telemetry:');
    lines.push('  - totalMs: ' + ((safeReport.telemetry && safeReport.telemetry.totalMs) || 0));
    lines.push('  - phases:');
    (safeReport.telemetry && safeReport.telemetry.phases || []).forEach(function(phase) {
        lines.push('    - ' + phase.name + ': ' + phase.ms + ' (' + phase.status + ')');
    });
    if (!safeReport.telemetry || safeReport.telemetry.phases.length == 0) {
        lines.push('    - none');
    }
    lines.push('- reproductionHints:');
    (safeReport.reproductionHints || []).forEach(function(hint) {
        lines.push('  - ' + hint);
    });

    return lines.join('\n') + '\n';
}

function assert_absent(text, value) {
    if (text.indexOf(value) >= 0) {
        throw new Error('safe diagnostic report leaked forbidden value: ' + value);
    }
}

function assert_report_safe(reportText, forbiddenValues) {
    var text = String(reportText || '');
    var values = forbiddenValues || [];
    var i;
    var value;

    for (i = 0; i < values.length; i++) {
        value = String(values[i] || '');
        if (!value) {
            continue;
        }
        assert_absent(text, value);
    }
}

exports.create_report = create_report;
exports.render_markdown = render_markdown;
exports.classify_result = classify_result;
exports.assert_report_safe = assert_report_safe;
