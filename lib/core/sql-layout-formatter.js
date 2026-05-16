var sqlFormatUtils = require('./sql-format-utils');
var sqlClauseRegistry = require('./sql-clause-registry');
var sqlTokenizer = require('./sql-tokenizer');
var repeat_string = sqlFormatUtils.repeat_string;

function get_indent_unit(options) {
	return options && options.indentStyle == 'space' ? '    ' : '\t';
}

function split_trailing_closing_parens(line) {
	var text = String(line || '').replace(/\s+$/g, '');
	var tokens = sqlTokenizer.tokenize(text);
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

function get_line_bracket_effects(line) {
	var tokens = sqlTokenizer.tokenize(String(line || ''));
	var first_code_seen = false;
	var leading_closers = 0;
	var net_delta = 0;

	for (var i = 0; i < tokens.length; i++) {
		var token = tokens[i];
		if (token.type == 'whitespace' || token.type == 'newline' || token.type == 'line_comment') {
			continue;
		}

		if (token.type == 'punctuation' && token.value == ')' && !first_code_seen) {
			leading_closers += 1;
		}

		first_code_seen = true;

		if (token.type == 'punctuation' && token.value == '(') {
			net_delta += 1;
		} else if (token.type == 'punctuation' && token.value == ')') {
			net_delta -= 1;
		}
	}

	return {
		leadingClosers: leading_closers,
		netDelta: net_delta
	};
}

function indent_nested_blocks(str, options) {
	var text_final = '';
	var text_list = [];
	var text_list_orginal = String(str || '').split("\n");
	for (var i = 0; i < text_list_orginal.length; i++) {
		if (text_list_orginal[i] != "" && text_list_orginal[i] != " ") {
			text_list = text_list.concat(split_trailing_closing_parens(text_list_orginal[i]));
		}
	}

	var bracket_deep = 0;
	var indent_unit = get_indent_unit(options);

	for (i = 0; i < text_list.length; i++) {
		var bracket_effects = get_line_bracket_effects(text_list[i]);
		if (bracket_effects.leadingClosers > 0) {
			bracket_deep -= bracket_effects.leadingClosers;
			if (bracket_deep < 0) {
				bracket_deep = 0;
			}
		}

		text_list[i] = repeat_string(indent_unit, bracket_deep) + text_list[i];

		bracket_deep += bracket_effects.netDelta;
		if (bracket_deep < 0) {
			bracket_deep = 0;
		}

		text_final += "\n" + text_list[i];
	}

	return text_final;
}

function should_insert_statement_gap(current_line, previous_line, dialect) {
	var trimmed = String(current_line || '').replace(/^\s+/g, '');
	var previous = String(previous_line || '');

	if (!sqlClauseRegistry.is_statement_start(trimmed, dialect || 'generic')) {
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
	return String(previous_line || '').indexOf(';') >= 0
		&& sqlClauseRegistry.is_select_block_start(current_line, dialect || 'generic');
}

function cleanup_layout_markers(str, dialect) {
	var text_final = '';
	var text_list_orginal = String(str || '').split("\n");
	var text_list = [];

	for (var i = 0; i < text_list_orginal.length; i++) {
		if (text_list_orginal[i] != "" && text_list_orginal[i] != " ") {
			text_list.push(text_list_orginal[i].replace(/\s$/ig, ""));
		}
	}

	for (let i = 0; i < text_list.length; i++) {
		var last_str = i == 0 ? "" : text_list[i - 1];

		if (i > 0) {
			text_final += '\n';
		}

		if (i > 0 && should_insert_statement_gap(text_list[i], last_str, dialect)) {
			text_final += '\n' + text_list[i];
		} else if (i > 0 && should_insert_select_after_statement_gap(text_list[i], last_str, dialect)) {
			text_final += '\n' + text_list[i];
		} else {
			text_final += text_list[i];
		}
	}

	return text_final.replace(/\n{1,2} *--/ig, "\n--").replace(/^ */ig, "")
		.replace(/(\s|\n){1,};(\n|\s){0,}/ig, "\n;\n\n");
}

exports.indent_nested_blocks = indent_nested_blocks;
exports.cleanup_layout_markers = cleanup_layout_markers;
