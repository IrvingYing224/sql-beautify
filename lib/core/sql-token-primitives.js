var sqlTokenizer = require('./sql-tokenizer');

function tokenize(text, tokenizerOptions) {
    return sqlTokenizer.tokenize(String(text || ''), tokenizerOptions);
}

function is_ignorable(token) {
    return token && (token.type == 'whitespace' || token.type == 'newline');
}

function split_code_and_comment(text, tokenizerOptions) {
    var source = String(text || '');
    var tokens = tokenize(source, tokenizerOptions);

    for (var i = 0; i < tokens.length; i++) {
        if (tokens[i].type == 'line_comment') {
            return {
                code: source.slice(0, tokens[i].start).replace(/\s+$/g, ''),
                comment: source.slice(tokens[i].start).replace(/\s+$/g, ''),
                commentStart: tokens[i].start
            };
        }
    }

    return {
        code: source.replace(/\s+$/g, ''),
        comment: '',
        commentStart: -1
    };
}

function split_top_level_items(text, tokenizerOptions, splitOptions) {
    var source = String(text || '');
    var tokens = tokenize(source, tokenizerOptions);
    var options = splitOptions || {};
    var items = [];
    var parenDepth = 0;
    var angleDepth = 0;
    var start = 0;

    for (var i = 0; i < tokens.length; i++) {
        if (tokens[i].type == 'punctuation' && tokens[i].value == '(') {
            parenDepth += 1;
            continue;
        }

        if (tokens[i].type == 'punctuation' && tokens[i].value == ')' && parenDepth > 0) {
            parenDepth -= 1;
            continue;
        }

        if (options.trackAngleBrackets && tokens[i].type == 'operator') {
            for (var q = 0; q < tokens[i].value.length; q++) {
                if (tokens[i].value[q] == '<') {
                    angleDepth += 1;
                    continue;
                }

                if (tokens[i].value[q] == '>' && angleDepth > 0) {
                    angleDepth -= 1;
                }
            }
            continue;
        }

        if (tokens[i].type == 'punctuation'
            && tokens[i].value == ','
            && parenDepth == 0
            && angleDepth == 0) {
            items.push(source.slice(start, tokens[i].start));
            start = tokens[i].end;
        }
    }

    items.push(source.slice(start));
    return items;
}

function find_top_level_word(text, word, tokenizerOptions) {
    var tokens = tokenize(text, tokenizerOptions);
    var depth = 0;
    var target = String(word || '').toUpperCase();

    for (var i = 0; i < tokens.length; i++) {
        var token = tokens[i];

        if (token.type == 'punctuation' && token.value == '(') {
            depth += 1;
            continue;
        }

        if (token.type == 'punctuation' && token.value == ')') {
            if (depth > 0) {
                depth -= 1;
            }
            continue;
        }

        if (depth == 0 && token.type == 'word' && token.value.toUpperCase() == target) {
            return token.start;
        }
    }

    return -1;
}

exports.tokenize = tokenize;
exports.is_ignorable = is_ignorable;
exports.split_code_and_comment = split_code_and_comment;
exports.split_top_level_items = split_top_level_items;
exports.find_top_level_word = find_top_level_word;
