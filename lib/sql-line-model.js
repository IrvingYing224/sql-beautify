var tokenizer = require('./sql-tokenizer');

function split_code_and_comment(text) {
    var tokens = tokenizer.tokenize(text);

    for (var i = 0; i < tokens.length; i++) {
        if (tokens[i].type == 'line_comment') {
            return {
                code: text.slice(0, tokens[i].start).replace(/\s+$/g, ''),
                comment: text.slice(tokens[i].start).replace(/\s+$/g, ''),
                commentStart: tokens[i].start
            };
        }
    }

    return {
        code: text.replace(/\s+$/g, ''),
        comment: '',
        commentStart: -1
    };
}

function create_line(raw, index) {
    var parts = split_code_and_comment(raw);
    var code_trimmed = parts.code.replace(/^\s+|\s+$/g, '');
    var comment_trimmed = parts.comment.replace(/^\s+|\s+$/g, '');

    return {
        index: index,
        raw: raw,
        code: parts.code,
        comment: parts.comment,
        commentStart: parts.commentStart,
        isBlank: code_trimmed == '' && comment_trimmed == '',
        isStandaloneComment: code_trimmed == '' && /^--/.test(comment_trimmed),
        hasTrailingComment: code_trimmed != '' && /^--/.test(comment_trimmed)
    };
}

function from_text(text) {
    var raw_lines = String(text || '').split(/\r\n|\n|\r/);
    var lines = [];

    for (var i = 0; i < raw_lines.length; i++) {
        lines.push(create_line(raw_lines[i], i));
    }

    return lines;
}

function comment_body(comment) {
    return String(comment || '').replace(/^--\s*/, '').replace(/\s+$/g, '');
}

function normalize_comment_marker(comment) {
    return String(comment || '').replace(/^--([^\s\-\n])/, '-- $1');
}

function rebuild_line(code, comment) {
    var clean_code = String(code || '').replace(/\s+$/g, '');
    var clean_comment = normalize_comment_marker(String(comment || '').replace(/\s+$/g, ''));

    if (clean_comment == '') {
        return clean_code;
    }

    if (clean_code == '') {
        return clean_comment;
    }

    return clean_code + ' ' + clean_comment;
}

exports.split_code_and_comment = split_code_and_comment;
exports.from_text = from_text;
exports.comment_body = comment_body;
exports.normalize_comment_marker = normalize_comment_marker;
exports.rebuild_line = rebuild_line;
