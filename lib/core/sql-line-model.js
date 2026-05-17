var primitives = require('./sql-token-primitives');

function split_code_and_comment(text, tokenizerOptions) {
    return primitives.split_code_and_comment(text, tokenizerOptions);
}

function create_line(raw, index, tokenizerOptions) {
    var parts = split_code_and_comment(raw, tokenizerOptions);
    var code_trimmed = parts.code.replace(/^\s+|\s+$/g, '');
    var comment_trimmed = parts.comment.replace(/^\s+|\s+$/g, '');
    var is_line_comment = /^(--|#)/.test(comment_trimmed);

    return {
        index: index,
        raw: raw,
        code: parts.code,
        comment: parts.comment,
        commentStart: parts.commentStart,
        isBlank: code_trimmed == '' && comment_trimmed == '',
        isStandaloneComment: code_trimmed == '' && is_line_comment,
        hasTrailingComment: code_trimmed != '' && is_line_comment
    };
}

function from_text(text, tokenizerOptions) {
    var raw_lines = String(text || '').split(/\r\n|\n|\r/);
    var lines = [];

    for (var i = 0; i < raw_lines.length; i++) {
        lines.push(create_line(raw_lines[i], i, tokenizerOptions));
    }

    return lines;
}

function comment_body(comment) {
    var trimmed = String(comment || '').replace(/^\s+/g, '').replace(/\s+$/g, '');
    if (is_hive_hint_comment(trimmed)) {
        return trimmed.replace(/^--\+\s*/, '');
    }
    return trimmed.replace(/^(--\s*|#\s*)/, '');
}

function normalize_comment_marker(comment) {
    var source = String(comment || '').replace(/\s+$/g, '');
    if (is_hive_hint_comment(source)) {
        return source.replace(/^(\s*)--\+\s*/, '$1--+ ');
    }
    return source.replace(/^--([^\s\-\n])/, '-- $1');
}

function comment_prefix(comment) {
    var trimmed = String(comment || '').replace(/^\s+/g, '');
    if (is_hive_hint_comment(trimmed)) {
        return '--+ ';
    }
    return /^#/.test(trimmed) ? '# ' : '-- ';
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

function is_hive_hint_comment(comment) {
    return /^--\+/.test(String(comment || '').replace(/^\s+/g, ''));
}

exports.split_code_and_comment = split_code_and_comment;
exports.from_text = from_text;
exports.comment_body = comment_body;
exports.normalize_comment_marker = normalize_comment_marker;
exports.comment_prefix = comment_prefix;
exports.rebuild_line = rebuild_line;
exports.is_hive_hint_comment = is_hive_hint_comment;
