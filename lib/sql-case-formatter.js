var sqlTokenizer = require('./sql-tokenizer');
var sqlStructure = require('./sql-structure');
var sqlCaseUtils = require('./sql-case-utils');

function split_code_and_comment(text) {
	return sqlStructure.split_code_and_comment(text);
}

function split_case_code_and_comment(text) {
	return sqlStructure.split_code_and_comment(text);
}

function get_first_comment_loc(text) {
	var tokens = sqlTokenizer.tokenize(text);
	for (let i = 0; i < tokens.length; i++) {
		if (tokens[i].type == 'line_comment') {
			return tokens[i].start;
		}
	}
	return -1;
}

var get_case_tokens = sqlCaseUtils.get_case_tokens;
var format_case_branch_value = sqlCaseUtils.format_case_branch_value;
var append_case_value_text = sqlCaseUtils.append_case_value_text;
var find_top_level_as_loc = sqlCaseUtils.find_top_level_as_loc;
var get_outer_as_code_width = sqlCaseUtils.get_outer_as_code_width;
var get_alignment_width_for_code = sqlCaseUtils.get_alignment_width_for_code;
var get_case_balance_delta = sqlCaseUtils.get_case_balance_delta;
var find_outer_then_token = sqlCaseUtils.find_outer_then_token;
var apply_case_then_else_split = sqlCaseUtils.apply_case_then_else_split;
var find_case_block_end = sqlCaseUtils.find_case_block_end;
var get_case_prefix_layout = sqlCaseUtils.get_case_prefix_layout;
var parse_case_expression = sqlCaseUtils.parse_case_expression;

function build_case_formatted_text(prefix_raw, case_operand, when_items, else_value, suffix_text, case_when_then_wrap_length, else_leading_comments, else_trailing_comment) {
	if (when_items.length == 0) {
		return null;
	}

	var layout = get_case_prefix_layout(prefix_raw);
	var wrap_limit = parseInt(case_when_then_wrap_length, 10);
	if (!wrap_limit || wrap_limit < 1) {
		wrap_limit = 50;
	}

	var should_wrap_then = false;
	var max_when_header_len = 0;

	for (let i = 0; i < when_items.length; i++) {
		var when_header = 'WHEN ' + when_items[i].when_text;
		if (when_header.length > max_when_header_len) {
			max_when_header_len = when_header.length;
		}
		if ((when_items[i].when_lines && when_items[i].when_lines.length > 1)
			|| when_items[i].when_text.length > wrap_limit
			|| when_items[i].then_text.length > wrap_limit) {
			should_wrap_then = true;
		}
	}

	var when_indent = layout.case_start_indent + '    ';
	var value_indent = when_indent + '    ';
	var lines = [];

	if (layout.prefix_output != null) {
		lines.push(layout.prefix_output);
	}

	lines.push(layout.case_line_prefix + 'CASE' + (case_operand != '' ? ' ' + case_operand : ''));

	for (let i = 0; i < when_items.length; i++) {
		if (when_items[i].leading_comments) {
			for (let j = 0; j < when_items[i].leading_comments.length; j++) {
				lines.push(when_indent + when_items[i].leading_comments[j]);
			}
		}

		if (when_items[i].when_lines && when_items[i].when_lines.length > 1) {
			var multiline_when_lines = format_case_multiline_when_item(when_indent, value_indent, when_items[i]);
			for (let j = 0; j < multiline_when_lines.length; j++) {
				lines.push(multiline_when_lines[j]);
			}
			continue;
		}

		var when_line = when_indent + 'WHEN ' + when_items[i].when_text;
		if (when_items[i].then_trailing_comment && when_items[i].then_trailing_comment != '') {
			lines.push(when_line);
			lines.push((value_indent + 'THEN ' + when_items[i].then_trailing_comment).replace(/\s+$/ig, ''));
			if (when_items[i].then_text != '') {
				lines.push((value_indent + when_items[i].then_text).replace(/\s+$/ig, ''));
			}
		} else if (should_wrap_then) {
			lines.push(when_line);
			lines.push(format_case_branch_value(value_indent, 'THEN', when_items[i].then_text));
		} else {
			var padding = " ".times(max_when_header_len - ('WHEN ' + when_items[i].when_text).length);
			lines.push(format_case_branch_value(when_indent, 'WHEN ' + when_items[i].when_text + padding + ' THEN', when_items[i].then_text));
		}
	}

	if (else_value != '' || else_trailing_comment != '') {
		if (else_leading_comments) {
			for (let i = 0; i < else_leading_comments.length; i++) {
				lines.push(when_indent + else_leading_comments[i]);
			}
		}
		if (should_wrap_then || else_trailing_comment != '') {
			lines.push((when_indent + 'ELSE' + (else_trailing_comment != '' ? ' ' + else_trailing_comment : '')).replace(/\s+$/ig, ''));
			if (else_value != '') {
				lines.push((value_indent + else_value).replace(/\s+$/ig, ''));
			}
		} else {
			lines.push((when_indent + 'ELSE ' + else_value).replace(/\s+$/ig, ''));
		}
	}

	lines.push((layout.case_start_indent + 'END' + (suffix_text != '' ? (/^[\),]/.exec(suffix_text) ? '' : ' ') + suffix_text : '')).replace(/\s+$/ig, ''));

	return lines.join('\n');
}

function split_case_boundary_lines(block_lines) {
	var lines = [];

	for (let i = 0; i < block_lines.length; i++) {
		var parts = split_case_code_and_comment(block_lines[i]);
		var tokens = get_case_tokens(parts.code);
		var split_locs = [];

		for (let j = 0; j < tokens.length; j++) {
			if (tokens[j].word == 'WHEN' && tokens[j].depth == 0 && tokens[j].start > 0) {
				split_locs.push(tokens[j].start);
			}
		}

		if (split_locs.length == 0) {
			lines.push(block_lines[i]);
			continue;
		}

		var start = 0;
		for (let j = 0; j < split_locs.length; j++) {
			var before = parts.code.slice(start, split_locs[j]).replace(/^\s+/ig, '').replace(/\s+$/ig, '');
			if (before != '') {
				lines.push(before);
			}
			start = split_locs[j];
		}

		var last = parts.code.slice(start).replace(/^\s+/ig, '').replace(/\s+$/ig, '');
		if (last != '') {
			lines.push(last + (parts.comment != '' ? ' ' + parts.comment : ''));
		}
	}

	return lines;
}

function normalize_case_multiline_condition_lines(condition_lines) {
	var result = [];
	var item_lines = [];
	var close_lines = [];
	var saw_list_header = false;

	for (let i = 0; i < condition_lines.length; i++) {
		var parts = split_case_code_and_comment(condition_lines[i]);
		var code = parts.code.replace(/^\s+/ig, '').replace(/\s+$/ig, '');
		var comment = parts.comment;

		if (code == '' && comment == '') {
			continue;
		}

		if (i == 0) {
			var first_match = /^(.*\()\s*(.+)$/.exec(code);
			if (first_match) {
				result.push(first_match[1].replace(/\s+$/ig, ''));
				item_lines.push({
					code: first_match[2].replace(/^\s*,\s*/ig, ''),
					comment: comment
				});
				saw_list_header = true;
				continue;
			}
		}

		if (saw_list_header && /^,/.exec(code)) {
			item_lines.push({
				code: code.replace(/^\s*,\s*/ig, ''),
				comment: comment
			});
			continue;
		}

		if (saw_list_header && /^\)/.exec(code)) {
			close_lines.push(code + (comment != '' ? ' ' + comment : ''));
			continue;
		}

		if (saw_list_header) {
			item_lines.push({
				code: code,
				comment: comment
			});
		} else {
			result.push(code + (comment != '' ? ' ' + comment : ''));
		}
	}

	if (saw_list_header) {
		for (let i = 0; i < item_lines.length; i++) {
			var item_code = item_lines[i].code.replace(/\s+$/ig, '');
			if (i < item_lines.length - 1) {
				item_code += ',';
			}
			result.push('    ' + item_code + (item_lines[i].comment != '' ? ' ' + item_lines[i].comment : ''));
		}

		for (let i = 0; i < close_lines.length; i++) {
			result.push(close_lines[i]);
		}
	}

	return result;
}

function format_case_multiline_when_item(when_indent, value_indent, item) {
	var condition_lines = normalize_case_multiline_condition_lines(item.when_lines || [item.when_text]);
	var output_lines = [];

	if (condition_lines.length == 0) {
		condition_lines = [item.when_text];
	}

	output_lines.push(when_indent + 'WHEN ' + condition_lines[0]);
	for (let i = 1; i < condition_lines.length; i++) {
		output_lines.push(value_indent + condition_lines[i]);
	}

	if (item.then_text != '') {
		if (get_first_comment_loc(output_lines[output_lines.length - 1]) >= 0) {
			output_lines.push(value_indent + 'THEN ' + item.then_text);
		} else {
			output_lines[output_lines.length - 1] = output_lines[output_lines.length - 1] + ' THEN ' + item.then_text;
		}
	}

	return output_lines;
}

function format_case_expression_line(line, case_when_then_wrap_length) {
	var parsed = parse_case_expression(line);

	if (parsed == null || parsed.when_items.length == 0) {
		return null;
	}

	return build_case_formatted_text(
		parsed.prefix_raw,
		parsed.case_operand,
		parsed.when_items,
		parsed.else_value,
		parsed.suffix_text,
		case_when_then_wrap_length,
		[],
		''
	);
}

function format_case_blocks(str, case_when_then_wrap_length) {
	var text_list = str.split('\n');
	var text_final = [];

	for (let i = 0; i < text_list.length; i++) {
		var current_line = text_list[i];
		var case_loc = -1;
		var line_tokens = get_case_tokens(current_line);

		for (let j = 0; j < line_tokens.length; j++) {
			if (line_tokens[j].word == 'CASE' && line_tokens[j].depth == 1) {
				case_loc = line_tokens[j].start;
				break;
			}
		}

		if (case_loc < 0) {
			text_final.push(current_line);
			continue;
		}

		var single_line_formatted = format_case_expression_line(current_line, case_when_then_wrap_length);
		if (single_line_formatted != null) {
			var single_line_tokens = get_case_tokens(split_code_and_comment(current_line).code);
			var has_root_end_on_same_line = false;
			for (let j = 0; j < single_line_tokens.length; j++) {
				if (single_line_tokens[j].word == 'END' && single_line_tokens[j].depth == 1) {
					has_root_end_on_same_line = true;
					break;
				}
			}

			if (has_root_end_on_same_line) {
				var single_line_parts = single_line_formatted.split('\n');
				for (let j = 0; j < single_line_parts.length; j++) {
					text_final.push(single_line_parts[j]);
				}
				continue;
			}
		}

		var block_lines = [current_line];
		var block_end_index = i;
		var end_suffix = '';
		var case_depth = 1;

		for (let j = i + 1; j < text_list.length; j++) {
			var end_line_parts = find_case_block_end(text_list[j], case_depth);
			case_depth = end_line_parts.depth;
			if (end_line_parts.found) {
				if (end_line_parts.before_end != '') {
					block_lines.push(end_line_parts.before_end);
				}
				block_end_index = j;
				end_suffix = end_line_parts.suffix_text + (end_line_parts.comment != '' ? ' ' + end_line_parts.comment : '');
				break;
			}
			block_lines.push(text_list[j]);
		}

		if (block_end_index == i) {
			text_final.push(current_line);
			continue;
		}

		var prefix_raw = current_line.slice(0, case_loc);
		var first_line_parts = split_case_code_and_comment(current_line.slice(case_loc + 4));
		var case_after_text = first_line_parts.code.replace(/\s+/ig, ' ').trim();
		var case_operand = '';
		var when_items = [];
		var else_value = '';
		var else_leading_comments = [];
		var else_trailing_comment = '';
		var pending_type = '';
		var nested_case_depth = 0;
		var active_value_target = '';
		var pending_comments = [];

		if (case_after_text != '') {
			if (/^WHEN\b/i.exec(case_after_text)) {
				block_lines[0] = 'WHEN ' + case_after_text.replace(/^WHEN\b/i, '').trim() + (first_line_parts.comment != '' ? ' ' + first_line_parts.comment : '');
			} else {
				var case_match = /^(.*?)(\bWHEN\b.*)$/i.exec(case_after_text);
				if (case_match) {
					case_operand = case_match[1].replace(/\s+/ig, ' ').trim();
					block_lines[0] = case_match[2] + (first_line_parts.comment != '' ? ' ' + first_line_parts.comment : '');
				} else {
					case_operand = case_after_text;
					block_lines[0] = '';
				}
			}
		} else {
			block_lines[0] = '';
		}

		block_lines = split_case_boundary_lines(block_lines);

		for (let j = 0; j < block_lines.length; j++) {
			var source_line = block_lines[j];
			var parts = split_case_code_and_comment(source_line);
			var code = parts.code.replace(/^\s+/ig, '').replace(/\s+/ig, ' ').trim();
			var code_with_comment = code + (parts.comment != '' ? ' ' + parts.comment : '');
			if (code == '') {
				if (parts.comment != '') {
					pending_comments.push(parts.comment.replace(/^\s+/ig, ''));
				}
				continue;
			}

			if (pending_type == 'THEN' && when_items.length > 0) {
				when_items[when_items.length - 1].then_text = code_with_comment;
				pending_type = '';
				nested_case_depth = get_case_balance_delta(code);
				if (nested_case_depth > 0) {
					active_value_target = 'THEN';
				}
				continue;
			}

			if (pending_type == 'ELSE') {
				else_value = code_with_comment;
				pending_type = '';
				nested_case_depth = get_case_balance_delta(code);
				if (nested_case_depth > 0) {
					active_value_target = 'ELSE';
				}
				continue;
			}

			if (nested_case_depth > 0) {
				if (active_value_target == 'THEN' && when_items.length > 0) {
					when_items[when_items.length - 1].then_text = append_case_value_text(when_items[when_items.length - 1].then_text, code_with_comment);
				} else if (active_value_target == 'ELSE') {
					else_value = append_case_value_text(else_value, code_with_comment);
				}
				nested_case_depth += get_case_balance_delta(code);
				if (nested_case_depth < 0) {
					nested_case_depth = 0;
				}
				if (nested_case_depth == 0) {
					active_value_target = '';
				}
				continue;
			}

			if (pending_type == 'WHEN' && when_items.length > 0) {
				var pending_then_token = find_outer_then_token(code);
				if (pending_then_token != null) {
					var pending_condition_text = code.slice(0, pending_then_token.start).replace(/\s+/ig, ' ').trim();
					var pending_then_text = code.slice(pending_then_token.end).replace(/\s+/ig, ' ').trim() + (parts.comment != '' ? ' ' + parts.comment : '');
					if (pending_condition_text != '') {
						when_items[when_items.length - 1].when_lines.push(pending_condition_text);
					}
					when_items[when_items.length - 1].when_text = when_items[when_items.length - 1].when_lines.join(' ').replace(/\s+/ig, ' ').trim();
					var pending_else_text = apply_case_then_else_split(when_items[when_items.length - 1], pending_then_text);
					if (pending_else_text != null) {
						else_value = pending_else_text;
					}
					pending_type = '';
					nested_case_depth = get_case_balance_delta(pending_then_text);
					if (nested_case_depth > 0) {
						active_value_target = 'THEN';
					}
				} else {
					when_items[when_items.length - 1].when_lines.push(code_with_comment);
				}
				continue;
			}

			if (/^WHEN\b/i.exec(code)) {
				var then_token = find_outer_then_token(code);
				if (then_token != null) {
					var when_text = code.slice(4, then_token.start).replace(/\s+/ig, ' ').trim();
					var then_code = code.slice(then_token.end).replace(/\s+/ig, ' ').trim();
					var then_comment = parts.comment;
					if (/^--/.exec(then_code)) {
						then_comment = then_code;
						then_code = '';
					}
					var when_item = {
						when_text: when_text,
						then_text: then_code == '' ? '' : then_code + (then_comment != '' ? ' ' + then_comment : ''),
						then_trailing_comment: then_code == '' ? then_comment : ''
					};
					if (pending_comments.length > 0) {
						when_item.leading_comments = pending_comments;
						pending_comments = [];
					}
					var inline_else_text = apply_case_then_else_split(when_item, when_item.then_text);
					if (inline_else_text != null) {
						else_value = inline_else_text;
					}
					when_items.push(when_item);
					pending_type = then_code == '' ? 'THEN' : '';
					nested_case_depth = get_case_balance_delta(then_code);
					if (nested_case_depth > 0) {
						active_value_target = 'THEN';
					}
				} else {
					var when_condition_text = code.replace(/^WHEN\b/i, '').replace(/\s+/ig, ' ').trim();
					when_items.push({
						when_text: when_condition_text,
						then_text: '',
						when_lines: [when_condition_text + (parts.comment != '' ? ' ' + parts.comment : '')],
						leading_comments: pending_comments.length > 0 ? pending_comments : null
					});
					pending_comments = [];
					pending_type = 'WHEN';
				}
				continue;
			}

			if (/^THEN\b/i.exec(code) && when_items.length > 0) {
				var then_line_text = code.replace(/^THEN\b/i, '').replace(/\s+/ig, ' ').trim();
				var then_line_comment = parts.comment;
				if (/^--/.exec(then_line_text)) {
					then_line_comment = then_line_text;
					then_line_text = '';
				}
				if (then_line_text == '') {
					when_items[when_items.length - 1].then_text = '';
					when_items[when_items.length - 1].then_trailing_comment = then_line_comment;
					pending_type = 'THEN';
				} else {
					when_items[when_items.length - 1].then_text = then_line_text + (then_line_comment != '' ? ' ' + then_line_comment : '');
					when_items[when_items.length - 1].then_trailing_comment = '';
					pending_type = '';
				}
				nested_case_depth = get_case_balance_delta(then_line_text);
				if (nested_case_depth > 0) {
					active_value_target = 'THEN';
				}
				continue;
			}

			if (/^ELSE\b/i.exec(code)) {
				if (pending_comments.length > 0) {
					else_leading_comments = pending_comments;
					pending_comments = [];
				}
				var else_line_text = code.replace(/^ELSE\b/i, '').replace(/\s+/ig, ' ').trim();
				var else_line_comment = parts.comment;
				if (/^--/.exec(else_line_text)) {
					else_line_comment = else_line_text;
					else_line_text = '';
				}
				if (else_line_text == '') {
					else_value = '';
					else_trailing_comment = else_line_comment;
					pending_type = 'ELSE';
				} else {
					else_value = else_line_text + (else_line_comment != '' ? ' ' + else_line_comment : '');
					pending_type = '';
				}
				nested_case_depth = get_case_balance_delta(else_line_text);
				if (nested_case_depth > 0) {
					active_value_target = 'ELSE';
				}
				continue;
			}

		}

		var formatted_block = build_case_formatted_text(prefix_raw, case_operand, when_items, else_value, end_suffix, case_when_then_wrap_length, else_leading_comments, else_trailing_comment);
		if (formatted_block == null) {
			text_final.push(current_line);
			continue;
		}

		var formatted_lines = formatted_block.split('\n');
		for (let j = 0; j < formatted_lines.length; j++) {
			text_final.push(formatted_lines[j]);
		}
		i = block_end_index;
	}

	return text_final.join('\n');
}

function find_root_case_start_loc(line) {
	var code = split_code_and_comment(line).code;
	var tokens = get_case_tokens(code);

	for (let i = 0; i < tokens.length; i++) {
		if (tokens[i].word == 'CASE' && tokens[i].depth == 1) {
			return tokens[i].start;
		}
	}

	return -1;
}

exports.get_case_tokens = get_case_tokens;
exports.get_case_balance_delta = get_case_balance_delta;
exports.find_top_level_as_loc = find_top_level_as_loc;
exports.get_outer_as_code_width = get_outer_as_code_width;
exports.get_alignment_width_for_code = get_alignment_width_for_code;
exports.format_case_expression_line = format_case_expression_line;
exports.format_case_blocks = format_case_blocks;
exports.find_root_case_start_loc = find_root_case_start_loc;
exports.is_case_branch_line = sqlCaseUtils.is_case_branch_line;
