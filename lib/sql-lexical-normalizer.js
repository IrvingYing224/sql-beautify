var sqlTokenizer = require('./sql-tokenizer');
var sqlOperatorRegistry = require('./sql-operator-registry');
var PRESERVED_LINE_COMMENT_NEWLINE = '__SQLBEAUTIFY_PRESERVE_LINE_COMMENT_NEWLINE__';

function preserve_line_comment_newlines(text) {
    return String(text || '').replace(
        /(--\{SQLBEAUTIFY_[^}]+\}(?:shouldhavenbehind)?)(\r\n|\n|\r)/g,
        '$1' + PRESERVED_LINE_COMMENT_NEWLINE
    );
}

function normalize_operator_spacing(text, dialect) {
    var tokens = sqlTokenizer.tokenize(text);
    var operator_lookup = sqlOperatorRegistry.get_operator_lookup(dialect || 'generic');
    var result = '';
    var i = 0;

    while (i < tokens.length) {
        if (tokens[i].type != 'operator') {
            result += tokens[i].value;
            i += 1;
            continue;
        }

        var merged = tokens[i].value;
        var next_index = i + 1;

        while (next_index + 1 < tokens.length
            && tokens[next_index].type == 'whitespace'
            && tokens[next_index + 1].type == 'operator'
            && sqlOperatorRegistry.is_registered_operator(
                merged + tokens[next_index + 1].value,
                dialect || 'generic'
            )) {
            merged += tokens[next_index + 1].value;
            next_index += 2;
        }

        if (sqlOperatorRegistry.is_registered_operator(merged, dialect || 'generic')) {
            var operator = operator_lookup[merged];
            if (operator.spacing == 'none') {
                result = result.replace(/[ \t]+$/g, '');
                result += merged;
            } else {
                result = result.replace(/[ \t]+$/g, '') + ' ' + merged + ' ';
            }
            i = next_index;
            while (i < tokens.length && tokens[i].type == 'whitespace') {
                i += 1;
            }
            continue;
        }

        result += tokens[i].value;
        i += 1;
    }

    return result;
}

function should_keep_space_before(result, token, had_space) {
    if (!had_space || result === '') {
        return false;
    }

    if (token.type == 'punctuation') {
        if (token.value == ')') {
            return true;
        }
        return token.value == '(';
    }

    if (token.type == 'operator') {
        return true;
    }

    if (/\($/.test(result)) {
        return true;
    }

    return !/[\s.]$/.test(result);
}

function collapse_whitespace(text) {
    var tokens = sqlTokenizer.tokenize(text);
    var result = '';
    var had_space = false;
    var had_newline = false;

    for (var i = 0; i < tokens.length; i++) {
        var token = tokens[i];

        if (token.type == 'whitespace' || token.type == 'newline') {
            had_space = true;
            if (token.type == 'newline') {
                had_newline = true;
            }
            continue;
        }

        if (token.type == 'punctuation' && token.value == ';' && had_newline) {
            result = result.replace(/[ \t]+$/g, '');
            if (!/\n$/.test(result)) {
                result += '\n';
            }
            had_space = false;
        }

        if (should_keep_space_before(result, token, had_space)) {
            result += ' ';
        }

        if (token.type == 'punctuation' && token.value == '.') {
            result = result.replace(/[ \t]+$/g, '');
        }

        result += token.value;
        had_space = false;
        had_newline = false;
    }

    return result;
}

function normalize(text, dialect) {
    var normalized = preserve_line_comment_newlines(text);
    normalized = normalize_operator_spacing(normalized, dialect || 'generic');
    normalized = collapse_whitespace(normalized);
    normalized = normalized.replace(/\s*__SQLBEAUTIFY_PRESERVE_LINE_COMMENT_NEWLINE__\s*/g, '\n');

    return normalized
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n[ \t]+/g, '\n')
        .replace(/\n{3,}/g, '\n\n');
}

exports.normalize = normalize;
