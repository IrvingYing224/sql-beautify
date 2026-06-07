var sqlClauseRegistry = require('./sql-clause-registry');
var sqlFormatMutations = require('./sql-format-mutations');
var sqlGroupByExtension = require('./sql-group-by-extension');
var sqlClauseContext = require('./sql-clause-context');

function is_word(token, value) {
	if (!token || token.type != 'word') {
		return false;
	}
	if (typeof value == 'undefined') {
		return true;
	}
	return token.value.toUpperCase() == value;
}

function active_tokens(document) {
	return (document.tokens || []).filter(function(token) {
		return token.isCode;
	});
}

function dialect_name(options) {
	if (options && options.dialect) {
		return options.dialect;
	}
	return String(options || 'generic');
}

function clause_at(tokens, index, dialect) {
	var clauses = sqlClauseRegistry.get_clauses(dialect).slice().sort(function(a, b) {
		return b.keywords.length - a.keywords.length;
	});

	for (var c = 0; c < clauses.length; c++) {
		var clause = clauses[c];
		var matched = true;
		for (var k = 0; k < clause.keywords.length; k++) {
			if (!tokens[index + k] || !is_word(tokens[index + k], clause.keywords[k])) {
				matched = false;
				break;
			}
		}
		if (matched) {
			return {
				clause: clause,
				token: tokens[index],
				length: clause.keywords.length
			};
		}
	}

	return null;
}

function is_inside_nested_scope(document, token) {
	var scopes = document.scopes || [];

	for (var i = 0; i < scopes.length; i++) {
		var scope = scopes[i];
		if (scope.kind == 'query'
			&& scope.id != 0
			&& scope.openLine == scope.closeLine
			&& token.index > scope.startTokenIndex
			&& token.index < scope.endTokenIndex) {
			return true;
		}
		if (scope.kind != 'functionCall'
			&& scope.kind != 'inList'
			&& scope.kind != 'windowSpec'
			&& scope.kind != 'parenList'
			&& scope.kind != 'caseExpr') {
			continue;
		}
		if (token.index > scope.startTokenIndex && token.index < scope.endTokenIndex) {
			return true;
		}
	}

	return false;
}

function previous_top_level_statement_start(tokens, index) {
	for (var i = index - 1; i >= 0; i--) {
		var token = tokens[i];
		if (token.type == 'punctuation' && token.value == ';') {
			return null;
		}
		if (token.type == 'word' && /^(INSERT|SELECT|WITH|CREATE|DROP|ALTER|DELETE|SET)$/i.exec(token.value)) {
			return token.value.toUpperCase();
		}
	}
	return null;
}

function should_break_select_after_insert_target(document, tokens, index) {
	var token = tokens[index];
	if (!is_word(token, 'SELECT') || !line_has_code_before_token(document, token)) {
		return false;
	}
	if (is_inside_nested_scope(document, token)) {
		return false;
	}
	return previous_top_level_statement_start(tokens, index) == 'INSERT';
}

function should_break_select_after_create_as_or_set_operator(document, tokens, index) {
	var token = tokens[index];
	var previous = tokens[index - 1];
	var beforePrevious = tokens[index - 2];
	if (!is_word(token, 'SELECT') || !line_has_code_before_token(document, token)) {
		return false;
	}
	if (is_inside_nested_scope(document, token)) {
		return false;
	}
	if (is_word(previous, 'AS') && previous_top_level_statement_start(tokens, index) == 'CREATE') {
		return true;
	}
	if (is_word(previous) && /^(UNION|INTERSECT|EXCEPT)$/i.exec(previous.value)) {
		return true;
	}
	return is_word(previous, 'ALL')
		&& is_word(beforePrevious)
		&& /^(UNION|INTERSECT|EXCEPT)$/i.exec(beforePrevious.value);
}

function line_has_code_before_token(document, token) {
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

function previous_code_token(tokens, index) {
	return sqlClauseContext.previous_code_token(tokens, index);
}

function next_code_token(tokens, index) {
	return sqlClauseContext.next_code_token(tokens, index);
}

function is_condition_connector_token(token) {
	return is_word(token, 'AND') || is_word(token, 'OR');
}

function condition_block_for_connector(nodes, token) {
	for (var i = 0; i < (nodes.conditionBlocks || []).length; i++) {
		var block = nodes.conditionBlocks[i];
		if (token.line < block.startLine || token.line > block.endLine) {
			continue;
		}
		for (var s = 0; s < (block.segments || []).length; s++) {
			var segment = block.segments[s];
			if (segment.tokens && segment.tokens.length > 0 && segment.tokens[0].index == token.index) {
				return block;
			}
		}
	}

	return null;
}

function is_recursive_with_modifier(tokens, index, match) {
	return match
		&& match.clause
		&& match.clause.name == 'RECURSIVE'
		&& index > 0
		&& is_word(tokens[index - 1], 'WITH')
		&& tokens[index - 1].line == tokens[index].line;
}

function condition_clause_indent(keyword) {
	if (/^ON$/i.exec(keyword || '')) {
		return '     ';
	}
	return '';
}

function condition_connector_indent(connector, keyword) {
	var target = /^(ON|QUALIFY)$/i.exec(keyword || '') ? 7 : String(keyword || '').length;
	var width = target - String(connector || '').length;
	if (width < 0) {
		width = 0;
	}
	return new Array(width + 1).join(' ');
}

function owner_query_scope(document, token) {
	var scopes = document.scopes || [];
	var owner = null;

	for (var i = 0; i < scopes.length; i++) {
		var scope = scopes[i];
		if (scope.kind != 'query' || typeof scope.bodyIndent != 'string') {
			continue;
		}
		if (token.index <= scope.startTokenIndex || token.index >= scope.endTokenIndex) {
			continue;
		}
		if (!owner || (scope.endTokenIndex - scope.startTokenIndex) < (owner.endTokenIndex - owner.startTokenIndex)) {
			owner = scope;
		}
	}

	return owner;
}

function query_scope_for_token(document, token) {
	var scopes = document.scopes || [];
	var owner = null;

	for (var i = 0; i < scopes.length; i++) {
		var scope = scopes[i];
		if (scope.kind != 'query') {
			continue;
		}
		if (token.index < scope.startTokenIndex || token.index > scope.endTokenIndex) {
			continue;
		}
		if (!owner || (scope.endTokenIndex - scope.startTokenIndex) < (owner.endTokenIndex - owner.startTokenIndex)) {
			owner = scope;
		}
	}

	return owner;
}

function update_query_clause_context(context, clause) {
	sqlClauseContext.update_query_clause_context(context, clause);
}

function query_context_before_token(document, tokens, index, dialect) {
	var token = tokens[index];
	var queryScope = query_scope_for_token(document, token);
	var context = sqlClauseContext.create_query_context();

	for (var i = 0; i < index; i++) {
		var current = tokens[i];
		var currentQueryScope = query_scope_for_token(document, current);
		var match;

		if (queryScope && (!currentQueryScope || currentQueryScope.id != queryScope.id)) {
			continue;
		}
		if (is_inside_nested_scope(document, current)) {
			continue;
		}

		match = clause_at(tokens, i, dialect);
		if (!match) {
			continue;
		}
		if (sqlGroupByExtension.is_start(tokens, i) || is_recursive_with_modifier(tokens, i, match)) {
			i += match.length - 1;
			continue;
		}
		update_query_clause_context(context, match.clause);
		i += match.length - 1;
	}

	return context;
}

function can_precede_qualify_clause(previous) {
	var value;

	if (!previous) {
		return false;
	}
	if (previous.type == 'operator') {
		return false;
	}
	if (previous.type == 'punctuation') {
		return previous.value == ')';
	}
	if (previous.type != 'word') {
		return true;
	}

	value = previous.value.toUpperCase();
	return !/^(AS|SELECT|FROM|JOIN|WHERE|ON|HAVING|QUALIFY|AND|OR|NOT|IN|EXISTS|WHEN|THEN|ELSE|BY)$/.test(value);
}

function can_follow_qualify_clause(next) {
	var value;

	if (!next) {
		return false;
	}
	if (next.type == 'operator') {
		return false;
	}
	if (next.type == 'punctuation' && /^(,|;|\))$/.test(next.value)) {
		return false;
	}
	if (next.type == 'word') {
		value = next.value.toUpperCase();
		if (value == 'AS') {
			return false;
		}
	}

	return true;
}

function should_apply_clause_match(document, tokens, index, match, dialect) {
	var context;

	if (!match || !match.clause || match.clause.name != 'QUALIFY') {
		return true;
	}

	context = query_context_before_token(document, tokens, index, dialect);

	return sqlClauseContext.is_real_qualify_clause(tokens, index, context);
}

function clause_indent(document, match, nodes, token) {
	if (!match || !match.clause) {
		return '';
	}
	if (match.clause.conditionClause) {
		return condition_clause_indent(match.clause.name);
	}
	var queryScope = owner_query_scope(document, token);
	if (queryScope) {
		return queryScope.bodyIndent || '';
	}
	return '';
}

function connector_indent(nodes, token) {
	var block = condition_block_for_connector(nodes, token);
	return condition_connector_indent(token.value.toUpperCase(), block ? block.keyword : '');
}

function apply_clause_line_break_mutations(document, nodes, mutations, config) {
	if (!document || !nodes || !mutations) {
		return;
	}

	var dialect = dialect_name(config && config.dialect ? config.dialect : document.tokenizerOptions);
	var tokens = active_tokens(document);

	for (var i = 0; i < tokens.length; i++) {
		var token = tokens[i];
		if (is_inside_nested_scope(document, token)) {
			continue;
		}
		var match = clause_at(tokens, i, dialect);

		if (match) {
			if (sqlGroupByExtension.is_start(tokens, i)) {
				i += match.length - 1;
				continue;
			}
			if (!should_apply_clause_match(document, tokens, i, match, dialect)) {
				i += match.length - 1;
				continue;
			}
			if (is_recursive_with_modifier(tokens, i, match)) {
				i += match.length - 1;
				continue;
			}
			if ((match.clause.name != 'SELECT' && line_has_code_before_token(document, token))
				|| should_break_select_after_insert_target(document, tokens, i)
				|| should_break_select_after_create_as_or_set_operator(document, tokens, i)) {
				sqlFormatMutations.add_line_break_before_token(
					mutations,
					token.id,
					clause_indent(document, match, nodes, token),
					''
				);
			}
			i += match.length - 1;
			continue;
		}

		if (is_condition_connector_token(token) && line_has_code_before_token(document, token)) {
			if (condition_block_for_connector(nodes, token)) {
				sqlFormatMutations.add_line_break_before_token(
					mutations,
					token.id,
					connector_indent(nodes, token),
					''
				);
			}
		}
	}
}

exports.apply_clause_line_break_mutations = apply_clause_line_break_mutations;
