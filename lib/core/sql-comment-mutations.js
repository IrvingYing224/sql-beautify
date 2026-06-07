var sqlFormatUtils = require('./sql-format-utils');
var sqlCaseUtils = require('./sql-case-utils');
var sqlFormatMutations = require('./sql-format-mutations');
var expand_tabs_for_width = sqlFormatUtils.expand_tabs_for_width;
var get_alignment_width_for_code = sqlCaseUtils.get_alignment_width_for_code;

function apply_comment_alignment_mutations(document, nodes, mutations, config) {
	var maxAlignWidth = config && config.maxAlignWidth ? config.maxAlignWidth : 150;
	var group = [];
	var pendingSelectGroup = [];
	var conditionKeywords = {
		ON: true,
		WHERE: true,
		HAVING: true,
		QUALIFY: true
	};
	var movedSeparatorsByLine = {};
	var removedTokenIds = {};

	for (var moveIndex = 0; moveIndex < (mutations.separatorMoves || []).length; moveIndex++) {
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

	for (var tokenOmissionKey in mutations.tokenOmissions) {
		if (!Object.prototype.hasOwnProperty.call(mutations.tokenOmissions, tokenOmissionKey)) {
			continue;
		}
		removedTokenIds[String(mutations.tokenOmissions[tokenOmissionKey].tokenId)] = true;
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

	function rendered_code_text_for_width(line) {
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
			return get_alignment_width_for_code(rendered.text, document.tokenizerOptions).width;
		}

		return get_alignment_width_for_code(planned_code_segment(line), document.tokenizerOptions).width;
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
			var segmentWidth = get_alignment_width_for_code(segments[i], document.tokenizerOptions).width;
			if (segmentWidth > width) {
				width = segmentWidth;
			}
		}
		return width;
	}

	function is_condition_keyword_only_comment_line(line) {
		if (!line.hasTrailingComment || line.codeTokens.length != 1) {
			return false;
		}

		var token = line.codeTokens[0];
		return token.type == 'word' && conditionKeywords[token.value.toUpperCase()] === true;
	}

	function is_select_header_comment_line(line) {
		if (!line.hasTrailingComment || line.codeTokens.length != 1) {
			return false;
		}

		var token = line.codeTokens[0];
		return token.type == 'word' && /^(SELECT|GROUP)$/i.exec(token.value);
	}

	function is_close_only_comment_line(line) {
		if (!line.hasTrailingComment || line.codeTokens.length != 1) {
			return false;
		}

		return line.codeTokens[0].type == 'punctuation' && line.codeTokens[0].value == ')';
	}

	function is_parenthesized_scope_body_line(lineIndex) {
		var scopes = document.scopes || [];

		for (var i = 0; i < scopes.length; i++) {
			var scope = scopes[i];
			if (scope.kind != 'inList'
				&& scope.kind != 'functionCall'
				&& scope.kind != 'parenList'
				&& scope.kind != 'windowSpec') {
				continue;
			}

			if (typeof scope.openLine == 'number'
				&& typeof scope.closeLine == 'number'
				&& lineIndex > scope.openLine
				&& lineIndex < scope.closeLine) {
				if (scope.parentScopeId != null) {
					var parent = scopes[scope.parentScopeId];
					if (parent && parent.kind == 'caseExpr') {
						continue;
					}
					if (parent && parent.kind == 'query' && scope.kind == 'functionCall') {
						continue;
					}
				}
				return true;
			}
		}

		return false;
	}

		function is_query_function_open_comment_line(lineIndex) {
			var scopes = document.scopes || [];

		for (var i = 0; i < scopes.length; i++) {
			var scope = scopes[i];
			if (scope.kind == 'functionCall'
				&& scope.parentScopeId != null
				&& scopes[scope.parentScopeId]
				&& scopes[scope.parentScopeId].kind == 'query'
				&& scope.openLine == lineIndex
				&& scope.openLine < scope.closeLine) {
				return true;
			}
		}

			return false;
		}

	function is_condition_bare_continuation_line(lineIndex) {
		var blocks = nodes && nodes.conditionBlocks ? nodes.conditionBlocks : [];
		for (var i = 0; i < blocks.length; i++) {
				for (var c = 0; c < (blocks[i].continuationLines || []).length; c++) {
					if (blocks[i].continuationLines[c].lineIndex == lineIndex) {
						return true;
					}
				}
		}
		return false;
	}

	function is_join_bridge_line(line) {
		if (!line || line.hasTrailingComment || !line.codeText) {
			return false;
		}

		return /^\s*(JOIN|LEFT|RIGHT|FULL|INNER|CROSS|ON)\b/i.exec(line.codeText);
	}

	function condition_segment_keyword(lineIndex) {
		var blocks = nodes && nodes.conditionBlocks ? nodes.conditionBlocks : [];
		for (var i = 0; i < blocks.length; i++) {
			for (var s = 0; s < (blocks[i].segments || []).length; s++) {
				if (blocks[i].segments[s].lineIndex == lineIndex) {
					return blocks[i].keyword;
				}
			}
		}
		return '';
	}

	function is_condition_segment_line(lineIndex) {
		return condition_segment_keyword(lineIndex) != '';
	}

		function group_has_condition_comment() {
			for (var i = 0; i < group.length; i++) {
				if (is_condition_segment_line(group[i].index)) {
					return true;
				}
		}
		return false;
	}

	function is_select_item_line(lineIndex) {
		var items = nodes && nodes.selectItems ? nodes.selectItems : [];
		for (var i = 0; i < items.length; i++) {
			if (lineIndex >= items[i].startLine && lineIndex <= items[i].endLine) {
				return true;
			}
			}
			return false;
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

		function group_has_case_branch_value_comment() {
			for (var i = 0; i < group.length; i++) {
				if (is_case_branch_value_comment_line(group[i].index)) {
					return true;
				}
			}
			return false;
		}

		function line_index_inside_case_expression(lineIndex) {
			var cases = nodes && nodes.caseExpressions ? nodes.caseExpressions : [];
			for (var i = 0; i < cases.length; i++) {
				if (lineIndex >= cases[i].startLine && lineIndex <= cases[i].endLine) {
					return true;
				}
			}
			return false;
		}

			function group_has_select_item_comment() {
				for (var i = 0; i < group.length; i++) {
					if (is_select_item_line(group[i].index)) {
						return true;
				}
		}
		return false;
	}

	function current_group_is_select_only() {
		if (group.length == 0) {
			return false;
		}
		for (var i = 0; i < group.length; i++) {
			if (!is_select_item_line(group[i].index)) {
				return false;
			}
		}
		return true;
	}

	function group_can_bridge_clause_line() {
		return group_has_condition_comment();
	}

		function group_can_bridge_select_to_having(line) {
			return group_has_select_item_comment()
				&& line
				&& !line.hasTrailingComment
				&& /^\s*GROUP\s+BY\b/i.exec(line.codeText || '');
		}

		function is_standalone_comment_between_select_items(line) {
			if (!line || !line.isStandaloneComment || !group_has_select_item_comment()) {
				return false;
			}

			var items = nodes && nodes.selectItems ? nodes.selectItems : [];
			for (var i = 0; i < items.length; i++) {
				for (var j = 0; j < items.length; j++) {
					if (items[i].ownerScopeId == null
						|| items[i].ownerScopeId != items[j].ownerScopeId
						|| items[i].endLine >= line.index
						|| items[j].startLine <= line.index) {
						continue;
					}
					return true;
				}
			}

			return false;
		}

	function select_item_for_line(lineIndex) {
		var items = nodes && nodes.selectItems ? nodes.selectItems : [];
		for (var i = 0; i < items.length; i++) {
			if (lineIndex >= items[i].startLine && lineIndex <= items[i].endLine) {
				return items[i];
			}
		}
		return null;
	}

	function select_owner_for_line(lineIndex) {
		var item = select_item_for_line(lineIndex);
		return item ? item.ownerScopeId : null;
	}

	function pending_select_group_matches(lineIndex) {
		var ownerScopeId = select_owner_for_line(lineIndex);
		if (ownerScopeId == null || pendingSelectGroup.length == 0) {
			return false;
		}
		for (var i = 0; i < pendingSelectGroup.length; i++) {
			if (pendingSelectGroup[i].ownerScopeId != ownerScopeId) {
				return false;
			}
		}
		return true;
	}

	function collapsed_select_item_for_line(lineIndex) {
		var item = select_item_for_line(lineIndex);
		if (!item || !item.tokens || item.tokens.length == 0) {
			return null;
		}
		var firstTokenReplacement = mutations.tokenReplacements[String(item.tokens[0].id)];
		if (!firstTokenReplacement || firstTokenReplacement.value == '') {
			return null;
		}
		for (var i = 1; i < item.tokens.length; i++) {
			if (mutations.tokenOmissions[String(item.tokens[i].id)]) {
				return item;
			}
		}
		return null;
	}

	function is_collapsed_select_item_bridge_line(line) {
		return !!line
			&& !line.hasTrailingComment
			&& !!group_has_select_item_comment()
			&& !!collapsed_select_item_for_line(line.index);
	}

	function is_hive_hint_select_item_line(lineIndex) {
		var item = select_item_for_line(lineIndex);
		if (!item) {
			return false;
		}
		var spans = nodes && nodes.selectSpans ? nodes.selectSpans : [];
		for (var i = 0; i < spans.length; i++) {
			if (spans[i].id != item.ownerScopeId) {
				continue;
			}
			var headerLine = document.lines[spans[i].startLine];
			return headerLine && /^--\+/.test(String(headerLine.commentText || '').replace(/^\s+/g, ''));
		}
		return false;
	}

	function flush_group() {
		if (group.length == 0) {
			return;
		}

	if (current_group_is_select_only() && group.length > 1 && !group_has_case_branch_value_comment()) {
		pendingSelectGroup = group.slice();
	}

			var target = 0;
			for (var i = 0; i < group.length; i++) {
				if (group[i].alignmentWidth >= maxAlignWidth
					&& !is_case_end_alias_comment_line(group[i].index)) {
					continue;
				}
				var width = group[i].codeWidth + 1;
				if (width > target) {
					target = width;
				}
			}

			for (i = 0; i < group.length; i++) {
				if (target > 0
					&& group[i].alignmentWidth < maxAlignWidth
					&& !mutations.lineCommentMoves[String(group[i].index)]) {
					sqlFormatMutations.add_comment_alignment(mutations, group[i].index, target - group[i].joinPrefixWidth);
				}
			}
		group = [];
	}

		for (var i = 0; i < document.lines.length; i++) {
			var line = document.lines[i];
			var comment = String(line.commentText || '').replace(/^\s+/g, '');
			if (mutations.lineCommentMoves[String(line.index)]) {
				continue;
			}
		if (is_condition_keyword_only_comment_line(line)) {
			flush_group();
			continue;
		}
		if (is_select_header_comment_line(line)) {
			flush_group();
			continue;
		}
		if (is_close_only_comment_line(line)) {
			flush_group();
			continue;
		}
			if (is_query_function_open_comment_line(line.index)) {
				if (!is_collapsed_select_item_bridge_line(line)) {
					flush_group();
				}
				continue;
			}
			if (is_condition_bare_continuation_line(line.index)) {
				flush_group();
				continue;
			}
			if (is_parenthesized_scope_body_line(line.index)) {
				if (!is_collapsed_select_item_bridge_line(line)) {
					flush_group();
				}
				continue;
		}

			if (line.hasTrailingComment && !/^--\+/.test(comment)) {
				if (mutations.lineJoins[String(line.index)] && group.length > 0) {
					flush_group();
				}
				if (group_has_case_branch_value_comment() && is_case_end_alias_comment_line(line.index)) {
					flush_group();
				}
				if (group_has_select_item_comment()) {
					var keyword = condition_segment_keyword(line.index);
					if (keyword != '' && keyword != 'HAVING') {
					flush_group();
				}
			}
			if (condition_segment_keyword(line.index) == 'HAVING' && pendingSelectGroup.length > 0 && group.length == 0) {
				group = pendingSelectGroup.slice();
				pendingSelectGroup = [];
			}
				if (pendingSelectGroup.length > 0
					&& group.length == 0
					&& is_select_item_line(line.index)
					&& (select_item_for_line(line.index).startLine == line.index || is_case_end_alias_comment_line(line.index))
					&& (!line_index_inside_case_expression(line.index)
						|| (is_case_end_alias_comment_line(line.index) && planned_code_width(line) >= maxAlignWidth))) {
					if (pending_select_group_matches(line.index)) {
						group = pendingSelectGroup.slice();
					}
					pendingSelectGroup = [];
				}
			if (is_hive_hint_select_item_line(line.index)) {
				flush_group();
				continue;
			}
				group.push({
					index: line.index,
						codeWidth: planned_code_width(line),
						alignmentWidth: planned_alignment_width(line),
						joinPrefixWidth: planned_join_prefix_width(line),
						prefixWidth: planned_prefix_width(line.index),
						ownerScopeId: select_owner_for_line(line.index)
					});
				} else if (is_collapsed_select_item_bridge_line(line)
					|| is_standalone_comment_between_select_items(line)
					|| (line.isStandaloneComment && group_has_case_branch_value_comment() && line_index_inside_case_expression(line.index))
					|| (is_join_bridge_line(line) && group_can_bridge_clause_line())
					|| group_can_bridge_select_to_having(line)) {
				continue;
			} else {
			flush_group();
		}
	}

	flush_group();
}

exports.apply_comment_alignment_mutations = apply_comment_alignment_mutations;
