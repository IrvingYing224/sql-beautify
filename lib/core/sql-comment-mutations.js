var sqlFormatMutations = require('./sql-format-mutations');
var sqlRenderWidth = require('./sql-render-width');

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
	var widthContext = sqlRenderWidth.create_width_context(document, nodes, mutations, config);

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

			function group_has_case_branch_value_comment() {
				for (var i = 0; i < group.length; i++) {
					if (widthContext.is_case_branch_value_comment_line(group[i].index)) {
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
					&& !widthContext.is_case_end_alias_comment_line(group[i].index)) {
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
				if (group_has_case_branch_value_comment() && widthContext.is_case_end_alias_comment_line(line.index)) {
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
					&& (select_item_for_line(line.index).startLine == line.index || widthContext.is_case_end_alias_comment_line(line.index))
					&& (!line_index_inside_case_expression(line.index)
						|| (widthContext.is_case_end_alias_comment_line(line.index) && widthContext.planned_code_width(line) >= maxAlignWidth))) {
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
						codeWidth: widthContext.planned_code_width(line),
						alignmentWidth: widthContext.planned_alignment_width(line),
						joinPrefixWidth: widthContext.planned_join_prefix_width(line),
						prefixWidth: widthContext.planned_prefix_width(line.index),
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
