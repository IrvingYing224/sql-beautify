var sqlFormatUtils = require('./sql-format-utils');
var sqlCaseUtils = require('./sql-case-utils');
var sqlFormatMutations = require('./sql-format-mutations');
var sqlRenderTokenSpacing = require('./sql-render-token-spacing');
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

	function original_gap_between(previousToken, token) {
		if (!previousToken || !token || previousToken.line != token.line) {
			return '';
		}
		return String(document.source || '').slice(previousToken.end, token.start);
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

	function line_starts_with_group_by(line) {
		var visible = [];
		var tokens = line.tokens || [];
		for (var i = 0; i < tokens.length; i++) {
			if (tokens[i].type == 'whitespace' || tokens[i].type == 'newline') {
				continue;
			}
			if (removedTokenIds[String(tokens[i].id)]) {
				continue;
			}
			visible.push(tokens[i]);
			if (visible.length == 2) {
				break;
			}
		}
		return visible.length == 2
			&& is_word_token(visible[0], 'GROUP')
			&& is_word_token(visible[1], 'BY');
	}

	function dialect_name() {
		if (config && config.dialect) {
			return config.dialect;
		}
		if (document && document.tokenizerOptions && document.tokenizerOptions.dialect) {
			return document.tokenizerOptions.dialect;
		}
		return 'generic';
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

	function line_has_inline_comma_spacing_change(line) {
		var tokens = line.codeTokens || [];
		for (var i = 1; i < tokens.length; i++) {
			var previousToken = tokens[i - 1];
			var token = tokens[i];
			if (!previousToken
				|| previousToken.type != 'punctuation'
				|| previousToken.value != ','
				|| previousToken.line != token.line) {
				continue;
			}
			if (i == 1 && /^\s*,/.test(String(line.codeText || ''))) {
				continue;
			}
			if (original_gap_between(previousToken, token) != ' ') {
				return true;
			}
		}
		return false;
	}

	function should_use_original_code_text(line) {
		return !line_has_width_mutation(line)
			&& !line_has_inline_comma_spacing_change(line)
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
		var dialect = dialect_name();
		var groupByLine = line_starts_with_group_by(line);

		for (var i = 0; i < line.codeTokens.length; i++) {
			var token = line.codeTokens[i];
			if (removedTokenIds[String(token.id)]) {
				continue;
			}
			var tokenMutation = sqlFormatMutations.get_for_token(mutations, token.id);
			if (tokenMutation.omission) {
				continue;
			}

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

			output = sqlRenderTokenSpacing.append_visible_token(
				output,
				document,
				token,
				sqlRenderTokenSpacing.token_value(token, tokenMutation),
				previousToken,
				dialect,
				groupByLine
			);

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
