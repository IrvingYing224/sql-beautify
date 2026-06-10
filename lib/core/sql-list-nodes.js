var scopeModel = require('./sql-scope-model');
var sqlGroupByExtension = require('./sql-group-by-extension');
var sqlFormatNavigation = require('./sql-format-navigation');
var sqlNodeUtils = require('./sql-node-utils');

var is_word = sqlNodeUtils.is_word;

function is_window_scope_token(document, token) {
	return scopeModel.find_owner_scope(document.scopes || [], token, 'windowSpec') != null;
}

function is_order_by_start(tokens, index) {
	return is_word(tokens[index], 'ORDER')
		&& tokens[index + 1]
		&& is_word(tokens[index + 1], 'BY');
}

function is_list_boundary_token(tokens, index, kind) {
	var token = tokens[index];

	if (!is_word(token)) {
		return false;
	}
	if (kind == 'selectList') {
		return is_word(token, 'FROM');
	}
	if (kind == 'groupByList') {
		if (sqlGroupByExtension.is_start(tokens, index)) {
			return true;
		}
		return is_word(token, 'ORDER')
			|| is_word(token, 'SORT')
			|| is_word(token, 'CLUSTER')
			|| is_word(token, 'DISTRIBUTE')
			|| is_word(token, 'LIMIT')
			|| is_word(token, 'UNION')
			|| is_word(token, 'HAVING')
			|| is_word(token, 'QUALIFY');
	}
	if (kind == 'orderByList') {
		return is_word(token, 'LIMIT')
			|| is_word(token, 'UNION')
			|| is_word(token, 'QUALIFY')
			|| is_word(token, 'INTERSECT')
			|| is_word(token, 'EXCEPT');
	}
	return false;
}

function list_boundary_end_token(tokens, index, kind) {
	if (kind == 'groupByList'
		&& sqlGroupByExtension.is_start(tokens, index)
		&& tokens[index - 1]
		&& tokens[index - 1].type == 'punctuation'
		&& tokens[index - 1].value == ',') {
		return tokens[index - 2] || tokens[index - 1];
	}
	return tokens[index - 1];
}

function create_list_spans(document) {
	var tokens = sqlFormatNavigation.active_tokens(document);
	var spans = [];
	var activeSpans = [];
	var parenDepth = 0;
	var caseDepth = 0;
	var nextSpanId = 0;

	function close_active_span(activeIndex, endToken) {
		var current = activeSpans[activeIndex];
		current.endTokenIndex = endToken ? endToken.index : current.startTokenIndex;
		current.endLine = endToken ? endToken.line : current.startLine;
		spans.push(current);
		activeSpans.splice(activeIndex, 1);
	}

	function close_current_depth_spans(endToken) {
		for (var s = activeSpans.length - 1; s >= 0; s--) {
			var current = activeSpans[s];
			if (current.parenDepth == parenDepth && current.caseDepth == caseDepth) {
				close_active_span(s, endToken);
			}
		}
	}

	for (var i = 0; i < tokens.length; i++) {
		var token = tokens[i];

		if (is_word(token, 'SELECT')) {
			activeSpans.push({
				id: 'selectList:' + nextSpanId++,
				kind: 'selectList',
				startTokenIndex: token.index,
				endTokenIndex: token.index,
				startLine: token.line,
				endLine: token.line,
				parenDepth: parenDepth,
				caseDepth: caseDepth
			});
		}

		if (is_word(token, 'GROUP')
			&& tokens[i + 1]
			&& is_word(tokens[i + 1], 'BY')) {
			activeSpans.push({
				id: 'groupByList:' + nextSpanId++,
				kind: 'groupByList',
				startTokenIndex: token.index,
				endTokenIndex: token.index,
				startLine: token.line,
				endLine: token.line,
				parenDepth: parenDepth,
				caseDepth: caseDepth
			});
		}

		if (is_order_by_start(tokens, i) && !is_window_scope_token(document, token)) {
			activeSpans.push({
				id: 'orderByList:' + nextSpanId++,
				kind: 'orderByList',
				startTokenIndex: tokens[i + 1].index,
				endTokenIndex: tokens[i + 1].index,
				startLine: token.line,
				endLine: token.line,
				parenDepth: parenDepth,
				caseDepth: caseDepth
			});
		}

		if (token.type == 'punctuation' && token.value == '(') {
			parenDepth += 1;
		} else if (token.type == 'punctuation' && token.value == ')' && parenDepth > 0) {
			close_current_depth_spans(tokens[i - 1]);
			parenDepth -= 1;
		}

		if (is_word(token, 'CASE')) {
			caseDepth += 1;
		} else if (is_word(token, 'END') && caseDepth > 0) {
			caseDepth -= 1;
		}

		for (var s = activeSpans.length - 1; s >= 0; s--) {
			var current = activeSpans[s];
			if (current.parenDepth != parenDepth || current.caseDepth != caseDepth) {
				continue;
			}
			if (is_list_boundary_token(tokens, i, current.kind)) {
				close_active_span(s, list_boundary_end_token(tokens, i, current.kind));
			}
		}
	}

	for (var a = 0; a < activeSpans.length; a++) {
		var active = activeSpans[a];
		var last = tokens.length > 0 ? tokens[tokens.length - 1] : null;
		active.endTokenIndex = last ? last.index : active.startTokenIndex;
		active.endLine = last ? last.line : active.startLine;
		spans.push(active);
	}

	for (var cleanup = 0; cleanup < spans.length; cleanup++) {
		delete spans[cleanup].parenDepth;
		delete spans[cleanup].caseDepth;
	}

	return spans;
}

function span_contains_token(span, token) {
	return token.index >= span.startTokenIndex && token.index <= span.endTokenIndex;
}

function select_span_for_token(spans, token) {
	var match = null;
	for (var i = 0; i < spans.length; i++) {
		if (span_contains_token(spans[i], token)) {
			if (!match
				|| (spans[i].endTokenIndex - spans[i].startTokenIndex)
					< (match.endTokenIndex - match.startTokenIndex)) {
				match = spans[i];
			}
		}
	}
	return match;
}

function owner_scope_for_separator(document, token, selectSpans) {
	var owner = scopeModel.find_owner_scope(document.scopes || [], token, [
		'functionCall',
		'inList',
		'windowSpec',
		'parenList'
	]);

	if (owner) {
		return {
			ownerScopeId: owner.id,
			ownerKind: owner.kind
		};
	}

	var selectSpan = select_span_for_token(selectSpans, token);
	if (selectSpan) {
		return {
			ownerScopeId: selectSpan.id,
			ownerKind: selectSpan.kind
		};
	}

	return {
		ownerScopeId: null,
		ownerKind: null
	};
}

function find_separators(document, selectSpans) {
	var separators = [];
	var spans = selectSpans || create_list_spans(document);
	var active = sqlFormatNavigation.active_tokens(document);
	var activeIndexByTokenIndex = {};

	for (var a = 0; a < active.length; a++) {
		activeIndexByTokenIndex[String(active[a].index)] = a;
	}

	for (var i = 0; i < document.tokens.length; i++) {
		var token = document.tokens[i];
		if (token.type != 'punctuation' || token.value != ',') {
			continue;
		}
		var activeIndex = activeIndexByTokenIndex[String(token.index)];
		if (typeof activeIndex == 'number'
			&& sqlGroupByExtension.is_start(active, activeIndex + 1)) {
			continue;
		}
		var owner = owner_scope_for_separator(document, token, spans);
		if (owner.ownerScopeId === null || owner.ownerKind === null) {
			continue;
		}
		separators.push({
			id: 'separator:' + separators.length,
			tokenId: token.id,
			tokenIndex: token.index,
			line: token.line,
			column: token.column,
			ownerScopeId: owner.ownerScopeId,
			ownerKind: owner.ownerKind
		});
	}

	return separators;
}

exports.create_list_spans = create_list_spans;
exports.find_separators = find_separators;
