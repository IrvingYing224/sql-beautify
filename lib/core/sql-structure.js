var lineModel = require('./sql-line-model');
var primitives = require('./sql-token-primitives');

function split_code_and_comment(text, tokenizerOptions) {
    return lineModel.split_code_and_comment(text, tokenizerOptions);
}

function find_top_level_word(text, word, tokenizerOptions) {
    return primitives.find_top_level_word(text, word, tokenizerOptions);
}

exports.split_code_and_comment = split_code_and_comment;
exports.find_top_level_word = find_top_level_word;
