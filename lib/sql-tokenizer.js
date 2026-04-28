function is_word_start(ch) {
    return /[A-Za-z_]/.test(ch || '');
}

function is_word_char(ch) {
    return /[A-Za-z0-9_$]/.test(ch || '');
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

function tokenize(text) {
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

        if (ch == '-' && text[i + 1] == '-') {
            i += 2;
            while (i < text.length && text[i] != '\n' && text[i] != '\r') {
                i += 1;
            }
            push_token(tokens, 'line_comment', text.slice(start, i), start, i);
            continue;
        }

        if (ch == '\'' || ch == '"') {
            i = read_string(text, i);
            push_token(tokens, 'string_literal', text.slice(start, i), start, i);
            continue;
        }

        if (is_word_start(ch)) {
            i += 1;
            while (i < text.length && is_word_char(text[i])) {
                i += 1;
            }
            push_token(tokens, 'word', text.slice(start, i), start, i);
            continue;
        }

        if (/[,.;()]/.test(ch)) {
            push_token(tokens, 'punctuation', ch, i, i + 1);
            i += 1;
            continue;
        }

        if (/[=<>!+\-*/%|&:]/.test(ch)) {
            i += 1;
            while (i < text.length && /[=<>!+\-*/%|&:]/.test(text[i])) {
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
