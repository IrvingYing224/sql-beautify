var sqlKeywords = require('./sql-keywords');

function token_value_text(token) {
	return token ? token.value : '';
}

function original_gap_between(document, previousToken, token) {
	if (!document || !previousToken || !token || previousToken.line != token.line) {
		return '';
	}
	return String(document.source || '').slice(previousToken.end, token.start);
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

function is_word_token(token, value) {
	if (!token || token.type != 'word') {
		return false;
	}
	if (typeof value == 'undefined') {
		return true;
	}
	return token.value.toUpperCase() == value;
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

function follows_window_order_by(document, tokens, index) {
	var token = tokens && tokens[index];
	if (!token || index < 2 || !token_inside_scope_kind(document, token, 'windowSpec')) {
		return false;
	}
	return tokens[index - 1]
		&& tokens[index - 2]
		&& is_word_token(tokens[index - 1], 'BY')
		&& is_word_token(tokens[index - 2], 'ORDER');
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

function rendered_token_value(token, options) {
	var value = token_value_text(token);
	if (options.applyKeywordCase && token.type == 'word' && sqlKeywords.is_keyword(value)) {
		return options.keywordCase == 'lower' ? value.toLowerCase() : value.toUpperCase();
	}
	return value;
}

function should_preserve_comma_gap(document, previousToken, token, options) {
	if (!previousToken
		|| previousToken.type != 'punctuation'
		|| previousToken.value != ','
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

function render_tokens(document, tokens, options) {
	var config = options || {};
	var output = '';
	var previousToken = null;

	for (var i = 0; i < (tokens || []).length; i++) {
		var token = tokens[i];
		if (!token) {
			continue;
		}
		var value = rendered_token_value(token, config);

		if (output == '') {
			output = value;
		} else if (token.type == 'punctuation'
			&& (value == ',' || value == ';' || value == ']' || value == '.')) {
			output = output.replace(/[ \t]+$/g, '') + value;
		} else if (token.type == 'punctuation' && value == ')') {
			var closeScope = token_scope_by_close_index(document, token);
			var closePrefix = closeScope && closeScope.id == config.spacedScopeId ? ' ' : '';
			output = output.replace(/[ \t]+$/g, '') + closePrefix + value;
		} else if (token.type == 'punctuation' && value == '(') {
			var openScope = token_scope_by_open_index(document, token);
			var openSuffix = openScope && openScope.id == config.spacedScopeId ? ' ' : '';
			if (config.spaceBeforeInParen && is_word_token(previousToken, 'IN')) {
				output = output.replace(/[ \t]+$/g, '') + ' ' + value + openSuffix;
			} else {
				output = output.replace(/[ \t]+$/g, '') + value + openSuffix;
			}
		} else if (config.compactOperatorToken && config.compactOperatorToken(document, token)) {
			output = output.replace(/[ \t]+$/g, '') + value;
		} else if (config.followsCompactOperator && config.followsCompactOperator(document, previousToken, token)) {
			output += value;
		} else if (should_join_unary_number(tokens, i, config.unaryNumberMode)) {
			output += value;
		} else if (should_preserve_comma_gap(document, previousToken, token, config)) {
			output = output.replace(/[ \t]+$/g, '') + ' ' + value;
		} else if (config.windowOrderBySpacing && follows_window_order_by(document, tokens, i)) {
			output += '  ' + value;
		} else if (/[\s(.,\[]$/.test(output)) {
			output += value;
		} else {
			output += ' ' + value;
		}

		previousToken = token;
	}

	return output;
}

exports.render_tokens = render_tokens;
