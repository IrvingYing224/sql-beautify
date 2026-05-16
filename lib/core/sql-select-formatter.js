var sqlTokenizer = require('./sql-tokenizer');
var sqlStructure = require('./sql-structure');
var sqlCaseUtils = require('./sql-case-utils');
var sqlFormatUtils = require('./sql-format-utils');
var sqlClauseRegistry = require('./sql-clause-registry');
var expand_tabs_for_width = sqlFormatUtils.expand_tabs_for_width;
var repeat_space = sqlFormatUtils.repeat_space;
var find_top_level_as_loc = sqlCaseUtils.find_top_level_as_loc;
var get_alignment_width_for_code = sqlCaseUtils.get_alignment_width_for_code;

function split_code_and_comment(text) {
	return sqlStructure.split_code_and_comment(text);
}

function move_top_level_separator_before_comment(line) {
	var parts = split_code_and_comment(line);
	var code = parts.code.replace(/\s+$/ig, '');
	var comment = parts.comment.replace(/^\s+|\s+$/g, '');

	if (comment == '' || !/,$/.test(code)) {
		return {
			line: line,
			moved: false
		};
	}

	return {
		line: code.slice(0, -1).replace(/\s+$/ig, '') + ' ' + comment,
		moved: true
	};
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

function is_select_item_start(line) {
	var trimmed = line.replace(/^\s+/ig, '');
	return /^SELECT\b/i.exec(trimmed) || /^GROUP BY\b/i.exec(trimmed) || /^,/.exec(trimmed);
}

function is_select_block_start(line, dialect) {
	return sqlClauseRegistry.is_select_block_start(line, dialect || 'generic');
}

function is_select_block_end(line, dialect) {
	return sqlClauseRegistry.is_select_block_end(line, dialect || 'generic');
}

function split_top_level_items(text) {
	var source = String(text || '');
	var items = [];
	var current = '';
	var paren_depth = 0;
	var quote = '';

	for (let i = 0; i < source.length; i++) {
		var ch = source[i];

		if ((ch == "'" || ch == '"') && quote == '') {
			quote = ch;
		} else if (ch == quote) {
			quote = '';
		}

		if (quote == '') {
			if (ch == '(') {
				paren_depth += 1;
			} else if (ch == ')' && paren_depth > 0) {
				paren_depth -= 1;
			}

			if (ch == ',' && paren_depth == 0) {
				items.push(current);
				current = '';
				continue;
			}
		}

		current += ch;
	}

	items.push(current);
	return items;
}

function normalize_select_item_text(item) {
	var normalized = item.replace(/,\s+/ig, ',');
	normalized = normalized.replace(/ORDER BY\s+/ig, 'ORDER BY ');

	if (/^ROW_NUMBER\(\)\s+OVER\(/i.exec(normalized) || /ORDER BY [^)]*,/i.exec(normalized)) {
		normalized = normalized.replace(/ORDER BY /i, 'ORDER BY  ');
	}

	return normalized;
}

function format_select_clause_line(line, keyword, continuation_indent) {
	var trimmed = line.replace(/^\s+/ig, '').replace(/\s+$/ig, '');
	var keyword_match = trimmed.match(new RegExp('^' + keyword.replace(/ /g, '\\s+') + '\\b', 'i'));

	if (keyword_match == null) {
		return line;
	}

	var remainder = trimmed.slice(keyword_match[0].length).replace(/^\s+/ig, '').replace(/\s+$/ig, '');
	if (remainder == '') {
		return keyword;
	}

	var items = split_top_level_items(remainder);
	var lines = [];

	for (let i = 0; i < items.length; i++) {
		var item = normalize_select_item_text(items[i].replace(/^\s+/ig, '').replace(/\s+$/ig, ''));
		if (item == '') {
			continue;
		}

		if (i == 0) {
			lines.push(keyword + '  ' + item);
		} else {
			lines.push(continuation_indent + ',' + item);
		}
	}

	return lines.join('\n');
}

function format_select_clause_lists(str) {
	var text_list = String(str || '').split('\n');
	var output = [];
	var in_select_list = false;
	var continuation_indent = '       ';
	var pending_leading_comma = false;

	for (let i = 0; i < text_list.length; i++) {
		if (pending_leading_comma) {
			var pending_trimmed = text_list[i].replace(/^\s+/ig, '');
			if (in_select_list && pending_trimmed != '' && !/^,/.exec(pending_trimmed) && !is_select_block_end(pending_trimmed, 'generic')) {
				text_list[i] = text_list[i].match(/^\s*/)[0] + ',' + pending_trimmed;
			}
			pending_leading_comma = false;
		}

		var separator_result = move_top_level_separator_before_comment(text_list[i]);
		text_list[i] = separator_result.line;
		var trimmed = text_list[i].replace(/^\s+/ig, '');

		if (/^SELECT\b/i.exec(trimmed)) {
			in_select_list = true;
			continuation_indent = '       ';
			output.push(format_select_clause_line(text_list[i], 'SELECT', '       '));
			pending_leading_comma = separator_result.moved;
			continue;
		}

		if (/^GROUP BY\b/i.exec(trimmed)) {
			in_select_list = true;
			continuation_indent = '         ';
			output.push(format_select_clause_line(text_list[i], 'GROUP BY', '         '));
			pending_leading_comma = separator_result.moved;
			continue;
		}

		if (in_select_list && /^,/.exec(trimmed)) {
			output.push(continuation_indent + ',' + normalize_select_item_text(trimmed.slice(1).replace(/^\s+/ig, '')));
			pending_leading_comma = separator_result.moved;
			continue;
		}

		if (in_select_list && is_select_block_end(trimmed, 'generic')) {
			in_select_list = false;
		}

		output.push(text_list[i]);
		pending_leading_comma = in_select_list && separator_result.moved;
	}

	return output.join('\n');
}

function apply_as_alignment_on_items(text_list, items, maxAlignWidth) {
	var max_as_loc = 0;

	for (let i = 0; i < items.length; i++) {
		if (items[i].max_code_width > max_as_loc && items[i].max_code_width < maxAlignWidth) {
			max_as_loc = items[i].max_code_width;
		}
	}

	for (let i = 0; i < items.length; i++) {
		if (items[i].as_line_index >= 0 && items[i].as_loc >= 0) {
			var current_line = text_list[items[i].as_line_index];
			var before_as = current_line.slice(0, items[i].as_loc).replace(/\s+$/ig, '');
			var after_as = current_line.slice(items[i].as_loc + 4).replace(/^\s+/ig, '');
			var before_as_visual_length = expand_tabs_for_width(before_as).length;
			var padding = max_as_loc - before_as_visual_length;
			if (padding >= 0) {
				text_list[items[i].as_line_index] = before_as + repeat_space(padding) + " AS " + after_as;
			}
		}
	}
}

function align_as_in_select_blocks(str, maxAlignWidth, dialect) {
	var text_list = str.split('\n');
	var current_items = [];
	var current_item = null;
	var in_block = false;

	for (let i = 0; i < text_list.length; i++) {
		if (is_select_block_start(text_list[i], dialect)) {
			if (in_block) {
				apply_as_alignment_on_items(text_list, current_items, maxAlignWidth);
			}
			in_block = true;
			current_items = [{
				as_line_index: -1,
				as_loc: -1,
				max_code_width: 0
			}];
			current_item = current_items[0];
		} else if (in_block && is_select_block_end(text_list[i], dialect)) {
			apply_as_alignment_on_items(text_list, current_items, maxAlignWidth);
			in_block = false;
			current_items = [];
			current_item = null;
		} else if (in_block && /^,/.exec(text_list[i].replace(/^\s+/ig, ''))) {
			current_item = {
				as_line_index: -1,
				as_loc: -1,
				max_code_width: 0
			};
			current_items.push(current_item);
		}

		if (in_block && current_item != null) {
			var line_parts = split_code_and_comment(text_list[i]);
			var code = line_parts.code.replace(/\s+$/ig, '');
			var code_width = 0;
			var alignment_info = get_alignment_width_for_code(code);
			var top_level_as_loc = alignment_info.top_level_as_loc;

			if (code != '') {
				if (top_level_as_loc >= 0) {
					current_item.as_line_index = i;
					current_item.as_loc = top_level_as_loc;
					code_width = alignment_info.width;
				} else {
					code_width = alignment_info.width;
				}

				if (code_width > current_item.max_code_width) {
					current_item.max_code_width = code_width;
				}
			}
		}
	}

	if (in_block) {
		apply_as_alignment_on_items(text_list, current_items, maxAlignWidth);
	}

	return text_list.join('\n');
}

function apply_trailing_comma_style(str) {
	var text_final = '';
	var text_list = str.replace(/\n *\-\-/ig, " \-\-{}").split("\n");
	for (let i = 0; i < text_list.length; i++) {
		var this_line = text_list[i];
		var next_line = '';

		if (i + 1 <= text_list.length) {
			next_line = text_list[i + 1];
		}

		var comment_loc = get_first_comment_loc(this_line);
		var is_comment = comment_loc;

		if (/^\s+\,/.exec(this_line)) {
			var the_comma_loc = this_line.indexOf(',');
			this_line = this_line.slice(0, the_comma_loc) + ' ' + this_line.slice(the_comma_loc + 1);
		}

		this_line.replace(/\s$/ig, "") + ',' + '\n ';

		if (/^\s+\,/.exec(next_line)) {
			if (is_comment > 0) {
				text_final += this_line.slice(0, comment_loc).replace(/\s$/ig, "") + "," + this_line.slice(comment_loc) + '\n';
			} else {
				text_final += this_line.replace(/\s$/ig, "") + ',' + '\n';
			}
		} else {
			text_final += this_line + '\n';
		}
	}
	return text_final.replace(/\-\-\{\}/ig, "\n--");
}

exports.expand_tabs_for_width = expand_tabs_for_width;
exports.format_select_clause_lists = format_select_clause_lists;
exports.align_as_in_select_blocks = align_as_in_select_blocks;
exports.apply_trailing_comma_style = apply_trailing_comma_style;
