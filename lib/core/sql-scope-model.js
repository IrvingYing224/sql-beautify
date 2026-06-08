var sqlClauseRegistry = require('./sql-clause-registry');
var sqlGroupByExtension = require('./sql-group-by-extension');
var sqlFormatNavigation = require('./sql-format-navigation');
var sqlClauseContext = require('./sql-clause-context');

var CONDITION_KEYWORDS = {
	ON: true,
	WHERE: true,
	HAVING: true,
	QUALIFY: true
};

var NON_FUNCTION_WORDS = {
	AND: true,
	AS: true,
	BY: true,
	CASE: true,
	ELSE: true,
	END: true,
	FROM: true,
	GROUP: true,
	HAVING: true,
	IN: true,
	JOIN: true,
	ON: true,
	NOT: true,
	OR: true,
	ORDER: true,
	OVER: true,
	SELECT: true,
	THEN: true,
	WHEN: true,
	WHERE: true
};

function is_code_token(token) {
	return token && token.isCode;
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

function token_value(token) {
	return token && token.value ? token.value.toUpperCase() : '';
}

function create_scope(scopes, kind, token, parentScopeId, fields) {
	var scope = {
		id: scopes.length,
		kind: kind,
		startLine: token ? token.line : 0,
		endLine: token ? token.line : 0,
		startTokenIndex: token ? token.index : -1,
		endTokenIndex: token ? token.index : -1,
		parentScopeId: typeof parentScopeId == 'number' ? parentScopeId : null,
		ownerText: '',
		keyword: ''
	};
	var key;
	fields = fields || {};
	for (key in fields) {
		if (Object.prototype.hasOwnProperty.call(fields, key)) {
			scope[key] = fields[key];
		}
	}
	scopes.push(scope);
	return scope;
}

function close_scope(scope, token) {
	if (!scope || !token) {
		return;
	}
	scope.endLine = token.line;
	scope.endTokenIndex = token.index;
}

function line_indent(document, lineIndex) {
	var line = document.lines[lineIndex];
	if (!line) {
		return '';
	}
	return String(line.raw || '').match(/^\s*/)[0];
}

function repeat_space(count) {
	return new Array(count + 1).join(' ');
}

function indent_unit(options) {
	return options && options.indentStyle == 'tab' ? '\t' : '    ';
}

function condition_base_indent(scopes, document, scope) {
	var lineIndent = line_indent(document, scope.startLine);
	var parent = sqlFormatNavigation.scope_by_id_from_list(scopes, scope.parentScopeId);
	if (parent && parent.kind == 'query' && typeof parent.bodyIndent == 'string') {
		return parent.bodyIndent;
	}
	return lineIndent;
}

function condition_close_indent(scopes, document, scope) {
	var prefix = condition_base_indent(scopes, document, scope);
	var target = /^(ON|QUALIFY)$/i.exec(scope.keyword || '')
		? prefix.length + 7
		: prefix.length + String(scope.keyword || '').length;
	var width = target - prefix.length - 3;
	if (width < 0) {
		width = 0;
	}
	return prefix + repeat_space(width);
}

function current_parent_scope_id(rootScope, activeCondition, stack) {
	if (stack.length > 0) {
		return stack[stack.length - 1].id;
	}
	if (activeCondition) {
		return activeCondition.id;
	}
	return rootScope ? rootScope.id : null;
}

function current_query_scope_id(rootScope, stack) {
	for (var i = stack.length - 1; i >= 0; i--) {
		if (stack[i].kind == 'query') {
			return stack[i].id;
		}
	}
	return rootScope ? rootScope.id : null;
}

function can_start_condition_at_current_scope(state) {
	if (state.parenStack.length == 0) {
		return true;
	}
	var current = state.parenStack[state.parenStack.length - 1];
	return current.kind == 'query'
		&& (!state.activeCondition || current.parentScopeId != state.activeCondition.id);
}

function classify_paren_owner(tokens, index) {
	var previous = index > 0 ? tokens[index - 1] : null;
	var next = index + 1 < tokens.length ? tokens[index + 1] : null;
	var previousValue = token_value(previous);

	if (previousValue == 'OVER') {
		return 'windowSpec';
	}

	if (next && token_value(next) == 'SELECT') {
		return 'query';
	}

	if (previousValue == 'IN') {
		return 'inList';
	}

	if (previous && previous.type == 'word' && !NON_FUNCTION_WORDS[previousValue]) {
		return 'functionCall';
	}

	return 'parenList';
}

function paren_owner_text(tokens, index, kind) {
	var previous = index > 0 ? tokens[index - 1] : null;
	if (kind == 'functionCall' && previous) {
		return previous.value + '(';
	}
	if (kind == 'inList') {
		return 'IN (';
	}
	if (kind == 'windowSpec') {
		return 'OVER (';
	}
	return '(';
}

function dialect_name(options) {
	if (options && options.dialect) {
		return options.dialect;
	}
	return String(options || 'generic');
}

function is_condition_keyword(tokens, index, queryContext) {
	var token = tokens[index];
	if (!is_word(token) || !CONDITION_KEYWORDS[token.value.toUpperCase()]) {
		return false;
	}
	if (is_word(token, 'QUALIFY')) {
		return sqlClauseContext.is_real_qualify_clause(tokens, index, queryContext);
	}
	return true;
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
			return clause;
		}
	}

	return null;
}

function is_clause_boundary(tokens, index, dialect) {
	var token = tokens[index];
	var clause;

	if (!is_word(token)) {
		return false;
	}
	if (is_condition_keyword(token)) {
		return true;
	}
	if (sqlGroupByExtension.is_start(tokens, index)) {
		return false;
	}
	clause = clause_at(tokens, index, dialect);
	return clause && clause.conditionReset === true;
}

function should_update_query_context(tokens, index, clause, queryContext) {
	if (!clause) {
		return false;
	}
	if (clause.name == 'QUALIFY') {
		return sqlClauseContext.is_real_qualify_clause(tokens, index, queryContext);
	}
	return true;
}

function close_condition_if_needed(state, tokens, index, previousToken, dialect) {
	var token = tokens[index];
	if (!state.activeCondition || !token || !previousToken) {
		return;
	}
	if (state.parenStack.length != state.activeCondition.parenDepth) {
		return;
	}
	if (token.type == 'punctuation' && token.value == ';') {
		close_scope(state.activeCondition, previousToken);
		state.activeCondition = null;
		return;
	}
	if (token.type == 'punctuation' && token.value == ')') {
		close_scope(state.activeCondition, previousToken);
		state.activeCondition = null;
		return;
	}
	if (!is_clause_boundary(tokens, index, dialect)) {
		return;
	}
	if (token.index == state.activeCondition.startTokenIndex) {
		return;
	}
	close_scope(state.activeCondition, previousToken);
	state.activeCondition = null;
}

function start_condition(scopes, parentScopeId, state, token) {
	if (state.activeCondition) {
		close_scope(state.activeCondition, state.previousToken || token);
	}
	state.activeCondition = create_scope(scopes, 'conditionBlock', token, parentScopeId, {
		keyword: token.value.toUpperCase(),
		ownerText: token.value.toUpperCase(),
		parenDepth: state.parenStack.length
	});
}

function build(document, options) {
	var tokens = sqlFormatNavigation.active_tokens(document);
	var scopes = [];
	var lastLine = document.lines.length > 0 ? document.lines.length - 1 : 0;
	var rootToken = tokens.length > 0 ? tokens[0] : null;
	var rootScope = create_scope(scopes, 'query', rootToken, null, {
		startLine: 0,
		endLine: lastLine,
		startTokenIndex: rootToken ? rootToken.index : -1,
		endTokenIndex: tokens.length > 0 ? tokens[tokens.length - 1].index : -1,
		ownerText: 'query'
	});
	var state = {
		parenStack: [],
		caseStack: [],
		activeCondition: null,
		previousToken: null,
		queryContext: sqlClauseContext.create_query_context()
	};
	var dialect = dialect_name(options || document.tokenizerOptions);
	var unit = indent_unit(options || document.tokenizerOptions);

	for (var i = 0; i < tokens.length; i++) {
		var token = tokens[i];
		close_condition_if_needed(state, tokens, i, state.previousToken, dialect);

		if (is_condition_keyword(tokens, i, state.queryContext) && can_start_condition_at_current_scope(state)) {
			start_condition(scopes, current_query_scope_id(rootScope, state.parenStack), state, token);
		}

		if (is_word(token, 'CASE')) {
			var caseScope = create_scope(scopes, 'caseExpr', token, current_parent_scope_id(rootScope, state.activeCondition, state.parenStack.concat(state.caseStack)), {
				keyword: 'CASE',
				ownerText: 'CASE'
			});
			state.caseStack.push(caseScope);
		} else if (is_word(token, 'END') && state.caseStack.length > 0) {
			close_scope(state.caseStack.pop(), token);
		}

		if (token.type == 'punctuation' && token.value == '(') {
			var kind = classify_paren_owner(tokens, i);
			var parentStack = state.parenStack.concat(state.caseStack);
			var parentScopeId = current_parent_scope_id(rootScope, state.activeCondition, parentStack);
				var parentScope = typeof parentScopeId == 'number' ? scopes[parentScopeId] : null;
				var openIndent = line_indent(document, token.line);
				var closeIndent = parentScope ? line_indent(document, parentScope.startLine) : openIndent;
				if (parentScope && parentScope.kind == 'conditionBlock' && kind != 'query') {
					closeIndent = condition_close_indent(scopes, document, parentScope);
				}
				var scope = create_scope(scopes, kind, token, parentScopeId, {
					ownerText: paren_owner_text(tokens, i, kind),
					openLine: token.line,
					openTokenIndex: token.index,
					openIndent: openIndent,
					bodyIndent: openIndent + unit,
					closeIndent: closeIndent,
					closeIndentOwnerKind: parentScope ? parentScope.kind : kind
				});
			state.parenStack.push(scope);
		} else if (token.type == 'punctuation' && token.value == ')' && state.parenStack.length > 0) {
			var closing = state.parenStack.pop();
			close_scope(closing, token);
			closing.closeLine = token.line;
			closing.closeTokenIndex = token.index;
		}

		var clause = clause_at(tokens, i, dialect);
		if (clause
			&& !sqlGroupByExtension.is_start(tokens, i)
			&& should_update_query_context(tokens, i, clause, state.queryContext)) {
			sqlClauseContext.update_query_clause_context(state.queryContext, clause);
		}

		state.previousToken = token;
	}

	while (state.caseStack.length > 0) {
		close_scope(state.caseStack.pop(), state.previousToken);
	}
	while (state.parenStack.length > 0) {
		close_scope(state.parenStack.pop(), state.previousToken);
	}
	if (state.activeCondition) {
		close_scope(state.activeCondition, state.previousToken);
	}

	return scopes;
}

function find_scopes_by_kind(scopes, kind) {
	return (scopes || []).filter(function(scope) {
		return scope.kind == kind;
	});
}

function target_line(target) {
	if (typeof target == 'number') {
		return target;
	}
	if (target && typeof target.line == 'number') {
		return target.line;
	}
	if (target && typeof target.lineIndex == 'number') {
		return target.lineIndex;
	}
	return -1;
}

function target_token_index(target) {
	if (target && typeof target.index == 'number') {
		return target.index;
	}
	if (target && typeof target.tokenIndex == 'number') {
		return target.tokenIndex;
	}
	return -1;
}

function kind_matches(scope, kinds) {
	if (!kinds) {
		return true;
	}
	if (typeof kinds == 'string') {
		return scope.kind == kinds;
	}
	return kinds.indexOf(scope.kind) >= 0;
}

function contains_target(scope, line, tokenIndex) {
	if (line < scope.startLine || line > scope.endLine) {
		return false;
	}
	if (tokenIndex < 0) {
		return true;
	}
	return tokenIndex >= scope.startTokenIndex && tokenIndex <= scope.endTokenIndex;
}

function find_owner_scope(scopes, target, kinds) {
	var line = target_line(target);
	var tokenIndex = target_token_index(target);
	var matches = [];

	for (var i = 0; i < (scopes || []).length; i++) {
		var scope = scopes[i];
		if (kind_matches(scope, kinds) && contains_target(scope, line, tokenIndex)) {
			matches.push(scope);
		}
	}

	matches.sort(function(a, b) {
		var aSpan = (a.endTokenIndex - a.startTokenIndex);
		var bSpan = (b.endTokenIndex - b.startTokenIndex);
		return aSpan - bSpan;
	});

	return matches.length > 0 ? matches[0] : null;
}

function is_inside_scope_kind(scopes, target, kind) {
	return find_owner_scope(scopes, target, kind) != null;
}

exports.build = build;
exports.find_scopes_by_kind = find_scopes_by_kind;
exports.find_owner_scope = find_owner_scope;
exports.is_inside_scope_kind = is_inside_scope_kind;
