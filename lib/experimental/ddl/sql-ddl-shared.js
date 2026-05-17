function repeat_space(count) {
    if (count <= 0) {
        return '';
    }

    return new Array(count + 1).join(' ');
}

function is_ignorable_token(token) {
    return token.type == 'whitespace'
        || token.type == 'newline'
        || token.type == 'line_comment'
        || token.type == 'block_comment';
}

function update_sql_depth(token, state) {
    if (token.type == 'punctuation' && token.value == '(') {
        state.paren_depth += 1;
    } else if (token.type == 'punctuation' && token.value == ')' && state.paren_depth > 0) {
        state.paren_depth -= 1;
    }
}

function render_hive_comment_literal(text) {
    return '"' + String(text || '')
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\r\n|\r|\n/g, '\\n') + '"';
}

exports.repeat_space = repeat_space;
exports.is_ignorable_token = is_ignorable_token;
exports.update_sql_depth = update_sql_depth;
exports.render_hive_comment_literal = render_hive_comment_literal;
