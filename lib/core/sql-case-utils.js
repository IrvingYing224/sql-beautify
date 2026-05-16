var sqlTokenizer = require('./sql-tokenizer');
var sqlStructure = require('./sql-structure');
var sqlFormatUtils = require('./sql-format-utils');
var expand_tabs_for_width = sqlFormatUtils.expand_tabs_for_width;
var repeat_space = sqlFormatUtils.repeat_space;

function split_code_and_comment(text, tokenizerOptions) {
	return sqlStructure.split_code_and_comment(text, tokenizerOptions);
}

function split_line_at_token(text, token, tokenizerOptions) {
	var parts = split_code_and_comment(text, tokenizerOptions);

	return {
		before_token: parts.code.slice(0, token.start).replace(/\s+$/ig, ''),
		suffix_text: parts.code.slice(token.end).replace(/^\s+/ig, '').replace(/\s+$/ig, ''),
		comment: parts.comment
	};
}

function get_case_tokens(text, tokenizerOptions) {
	var tokens = [];
	var case_depth = 0;
	var source_tokens = sqlTokenizer.tokenize(text, tokenizerOptions);

	for (let i = 0; i < source_tokens.length; i++) {
		if (source_tokens[i].type == 'line_comment') {
			break;
		}
		if (source_tokens[i].type != 'word') {
			continue;
		}

		var word = source_tokens[i].value.toUpperCase();

		if (word == 'CASE') {
			case_depth += 1;
			tokens.push({ word: word, start: source_tokens[i].start, end: source_tokens[i].end, depth: case_depth });
		} else if (word == 'END') {
			tokens.push({ word: word, start: source_tokens[i].start, end: source_tokens[i].end, depth: case_depth });
			if (case_depth > 0) {
				case_depth -= 1;
			}
		} else if (word == 'WHEN' || word == 'THEN' || word == 'ELSE') {
			tokens.push({ word: word, start: source_tokens[i].start, end: source_tokens[i].end, depth: case_depth });
		}
	}

	return tokens;
}

function format_case_branch_value(indent, keyword, value_text, tokenizerOptions) {
	var value_parts = split_code_and_comment(value_text, tokenizerOptions);
	var line = indent + keyword;

	if (value_parts.code != '') {
		line += ' ' + value_parts.code;
	}

	if (value_parts.comment != '') {
		line += ' ' + value_parts.comment;
	}

	return line.replace(/\s+$/ig, '');
}

function append_case_value_text(current_text, next_text) {
	var current_trimmed = current_text.replace(/\s+$/ig, '');
	var next_trimmed = next_text.replace(/^\s+/ig, '').replace(/\s+$/ig, '');

	if (next_trimmed == '') {
		return current_trimmed;
	}

	if (current_trimmed == '') {
		return next_trimmed;
	}

	return current_trimmed + ' ' + next_trimmed;
}

function find_top_level_as_loc(text, tokenizerOptions) {
	var as_loc = sqlStructure.find_top_level_word(text, 'AS', tokenizerOptions);
	if (as_loc > 0 && /\s/.test(text[as_loc - 1])) {
		return as_loc - 1;
	}
	return as_loc;
}

function is_case_branch_line(text) {
	var trimmed = text.replace(/^\s+/ig, '');
	return /^WHEN\b/i.exec(trimmed) || /^THEN\b/i.exec(trimmed) || /^ELSE\b/i.exec(trimmed);
}

function get_outer_as_code_width(code, top_level_as_loc) {
	if (top_level_as_loc >= 0) {
		return expand_tabs_for_width(code.slice(0, top_level_as_loc).replace(/\s+$/ig, '')).length;
	}

	return expand_tabs_for_width(code.replace(/\s+$/ig, '')).length;
}

function get_alignment_width_for_code(code, tokenizerOptions) {
	var normalized_code = code.replace(/\s+$/ig, '');
	var top_level_as_loc = find_top_level_as_loc(normalized_code, tokenizerOptions);

	return {
		top_level_as_loc: top_level_as_loc,
		width: get_outer_as_code_width(normalized_code, top_level_as_loc)
	};
}

function get_case_balance_delta(text, tokenizerOptions) {
	var tokens = get_case_tokens(text, tokenizerOptions);
	var balance = 0;

	for (let i = 0; i < tokens.length; i++) {
		if (tokens[i].word == 'CASE') {
			balance += 1;
		} else if (tokens[i].word == 'END') {
			balance -= 1;
		}
	}

	return balance;
}

function find_outer_then_token(code, tokenizerOptions) {
	var tokens = get_case_tokens(code, tokenizerOptions);

	for (let i = 0; i < tokens.length; i++) {
		if (tokens[i].word == 'THEN' && tokens[i].depth == 0) {
			return tokens[i];
		}
	}

	return null;
}

function split_outer_else_text(text, tokenizerOptions) {
	var tokens = get_case_tokens(text, tokenizerOptions);

	for (let i = 0; i < tokens.length; i++) {
		if (tokens[i].word == 'ELSE' && tokens[i].depth == 0) {
			return {
				before_else: text.slice(0, tokens[i].start).replace(/\s+$/ig, ''),
				else_text: text.slice(tokens[i].end).replace(/^\s+/ig, '').replace(/\s+$/ig, '')
			};
		}
	}

	return {
		before_else: text,
		else_text: null
	};
}

function apply_case_then_else_split(when_item, then_text, tokenizerOptions) {
	var split_else = split_outer_else_text(then_text, tokenizerOptions);
	when_item.then_text = split_else.before_else;
	return split_else.else_text;
}

function find_case_block_end(line, current_depth, tokenizerOptions) {
	var parts = split_code_and_comment(line, tokenizerOptions);
	var tokens = get_case_tokens(parts.code, tokenizerOptions);
	var depth = current_depth;

	for (let i = 0; i < tokens.length; i++) {
		if (tokens[i].word == 'CASE') {
			depth += 1;
		} else if (tokens[i].word == 'END') {
			depth -= 1;
			if (depth == 0) {
				var split_parts = split_line_at_token(line, tokens[i], tokenizerOptions);
				return {
					found: true,
					before_end: split_parts.before_token,
					suffix_text: split_parts.suffix_text,
					comment: split_parts.comment,
					depth: depth
				};
			}
		}
	}

	return {
		found: false,
		depth: depth
	};
}

function get_case_prefix_layout(prefix_raw) {
	var prefix_trimmed = prefix_raw.replace(/\s+$/ig, '');

	if (/^SELECT$/i.exec(prefix_trimmed)) {
		return {
			prefix_output: 'SELECT',
			case_line_prefix: '       ',
			case_start_indent: '       '
		};
	}

	if (/^GROUP BY$/i.exec(prefix_trimmed)) {
		return {
			prefix_output: 'GROUP BY',
			case_line_prefix: '         ',
			case_start_indent: '         '
		};
	}

	if (/^\s*,$/.exec(prefix_trimmed)) {
		return {
			prefix_output: null,
			case_line_prefix: prefix_trimmed,
			case_start_indent: repeat_space(expand_tabs_for_width(prefix_trimmed).length)
		};
	}

	return {
		prefix_output: null,
		case_line_prefix: prefix_raw,
		case_start_indent: repeat_space(expand_tabs_for_width(prefix_raw).length)
	};
}

function parse_case_expression(text, tokenizerOptions) {
	var parts = split_code_and_comment(text, tokenizerOptions);
	var code = parts.code;
	var tokens = get_case_tokens(code, tokenizerOptions);
	var root_case = null;
	var root_end = null;
	var boundary_tokens = [];
	var first_when = null;
	var case_operand = '';
	var when_items = [];
	var else_value = {
		value: '',
		leading_comments: []
	};
	var next_boundary = null;
	var suffix_text = code.replace(/\s+$/ig, '');

	for (let i = 0; i < tokens.length; i++) {
		if (tokens[i].word == 'CASE' && tokens[i].depth == 1) {
			root_case = tokens[i];
			break;
		}
	}

	if (root_case == null) {
		return null;
	}

	for (let i = 0; i < tokens.length; i++) {
		if (tokens[i].word == 'END' && tokens[i].depth == 1 && tokens[i].start > root_case.start) {
			root_end = tokens[i];
			break;
		}
	}

	if (root_end == null) {
		return null;
	}

	for (let i = 0; i < tokens.length; i++) {
		if (tokens[i].depth == 1
			&& tokens[i].start > root_case.start
			&& tokens[i].start < root_end.start
			&& (tokens[i].word == 'WHEN' || tokens[i].word == 'THEN' || tokens[i].word == 'ELSE')) {
			boundary_tokens.push(tokens[i]);
		}
	}

	for (let i = 0; i < boundary_tokens.length; i++) {
		if (boundary_tokens[i].word == 'WHEN') {
			first_when = boundary_tokens[i];
			break;
		}
	}

	if (first_when == null) {
		return null;
	}

	case_operand = code.slice(root_case.end, first_when.start).replace(/\s+/ig, ' ').trim();

	for (let i = 0; i < boundary_tokens.length; i++) {
		if (boundary_tokens[i].word == 'WHEN') {
			var then_token = null;

			for (let j = i + 1; j < boundary_tokens.length; j++) {
				if (boundary_tokens[j].word == 'THEN') {
					then_token = boundary_tokens[j];
					break;
				}
				if (boundary_tokens[j].word == 'WHEN' || boundary_tokens[j].word == 'ELSE') {
					break;
				}
			}

			if (then_token == null) {
				return null;
			}

			next_boundary = root_end;
			for (let j = i + 1; j < boundary_tokens.length; j++) {
				if (boundary_tokens[j].start > then_token.start && (boundary_tokens[j].word == 'WHEN' || boundary_tokens[j].word == 'ELSE')) {
					next_boundary = boundary_tokens[j];
					break;
				}
			}

			when_items.push({
				when_text: code.slice(boundary_tokens[i].end, then_token.start).replace(/\s+/ig, ' ').trim(),
				then_text: code.slice(then_token.end, next_boundary.start).replace(/\s+/ig, ' ').trim()
			});
		}

		if (boundary_tokens[i].word == 'ELSE') {
			else_value.value = code.slice(boundary_tokens[i].end, root_end.start).replace(/\s+/ig, ' ').trim();
			break;
		}
	}

	suffix_text = code.slice(root_end.end).replace(/^\s+/ig, '').replace(/\s+$/ig, '');
	if (parts.comment != '') {
		suffix_text += (suffix_text != '' ? ' ' : '') + parts.comment;
	}

	return {
		prefix_raw: code.slice(0, root_case.start),
		case_operand: case_operand,
		when_items: when_items,
		else_value: else_value.value,
		suffix_text: suffix_text
	};
}

exports.split_line_at_token = split_line_at_token;
exports.get_case_tokens = get_case_tokens;
exports.format_case_branch_value = format_case_branch_value;
exports.append_case_value_text = append_case_value_text;
exports.find_top_level_as_loc = find_top_level_as_loc;
exports.is_case_branch_line = is_case_branch_line;
exports.get_outer_as_code_width = get_outer_as_code_width;
exports.get_alignment_width_for_code = get_alignment_width_for_code;
exports.get_case_balance_delta = get_case_balance_delta;
exports.find_outer_then_token = find_outer_then_token;
exports.split_outer_else_text = split_outer_else_text;
exports.apply_case_then_else_split = apply_case_then_else_split;
exports.find_case_block_end = find_case_block_end;
exports.get_case_prefix_layout = get_case_prefix_layout;
exports.parse_case_expression = parse_case_expression;
