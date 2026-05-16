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

function normalize(raw_options, explicit_options) {
    var raw = raw_options || {};
    var explicit = explicit_options || {};
    var align_width = explicit.sqlMaxAlignWidth
        ? raw.sqlMaxAlignWidth
        : explicit.maxAlignWidth
            ? raw.maxAlignWidth
            : raw.as_loc_cnt;
    var wrap_length = explicit.sqlCaseWhenThenWrapLength
        ? raw.sqlCaseWhenThenWrapLength
        : raw.case_when_then_wrap_length;

    return {
        uppercase: explicit.sqlKeywordCase
            ? raw.sqlKeywordCase !== 'lower'
            : explicit.keywordCase
                ? raw.keywordCase !== 'lower'
                : raw.uppercase !== false,
        comma_location: explicit.sqlCommaStyle
            ? raw.sqlCommaStyle === 'trailing'
            : explicit.commaStyle
                ? raw.commaStyle === 'trailing'
                : raw.comma_location === true,
        bracket_char: explicit.sqlIndentStyle
            ? raw.sqlIndentStyle === 'space'
            : explicit.indentStyle
                ? raw.indentStyle === 'space'
                : raw.bracket_char === true,
        as_loc_cnt: normalize_number(align_width, 150, 1, 500),
        case_when_then_wrap_length: normalize_number(wrap_length, 50, 1, 300),
        dialect: explicit.sqlDialect ? raw.sqlDialect : 'generic'
    };
}

exports.normalize = normalize;
exports.normalize_number = normalize_number;
