var sqlDialect = require('./sql-dialect');

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

function has_value(value) {
    return typeof value !== 'undefined' && value !== null;
}

function is_canonical_input(raw, explicit) {
    return explicit.canonical === true;
}

function normalize_keyword_case(raw, explicit) {
    if (is_canonical_input(raw, explicit) && (raw.keywordCase === 'lower' || raw.keywordCase === 'upper')) {
        return raw.keywordCase;
    }
    if (explicit.sqlKeywordCase) {
        return raw.sqlKeywordCase === 'lower' ? 'lower' : 'upper';
    }
    if (explicit.keywordCase) {
        return raw.keywordCase === 'lower' ? 'lower' : 'upper';
    }
    return raw.uppercase === false ? 'lower' : 'upper';
}

function normalize_comma_style(raw, explicit) {
    if (is_canonical_input(raw, explicit) && (raw.commaStyle === 'leading' || raw.commaStyle === 'trailing')) {
        return raw.commaStyle;
    }
    if (explicit.sqlCommaStyle) {
        return raw.sqlCommaStyle === 'trailing' ? 'trailing' : 'leading';
    }
    if (explicit.commaStyle) {
        return raw.commaStyle === 'trailing' ? 'trailing' : 'leading';
    }
    return raw.comma_location === true ? 'trailing' : 'leading';
}

function normalize_indent_style(raw, explicit) {
    if (is_canonical_input(raw, explicit) && (raw.indentStyle === 'tab' || raw.indentStyle === 'space')) {
        return raw.indentStyle;
    }
    if (explicit.sqlIndentStyle) {
        return raw.sqlIndentStyle === 'space' ? 'space' : 'tab';
    }
    if (explicit.indentStyle) {
        return raw.indentStyle === 'space' ? 'space' : 'tab';
    }
    return raw.bracket_char === true ? 'space' : 'tab';
}

function normalize_language_mode(value) {
    return value === 'hive-sql' ? 'hive-sql' : 'sql';
}

function default_dialect_for_language_mode(language_mode) {
    return language_mode === 'hive-sql' ? 'hive' : 'generic';
}

function resolve_requested_dialect(raw, explicit) {
    if (is_canonical_input(raw, explicit) && has_value(raw.dialect)) {
        return raw.dialect;
    }
    if (explicit.sqlDialect) {
        return raw.sqlDialect;
    }
    if (explicit.dialect) {
        return raw.dialect;
    }
    return undefined;
}

function normalize(raw_options, explicit_options) {
    var raw = raw_options || {};
    var explicit = explicit_options || {};
    var align_width = is_canonical_input(raw, explicit)
        ? raw.maxAlignWidth
        : explicit.sqlMaxAlignWidth
        ? raw.sqlMaxAlignWidth
        : explicit.maxAlignWidth
            ? raw.maxAlignWidth
            : raw.as_loc_cnt;
    var wrap_length = is_canonical_input(raw, explicit)
        ? raw.caseWhenThenWrapLength
        : explicit.sqlCaseWhenThenWrapLength
        ? raw.sqlCaseWhenThenWrapLength
        : raw.case_when_then_wrap_length;
    var language_mode = normalize_language_mode(raw.languageMode || raw.documentLanguageId);
    var requested_dialect = resolve_requested_dialect(raw, explicit);

    return {
        keywordCase: normalize_keyword_case(raw, explicit),
        commaStyle: normalize_comma_style(raw, explicit),
        indentStyle: normalize_indent_style(raw, explicit),
        maxAlignWidth: normalize_number(align_width, 150, 1, 500),
        caseWhenThenWrapLength: normalize_number(wrap_length, 50, 1, 300),
        dialect: sqlDialect.normalize_dialect(
            has_value(requested_dialect)
                ? requested_dialect
                : default_dialect_for_language_mode(language_mode)
        ),
        languageMode: language_mode,
        unsupportedSyntaxPolicy: raw.unsupportedSyntaxPolicy || 'preserve'
    };
}

function to_legacy(options) {
    var normalized = normalize(options || {}, {
        canonical: true
    });

    return {
        uppercase: normalized.keywordCase !== 'lower',
        comma_location: normalized.commaStyle === 'trailing',
        bracket_char: normalized.indentStyle === 'space',
        as_loc_cnt: normalized.maxAlignWidth,
        case_when_then_wrap_length: normalized.caseWhenThenWrapLength,
        dialect: normalized.dialect
    };
}

exports.normalize = normalize;
exports.normalize_number = normalize_number;
exports.to_legacy = to_legacy;
exports.default_dialect_for_language_mode = default_dialect_for_language_mode;
exports.normalize_language_mode = normalize_language_mode;
