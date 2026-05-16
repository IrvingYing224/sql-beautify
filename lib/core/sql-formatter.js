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

function format_sql(text, options) {
    var config = sqlCanonicalOptions.normalize(options || {});
    var context = sqlFormatContext.create_context(text);
    var dialect = sqlDialect.get_capabilities(config.dialect);
    var set_shield = sqlNormalizePasses.protect_set_payloads(text, context);
    var token_shield = sqlShield.protect(set_shield.text, {
        line_comment: false,
        tokenizerOptions: dialect
    });
    var step0 = token_shield.text;
    var comment_shield = sqlCommentFormatter.protect_standalone_comments(step0, context);
    step0 = sqlCommentFormatter.protect_inline_comments(comment_shield.text, context, dialect);
    step0 = sqlClauseSplitter.protect_opaque_segments(step0, config.dialect, context);

    var step7 = sqlFormatPipeline.run(step0, [
        function(value) {
            return sqlLexicalNormalizer.normalize(value, config.dialect);
        },
        function(value) {
            return sqlClauseSplitter.split_clauses(value, config.dialect, context);
        },
        function(value) {
            return sqlSelectFormatter.format_select_clause_lists(value);
        },
        function(value) {
            return sqlConditionFormatter.wrap_condition_clauses(value, config.dialect);
        },
        function(value) {
            return sqlLayoutFormatter.indent_nested_blocks(value, config);
        },
        function(value) {
            return sqlLayoutFormatter.cleanup_layout_markers(value, config.dialect);
        }
    ]);

    var currentStep = sqlCommentFormatter.restore_comments(step7, context);
    currentStep = sqlNormalizePasses.restore_set_payloads(currentStep, context);
    currentStep = sqlShield.preserve_standalone_block_lines(currentStep, token_shield.items);
    currentStep = sqlShield.restore(currentStep, token_shield.tokens, token_shield.items);
    currentStep = sqlSelectFormatter.repair_orphan_leading_commas(currentStep);
    currentStep = sqlCaseFormatter.format_case_blocks(currentStep, config.caseWhenThenWrapLength);
    currentStep = sqlSelectFormatter.align_as_in_select_blocks(currentStep, config.maxAlignWidth, config.dialect);
    currentStep = sqlConditionFormatter.align_condition_clauses(currentStep, config.dialect);

    currentStep = sqlKeywords.apply_keyword_case(currentStep, config.keywordCase !== 'lower', dialect);

    if (config.commaStyle === 'trailing') {
        currentStep = sqlSelectFormatter.apply_trailing_comma_style(currentStep);
    }

    currentStep = sqlCommentFormatter.order_comment(currentStep, config.maxAlignWidth);

    currentStep = sqlClauseSplitter.restore_opaque_segments(currentStep, context);

    return sqlCommentFormatter.normalize_line_comment_spacing(currentStep);
}

exports.format_sql = format_sql;
