var sqlShield = require('./sql-shield');
var sqlKeywords = require('./sql-keywords');
var sqlFormatPipeline = require('./sql-format-pipeline');
var sqlFormatContext = require('./sql-format-context');
var sqlDialect = require('./sql-dialect');
var sqlNormalizePasses = require('./sql-normalize-passes');
var sqlCommentFormatter = require('./sql-comment-formatter');
var sqlCaseFormatter = require('./sql-case-formatter');
var sqlSelectFormatter = require('./sql-select-formatter');
var sqlConditionFormatter = require('./sql-condition-formatter');

function format_sql(text, options) {
    var config = options || {};
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

    var step7 = sqlFormatPipeline.run(step0, [
        sqlCommentFormatter.reshape_comment,
        sqlNormalizePasses.replace_char,
        sqlNormalizePasses.get_bracket,
        function(value) {
            return sqlSelectFormatter.except_subquery(value)
                .replace(/\{\.\*\.\*\}/ig, "(")
                .replace(/\{\*\.\*\.\}/ig, ")");
        },
        function(value) {
            return sqlSelectFormatter.special_wrap(
                value,
                config.as_loc_cnt,
                config.case_when_then_wrap_length
            );
        },
        sqlNormalizePasses.bracket_deep,
        sqlNormalizePasses.extra
    ]);

    var currentStep = sqlCommentFormatter.restore_comments(step7, context);
    currentStep = sqlNormalizePasses.restore_set_payloads(currentStep, context);
    currentStep = sqlShield.preserve_standalone_block_lines(currentStep, token_shield.items);
    currentStep = sqlShield.restore(currentStep, token_shield.tokens, token_shield.items);
    currentStep = sqlCaseFormatter.format_case_blocks(currentStep, config.case_when_then_wrap_length);
    currentStep = sqlSelectFormatter.align_as_in_select_blocks(currentStep, config.as_loc_cnt);

    currentStep = sqlKeywords.apply_keyword_case(currentStep, config.uppercase !== false, dialect);

    if (config.comma_location === true) {
        currentStep = sqlSelectFormatter.convert_comma_loaction(currentStep);
    }

    currentStep = sqlConditionFormatter.align_condition_clauses(currentStep);
    currentStep = sqlCommentFormatter.order_comment(currentStep, config.as_loc_cnt);

    if (config.bracket_char === true) {
        currentStep = currentStep.replace(/\t/ig, "    ");
    }

    return sqlCommentFormatter.normalize_line_comment_spacing(currentStep);
}

exports.format_sql = format_sql;
