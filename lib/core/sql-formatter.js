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
var sqlSyntaxRiskDetector = require('./sql-syntax-risk-detector');
var sqlFormatDocument = require('./sql-format-document');
var sqlScopeModel = require('./sql-scope-model');
var sqlFormatNavigation = require('./sql-format-navigation');
var sqlFormatNodes = require('./sql-format-nodes');
var sqlFormatMutations = require('./sql-format-mutations');
var sqlFormatInvariants = require('./sql-format-invariants');
var sqlStructuredRenderer = require('./sql-structured-renderer');

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
        diagnostics.push({
            level: 'warning',
            code: 'unsupported_syntax',
            message: 'Unsupported or low-confidence SQL syntax was detected; protected opaque fragments were preserved where applicable.',
            unsupportedSegments: (context.unsupportedSegments || []).slice()
        });
    }

    return diagnostics;
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
	protectedText = sqlClauseSplitter.protect_opaque_segments(protectedText, config.dialect, context);
	return protectedText;
}

function restore_structured_output(text, context) {
	var restored = sqlClauseSplitter.restore_opaque_segments(text, context);
	return sqlNormalizePasses.restore_set_payloads(restored, context);
}

function format_sql_structured_detailed(originalText, protectedText, config, dialect, context) {
	var document = sqlFormatDocument.from_text(protectedText, config);
	document.scopes = sqlScopeModel.build(document, config);
	sqlFormatNavigation.attach_scope_index(document);
	var nodes = sqlFormatNodes.extract(document, config);
	document.nodes = nodes;
	sqlFormatInvariants.assert_document_safe(document, nodes);

	var mutations = sqlFormatMutations.create();
	add_initial_structured_mutations(document, nodes, mutations, config);
	sqlFormatInvariants.assert_mutation_plan_safe(document, nodes, mutations);

	var rendered = sqlStructuredRenderer.render(document, nodes, mutations, config);
	rendered = restore_user_blank_lines(originalText, rendered, config.dialect);
	rendered = sqlCommentSpacing.normalize_line_comment_spacing(rendered, dialect);
	rendered = restore_structured_output(rendered, context);

	return {
		text: normalize_output_whitespace(rendered),
		diagnostics: collect_runtime_diagnostics(context, config)
	};
}

function format_sql_detailed(text, options) {
    var config = sqlCanonicalOptions.normalize(options || {});
    var context = sqlFormatContext.create_context(text);
    var dialect = sqlDialect.get_capabilities(config.dialect);
    var riskSegments = sqlSyntaxRiskDetector.detect(text, dialect);
    for (var r = 0; r < riskSegments.length; r++) {
        sqlUnsupportedPolicy.note_unsupported(context, riskSegments[r].kind, riskSegments[r].text);
    }
    var protectedText = protect_structured_input(text, config, dialect, context);
    sqlUnsupportedPolicy.enforce_policy(context, config.unsupportedSyntaxPolicy);

    return format_sql_structured_detailed(text, protectedText, config, dialect, context);
}

function format_sql(text, options) {
    return format_sql_detailed(text, options).text;
}

exports.format_sql = format_sql;
exports.format_sql_detailed = format_sql_detailed;
