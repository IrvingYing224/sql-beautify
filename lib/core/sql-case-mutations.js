var sqlFormatUtils = require('./sql-format-utils');
var sqlFormatMutations = require('./sql-format-mutations');
var sqlFormatNavigation = require('./sql-format-navigation');
var sqlScopeModel = require('./sql-scope-model');
var sqlTokenRenderer = require('./sql-token-renderer');
var repeat_space = sqlFormatUtils.repeat_space;
var expand_tabs_for_width = sqlFormatUtils.expand_tabs_for_width;

function select_item_for_case_node(nodes, caseNode) {
	for (var i = 0; i < (nodes.selectItems || []).length; i++) {
		var item = nodes.selectItems[i];
		if (caseNode.caseKeywordToken
			&& caseNode.caseKeywordToken.index >= item.startTokenIndex
			&& caseNode.caseKeywordToken.index <= item.endTokenIndex
			&& (item.ownerKind == 'selectList' || item.ownerKind == 'groupByList' || item.ownerKind == 'orderByList')) {
			return item;
		}
	}
	return null;
}

function select_span_for_item(nodes, item) {
	for (var s = 0; s < (nodes.selectSpans || []).length; s++) {
		if (nodes.selectSpans[s].id == item.ownerScopeId) {
			return nodes.selectSpans[s];
		}
	}
	return null;
}

function select_base_indent(document, selectSpan) {
	var baseIndent = '';
	if (selectSpan) {
		var selectLine = document.lines[selectSpan.startLine];
		baseIndent = selectLine ? String(selectLine.raw || '').match(/^\s*/)[0] : '';
		var queryScope = sqlScopeModel.find_owner_scope(document.scopes || [], {
			line: selectSpan.startLine,
			tokenIndex: selectSpan.startTokenIndex
		}, 'query');
		if (queryScope && queryScope.id != 0 && typeof queryScope.bodyIndent == 'string') {
			baseIndent = queryScope.bodyIndent;
		}
	}
	return baseIndent;
}

function case_base_indent(document, nodes, caseNode) {
	var scopeId = caseNode.scopeId;
	var functionIndent = function_case_indent(document, nodes, caseNode);

	if (functionIndent != null) {
		return functionIndent;
	}

	var item = select_item_for_case_node(nodes, caseNode);
	if (item) {
		var selectSpan = select_span_for_item(nodes, item);
		var baseIndent = select_base_indent(document, selectSpan);
		if (item.ownerKind == 'orderByList') {
			return baseIndent + '          ';
		}
		if (item.ownerKind == 'groupByList') {
			return baseIndent + '         ';
		}
		return item.id == 'selectItem:0'
			? baseIndent + '       '
			: baseIndent + '        ';
	}

	var line = document.lines[caseNode.startLine];
	return line ? String(line.raw || '').match(/^\s*/)[0] : '';
}

function has_code_before_token_on_line(document, token) {
	var line = token && document.lines[token.line];
	if (!line) {
		return false;
	}
	var before = line.raw.slice(0, token.column).replace(/^\s+|\s+$/g, '');
	if (/^,$/.test(before)) {
		return false;
	}
	return before != '';
}

function set_keyword_layout(document, mutations, token, indentText) {
	if (!token) {
		return;
	}

	if (has_code_before_token_on_line(document, token)) {
		sqlFormatMutations.add_line_break_before_token(mutations, token.id, indentText, '');
	} else {
		sqlFormatMutations.add_line_indent(mutations, token.line, indentText);
	}
}

function first_word_after_token_on_same_line(document, token, word) {
	if (!token) {
		return null;
	}

	for (var i = token.index + 1; i < document.tokens.length; i++) {
		var current = document.tokens[i];
		if (current.line != token.line) {
			return null;
		}
		if (current.type == 'whitespace' || current.type == 'newline') {
			continue;
		}
		if (current.type == 'word' && current.value.toUpperCase() == word) {
			return current;
		}
	}

	return null;
}

function is_nested_case_node(document, caseNode) {
	var scope = sqlFormatNavigation.scope_by_id(document, caseNode.scopeId);
	var parent = scope ? sqlFormatNavigation.scope_by_id(document, scope.parentScopeId) : null;
	return parent && parent.kind == 'caseExpr';
}

function normalized_prefix_before_token(document, token) {
	var line = token ? document.lines[token.line] : null;
	if (!line) {
		return '';
	}

	return String(line.raw || '').slice(0, token.column)
		.replace(/^(\s*select)\s+/i, '$1  ')
		.replace(/([A-Za-z_][A-Za-z0-9_]*)\s+\(/g, '$1(')
		.replace(/\(\s+/g, '(');
}

function select_item_prefix_before_case(document, nodes, caseNode) {
	var item = select_item_for_case_node(nodes, caseNode);
	if (!item || !caseNode.caseKeywordToken) {
		return null;
	}

	var owner = sqlScopeModel.find_owner_scope(document.scopes || [], caseNode.caseKeywordToken, 'functionCall');
	if (!owner || owner.openLine != caseNode.caseKeywordToken.line) {
		return null;
	}

	var selectSpan = select_span_for_item(nodes, item);
	var baseIndent = select_base_indent(document, selectSpan);
	var listPrefix = item.ownerKind == 'groupByList'
		? baseIndent + '         '
		: item.id == 'selectItem:0'
			? baseIndent + 'SELECT  '
			: baseIndent + '       ,';
	var beforeCaseTokens = [];
	for (var i = 0; i < (item.tokens || []).length; i++) {
		if (item.tokens[i].index >= caseNode.caseKeywordToken.index) {
			break;
		}
		beforeCaseTokens.push(item.tokens[i]);
	}
	var beforeCaseText = render_token_values(document, beforeCaseTokens, null);
	if (beforeCaseText == '') {
		return listPrefix;
	}
	if (/[ \t(.,\[]$/.test(listPrefix)) {
		return listPrefix + beforeCaseText + (/[ \t(.,\[]$/.test(beforeCaseText) ? '' : ' ');
	}
	return listPrefix + ' ' + beforeCaseText + (/[ \t(.,\[]$/.test(beforeCaseText) ? '' : ' ');
}

function function_case_indent(document, nodes, caseNode) {
	if (!caseNode || !caseNode.caseKeywordToken) {
		return null;
	}

	var selectPrefix = select_item_prefix_before_case(document, nodes, caseNode);
	if (selectPrefix != null) {
		return repeat_space(expand_tabs_for_width(selectPrefix).length);
	}

	var owner = sqlScopeModel.find_owner_scope(document.scopes || [], caseNode.caseKeywordToken, 'functionCall');
	if (!owner || owner.openLine != caseNode.caseKeywordToken.line) {
		return null;
	}

	for (var scope = owner; scope; scope = sqlFormatNavigation.scope_by_id(document, scope.parentScopeId)) {
		if (scope.kind == 'conditionBlock') {
			return null;
		}
	}

	return repeat_space(expand_tabs_for_width(normalized_prefix_before_token(document, caseNode.caseKeywordToken)).length);
}

function nested_case_value_for_branch(document, nodes, caseNode, branch) {
	var thenTokens = branch && branch.thenTokens ? branch.thenTokens : [];
	if (thenTokens.length == 0) {
		return null;
	}

	var startIndex = thenTokens[0].index;
	var endIndex = thenTokens[thenTokens.length - 1].index;
	var cases = nodes && nodes.caseExpressions ? nodes.caseExpressions : [];

	for (var i = 0; i < cases.length; i++) {
		var nested = cases[i];
		var scope = sqlFormatNavigation.scope_by_id(document, nested.scopeId);
		if (nested.scopeId == caseNode.scopeId
			|| !scope
			|| scope.parentScopeId != caseNode.scopeId
			|| nested.caseKeywordToken.index < startIndex
			|| nested.caseKeywordToken.index > endIndex) {
			continue;
		}
		return nested;
	}

	return null;
}

function apply_nested_case_value_joins(document, nodes, caseNode, branch, mutations) {
	var nested = nested_case_value_for_branch(document, nodes, caseNode, branch);
	if (!nested || !branch.thenKeywordToken || nested.startLine <= branch.thenKeywordToken.line) {
		return;
	}

	for (var lineIndex = nested.startLine; lineIndex <= nested.endLine; lineIndex++) {
		sqlFormatMutations.add_line_join(mutations, lineIndex, ' ');
	}
}

function omit_blank_lines_inside_case(document, caseNode, mutations) {
	for (var lineIndex = caseNode.startLine + 1; lineIndex < caseNode.endLine; lineIndex++) {
		if (document.lines[lineIndex] && document.lines[lineIndex].isBlank) {
			sqlFormatMutations.add_line_omission(mutations, lineIndex);
		}
	}
}

function condition_segment_before_case(document, nodes, caseNode) {
	var match = null;
	for (var i = 0; i < (nodes.conditionBlocks || []).length; i++) {
		var block = nodes.conditionBlocks[i];
		for (var s = 0; s < (block.segments || []).length; s++) {
			var segment = block.segments[s];
			if ((segment.kind != 'connector' && segment.kind != 'clause')
				|| !segment.tokens
				|| segment.tokens.length == 0) {
				continue;
			}
			if (segment.lineIndex != caseNode.startLine || segment.tokens[0].index >= caseNode.caseKeywordToken.index) {
				continue;
			}
			for (var t = 0; t < segment.tokens.length; t++) {
				if (segment.tokens[t].index == caseNode.caseKeywordToken.index) {
					if (!match || segment.tokens[0].index > match.tokens[0].index) {
						match = segment;
					}
				}
			}
		}
	}
	return match;
}

function case_follows_condition_clause_keyword(document, nodes, caseNode) {
	var segment = condition_segment_before_case(document, nodes, caseNode);
	if (!segment || !segment.tokens || segment.tokens.length < 2) {
		return false;
	}
	return segment.tokens[1].index == caseNode.caseKeywordToken.index;
}

function render_tokens_between(tokens, startToken, endToken) {
	var result = [];
	for (var i = 0; i < (tokens || []).length; i++) {
		if (startToken && tokens[i].index < startToken.index) {
			continue;
		}
		if (endToken && tokens[i].index >= endToken.index) {
			break;
		}
		result.push(tokens[i].value);
	}
	return result.join(' ').replace(/\s+([,.;)])/g, '$1').replace(/([(])\s+/g, '$1');
}

function condition_case_base_indent(document, nodes, caseNode, baseIndent) {
	var segment = condition_segment_before_case(document, nodes, caseNode);
	if (!segment) {
		return baseIndent;
	}
	var prefix = render_tokens_between(segment.tokens, segment.tokens[0], caseNode.caseKeywordToken);
	if (prefix == '') {
		return baseIndent;
	}
	if (segment.kind == 'clause' && case_follows_condition_clause_keyword(document, nodes, caseNode)) {
		return String(baseIndent || '') + repeat_space(prefix.length + 1);
	}
	if (segment.kind == 'connector' && /^(AND|OR)$/i.exec(prefix)) {
		return String(baseIndent || '') + repeat_space(prefix.length + (baseIndent == '' ? 3 : 1));
	}
	if (segment.kind == 'connector' && /\($/.test(prefix)) {
		if (/\b(AND|OR|NOT|IN|EXISTS|IF) \($/i.exec(prefix)) {
			return String(baseIndent || '') + repeat_space(prefix.length);
		}
		return String(baseIndent || '') + repeat_space(prefix.length + 2);
	}
	if (/\($/.test(prefix)) {
		if (/\b(AND|OR|NOT|IN|EXISTS|IF) \($/i.exec(prefix)) {
			return String(baseIndent || '') + repeat_space(prefix.length);
		}
		return String(baseIndent || '') + repeat_space(prefix.length - 1);
	}
	return String(baseIndent || '') + repeat_space(prefix.length + (/\($/.test(prefix) ? 2 : 3));
}

function case_start_indent(document, nodes, caseNode, baseIndent) {
	var segment = condition_segment_before_case(document, nodes, caseNode);
	if (segment) {
		return condition_case_base_indent(document, nodes, caseNode, baseIndent);
	}
	return baseIndent;
}

function token_indexes(tokens) {
	var lookup = {};
	for (var i = 0; i < (tokens || []).length; i++) {
		lookup[String(tokens[i].index)] = true;
	}
	return lookup;
}

function scope_is_inside_tokens(scope, tokens) {
	if (!scope || !tokens || tokens.length == 0) {
		return false;
	}

	return scope.startTokenIndex >= tokens[0].index
		&& scope.endTokenIndex <= tokens[tokens.length - 1].index;
}

function token_in_token_list(token, tokens) {
	for (var i = 0; i < (tokens || []).length; i++) {
		if (tokens[i].index == token.index) {
			return true;
		}
	}
	return false;
}

function token_in_case_value(document, token) {
	var cases = document && document.nodes ? document.nodes.caseExpressions : [];
	for (var i = 0; i < (cases || []).length; i++) {
		var caseNode = cases[i];
		for (var b = 0; b < (caseNode.branches || []).length; b++) {
			if (token_in_token_list(token, caseNode.branches[b].thenTokens)) {
				return true;
			}
		}
		if (token_in_token_list(token, caseNode.elseTokens)) {
			return true;
		}
	}
	return false;
}

function owner_function_scope(document, token) {
	var scopes = document && document.scopes ? document.scopes : [];
	var match = null;
	for (var i = 0; i < scopes.length; i++) {
		var scope = scopes[i];
		if (scope.kind != 'functionCall'
			|| token.index < scope.startTokenIndex
			|| token.index > scope.endTokenIndex) {
			continue;
		}
		if (!match || scope.startTokenIndex >= match.startTokenIndex) {
			match = scope;
		}
	}
	return match;
}

function token_inside_function_named(document, token, name) {
	var scope = owner_function_scope(document, token);
	if (!scope || typeof scope.startTokenIndex != 'number') {
		return false;
	}
	var ownerToken = document.tokens[scope.startTokenIndex - 1];
	return ownerToken
		&& ownerToken.type == 'word'
		&& ownerToken.value.toUpperCase() == String(name || '').toUpperCase();
}

function is_originally_compact_case_function_plus(document, token) {
	if (!token
		|| token.type != 'operator'
		|| token.value != '+'
		|| !token_in_case_value(document, token)) {
		return false;
	}

	var previous = sqlFormatNavigation.previous_code_token(document, token);
	var next = sqlFormatNavigation.next_code_token(document, token);
	var afterNext = sqlFormatNavigation.next_code_token(document, next);

	return previous
		&& previous.type == 'punctuation'
		&& previous.value == ')'
		&& next
		&& next.type == 'word'
		&& afterNext
		&& afterNext.type == 'punctuation'
		&& afterNext.value == '('
		&& original_gap_between(document, previous, token) == ''
		&& original_gap_between(document, token, next) == '';
}

function follows_originally_compact_case_function_plus(document, previousToken, token) {
	var next = sqlFormatNavigation.next_code_token(document, previousToken);
	return is_originally_compact_case_function_plus(document, previousToken)
		&& next
		&& token
		&& next.index == token.index;
}

function then_follows_when_close_paren(document, branch) {
	var thenToken = branch && branch.thenKeywordToken;
	var previous = sqlFormatNavigation.previous_code_token(document, thenToken);
	var whenTokenIndexes = token_indexes(branch ? branch.whenTokens : []);

	return previous
		&& previous.line == thenToken.line
		&& previous.type == 'punctuation'
		&& previous.value == ')'
		&& whenTokenIndexes[String(previous.index)] === true;
}

function then_comment_has_following_value(document, branch) {
	if (!branch || !branch.thenKeywordToken || !branch.thenTokens || branch.thenTokens.length == 0) {
		return false;
	}
	var line = document.lines[branch.thenKeywordToken.line];
	return line
		&& line.hasTrailingComment
		&& branch.thenTokens[0].line != branch.thenKeywordToken.line;
}

function can_join_then_line_to_when(document, branch, wrapValues) {
	if (wrapValues
		|| !branch
		|| !branch.whenKeywordToken
		|| !branch.thenKeywordToken
		|| !branch.thenTokens
		|| branch.thenTokens.length == 0
		|| branch.thenKeywordToken.line == branch.whenKeywordToken.line
		|| branch.thenTokens[0].line != branch.thenKeywordToken.line
		|| sorted_token_lines(branch.whenTokens || []).length > 1) {
		return false;
	}
	var whenLine = document.lines[branch.whenKeywordToken.line];
	var thenLine = document.lines[branch.thenKeywordToken.line];
	return (!whenLine || !whenLine.hasTrailingComment)
		&& (!thenLine || !thenLine.hasTrailingComment);
}

function can_join_else_value_line(document, caseNode, wrapValues) {
	if (wrapValues
		|| !caseNode
		|| case_has_multiline_when(caseNode)
		|| !caseNode.elseKeywordToken
		|| !caseNode.elseTokens
		|| caseNode.elseTokens.length == 0
		|| caseNode.elseTokens[0].line == caseNode.elseKeywordToken.line) {
		return false;
	}
	var elseLine = document.lines[caseNode.elseKeywordToken.line];
	var valueLine = document.lines[caseNode.elseTokens[0].line];
	return (!elseLine || !elseLine.hasTrailingComment)
		&& (!valueLine || !valueLine.hasTrailingComment);
}

function case_has_multiline_when(caseNode) {
		for (var i = 0; i < (caseNode.branches || []).length; i++) {
			var branch = caseNode.branches[i];
			for (var t = 0; t < (branch.whenTokens || []).length; t++) {
			if (branch.whenTokens[t].line != branch.whenKeywordToken.line) {
				return true;
			}
		}
	}
		return false;
	}

function tokens_are_single_function_call(document, tokens) {
	if (!tokens || tokens.length < 3 || tokens[0].type != 'word') {
		return false;
	}
	for (var i = 0; i < (document.scopes || []).length; i++) {
		var scope = document.scopes[i];
		if (scope.kind == 'functionCall'
			&& scope.startTokenIndex == tokens[1].index
			&& scope.endTokenIndex == tokens[tokens.length - 1].index) {
			return true;
		}
	}
	return false;
}

function case_should_wrap_values(document, caseNode, config) {
	var wrapLimit = config && config.caseWhenThenWrapLength ? parseInt(config.caseWhenThenWrapLength, 10) : 50;
	if (!wrapLimit || wrapLimit < 1) {
		wrapLimit = 50;
		}

	for (var i = 0; i < (caseNode.branches || []).length; i++) {
		var branch = caseNode.branches[i];
		var whenLines = sorted_token_lines(branch.whenTokens || []);
		var whenText = render_token_values(document, branch.whenTokens || [], null);
		var thenText = render_token_values(document, branch.thenTokens || [], null);
		if ((whenLines.length <= 1 && whenText.length > wrapLimit)
			|| (thenText.length > wrapLimit && !tokens_are_single_function_call(document, branch.thenTokens))) {
			return true;
		}
	}

		return false;
	}

function original_gap_between(document, previousToken, token) {
	if (!document || !previousToken || !token || previousToken.line != token.line) {
		return '';
	}
	return String(document.source || '').slice(previousToken.end, token.start);
}

function render_token_values(document, tokens, preserveCommaGapTokenIndexes) {
	return sqlTokenRenderer.render_tokens(document, tokens, {
		spaceBeforeInParen: true,
		preserveCommaGapTokenIndexes: preserveCommaGapTokenIndexes,
		preserveCommaGapExceptFunctionName: 'COALESCE',
		compactOperatorToken: is_originally_compact_case_function_plus,
		followsCompactOperator: follows_originally_compact_case_function_plus,
		unaryNumberMode: 'case'
	});
}

function tokens_on_line(tokens, lineIndex) {
	var result = [];
	for (var i = 0; i < (tokens || []).length; i++) {
		if (tokens[i].line == lineIndex) {
			result.push(tokens[i]);
		}
	}
	return result;
}

function sorted_token_lines(tokens) {
	var seen = {};
	var lines = [];
	for (var i = 0; i < (tokens || []).length; i++) {
		var key = String(tokens[i].line);
		if (!seen[key]) {
			seen[key] = true;
			lines.push(tokens[i].line);
		}
	}
	return lines.sort(function(a, b) {
		return a - b;
	});
}

function direct_scope_for_case_when_line(document, caseNode, branch, lineIndex) {
	var scopes = document.scopes || [];
	for (var i = 0; i < scopes.length; i++) {
		var scope = scopes[i];
		if (scope.kind == 'inList'
			&& scope.parentScopeId == caseNode.scopeId
			&& scope_is_inside_tokens(scope, branch.whenTokens)
			&& typeof scope.openLine == 'number'
			&& typeof scope.closeLine == 'number'
			&& lineIndex >= scope.openLine
			&& lineIndex <= scope.closeLine) {
			return scope;
		}
	}
	return null;
}

function tokens_between_same_line(document, startToken, endToken) {
	var result = [];
	if (!document || !startToken || !endToken || startToken.line != endToken.line) {
		return result;
	}

	for (var i = startToken.index + 1; i < endToken.index; i++) {
		var token = document.tokens[i];
		if (token && token.isCode && token.line == startToken.line) {
			result.push(token);
		}
	}
	return result;
}

function add_case_width(document, widths, indentText, tokens, preserveCommaGapTokenIndexes) {
	var text = render_token_values(document, tokens, preserveCommaGapTokenIndexes);
	if (text != '') {
		widths.push(String(indentText || '').length + text.length);
	}
}

function case_alias_spacing(document, nodes, caseNode, asToken, baseIndent, branchIndent, valueIndent, config, wrapValues) {
		var widths = [];
		var firstBranch = caseNode.branches && caseNode.branches.length > 0 ? caseNode.branches[0] : null;
		var maxAlignWidth = config && config.maxAlignWidth ? config.maxAlignWidth : 150;
		var multilineWhen = case_has_multiline_when(caseNode) || wrapValues;
		var valueTokenIndexes = token_indexes(caseNode.elseTokens || []);

	for (var valueBranchIndex = 0; valueBranchIndex < (caseNode.branches || []).length; valueBranchIndex++) {
		var valueTokens = caseNode.branches[valueBranchIndex].thenTokens || [];
		for (var valueTokenIndex = 0; valueTokenIndex < valueTokens.length; valueTokenIndex++) {
			valueTokenIndexes[String(valueTokens[valueTokenIndex].index)] = true;
		}
	}

	if (firstBranch && caseNode.caseKeywordToken) {
		add_case_width(
			document,
			widths,
			baseIndent,
			[caseNode.caseKeywordToken].concat(tokens_between_same_line(document, caseNode.caseKeywordToken, firstBranch.whenKeywordToken)),
			valueTokenIndexes
		);
	} else if (caseNode.caseKeywordToken) {
		add_case_width(document, widths, baseIndent, [caseNode.caseKeywordToken], valueTokenIndexes);
	}

	for (var b = 0; b < (caseNode.branches || []).length; b++) {
			var branch = caseNode.branches[b];
			var whenLines = sorted_token_lines([branch.whenKeywordToken].concat(branch.whenTokens || []));
			var thenCommentBreaksValue = then_comment_has_following_value(document, branch);
			var thenStaysWithWhen = branch.thenKeywordToken
				&& !wrapValues
				&& !thenCommentBreaksValue
				&& branch.thenKeywordToken.line == branch.whenKeywordToken.line;
			var thenJoinsWithWhen = can_join_then_line_to_when(document, branch, wrapValues);
			var thenStaysWithClose = !wrapValues && then_follows_when_close_paren(document, branch);

			for (var w = 0; w < whenLines.length; w++) {
				var lineIndex = whenLines[w];
				var scope = direct_scope_for_case_when_line(document, caseNode, branch, lineIndex);
				var indent = valueIndent;
				var tokens = tokens_on_line(branch.whenTokens, lineIndex);

			if (lineIndex == branch.whenKeywordToken.line) {
				indent = branchIndent;
				tokens = [branch.whenKeywordToken].concat(tokens);
				} else if (scope && lineIndex > scope.openLine && lineIndex < scope.closeLine) {
					indent = valueIndent + '    ';
				}
				if (scope && scope.openLine != scope.closeLine && lineIndex == scope.openLine) {
					tokens = tokens.filter(function(token) {
						return token.index <= scope.openTokenIndex;
					});
				}

					if (((thenStaysWithWhen || thenStaysWithClose)
							&& branch.thenKeywordToken
							&& branch.thenKeywordToken.line == lineIndex)
						|| (thenJoinsWithWhen && lineIndex == branch.whenKeywordToken.line)) {
					if (thenStaysWithWhen || thenJoinsWithWhen) {
						var whenText = render_token_values(document, tokens, valueTokenIndexes);
						var thenTokens = nested_case_value_for_branch(document, nodes, caseNode, branch)
							? branch.thenTokens
							: (thenJoinsWithWhen ? branch.thenTokens : tokens_on_line(branch.thenTokens, lineIndex));
						var thenText = render_token_values(document, [branch.thenKeywordToken].concat(thenTokens), valueTokenIndexes);
						widths.push(String(indent || '').length + whenText.length + case_when_then_spacing(branch, caseNode).length + thenText.length);
						continue;
						}
						tokens = tokens.concat([branch.thenKeywordToken], tokens_on_line(branch.thenTokens, lineIndex));
					}
				if (scope
					&& lineIndex == scope.closeLine
					&& branch.thenKeywordToken
					&& branch.thenKeywordToken.line == scope.closeLine + 1) {
					tokens = tokens.concat([branch.thenKeywordToken], branch.thenTokens || []);
				}

				add_case_width(document, widths, indent, tokens, valueTokenIndexes);
			}

			if (branch.thenKeywordToken && !thenStaysWithWhen && !thenJoinsWithWhen && !thenStaysWithClose) {
				add_case_width(
					document,
					widths,
				valueIndent,
				[branch.thenKeywordToken].concat(tokens_on_line(branch.thenTokens, branch.thenKeywordToken.line)),
					valueTokenIndexes
				);
			}
			if (thenCommentBreaksValue) {
				add_case_width(document, widths, valueIndent, branch.thenTokens || [], valueTokenIndexes);
			}
		}

	if (caseNode.elseKeywordToken) {
		if (multilineWhen && caseNode.elseTokens && caseNode.elseTokens.length > 0) {
			add_case_width(document, widths, branchIndent, [caseNode.elseKeywordToken], valueTokenIndexes);
			add_case_width(document, widths, valueIndent, caseNode.elseTokens, valueTokenIndexes);
		} else {
			add_case_width(document, widths, branchIndent, [caseNode.elseKeywordToken].concat(caseNode.elseTokens || []), valueTokenIndexes);
		}
	}

	var beforeAsTokens = [caseNode.endKeywordToken].concat(tokens_between_same_line(document, caseNode.endKeywordToken, asToken));
	var beforeAsWidth = String(baseIndent || '').length + render_token_values(document, beforeAsTokens, valueTokenIndexes).length;
	var maxWidth = beforeAsWidth;
	for (var i = 0; i < widths.length; i++) {
		if (widths[i] > maxWidth && widths[i] < maxAlignWidth) {
			maxWidth = widths[i];
		}
	}

	var spacingWidth = maxWidth + 1 - beforeAsWidth;
	return repeat_space(spacingWidth < 1 ? 1 : spacingWidth);
}

function apply_case_when_scope_indents(document, caseNode, branch, mutations, valueIndent) {
	var scopes = document.scopes || [];
	for (var i = 0; i < scopes.length; i++) {
		var scope = scopes[i];
		if (scope.kind != 'inList'
			|| scope.parentScopeId != caseNode.scopeId
			|| !scope_is_inside_tokens(scope, branch.whenTokens)
			|| typeof scope.openLine != 'number'
			|| typeof scope.closeLine != 'number'
			|| scope.openLine == scope.closeLine) {
			continue;
		}

		for (var lineIndex = scope.openLine + 1; lineIndex < scope.closeLine; lineIndex++) {
			sqlFormatMutations.add_line_indent(mutations, lineIndex, valueIndent + '    ');
		}
			sqlFormatMutations.add_line_indent(mutations, scope.closeLine, valueIndent);
		}
	}

	function apply_case_when_inlist_layout(document, caseNode, branch, mutations, valueIndent) {
		var scopes = document.scopes || [];
		for (var i = 0; i < scopes.length; i++) {
			var scope = scopes[i];
			if (scope.kind != 'inList'
				|| scope.parentScopeId != caseNode.scopeId
				|| !scope_is_inside_tokens(scope, branch.whenTokens)
				|| typeof scope.openLine != 'number'
				|| typeof scope.closeLine != 'number'
				|| scope.openLine == scope.closeLine) {
				continue;
			}

			for (var t = 0; t < (branch.whenTokens || []).length; t++) {
				var token = branch.whenTokens[t];
				if (token.index > scope.openTokenIndex
					&& token.index < scope.closeTokenIndex
					&& token.line == scope.openLine) {
					sqlFormatMutations.add_line_break_before_token(mutations, token.id, valueIndent + '    ', '');
					break;
				}
			}

			if (branch.thenKeywordToken
				&& branch.thenKeywordToken.line == scope.closeLine + 1
				&& document.lines[scope.closeLine]
				&& !document.lines[scope.closeLine].hasTrailingComment) {
				sqlFormatMutations.add_line_join(mutations, branch.thenKeywordToken.line, ' ');
			}
		}
	}

	function case_when_then_spacing(branch, caseNode) {
	var maxWhenWidth = 0;
	for (var i = 0; i < (caseNode.branches || []).length; i++) {
		var current = caseNode.branches[i];
		if (!current.thenKeywordToken
			|| !current.whenKeywordToken
			|| current.thenKeywordToken.line != current.whenKeywordToken.line) {
			continue;
		}
		var whenText = render_token_values(
			null,
			[current.whenKeywordToken].concat(current.whenTokens || []),
			null
		);
		if (whenText.length > maxWhenWidth) {
			maxWhenWidth = whenText.length;
		}
	}

	var currentText = render_token_values(
		null,
		[branch.whenKeywordToken].concat(branch.whenTokens || []),
		null
	);
	var width = maxWhenWidth - currentText.length + 1;
	return repeat_space(width < 1 ? 1 : width);
}

function apply_case_mutations(document, nodes, mutations, config) {
	if (!document || !nodes || !mutations) {
		return;
	}

	for (var i = 0; i < (nodes.caseExpressions || []).length; i++) {
			var caseNode = nodes.caseExpressions[i];
			if (is_nested_case_node(document, caseNode)) {
				continue;
			}

				var baseIndent = case_base_indent(document, nodes, caseNode);
				var caseIndent = case_start_indent(document, nodes, caseNode, baseIndent);
					var branchIndent = caseIndent + '    ';
					var valueIndent = branchIndent + '    ';
					var wrapValues = case_should_wrap_values(document, caseNode, config);
					var keepCaseWithFunctionPrefix = function_case_indent(document, nodes, caseNode) != null;
					omit_blank_lines_inside_case(document, caseNode, mutations);

				if (caseIndent == baseIndent
					&& !keepCaseWithFunctionPrefix
					&& !case_follows_condition_clause_keyword(document, nodes, caseNode)) {
					set_keyword_layout(document, mutations, caseNode.caseKeywordToken, baseIndent);
				}

				for (var b = 0; b < (caseNode.branches || []).length; b++) {
				var branch = caseNode.branches[b];
				set_keyword_layout(document, mutations, branch.whenKeywordToken, branchIndent);
				if (can_join_then_line_to_when(document, branch, wrapValues)) {
					sqlFormatMutations.add_line_join(mutations, branch.thenKeywordToken.line, ' ');
				}
				apply_case_when_scope_indents(document, caseNode, branch, mutations, valueIndent);
				apply_case_when_inlist_layout(document, caseNode, branch, mutations, valueIndent);
				apply_nested_case_value_joins(document, nodes, caseNode, branch, mutations);
						if (branch.thenKeywordToken && then_comment_has_following_value(document, branch)) {
							sqlFormatMutations.add_line_break_before_token(mutations, branch.thenKeywordToken.id, valueIndent, '');
							sqlFormatMutations.add_line_indent(mutations, branch.thenTokens[0].line, valueIndent);
						} else if (branch.thenKeywordToken && wrapValues) {
							if (branch.whenKeywordToken
								&& branch.thenKeywordToken.line == branch.whenKeywordToken.line) {
							sqlFormatMutations.add_line_break_before_token(mutations, branch.thenKeywordToken.id, valueIndent, '');
						} else {
							set_keyword_layout(document, mutations, branch.thenKeywordToken, valueIndent);
						}
					} else if (branch.thenKeywordToken
						&& branch.whenKeywordToken
						&& branch.thenKeywordToken.line != branch.whenKeywordToken.line
						&& !then_follows_when_close_paren(document, branch)) {
						set_keyword_layout(document, mutations, branch.thenKeywordToken, valueIndent);
					} else if (branch.thenKeywordToken
						&& branch.whenKeywordToken
						&& branch.thenKeywordToken.line == branch.whenKeywordToken.line) {
						sqlFormatMutations.add_spacing_before_token(
							mutations,
						branch.thenKeywordToken.id,
						case_when_then_spacing(branch, caseNode)
					);
				}
			}

		set_keyword_layout(document, mutations, caseNode.elseKeywordToken, branchIndent);
			if (can_join_else_value_line(document, caseNode, wrapValues)) {
				sqlFormatMutations.add_line_join(mutations, caseNode.elseTokens[0].line, ' ');
			}
			if ((wrapValues || case_has_multiline_when(caseNode))
				&& caseNode.elseKeywordToken
				&& caseNode.elseTokens
				&& caseNode.elseTokens.length > 0
				&& caseNode.elseTokens[0].line == caseNode.elseKeywordToken.line) {
				sqlFormatMutations.add_line_break_before_token(mutations, caseNode.elseTokens[0].id, valueIndent, '');
			}
			if (caseNode.elseKeywordToken
				&& caseNode.elseTokens
				&& caseNode.elseTokens.length > 0
				&& caseNode.elseTokens[0].line != caseNode.elseKeywordToken.line) {
				sqlFormatMutations.add_line_indent(mutations, caseNode.elseTokens[0].line, valueIndent);
			}
				set_keyword_layout(document, mutations, caseNode.endKeywordToken, caseIndent);

		var asToken = first_word_after_token_on_same_line(document, caseNode.endKeywordToken, 'AS');
		if (asToken) {
			sqlFormatMutations.add_spacing_before_token(
					mutations,
					asToken.id,
					case_alias_spacing(document, nodes, caseNode, asToken, baseIndent, branchIndent, valueIndent, config, wrapValues)
				);
			}
	}
}

exports.apply_case_mutations = apply_case_mutations;
