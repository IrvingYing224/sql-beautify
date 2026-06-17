var sqlFormatMutations = require('./sql-format-mutations');
var sqlLineModel = require('./sql-line-model');
var sqlRenderTokenSpacing = require('./sql-render-token-spacing');

function dialect_name(options, document) {
	if (options && options.dialect) {
		return options.dialect;
	}
	if (document && document.tokenizerOptions && document.tokenizerOptions.dialect) {
		return document.tokenizerOptions.dialect;
	}
	return 'generic';
}

function first_visible_token(line, moveState) {
	for (var i = 0; i < line.tokens.length; i++) {
		if (line.tokens[i].type == 'whitespace' || line.tokens[i].type == 'newline') {
			continue;
		}
		if (moveState.removedTokenIds[String(line.tokens[i].id)]) {
			continue;
		}
		return line.tokens[i];
	}

	return null;
}

function line_starts_with_group_by(line, moveState) {
	var visible = [];
	for (var i = 0; i < line.tokens.length; i++) {
		if (line.tokens[i].type == 'whitespace' || line.tokens[i].type == 'newline') {
			continue;
		}
		if (moveState.removedTokenIds[String(line.tokens[i].id)]) {
			continue;
		}
		visible.push(line.tokens[i]);
		if (visible.length == 2) {
			break;
		}
	}
	return visible.length == 2
		&& is_word_token(visible[0], 'GROUP')
		&& is_word_token(visible[1], 'BY');
}

function trim_trailing_space(text) {
	return String(text || '').replace(/[ \t]+$/g, '');
}

function is_word_token(token, value) {
	if (!token || token.type != 'word') {
		return false;
	}
	if (typeof value == 'undefined') {
		return true;
	}
	return token.value.toUpperCase() == value;
}

function render_line_from_tokens(document, line, mutations, moveState, options) {
	var output = '';
	var leadingIndent = String(line.raw || '').match(/^\s*/)[0];
	var previousToken = null;
	var groupByLine = line_starts_with_group_by(line, moveState);
	var dialect = dialect_name(options, document);
	var tokenStartsNewLine = false;

	for (var i = 0; i < line.tokens.length; i++) {
		var token = line.tokens[i];
		if (token.type == 'whitespace' || token.type == 'newline') {
			continue;
		}

		if (moveState.removedTokenIds[String(token.id)]) {
			continue;
		}

		var tokenMutation = sqlFormatMutations.get_for_token(mutations, token.id);
		if (tokenMutation.omission) {
			continue;
		}
		if (tokenMutation.replacement && tokenMutation.replacement.value == '') {
			continue;
		}
		if (tokenMutation.lineBreakBefore) {
			output = trim_trailing_space(output)
				+ '\n'
				+ tokenMutation.lineBreakBefore.indentText
				+ tokenMutation.lineBreakBefore.prefixText;
			previousToken = null;
			tokenStartsNewLine = true;
		} else if (output == '' && token == first_visible_token(line, moveState)) {
			output += leadingIndent;
		}

		if (tokenMutation.spacingBefore) {
			output = trim_trailing_space(output) + tokenMutation.spacingBefore.spacingText;
		}

		output = sqlRenderTokenSpacing.append_visible_token(
			output,
			document,
			token,
			sqlRenderTokenSpacing.token_value(token, tokenMutation),
			previousToken,
			dialect,
			groupByLine,
			{ tokenStartsNewLine: tokenStartsNewLine }
		);
		previousToken = token;
		tokenStartsNewLine = false;
	}

	if (moveState.movedCommentSourceLines[String(line.index)] && line.hasTrailingComment) {
		var commentIndex = output.indexOf(line.commentText);
		if (commentIndex >= 0) {
			output = output.slice(0, commentIndex).replace(/[ \t]+$/g, '');
		}
	}

	var movedComments = moveState.movedCommentsByLine[String(line.index)] || [];
	for (var m = 0; m < movedComments.length; m++) {
		var sourceLine = document.lines[movedComments[m].fromLineIndex];
		var commentText = sourceLine ? sourceLine.commentText : '';
		if (commentText != '') {
			output = trim_trailing_space(output) + ' ' + commentText.replace(/^\s+/g, '');
		}
	}

	return output.replace(/[ \t]+$/g, '');
}

function apply_comment_alignment_to_single_line(lineText, alignment) {
	if (!alignment) {
		return lineText;
	}

	var parts = sqlLineModel.split_code_and_comment(lineText);
	if (parts.comment == '') {
		return lineText;
	}

	var code = parts.code.replace(/[ \t]+$/g, '');
	var gap = alignment.column - code.length;
	if (gap < 1) {
		gap = 1;
	}

	return code + new Array(gap + 1).join(' ') + parts.comment;
}

function apply_comment_alignment(lineText, alignment) {
	if (!alignment) {
		return lineText;
	}

	var text = String(lineText || '');
	if (text.indexOf('\n') < 0) {
		return apply_comment_alignment_to_single_line(text, alignment);
	}

	var lines = text.split('\n');
	for (var i = 0; i < lines.length; i++) {
		lines[i] = apply_comment_alignment_to_single_line(lines[i], alignment);
	}
	return lines.join('\n');
}

function normalize_output_whitespace(text) {
	var normalized = String(text || '')
		.replace(/\r\n|\r/g, '\n')
		.replace(/[ \t]+$/gm, '')
		.replace(/^\n+/g, '')
		.replace(/\n{3,}/g, '\n\n')
		.replace(/\n+$/g, '');

	return normalized + '\n';
}

function append_joined_line(lines, rendered, joinMutation) {
	if (!joinMutation || lines.length == 0) {
		lines.push(rendered);
		return;
	}

	var renderedLines = String(rendered || '').split('\n');
	var first = renderedLines.shift();
	var separator = typeof joinMutation.separatorText == 'string' ? joinMutation.separatorText : ' ';
	lines[lines.length - 1] = trim_trailing_space(lines[lines.length - 1])
		+ separator
		+ first.replace(/^\s+/g, '');

	for (var i = 0; i < renderedLines.length; i++) {
		lines.push(renderedLines[i]);
	}
}

exports.render_line_from_tokens = render_line_from_tokens;
exports.apply_comment_alignment = apply_comment_alignment;
exports.append_joined_line = append_joined_line;
exports.normalize_output_whitespace = normalize_output_whitespace;
