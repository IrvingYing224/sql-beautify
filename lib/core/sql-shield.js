var tokenizer = require('./sql-tokenizer');

var DEFAULT_PROTECTED_TYPES = {
    string_literal: true,
    line_comment: true,
    block_comment: true,
    quoted_identifier: true
};

function get_protected_types(options) {
    var protected_types = {};
    var key;

    for (key in DEFAULT_PROTECTED_TYPES) {
        protected_types[key] = DEFAULT_PROTECTED_TYPES[key];
    }

    if (options) {
        for (key in DEFAULT_PROTECTED_TYPES) {
            if (options[key] === false) {
                protected_types[key] = false;
            }
        }
    }

    return protected_types;
}

function create_nonce(text) {
    var seed = 0;
    var nonce = '';

    do {
        nonce = 'SQLBEAUTIFYSHIELD' + seed + 'MARK';
        seed += 1;
    } while (text.indexOf(nonce) >= 0);

    return nonce;
}

function create_placeholder(nonce, index) {
    return '{' + nonce + '_' + index + '}';
}

function escape_regex(text) {
    return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function is_standalone_block_comment(text, token) {
    var before = text.slice(0, token.start);
    var after = text.slice(token.end);
    var previous_newline = Math.max(before.lastIndexOf('\n'), before.lastIndexOf('\r'));
    var next_newline_n = after.indexOf('\n');
    var next_newline_r = after.indexOf('\r');
    var next_newline;
    var before_line = text.slice(previous_newline + 1, token.start);
    var after_line;

    if (next_newline_n < 0) {
        next_newline = next_newline_r;
    } else if (next_newline_r < 0) {
        next_newline = next_newline_n;
    } else {
        next_newline = Math.min(next_newline_n, next_newline_r);
    }

    after_line = next_newline < 0 ? after : after.slice(0, next_newline);

    return /^[ \t]*$/.test(before_line) && /^[ \t]*$/.test(after_line);
}

function protect(text, options) {
    var source = String(text || '');
    var tokens = tokenizer.tokenize(source, options && options.tokenizerOptions);
    var protected_tokens = [];
    var items = [];
    var protected_types = get_protected_types(options);
    var nonce = create_nonce(source);

    for (var i = 0; i < tokens.length; i++) {
        if (protected_types[tokens[i].type] === true) {
            var placeholder = create_placeholder(nonce, protected_tokens.length);
            var item_type = tokens[i].type == 'block_comment' && is_standalone_block_comment(source, tokens[i])
                ? 'standalone_block_comment'
                : tokens[i].type;

            protected_tokens.push(tokens[i].value);
            items.push({
                placeholder: placeholder,
                value: tokens[i].value,
                type: item_type
            });
            tokens[i].value = placeholder;
        }
    }

    protected_tokens.items = items;

    return {
        text: tokenizer.join_tokens(tokens),
        tokens: protected_tokens,
        items: items,
        nonce: nonce
    };
}

function preserve_standalone_block_lines(text, items) {
    var result = String(text || '');

    for (var i = 0; i < (items || []).length; i++) {
        if (items[i].type != 'standalone_block_comment') {
            continue;
        }

        var placeholder = items[i].placeholder;
        var pattern = new RegExp('\\s*' + escape_regex(placeholder) + '\\s*', 'g');
        result = result.replace(pattern, function(match, offset, source) {
            var prefix = offset == 0 ? '' : '\n';
            var suffix = offset + match.length >= source.length ? '' : '\n';
            return prefix + placeholder + suffix;
        });
    }

    return result;
}

function restore(text, protected_tokens, items) {
    var result = String(text || '');
    var restore_items = items || (protected_tokens && protected_tokens.items) || [];

    for (var q = 0; q < restore_items.length; q++) {
        result = result.split(restore_items[q].placeholder).join(restore_items[q].value);
    }

    return result;
}

exports.protect = protect;
exports.restore = restore;
exports.preserve_standalone_block_lines = preserve_standalone_block_lines;
