var sqlDialect = require('../core/sql-dialect');
var sqlCanonicalOptions = require('../core/sql-canonical-options');

function normalize_number(value, fallback, min, max) {
    return sqlCanonicalOptions.normalize_number(value, fallback, min, max);
}

function is_canonical_input(raw, explicit) {
    return explicit.canonical === true;
}

function normalize_keyword_case(raw, explicit) {
    if (is_canonical_input(raw, explicit) && (raw.keywordCase === 'lower' || raw.keywordCase === 'upper')) {
        return raw.keywordCase;
    }
    return raw.keywordCase === 'lower' ? 'lower' : 'upper';
}

function normalize_comma_style(raw, explicit) {
    if (is_canonical_input(raw, explicit) && (raw.commaStyle === 'leading' || raw.commaStyle === 'trailing')) {
        return raw.commaStyle;
    }
    return raw.commaStyle === 'trailing' ? 'trailing' : 'leading';
}

function normalize_indent_style(raw, explicit) {
    if (is_canonical_input(raw, explicit) && (raw.indentStyle === 'tab' || raw.indentStyle === 'space')) {
        return raw.indentStyle;
    }
    return raw.indentStyle === 'space' ? 'space' : 'tab';
}

function normalize_language_mode(value) {
    return sqlCanonicalOptions.normalize_language_mode(value);
}

function default_dialect_for_language_mode(language_mode) {
    return sqlCanonicalOptions.default_dialect_for_language_mode(language_mode);
}

function resolve_requested_dialect(raw, explicit) {
    if (is_canonical_input(raw, explicit) && typeof raw.dialect !== 'undefined' && raw.dialect !== null) {
        return raw.dialect;
    }
    if (explicit.dialect) {
        return raw.dialect;
    }
    return undefined;
}

function resolve_unsupported_policy(raw, explicit) {
    if (is_canonical_input(raw, explicit) && typeof raw.unsupportedSyntaxPolicy !== 'undefined' && raw.unsupportedSyntaxPolicy !== null) {
        return raw.unsupportedSyntaxPolicy;
    }
    if (explicit.unsupportedSyntaxPolicy) {
        return raw.unsupportedSyntaxPolicy;
    }
    return undefined;
}

function normalize(raw_options, explicit_options) {
    var raw = raw_options || {};
    var explicit = explicit_options || {};
    var align_width = is_canonical_input(raw, explicit)
        ? raw.maxAlignWidth
        : explicit.maxAlignWidth
            ? raw.maxAlignWidth
            : raw.maxAlignWidth;
    var wrap_length = is_canonical_input(raw, explicit)
        ? raw.caseWhenThenWrapLength
        : explicit.caseWhenThenWrapLength
            ? raw.caseWhenThenWrapLength
            : raw.caseWhenThenWrapLength;
    var language_mode = normalize_language_mode(raw.languageMode || raw.documentLanguageId);
    var requested_dialect = resolve_requested_dialect(raw, explicit);

    return sqlCanonicalOptions.normalize({
        keywordCase: normalize_keyword_case(raw, explicit),
        commaStyle: normalize_comma_style(raw, explicit),
        indentStyle: normalize_indent_style(raw, explicit),
        maxAlignWidth: normalize_number(align_width, 150, 1, 500),
        caseWhenThenWrapLength: normalize_number(wrap_length, 50, 1, 300),
        dialect: sqlDialect.normalize_dialect(
            typeof requested_dialect !== 'undefined' && requested_dialect !== null
                ? requested_dialect
                : default_dialect_for_language_mode(language_mode)
        ),
        languageMode: language_mode,
        unsupportedSyntaxPolicy: resolve_unsupported_policy(raw, explicit)
    });
}

exports.normalize = normalize;
exports.normalize_number = normalize_number;
exports.default_dialect_for_language_mode = default_dialect_for_language_mode;
exports.normalize_language_mode = normalize_language_mode;
