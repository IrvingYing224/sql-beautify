function is_word_start(ch) {
    return /[A-Za-z_]/.test(ch || '');
}

function is_word_char(ch) {
    return /[A-Za-z0-9_$]/.test(ch || '');
}

function is_digit(ch) {
    return /[0-9]/.test(ch || '');
}

function is_hex_digit(ch) {
    return /[0-9A-Fa-f]/.test(ch || '');
}

function is_typed_string_prefix(ch) {
    return /[XxBb]/.test(ch || '');
}

function push_token(tokens, type, value, start, end) {
    tokens.push({
        type: type,
        value: value,
        start: start,
        end: end
    });
}

function read_string(text, start) {
    var quote = text[start];
    var i = start + 1;

    while (i < text.length) {
        if (text[i] == quote) {
            if (text[i + 1] == quote) {
                i += 2;
                continue;
            }
            i += 1;
            break;
        }
        if (text[i] == '\\' && i + 1 < text.length) {
            i += 2;
            continue;
        }
        i += 1;
    }

    return i;
}

function read_block_comment(text, start) {
    var i = start + 2;

    while (i < text.length) {
        if (text[i] == '*' && text[i + 1] == '/') {
            return i + 2;
        }
        i += 1;
    }

    return i;
}

function read_quoted_identifier(text, start) {
    var i = start + 1;

    while (i < text.length) {
        if (text[i] == '`') {
            if (text[i + 1] == '`') {
                i += 2;
                continue;
            }
            return i + 1;
        }
        i += 1;
    }

    return i;
}

function read_dollar_quoted_string(text, start) {
    var tag_match = text.slice(start).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
    if (!tag_match) {
        return start;
    }
    var tag = tag_match[0];
    var end = text.indexOf(tag, start + tag.length);
    return end < 0 ? text.length : end + tag.length;
}

function read_placeholder(text, start) {
    if (text[start] != '{') {
        return start;
    }

    var end = text.indexOf('}', start + 1);
    if (end < 0) {
        return start;
    }

    return end + 1;
}

function read_dollar_placeholder(text, start) {
    if (text[start] != '$' || text[start + 1] != '{') {
        return start;
    }

    var end = text.indexOf('}', start + 2);
    if (end < 0) {
        return start;
    }

    return end + 1;
}

function read_number(text, start) {
    var i = start;

    if (text[i] == '0' && (text[i + 1] == 'x' || text[i + 1] == 'X') && is_hex_digit(text[i + 2])) {
        i += 3;
        while (i < text.length && is_hex_digit(text[i])) {
            i += 1;
        }
        return i;
    }

    if (text[i] == '.') {
        if (!is_digit(text[i + 1])) {
            return start;
        }
        i += 1;
    }

    while (i < text.length && is_digit(text[i])) {
        i += 1;
    }

    if (text[i] == '.') {
        i += 1;
        while (i < text.length && is_digit(text[i])) {
            i += 1;
        }
    }

    if ((text[i] == 'e' || text[i] == 'E')
        && (is_digit(text[i + 1])
            || ((text[i + 1] == '+' || text[i + 1] == '-') && is_digit(text[i + 2])))) {
        i += 1;
        if (text[i] == '+' || text[i] == '-') {
            i += 1;
        }
        while (i < text.length && is_digit(text[i])) {
            i += 1;
        }
    }

    return i;
}

function read_typed_string_literal(text, start) {
    if (!is_typed_string_prefix(text[start]) || (text[start + 1] != '\'' && text[start + 1] != '"')) {
        return start;
    }

    return read_string(text, start + 1);
}

function tokenize(text, options) {
    var tokens = [];
    var i = 0;

    while (i < text.length) {
        var ch = text[i];
        var start = i;

        if (ch == '\r' && text[i + 1] == '\n') {
            push_token(tokens, 'newline', '\r\n', i, i + 2);
            i += 2;
            continue;
        }

        if (ch == '\n' || ch == '\r') {
            push_token(tokens, 'newline', ch, i, i + 1);
            i += 1;
            continue;
        }

        if (ch == ' ' || ch == '\t') {
            while (i < text.length && (text[i] == ' ' || text[i] == '\t')) {
                i += 1;
            }
            push_token(tokens, 'whitespace', text.slice(start, i), start, i);
            continue;
        }

        if (ch == '/' && text[i + 1] == '*') {
            i = read_block_comment(text, i);
            push_token(tokens, 'block_comment', text.slice(start, i), start, i);
            continue;
        }

        if (ch == '-' && text[i + 1] == '-') {
            i += 2;
            while (i < text.length && text[i] != '\n' && text[i] != '\r') {
                i += 1;
            }
            push_token(tokens, 'line_comment', text.slice(start, i), start, i);
            continue;
        }

        if (options && options.hashLineComments && ch == '#') {
            i += 1;
            while (i < text.length && text[i] != '\n' && text[i] != '\r') {
                i += 1;
            }
            push_token(tokens, 'line_comment', text.slice(start, i), start, i);
            continue;
        }

        if (ch == '`') {
            i = read_quoted_identifier(text, i);
            push_token(tokens, 'quoted_identifier', text.slice(start, i), start, i);
            continue;
        }

        if (ch == '\'' || ch == '"') {
            i = read_string(text, i);
            push_token(tokens, 'string_literal', text.slice(start, i), start, i);
            continue;
        }

        if (options && options.dollarQuotedStrings && ch == '$') {
            var dollar_end = read_dollar_quoted_string(text, i);
            if (dollar_end > i) {
                i = dollar_end;
                push_token(tokens, 'string_literal', text.slice(start, i), start, i);
                continue;
            }
        }

        if (ch == '$') {
            var dollar_placeholder_end = read_dollar_placeholder(text, i);
            if (dollar_placeholder_end > i) {
                i = dollar_placeholder_end;
                push_token(tokens, 'placeholder', text.slice(start, i), start, i);
                continue;
            }
        }

        if (ch == '{') {
            var placeholder_end = read_placeholder(text, i);
            if (placeholder_end > i) {
                i = placeholder_end;
                push_token(tokens, 'placeholder', text.slice(start, i), start, i);
                continue;
            }
        }

        if (is_typed_string_prefix(ch) && (text[i + 1] == '\'' || text[i + 1] == '"')) {
            var typed_string_end = read_typed_string_literal(text, i);
            if (typed_string_end > i) {
                i = typed_string_end;
                push_token(tokens, 'string_literal', text.slice(start, i), start, i);
                continue;
            }
        }

        if (is_word_start(ch)) {
            i += 1;
            while (i < text.length && is_word_char(text[i])) {
                i += 1;
            }
            push_token(tokens, 'word', text.slice(start, i), start, i);
            continue;
        }

        if (is_digit(ch) || (ch == '.' && is_digit(text[i + 1]))) {
            var number_end = read_number(text, i);
            if (number_end > i) {
                i = number_end;
                push_token(tokens, 'number', text.slice(start, i), start, i);
                continue;
            }
        }

        if (/[,.;()[\]]/.test(ch)) {
            push_token(tokens, 'punctuation', ch, i, i + 1);
            i += 1;
            continue;
        }

        if (/[=<>!+\-*/%|&:#]/.test(ch)) {
            i += 1;
            while (i < text.length && /[=<>!+\-*/%|&:#]/.test(text[i])) {
                i += 1;
            }
            push_token(tokens, 'operator', text.slice(start, i), start, i);
            continue;
        }

        push_token(tokens, 'other', ch, i, i + 1);
        i += 1;
    }

    return tokens;
}

function join_tokens(tokens) {
    var text = '';
    for (var i = 0; i < tokens.length; i++) {
        text += tokens[i].value;
    }
    return text;
}

exports.tokenize = tokenize;
exports.join_tokens = join_tokens;
