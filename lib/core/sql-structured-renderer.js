var sqlFormatMutations = require('./sql-format-mutations');
var sqlFormatNavigation = require('./sql-format-navigation');
var sqlLineModel = require('./sql-line-model');
var sqlOperatorRegistry = require('./sql-operator-registry');
var sqlRenderMoveState = require('./sql-render-move-state');

function line_prefix_indent(moveState, lineIndex) {
	var prefixes = moveState && moveState.prefixesByLine
		? moveState.prefixesByLine[String(lineIndex)]
		: null;

	if (!prefixes || prefixes.length == 0) {
		return null;
	}

	for (var i = 0; i < prefixes.length; i++) {
		if (prefixes[i] && typeof prefixes[i].indentText == 'string') {
			return prefixes[i].indentText;
		}
	}

	return null;
}

function effective_token_indent(document, token, mutations, moveState) {
	if (!token) {
		return '';
	}

	var line = document.lines[token.line];
	var lineMutations = sqlFormatMutations.get_for_line(mutations, token.line);
	var prefixIndent = line_prefix_indent(moveState, token.line);
	var indent = lineMutations.indent
		? lineMutations.indent.indentText
		: (prefixIndent != null)
			? prefixIndent
		: (line ? String(line.raw || '').match(/^\s*/)[0] : '');

	if (!line) {
		return indent;
	}

	for (var i = 0; i < line.tokens.length; i++) {
		var current = line.tokens[i];
		if (current.index > token.index) {
			break;
		}
		if (current.type == 'whitespace' || current.type == 'newline') {
			continue;
		}

		var tokenMutation = sqlFormatMutations.get_for_token(mutations, current.id);
		if (tokenMutation.lineBreakBefore) {
			indent = tokenMutation.lineBreakBefore.indentText;
		}
	}

	return indent;
}

function suffix_after_prefix(value, prefix) {
	value = String(value || '');
	prefix = String(prefix || '');

	if (value.slice(0, prefix.length) == prefix) {
		return value.slice(prefix.length);
	}

	return '';
}

function effective_scope_start_indent(document, scope, mutations, moveState) {
	if (!scope) {
		return '';
	}

	var token = sqlFormatNavigation.token_by_index(document, scope.startTokenIndex);
	return effective_token_indent(document, token, mutations, moveState);
}

function effective_scope_body_indent(document, scope, mutations, moveState) {
	if (scope && scope.kind == 'inList' && scope.closeIndentOwnerKind == 'conditionBlock') {
		return scope.bodyIndent || '';
	}
	var openToken = sqlFormatNavigation.token_by_index(document, scope.openTokenIndex);
	var openIndent = effective_token_indent(document, openToken, mutations, moveState);
	return openIndent + suffix_after_prefix(scope.bodyIndent, scope.openIndent);
}

function effective_scope_close_indent(document, scope, mutations, moveState) {
	if (scope && scope.closeIndentOwnerKind == 'conditionBlock') {
		return scope.closeIndent;
	}

	if (scope && scope.kind == 'query') {
		return effective_scope_start_indent(document, scope, mutations, moveState)
			+ suffix_after_prefix(scope.closeIndent, scope.openIndent);
	}

	var parent = sqlFormatNavigation.scope_by_id(document, scope.parentScopeId);

	if (parent) {
		return effective_scope_start_indent(document, parent, mutations, moveState)
			+ suffix_after_prefix(scope.closeIndent, String(scope.closeIndent || ''));
	}

	return scope.closeIndent;
}

function build_close_indent_by_line(document, mutations, moveState) {
	var lookup = {};
	var scopes = document.scopes || [];

	for (var i = 0; i < scopes.length; i++) {
		var scope = scopes[i];
		if (typeof scope.closeLine != 'number' || typeof scope.closeIndent != 'string') {
			continue;
		}
		var closeIndent = effective_scope_close_indent(document, scope, mutations, moveState);
		var key = String(scope.closeLine);
		if (typeof lookup[key] == 'undefined'
			|| closeIndent.length < lookup[key].length) {
			lookup[key] = closeIndent;
		}
	}

	return lookup;
}

function build_body_indent_by_line(document, mutations, moveState) {
	var lookup = {};
	var scopes = document.scopes || [];

	for (var i = 0; i < scopes.length; i++) {
		var scope = scopes[i];
		if (typeof scope.openLine != 'number'
			|| typeof scope.closeLine != 'number'
				|| typeof scope.bodyIndent != 'string'
				|| scope.closeLine <= scope.openLine) {
			continue;
		}
		var bodyIndent = effective_scope_body_indent(document, scope, mutations, moveState);

		for (var lineIndex = scope.openLine + 1; lineIndex < scope.closeLine; lineIndex++) {
			var key = String(lineIndex);
			if (typeof lookup[key] == 'undefined'
				|| bodyIndent.length > lookup[key].length) {
				lookup[key] = bodyIndent;
			}
		}
	}

	return lookup;
}

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

function token_value(token, mutation) {
	var value = mutation && mutation.replacement ? mutation.replacement.value : token.value;
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

function is_comparison_with_unary_sign(value) {
	return /^(=|<>|!=|>=|<=|>|<)[+-]$/.test(String(value || ''));
}

function is_arithmetic_with_unary_sign(value) {
	return /^[*/%][+-]$/.test(String(value || ''));
}

function is_unary_sign_token(previousToken) {
	if (!previousToken) {
		return true;
	}
	if (previousToken.type == 'operator') {
		return true;
	}
	if (previousToken.type == 'word' && /^(THEN|ELSE|WHEN|IN|AND|OR|NOT|SELECT)$/i.exec(previousToken.value)) {
		return true;
	}
	if (previousToken.type == 'punctuation' && /^(,|\(|\[)$/.test(previousToken.value)) {
		return true;
	}
	return false;
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
	return visible.length == 2 && is_word_token(visible[0], 'GROUP') && is_word_token(visible[1], 'BY');
}

function operator_spacing(token, value, dialect) {
	var lookup = sqlOperatorRegistry.get_operator_lookup(dialect || 'generic');
	var operator = lookup[value] || lookup[token.value];
	return operator ? operator.spacing : 'surround';
}

function previous_operator_has_no_spacing(previousToken, dialect) {
	return previousToken
		&& previousToken.type == 'operator'
		&& (operator_spacing(previousToken, previousToken.value, dialect) == 'none'
			|| is_comparison_with_unary_sign(previousToken.value));
}

function trim_trailing_space(text) {
	return String(text || '').replace(/[ \t]+$/g, '');
}

function original_gap_between(document, previousToken, token) {
	if (!document || !previousToken || !token || previousToken.line != token.line) {
		return '';
	}
	return String(document.source || '').slice(previousToken.end, token.start);
}

function normalized_original_space(document, previousToken, token) {
	return /[ \t]/.test(original_gap_between(document, previousToken, token)) ? ' ' : '';
}

function token_inside_scope_kind(document, token, kind) {
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

function token_inside_inline_query(document, token) {
	var scopes = document && document.scopes ? document.scopes : [];
	for (var i = 0; i < scopes.length; i++) {
		if (scopes[i].kind == 'query'
			&& scopes[i].id != 0
			&& scopes[i].openLine == scopes[i].closeLine
			&& token.index > scopes[i].startTokenIndex
			&& token.index < scopes[i].endTokenIndex) {
			return true;
		}
	}
	return false;
}

function token_opens_inline_query(document, token) {
	var scopes = document && document.scopes ? document.scopes : [];
	for (var i = 0; i < scopes.length; i++) {
		if (scopes[i].kind == 'query'
			&& scopes[i].id != 0
			&& scopes[i].openLine == scopes[i].closeLine
			&& scopes[i].openTokenIndex == token.index) {
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
		if (!match
			|| scope.startTokenIndex >= match.startTokenIndex) {
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
	var openToken = sqlFormatNavigation.token_by_index(document, scope.startTokenIndex);
	var ownerToken = sqlFormatNavigation.previous_code_token(document, openToken);
	return ownerToken
		&& ownerToken.type == 'word'
		&& ownerToken.value.toUpperCase() == String(name || '').toUpperCase();
}

function token_inside_grouping_sets(document, token) {
	var scope = owner_function_scope(document, token);
	if (!scope || typeof scope.startTokenIndex != 'number') {
		return false;
	}
	var openToken = sqlFormatNavigation.token_by_index(document, scope.startTokenIndex);
	var ownerToken = sqlFormatNavigation.previous_code_token(document, openToken);
	return ownerToken
		&& ownerToken.type == 'word'
		&& ownerToken.value.toUpperCase() == 'SETS'
		&& is_word_token(sqlFormatNavigation.previous_code_token(document, ownerToken), 'GROUPING');
}

function follows_grouping_sets_keyword(document, previousToken) {
	return previousToken
		&& is_word_token(previousToken, 'SETS')
		&& is_word_token(sqlFormatNavigation.previous_code_token(document, previousToken), 'GROUPING');
}

function should_preserve_grouping_sets_gap(document, previousToken, token) {
	return token_inside_grouping_sets(document, token)
		&& /[ \t]/.test(original_gap_between(document, previousToken, token));
}

function follows_window_order_by(document, previousToken, token) {
	if (!previousToken || !is_word_token(previousToken, 'BY')) {
		return false;
	}

	var beforeBy = sqlFormatNavigation.previous_code_token(document, previousToken);
	return is_word_token(beforeBy, 'ORDER') && token_inside_scope_kind(document, token, 'windowSpec');
}

function follows_group_by(document, previousToken, token) {
	if (!previousToken || !is_word_token(previousToken, 'BY')) {
		return false;
	}

	return is_word_token(sqlFormatNavigation.previous_code_token(document, previousToken), 'GROUP');
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

function should_keep_original_comma_gap(document, previousToken, token) {
	if (!previousToken || previousToken.type != 'punctuation' || previousToken.value != ',') {
		return false;
	}
	if (!/[ \t]/.test(original_gap_between(document, previousToken, token))) {
		return false;
	}
	if (token_inside_scope_kind(document, token, 'inList')) {
		return true;
	}
	if (token_inside_scope_kind(document, token, 'conditionBlock')
		&& !token_inside_scope_kind(document, token, 'caseExpr')) {
		return true;
	}
	return token_inside_scope_kind(document, token, 'functionCall')
		&& !token_inside_function_named(document, token, 'COALESCE')
		&& token_in_case_value(document, token);
}

function follows_lateral_view_alias_comma(document, previousToken, token) {
	if (!document
		|| !previousToken
		|| previousToken.type != 'punctuation'
		|| previousToken.value != ','
		|| !token
		|| previousToken.line != token.line) {
		return false;
	}

	var sawAs = false;
	var sawView = false;
	for (var i = previousToken.index - 1; i >= 0; i--) {
		var candidate = document.tokens[i];
		if (!candidate || candidate.line != previousToken.line) {
			break;
		}
		if (!candidate.isCode || candidate.type != 'word') {
			continue;
		}
		if (!sawAs && candidate.value.toUpperCase() == 'AS') {
			sawAs = true;
			continue;
		}
		if (sawAs && candidate.value.toUpperCase() == 'VIEW') {
			sawView = true;
			continue;
		}
		if (sawAs && sawView && candidate.value.toUpperCase() == 'LATERAL') {
			return true;
		}
	}
	return false;
}

function should_compact_open_bracket(previousToken) {
	if (!previousToken) {
		return false;
	}
	if (previousToken.type == 'word') {
		return previousToken.value.toUpperCase() != 'ARRAY';
	}
	if (previousToken.type == 'quoted_identifier'
		|| previousToken.type == 'number'
		|| previousToken.type == 'string_literal') {
		return true;
	}
	return previousToken.type == 'punctuation'
		&& (previousToken.value == ')' || previousToken.value == ']');
}

	function should_add_comma_gap(document, previousToken, token) {
		if (token_inside_scope_kind(document, token, 'caseExpr')) {
			var line = document && token ? document.lines[token.line] : null;
			if (line && line.commentStart >= 0 && token.column < line.commentStart) {
				return false;
			}
		}
		return previousToken
			&& previousToken.type == 'punctuation'
			&& previousToken.value == ','
		&& token_inside_scope_kind(document, token, 'inList');
}

function append_visible_token(output, document, token, value, previousToken, dialect, groupByLine) {
	if (token.type == 'line_comment') {
		if (trim_trailing_space(output) == '') {
			return output + value;
		}
		return trim_trailing_space(output) + ' ' + value;
	}

	if (token.type == 'block_comment') {
		if (output == '' || /[\s(]$/.test(output)) {
			return output + value;
		}
		return output + ' ' + value;
	}

	if (token.type == 'operator') {
		if (previousToken && is_word_token(previousToken, 'SELECT') && token_inside_inline_query(document, token)) {
			return trim_trailing_space(output) + ' ' + value;
		}
		if (previousToken && is_word_token(previousToken, 'SELECT') && value == '*') {
			return trim_trailing_space(output) + '  ' + value;
		}
		if (previousToken && previousToken.type == 'punctuation' && previousToken.value == '(' && value == '*') {
			return trim_trailing_space(output) + value;
		}
		if (is_originally_compact_case_function_plus(document, token)) {
			return trim_trailing_space(output) + value;
		}
		if (/^[+-]$/.test(value) && is_unary_sign_token(previousToken)) {
			return trim_trailing_space(output) + (previousToken && is_word_token(previousToken, 'SELECT') ? '  ' : ' ') + value;
		}
		if (is_arithmetic_with_unary_sign(token.value)) {
			return trim_trailing_space(output) + ' ' + value;
		}
		if (is_comparison_with_unary_sign(token.value)) {
			return trim_trailing_space(output) + ' ' + value;
		}
		if (operator_spacing(token, value, dialect) == 'none') {
			return trim_trailing_space(output) + value;
		}
		return trim_trailing_space(output) + ' ' + value + ' ';
	}

	if (token.type == 'punctuation') {
		if (value == ',' && trim_trailing_space(output) == '') {
			return output + value;
		}
		if (value == ')' && should_preserve_grouping_sets_gap(document, previousToken, token)) {
			return trim_trailing_space(output) + ' ' + value;
		}
		if (value == ',' || value == ';' || value == ')' || value == ']' || value == '.') {
			return trim_trailing_space(output) + value;
		}
		if (value == '[' && should_compact_open_bracket(previousToken)) {
			return trim_trailing_space(output) + value;
		}
		if (value == '(') {
			if (follows_grouping_sets_keyword(document, previousToken)) {
				return trim_trailing_space(output) + ' ' + value;
			}
			if (previousToken
				&& previousToken.type == 'punctuation'
				&& previousToken.value == '('
				&& should_preserve_grouping_sets_gap(document, previousToken, token)) {
				return trim_trailing_space(output) + ' ' + value;
			}
			if (previousToken && is_word_token(previousToken) && /^(AND|OR|NOT)$/i.exec(previousToken.value)) {
				return trim_trailing_space(output) + ' ' + value;
			}
			if (token_opens_inline_query(document, token)) {
				return trim_trailing_space(output) + ' ' + value + ' ';
			}
			if (previousToken && is_word_token(previousToken, 'OVER')) {
				return trim_trailing_space(output) + normalized_original_space(document, previousToken, token) + value;
			}
			if (previousToken && is_word_token(previousToken, 'IN')) {
				return trim_trailing_space(output) + normalized_original_space(document, previousToken, token) + value;
			}
			if (previousToken && is_word_token(previousToken, 'IF')) {
				return trim_trailing_space(output) + normalized_original_space(document, previousToken, token) + value;
			}
			if (previousToken && is_word_token(previousToken) && /^(EXISTS|OVER)$/i.exec(previousToken.value)) {
				return trim_trailing_space(output) + ' ' + value;
			}
			return trim_trailing_space(output) + value;
		}
	}

	if ((token.type == 'number' || token.type == 'word')
		&& follows_originally_compact_case_function_plus(document, previousToken, token)) {
		return trim_trailing_space(output) + value;
	}

	if (previousToken
		&& previousToken.type == 'punctuation'
		&& previousToken.value == '('
		&& should_preserve_grouping_sets_gap(document, previousToken, token)) {
		return output + ' ' + value;
	}

	if ((token.type == 'number' || token.type == 'word')
		&& /[+-]\s$/.test(output)
		&& previousToken
		&& previousToken.type == 'operator'
		&& (/^[+-]$/.test(previousToken.value) || is_arithmetic_with_unary_sign(previousToken.value))
		&& (is_arithmetic_with_unary_sign(previousToken.value)
			|| is_unary_sign_token(sqlFormatNavigation.previous_code_token(document, previousToken)))) {
		return trim_trailing_space(output) + value;
	}

	if (output == '' || /[\s(.,\[]$/.test(output)) {
		if (should_keep_original_comma_gap(document, previousToken, token)) {
			return trim_trailing_space(output) + ' ' + value;
		}
		if (should_add_comma_gap(document, previousToken, token)) {
			return trim_trailing_space(output) + ' ' + value;
		}
		if (follows_lateral_view_alias_comma(document, previousToken, token)) {
			return trim_trailing_space(output) + ' ' + value;
		}
		return output + value;
	}

	if (previous_operator_has_no_spacing(previousToken, dialect)) {
		return output + value;
	}

	if ((token.type == 'number' || token.type == 'word')
		&& /[+-]$/.test(output)
		&& previousToken
		&& previousToken.type == 'operator'
		&& (/^[+-]$/.test(previousToken.value) || is_arithmetic_with_unary_sign(previousToken.value))
		&& (is_arithmetic_with_unary_sign(previousToken.value)
			|| is_unary_sign_token(sqlFormatNavigation.previous_code_token(document, previousToken)))) {
		return output + value;
	}

	if (previousToken && is_word_token(previousToken, 'SELECT') && token_inside_inline_query(document, token)) {
		return output + ' ' + value;
	}

	if (previousToken && is_word_token(previousToken, 'SELECT')) {
		return output + '  ' + value;
	}

	if ((groupByLine || follows_group_by(document, previousToken, token))
		&& previousToken
		&& is_word_token(previousToken, 'BY')) {
		return output + '  ' + value;
	}

	if (follows_window_order_by(document, previousToken, token)) {
		return output + '  ' + value;
	}

	return output + ' ' + value;
}

function render_line_from_tokens(document, line, mutations, moveState, options) {
	var output = '';
	var leadingIndent = String(line.raw || '').match(/^\s*/)[0];
	var previousToken = null;
	var groupByLine = line_starts_with_group_by(line, moveState);
	var dialect = dialect_name(options, document);

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
		} else if (output == '' && token == first_visible_token(line, moveState)) {
			output += leadingIndent;
		}

		if (tokenMutation.spacingBefore) {
			output = trim_trailing_space(output) + tokenMutation.spacingBefore.spacingText;
		}

		output = append_visible_token(
			output,
			document,
			token,
			token_value(token, tokenMutation),
			previousToken,
			dialect,
			groupByLine
		);
		previousToken = token;
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

function apply_scope_close_indent(lineText, closeIndent) {
	if (typeof closeIndent != 'string') {
		return lineText;
	}

	var trimmed = String(lineText || '').replace(/^\s+/g, '');
	if (!/^\)/.test(trimmed)) {
		return lineText;
	}

	return closeIndent + trimmed;
}

function apply_scope_body_indent(lineText, bodyIndent) {
	if (typeof bodyIndent != 'string') {
		return lineText;
	}

	if (String(lineText || '').replace(/^\s+|\s+$/g, '') == '') {
		return lineText;
	}

	var currentIndent = String(lineText || '').match(/^\s*/)[0];
	if (currentIndent.length >= bodyIndent.length) {
		return lineText;
	}

	return bodyIndent + String(lineText || '').replace(/^\s+/g, '');
}

function apply_indent(lineText, indentMutation) {
	if (!indentMutation) {
		return lineText;
	}
	return indentMutation.indentText + String(lineText || '').replace(/^\s+/g, '');
}

function apply_line_prefix(lineText, prefixes) {
	if (!prefixes || prefixes.length == 0) {
		return lineText;
	}
	var originalIndent = String(lineText || '').match(/^\s*/)[0];
	var indent = typeof prefixes[0].indentText == 'string'
		? prefixes[0].indentText
		: originalIndent;
	var body = String(lineText || '').slice(originalIndent.length);
	var text = '';
	for (var i = 0; i < prefixes.length; i++) {
		text += typeof prefixes[i] == 'string' ? prefixes[i] : prefixes[i].text;
	}
	return indent + text + body.replace(/^\s+/g, '');
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

function render(document, nodes, mutations, options) {
	var plan = mutations || sqlFormatMutations.create();
	var moveState = sqlRenderMoveState.build_move_state(nodes || {}, plan);
	var closeIndentByLine = build_close_indent_by_line(document, plan, moveState);
	var bodyIndentByLine = build_body_indent_by_line(document, plan, moveState);
	var lines = [];

		for (var i = 0; i < document.lines.length; i++) {
			var line = document.lines[i];
			var lineMutations = sqlFormatMutations.get_for_line(plan, i);
			if (lineMutations.omission) {
				continue;
			}
			var rendered = render_line_from_tokens(document, line, plan, moveState, options);

		if (!lineMutations.indent) {
			rendered = apply_scope_body_indent(rendered, bodyIndentByLine[String(i)]);
		}
		rendered = apply_scope_close_indent(rendered, closeIndentByLine[String(i)]);
			rendered = apply_indent(rendered, lineMutations.indent);
			rendered = apply_line_prefix(rendered, moveState.prefixesByLine[String(i)]);
			rendered = apply_comment_alignment(rendered, lineMutations.commentAlignment);
			append_joined_line(lines, rendered, lineMutations.lineJoin);
		}

	return normalize_output_whitespace(lines.join('\n'));
}

exports.render = render;
