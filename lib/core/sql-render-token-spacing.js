var sqlFormatNavigation = require('./sql-format-navigation');
var sqlOperatorRegistry = require('./sql-operator-registry');
var sqlKeywords = require('./sql-keywords');

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

function rendered_token_value(token, options) {
	var value = token ? token.value : '';
	if (options && options.applyKeywordCase && token.type == 'word' && sqlKeywords.is_keyword(value)) {
		return options.keywordCase == 'lower' ? value.toLowerCase() : value.toUpperCase();
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

function output_is_leading_comma_prefix(output) {
	return /^\s*,$/.test(trim_trailing_space(output));
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

function token_scope_by_open_index(document, token) {
	var scopes = document && document.scopes ? document.scopes : [];
	for (var i = 0; i < scopes.length; i++) {
		if (scopes[i].openTokenIndex == token.index) {
			return scopes[i];
		}
	}
	return null;
}

function token_scope_by_close_index(document, token) {
	var scopes = document && document.scopes ? document.scopes : [];
	for (var i = 0; i < scopes.length; i++) {
		if (scopes[i].closeTokenIndex == token.index) {
			return scopes[i];
		}
	}
	return null;
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

function should_join_unary_number(tokens, index, mode) {
	var token = tokens[index];
	var previousToken = tokens[index - 1];
	if (!token
		|| token.type != 'number'
		|| !previousToken
		|| previousToken.type != 'operator'
		|| !/^[+-]$/.test(previousToken.value)) {
		return false;
	}

	if (mode == 'case') {
		return true;
	}

	if (mode != 'select') {
		return false;
	}

	var beforePreviousToken = tokens[index - 2];
	return index < 2
		|| (beforePreviousToken && beforePreviousToken.type == 'operator')
		|| (beforePreviousToken && beforePreviousToken.type == 'word' && /^(THEN|ELSE|WHEN|IN|AND|OR|NOT|SELECT)$/i.exec(beforePreviousToken.value))
		|| (beforePreviousToken && beforePreviousToken.type == 'punctuation' && /^(,|\(|\[)$/.test(beforePreviousToken.value));
}

function should_preserve_configured_comma_gap(document, previousToken, token, options) {
	if (!previousToken
		|| previousToken.type != 'punctuation'
		|| previousToken.value != ','
		|| !options
		|| !options.preserveCommaGapTokenIndexes
		|| !options.preserveCommaGapTokenIndexes[String(token.index)]) {
		return false;
	}
	if (options.preserveCommaGapExceptFunctionName
		&& token_inside_function_named(document, token, options.preserveCommaGapExceptFunctionName)) {
		return false;
	}
	return /[ \t]/.test(original_gap_between(document, previousToken, token));
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

function scope_open_suffix(document, token, options) {
	if (!options || options.spacedScopeId == null) {
		return '';
	}
	var openScope = token_scope_by_open_index(document, token);
	return openScope && openScope.id == options.spacedScopeId ? ' ' : '';
}

function scope_close_prefix(document, token, options) {
	if (!options || options.spacedScopeId == null) {
		return '';
	}
	var closeScope = token_scope_by_close_index(document, token);
	return closeScope && closeScope.id == options.spacedScopeId ? ' ' : '';
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

function append_visible_token(output, document, token, value, previousToken, dialect, groupByLine, spacingOptions) {
	var behavior = spacingOptions || {};
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

	if (!behavior.disableImplicitUnaryNumberJoin
		&& (token.type == 'number' || token.type == 'word')
		&& /[+-]\s$/.test(output)
		&& previousToken
		&& previousToken.type == 'operator'
		&& (/^[+-]$/.test(previousToken.value) || is_arithmetic_with_unary_sign(previousToken.value))
		&& (is_arithmetic_with_unary_sign(previousToken.value)
			|| is_unary_sign_token(sqlFormatNavigation.previous_code_token(document, previousToken)))) {
		return trim_trailing_space(output) + value;
	}

	if (output == '' || /[\s(.,\[]$/.test(output)) {
		if (previousToken && previousToken.type == 'punctuation' && previousToken.value == ',') {
			if (output_is_leading_comma_prefix(output)) {
				return output + value;
			}
			return trim_trailing_space(output) + ' ' + value;
		}
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

	if (!behavior.disableImplicitUnaryNumberJoin
		&& (token.type == 'number' || token.type == 'word')
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

	if (!behavior.disableWindowOrderBySpacing && follows_window_order_by(document, previousToken, token)) {
		return output + '  ' + value;
	}

	return output + ' ' + value;
}

function append_visible_token_with_options(output, document, tokens, index, value, previousToken, options) {
	var config = options || {};
	var token = tokens[index];
	var behavior = {
		disableWindowOrderBySpacing: !config.windowOrderBySpacing,
		disableImplicitUnaryNumberJoin: true
	};
	if (output == '') {
		return value;
	}
	if (token.type == 'punctuation' && value == '(') {
		var openSuffix = scope_open_suffix(document, token, config);
		if (config.spaceBeforeInParen && is_word_token(previousToken, 'IN')) {
			return trim_trailing_space(output) + ' ' + value + openSuffix;
		}
		if (openSuffix != '') {
			return append_visible_token(
				output,
				document,
				token,
				value,
				previousToken,
				config.dialect || dialect_name(config, document),
				config.groupByLine,
				behavior
			) + openSuffix;
		}
		if (is_word_token(previousToken, 'IN')) {
			return append_visible_token(
				output,
				document,
				token,
				value,
				previousToken,
				config.dialect || dialect_name(config, document),
				config.groupByLine,
				behavior
			);
		}
		return trim_trailing_space(output) + value;
	}
	if (token.type == 'punctuation') {
		if (value == ')') {
			var closePrefix = scope_close_prefix(document, token, config);
			return trim_trailing_space(output) + closePrefix + value;
		}
		if (value == ',' || value == ';' || value == ']' || value == '.') {
			return trim_trailing_space(output) + value;
		}
	}
	if (config.compactOperatorToken && config.compactOperatorToken(document, token)) {
		return trim_trailing_space(output) + value;
	}
	if (config.followsCompactOperator && config.followsCompactOperator(document, previousToken, token)) {
		return output + value;
	}
	if (should_join_unary_number(tokens, index, config.unaryNumberMode)) {
		return output + value;
	}
	if (token.type == 'operator' && value == '*' && /\($/.test(output)) {
		return output + value;
	}
	if (token.type == 'operator') {
		return trim_trailing_space(output) + ' ' + value;
	}
	if (previousToken && previousToken.type == 'operator') {
		return output + ' ' + value;
	}
	if (previousToken && previousToken.type == 'punctuation' && previousToken.value == ',') {
		return output_is_leading_comma_prefix(output)
			? output + value
			: trim_trailing_space(output) + ' ' + value;
	}
	if (should_preserve_configured_comma_gap(document, previousToken, token, config)) {
		return trim_trailing_space(output) + ' ' + value;
	}
	if (config.windowOrderBySpacing && follows_window_order_by(document, previousToken, token)) {
		return output + '  ' + value;
	}
	if (/[\s(.,\[]$/.test(output)) {
		return output + value;
	}
	return output + ' ' + value;
}

function render_visible_tokens(document, tokens, options) {
	var config = options || {};
	var output = '';
	var previousToken = null;

	for (var i = 0; i < (tokens || []).length; i++) {
		var token = tokens[i];
		if (!token) {
			continue;
		}

		output = append_visible_token_with_options(
			output,
			document,
			tokens,
			i,
			rendered_token_value(token, config),
			previousToken,
			config
		);
		previousToken = token;
	}

	return output;
}

exports.token_value = token_value;
exports.append_visible_token = append_visible_token;
exports.render_visible_tokens = render_visible_tokens;
