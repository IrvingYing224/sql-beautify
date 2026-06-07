var sqlFormatNavigation = require('./sql-format-navigation');

function is_code_token(token) {
	return token && token.isCode;
}

function is_word(token, value) {
	if (!token || token.type != 'word') {
		return false;
	}
	if (typeof value == 'undefined') {
		return true;
	}
	return token.value.toUpperCase() == value;
}

function token_in_range(token, startIndex, endIndex) {
	return token.index >= startIndex && token.index <= endIndex;
}

function tokens_in_range(document, startIndex, endIndex) {
	var tokens = sqlFormatNavigation.active_tokens(document);
	var result = [];
	for (var i = 0; i < tokens.length; i++) {
		if (token_in_range(tokens[i], startIndex, endIndex)) {
			result.push(tokens[i]);
		}
	}
	return result;
}

exports.is_code_token = is_code_token;
exports.is_word = is_word;
exports.token_in_range = token_in_range;
exports.tokens_in_range = tokens_in_range;
