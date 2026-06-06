var sqlCaseUtils = require('./sql-case-utils');
var sqlFormatDocument = require('./sql-format-document');

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
	var document = sqlFormatDocument.from_text(text, tokenizerOptions);
	var lines = [];

	for (var i = 0; i < document.lines.length; i++) {
		var line_info = document.lines[i];
		var code_tokens = line_info.codeTokens;
		lines.push({
			index: i,
			raw: line_info.raw,
			code: line_info.codeText,
			comment: line_info.commentText,
			isBlank: line_info.isBlank,
			isStandaloneComment: line_info.isStandaloneComment,
			hasTrailingComment: line_info.hasTrailingComment,
			codeTokens: code_tokens,
			parenDelta: paren_delta(code_tokens),
			caseDelta: sqlCaseUtils.get_case_balance_delta(line_info.codeText, document.tokenizerOptions)
		});
	}

	return {
		document: document,
		lines: lines
	};
}

exports.from_text = from_text;
