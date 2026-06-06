var sqlTokenizer = require('./sql-tokenizer');
var sqlStructure = require('./sql-structure');
var sqlCaseUtils = require('./sql-case-utils');
var sqlFormatUtils = require('./sql-format-utils');
var sqlFormatMutations = require('./sql-format-mutations');
var sqlScopeModel = require('./sql-scope-model');
var repeat_space = sqlFormatUtils.repeat_space;
var expand_tabs_for_width = sqlFormatUtils.expand_tabs_for_width;

function split_code_and_comment(text, tokenizerOptions) {
	return sqlStructure.split_code_and_comment(text, tokenizerOptions);
}

function split_case_code_and_comment(text, tokenizerOptions) {
	return sqlStructure.split_code_and_comment(text, tokenizerOptions);
}

function normalize_case_value_text(text) {
	return String(text || '').replace(/\)\s+\+\s+(?=[A-Za-z_][A-Za-z0-9_]*\()/g, ')+');
}

function normalize_case_condition_text(text) {
	return String(text || '').replace(/,\s+/g, ',');
}

function get_first_comment_loc(text, tokenizerOptions) {
	var tokens = sqlTokenizer.tokenize(text, tokenizerOptions);
	for (let i = 0; i < tokens.length; i++) {
		if (tokens[i].type == 'line_comment') {
			return tokens[i].start;
		}
	}
	return -1;
}

function get_paren_balance(text, tokenizerOptions) {
	var tokens = sqlTokenizer.tokenize(String(text || ''), tokenizerOptions);
	var balance = 0;

	for (let i = 0; i < tokens.length; i++) {
		if (tokens[i].type == 'punctuation' && tokens[i].value == '(') {
			balance += 1;
		} else if (tokens[i].type == 'punctuation' && tokens[i].value == ')' && balance > 0) {
			balance -= 1;
		}
	}

	return balance;
}

function strip_top_level_trailing_comma_before_comment(text, tokenizerOptions) {
	var parts = split_case_code_and_comment(text, tokenizerOptions);
	var code = parts.code.replace(/\s+$/ig, '');

	if (parts.comment == '' || !/,$/.test(code) || get_paren_balance(code, tokenizerOptions) != 0) {
		return text;
	}

	return code.slice(0, -1).replace(/\s+$/ig, '') + ' ' + parts.comment;
}

function is_standalone_comment_marker_line(line) {
	return /^\s*\{SQLBEAUTIFY_standalone_comment_\d+_\d+\}\s*$/.test(String(line || ''));
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

function build_case_formatted_text(prefix_raw, case_operand, when_items, else_value, suffix_text, caseWhenThenWrapLength, else_leading_comments, else_trailing_comment, tokenizerOptions, case_trailing_comment) {
	if (when_items.length == 0) {
		return null;
	}

	var layout = get_case_prefix_layout(prefix_raw);
	var wrap_limit = parseInt(caseWhenThenWrapLength, 10);
	if (!wrap_limit || wrap_limit < 1) {
		wrap_limit = 50;
	}

	var should_wrap_then = false;
	var max_when_header_len = 0;

	for (let i = 0; i < when_items.length; i++) {
		when_items[i].when_text = normalize_case_condition_text(when_items[i].when_text);
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

	lines.push((layout.case_line_prefix + 'CASE' + (case_operand != '' ? ' ' + case_operand : '') + (case_trailing_comment ? ' ' + case_trailing_comment : '')).replace(/\s+$/ig, ''));

	for (let i = 0; i < when_items.length; i++) {
		if (when_items[i].leading_comments) {
			for (let j = 0; j < when_items[i].leading_comments.length; j++) {
				lines.push(when_indent + when_items[i].leading_comments[j]);
			}
		}

		if (when_items[i].when_lines && when_items[i].when_lines.length > 1) {
			var multiline_when_lines = format_case_multiline_when_item(when_indent, value_indent, when_items[i], tokenizerOptions);
			for (let j = 0; j < multiline_when_lines.length; j++) {
				lines.push(multiline_when_lines[j]);
			}
			continue;
		}

		var when_line = (when_indent + 'WHEN ' + when_items[i].when_text + (when_items[i].when_trailing_comment ? ' ' + when_items[i].when_trailing_comment : '')).replace(/\s+$/ig, '');
		if (when_items[i].when_trailing_comment && when_items[i].when_trailing_comment != '') {
			lines.push(when_line);
			if (when_items[i].then_trailing_comment && when_items[i].then_trailing_comment != '') {
				lines.push((value_indent + 'THEN ' + when_items[i].then_trailing_comment).replace(/\s+$/ig, ''));
			}
			if (when_items[i].then_text != '') {
				lines.push(format_case_branch_value(value_indent, 'THEN', normalize_case_value_text(when_items[i].then_text), tokenizerOptions));
			}
		} else if (when_items[i].then_trailing_comment && when_items[i].then_trailing_comment != '') {
			var then_text_with_comment = normalize_case_value_text(when_items[i].then_text);
			lines.push(when_line);
			lines.push((value_indent + 'THEN ' + when_items[i].then_trailing_comment).replace(/\s+$/ig, ''));
			if (then_text_with_comment != '') {
				lines.push((value_indent + then_text_with_comment).replace(/\s+$/ig, ''));
			}
		} else if (should_wrap_then) {
			lines.push(when_line);
			lines.push(format_case_branch_value(value_indent, 'THEN', normalize_case_value_text(when_items[i].then_text), tokenizerOptions));
		} else {
			var padding = repeat_space(max_when_header_len - ('WHEN ' + when_items[i].when_text).length);
			lines.push(format_case_branch_value(
				when_indent,
				'WHEN ' + when_items[i].when_text + padding + ' THEN',
				normalize_case_value_text(when_items[i].then_text),
				tokenizerOptions
			));
		}
	}

	if (else_value != '' || else_trailing_comment != '') {
		var normalized_else_value = normalize_case_value_text(else_value);
		if (else_leading_comments) {
			for (let i = 0; i < else_leading_comments.length; i++) {
				lines.push(when_indent + else_leading_comments[i]);
			}
		}
		if (should_wrap_then || else_trailing_comment != '') {
			lines.push((when_indent + 'ELSE' + (else_trailing_comment != '' ? ' ' + else_trailing_comment : '')).replace(/\s+$/ig, ''));
			if (normalized_else_value != '') {
				lines.push((value_indent + normalized_else_value).replace(/\s+$/ig, ''));
			}
		} else {
			lines.push((when_indent + 'ELSE ' + normalized_else_value).replace(/\s+$/ig, ''));
		}
	}

	lines.push((layout.case_start_indent + 'END' + (suffix_text != '' ? (/^[\),]/.exec(suffix_text) ? '' : ' ') + suffix_text : '')).replace(/\s+$/ig, ''));

	return lines.join('\n');
}

function split_case_boundary_lines(block_lines, tokenizerOptions) {
	var lines = [];

	for (let i = 0; i < block_lines.length; i++) {
		var parts = split_case_code_and_comment(block_lines[i], tokenizerOptions);
		var tokens = get_case_tokens(parts.code, tokenizerOptions);
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

function normalize_case_multiline_condition_lines(condition_lines, tokenizerOptions) {
	var result = [];
	var item_lines = [];
	var close_lines = [];
	var saw_list_header = false;

	for (let i = 0; i < condition_lines.length; i++) {
		var parts = split_case_code_and_comment(condition_lines[i], tokenizerOptions);
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
			if (i < item_lines.length - 1 && !/,$/.test(item_code)) {
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

function format_case_multiline_when_item(when_indent, value_indent, item, tokenizerOptions) {
	var condition_lines = normalize_case_multiline_condition_lines(item.when_lines || [item.when_text], tokenizerOptions);
	var output_lines = [];

	if (condition_lines.length == 0) {
		condition_lines = [item.when_text];
	}

	output_lines.push(when_indent + 'WHEN ' + condition_lines[0]);
	for (let i = 1; i < condition_lines.length; i++) {
		output_lines.push(value_indent + condition_lines[i]);
	}

	if (item.then_text != '') {
		if (get_first_comment_loc(output_lines[output_lines.length - 1], tokenizerOptions) >= 0) {
			output_lines.push(value_indent + 'THEN ' + item.then_text);
		} else {
			output_lines[output_lines.length - 1] = output_lines[output_lines.length - 1] + ' THEN ' + item.then_text;
		}
	}

	return output_lines;
}

function format_case_expression_line(line, caseWhenThenWrapLength, tokenizerOptions) {
	var parsed = parse_case_expression(line, tokenizerOptions);

	if (parsed == null || parsed.when_items.length == 0) {
		return null;
	}

	return build_case_formatted_text(
		parsed.prefix_raw,
		parsed.case_operand,
		parsed.when_items,
		parsed.else_value,
		parsed.suffix_text,
		caseWhenThenWrapLength,
		[],
		'',
		tokenizerOptions,
		''
	);
}

function format_case_blocks(str, caseWhenThenWrapLength, tokenizerOptions) {
	var text_list = str.split('\n');
	var text_final = [];

	for (let i = 0; i < text_list.length; i++) {
		var current_line = text_list[i];
		var case_loc = -1;
		var line_tokens = get_case_tokens(current_line, tokenizerOptions);

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

		var single_line_formatted = format_case_expression_line(current_line, caseWhenThenWrapLength, tokenizerOptions);
		if (single_line_formatted != null) {
			var single_line_tokens = get_case_tokens(split_code_and_comment(current_line, tokenizerOptions).code, tokenizerOptions);
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
			var end_line_parts = find_case_block_end(text_list[j], case_depth, tokenizerOptions);
			case_depth = end_line_parts.depth;
			if (end_line_parts.found) {
				if (end_line_parts.before_end != '') {
					block_lines.push(end_line_parts.before_end);
				}
				block_end_index = j;
				end_suffix = strip_top_level_trailing_comma_before_comment(end_line_parts.suffix_text + (end_line_parts.comment != '' ? ' ' + end_line_parts.comment : ''), tokenizerOptions);
				break;
			}
			block_lines.push(text_list[j]);
		}

		if (block_end_index == i) {
			text_final.push(current_line);
			continue;
		}

		var prefix_raw = current_line.slice(0, case_loc);
		var first_line_parts = split_case_code_and_comment(current_line.slice(case_loc + 4), tokenizerOptions);
		var case_after_text = first_line_parts.code.replace(/\s+/ig, ' ').trim();
		var case_operand = '';
		var when_items = [];
		var else_value = '';
		var else_leading_comments = [];
		var else_trailing_comment = '';
		var case_trailing_comment = '';
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
			case_trailing_comment = first_line_parts.comment;
			block_lines[0] = '';
		}

		block_lines = split_case_boundary_lines(block_lines, tokenizerOptions);

		for (let j = 0; j < block_lines.length; j++) {
			var source_line = block_lines[j];
			var parts = split_case_code_and_comment(source_line, tokenizerOptions);
			var code = parts.code.replace(/^\s+/ig, '').replace(/\s+/ig, ' ').trim();
			var code_with_comment = code + (parts.comment != '' ? ' ' + parts.comment : '');
			if (is_standalone_comment_marker_line(code)) {
				pending_comments.push(code);
				continue;
			}
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
					var condition_line_comment = get_paren_balance(when_condition_text, tokenizerOptions) > 0 ? parts.comment : '';
					when_items.push({
						when_text: when_condition_text,
						then_text: '',
						when_lines: [when_condition_text + (condition_line_comment != '' ? ' ' + condition_line_comment : '')],
						when_trailing_comment: condition_line_comment == '' ? parts.comment : '',
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

		var formatted_block = build_case_formatted_text(prefix_raw, case_operand, when_items, else_value, end_suffix, caseWhenThenWrapLength, else_leading_comments, else_trailing_comment, tokenizerOptions, case_trailing_comment);
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

function find_root_case_start_loc(line, tokenizerOptions) {
	var code = split_code_and_comment(line, tokenizerOptions).code;
	var tokens = get_case_tokens(code, tokenizerOptions);

	for (let i = 0; i < tokens.length; i++) {
		if (tokens[i].word == 'CASE' && tokens[i].depth == 1) {
			return tokens[i].start;
		}
	}

	return -1;
}

function render_tokens(tokens) {
	return (tokens || []).map(function(token) {
		return token.value;
	}).join(' ').replace(/\s+([,.;)])/g, '$1').replace(/([(])\s+/g, '$1');
}

function render_case_node(caseNode) {
	var lines = [];

	lines.push(('CASE' + (caseNode.caseComment ? ' ' + caseNode.caseComment : '')).replace(/\s+$/g, ''));

	for (var i = 0; i < (caseNode.branches || []).length; i++) {
		var branch = caseNode.branches[i];
		var whenText = render_tokens(branch.whenTokens);
		var thenText = render_tokens(branch.thenTokens);
		lines.push(('WHEN ' + whenText + (branch.whenComment ? ' ' + branch.whenComment : '')).replace(/\s+$/g, ''));
		lines.push(('THEN ' + thenText + (branch.thenComment ? ' ' + branch.thenComment : '')).replace(/\s+$/g, ''));
	}

	if (caseNode.elseTokens && caseNode.elseTokens.length > 0 || caseNode.elseComment) {
		lines.push(('ELSE ' + render_tokens(caseNode.elseTokens) + (caseNode.elseComment ? ' ' + caseNode.elseComment : '')).replace(/\s+$/g, ''));
	}

	lines.push(('END ' + render_tokens(caseNode.suffixTokens)).replace(/\s+$/g, ''));
	return lines.join('\n');
}

function select_item_for_case_node(nodes, caseNode) {
	for (var i = 0; i < (nodes.selectItems || []).length; i++) {
		var item = nodes.selectItems[i];
		if (caseNode.caseKeywordToken
			&& caseNode.caseKeywordToken.index >= item.startTokenIndex
			&& caseNode.caseKeywordToken.index <= item.endTokenIndex
			&& (item.ownerKind == 'selectList' || item.ownerKind == 'groupByList')) {
			return item;
		}
	}
	return null;
}

function select_span_for_item(nodes, item) {
	for (var s = 0; s < (nodes.selectSpans || []).length; s++) {
		if (nodes.selectSpans[s].id == item.ownerScopeId) {
			return nodes.selectSpans[s];
		}
	}
	return null;
}

function select_base_indent(document, selectSpan) {
	var baseIndent = '';
	if (selectSpan) {
		var selectLine = document.lines[selectSpan.startLine];
		baseIndent = selectLine ? String(selectLine.raw || '').match(/^\s*/)[0] : '';
		var queryScope = sqlScopeModel.find_owner_scope(document.scopes || [], {
			line: selectSpan.startLine,
			tokenIndex: selectSpan.startTokenIndex
		}, 'query');
		if (queryScope && queryScope.id != 0 && typeof queryScope.bodyIndent == 'string') {
			baseIndent = queryScope.bodyIndent;
		}
	}
	return baseIndent;
}

function case_base_indent(document, nodes, caseNode) {
	var scopeId = caseNode.scopeId;
	var functionIndent = function_case_indent(document, nodes, caseNode);

	if (functionIndent != null) {
		return functionIndent;
	}

	var item = select_item_for_case_node(nodes, caseNode);
	if (item) {
		var selectSpan = select_span_for_item(nodes, item);
		var baseIndent = select_base_indent(document, selectSpan);
		if (item.ownerKind == 'groupByList') {
			return baseIndent + '         ';
		}
		return item.id == 'selectItem:0'
			? baseIndent + '       '
			: baseIndent + '        ';
	}

	var line = document.lines[caseNode.startLine];
	return line ? String(line.raw || '').match(/^\s*/)[0] : '';
}

function has_code_before_token_on_line(document, token) {
	var line = token && document.lines[token.line];
	if (!line) {
		return false;
	}
	var before = line.raw.slice(0, token.column).replace(/^\s+|\s+$/g, '');
	if (/^,$/.test(before)) {
		return false;
	}
	return before != '';
}

function set_keyword_layout(document, mutations, token, indentText) {
	if (!token) {
		return;
	}

	if (has_code_before_token_on_line(document, token)) {
		sqlFormatMutations.add_line_break_before_token(mutations, token.id, indentText, '');
	} else {
		sqlFormatMutations.add_line_indent(mutations, token.line, indentText);
	}
}

function first_word_after_token_on_same_line(document, token, word) {
	if (!token) {
		return null;
	}

	for (var i = token.index + 1; i < document.tokens.length; i++) {
		var current = document.tokens[i];
		if (current.line != token.line) {
			return null;
		}
		if (current.type == 'whitespace' || current.type == 'newline') {
			continue;
		}
		if (current.type == 'word' && current.value.toUpperCase() == word) {
			return current;
		}
	}

	return null;
}

function scope_by_id(document, scopeId) {
	for (var i = 0; i < (document.scopes || []).length; i++) {
		if (document.scopes[i].id == scopeId) {
			return document.scopes[i];
		}
	}

	return null;
}

function is_nested_case_node(document, caseNode) {
	var scope = scope_by_id(document, caseNode.scopeId);
	var parent = scope ? scope_by_id(document, scope.parentScopeId) : null;
	return parent && parent.kind == 'caseExpr';
}

function normalized_prefix_before_token(document, token) {
	var line = token ? document.lines[token.line] : null;
	if (!line) {
		return '';
	}

	return String(line.raw || '').slice(0, token.column)
		.replace(/^(\s*select)\s+/i, '$1  ')
		.replace(/([A-Za-z_][A-Za-z0-9_]*)\s+\(/g, '$1(')
		.replace(/\(\s+/g, '(');
}

function select_item_prefix_before_case(document, nodes, caseNode) {
	var item = select_item_for_case_node(nodes, caseNode);
	if (!item || !caseNode.caseKeywordToken) {
		return null;
	}

	var owner = sqlScopeModel.find_owner_scope(document.scopes || [], caseNode.caseKeywordToken, 'functionCall');
	if (!owner || owner.openLine != caseNode.caseKeywordToken.line) {
		return null;
	}

	var selectSpan = select_span_for_item(nodes, item);
	var baseIndent = select_base_indent(document, selectSpan);
	var listPrefix = item.ownerKind == 'groupByList'
		? baseIndent + '         '
		: item.id == 'selectItem:0'
			? baseIndent + 'SELECT  '
			: baseIndent + '       ,';
	var beforeCaseTokens = [];
	for (var i = 0; i < (item.tokens || []).length; i++) {
		if (item.tokens[i].index >= caseNode.caseKeywordToken.index) {
			break;
		}
		beforeCaseTokens.push(item.tokens[i]);
	}
	var beforeCaseText = render_token_values(document, beforeCaseTokens, null);
	if (beforeCaseText == '') {
		return listPrefix;
	}
	if (/[ \t(.,\[]$/.test(listPrefix)) {
		return listPrefix + beforeCaseText + (/[ \t(.,\[]$/.test(beforeCaseText) ? '' : ' ');
	}
	return listPrefix + ' ' + beforeCaseText + (/[ \t(.,\[]$/.test(beforeCaseText) ? '' : ' ');
}

function function_case_indent(document, nodes, caseNode) {
	if (!caseNode || !caseNode.caseKeywordToken) {
		return null;
	}

	var selectPrefix = select_item_prefix_before_case(document, nodes, caseNode);
	if (selectPrefix != null) {
		return repeat_space(expand_tabs_for_width(selectPrefix).length);
	}

	var owner = sqlScopeModel.find_owner_scope(document.scopes || [], caseNode.caseKeywordToken, 'functionCall');
	if (!owner || owner.openLine != caseNode.caseKeywordToken.line) {
		return null;
	}

	for (var scope = owner; scope; scope = scope_by_id(document, scope.parentScopeId)) {
		if (scope.kind == 'conditionBlock') {
			return null;
		}
	}

	return repeat_space(expand_tabs_for_width(normalized_prefix_before_token(document, caseNode.caseKeywordToken)).length);
}

function nested_case_value_for_branch(document, nodes, caseNode, branch) {
	var thenTokens = branch && branch.thenTokens ? branch.thenTokens : [];
	if (thenTokens.length == 0) {
		return null;
	}

	var startIndex = thenTokens[0].index;
	var endIndex = thenTokens[thenTokens.length - 1].index;
	var cases = nodes && nodes.caseExpressions ? nodes.caseExpressions : [];

	for (var i = 0; i < cases.length; i++) {
		var nested = cases[i];
		var scope = scope_by_id(document, nested.scopeId);
		if (nested.scopeId == caseNode.scopeId
			|| !scope
			|| scope.parentScopeId != caseNode.scopeId
			|| nested.caseKeywordToken.index < startIndex
			|| nested.caseKeywordToken.index > endIndex) {
			continue;
		}
		return nested;
	}

	return null;
}

function apply_nested_case_value_joins(document, nodes, caseNode, branch, mutations) {
	var nested = nested_case_value_for_branch(document, nodes, caseNode, branch);
	if (!nested || !branch.thenKeywordToken || nested.startLine <= branch.thenKeywordToken.line) {
		return;
	}

	for (var lineIndex = nested.startLine; lineIndex <= nested.endLine; lineIndex++) {
		sqlFormatMutations.add_line_join(mutations, lineIndex, ' ');
	}
}

function omit_blank_lines_inside_case(document, caseNode, mutations) {
	for (var lineIndex = caseNode.startLine + 1; lineIndex < caseNode.endLine; lineIndex++) {
		if (document.lines[lineIndex] && document.lines[lineIndex].isBlank) {
			sqlFormatMutations.add_line_omission(mutations, lineIndex);
		}
	}
}

function condition_segment_before_case(document, nodes, caseNode) {
	var match = null;
	for (var i = 0; i < (nodes.conditionBlocks || []).length; i++) {
		var block = nodes.conditionBlocks[i];
		for (var s = 0; s < (block.segments || []).length; s++) {
			var segment = block.segments[s];
			if ((segment.kind != 'connector' && segment.kind != 'clause')
				|| !segment.tokens
				|| segment.tokens.length == 0) {
				continue;
			}
			if (segment.lineIndex != caseNode.startLine || segment.tokens[0].index >= caseNode.caseKeywordToken.index) {
				continue;
			}
			for (var t = 0; t < segment.tokens.length; t++) {
				if (segment.tokens[t].index == caseNode.caseKeywordToken.index) {
					if (!match || segment.tokens[0].index > match.tokens[0].index) {
						match = segment;
					}
				}
			}
		}
	}
	return match;
}

function case_follows_condition_clause_keyword(document, nodes, caseNode) {
	var segment = condition_segment_before_case(document, nodes, caseNode);
	if (!segment || !segment.tokens || segment.tokens.length < 2) {
		return false;
	}
	return segment.tokens[1].index == caseNode.caseKeywordToken.index;
}

function render_tokens_between(tokens, startToken, endToken) {
	var result = [];
	for (var i = 0; i < (tokens || []).length; i++) {
		if (startToken && tokens[i].index < startToken.index) {
			continue;
		}
		if (endToken && tokens[i].index >= endToken.index) {
			break;
		}
		result.push(tokens[i].value);
	}
	return result.join(' ').replace(/\s+([,.;)])/g, '$1').replace(/([(])\s+/g, '$1');
}

function condition_case_base_indent(document, nodes, caseNode, baseIndent) {
	var segment = condition_segment_before_case(document, nodes, caseNode);
	if (!segment) {
		return baseIndent;
	}
	var prefix = render_tokens_between(segment.tokens, segment.tokens[0], caseNode.caseKeywordToken);
	if (prefix == '') {
		return baseIndent;
	}
	if (segment.kind == 'clause' && case_follows_condition_clause_keyword(document, nodes, caseNode)) {
		return String(baseIndent || '') + repeat_space(prefix.length + 1);
	}
	if (segment.kind == 'connector' && /^(AND|OR)$/i.exec(prefix)) {
		return String(baseIndent || '') + repeat_space(prefix.length + (baseIndent == '' ? 3 : 1));
	}
	if (segment.kind == 'connector' && /\($/.test(prefix)) {
		if (/\b(AND|OR|NOT|IN|EXISTS|IF) \($/i.exec(prefix)) {
			return String(baseIndent || '') + repeat_space(prefix.length);
		}
		return String(baseIndent || '') + repeat_space(prefix.length + 2);
	}
	if (/\($/.test(prefix)) {
		if (/\b(AND|OR|NOT|IN|EXISTS|IF) \($/i.exec(prefix)) {
			return String(baseIndent || '') + repeat_space(prefix.length);
		}
		return String(baseIndent || '') + repeat_space(prefix.length - 1);
	}
	return String(baseIndent || '') + repeat_space(prefix.length + (/\($/.test(prefix) ? 2 : 3));
}

function case_start_indent(document, nodes, caseNode, baseIndent) {
	var segment = condition_segment_before_case(document, nodes, caseNode);
	if (segment) {
		return condition_case_base_indent(document, nodes, caseNode, baseIndent);
	}
	return baseIndent;
}

function token_indexes(tokens) {
	var lookup = {};
	for (var i = 0; i < (tokens || []).length; i++) {
		lookup[String(tokens[i].index)] = true;
	}
	return lookup;
}

function scope_is_inside_tokens(scope, tokens) {
	if (!scope || !tokens || tokens.length == 0) {
		return false;
	}

	return scope.startTokenIndex >= tokens[0].index
		&& scope.endTokenIndex <= tokens[tokens.length - 1].index;
}

function previous_code_token(document, token) {
	if (!document || !token) {
		return null;
	}

	for (var i = token.index - 1; i >= 0; i--) {
		var candidate = document.tokens[i];
		if (candidate && candidate.isCode) {
			return candidate;
		}
	}

	return null;
}

function next_code_token(document, token) {
	if (!document || !token) {
		return null;
	}

	for (var i = token.index + 1; i < document.tokens.length; i++) {
		var candidate = document.tokens[i];
		if (candidate && candidate.isCode) {
			return candidate;
		}
	}

	return null;
}

function token_in_token_list(token, tokens) {
	for (var i = 0; i < (tokens || []).length; i++) {
		if (tokens[i].index == token.index) {
			return true;
		}
	}
	return false;
}

function token_in_case_value(document, token) {
	var cases = document && document.nodes ? document.nodes.caseExpressions : [];
	for (var i = 0; i < (cases || []).length; i++) {
		var caseNode = cases[i];
		for (var b = 0; b < (caseNode.branches || []).length; b++) {
			if (token_in_token_list(token, caseNode.branches[b].thenTokens)) {
				return true;
			}
		}
		if (token_in_token_list(token, caseNode.elseTokens)) {
			return true;
		}
	}
	return false;
}

function owner_function_scope(document, token) {
	var scopes = document && document.scopes ? document.scopes : [];
	var match = null;
	for (var i = 0; i < scopes.length; i++) {
		var scope = scopes[i];
		if (scope.kind != 'functionCall'
			|| token.index < scope.startTokenIndex
			|| token.index > scope.endTokenIndex) {
			continue;
		}
		if (!match || scope.startTokenIndex >= match.startTokenIndex) {
			match = scope;
		}
	}
	return match;
}

function token_inside_function_named(document, token, name) {
	var scope = owner_function_scope(document, token);
	if (!scope || typeof scope.startTokenIndex != 'number') {
		return false;
	}
	var ownerToken = document.tokens[scope.startTokenIndex - 1];
	return ownerToken
		&& ownerToken.type == 'word'
		&& ownerToken.value.toUpperCase() == String(name || '').toUpperCase();
}

function is_originally_compact_case_function_plus(document, token) {
	if (!token
		|| token.type != 'operator'
		|| token.value != '+'
		|| !token_in_case_value(document, token)) {
		return false;
	}

	var previous = previous_code_token(document, token);
	var next = next_code_token(document, token);
	var afterNext = next_code_token(document, next);

	return previous
		&& previous.type == 'punctuation'
		&& previous.value == ')'
		&& next
		&& next.type == 'word'
		&& afterNext
		&& afterNext.type == 'punctuation'
		&& afterNext.value == '('
		&& original_gap_between(document, previous, token) == ''
		&& original_gap_between(document, token, next) == '';
}

function follows_originally_compact_case_function_plus(document, previousToken, token) {
	var next = next_code_token(document, previousToken);
	return is_originally_compact_case_function_plus(document, previousToken)
		&& next
		&& token
		&& next.index == token.index;
}

function then_follows_when_close_paren(document, branch) {
	var thenToken = branch && branch.thenKeywordToken;
	var previous = previous_code_token(document, thenToken);
	var whenTokenIndexes = token_indexes(branch ? branch.whenTokens : []);

	return previous
		&& previous.line == thenToken.line
		&& previous.type == 'punctuation'
		&& previous.value == ')'
		&& whenTokenIndexes[String(previous.index)] === true;
}

function then_comment_has_following_value(document, branch) {
	if (!branch || !branch.thenKeywordToken || !branch.thenTokens || branch.thenTokens.length == 0) {
		return false;
	}
	var line = document.lines[branch.thenKeywordToken.line];
	return line
		&& line.hasTrailingComment
		&& branch.thenTokens[0].line != branch.thenKeywordToken.line;
}

function can_join_then_line_to_when(document, branch, wrapValues) {
	if (wrapValues
		|| !branch
		|| !branch.whenKeywordToken
		|| !branch.thenKeywordToken
		|| !branch.thenTokens
		|| branch.thenTokens.length == 0
		|| branch.thenKeywordToken.line == branch.whenKeywordToken.line
		|| branch.thenTokens[0].line != branch.thenKeywordToken.line
		|| sorted_token_lines(branch.whenTokens || []).length > 1) {
		return false;
	}
	var whenLine = document.lines[branch.whenKeywordToken.line];
	var thenLine = document.lines[branch.thenKeywordToken.line];
	return (!whenLine || !whenLine.hasTrailingComment)
		&& (!thenLine || !thenLine.hasTrailingComment);
}

function can_join_else_value_line(document, caseNode, wrapValues) {
	if (wrapValues
		|| !caseNode
		|| case_has_multiline_when(caseNode)
		|| !caseNode.elseKeywordToken
		|| !caseNode.elseTokens
		|| caseNode.elseTokens.length == 0
		|| caseNode.elseTokens[0].line == caseNode.elseKeywordToken.line) {
		return false;
	}
	var elseLine = document.lines[caseNode.elseKeywordToken.line];
	var valueLine = document.lines[caseNode.elseTokens[0].line];
	return (!elseLine || !elseLine.hasTrailingComment)
		&& (!valueLine || !valueLine.hasTrailingComment);
}

function case_has_multiline_when(caseNode) {
		for (var i = 0; i < (caseNode.branches || []).length; i++) {
			var branch = caseNode.branches[i];
			for (var t = 0; t < (branch.whenTokens || []).length; t++) {
			if (branch.whenTokens[t].line != branch.whenKeywordToken.line) {
				return true;
			}
		}
	}
		return false;
	}

function tokens_are_single_function_call(document, tokens) {
	if (!tokens || tokens.length < 3 || tokens[0].type != 'word') {
		return false;
	}
	for (var i = 0; i < (document.scopes || []).length; i++) {
		var scope = document.scopes[i];
		if (scope.kind == 'functionCall'
			&& scope.startTokenIndex == tokens[1].index
			&& scope.endTokenIndex == tokens[tokens.length - 1].index) {
			return true;
		}
	}
	return false;
}

function case_should_wrap_values(document, caseNode, config) {
	var wrapLimit = config && config.caseWhenThenWrapLength ? parseInt(config.caseWhenThenWrapLength, 10) : 50;
	if (!wrapLimit || wrapLimit < 1) {
		wrapLimit = 50;
		}

	for (var i = 0; i < (caseNode.branches || []).length; i++) {
		var branch = caseNode.branches[i];
		var whenLines = sorted_token_lines(branch.whenTokens || []);
		var whenText = render_token_values(document, branch.whenTokens || [], null);
		var thenText = render_token_values(document, branch.thenTokens || [], null);
		if ((whenLines.length <= 1 && whenText.length > wrapLimit)
			|| (thenText.length > wrapLimit && !tokens_are_single_function_call(document, branch.thenTokens))) {
			return true;
		}
	}

		return false;
	}

function token_value_text(token) {
	return token ? token.value : '';
}

function original_gap_between(document, previousToken, token) {
	if (!document || !previousToken || !token || previousToken.line != token.line) {
		return '';
	}
	return String(document.source || '').slice(previousToken.end, token.start);
}

function render_token_values(document, tokens, preserveCommaGapTokenIndexes) {
	var output = '';
	var previousToken = null;

	for (var i = 0; i < (tokens || []).length; i++) {
		var token = tokens[i];
		var value = token_value_text(token);

		if (output == '') {
			output = value;
		} else if (token.type == 'punctuation'
			&& (value == ',' || value == ';' || value == ')' || value == ']' || value == '.')) {
			output = output.replace(/[ \t]+$/g, '') + value;
		} else if (token.type == 'punctuation' && value == '(') {
			if (previousToken && previousToken.type == 'word' && previousToken.value.toUpperCase() == 'IN') {
				output = output.replace(/[ \t]+$/g, '') + ' ' + value;
			} else {
				output = output.replace(/[ \t]+$/g, '') + value;
			}
		} else if (is_originally_compact_case_function_plus(document, token)) {
			output = output.replace(/[ \t]+$/g, '') + value;
		} else if (follows_originally_compact_case_function_plus(document, previousToken, token)) {
			output += value;
		} else if (token.type == 'number'
			&& previousToken
			&& previousToken.type == 'operator'
			&& /^[+-]$/.test(previousToken.value)) {
			output += value;
		} else if (previousToken
			&& previousToken.type == 'punctuation'
			&& previousToken.value == ','
			&& preserveCommaGapTokenIndexes
			&& preserveCommaGapTokenIndexes[String(token.index)]
			&& !token_inside_function_named(document, token, 'COALESCE')
			&& /[ \t]/.test(original_gap_between(document, previousToken, token))) {
			output = output.replace(/[ \t]+$/g, '') + ' ' + value;
		} else if (/[\s(.,\[]$/.test(output)) {
			output += value;
		} else {
			output += ' ' + value;
		}

		previousToken = token;
	}

	return output;
}

function tokens_on_line(tokens, lineIndex) {
	var result = [];
	for (var i = 0; i < (tokens || []).length; i++) {
		if (tokens[i].line == lineIndex) {
			result.push(tokens[i]);
		}
	}
	return result;
}

function sorted_token_lines(tokens) {
	var seen = {};
	var lines = [];
	for (var i = 0; i < (tokens || []).length; i++) {
		var key = String(tokens[i].line);
		if (!seen[key]) {
			seen[key] = true;
			lines.push(tokens[i].line);
		}
	}
	return lines.sort(function(a, b) {
		return a - b;
	});
}

function direct_scope_for_case_when_line(document, caseNode, branch, lineIndex) {
	var scopes = document.scopes || [];
	for (var i = 0; i < scopes.length; i++) {
		var scope = scopes[i];
		if (scope.kind == 'inList'
			&& scope.parentScopeId == caseNode.scopeId
			&& scope_is_inside_tokens(scope, branch.whenTokens)
			&& typeof scope.openLine == 'number'
			&& typeof scope.closeLine == 'number'
			&& lineIndex >= scope.openLine
			&& lineIndex <= scope.closeLine) {
			return scope;
		}
	}
	return null;
}

function tokens_between_same_line(document, startToken, endToken) {
	var result = [];
	if (!document || !startToken || !endToken || startToken.line != endToken.line) {
		return result;
	}

	for (var i = startToken.index + 1; i < endToken.index; i++) {
		var token = document.tokens[i];
		if (token && token.isCode && token.line == startToken.line) {
			result.push(token);
		}
	}
	return result;
}

function add_case_width(document, widths, indentText, tokens, preserveCommaGapTokenIndexes) {
	var text = render_token_values(document, tokens, preserveCommaGapTokenIndexes);
	if (text != '') {
		widths.push(String(indentText || '').length + text.length);
	}
}

function case_alias_spacing(document, nodes, caseNode, asToken, baseIndent, branchIndent, valueIndent, config, wrapValues) {
		var widths = [];
		var firstBranch = caseNode.branches && caseNode.branches.length > 0 ? caseNode.branches[0] : null;
		var maxAlignWidth = config && config.maxAlignWidth ? config.maxAlignWidth : 150;
		var multilineWhen = case_has_multiline_when(caseNode) || wrapValues;
		var valueTokenIndexes = token_indexes(caseNode.elseTokens || []);

	for (var valueBranchIndex = 0; valueBranchIndex < (caseNode.branches || []).length; valueBranchIndex++) {
		var valueTokens = caseNode.branches[valueBranchIndex].thenTokens || [];
		for (var valueTokenIndex = 0; valueTokenIndex < valueTokens.length; valueTokenIndex++) {
			valueTokenIndexes[String(valueTokens[valueTokenIndex].index)] = true;
		}
	}

	if (firstBranch && caseNode.caseKeywordToken) {
		add_case_width(
			document,
			widths,
			baseIndent,
			[caseNode.caseKeywordToken].concat(tokens_between_same_line(document, caseNode.caseKeywordToken, firstBranch.whenKeywordToken)),
			valueTokenIndexes
		);
	} else if (caseNode.caseKeywordToken) {
		add_case_width(document, widths, baseIndent, [caseNode.caseKeywordToken], valueTokenIndexes);
	}

	for (var b = 0; b < (caseNode.branches || []).length; b++) {
			var branch = caseNode.branches[b];
			var whenLines = sorted_token_lines([branch.whenKeywordToken].concat(branch.whenTokens || []));
			var thenCommentBreaksValue = then_comment_has_following_value(document, branch);
			var thenStaysWithWhen = branch.thenKeywordToken
				&& !wrapValues
				&& !thenCommentBreaksValue
				&& branch.thenKeywordToken.line == branch.whenKeywordToken.line;
			var thenJoinsWithWhen = can_join_then_line_to_when(document, branch, wrapValues);
			var thenStaysWithClose = !wrapValues && then_follows_when_close_paren(document, branch);

			for (var w = 0; w < whenLines.length; w++) {
				var lineIndex = whenLines[w];
				var scope = direct_scope_for_case_when_line(document, caseNode, branch, lineIndex);
				var indent = valueIndent;
				var tokens = tokens_on_line(branch.whenTokens, lineIndex);

			if (lineIndex == branch.whenKeywordToken.line) {
				indent = branchIndent;
				tokens = [branch.whenKeywordToken].concat(tokens);
				} else if (scope && lineIndex > scope.openLine && lineIndex < scope.closeLine) {
					indent = valueIndent + '    ';
				}
				if (scope && scope.openLine != scope.closeLine && lineIndex == scope.openLine) {
					tokens = tokens.filter(function(token) {
						return token.index <= scope.openTokenIndex;
					});
				}

					if (((thenStaysWithWhen || thenStaysWithClose)
							&& branch.thenKeywordToken
							&& branch.thenKeywordToken.line == lineIndex)
						|| (thenJoinsWithWhen && lineIndex == branch.whenKeywordToken.line)) {
					if (thenStaysWithWhen || thenJoinsWithWhen) {
						var whenText = render_token_values(document, tokens, valueTokenIndexes);
						var thenTokens = nested_case_value_for_branch(document, nodes, caseNode, branch)
							? branch.thenTokens
							: (thenJoinsWithWhen ? branch.thenTokens : tokens_on_line(branch.thenTokens, lineIndex));
						var thenText = render_token_values(document, [branch.thenKeywordToken].concat(thenTokens), valueTokenIndexes);
						widths.push(String(indent || '').length + whenText.length + case_when_then_spacing(branch, caseNode).length + thenText.length);
						continue;
						}
						tokens = tokens.concat([branch.thenKeywordToken], tokens_on_line(branch.thenTokens, lineIndex));
					}
				if (scope
					&& lineIndex == scope.closeLine
					&& branch.thenKeywordToken
					&& branch.thenKeywordToken.line == scope.closeLine + 1) {
					tokens = tokens.concat([branch.thenKeywordToken], branch.thenTokens || []);
				}

				add_case_width(document, widths, indent, tokens, valueTokenIndexes);
			}

			if (branch.thenKeywordToken && !thenStaysWithWhen && !thenJoinsWithWhen && !thenStaysWithClose) {
				add_case_width(
					document,
					widths,
				valueIndent,
				[branch.thenKeywordToken].concat(tokens_on_line(branch.thenTokens, branch.thenKeywordToken.line)),
					valueTokenIndexes
				);
			}
			if (thenCommentBreaksValue) {
				add_case_width(document, widths, valueIndent, branch.thenTokens || [], valueTokenIndexes);
			}
		}

	if (caseNode.elseKeywordToken) {
		if (multilineWhen && caseNode.elseTokens && caseNode.elseTokens.length > 0) {
			add_case_width(document, widths, branchIndent, [caseNode.elseKeywordToken], valueTokenIndexes);
			add_case_width(document, widths, valueIndent, caseNode.elseTokens, valueTokenIndexes);
		} else {
			add_case_width(document, widths, branchIndent, [caseNode.elseKeywordToken].concat(caseNode.elseTokens || []), valueTokenIndexes);
		}
	}

	var beforeAsTokens = [caseNode.endKeywordToken].concat(tokens_between_same_line(document, caseNode.endKeywordToken, asToken));
	var beforeAsWidth = String(baseIndent || '').length + render_token_values(document, beforeAsTokens, valueTokenIndexes).length;
	var maxWidth = beforeAsWidth;
	for (var i = 0; i < widths.length; i++) {
		if (widths[i] > maxWidth && widths[i] < maxAlignWidth) {
			maxWidth = widths[i];
		}
	}

	var spacingWidth = maxWidth + 1 - beforeAsWidth;
	return repeat_space(spacingWidth < 1 ? 1 : spacingWidth);
}

function apply_case_when_scope_indents(document, caseNode, branch, mutations, valueIndent) {
	var scopes = document.scopes || [];
	for (var i = 0; i < scopes.length; i++) {
		var scope = scopes[i];
		if (scope.kind != 'inList'
			|| scope.parentScopeId != caseNode.scopeId
			|| !scope_is_inside_tokens(scope, branch.whenTokens)
			|| typeof scope.openLine != 'number'
			|| typeof scope.closeLine != 'number'
			|| scope.openLine == scope.closeLine) {
			continue;
		}

		for (var lineIndex = scope.openLine + 1; lineIndex < scope.closeLine; lineIndex++) {
			sqlFormatMutations.add_line_indent(mutations, lineIndex, valueIndent + '    ');
		}
			sqlFormatMutations.add_line_indent(mutations, scope.closeLine, valueIndent);
		}
	}

	function apply_case_when_inlist_layout(document, caseNode, branch, mutations, valueIndent) {
		var scopes = document.scopes || [];
		for (var i = 0; i < scopes.length; i++) {
			var scope = scopes[i];
			if (scope.kind != 'inList'
				|| scope.parentScopeId != caseNode.scopeId
				|| !scope_is_inside_tokens(scope, branch.whenTokens)
				|| typeof scope.openLine != 'number'
				|| typeof scope.closeLine != 'number'
				|| scope.openLine == scope.closeLine) {
				continue;
			}

			for (var t = 0; t < (branch.whenTokens || []).length; t++) {
				var token = branch.whenTokens[t];
				if (token.index > scope.openTokenIndex
					&& token.index < scope.closeTokenIndex
					&& token.line == scope.openLine) {
					sqlFormatMutations.add_line_break_before_token(mutations, token.id, valueIndent + '    ', '');
					break;
				}
			}

			if (branch.thenKeywordToken
				&& branch.thenKeywordToken.line == scope.closeLine + 1
				&& document.lines[scope.closeLine]
				&& !document.lines[scope.closeLine].hasTrailingComment) {
				sqlFormatMutations.add_line_join(mutations, branch.thenKeywordToken.line, ' ');
			}
		}
	}

	function case_when_then_spacing(branch, caseNode) {
	var maxWhenWidth = 0;
	for (var i = 0; i < (caseNode.branches || []).length; i++) {
		var current = caseNode.branches[i];
		if (!current.thenKeywordToken
			|| !current.whenKeywordToken
			|| current.thenKeywordToken.line != current.whenKeywordToken.line) {
			continue;
		}
		var whenText = render_token_values(
			null,
			[current.whenKeywordToken].concat(current.whenTokens || []),
			null
		);
		if (whenText.length > maxWhenWidth) {
			maxWhenWidth = whenText.length;
		}
	}

	var currentText = render_token_values(
		null,
		[branch.whenKeywordToken].concat(branch.whenTokens || []),
		null
	);
	var width = maxWhenWidth - currentText.length + 1;
	return repeat_space(width < 1 ? 1 : width);
}

function apply_case_mutations(document, nodes, mutations, config) {
	if (!document || !nodes || !mutations) {
		return;
	}

	for (var i = 0; i < (nodes.caseExpressions || []).length; i++) {
			var caseNode = nodes.caseExpressions[i];
			if (is_nested_case_node(document, caseNode)) {
				continue;
			}

				var baseIndent = case_base_indent(document, nodes, caseNode);
				var caseIndent = case_start_indent(document, nodes, caseNode, baseIndent);
					var branchIndent = caseIndent + '    ';
					var valueIndent = branchIndent + '    ';
					var wrapValues = case_should_wrap_values(document, caseNode, config);
					var keepCaseWithFunctionPrefix = function_case_indent(document, nodes, caseNode) != null;
					omit_blank_lines_inside_case(document, caseNode, mutations);

				if (caseIndent == baseIndent
					&& !keepCaseWithFunctionPrefix
					&& !case_follows_condition_clause_keyword(document, nodes, caseNode)) {
					set_keyword_layout(document, mutations, caseNode.caseKeywordToken, baseIndent);
				}

				for (var b = 0; b < (caseNode.branches || []).length; b++) {
				var branch = caseNode.branches[b];
				set_keyword_layout(document, mutations, branch.whenKeywordToken, branchIndent);
				if (can_join_then_line_to_when(document, branch, wrapValues)) {
					sqlFormatMutations.add_line_join(mutations, branch.thenKeywordToken.line, ' ');
				}
				apply_case_when_scope_indents(document, caseNode, branch, mutations, valueIndent);
				apply_case_when_inlist_layout(document, caseNode, branch, mutations, valueIndent);
				apply_nested_case_value_joins(document, nodes, caseNode, branch, mutations);
						if (branch.thenKeywordToken && then_comment_has_following_value(document, branch)) {
							sqlFormatMutations.add_line_break_before_token(mutations, branch.thenKeywordToken.id, valueIndent, '');
							sqlFormatMutations.add_line_indent(mutations, branch.thenTokens[0].line, valueIndent);
						} else if (branch.thenKeywordToken && wrapValues) {
							if (branch.whenKeywordToken
								&& branch.thenKeywordToken.line == branch.whenKeywordToken.line) {
							sqlFormatMutations.add_line_break_before_token(mutations, branch.thenKeywordToken.id, valueIndent, '');
						} else {
							set_keyword_layout(document, mutations, branch.thenKeywordToken, valueIndent);
						}
					} else if (branch.thenKeywordToken
						&& branch.whenKeywordToken
						&& branch.thenKeywordToken.line != branch.whenKeywordToken.line
						&& !then_follows_when_close_paren(document, branch)) {
						set_keyword_layout(document, mutations, branch.thenKeywordToken, valueIndent);
					} else if (branch.thenKeywordToken
						&& branch.whenKeywordToken
						&& branch.thenKeywordToken.line == branch.whenKeywordToken.line) {
						sqlFormatMutations.add_spacing_before_token(
							mutations,
						branch.thenKeywordToken.id,
						case_when_then_spacing(branch, caseNode)
					);
				}
			}

		set_keyword_layout(document, mutations, caseNode.elseKeywordToken, branchIndent);
			if (can_join_else_value_line(document, caseNode, wrapValues)) {
				sqlFormatMutations.add_line_join(mutations, caseNode.elseTokens[0].line, ' ');
			}
			if ((wrapValues || case_has_multiline_when(caseNode))
				&& caseNode.elseKeywordToken
				&& caseNode.elseTokens
				&& caseNode.elseTokens.length > 0
				&& caseNode.elseTokens[0].line == caseNode.elseKeywordToken.line) {
				sqlFormatMutations.add_line_break_before_token(mutations, caseNode.elseTokens[0].id, valueIndent, '');
			}
			if (caseNode.elseKeywordToken
				&& caseNode.elseTokens
				&& caseNode.elseTokens.length > 0
				&& caseNode.elseTokens[0].line != caseNode.elseKeywordToken.line) {
				sqlFormatMutations.add_line_indent(mutations, caseNode.elseTokens[0].line, valueIndent);
			}
				set_keyword_layout(document, mutations, caseNode.endKeywordToken, caseIndent);

		var asToken = first_word_after_token_on_same_line(document, caseNode.endKeywordToken, 'AS');
		if (asToken) {
			sqlFormatMutations.add_spacing_before_token(
					mutations,
					asToken.id,
					case_alias_spacing(document, nodes, caseNode, asToken, baseIndent, branchIndent, valueIndent, config, wrapValues)
				);
			}
	}
}

exports.get_case_tokens = get_case_tokens;
exports.get_case_balance_delta = get_case_balance_delta;
exports.find_top_level_as_loc = find_top_level_as_loc;
exports.get_outer_as_code_width = get_outer_as_code_width;
exports.get_alignment_width_for_code = get_alignment_width_for_code;
exports.format_case_expression_line = format_case_expression_line;
exports.format_case_blocks = format_case_blocks;
exports.apply_case_mutations = apply_case_mutations;
exports.render_case_node = render_case_node;
exports.find_root_case_start_loc = find_root_case_start_loc;
exports.is_case_branch_line = sqlCaseUtils.is_case_branch_line;
