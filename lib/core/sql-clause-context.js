function is_ignorable(token) {
	return token && (
		token.type == 'whitespace'
		|| token.type == 'newline'
		|| token.type == 'line_comment'
		|| token.type == 'block_comment'
	);
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

function next_code_index(tokens, index) {
	for (var i = index + 1; i < (tokens || []).length; i++) {
		if (!is_ignorable(tokens[i])) {
			return i;
		}
	}
	return -1;
}

function next_code_token(tokens, index) {
	var found = next_code_index(tokens, index);
	return found >= 0 ? tokens[found] : null;
}

function previous_code_token(tokens, index) {
	for (var i = index - 1; i >= 0; i--) {
		if (!is_ignorable(tokens[i])) {
			return tokens[i];
		}
	}
	return null;
}

function find_matching_paren(tokens, openIndex) {
	var depth = 0;

	for (var i = openIndex; i < (tokens || []).length; i++) {
		if (tokens[i].type == 'punctuation' && tokens[i].value == '(') {
			depth += 1;
		} else if (tokens[i].type == 'punctuation' && tokens[i].value == ')') {
			depth -= 1;
			if (depth == 0) {
				return i;
			}
		}
	}

	return -1;
}

function create_query_context() {
	return {
		inSelect: false,
		seenFrom: false,
		lastClause: ''
	};
}

function clause_name(clauseOrName) {
	if (!clauseOrName) {
		return '';
	}
	if (typeof clauseOrName == 'string') {
		return clauseOrName.toUpperCase();
	}
	return String(clauseOrName.name || '').toUpperCase();
}

function update_query_clause_context(context, clauseOrName) {
	var name = clause_name(clauseOrName);

	if (!context) {
		return;
	}

	if (name == 'SELECT') {
		context.inSelect = true;
		context.seenFrom = false;
		context.lastClause = 'SELECT';
		return;
	}

	if (!context.inSelect) {
		return;
	}

	if (/^(FROM|JOIN|LEFT JOIN|LEFT OUTER JOIN|RIGHT JOIN|RIGHT OUTER JOIN|FULL JOIN|FULL OUTER JOIN|INNER JOIN|CROSS JOIN|LEFT SEMI JOIN|LEFT ANTI JOIN)$/.test(name)) {
		context.seenFrom = true;
		context.lastClause = name == 'FROM' ? 'FROM' : 'JOIN';
		return;
	}

	if (/^(WHERE|GROUP BY|ORDER BY|HAVING|QUALIFY|LIMIT|UNION|INTERSECT|EXCEPT|ON)$/.test(name)) {
		context.lastClause = name.split(' ')[0];
	}
}

function is_clause_boundary_word(value) {
	return /^(SELECT|FROM|JOIN|WHERE|GROUP|ORDER|HAVING|QUALIFY|LIMIT|UNION|INTERSECT|EXCEPT|ON)$/.test(String(value || '').toUpperCase());
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
		if (value == 'AS' || is_clause_boundary_word(value)) {
			return false;
		}
	}

	return true;
}

function is_real_qualify_clause(tokens, index, context) {
	var previous;
	var next;

	if (!is_word((tokens || [])[index], 'QUALIFY')) {
		return false;
	}

	if (!context || !context.inSelect || !context.seenFrom) {
		return false;
	}

	previous = previous_code_token(tokens, index);
	next = next_code_token(tokens, index);

	return can_precede_qualify_clause(previous)
		&& can_follow_qualify_clause(next);
}

function is_statement_boundary(previous) {
	return !previous || (previous.type == 'punctuation' && previous.value == ';');
}

function is_merge_statement(tokens, index, depth) {
	var previous = previous_code_token(tokens, index);
	var next = next_code_token(tokens, index);

	return depth == 0
		&& is_word((tokens || [])[index], 'MERGE')
		&& is_statement_boundary(previous)
		&& is_word(next, 'INTO');
}

function is_pivot_construct(tokens, index, context) {
	var token = (tokens || [])[index];
	var previous = previous_code_token(tokens, index);
	var next = next_code_token(tokens, index);

	if (!is_word(token) || !/^(PIVOT|UNPIVOT)$/.test(token.value.toUpperCase())) {
		return false;
	}

	if (!context || !context.inSelect || !context.seenFrom) {
		return false;
	}

	if (!/^(FROM|JOIN)$/.test(context.lastClause || '')) {
		return false;
	}

	if (!previous || (previous.type == 'word' && /^(AS|FROM|JOIN)$/i.exec(previous.value))) {
		return false;
	}

	if (previous.type == 'operator') {
		return false;
	}

	return next && next.type == 'punctuation' && next.value == '(';
}

function snippet_range(source, token, index) {
	var start = token ? token.start : 0;
	var end = token ? token.end : 0;
	return {
		startIndex: typeof index == 'number' ? index : -1,
		endIndex: typeof index == 'number' ? index : -1,
		start: start,
		end: end,
		text: String(source || '').slice(Math.max(0, start - 40), Math.min(String(source || '').length, end + 120)),
		complete: false
	};
}

function match_recognize_paren_anchor_index(tokens, index, value) {
	if (value == 'MATCH_RECOGNIZE') {
		return index;
	}
	return next_code_index(tokens, index);
}

function match_recognize_range(source, tokens, index) {
	var token = (tokens || [])[index];
	var value = token && token.type == 'word' ? token.value.toUpperCase() : '';
	var recognizeIndex;
	var anchorIndex;
	var openIndex;
	var closeIndex;

	if (value == 'MATCH') {
		recognizeIndex = next_code_index(tokens, index);
		if (recognizeIndex < 0 || !is_word(tokens[recognizeIndex], 'RECOGNIZE')) {
			return null;
		}
	} else if (value != 'MATCH_RECOGNIZE') {
		return null;
	}

	anchorIndex = match_recognize_paren_anchor_index(tokens, index, value);
	openIndex = next_code_index(tokens, anchorIndex);
	if (openIndex < 0 || !tokens[openIndex] || tokens[openIndex].type != 'punctuation' || tokens[openIndex].value != '(') {
		return null;
	}

	closeIndex = find_matching_paren(tokens, openIndex);
	if (closeIndex < 0) {
		return snippet_range(source, token, index);
	}

	return {
		startIndex: index,
		endIndex: closeIndex,
		start: tokens[index].start,
		end: tokens[closeIndex].end,
		text: String(source || '').slice(tokens[index].start, tokens[closeIndex].end),
		complete: true
	};
}

exports.previous_code_token = previous_code_token;
exports.next_code_token = next_code_token;
exports.next_code_index = next_code_index;
exports.find_matching_paren = find_matching_paren;
exports.create_query_context = create_query_context;
exports.update_query_clause_context = update_query_clause_context;
exports.can_precede_qualify_clause = can_precede_qualify_clause;
exports.can_follow_qualify_clause = can_follow_qualify_clause;
exports.is_real_qualify_clause = is_real_qualify_clause;
exports.is_merge_statement = is_merge_statement;
exports.is_pivot_construct = is_pivot_construct;
exports.match_recognize_range = match_recognize_range;
