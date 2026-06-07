var sqlTokenizer = require('./sql-tokenizer');
var sqlLineModel = require('./sql-line-model');

function is_mysql_hash_comment_enabled(tokenizer_options) {
	return tokenizer_options && tokenizer_options.dialect == 'mysql';
}

function normalize_line_comment_spacing(str, tokenizer_options) {
	var tokens = sqlTokenizer.tokenize(str, tokenizer_options);

	for (let i = 0; i < tokens.length; i++) {
		if (tokens[i].type == 'line_comment') {
			tokens[i].value = sqlLineModel.normalize_comment_marker(tokens[i].value);
		}
	}

	return sqlTokenizer.join_tokens(tokens);
}

exports.normalize_line_comment_spacing = normalize_line_comment_spacing;
