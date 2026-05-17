var sqlDialect = require('./sql-dialect');
var sqlUnsupportedPolicy = require('./sql-unsupported-policy');

function normalize_number(value, fallback, min, max) {
    var parsed = parseInt(value, 10);
    if (isNaN(parsed)) {
        parsed = fallback;
    }
    if (parsed < min) {
        return min;
    }
    if (parsed > max) {
        return max;
    }
    return parsed;
}

function normalize_keyword_case(value) {
    return value === 'lower' ? 'lower' : 'upper';
}

function normalize_comma_style(value) {
    return value === 'trailing' ? 'trailing' : 'leading';
}

function normalize_indent_style(value) {
    return value === 'tab' ? 'tab' : 'space';
}

function normalize_language_mode(value) {
    return value === 'hive-sql' ? 'hive-sql' : 'sql';
}

function default_dialect_for_language_mode() {
    return 'hive';
}

function normalize(options) {
    var raw = options || {};
    var languageMode = normalize_language_mode(raw.languageMode || raw.documentLanguageId);
    var dialect = typeof raw.dialect !== 'undefined'
        ? raw.dialect
        : default_dialect_for_language_mode(languageMode);

    return {
        keywordCase: normalize_keyword_case(raw.keywordCase),
        commaStyle: normalize_comma_style(raw.commaStyle),
        indentStyle: normalize_indent_style(raw.indentStyle),
        maxAlignWidth: normalize_number(raw.maxAlignWidth, 150, 1, 500),
        caseWhenThenWrapLength: normalize_number(raw.caseWhenThenWrapLength, 50, 1, 300),
        dialect: sqlDialect.normalize_dialect(dialect),
        languageMode: languageMode,
        unsupportedSyntaxPolicy: sqlUnsupportedPolicy.normalize_policy(raw.unsupportedSyntaxPolicy)
    };
}

exports.normalize = normalize;
exports.normalize_number = normalize_number;
exports.default_dialect_for_language_mode = default_dialect_for_language_mode;
exports.normalize_language_mode = normalize_language_mode;
