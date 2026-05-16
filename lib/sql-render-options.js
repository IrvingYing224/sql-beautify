function normalize(raw_options, explicit_options) {
    var raw = raw_options || {};
    var explicit = explicit_options || {};

    return {
        uppercase: explicit.keywordCase ? raw.keywordCase !== 'lower' : raw.uppercase,
        comma_location: explicit.commaStyle ? raw.commaStyle === 'trailing' : raw.comma_location,
        bracket_char: explicit.indentStyle ? raw.indentStyle === 'space' : raw.bracket_char,
        as_loc_cnt: explicit.maxAlignWidth ? raw.maxAlignWidth : raw.as_loc_cnt,
        case_when_then_wrap_length: raw.case_when_then_wrap_length
    };
}

exports.normalize = normalize;
