var sqlTokenizer = require('./sql-tokenizer');
var sqlStructure = require('./sql-structure');
var sqlTokenPrimitives = require('./sql-token-primitives');
var sqlCaseUtils = require('./sql-case-utils');
var sqlFormatUtils = require('./sql-format-utils');
var sqlClauseRegistry = require('./sql-clause-registry');
var expand_tabs_for_width = sqlFormatUtils.expand_tabs_for_width;
var repeat_space = sqlFormatUtils.repeat_space;
var find_top_level_as_loc = sqlCaseUtils.find_top_level_as_loc;
var get_alignment_width_for_code = sqlCaseUtils.get_alignment_width_for_code;

function resolve_dialect_name(dialect) {
	return dialect && dialect.dialect ? dialect.dialect : (dialect || 'generic');
}

function split_code_and_comment(text, tokenizerOptions) {
	return sqlStructure.split_code_and_comment(text, tokenizerOptions);
}

function move_top_level_separator_before_comment(line, tokenizerOptions) {
	var parts = split_code_and_comment(line, tokenizerOptions);
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

function get_first_comment_loc(text, tokenizerOptions) {
	var tokens = sqlTokenizer.tokenize(text, tokenizerOptions);
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
	return sqlClauseRegistry.is_select_block_start(line, resolve_dialect_name(dialect));
}

function is_select_block_end(line, dialect) {
	return sqlClauseRegistry.is_select_block_end(line, resolve_dialect_name(dialect));
}

function normalize_select_item_text(item) {
	var normalized = item.replace(/,\s+/ig, ',');
	normalized = normalized.replace(/ORDER BY\s+/ig, 'ORDER BY ');

	if (/^ROW_NUMBER\(\)\s+OVER\(/i.exec(normalized) || /ORDER BY [^)]*,/i.exec(normalized)) {
		normalized = normalized.replace(/ORDER BY /i, 'ORDER BY  ');
	}

	return normalized;
}

function extract_leading_standalone_comment_markers(text, tokenizerOptions) {
	var source = String(text || '');
	var tokens = sqlTokenizer.tokenize(source, tokenizerOptions);
	var markers = [];
	var cursor = 0;

	for (let i = 0; i < tokens.length; i++) {
		if (tokens[i].type == 'whitespace' || tokens[i].type == 'newline') {
			cursor = tokens[i].end;
			continue;
		}

		if (tokens[i].type == 'placeholder' && /standalone_comment/.exec(tokens[i].value)) {
			markers.push(tokens[i].value);
			cursor = tokens[i].end;
			continue;
		}

		break;
	}

	return {
		markers: markers,
		remainder: source.slice(cursor).replace(/^\s+/ig, '')
	};
}

function append_select_item_lines(lines, prefix, item_text, tokenizerOptions) {
	var extracted = extract_leading_standalone_comment_markers(item_text, tokenizerOptions);

	for (let i = 0; i < extracted.markers.length; i++) {
		lines.push(extracted.markers[i]);
	}

	var normalized = normalize_select_item_text(extracted.remainder.replace(/^\s+/ig, '').replace(/\s+$/ig, ''));
	if (normalized == '') {
		return false;
	}

	lines.push(prefix + normalized);
	return true;
}

function format_select_clause_line(line, keyword, continuation_indent, tokenizerOptions) {
	var trimmed = line.replace(/^\s+/ig, '').replace(/\s+$/ig, '');
	var keyword_match = trimmed.match(new RegExp('^' + keyword.replace(/ /g, '\\s+') + '\\b', 'i'));

	if (keyword_match == null) {
		return line;
	}

	var remainder = trimmed.slice(keyword_match[0].length).replace(/^\s+/ig, '').replace(/\s+$/ig, '');
	if (remainder == '') {
		return keyword;
	}

	var items = sqlTokenPrimitives.split_top_level_items(remainder, tokenizerOptions);
	var lines = [];
	var actual_item_count = 0;

	for (let i = 0; i < items.length; i++) {
		var prefix = actual_item_count == 0 ? keyword + '  ' : continuation_indent + ',';
		if (append_select_item_lines(lines, prefix, items[i], tokenizerOptions)) {
			actual_item_count += 1;
		}
	}

	if (actual_item_count == 0) {
		return keyword;
	}

	return lines.join('\n');
}

function format_select_clause_lists(str, dialect) {
	var text_list = String(str || '').split('\n');
	var output = [];
	var in_select_list = false;
	var continuation_indent = '       ';
	var pending_leading_comma = false;
	var tokenizerOptions = dialect;

	for (let i = 0; i < text_list.length; i++) {
		if (pending_leading_comma) {
			var pending_trimmed = text_list[i].replace(/^\s+/ig, '');
			var pending_extracted = extract_leading_standalone_comment_markers(pending_trimmed, tokenizerOptions);
			if (in_select_list
				&& pending_extracted.markers.length > 0
				&& pending_extracted.remainder == '') {
				// Preserve the pending comma for the next real select item line.
			} else if (in_select_list && pending_trimmed != '' && !/^,/.exec(pending_trimmed) && !is_select_block_end(pending_trimmed, dialect)) {
				text_list[i] = continuation_indent + ',' + pending_trimmed;
				pending_leading_comma = false;
			} else {
				pending_leading_comma = false;
			}
		}

		var separator_result = move_top_level_separator_before_comment(text_list[i], tokenizerOptions);
		text_list[i] = separator_result.line;
		var trimmed = text_list[i].replace(/^\s+/ig, '');

		if (/^SELECT\b/i.exec(trimmed)) {
			in_select_list = true;
			continuation_indent = '       ';
			output.push(format_select_clause_line(text_list[i], 'SELECT', '       ', tokenizerOptions));
			pending_leading_comma = separator_result.moved;
			continue;
		}

		if (/^GROUP BY\b/i.exec(trimmed)) {
			in_select_list = true;
			continuation_indent = '         ';
			output.push(format_select_clause_line(text_list[i], 'GROUP BY', '         ', tokenizerOptions));
			pending_leading_comma = separator_result.moved;
			continue;
		}

		if (in_select_list && /^,/.exec(trimmed)) {
			var continuation_items = sqlTokenPrimitives.split_top_level_items(trimmed.slice(1), tokenizerOptions);
			var emitted_actual_item = false;
			for (let j = 0; j < continuation_items.length; j++) {
				if (append_select_item_lines(output, continuation_indent + ',', continuation_items[j], tokenizerOptions)) {
					emitted_actual_item = true;
				}
			}
			pending_leading_comma = separator_result.moved || !emitted_actual_item;
			continue;
		}

		if (in_select_list) {
			var marker_only = extract_leading_standalone_comment_markers(trimmed, tokenizerOptions);
			if (marker_only.markers.length > 0 && marker_only.remainder == '') {
				for (let j = 0; j < marker_only.markers.length; j++) {
					output.push(marker_only.markers[j]);
				}
				var next_trimmed = i + 1 < text_list.length ? text_list[i + 1].replace(/^\s+/ig, '') : '';
				pending_leading_comma = next_trimmed != ''
					&& !/^(WHEN|THEN|ELSE|END)\b/i.exec(next_trimmed)
					&& !/^,/.exec(next_trimmed)
					&& !is_select_block_end(next_trimmed, dialect);
				continue;
			}
		}

		if (in_select_list && is_select_block_end(trimmed, dialect)) {
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
			var line_parts = split_code_and_comment(text_list[i], dialect);
			var code = line_parts.code.replace(/\s+$/ig, '');
			var code_width = 0;
			var alignment_info = get_alignment_width_for_code(code, dialect);
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

function apply_trailing_comma_style(str, tokenizerOptions) {
	var text_final = '';
	var text_list = str.replace(/\n *\-\-/ig, " \-\-{}").split("\n");
	for (let i = 0; i < text_list.length; i++) {
		var this_line = text_list[i];
		var next_line = '';

		if (i + 1 <= text_list.length) {
			next_line = text_list[i + 1];
		}

		var comment_loc = get_first_comment_loc(this_line, tokenizerOptions);
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

function repair_orphan_leading_commas(str) {
	var text_list = String(str || '').split('\n');
	var removed = {};

	for (let i = 0; i < text_list.length; i++) {
		if (!/^\s*,$/.exec(text_list[i])) {
			continue;
		}

		var indent = text_list[i].match(/^\s*/)[0];

		for (let j = i + 1; j < text_list.length; j++) {
			var trimmed = text_list[j].replace(/^\s+/ig, '');

			if (trimmed == '') {
				continue;
			}

			if (/^--/.exec(trimmed)) {
				continue;
			}

			text_list[j] = indent + (/^,/.exec(trimmed) ? trimmed : ',' + trimmed);
			removed[i] = true;
			break;
		}
	}

	var output = [];
	for (let i = 0; i < text_list.length; i++) {
		if (!removed[i]) {
			output.push(text_list[i]);
		}
	}

	return output.join('\n');
}

exports.expand_tabs_for_width = expand_tabs_for_width;
exports.format_select_clause_lists = format_select_clause_lists;
exports.align_as_in_select_blocks = align_as_in_select_blocks;
exports.apply_trailing_comma_style = apply_trailing_comma_style;
exports.repair_orphan_leading_commas = repair_orphan_leading_commas;
