var sqlTokenizer = require('./sql-tokenizer');
var sqlClauseRegistry = require('./sql-clause-registry');
var sqlOperatorRegistry = require('./sql-operator-registry');
var sqlUnsupportedPolicy = require('./sql-unsupported-policy');

function is_ignorable(token) {
    return token && (token.type == 'whitespace' || token.type == 'newline');
}

function resolve_dialect_name(dialect) {
    return dialect && dialect.dialect ? dialect.dialect : (dialect || 'generic');
}

function push_paren_kind(stack, kind) {
    stack.push(kind || 'plain');
}

function pop_paren_kind(stack) {
    if (stack.length == 0) {
        return 'plain';
    }
    return stack.pop();
}

function current_paren_kind(stack) {
    if (stack.length == 0) {
        return '';
    }
    return stack[stack.length - 1];
}

function query_depth(stack) {
    var depth = 0;
    for (var i = 0; i < stack.length; i++) {
        if (stack[i] == 'query' || stack[i] == 'inline-query-multiline') {
            depth += 1;
        }
    }
    return depth;
}

function previous_code_token(tokens, index) {
    for (var i = index - 1; i >= 0; i--) {
        if (!is_ignorable(tokens[i])) {
            return tokens[i];
        }
    }
    return null;
}

function next_code_token(tokens, index) {
    for (var i = index + 1; i < tokens.length; i++) {
        if (!is_ignorable(tokens[i])) {
            return tokens[i];
        }
    }
    return null;
}

function has_inline_space_before(source, token) {
    return token && token.start > 0 && /[ \t]/.test(source[token.start - 1] || '');
}

function has_inline_space_after(source, token) {
    return token && token.end < source.length && /[ \t]/.test(source[token.end] || '');
}

function has_spacing_before(source, token) {
    return token && token.start > 0 && /\s/.test(source[token.start - 1] || '');
}

function has_spacing_after(source, token) {
    return token && token.end < source.length && /\s/.test(source[token.end] || '');
}

function is_query_paren(tokens, index, dialect) {
    var previous = previous_code_token(tokens, index);
    var next = next_code_token(tokens, index);

    if (!next || next.type != 'word') {
        return false;
    }

    if (!/^(SELECT|WITH|VALUES)$/i.exec(next.value)) {
        return false;
    }

    if (!previous) {
        return false;
    }

    return previous.type == 'word'
        && /^(AS|FROM|JOIN|LEFT|RIGHT|FULL|INNER|CROSS|ON|INTO|EXISTS|IN|WITH)$/i.exec(previous.value);
}

function get_query_paren_kind(tokens, index, dialect) {
    if (!is_query_paren(tokens, index, dialect)) {
        return null;
    }

    var previous = previous_code_token(tokens, index);
    if (previous && previous.type == 'word' && /^(EXISTS|IN)$/i.exec(previous.value)) {
        return 'inline-query';
    }

    return 'query';
}

function is_multiline_query_paren(source, tokens, index) {
    var close_index = find_matching_paren(tokens, index);
    if (close_index < 0) {
        return false;
    }

    return /[\r\n]/.test(source.slice(tokens[index].end, tokens[close_index].start));
}

function collect_query_paren_metadata(source, dialect) {
    var tokens = sqlTokenizer.tokenize(String(source || ''), dialect);
    var metadata = [];

    for (var i = 0; i < tokens.length; i++) {
        if (tokens[i].type != 'punctuation' || tokens[i].value != '(') {
            continue;
        }

        var kind = get_query_paren_kind(tokens, i, resolve_dialect_name(dialect));
        if (!kind) {
            continue;
        }

        metadata.push({
            kind: kind,
            multiline: is_multiline_query_paren(source, tokens, i)
        });
    }

    return metadata;
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

function protect_opaque_segments(text, dialect, context) {
    var tokens = sqlTokenizer.tokenize(text, dialect);
    var result = '';
    var cursor = 0;

    for (var i = 0; i < tokens.length; i++) {
        if (tokens[i].type == 'word' && /^MATCH_RECOGNIZE$/i.exec(tokens[i].value)) {
            var next = next_code_token(tokens, i);
            if (next && next.type == 'punctuation' && next.value == '(') {
                var close_index = find_matching_paren(tokens, tokens.indexOf(next));
                if (close_index > i) {
                    sqlUnsupportedPolicy.note_unsupported(context, 'opaque_clause', text.slice(tokens[i].start, tokens[close_index].end));
                    result += text.slice(cursor, tokens[i].start);
                    result += context.store('opaque_clause', text.slice(tokens[i].start, tokens[close_index].end));
                    cursor = tokens[close_index].end;
                    i = close_index;
                }
            }
        }
    }

    result += text.slice(cursor);
    return result;
}

function longest_matching_clause(tokens, index, dialect) {
    var clauses = sqlClauseRegistry.get_clauses(dialect);
    var best = null;

    for (var i = 0; i < clauses.length; i++) {
        var matches = true;
        var current_index = index;
        var last_index = index;

        for (var j = 0; j < clauses[i].keywords.length; j++) {
            while (current_index < tokens.length && is_ignorable(tokens[current_index])) {
                current_index += 1;
            }

            var token = tokens[current_index];
            if (!token || token.type != 'word' || token.value.toUpperCase() != clauses[i].keywords[j]) {
                matches = false;
                break;
            }
            last_index = current_index;
            current_index += 1;
        }

        if (matches && (!best || clauses[i].keywords.length > best.clause.keywords.length)) {
            best = {
                clause: clauses[i],
                lastIndex: last_index
            };
        }
    }

    return best;
}

function get_query_clause_context(contexts, depth) {
    if (!contexts[depth]) {
        contexts[depth] = {
            inSelect: false,
            seenFrom: false,
            lastClause: ''
        };
    }

    return contexts[depth];
}

function update_query_clause_context(context, clause) {
    var name = clause && clause.name ? clause.name : '';

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
        context.lastClause = 'JOIN';
        if (name == 'FROM') {
            context.lastClause = 'FROM';
        }
        return;
    }

    if (/^(WHERE|GROUP BY|ORDER BY|HAVING|QUALIFY|LIMIT|UNION|INTERSECT|EXCEPT|ON)$/.test(name)) {
        context.lastClause = name.split(' ')[0];
    }
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

function should_apply_clause_match(tokens, index, clause_match, context) {
    var clause = clause_match && clause_match.clause;
    var previous;
    var next;

    if (clause && clause.name == 'WITH' && context.lastClause == 'GROUP') {
        previous = previous_code_token(tokens, index);
        next = next_code_token(tokens, index);
        if (previous != null
            && previous.type != 'operator'
            && next != null
            && next.type == 'word'
            && /^(CUBE|ROLLUP|GROUPING)$/i.exec(next.value)) {
            return false;
        }
    }

    if (!clause || clause.name != 'QUALIFY') {
        return true;
    }

    previous = previous_code_token(tokens, index);
    next = next_code_token(tokens, clause_match.lastIndex);

    return context.inSelect
        && context.seenFrom
        && can_precede_qualify_clause(previous)
        && can_follow_qualify_clause(next);
}

function append_piece(state, piece) {
    if (piece === '') {
        return;
    }

    state.output += piece;
    state.lastChar = state.output[state.output.length - 1];
}

function ensure_newline(state) {
    state.output = state.output.replace(/[ \t]+$/g, '');
    if (!/\n$/.test(state.output) && state.output !== '') {
        state.output += '\n';
    }
    state.lastChar = state.output[state.output.length - 1] || '';
}

function ensure_space(state) {
    if (state.output === '' || /[\s(]$/.test(state.output)) {
        return;
    }
    state.output += ' ';
    state.lastChar = ' ';
}

function needs_leading_space(output) {
    return /[A-Za-z0-9_$}'"`)\]]$/.test(output || '');
}

function is_unary_prefix_operator(tokens, index) {
    var token = tokens[index];
    var previous = previous_code_token(tokens, index);
    var next = next_code_token(tokens, index);

    if (!token || token.type != 'operator' || (token.value != '-' && token.value != '+')) {
        return false;
    }

    if (!next || next.type == 'operator' || next.type == 'line_comment') {
        return false;
    }

    if (previous == null) {
        return true;
    }

    if (previous.type == 'operator') {
        return true;
    }

    if (previous.type == 'punctuation') {
        return previous.value == '(' || previous.value == ',';
    }

    if (previous.type == 'word') {
        return /^(SELECT|WHEN|THEN|ELSE|AND|OR|NOT|IN|EXISTS|ON|WHERE|HAVING|BY|AS|CASE)$/i.exec(previous.value) != null;
    }

    return false;
}

function split_operator_with_unary_suffix(tokenValue, dialectName) {
    var value = String(tokenValue || '');

    if (value.length < 2) {
        return null;
    }

    var suffix = value[value.length - 1];
    var prefix = value.slice(0, -1);

    if ((suffix != '-' && suffix != '+') || prefix == '') {
        return null;
    }

    return {
        prefix: prefix,
        suffix: suffix
    };
}

function split_clauses(text, dialect, context) {
    var dialectName = resolve_dialect_name(dialect);
    var protected_text = protect_opaque_segments(text, dialect, context);
    var tokens = sqlTokenizer.tokenize(protected_text, dialect);
    var state = {
        output: '',
        lastChar: ''
    };
    var paren_stack = [];
    var clause_contexts = [];
    var operator_lookup = sqlOperatorRegistry.get_operator_lookup(dialectName);
    var query_paren_metadata = collect_query_paren_metadata(context && context.source, dialect);
    var query_paren_index = 0;

    for (var i = 0; i < tokens.length; i++) {
        var token = tokens[i];
        var next = next_code_token(tokens, i);

        if (token.type == 'whitespace' || token.type == 'newline') {
            continue;
        }

        if (token.type == 'placeholder') {
            if (/standalone_comment/.test(token.value)) {
                ensure_newline(state);
                append_piece(state, token.value);
                ensure_newline(state);
                continue;
            }
            if (state.output !== '' && needs_leading_space(state.output) && !/\.$/.test(state.output)) {
                ensure_space(state);
            }
            append_piece(state, token.value);
            continue;
        }

        if (token.type == 'word') {
            var clause_match = longest_matching_clause(tokens, i, dialectName);
            var clause_context = get_query_clause_context(clause_contexts, query_depth(paren_stack));
            if (clause_match && (
                paren_stack.length == 0
                || current_paren_kind(paren_stack) == 'query'
                || current_paren_kind(paren_stack) == 'inline-query-multiline'
            ) && should_apply_clause_match(tokens, i, clause_match, clause_context)) {
                if (!(clause_match.clause.name == 'RECURSIVE' && /\bWITH\s+$/.test(state.output))) {
                    ensure_newline(state);
                }
                append_piece(state, clause_match.clause.keywords.join(' '));
                append_piece(state, ' ');
                update_query_clause_context(clause_context, clause_match.clause);
                i = clause_match.lastIndex;
                continue;
            }

            if (state.output !== '' && needs_leading_space(state.output) && !/\.$/.test(state.output)) {
                ensure_space(state);
            }
            append_piece(state, token.value);
            continue;
        }

        if (token.type == 'punctuation' && token.value == '(') {
            var query_paren_kind = get_query_paren_kind(tokens, i, dialectName);
            var query_paren_info = null;
            if (query_paren_kind) {
                query_paren_info = query_paren_metadata[query_paren_index] || null;
                query_paren_index += 1;
            }
            if (query_paren_kind == 'query') {
                ensure_newline(state);
                append_piece(state, '(');
                ensure_newline(state);
                push_paren_kind(paren_stack, 'query');
            } else if (query_paren_kind == 'inline-query') {
                if (has_inline_space_before(protected_text, token)) {
                    ensure_space(state);
                } else {
                    state.output = state.output.replace(/[ \t]+$/g, '');
                }
                append_piece(state, '(');
                if (query_paren_info && query_paren_info.multiline) {
                    ensure_newline(state);
                    push_paren_kind(paren_stack, 'inline-query-multiline');
                } else {
                    append_piece(state, ' ');
                    push_paren_kind(paren_stack, 'inline-query');
                }
            } else {
                if (has_spacing_before(protected_text, token)) {
                    ensure_space(state);
                } else {
                    state.output = state.output.replace(/[ \t]+$/g, '');
                }
                append_piece(state, '(');
                if (has_spacing_after(protected_text, token)) {
                    append_piece(state, ' ');
                }
                push_paren_kind(paren_stack, 'plain');
            }
            continue;
        }

        if (token.type == 'punctuation' && token.value == ')') {
            var paren_kind = pop_paren_kind(paren_stack);
            if (paren_kind == 'query' || paren_kind == 'inline-query-multiline') {
                ensure_newline(state);
            }
            if (/\n$/.test(state.output)) {
                append_piece(state, ')');
            } else {
                if (has_spacing_before(protected_text, token)) {
                    ensure_space(state);
                } else {
                    state.output = state.output.replace(/[ \t]+$/g, '');
                }
                append_piece(state, ')');
            }
            if (paren_kind == 'query'
                && next
                && next.type == 'word'
                && sqlClauseRegistry.is_select_block_start(next.value, dialect)) {
                ensure_newline(state);
            }
            continue;
        }

        if (token.type == 'punctuation' && token.value == '.') {
            state.output = state.output.replace(/[ \t]+$/g, '');
            append_piece(state, '.');
            continue;
        }

        if (token.type == 'punctuation' && (token.value == '[' || token.value == ']')) {
            state.output = state.output.replace(/[ \t]+$/g, '');
            append_piece(state, token.value);
            continue;
        }

        if (token.type == 'punctuation' && token.value == ',') {
            state.output = state.output.replace(/[ \t]+$/g, '');
            append_piece(state, ',');
            append_piece(state, ' ');
            continue;
        }

        if (token.type == 'punctuation' && token.value == ';') {
            if (token.start > 0 && /[\r\n]/.test(text[token.start - 1] || '')) {
                ensure_newline(state);
            } else if (token.start > 0 && /[ \t]/.test(text[token.start - 1] || '')) {
                ensure_space(state);
            } else {
                state.output = state.output.replace(/[ \t]+$/g, '');
            }
            append_piece(state, ';');
            if (next && next.type == 'line_comment') {
                append_piece(state, ' ');
            }
            continue;
        }

        if (token.type == 'line_comment') {
            if (state.output !== '' && !/[ \n]$/.test(state.output)) {
                append_piece(state, ' ');
            }
            append_piece(state, token.value);
            if (tokens[i + 1] && tokens[i + 1].type == 'newline') {
                ensure_newline(state);
            }
            continue;
        }

        if (token.type == 'operator') {
            var operator = operator_lookup[token.value];
            var unary_suffix = split_operator_with_unary_suffix(token.value, dialectName);
            if (is_unary_prefix_operator(tokens, i)) {
                append_piece(state, token.value);
            } else if (unary_suffix) {
                var prefix_operator = operator_lookup[unary_suffix.prefix];
                if (prefix_operator && prefix_operator.spacing == 'none') {
                    state.output = state.output.replace(/[ \t]+$/g, '');
                    append_piece(state, unary_suffix.prefix);
                } else {
                    ensure_space(state);
                    append_piece(state, unary_suffix.prefix);
                    append_piece(state, ' ');
                }
                append_piece(state, unary_suffix.suffix);
            } else if (operator && operator.spacing == 'none') {
                state.output = state.output.replace(/[ \t]+$/g, '');
                append_piece(state, token.value);
            } else if (operator && operator.spacing == 'surround') {
                ensure_space(state);
                append_piece(state, token.value);
                append_piece(state, ' ');
            } else {
                ensure_space(state);
                append_piece(state, token.value);
                append_piece(state, ' ');
            }
            continue;
        }

        if (state.output !== '' && needs_leading_space(state.output) && !/\.$/.test(state.output)) {
            ensure_space(state);
        }
        append_piece(state, token.value);
    }

    return state.output
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/[ \t]+$/g, '');
}

function restore_opaque_segments(text, context) {
    return context.restore('opaque_clause', text);
}

exports.split_clauses = split_clauses;
exports.protect_opaque_segments = protect_opaque_segments;
exports.restore_opaque_segments = restore_opaque_segments;
