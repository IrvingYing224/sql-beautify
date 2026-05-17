var sqlTokenizer = require('./sql-tokenizer');

function is_ignorable(token) {
    return token && (
        token.type == 'whitespace'
        || token.type == 'newline'
        || token.type == 'line_comment'
        || token.type == 'block_comment'
    );
}

function next_code_index(tokens, index) {
    for (var i = index + 1; i < tokens.length; i++) {
        if (!is_ignorable(tokens[i])) {
            return i;
        }
    }
    return -1;
}

function next_code_token(tokens, index) {
    var found = next_code_index(tokens, index);
    if (found >= 0) {
        return tokens[found];
    }
    return null;
}

function previous_code_token(tokens, index) {
    for (var i = index - 1; i >= 0; i--) {
        if (!is_ignorable(tokens[i])) {
            return tokens[i];
        }
    }
    return null;
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
        states[depth] = {
            inSelect: false,
            seenFrom: false,
            lastClause: ''
        };
    }

    return states[depth];
}

function reset_depth_state(states, depth) {
    states[depth] = null;
}

function update_select_context(state, value) {
    if (value == 'SELECT') {
        state.inSelect = true;
        state.seenFrom = false;
        state.lastClause = 'SELECT';
        return;
    }

    if (!state.inSelect) {
        return;
    }

    if (value == 'FROM' || value == 'JOIN') {
        state.seenFrom = true;
        state.lastClause = value;
        return;
    }

    if (/^(WHERE|GROUP|ORDER|HAVING|QUALIFY|LIMIT|UNION|INTERSECT|EXCEPT|ON)$/.test(value)) {
        state.lastClause = value;
    }
}

function is_clause_boundary_word(value) {
    return /^(SELECT|FROM|JOIN|WHERE|GROUP|ORDER|HAVING|QUALIFY|LIMIT|UNION|INTERSECT|EXCEPT|ON)$/.test(value);
}

function has_qualify_expression_after(tokens, index) {
    var next = next_code_token(tokens, index);
    var value;

    if (!next || next.type == 'line_comment' || next.type == 'block_comment') {
        return false;
    }

    if (next.type == 'punctuation' && /^(,|;|\))$/.test(next.value)) {
        return false;
    }

    if (next.type == 'operator') {
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

function is_qualify_clause(tokens, index, state) {
    var previous = previous_code_token(tokens, index);

    if (!state.inSelect || !state.seenFrom) {
        return false;
    }

    if (!can_precede_qualify_clause(previous)) {
        return false;
    }

    return has_qualify_expression_after(tokens, index);
}

function is_statement_boundary(previous) {
    return !previous || (previous.type == 'punctuation' && previous.value == ';');
}

function is_merge_statement(tokens, index, depth) {
    var previous = previous_code_token(tokens, index);
    var next = next_code_token(tokens, index);

    return depth == 0
        && is_statement_boundary(previous)
        && next
        && next.type == 'word'
        && /^INTO$/i.exec(next.value);
}

function is_pivot_construct(tokens, index, state) {
    var previous = previous_code_token(tokens, index);
    var next = next_code_token(tokens, index);

    if (!state.inSelect || !state.seenFrom) {
        return false;
    }

    if (!/^(FROM|JOIN)$/.test(state.lastClause || '')) {
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

function find_matching_paren(tokens, open_index) {
    var depth = 0;

    for (var i = open_index; i < tokens.length; i++) {
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

function match_recognize_text(source, tokens, start_index, paren_anchor_index) {
    var open_index = next_code_index(tokens, paren_anchor_index);
    var close_index;

    if (open_index < 0 || tokens[open_index].type != 'punctuation' || tokens[open_index].value != '(') {
        return '';
    }

    close_index = find_matching_paren(tokens, open_index);
    if (close_index < 0) {
        return snippet_for_range(source, tokens[start_index].start, tokens[start_index].end);
    }

    return source.slice(tokens[start_index].start, tokens[close_index].end);
}

function is_match_recognize(tokens, index, value) {
    var recognize_index;
    var open_index;

    if (value == 'MATCH_RECOGNIZE') {
        open_index = next_code_index(tokens, index);
        return open_index >= 0 && tokens[open_index].type == 'punctuation' && tokens[open_index].value == '(';
    }

    if (value != 'MATCH') {
        return false;
    }

    recognize_index = next_code_index(tokens, index);
    if (recognize_index < 0
        || tokens[recognize_index].type != 'word'
        || tokens[recognize_index].value.toUpperCase() != 'RECOGNIZE') {
        return false;
    }

    open_index = next_code_index(tokens, recognize_index);
    return open_index >= 0 && tokens[open_index].type == 'punctuation' && tokens[open_index].value == '(';
}

function match_recognize_paren_anchor_index(tokens, index, value) {
    if (value == 'MATCH_RECOGNIZE') {
        return index;
    }

    return next_code_index(tokens, index);
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
    var match_anchor_index;
    var segment_text;

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

        if (tokens[i].type != 'word') {
            continue;
        }

        state = get_depth_state(states, depth);
        value = tokens[i].value.toUpperCase();

        if (syntaxLookup.MATCH_RECOGNIZE && is_match_recognize(tokens, i, value)) {
            match_anchor_index = match_recognize_paren_anchor_index(tokens, i, value);
            segment_text = match_recognize_text(source, tokens, i, match_anchor_index);
            note_segment(
                segments,
                syntaxLookup.MATCH_RECOGNIZE,
                segment_text || snippet_for_range(source, tokens[i].start, tokens[i].end)
            );
            update_select_context(state, value);
            continue;
        }

        kind = syntaxLookup[value];
        if (kind == 'dialect_unsupported_clause' && value == 'QUALIFY' && is_qualify_clause(tokens, i, state)) {
            note_segment(segments, kind, snippet_for_range(source, tokens[i].start, tokens[i].end));
        } else if (kind == 'known_unmodeled_construct' && value == 'MERGE' && is_merge_statement(tokens, i, depth)) {
            note_segment(segments, kind, snippet_for_range(source, tokens[i].start, tokens[i].end));
        } else if (kind == 'known_unmodeled_construct' && /^(PIVOT|UNPIVOT)$/.test(value) && is_pivot_construct(tokens, i, state)) {
            note_segment(segments, kind, snippet_for_range(source, tokens[i].start, tokens[i].end));
        }

        update_select_context(state, value);
    }

    return segments;
}

exports.detect = detect;
