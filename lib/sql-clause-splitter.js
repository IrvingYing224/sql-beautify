var sqlTokenizer = require('./sql-tokenizer');
var sqlClauseRegistry = require('./sql-clause-registry');
var sqlOperatorRegistry = require('./sql-operator-registry');

function is_ignorable(token) {
    return token && (token.type == 'whitespace' || token.type == 'newline');
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

function query_depth(stack) {
    var depth = 0;
    for (var i = 0; i < stack.length; i++) {
        if (stack[i] == 'query') {
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
    var tokens = sqlTokenizer.tokenize(text);
    var result = '';
    var cursor = 0;

    for (var i = 0; i < tokens.length; i++) {
        if (tokens[i].type == 'word' && /^MATCH_RECOGNIZE$/i.exec(tokens[i].value)) {
            var next = next_code_token(tokens, i);
            if (next && next.type == 'punctuation' && next.value == '(') {
                var close_index = find_matching_paren(tokens, tokens.indexOf(next));
                if (close_index > i) {
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
    return /[A-Za-z0-9_$}'"`)]$/.test(output || '');
}

function split_clauses(text, dialect, context) {
    var protected_text = protect_opaque_segments(text, dialect, context);
    var tokens = sqlTokenizer.tokenize(protected_text);
    var state = {
        output: '',
        lastChar: ''
    };
    var paren_stack = [];
    var operator_lookup = sqlOperatorRegistry.get_operator_lookup(dialect);

    for (var i = 0; i < tokens.length; i++) {
        var token = tokens[i];
        var next = next_code_token(tokens, i);

        if (token.type == 'whitespace' || token.type == 'newline') {
            continue;
        }

        if (token.type == 'placeholder') {
            if (state.output !== '' && needs_leading_space(state.output) && !/\.$/.test(state.output)) {
                ensure_space(state);
            }
            append_piece(state, token.value);
            continue;
        }

        if (token.type == 'word') {
            var clause_match = longest_matching_clause(tokens, i, dialect);
            if (clause_match && (query_depth(paren_stack) > 0 || paren_stack.length == 0)) {
                if (!(clause_match.clause.name == 'RECURSIVE' && /\bWITH\s+$/.test(state.output))) {
                    ensure_newline(state);
                }
                append_piece(state, clause_match.clause.keywords.join(' '));
                append_piece(state, ' ');
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
            var query_paren_kind = get_query_paren_kind(tokens, i, dialect);
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
                append_piece(state, ' ');
                push_paren_kind(paren_stack, 'inline-query');
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
            if (paren_kind == 'query') {
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
            if ((tokens[i + 1] && tokens[i + 1].type == 'newline')
                || /shouldhavenbehind$/i.exec(token.value)) {
                ensure_newline(state);
            }
            continue;
        }

        if (token.type == 'operator') {
            var operator = operator_lookup[token.value];
            if (operator && operator.spacing == 'none') {
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
