var sqlShield = require('./sql-shield');
var sqlKeywords = require('./sql-keywords');
var sqlFormatPipeline = require('./sql-format-pipeline');
var sqlFormatContext = require('./sql-format-context');
var sqlDialect = require('./sql-dialect');
var sqlCanonicalOptions = require('./sql-canonical-options');
var sqlLexicalNormalizer = require('./sql-lexical-normalizer');
var sqlClauseSplitter = require('./sql-clause-splitter');
var sqlNormalizePasses = require('./sql-normalize-passes');
var sqlLayoutFormatter = require('./sql-layout-formatter');
var sqlCommentFormatter = require('./sql-comment-formatter');
var sqlCaseFormatter = require('./sql-case-formatter');
var sqlSelectFormatter = require('./sql-select-formatter');
var sqlConditionFormatter = require('./sql-condition-formatter');
var sqlUnsupportedPolicy = require('./sql-unsupported-policy');

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
            message: 'Unsupported SQL fragments were preserved without reformatting.',
            unsupportedSegments: (context.unsupportedSegments || []).slice()
        });
    }

    return diagnostics;
}

function format_sql_detailed(text, options) {
    var config = sqlCanonicalOptions.normalize(options || {});
    var context = sqlFormatContext.create_context(text);
    var dialect = sqlDialect.get_capabilities(config.dialect);
    var set_shield = sqlNormalizePasses.protect_set_payloads(text, context, dialect);
    var token_shield = sqlShield.protect(set_shield.text, {
        line_comment: false,
        tokenizerOptions: dialect
    });
    var step0 = token_shield.text;
    var comment_shield = sqlCommentFormatter.protect_standalone_comments(step0, context, dialect);
    step0 = sqlCommentFormatter.protect_inline_comments(comment_shield.text, context, dialect);
    step0 = sqlClauseSplitter.protect_opaque_segments(step0, config.dialect, context);
    sqlUnsupportedPolicy.enforce_policy(context, config.unsupportedSyntaxPolicy);

    var step7 = sqlFormatPipeline.run(step0, [
        function(value) {
            return sqlLexicalNormalizer.normalize(value, config.dialect);
        },
        function(value) {
            return sqlClauseSplitter.split_clauses(value, config.dialect, context);
        },
        function(value) {
            return sqlSelectFormatter.format_select_clause_lists(value, dialect);
        },
        function(value) {
            return sqlConditionFormatter.wrap_condition_clauses(value, dialect);
        },
        function(value) {
            return sqlLayoutFormatter.indent_nested_blocks(value, {
                indentStyle: config.indentStyle,
                tokenizerOptions: dialect
            });
        },
        function(value) {
            return sqlLayoutFormatter.cleanup_layout_markers(value, dialect);
        }
    ]);

    var currentStep = sqlCommentFormatter.restore_comments(step7, context);
    currentStep = sqlNormalizePasses.restore_set_payloads(currentStep, context);
    currentStep = sqlShield.preserve_standalone_block_lines(currentStep, token_shield.items);
    currentStep = sqlShield.restore(currentStep, token_shield.tokens, token_shield.items);
    currentStep = sqlSelectFormatter.repair_orphan_leading_commas(currentStep, dialect);
    currentStep = sqlCaseFormatter.format_case_blocks(currentStep, config.caseWhenThenWrapLength, dialect);
    currentStep = sqlSelectFormatter.align_as_in_select_blocks(currentStep, config.maxAlignWidth, config.dialect);
    currentStep = sqlConditionFormatter.align_condition_clauses(currentStep, config.dialect);

    currentStep = sqlKeywords.apply_keyword_case(currentStep, config.keywordCase !== 'lower', dialect);

    if (config.commaStyle === 'trailing') {
        currentStep = sqlSelectFormatter.apply_trailing_comma_style(currentStep, dialect);
    }

    currentStep = sqlCommentFormatter.order_comment(currentStep, config.maxAlignWidth, dialect);

    currentStep = sqlClauseSplitter.restore_opaque_segments(currentStep, context);
    currentStep = restore_user_blank_lines(text, currentStep, config.dialect);

    return {
        text: normalize_output_whitespace(sqlCommentFormatter.normalize_line_comment_spacing(currentStep, dialect)),
        diagnostics: collect_runtime_diagnostics(context, config)
    };
}

function format_sql(text, options) {
    return format_sql_detailed(text, options).text;
}

exports.format_sql = format_sql;
exports.format_sql_detailed = format_sql_detailed;
