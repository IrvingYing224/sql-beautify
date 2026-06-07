var sqlTokenizer = require('./sql-tokenizer');
var sqlClauseContext = require('./sql-clause-context');

function is_ignorable(token) {
	return token && (
		token.type == 'whitespace'
		|| token.type == 'newline'
		|| token.type == 'line_comment'
		|| token.type == 'block_comment'
	);
}

function snippet_for_range(source, start_index, end_index) {
	var start = Math.max(0, start_index - 40);
	var end = Math.min(source.length, end_index + 120);
	return source.slice(start, end);
}

function note_segment(segments, kind, text) {
	segments.push({
		kind: kind,
		text: text
	});
}

function build_syntax_lookup(items) {
	var lookup = {};

	for (var i = 0; i < items.length; i++) {
		lookup[String(items[i].name || '').toUpperCase()] = items[i].kind;
	}

	return lookup;
}

function get_depth_state(states, depth) {
	if (!states[depth]) {
		states[depth] = sqlClauseContext.create_query_context();
	}

	return states[depth];
}

function reset_depth_state(states, depth) {
	states[depth] = null;
}

function update_select_context(state, value) {
	if (value == 'GROUP') {
		sqlClauseContext.update_query_clause_context(state, 'GROUP BY');
		return;
	}

	if (value == 'ORDER') {
		sqlClauseContext.update_query_clause_context(state, 'ORDER BY');
		return;
	}

	sqlClauseContext.update_query_clause_context(state, value);
}

function detect(text, dialectCapabilities) {
	var source = String(text || '');
	var capabilities = dialectCapabilities || {};
	var tokens = sqlTokenizer.tokenize(source, capabilities);
	var syntaxLookup = build_syntax_lookup(capabilities.knownLowConfidenceSyntax || []);
	var segments = [];
	var states = [];
	var depth = 0;
	var state;
	var value;
	var kind;
	var matchRange;

	for (var i = 0; i < tokens.length; i++) {
		if (tokens[i].type == 'punctuation') {
			if (tokens[i].value == '(') {
				depth += 1;
				reset_depth_state(states, depth);
			} else if (tokens[i].value == ')') {
				reset_depth_state(states, depth);
				depth = Math.max(0, depth - 1);
			} else if (tokens[i].value == ';' && depth == 0) {
				reset_depth_state(states, 0);
			}
			continue;
		}

		if (is_ignorable(tokens[i]) || tokens[i].type != 'word') {
			continue;
		}

		state = get_depth_state(states, depth);
		value = tokens[i].value.toUpperCase();

		if (syntaxLookup.MATCH_RECOGNIZE || syntaxLookup.MATCH) {
			matchRange = sqlClauseContext.match_recognize_range(source, tokens, i);
			if (matchRange) {
				note_segment(
					segments,
					syntaxLookup.MATCH_RECOGNIZE || syntaxLookup.MATCH,
					matchRange.text || snippet_for_range(source, tokens[i].start, tokens[i].end)
				);
				update_select_context(state, value);
				i = typeof matchRange.endIndex == 'number' && matchRange.endIndex > i
					? matchRange.endIndex
					: i;
				continue;
			}
		}

		kind = syntaxLookup[value];
		if (kind == 'dialect_unsupported_clause'
			&& value == 'QUALIFY'
			&& sqlClauseContext.is_real_qualify_clause(tokens, i, state)) {
			note_segment(segments, kind, snippet_for_range(source, tokens[i].start, tokens[i].end));
		} else if (kind == 'known_unmodeled_construct'
			&& value == 'MERGE'
			&& sqlClauseContext.is_merge_statement(tokens, i, depth)) {
			note_segment(segments, kind, snippet_for_range(source, tokens[i].start, tokens[i].end));
		} else if (kind == 'known_unmodeled_construct'
			&& /^(PIVOT|UNPIVOT)$/.test(value)
			&& sqlClauseContext.is_pivot_construct(tokens, i, state)) {
			note_segment(segments, kind, snippet_for_range(source, tokens[i].start, tokens[i].end));
		}

		update_select_context(state, value);
	}

	return segments;
}

exports.detect = detect;
