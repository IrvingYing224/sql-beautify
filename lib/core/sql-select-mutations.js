var sqlFormatUtils = require('./sql-format-utils');
var sqlFormatMutations = require('./sql-format-mutations');
var sqlFormatNavigation = require('./sql-format-navigation');
var sqlScopeModel = require('./sql-scope-model');
var sqlGroupByExtension = require('./sql-group-by-extension');
var sqlTokenRenderer = require('./sql-token-renderer');
var repeat_space = sqlFormatUtils.repeat_space;

function find_separator_node(nodes, separatorId) {
	for (var i = 0; i < (nodes.separators || []).length; i++) {
		if (nodes.separators[i].id == separatorId) {
			return nodes.separators[i];
		}
	}
	return null;
}

function is_structured_list_separator(separator) {
	return separator
		&& (separator.ownerKind == 'selectList' || separator.ownerKind == 'groupByList');
}

function find_select_span(nodes, ownerScopeId) {
	for (var i = 0; i < (nodes.selectSpans || []).length; i++) {
		if (nodes.selectSpans[i].id == ownerScopeId) {
			return nodes.selectSpans[i];
		}
	}

	return null;
}

function case_scope_for_item(document, item) {
	for (var i = 0; i < (document.scopes || []).length; i++) {
		var scope = document.scopes[i];
		if (scope.kind == 'caseExpr'
			&& scope.startTokenIndex >= item.startTokenIndex
			&& scope.endTokenIndex <= item.endTokenIndex) {
			return scope;
		}
	}
	return null;
}

function case_node_for_item(nodes, item) {
	for (var i = 0; i < (nodes.caseExpressions || []).length; i++) {
		var caseNode = nodes.caseExpressions[i];
		if (caseNode.caseKeywordToken
			&& caseNode.caseKeywordToken.index >= item.startTokenIndex
			&& caseNode.caseKeywordToken.index <= item.endTokenIndex) {
			return caseNode;
		}
	}
	return null;
}

function tokens_between_same_line(document, startToken, endToken) {
	var result = [];
	if (!startToken || !endToken) {
		return result;
	}
	for (var i = startToken.index + 1; i < document.tokens.length; i++) {
		var token = document.tokens[i];
		if (!token || token.index >= endToken.index || token.line != startToken.line) {
			break;
		}
		if (token.isCode) {
			result.push(token);
		}
	}
	return result;
}

function render_node_tokens_with_options(document, tokens, options, spacedScopeId) {
	return sqlTokenRenderer.render_tokens(document, tokens, {
		applyKeywordCase: true,
		keywordCase: options && options.keywordCase,
		spacedScopeId: spacedScopeId,
		unaryNumberMode: 'select',
		windowOrderBySpacing: true
	});
}

function render_node_tokens(document, tokens) {
	return render_node_tokens_with_options(document, tokens, null, null);
}

function structured_list_indent(document, nodes, ownerScopeId, ownerKind) {
	var span = find_select_span(nodes, ownerScopeId);
	var line = span ? document.lines[span.startLine] : null;
	var baseIndent = line ? String(line.raw || '').match(/^\s*/)[0] : '';
	var queryScope = span
		? sqlScopeModel.find_owner_scope(document.scopes || [], {
			line: span.startLine,
			tokenIndex: span.startTokenIndex
		}, 'query')
		: null;
	if (queryScope && queryScope.id != 0 && typeof queryScope.bodyIndent == 'string') {
		baseIndent = queryScope.bodyIndent;
	}
	return baseIndent + (ownerKind == 'groupByList' ? '         ' : '       ');
}

function item_indent(document, nodes, item) {
	var span = find_select_span(nodes, item.ownerScopeId);
	var line = span ? document.lines[span.startLine] : null;
	var baseIndent = line ? String(line.raw || '').match(/^\s*/)[0] : '';
	var queryScope = span
		? sqlScopeModel.find_owner_scope(document.scopes || [], {
			line: span.startLine,
			tokenIndex: span.startTokenIndex
		}, 'query')
		: null;
	if (queryScope && queryScope.id != 0 && typeof queryScope.bodyIndent == 'string') {
		baseIndent = queryScope.bodyIndent;
	}
	return item.id == 'selectItem:0'
		? baseIndent + (item.ownerKind == 'groupByList' ? 'GROUP BY  ' : 'SELECT  ')
		: structured_list_indent(document, nodes, item.ownerScopeId, item.ownerKind) + ',';
}

function token_inside_nested_scope(document, item, token) {
	for (var i = 0; i < (document.scopes || []).length; i++) {
		var scope = document.scopes[i];
		if (scope.kind != 'functionCall'
			&& scope.kind != 'inList'
			&& scope.kind != 'windowSpec'
			&& scope.kind != 'parenList') {
			continue;
		}
		if (token.index > scope.startTokenIndex && token.index < scope.endTokenIndex) {
			return true;
		}
	}
	return false;
}

function find_as_token(document, item) {
	var match = null;
	for (var i = 0; i < (item.tokens || []).length; i++) {
		if (item.tokens[i].type == 'word'
			&& item.tokens[i].value.toUpperCase() == 'AS'
			&& !token_inside_nested_scope(document, item, item.tokens[i])) {
			match = item.tokens[i];
		}
	}
	return match;
}

function effective_line_indent(document, mutations, lineIndex) {
	var lineIndent = mutations && mutations.lineIndents
		? mutations.lineIndents[String(lineIndex)]
		: null;
	if (lineIndent) {
		return lineIndent.indentText;
	}
	var line = document.lines[lineIndex];
	return line ? String(line.raw || '').match(/^\s*/)[0] : '';
}

function effective_token_line_indent(document, mutations, token) {
	var tokenMutation = token && mutations
		? sqlFormatMutations.get_for_token(mutations, token.id)
		: null;
	if (tokenMutation && tokenMutation.lineBreakBefore) {
		return tokenMutation.lineBreakBefore.indentText;
	}
	return effective_line_indent(document, mutations, token ? token.line : -1);
}

function rendered_item_width_before_as(document, nodes, item, mutations) {
	var asToken = find_as_token(document, item);
	var caseScope = case_scope_for_item(document, item);
	if (!asToken) {
		return 0;
	}
	if (caseScope && asToken.index > caseScope.endTokenIndex) {
		var caseNode = case_node_for_item(nodes, item);
		var endToken = caseNode && caseNode.endKeywordToken ? caseNode.endKeywordToken : null;
		var suffixTokens = endToken
			? [endToken].concat(tokens_between_same_line(document, endToken, asToken))
			: [];
		return effective_token_line_indent(document, mutations, endToken).length
			+ render_node_tokens(document, suffixTokens).length;
	}
	var functionScope = top_level_function_scope_for_item(document, item);
	if (functionScope
		&& typeof functionScope.closeTokenIndex == 'number'
		&& asToken.index > functionScope.closeTokenIndex
		&& asToken.line == functionScope.closeLine) {
		return effective_line_indent(document, mutations, functionScope.closeLine).length + ')'.length;
	}
	var width = item_indent(document, nodes, item).length;
	var beforeAsTokens = [];
	for (var i = 0; i < (item.tokens || []).length; i++) {
		var token = item.tokens[i];
		if (token.index >= asToken.index) {
			break;
		}
		if (token.line != item.startLine) {
			continue;
		}
		beforeAsTokens.push(token);
	}
	return width + render_node_tokens(document, beforeAsTokens).length;
}

function max_rendered_item_width_before_as(document, nodes, item, mutations) {
	var width = rendered_item_width_before_as(document, nodes, item, mutations);
	var caseScope = case_scope_for_item(document, item);
	var asToken = find_as_token(document, item);
	var caseNode = case_node_for_item(nodes, item);

	if (caseScope && asToken && asToken.index > caseScope.endTokenIndex) {
		var caseIndent = item_indent(document, nodes, item);
		var maxWidth = caseIndent.length + 'END'.length;
		for (var b = 0; b < (caseNode && caseNode.branches || []).length; b++) {
			var branch = caseNode.branches[b];
			var whenText = render_node_tokens(document, [branch.whenKeywordToken].concat(branch.whenTokens || []));
			var thenText = branch.thenKeywordToken
				? render_node_tokens(document, [branch.thenKeywordToken].concat(branch.thenTokens || []))
				: '';
			var branchText = whenText + (thenText != '' ? ' ' + thenText : '');
			var branchWidth = caseIndent.length + 4 + branchText.length;
			if (branchWidth > maxWidth) {
				maxWidth = branchWidth;
			}
		}
		if (caseNode && caseNode.elseKeywordToken) {
			var elseText = render_node_tokens(document, [caseNode.elseKeywordToken].concat(caseNode.elseTokens || []));
			var elseWidth = caseIndent.length + 4 + elseText.length;
			if (elseWidth > maxWidth) {
				maxWidth = elseWidth;
			}
		}
		return maxWidth;
	}

	return width;
}

function rendered_item_width_without_as(document, nodes, item) {
	return item_indent(document, nodes, item).length + render_node_tokens(document, item.tokens || []).length;
}

function existing_case_alias_target_width(document, item, asToken, width, mutations) {
	var caseScope = case_scope_for_item(document, item);
	if (!caseScope || !asToken || asToken.index <= caseScope.endTokenIndex) {
		return null;
	}

	var tokenMutation = sqlFormatMutations.get_for_token(mutations, asToken.id);
	if (!tokenMutation.spacingBefore) {
		return null;
	}

	return width + tokenMutation.spacingBefore.spacingText.length - 1;
}

function apply_select_as_alignment_mutations(document, nodes, mutations, config) {
	var maxAlignWidth = config && config.maxAlignWidth ? config.maxAlignWidth : 150;
	var groups = {};
	var groupOrder = [];

	for (var i = 0; i < (nodes.selectItems || []).length; i++) {
		var item = nodes.selectItems[i];
		var asToken = find_as_token(document, item);
		var key = String(item.ownerScopeId);
		if (item.tokens
			&& item.tokens.length > 0
			&& mutations.tokenReplacements[String(item.tokens[0].id)]
			&& mutations.tokenReplacements[String(item.tokens[0].id)].value != '') {
			groups[key] = groups[key] || [];
			if (groupOrder.indexOf(key) < 0) {
				groupOrder.push(key);
			}
			groups[key].push({
				item: item,
				asToken: null,
				width: 0,
				maxWidth: rendered_item_width_without_as(document, nodes, item)
			});
			continue;
		}
		if (!groups[key]) {
			groups[key] = [];
			groupOrder.push(key);
		}
		if (!asToken) {
			groups[key].push({
				item: item,
				asToken: null,
				width: 0,
				maxWidth: rendered_item_width_without_as(document, nodes, item)
			});
			continue;
		}
		var width = rendered_item_width_before_as(document, nodes, item, mutations);
		var maxWidth = max_rendered_item_width_before_as(document, nodes, item, mutations);
		var caseAliasTarget = existing_case_alias_target_width(document, item, asToken, width, mutations);
		if (caseAliasTarget != null) {
			maxWidth = caseAliasTarget;
		}

		groups[key].push({
			item: item,
			asToken: asToken,
			width: width,
			maxWidth: maxWidth
		});
	}

	for (var g = 0; g < groupOrder.length; g++) {
		var group = groups[groupOrder[g]];
		var target = 0;
		for (var w = 0; w < group.length; w++) {
			if (group[w].maxWidth > target && group[w].maxWidth < maxAlignWidth) {
				target = group[w].maxWidth;
			}
		}
		for (var a = 0; a < group.length; a++) {
			if (!group[a].asToken) {
				continue;
			}
			var spacing = target - group[a].width + 1;
			sqlFormatMutations.add_spacing_before_token(
				mutations,
				group[a].asToken.id,
				repeat_space(spacing < 1 ? 1 : spacing)
			);
		}
	}
}

function has_select_hint_line(document, item) {
	if (!document || !item || item.ownerKind != 'selectList') {
		return false;
	}

	var previousLine = document.lines[item.startLine - 1];
	if (!previousLine || !previousLine.hasTrailingComment || !/^--\+/.test(previousLine.commentText)) {
		return false;
	}

	return previousLine.codeTokens.length == 1
		&& previousLine.codeTokens[0].type == 'word'
		&& /^SELECT$/i.exec(previousLine.codeTokens[0].value);
}

function has_select_header_comment_line(document, nodes, item) {
	if (!document || !nodes || !item || item.ownerKind != 'selectList' || item.id != 'selectItem:0') {
		return false;
	}
	var span = find_select_span(nodes, item.ownerScopeId);
	if (!span || item.startLine <= span.startLine) {
		return false;
	}
	var line = document.lines[span.startLine];
	return line
		&& line.hasTrailingComment
		&& line.codeTokens.length == 1
		&& line.codeTokens[0].type == 'word'
		&& /^SELECT$/i.exec(line.codeTokens[0].value);
}

function apply_between_item_comment_indents(document, nodes, mutations, item, nextItem) {
	if (!nextItem || item.ownerScopeId != nextItem.ownerScopeId) {
		return;
	}
	if (nextItem.startLine <= item.endLine + 1) {
		return;
	}
	var indent = structured_list_indent(document, nodes, item.ownerScopeId, item.ownerKind);
	for (var lineIndex = item.endLine + 1; lineIndex < nextItem.startLine; lineIndex++) {
		var line = document.lines[lineIndex];
		if (line && line.isStandaloneComment) {
			sqlFormatMutations.add_line_indent(mutations, lineIndex, indent);
		}
	}
}

function token_inside_item(token, item) {
	return token
		&& item
		&& token.index >= item.startTokenIndex
		&& token.index <= item.endTokenIndex;
}

function top_level_function_scope_for_item(document, item, includeSingleLine) {
	for (var i = 0; i < (document.scopes || []).length; i++) {
		var scope = document.scopes[i];
		if (scope.kind != 'functionCall'
			|| scope.parentScopeId != 0) {
			continue;
		}
		if (!includeSingleLine && scope.openLine >= scope.closeLine) {
			continue;
		}

		var openToken = document.tokens[scope.openTokenIndex];
		var closeToken = document.tokens[scope.closeTokenIndex];
		if (token_inside_item(openToken, item) && token_inside_item(closeToken, item)) {
			return scope;
		}
	}
	return null;
}

function first_word_after_scope_close(document, scope, word) {
	if (!scope || typeof scope.closeTokenIndex != 'number') {
		return null;
	}

	var closeToken = document.tokens[scope.closeTokenIndex];
	if (!closeToken) {
		return null;
	}

	for (var i = closeToken.index + 1; i < document.tokens.length; i++) {
		var token = document.tokens[i];
		if (token.line != closeToken.line) {
			return null;
		}
		if (token.type == 'whitespace' || token.type == 'newline') {
			continue;
		}
		if (token.type == 'word' && token.value.toUpperCase() == word) {
			return token;
		}
	}
	return null;
}

function function_item_alias_spacing(document, nodes, mutations, item, itemIndent) {
	var maxWidth = 0;
	for (var i = 0; i < (nodes.selectItems || []).length; i++) {
		var other = nodes.selectItems[i];
		if (other.ownerScopeId != item.ownerScopeId || other.startLine >= item.startLine) {
			continue;
		}

		for (var tokenIndex = 0; tokenIndex < (other.tokens || []).length; tokenIndex++) {
			var token = other.tokens[tokenIndex];
			if (token.type != 'word' || token.value.toUpperCase() != 'AS') {
				continue;
			}

			var line = document.lines[token.line];
			var tokenMutation = sqlFormatMutations.get_for_token(mutations, token.id);
			var lineIndent = mutations.lineIndents[String(token.line)];
			var width;
			if (tokenMutation.spacingBefore) {
				var beforeAs = String(line.codeText || '').slice(0, token.column).replace(/\s+$/g, '');
				width = (lineIndent ? lineIndent.indentText.length : String(line.raw || '').match(/^\s*/)[0].length)
					+ beforeAs.replace(/^\s+/g, '').length
					+ tokenMutation.spacingBefore.spacingText.length;
			} else {
				width = token.column;
			}

			if (width > maxWidth) {
				maxWidth = width;
			}
			break;
		}
	}

	var beforeAsWidth = itemIndent.length + 1;
	var spacingWidth = maxWidth - beforeAsWidth;
	return repeat_space(spacingWidth < 1 ? 1 : spacingWidth);
}

function apply_multiline_function_item_mutations(document, nodes, mutations, item, config) {
	var scope = top_level_function_scope_for_item(document, item, true);
	if (!scope) {
		return;
	}

	var itemIndent = structured_list_indent(document, nodes, item.ownerScopeId, item.ownerKind);
	var collapsedText = render_node_tokens_with_options(document, item.tokens || [], config, scope.id);
	var collapsedWidth = itemIndent.length + 1 + collapsedText.length;
	var maxAlignWidth = config && config.maxAlignWidth
		? config.maxAlignWidth
		: 150;
	var originalCode = '';
	for (var lineIndexForCode = item.startLine; lineIndexForCode <= item.endLine; lineIndexForCode++) {
		originalCode += (lineIndexForCode == item.startLine ? '' : ' ')
			+ String(document.lines[lineIndexForCode] ? document.lines[lineIndexForCode].codeText : '').replace(/^\s+|\s+$/g, '');
	}
	var alreadyCollapsedWithOuterGap = scope.openLine == scope.closeLine
		&& /\(\s+/.test(originalCode)
		&& /\s+\)\s+AS\b/i.test(originalCode);

	if (collapsedWidth >= maxAlignWidth
		&& item.tokens
		&& item.tokens.length > 0
		&& (scope.openLine < scope.closeLine || alreadyCollapsedWithOuterGap)) {
		sqlFormatMutations.add_token_replacement(mutations, item.tokens[0].id, collapsedText);
		for (var tokenIndex = 1; tokenIndex < item.tokens.length; tokenIndex++) {
			sqlFormatMutations.add_token_omission(mutations, item.tokens[tokenIndex].id);
		}
		var endLine = document.lines[item.endLine];
		if (endLine && endLine.hasTrailingComment && item.endLine != item.startLine) {
			sqlFormatMutations.add_line_comment_move(mutations, item.endLine, item.startLine);
		}
		if (item.endLine > item.startLine) {
			for (var omittedLine = item.startLine + 1; omittedLine <= item.endLine; omittedLine++) {
				sqlFormatMutations.add_line_omission(mutations, omittedLine);
			}
		}
		return;
	}

	if (scope.openLine >= scope.closeLine) {
		return;
	}

	for (var lineIndex = scope.openLine + 1; lineIndex < scope.closeLine; lineIndex++) {
		sqlFormatMutations.add_line_indent(mutations, lineIndex, itemIndent + '    ');
	}
	sqlFormatMutations.add_line_indent(mutations, scope.closeLine, itemIndent);

	var asToken = first_word_after_scope_close(document, scope, 'AS');
	if (asToken) {
		sqlFormatMutations.add_spacing_before_token(
			mutations,
			asToken.id,
			function_item_alias_spacing(document, nodes, mutations, item, itemIndent)
		);
	}
}

	function line_starts_with_leading_separator(document, item) {
		var line = document && item ? document.lines[item.startLine] : null;
		return line && /^\s*,/.test(String(line.codeText || ''));
	}

	function select_span_by_id(nodes, ownerScopeId) {
		var spans = nodes && nodes.selectSpans ? nodes.selectSpans : [];
		for (var i = 0; i < spans.length; i++) {
			if (spans[i].id == ownerScopeId) {
				return spans[i];
			}
		}
		return null;
	}

	function is_first_item_in_owner(nodes, item) {
		var items = nodes && nodes.selectItems ? nodes.selectItems : [];
		for (var i = 0; i < items.length; i++) {
			if (items[i].ownerScopeId != item.ownerScopeId) {
				continue;
			}
			return items[i].id == item.id;
		}
		return false;
	}

	function should_join_select_header_first_item(document, nodes, item) {
		if (!item || item.ownerKind != 'selectList' || !is_first_item_in_owner(nodes, item)) {
			return false;
		}
		if (item.tokens
			&& item.tokens.length > 0
			&& item.tokens[0].type == 'word'
			&& item.tokens[0].value.toUpperCase() == 'CASE') {
			return false;
		}

		var span = select_span_by_id(nodes, item.ownerScopeId);
		var headerLine = span ? document.lines[span.startLine] : null;
		if (!headerLine
			|| headerLine.hasTrailingComment
			|| item.startLine != span.startLine + 1
			|| headerLine.codeTokens.length != 1
			|| headerLine.codeTokens[0].type != 'word'
			|| headerLine.codeTokens[0].value.toUpperCase() != 'SELECT') {
			return false;
		}

		return true;
	}

		function nearest_group_by_span_before_token(nodes, token) {
		var spans = nodes && nodes.selectSpans ? nodes.selectSpans : [];
		var match = null;

		for (var i = 0; i < spans.length; i++) {
			if (spans[i].kind != 'groupByList' || spans[i].endTokenIndex >= token.index) {
				continue;
			}
			if (!match || spans[i].endTokenIndex > match.endTokenIndex) {
				match = spans[i];
			}
		}

		return match;
	}

	function line_has_code_before_token_except(document, token, ignoredToken) {
		var line = token && document.lines[token.line];
		if (!line) {
			return false;
		}

		for (var i = 0; i < line.codeTokens.length; i++) {
			if (line.codeTokens[i].index >= token.index) {
				return false;
			}
			if (ignoredToken && line.codeTokens[i].id == ignoredToken.id) {
				continue;
			}
			return true;
		}

		return false;
	}

	function apply_group_by_extension_mutations(document, nodes, mutations) {
		var tokens = sqlFormatNavigation.active_tokens(document);

		for (var i = 0; i < tokens.length; i++) {
			if (!sqlGroupByExtension.is_start(tokens, i)) {
				continue;
			}

			var token = tokens[i];
			var span = nearest_group_by_span_before_token(nodes, token);
			if (!span) {
				continue;
			}

			var previous = tokens[i - 1];
			var leadingComma = previous
				&& previous.type == 'punctuation'
				&& previous.value == ','
				? previous
				: null;
			var indent = structured_list_indent(document, nodes, span.id, span.kind) + ' ';

			if (leadingComma) {
				sqlFormatMutations.add_token_omission(mutations, leadingComma.id);
			}
			if (line_has_code_before_token_except(document, token, leadingComma)) {
				sqlFormatMutations.add_line_break_before_token(mutations, token.id, indent, '');
			} else {
				sqlFormatMutations.add_line_indent(mutations, token.line, indent);
			}
		}
	}

	function apply_select_list_mutations(document, nodes, mutations, config) {
	if (!document || !nodes || !mutations || !config || config.commaStyle != 'leading') {
		return;
	}

	for (var i = 0; i < (nodes.selectItems || []).length; i++) {
			var item = nodes.selectItems[i];
			var nextItem = nodes.selectItems[i + 1];
			if (should_join_select_header_first_item(document, nodes, item)) {
				sqlFormatMutations.add_line_join(mutations, item.startLine, '  ');
			}
			if (has_select_hint_line(document, item)) {
			sqlFormatMutations.add_line_indent(mutations, item.startLine, structured_list_indent(document, nodes, item.ownerScopeId, item.ownerKind) + ' ');
		}
		if (has_select_header_comment_line(document, nodes, item)) {
			sqlFormatMutations.add_line_indent(mutations, item.startLine, structured_list_indent(document, nodes, item.ownerScopeId, item.ownerKind) + ' ');
		}
		if (line_starts_with_leading_separator(document, item)) {
			sqlFormatMutations.add_line_indent(mutations, item.startLine, structured_list_indent(document, nodes, item.ownerScopeId, item.ownerKind));
		}
		apply_between_item_comment_indents(document, nodes, mutations, item, nextItem);
		apply_multiline_function_item_mutations(document, nodes, mutations, item, config);
		if (!item.separatorId) {
			continue;
		}

		var separator = find_separator_node(nodes, item.separatorId);
		var nextItem = nodes.selectItems[i + 1];
		if (!is_structured_list_separator(separator)
			|| !nextItem
			|| nextItem.ownerScopeId != item.ownerScopeId) {
			continue;
		}

		if (separator.line == nextItem.startLine) {
			var sameLine = document.lines[separator.line];
			var beforeSeparator = sameLine ? sameLine.raw.slice(0, separator.column).replace(/^\s+|\s+$/g, '') : '';
			if (beforeSeparator == '') {
				continue;
			}
			sqlFormatMutations.add_separator_move(mutations, separator.id, {
				placement: 'removed'
			});
			sqlFormatMutations.add_line_break_before_token(
				mutations,
				nextItem.tokens[0].id,
				structured_list_indent(document, nodes, item.ownerScopeId, separator.ownerKind),
				','
			);
		} else {
			var separatorLine = document.lines[separator.line];
			if (!separatorLine || !/,\s*$/.test(separatorLine.codeText)) {
				continue;
			}

			sqlFormatMutations.add_separator_move(mutations, separator.id, {
				lineIndex: nextItem.startLine,
				placement: 'linePrefix',
				text: ',',
				indentText: structured_list_indent(document, nodes, item.ownerScopeId, separator.ownerKind)
			});
		}
	}

	apply_group_by_extension_mutations(document, nodes, mutations);
	apply_select_as_alignment_mutations(document, nodes, mutations, config);
}

exports.apply_select_list_mutations = apply_select_list_mutations;
