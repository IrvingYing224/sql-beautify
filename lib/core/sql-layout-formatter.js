var sqlFormatUtils = require('./sql-format-utils');
var sqlClauseRegistry = require('./sql-clause-registry');
var sqlTokenizer = require('./sql-tokenizer');
var sqlFormatModel = require('./sql-format-model');
var sqlFormatMutations = require('./sql-format-mutations');
var sqlFormatNavigation = require('./sql-format-navigation');
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

function is_word(token, value) {
	return token
		&& token.type == 'word'
		&& token.value.toUpperCase() == value;
}

function is_inline_subquery_exempt(document, openToken) {
	var previous = sqlFormatNavigation.previous_code_token(document, openToken);
	return is_word(previous, 'IN') || is_word(previous, 'EXISTS');
}

function is_query_boundary_after_close(token) {
	return token
		&& token.type == 'word'
		&& /^(SELECT|WITH|FROM|WHERE|GROUP|ORDER|HAVING|QUALIFY|LIMIT|UNION|INTERSECT|EXCEPT|INSERT|CREATE|DROP|ALTER|DELETE|SET)$/i.exec(token.value);
}

function apply_scope_layout_mutations(document, nodes, mutations, config) {
	if (!document || !mutations) {
		return;
	}

	var scopes = document.scopes || [];
	for (var i = 0; i < scopes.length; i++) {
		var scope = scopes[i];
		if (scope.kind != 'query' || typeof scope.openTokenIndex != 'number') {
			continue;
		}
		var token = sqlFormatNavigation.token_by_index(document, scope.openTokenIndex);
		if (!token || is_inline_subquery_exempt(document, token)) {
			continue;
		}
		if (has_code_before_token(document, token)) {
			sqlFormatMutations.add_line_break_before_token(mutations, token.id, scope.openIndent || '', '');
		}

		var firstBodyToken = sqlFormatNavigation.next_code_token(document, token);
		if (firstBodyToken && firstBodyToken.line == token.line) {
			sqlFormatMutations.add_line_break_before_token(mutations, firstBodyToken.id, scope.bodyIndent || '', '');
		}

		var closeToken = typeof scope.closeTokenIndex == 'number'
			? sqlFormatNavigation.token_by_index(document, scope.closeTokenIndex)
			: null;
		if (closeToken && has_code_before_token(document, closeToken)) {
			if (scope.closeLine != scope.openLine) {
				sqlFormatMutations.add_line_indent(mutations, closeToken.line, scope.bodyIndent || '');
			}
			sqlFormatMutations.add_line_break_before_token(mutations, closeToken.id, scope.closeIndent || '', '');
		}

		var afterCloseToken = closeToken ? sqlFormatNavigation.next_code_token(document, closeToken) : null;
		if (afterCloseToken && afterCloseToken.line == closeToken.line && is_query_boundary_after_close(afterCloseToken)) {
			sqlFormatMutations.add_line_break_before_token(mutations, afterCloseToken.id, scope.closeIndent || '', '');
		}
	}
}

exports.indent_nested_blocks = indent_nested_blocks;
exports.cleanup_layout_markers = cleanup_layout_markers;
exports.apply_scope_layout_mutations = apply_scope_layout_mutations;
