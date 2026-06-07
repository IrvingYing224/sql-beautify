var sqlFormatUtils = require('./sql-format-utils');
var sqlCaseUtils = require('./sql-case-utils');
var sqlFormatMutations = require('./sql-format-mutations');
var expand_tabs_for_width = sqlFormatUtils.expand_tabs_for_width;
var get_alignment_width_for_code = sqlCaseUtils.get_alignment_width_for_code;

function create_width_context(document, nodes, mutations, config) {
	var movedSeparatorsByLine = {};
	var removedTokenIds = {};
	var alignmentWidthCache = {};
	var moveIndex;
	var tokenOmissionKey;

	for (moveIndex = 0; moveIndex < (mutations.separatorMoves || []).length; moveIndex++) {
		var move = mutations.separatorMoves[moveIndex];
		var separator = separator_node_for_id(move.separatorId);
		if (!separator) {
			continue;
		}
		removedTokenIds[String(separator.tokenId)] = true;
		if (move.target && move.target.placement == 'linePrefix' && move.target.lineIndex != null) {
			var lineKey = String(move.target.lineIndex);
			if (!movedSeparatorsByLine[lineKey]) {
				movedSeparatorsByLine[lineKey] = [];
			}
			movedSeparatorsByLine[lineKey].push(move);
		}
	}

	for (tokenOmissionKey in mutations.tokenOmissions) {
		if (!Object.prototype.hasOwnProperty.call(mutations.tokenOmissions, tokenOmissionKey)) {
			continue;
		}
		removedTokenIds[String(mutations.tokenOmissions[tokenOmissionKey].tokenId)] = true;
	}

	function tokenizer_options_key(options) {
		var source = options || {};
		var keys = Object.keys(source).sort();
		var copy = {};
		for (var i = 0; i < keys.length; i++) {
			if (typeof source[keys[i]] != 'function') {
				copy[keys[i]] = source[keys[i]];
			}
		}
		return JSON.stringify(copy);
	}

	function cached_alignment_width_for_code(code) {
		var key = tokenizer_options_key(document && document.tokenizerOptions) + '\0' + String(code || '');
		if (Object.prototype.hasOwnProperty.call(alignmentWidthCache, key)) {
			return alignmentWidthCache[key];
		}
		var width = get_alignment_width_for_code(code, document.tokenizerOptions).width;
		alignmentWidthCache[key] = width;
		return width;
	}

	function separator_node_for_id(separatorId) {
		var separators = nodes && nodes.separators ? nodes.separators : [];
		for (var i = 0; i < separators.length; i++) {
			if (separators[i].id == separatorId) {
				return separators[i];
			}
		}
		return null;
	}

	function planned_prefix_width(lineIndex) {
		var width = 0;
		var line = document.lines[lineIndex];
		var moves = movedSeparatorsByLine[String(lineIndex)] || [];
		for (var i = 0; i < moves.length; i++) {
			width += String(moves[i].target.text || '').length;
			if (i == 0 && typeof moves[i].target.indentText == 'string') {
				width += expand_tabs_for_width(moves[i].target.indentText).length
					- expand_tabs_for_width(line ? String(line.raw || '').match(/^\s*/)[0] : '').length;
			}
		}
		return width;
	}

	function normalized_token_value(token) {
		var tokenMutation = sqlFormatMutations.get_for_token(mutations, token.id);
		var value = tokenMutation && tokenMutation.replacement ? tokenMutation.replacement.value : token.value;
		if (token && token.type == 'operator') {
			var unary = /^(=|<>|!=|>=|<=|>|<)([+-])$/.exec(value);
			if (unary) {
				return unary[1] + ' ' + unary[2];
			}
			var arithmeticUnary = /^([*/%])([+-])$/.exec(value);
			if (arithmeticUnary) {
				return arithmeticUnary[1] + ' ' + arithmeticUnary[2];
			}
		}
		return value;
	}

	function original_gap_between(previousToken, token) {
		if (!previousToken || !token || previousToken.line != token.line) {
			return '';
		}
		return String(document.source || '').slice(previousToken.end, token.start);
	}

	function normalized_original_space(previousToken, token) {
		return /[ \t]/.test(original_gap_between(previousToken, token)) ? ' ' : '';
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

	function previous_code_token(token) {
		if (!token) {
			return null;
		}

		for (var i = token.index - 1; i >= 0; i--) {
			var candidate = document.tokens[i];
			if (candidate && candidate.isCode) {
				return candidate;
			}
		}

		return null;
	}

	function token_inside_scope_kind(token, kind) {
		var scopes = document && document.scopes ? document.scopes : [];
		for (var i = 0; i < scopes.length; i++) {
			if (scopes[i].kind == kind
				&& token.index >= scopes[i].startTokenIndex
				&& token.index <= scopes[i].endTokenIndex) {
				return true;
			}
		}
		return false;
	}

	function follows_window_order_by(previousToken, token) {
		if (!is_word_token(previousToken, 'BY')) {
			return false;
		}

		var beforeBy = previous_code_token(previousToken);
		return is_word_token(beforeBy, 'ORDER') && token_inside_scope_kind(token, 'windowSpec');
	}

	function line_has_width_mutation(line) {
		if (mutations.lineJoins[String(line.index)]
			|| (movedSeparatorsByLine[String(line.index)] || []).length > 0) {
			return true;
		}

		for (var i = 0; i < (line.codeTokens || []).length; i++) {
			var token = line.codeTokens[i];
			if (removedTokenIds[String(token.id)]) {
				return true;
			}
			var tokenMutation = sqlFormatMutations.get_for_token(mutations, token.id);
			if (tokenMutation.omission
				|| tokenMutation.replacement
				|| tokenMutation.lineBreakBefore
				|| tokenMutation.spacingBefore) {
				return true;
			}
		}

		return false;
	}

	function should_use_original_code_text(line) {
		return !line_has_width_mutation(line)
			&& (!mutations.lineIndents[String(line.index)]
				|| is_word_token((line.codeTokens || [])[0], 'SELECT'));
	}

	function rendered_code_text_for_width(line) {
		if (should_use_original_code_text(line)) {
			var codeText = String(line.codeText || '').replace(/[ \t]+$/g, '');
			return {
				text: codeText,
				includesIndent: false,
				segments: [codeText]
			};
		}

		var output = '';
		var previousToken = null;
		var sawLineBreak = false;

		for (var i = 0; i < line.codeTokens.length; i++) {
			var token = line.codeTokens[i];
			if (removedTokenIds[String(token.id)]) {
				continue;
			}
			var tokenMutation = sqlFormatMutations.get_for_token(mutations, token.id);
			if (tokenMutation.omission) {
				continue;
			}
			var value = normalized_token_value(token);

			if (tokenMutation.lineBreakBefore) {
				output = output.replace(/[ \t]+$/g, '')
					+ '\n'
					+ tokenMutation.lineBreakBefore.indentText
					+ tokenMutation.lineBreakBefore.prefixText;
				previousToken = null;
				sawLineBreak = true;
			}

			if (tokenMutation.spacingBefore) {
				output = output.replace(/[ \t]+$/g, '') + tokenMutation.spacingBefore.spacingText;
			}

			if (token.type == 'punctuation') {
				if (value == ',' || value == ';' || value == ')' || value == ']' || value == '.') {
					output = output.replace(/[ \t]+$/g, '') + value;
				} else if (value == '(') {
					if (is_word_token(previousToken, 'OVER')) {
						output = output.replace(/[ \t]+$/g, '') + normalized_original_space(previousToken, token) + value;
					} else {
						output = output.replace(/[ \t]+$/g, '') + value;
					}
				} else if (/[ \t(.,\[]$/.test(output) || output == '') {
					output += value;
				} else {
					output += ' ' + value;
				}
			} else if (token.type == 'operator') {
				if (previousToken && previousToken.type == 'punctuation' && previousToken.value == '(' && value == '*') {
					output = output.replace(/[ \t]+$/g, '') + value;
				} else if (previousToken && previousToken.type == 'word' && previousToken.value.toUpperCase() == 'SELECT' && value == '*') {
					output = output.replace(/[ \t]+$/g, '') + '  ' + value;
				} else {
					output = output.replace(/[ \t]+$/g, '') + ' ' + value + ' ';
				}
			} else if (output == '' || /[ \t(.,\[]$/.test(output)) {
				output += value;
			} else if (previousToken && previousToken.type == 'word' && previousToken.value.toUpperCase() == 'SELECT') {
				output += '  ' + value;
			} else if (follows_window_order_by(previousToken, token)) {
				output += '  ' + value;
			} else {
				output += ' ' + value;
			}

			previousToken = token;
		}

		output = output.replace(/[ \t]+$/g, '');
		if (sawLineBreak) {
			var segments = output.split('\n');
			return {
				text: segments[segments.length - 1],
				includesIndent: true,
				segments: segments
			};
		}

		return {
			text: output,
			includesIndent: false,
			segments: [output]
		};
	}

	function planned_unjoined_code_width(line) {
		var rendered = rendered_code_text_for_width(line);
		var codeText = rendered.text;

		if (rendered.includesIndent) {
			if (is_case_branch_value_comment_line(line.index)) {
				return max_segment_width(rendered.segments);
			}
			return expand_tabs_for_width(codeText).length;
		}

		var indent = mutations.lineIndents[String(line.index)];
		if (indent) {
			return expand_tabs_for_width(indent.indentText).length
				+ expand_tabs_for_width(codeText).length;
		}

		return expand_tabs_for_width(String(line.raw || '').match(/^\s*/)[0]).length
			+ expand_tabs_for_width(codeText).length;
	}

	function planned_code_width(line) {
		var join = mutations.lineJoins[String(line.index)];

		if (join && line.index > 0) {
			var rendered = rendered_code_text_for_width(line);
			var previousText = planned_code_segment(document.lines[line.index - 1]).replace(/[ \t]+$/g, '');
			var currentText = rendered.text.replace(/^\s+/g, '');
			return expand_tabs_for_width(previousText).length
				+ String(join.separatorText || ' ').length
				+ expand_tabs_for_width(currentText).length;
		}

		var width = planned_unjoined_code_width(line);
		if (line.hasTrailingComment
			&& !line_has_line_break_mutation(line)
			&& line_inside_case_expr(line)) {
			var rawWidth = expand_tabs_for_width(String(line.codeText || '').replace(/[ \t]+$/g, '')).length;
			if (rawWidth > width) {
				width = rawWidth;
			}
		}
		return width;
	}

	function planned_join_prefix_width(line) {
		if (!mutations.lineJoins[String(line.index)]) {
			return 0;
		}
		return planned_code_width(line) - planned_unjoined_code_width(line);
	}

	function line_has_line_break_mutation(line) {
		for (var i = 0; i < (line.codeTokens || []).length; i++) {
			if (sqlFormatMutations.get_for_token(mutations, line.codeTokens[i].id).lineBreakBefore) {
				return true;
			}
		}
		return false;
	}

	function line_inside_case_expr(line) {
		for (var i = 0; i < (line.codeTokens || []).length; i++) {
			if (token_inside_scope_kind(line.codeTokens[i], 'caseExpr')) {
				return true;
			}
		}
		return false;
	}

	function planned_code_segment(line) {
		var rendered = rendered_code_text_for_width(line);
		if (rendered.includesIndent) {
			return rendered.text;
		}

		var indent = mutations.lineIndents[String(line.index)];
		if (indent) {
			return indent.indentText + rendered.text;
		}

		return String(line.raw || '').match(/^\s*/)[0] + rendered.text;
	}

	function planned_alignment_width(line) {
		var rendered = rendered_code_text_for_width(line);
		if (rendered.includesIndent) {
			if (is_case_branch_value_comment_line(line.index)) {
				return max_segment_alignment_width(rendered.segments);
			}
			return cached_alignment_width_for_code(rendered.text);
		}

		return cached_alignment_width_for_code(planned_code_segment(line));
	}

	function max_segment_width(segments) {
		var width = 0;
		for (var i = 0; i < (segments || []).length; i++) {
			var segmentWidth = expand_tabs_for_width(segments[i]).length;
			if (segmentWidth > width) {
				width = segmentWidth;
			}
		}
		return width;
	}

	function max_segment_alignment_width(segments) {
		var width = 0;
		for (var i = 0; i < (segments || []).length; i++) {
			var segmentWidth = cached_alignment_width_for_code(segments[i]);
			if (segmentWidth > width) {
				width = segmentWidth;
			}
		}
		return width;
	}

	function token_after_case_end_on_same_line(caseNode, lineIndex, value) {
		if (!caseNode || !caseNode.endKeywordToken || caseNode.endKeywordToken.line != lineIndex) {
			return null;
		}

		var line = document.lines[lineIndex];
		for (var i = caseNode.endKeywordToken.index + 1; i < document.tokens.length; i++) {
			var token = document.tokens[i];
			if (!token || token.line != lineIndex) {
				break;
			}
			if (!token.isCode) {
				continue;
			}
			if (line && line.commentStart >= 0 && token.column >= line.commentStart) {
				break;
			}
			if (token.type == 'word' && token.value.toUpperCase() == value) {
				return token;
			}
		}

		return null;
	}

	function is_case_end_alias_comment_line(lineIndex) {
		var line = document.lines[lineIndex];
		if (!line || !line.hasTrailingComment) {
			return false;
		}

		var cases = nodes && nodes.caseExpressions ? nodes.caseExpressions : [];
		for (var i = 0; i < cases.length; i++) {
			if (token_after_case_end_on_same_line(cases[i], lineIndex, 'AS')) {
				return true;
			}
		}

		return false;
	}

	function is_case_branch_value_comment_line(lineIndex) {
		var line = document.lines[lineIndex];
		if (!line || !line.hasTrailingComment || is_case_end_alias_comment_line(lineIndex)) {
			return false;
		}

		var cases = nodes && nodes.caseExpressions ? nodes.caseExpressions : [];
		for (var i = 0; i < cases.length; i++) {
			var caseNode = cases[i];
			for (var b = 0; b < (caseNode.branches || []).length; b++) {
				var branch = caseNode.branches[b];
				if (branch.thenKeywordToken && branch.thenKeywordToken.line == lineIndex) {
					return true;
				}
			}
			if (caseNode.elseKeywordToken && caseNode.elseKeywordToken.line == lineIndex) {
				return true;
			}
		}

		return false;
	}

	return {
		planned_prefix_width: planned_prefix_width,
		planned_code_width: planned_code_width,
		planned_join_prefix_width: planned_join_prefix_width,
		planned_code_segment: planned_code_segment,
		planned_alignment_width: planned_alignment_width,
		is_case_end_alias_comment_line: is_case_end_alias_comment_line,
		is_case_branch_value_comment_line: is_case_branch_value_comment_line
	};
}

exports.create_width_context = create_width_context;
