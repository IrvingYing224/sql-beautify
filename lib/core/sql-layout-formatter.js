var sqlFormatUtils = require('./sql-format-utils');
var sqlClauseRegistry = require('./sql-clause-registry');
var sqlTokenizer = require('./sql-tokenizer');
var sqlFormatModel = require('./sql-format-model');
var sqlFormatMutations = require('./sql-format-mutations');
var sqlFormatNavigation = require('./sql-format-navigation');
var sqlClauseContext = require('./sql-clause-context');
var repeat_string = sqlFormatUtils.repeat_string;

function resolve_dialect_name(dialect) {
	return dialect && dialect.dialect ? dialect.dialect : String(dialect || 'generic');
}

function get_indent_unit(options) {
	return options && options.indentStyle == 'space' ? '    ' : '\t';
}

function split_trailing_closing_parens(line, tokenizerOptions) {
	var text = String(line || '').replace(/\s+$/g, '');
	var tokens = sqlTokenizer.tokenize(text, tokenizerOptions);
	var closers_to_split = 0;
	var trailing_closers = 0;
	var local_paren_depth = 0;
	var parts = [];

	for (var i = 0; i < tokens.length; i++) {
		if (tokens[i].type == 'punctuation' && tokens[i].value == '(') {
			local_paren_depth += 1;
		} else if (tokens[i].type == 'punctuation' && tokens[i].value == ')') {
			if (local_paren_depth > 0) {
				local_paren_depth -= 1;
			} else {
				closers_to_split += 1;
			}
		}
	}

	for (i = tokens.length - 1; i >= 0; i--) {
		if (tokens[i].type == 'whitespace') {
			continue;
		}
		if (tokens[i].type == 'punctuation' && tokens[i].value == ')') {
			trailing_closers += 1;
			continue;
		}
		break;
	}

	closers_to_split = Math.min(closers_to_split, trailing_closers);
	if (closers_to_split == 0) {
		return text == '' ? [] : [text];
	}

	var split_start = text.length;
	var remaining = closers_to_split;
	for (i = tokens.length - 1; i >= 0 && remaining > 0; i--) {
		if (tokens[i].type == 'punctuation' && tokens[i].value == ')') {
			split_start = tokens[i].start;
			remaining -= 1;
		}
	}

	text = text.slice(0, split_start).replace(/\s+$/g, '');
	if (text != '') {
		parts.push(text);
	}
	for (i = 0; i < closers_to_split; i++) {
		parts.push(')');
	}

	return parts;
}

function get_line_leading_closers(tokens) {
	var first_code_seen = false;
	var leading_closers = 0;

	for (var i = 0; i < tokens.length; i++) {
		var token = tokens[i];
		if (token.type == 'whitespace' || token.type == 'newline') {
			continue;
		}

		if (token.type == 'punctuation' && token.value == ')' && !first_code_seen) {
			leading_closers += 1;
		}

		first_code_seen = true;
	}

	return leading_closers;
}

function indent_nested_blocks(str, options) {
	var text_list = [];
	var output = [];
	var text_list_orginal = String(str || '').split("\n");
	var previous_was_blank = false;
	var tokenizerOptions = options && options.tokenizerOptions ? options.tokenizerOptions : null;
	for (var i = 0; i < text_list_orginal.length; i++) {
		if (text_list_orginal[i] === "" || text_list_orginal[i] === " ") {
			if (!previous_was_blank) {
				text_list.push('');
			}
			previous_was_blank = true;
		} else {
			text_list = text_list.concat(split_trailing_closing_parens(text_list_orginal[i], tokenizerOptions));
			previous_was_blank = false;
		}
	}

	var bracket_deep = 0;
	var indent_unit = get_indent_unit(options);
	var model = sqlFormatModel.from_text(text_list.join('\n'), tokenizerOptions);

	for (i = 0; i < text_list.length; i++) {
		if (text_list[i] === '') {
			output.push('');
			continue;
		}

		var leading_closers = get_line_leading_closers(model.lines[i].codeTokens);
		if (leading_closers > 0) {
			bracket_deep -= leading_closers;
			if (bracket_deep < 0) {
				bracket_deep = 0;
			}
		}

		text_list[i] = repeat_string(indent_unit, bracket_deep) + text_list[i];

		bracket_deep += model.lines[i].parenDelta;
		if (bracket_deep < 0) {
			bracket_deep = 0;
		}

		output.push(text_list[i]);
	}

	return output.length == 0 ? '' : '\n' + output.join('\n');
}

function should_insert_statement_gap(current_line, previous_line, dialect) {
	var trimmed = String(current_line || '').replace(/^\s+/g, '');
	var previous = String(previous_line || '');
	var dialectName = resolve_dialect_name(dialect);

	if (!sqlClauseRegistry.is_statement_start(trimmed, dialectName)) {
		return false;
	}

	if (/^CREATE\b/i.exec(trimmed) && (/\bDROP\b/i.exec(previous) || /\bADD\s+JAR\b/i.exec(previous))) {
		return false;
	}

	if (/^SET\b/i.exec(trimmed) && /\bSET\b/i.exec(previous)) {
		return false;
	}

	return true;
}

function should_insert_select_after_statement_gap(current_line, previous_line, dialect) {
	var dialectName = resolve_dialect_name(dialect);
	return String(previous_line || '').indexOf(';') >= 0
		&& sqlClauseRegistry.is_select_block_start(current_line, dialectName);
}

function cleanup_layout_markers(str, dialect) {
	var text_list_orginal = String(str || '').split("\n");
	var text_list = [];
	var output = [];
	var previous_was_blank = false;

	for (var i = 0; i < text_list_orginal.length; i++) {
		var trimmed_line = text_list_orginal[i].replace(/[ \t]+$/g, '');
		if (trimmed_line == '') {
			if (!previous_was_blank) {
				text_list.push('');
			}
			previous_was_blank = true;
		} else {
			text_list.push(trimmed_line);
			previous_was_blank = false;
		}
	}

	for (let i = 0; i < text_list.length; i++) {
		var last_str = i == 0 ? "" : text_list[i - 1];

		if (text_list[i] == '') {
			output.push('');
			continue;
		}

		if (i > 0 && should_insert_statement_gap(text_list[i], last_str, dialect)) {
			output.push('', text_list[i]);
		} else if (i > 0 && should_insert_select_after_statement_gap(text_list[i], last_str, dialect)) {
			output.push('', text_list[i]);
		} else {
			output.push(text_list[i]);
		}
	}

	return output.join('\n').replace(/\n{1,2} *--/ig, "\n--").replace(/^ */ig, "")
		.replace(/(\s|\n){1,};(\n|\s){0,}/ig, "\n;\n\n");
}

function has_code_before_token(document, token) {
	var line = token && document.lines[token.line];
	if (!line) {
		return false;
	}

	for (var i = 0; i < line.codeTokens.length; i++) {
		if (line.codeTokens[i].index >= token.index) {
			return false;
		}
		return true;
	}

	return false;
}

function should_expand_query_scope(document, scope, openToken) {
	if (!scope || scope.kind != 'query' || typeof scope.openTokenIndex != 'number') {
		return false;
	}
	if (!openToken) {
		return false;
	}
	if (scope.id == 0) {
		return false;
	}
	return true;
}

function is_word(token, value) {
	if (!token || token.type != 'word') {
		return false;
	}
	if (typeof value == 'undefined') {
		return true;
	}
	return token.value.toUpperCase() == value;
}

function should_keep_query_open_inline(document, openToken) {
	var previous = sqlFormatNavigation.previous_code_token(document, openToken);
	return is_word(previous, 'IN') || is_word(previous, 'EXISTS');
}

function is_query_boundary_after_close(token) {
	return token
		&& token.type == 'word'
		&& /^(SELECT|WITH|FROM|WHERE|GROUP|ORDER|HAVING|QUALIFY|LIMIT|UNION|INTERSECT|EXCEPT|INSERT|CREATE|DROP|ALTER|DELETE|SET)$/i.exec(token.value);
}

function is_scope_body_token(scope, token, directBodyTokenLookup) {
	if (!token
		|| !token.isCode
		|| token.index <= scope.openTokenIndex
		|| token.index >= scope.closeTokenIndex) {
		return false;
	}
	return directBodyTokenLookup[String(token.index)] === true;
}

function should_apply_query_clause_match(tokens, index, clause, queryContext) {
	if (!clause) {
		return false;
	}
	if (clause.name == 'QUALIFY') {
		return sqlClauseContext.is_real_qualify_clause(tokens, index, queryContext);
	}
	return true;
}

function should_update_query_context(tokens, index, clause, queryContext) {
	return should_apply_query_clause_match(tokens, index, clause, queryContext);
}

function query_clause_match_at(scope, tokens, index, clauses, directBodyTokenLookup, queryContext) {
	for (var c = 0; c < clauses.length; c++) {
		var clause = clauses[c];
		var matched = true;
		for (var k = 0; k < clause.keywords.length; k++) {
			if (!tokens[index + k]
				|| !is_scope_body_token(scope, tokens[index + k], directBodyTokenLookup)
				|| !is_word(tokens[index + k], clause.keywords[k])) {
				matched = false;
				break;
			}
		}
		if (matched) {
			return should_apply_query_clause_match(tokens, index, clause, queryContext) ? clause : null;
		}
	}

	return null;
}

function update_query_context_if_clause(tokens, index, clause, queryContext) {
	if (should_update_query_context(tokens, index, clause, queryContext)) {
		sqlClauseContext.update_query_clause_context(queryContext, clause);
	}
}

function scope_active_tokens(document, scope, tokens) {
	var result = [];
	var startPosition = document && document.codeTokenPositionByIndex
		? document.codeTokenPositionByIndex[String(scope.openTokenIndex)]
		: null;

	if (typeof startPosition != 'number') {
		startPosition = 0;
	}

	for (var i = startPosition + 1; i < tokens.length; i++) {
		var token = tokens[i];
		if (!token || token.index >= scope.closeTokenIndex) {
			break;
		}
		if (token.index > scope.openTokenIndex) {
			result.push(token);
		}
	}

	return result;
}

function build_direct_query_body_token_lookup(scope, tokens, descendantScopes) {
	var lookup = {};
	var childIndex = 0;
	var child = descendantScopes[childIndex] || null;

	for (var i = 0; i < tokens.length; i++) {
		var token = tokens[i];
		if (!token || !token.isCode || token.index <= scope.openTokenIndex || token.index >= scope.closeTokenIndex) {
			continue;
		}
		while (child && token.index > child.endTokenIndex) {
			childIndex += 1;
			child = descendantScopes[childIndex] || null;
		}
		if (child
			&& token.index <= child.endTokenIndex
			&& (child.kind == 'query'
				? token.index >= child.startTokenIndex
				: token.index > child.startTokenIndex)) {
			continue;
		}
		lookup[String(token.index)] = true;
	}

	return lookup;
}

function is_descendant_scope(scope, candidate, scopeById) {
	var parent = candidate ? scopeById[String(candidate.parentScopeId)] : null;

	while (parent) {
		if (parent.id == scope.id) {
			return true;
		}
		parent = scopeById[String(parent.parentScopeId)] || null;
	}

	return false;
}

function descendant_scopes(scope, scopes) {
	var children = [];
	var scopeById = {};
	var i;

	for (i = 0; i < (scopes || []).length; i++) {
		scopeById[String(scopes[i].id)] = scopes[i];
	}

	for (i = 0; i < (scopes || []).length; i++) {
		var child = scopes[i];
		if (is_descendant_scope(scope, child, scopeById)
			&& child.id != scope.id) {
			children.push(child);
		}
	}

	children.sort(function(a, b) {
		return a.startTokenIndex - b.startTokenIndex;
	});

	return children;
}

function query_clauses_for_config(config) {
	return sqlClauseRegistry.get_clauses(resolve_dialect_name(config && config.dialect)).slice().sort(function(a, b) {
		return b.keywords.length - a.keywords.length;
	});
}

function suffix_after_prefix(value, prefix) {
	value = String(value || '');
	prefix = String(prefix || '');

	if (value.slice(0, prefix.length) == prefix) {
		return value.slice(prefix.length);
	}

	return '';
}

function effective_token_indent(document, mutations, token) {
	var line = token && document.lines[token.line];
	var lineIndent = mutations && mutations.lineIndents
		? mutations.lineIndents[String(token.line)]
		: null;
	var indent = lineIndent
		? lineIndent.indentText
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

function effective_scope_indents(document, scope, mutations, openToken) {
	var openIndent = effective_token_indent(document, mutations, openToken);
	var bodyIndent = openIndent + suffix_after_prefix(scope.bodyIndent, scope.openIndent);
	var closeIndent = openIndent + suffix_after_prefix(scope.closeIndent, scope.openIndent);

	if (scope.closeIndentOwnerKind == 'conditionBlock') {
		closeIndent = scope.closeIndent || '';
	} else if (scope.kind == 'query') {
		closeIndent = openIndent;
	}

	return {
		openIndent: openIndent,
		bodyIndent: bodyIndent,
		closeIndent: closeIndent
	};
}

function add_query_scope_body_mutations(document, scope, mutations, config, clauses) {
	var allTokens = sqlFormatNavigation.active_tokens(document);
	var tokens = scope_active_tokens(document, scope, allTokens);
	var directBodyTokenLookup = build_direct_query_body_token_lookup(
		scope,
		tokens,
		descendant_scopes(scope, document.scopes || [])
	);
	var firstBodyToken = null;
	var selectToken = null;
	var openToken = sqlFormatNavigation.token_by_index(document, scope.openTokenIndex);
	var indents = effective_scope_indents(document, scope, mutations, openToken);
	var compactScope = false;
	var queryContext;
	var i;
	var token;
	var clause;

	for (i = 0; i < tokens.length; i++) {
		token = tokens[i];
		if (!is_scope_body_token(scope, token, directBodyTokenLookup)) {
			continue;
		}
		if (!firstBodyToken) {
			firstBodyToken = token;
		}
		if (!selectToken && is_word(token, 'SELECT')) {
			selectToken = token;
		}
	}

	compactScope = openToken && firstBodyToken && firstBodyToken.line == openToken.line;

	if (compactScope) {
		queryContext = sqlClauseContext.create_query_context();
		for (i = 0; i < tokens.length; i++) {
			token = tokens[i];
			clause = query_clause_match_at(scope, tokens, i, clauses, directBodyTokenLookup, queryContext);
			if (token != firstBodyToken && clause) {
				sqlFormatMutations.add_line_break_before_token(mutations, token.id, indents.bodyIndent, '');
			}
			if (clause) {
				update_query_context_if_clause(tokens, i, clause, queryContext);
			}
		}
	}

	if (compactScope) {
		sqlFormatMutations.add_line_break_before_token(mutations, firstBodyToken.id, indents.bodyIndent, '');
	}

	if (compactScope && selectToken) {
		var selectItemToken = sqlFormatNavigation.next_code_token(document, selectToken);
		if (is_scope_body_token(scope, selectItemToken, directBodyTokenLookup)) {
			sqlFormatMutations.add_spacing_before_token(mutations, selectItemToken.id, '  ');
		}
	}

	return compactScope;
}

function apply_scope_layout_mutations(document, nodes, mutations, config) {
	if (!document || !mutations) {
		return;
	}

	var scopes = document.scopes || [];
	var clauses = query_clauses_for_config(config);
	for (var i = 0; i < scopes.length; i++) {
		var scope = scopes[i];
		if (scope.kind != 'query' || typeof scope.openTokenIndex != 'number') {
			continue;
		}
		var token = sqlFormatNavigation.token_by_index(document, scope.openTokenIndex);
		if (!should_expand_query_scope(document, scope, token)) {
			continue;
		}
		var indents = effective_scope_indents(document, scope, mutations, token);
		if (has_code_before_token(document, token) && !should_keep_query_open_inline(document, token)) {
			sqlFormatMutations.add_line_break_before_token(mutations, token.id, indents.openIndent, '');
		}

		var expandedCompactScope = add_query_scope_body_mutations(document, scope, mutations, config, clauses);

		var closeToken = typeof scope.closeTokenIndex == 'number'
			? sqlFormatNavigation.token_by_index(document, scope.closeTokenIndex)
			: null;
		if (closeToken && has_code_before_token(document, closeToken)) {
			if (scope.closeLine != scope.openLine && closeToken.line != token.line) {
				sqlFormatMutations.add_line_indent(mutations, closeToken.line, indents.bodyIndent);
			}
			if (indents.closeIndent != '' && closeToken.line == token.line) {
				sqlFormatMutations.add_line_break_before_token(mutations, closeToken.id, '', '');
				sqlFormatMutations.add_token_replacement(mutations, closeToken.id, indents.closeIndent + closeToken.value);
			} else {
				sqlFormatMutations.add_line_break_before_token(mutations, closeToken.id, indents.closeIndent, '');
			}
		} else if (closeToken && (scope.closeLine != scope.openLine || expandedCompactScope)) {
			sqlFormatMutations.add_line_indent(mutations, closeToken.line, indents.closeIndent);
		}

		var afterCloseToken = closeToken ? sqlFormatNavigation.next_code_token(document, closeToken) : null;
		if (afterCloseToken && afterCloseToken.line == closeToken.line && is_query_boundary_after_close(afterCloseToken)) {
			sqlFormatMutations.add_line_break_before_token(mutations, afterCloseToken.id, indents.closeIndent, '');
		}
	}
}

exports.indent_nested_blocks = indent_nested_blocks;
exports.cleanup_layout_markers = cleanup_layout_markers;
exports.apply_scope_layout_mutations = apply_scope_layout_mutations;
