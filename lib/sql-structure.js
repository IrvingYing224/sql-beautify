var tokenizer = require('./sql-tokenizer');
var lineModel = require('./sql-line-model');

function split_code_and_comment(text) {
    return lineModel.split_code_and_comment(text);
}

function find_top_level_word(text, word) {
    var tokens = tokenizer.tokenize(text);
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

exports.split_code_and_comment = split_code_and_comment;
exports.find_top_level_word = find_top_level_word;
