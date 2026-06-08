var sqlKeywords = require('./sql-keywords');
var sqlFormatContext = require('./sql-format-context');
var sqlDialect = require('./sql-dialect');
var sqlCanonicalOptions = require('./sql-canonical-options');
var sqlClauseSplitter = require('./sql-clause-splitter');
var sqlNormalizePasses = require('./sql-normalize-passes');
var sqlLayoutFormatter = require('./sql-layout-formatter');
var sqlCommentSpacing = require('./sql-comment-spacing');
var sqlCommentMutations = require('./sql-comment-mutations');
var sqlCaseMutations = require('./sql-case-mutations');
var sqlSelectMutations = require('./sql-select-mutations');
var sqlConditionMutations = require('./sql-condition-mutations');
var sqlClauseFormatter = require('./sql-clause-formatter');
var sqlUnsupportedPolicy = require('./sql-unsupported-policy');
var sqlDiagnostics = require('./sql-diagnostics');
var sqlSyntaxRiskDetector = require('./sql-syntax-risk-detector');
var sqlFormatDocument = require('./sql-format-document');
var sqlScopeModel = require('./sql-scope-model');
var sqlFormatNavigation = require('./sql-format-navigation');
var sqlFormatNodes = require('./sql-format-nodes');
var sqlFormatMutations = require('./sql-format-mutations');
var sqlFormatInvariants = require('./sql-format-invariants');
var sqlStructuredRenderer = require('./sql-structured-renderer');
var sqlSafeDiagnosticReport = require('./sql-safe-diagnostic-report');

function normalize_line_endings(text) {
    return String(text || '').replace(/\r\n|\r/g, '\n');
}

function find_clause_name(line, dialect) {
    var trimmed = String(line || '').replace(/^\s+/g, '');
    var clauses = require('./sql-clause-registry').get_clauses(dialect || 'generic');

    for (var i = 0; i < clauses.length; i++) {
        var pattern = new RegExp('^' + clauses[i].keywords.join('\\s+') + '\\b', 'i');
        if (pattern.test(trimmed)) {
            return clauses[i].name;
        }
    }

    return '';
}

function collect_blank_line_clause_targets(source, dialect) {
    var lines = normalize_line_endings(source).split('\n');
    var targets = [];
    var previous_was_blank = false;

    for (var i = 0; i < lines.length; i++) {
        var trimmed = lines[i].replace(/^\s+|\s+$/g, '');
        if (trimmed == '') {
            previous_was_blank = true;
            continue;
        }

        if (previous_was_blank) {
            var clause_name = find_clause_name(lines[i], dialect);
            if (clause_name != '') {
                targets.push(clause_name);
            }
        }

        previous_was_blank = false;
    }

    return targets;
}

function restore_user_blank_lines(source, formatted, dialect) {
    var targets = collect_blank_line_clause_targets(source, dialect);
    if (targets.length == 0) {
        return formatted;
    }

    var lines = normalize_line_endings(formatted).replace(/\n+$/g, '').split('\n');
    var output = [];
    var targetIndex = 0;

    for (var i = 0; i < lines.length; i++) {
        var clause_name = find_clause_name(lines[i], dialect);
        if (targetIndex < targets.length
            && clause_name != ''
            && clause_name == targets[targetIndex]
            && output.length > 0
            && output[output.length - 1] != '') {
            output.push('');
            targetIndex += 1;
        }

        output.push(lines[i]);
    }

    return output.join('\n');
}

function normalize_output_whitespace(text) {
    var normalized = String(text || '')
        .replace(/\r\n|\r/g, '\n')
        .replace(/[ \t]+$/gm, '')
        .replace(/^\n+/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/\n+$/g, '');

    return normalized + '\n';
}

function collect_runtime_diagnostics(context, config) {
    var diagnostics = [];

    if (config.unsupportedSyntaxPolicy == 'warn' && sqlUnsupportedPolicy.has_unsupported(context)) {
        diagnostics = collect_unsupported_diagnostics(context);
    }

    return diagnostics;
}

function collect_unsupported_diagnostics(context) {
    if (!sqlUnsupportedPolicy.has_unsupported(context)) {
        return [];
    }

    return [
        sqlDiagnostics.create_unsupported_runtime_diagnostic(context.unsupportedSegments || [])
    ];
}

function now_ms() {
    return Date.now();
}

function create_telemetry() {
    return {
        startMs: now_ms(),
        phases: []
    };
}

function record_phase(telemetry, name, startedAt, status) {
    if (!telemetry) {
        return;
    }

    telemetry.phases.push({
        name: name,
        ms: now_ms() - startedAt,
        status: status || 'ok'
    });
}

function finish_telemetry(telemetry) {
    if (!telemetry) {
        return null;
    }

    return {
        totalMs: now_ms() - telemetry.startMs,
        phases: telemetry.phases.slice()
    };
}

function timed_phase(telemetry, name, callback) {
    var startedAt = now_ms();

    try {
        var result = callback();
        record_phase(telemetry, name, startedAt, 'ok');
        return result;
    } catch (error) {
        record_phase(telemetry, name, startedAt, 'error');
        throw error;
    }
}

function add_initial_structured_mutations(document, nodes, mutations, config) {
	sqlCaseMutations.apply_case_mutations(document, nodes, mutations, config);
	sqlSelectMutations.apply_select_list_mutations(document, nodes, mutations, config);
	sqlClauseFormatter.apply_clause_line_break_mutations(document, nodes, mutations, config);
	sqlConditionMutations.apply_condition_mutations(document, nodes, mutations, config);
	sqlLayoutFormatter.apply_scope_layout_mutations(document, nodes, mutations, config);
	sqlKeywords.apply_keyword_case_mutations(document, mutations, config.keywordCase !== 'lower', document.tokenizerOptions);
	sqlCommentMutations.apply_comment_alignment_mutations(document, nodes, mutations, config);
}

function protect_structured_input(text, config, dialect, context) {
	var protectedText = sqlNormalizePasses.protect_set_payloads(text, context, dialect).text;
	protectedText = sqlClauseSplitter.protect_opaque_segments(protectedText, config.dialect, context, {
		recordUnsupported: false
	});
	return protectedText;
}

function restore_structured_output(text, context) {
	var restored = sqlClauseSplitter.restore_opaque_segments(text, context);
	return sqlNormalizePasses.restore_set_payloads(restored, context);
}

function format_sql_structured_detailed(originalText, protectedText, config, dialect, context, telemetry) {
    var document = timed_phase(telemetry, 'format_document', function() {
        return sqlFormatDocument.from_text(protectedText, config);
    });
    timed_phase(telemetry, 'scope_model', function() {
        document.scopes = sqlScopeModel.build(document, config);
        sqlFormatNavigation.attach_scope_index(document);
    });
    var nodes = timed_phase(telemetry, 'format_nodes', function() {
        var extracted = sqlFormatNodes.extract(document, config);
        document.nodes = extracted;
        sqlFormatInvariants.assert_document_safe(document, extracted);
        return extracted;
    });

    var mutations = timed_phase(telemetry, 'mutation_plan', function() {
        var plan = sqlFormatMutations.create();
        add_initial_structured_mutations(document, nodes, plan, config);
        sqlFormatInvariants.assert_mutation_plan_safe(document, nodes, plan);
        return plan;
    });

    var rendered = timed_phase(telemetry, 'render', function() {
        var output = sqlStructuredRenderer.render(document, nodes, mutations, config);
        output = restore_user_blank_lines(originalText, output, config.dialect);
        return sqlCommentSpacing.normalize_line_comment_spacing(output, dialect);
    });
    var restored = timed_phase(telemetry, 'restore', function() {
        return restore_structured_output(rendered, context);
    });

    return {
        text: normalize_output_whitespace(restored),
        diagnostics: collect_runtime_diagnostics(context, config)
    };
}

function format_sql_detailed(text, options) {
    var rawOptions = options || {};
    var includeTelemetry = rawOptions.includeTelemetry === true;
    var telemetry = includeTelemetry ? create_telemetry() : null;
    var config = sqlCanonicalOptions.normalize(rawOptions);
    var context = sqlFormatContext.create_context(text);
    var dialect = sqlDialect.get_capabilities(config.dialect);
    var finalTelemetry;

    try {
        timed_phase(telemetry, 'syntax_risk_detection', function() {
            var riskSegments = sqlSyntaxRiskDetector.detect(text, dialect);
            for (var r = 0; r < riskSegments.length; r++) {
                sqlUnsupportedPolicy.note_unsupported(context, riskSegments[r].kind, riskSegments[r]);
            }
        });
        var protectedText = timed_phase(telemetry, 'protect_input', function() {
            return protect_structured_input(text, config, dialect, context);
        });
        sqlUnsupportedPolicy.enforce_policy(context, config.unsupportedSyntaxPolicy);

        var result = format_sql_structured_detailed(text, protectedText, config, dialect, context, telemetry);
        if (includeTelemetry) {
            finalTelemetry = finish_telemetry(telemetry);
            result.telemetry = finalTelemetry;
            result.safeReport = sqlSafeDiagnosticReport.create_report({
                text: text,
                phase: rawOptions.phase || 'core_format',
                options: config,
                result: result
            });
        }

        return result;
    } catch (error) {
        if (includeTelemetry) {
            finalTelemetry = finish_telemetry(telemetry);
            error.sqlBeautifyDiagnostics = collect_unsupported_diagnostics(context);
            error.sqlBeautifyTelemetry = finalTelemetry;
            error.sqlBeautifyClassification = sqlSafeDiagnosticReport.classify_result({
                error: error,
                result: {
                    telemetry: finalTelemetry,
                    diagnostics: error.sqlBeautifyDiagnostics
                }
            });
        }
        throw error;
    }
}

function format_sql(text, options) {
    return format_sql_detailed(text, options).text;
}

exports.format_sql = format_sql;
exports.format_sql_detailed = format_sql_detailed;
