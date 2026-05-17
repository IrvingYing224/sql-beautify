var sqlLineModel = require('./sql-line-model');
var sqlTokenizer = require('./sql-tokenizer');
var sqlCaseUtils = require('./sql-case-utils');

function paren_delta(tokens) {
	var delta = 0;

	for (var i = 0; i < tokens.length; i++) {
		if (tokens[i].type == 'punctuation' && tokens[i].value == '(') {
			delta += 1;
		} else if (tokens[i].type == 'punctuation' && tokens[i].value == ')') {
			delta -= 1;
		}
	}

	return delta;
}

function from_text(text, tokenizerOptions) {
	var raw_lines = String(text || '').split(/\r\n|\n|\r/);
	var lines = [];

	for (var i = 0; i < raw_lines.length; i++) {
		var line_info = sqlLineModel.from_text(raw_lines[i], tokenizerOptions)[0];
		var code_tokens = sqlTokenizer.tokenize(line_info.code, tokenizerOptions);
		lines.push({
			index: i,
			raw: raw_lines[i],
			code: line_info.code,
			comment: line_info.comment,
			isBlank: line_info.isBlank,
			isStandaloneComment: line_info.isStandaloneComment,
			hasTrailingComment: line_info.hasTrailingComment,
			codeTokens: code_tokens,
			parenDelta: paren_delta(code_tokens),
			caseDelta: sqlCaseUtils.get_case_balance_delta(line_info.code, tokenizerOptions)
		});
	}

	return {
		lines: lines
	};
}

exports.from_text = from_text;
