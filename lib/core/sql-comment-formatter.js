var sqlTokenizer = require('./sql-tokenizer');
var sqlStructure = require('./sql-structure');
var sqlLineModel = require('./sql-line-model');
var sqlFormatContext = require('./sql-format-context');
var sqlFormatUtils = require('./sql-format-utils');
var sqlCaseUtils = require('./sql-case-utils');
var sqlFormatModel = require('./sql-format-model');
var expand_tabs_for_width = sqlFormatUtils.expand_tabs_for_width;
var repeat_space = sqlFormatUtils.repeat_space;
var find_top_level_as_loc = sqlCaseUtils.find_top_level_as_loc;
var get_alignment_width_for_code = sqlCaseUtils.get_alignment_width_for_code;

function split_code_and_comment(text, tokenizer_options) {
	return sqlStructure.split_code_and_comment(text, tokenizer_options);
}

function protect_standalone_comments(str, context, tokenizer_options) {
	var text_list = str.split("\n");
	for (let i = 0; i < text_list.length; i++) {
		var line_info = sqlLineModel.from_text(text_list[i], tokenizer_options)[0];
		if (line_info.isStandaloneComment) {
			var comment_text = line_info.comment.replace(/\s+$/ig, "");
			text_list[i] = context.store('standalone_comment', comment_text);
		}
	}

	return {
		text: text_list.join("\n")
	};
}

function get_first_comment_loc(text, tokenizer_options) {
	var tokens = sqlTokenizer.tokenize(text, tokenizer_options);

	for (let i = 0; i < tokens.length; i++) {
		if (tokens[i].type == 'line_comment') {
			return tokens[i].start;
		}
	}

	return -1;
}

function protect_inline_comments(str, context, tokenizer_options) {
	var text_list = str.split("\n");
	for (let i = 0; i < text_list.length; i++) {
		var line_info = sqlLineModel.from_text(text_list[i], tokenizer_options)[0];
		if (line_info.isStandaloneComment) {
			continue;
		}

		var comment_loc = get_first_comment_loc(text_list[i], tokenizer_options);
		if (comment_loc >= 0) {
			text_list[i] = text_list[i].slice(0, comment_loc)
				+ "--"
				+ context.store('line_comment', text_list[i].slice(comment_loc).replace(/\s+$/ig, ""));
		}
	}
	return text_list.join("\n");
}

function restore_comments(str, context) {
	var result = String(str || '');
	var line_comments = context.stores.line_comment || [];
	var comments = context.stores.standalone_comment || [];

	for (var j = 0; j < line_comments.length; j++) {
		var line_marker = context.marker('line_comment', j);
		var line_pattern = new RegExp('--\\s*' + sqlFormatContext.escape_regex(line_marker), 'g');
		result = result.replace(line_pattern, line_comments[j]);
	}

	result = context.restore('line_comment', result);

	if (comments.length > 0) {
		var marker_regex = context.marker_regex('standalone_comment');
		var lines = result.split('\n');
		var restored_lines = [];

		for (var i = 0; i < lines.length; i++) {
			var line = lines[i];
			var cursor = 0;
			var matched = false;
			var match;

			marker_regex.lastIndex = 0;
			while ((match = marker_regex.exec(line)) != null) {
				matched = true;
				var before = line.slice(cursor, match.index).replace(/\s+$/ig, '');
				if (before.replace(/^\s+/ig, '') != '') {
					restored_lines.push(before);
				}

				restored_lines.push(comments[parseInt(match[1], 10)]);
				cursor = match.index + match[0].length;
			}

			if (!matched) {
				restored_lines.push(line);
				continue;
			}

			var tail = line.slice(cursor).replace(/\s+$/ig, '');
			if (tail.replace(/^\s+/ig, '') != '') {
				restored_lines.push(tail);
			}
		}

		result = restored_lines.join('\n');
	}

	return result;
}

//遍历替换逻辑

function normalize_line_comment_spacing(str, tokenizer_options) {
	var tokens = sqlTokenizer.tokenize(str, tokenizer_options);

	for (let i = 0; i < tokens.length; i++) {
		if (tokens[i].type == 'line_comment') {
			tokens[i].value = tokens[i].value.replace(/^--([^\s\-\n])/, "-- $1");
		}
	}

	return sqlTokenizer.join_tokens(tokens);
}

function order_comment(str, maxAlignWidth, tokenizer_options){
	var text_list = str.split("\n");
	var model = sqlFormatModel.from_text(str, tokenizer_options);
	var current_group_key = null;
	var current_group = [];
	var paren_depth = 0;
	var case_depth = 0;
	var in_select_block = false;
	var condition_group = '';
	var last_select_target_comment_loc = 0;

	function get_line_group_key(line_info, before_paren_depth, before_case_depth) {
		if (!line_info.hasTrailingComment) {
			return null;
		}

		var code = line_info.code.replace(/\s+$/ig, '');
		var trimmed = code.replace(/^\s+/ig, '');
		var line_case_delta = line_info.caseDelta;
		var line_starts_case = /^(CASE|WHEN|THEN|ELSE)\b/i.exec(trimmed);
		var line_is_case_end_alias = /^END\b/i.exec(trimmed) && find_top_level_as_loc(code, tokenizer_options) >= 0;

		if (condition_group != '' && /^END\b/i.exec(trimmed)) {
			return 'condition:' + condition_group;
		}

		if ((before_paren_depth > 0 || /\($/.exec(trimmed)) && before_case_depth > 0 && !line_is_case_end_alias && !/^\).*\bTHEN\b/i.exec(trimmed)) {
			return 'list:' + before_paren_depth + ':' + code.match(/^\s*/)[0].length;
		}

		if ((before_case_depth > 0 || line_case_delta != 0 || line_starts_case) && !line_is_case_end_alias) {
			return 'case:' + before_case_depth;
		}

		if (/^(ON|WHERE|HAVING)\b/i.exec(trimmed)) {
			condition_group = /^HAVING\b/i.exec(trimmed) ? 'having' : 'condition';
			return 'condition:' + condition_group;
		}

		if (/^(AND|OR)\b/i.exec(trimmed) && condition_group != '') {
			return 'condition:' + condition_group;
		}

		if (in_select_block) {
			return 'select';
		}

		if (before_paren_depth > 0 || /\($/.exec(trimmed)) {
			return 'list:' + before_paren_depth + ':' + code.match(/^\s*/)[0].length;
		}

		return 'default:' + line_info.index;
	}

	function flush_group() {
		if (current_group.length === 0) {
			return;
		}

		var target_comment_loc = 0;

		for (let i = 0; i < current_group.length; i++) {
			var visual_code_length = expand_tabs_for_width(current_group[i].code).length;
			var alignment_width = get_alignment_width_for_code(current_group[i].code, tokenizer_options).width;
			var min_gap = 1;
			if (alignment_width < maxAlignWidth && visual_code_length + min_gap > target_comment_loc) {
				target_comment_loc = visual_code_length + min_gap;
			}
		}

		if (current_group_key == 'condition:having' && last_select_target_comment_loc > target_comment_loc) {
			target_comment_loc = last_select_target_comment_loc;
		}

		for (let i = 0; i < current_group.length; i++) {
			var item = current_group[i];
			if (item.index < 0 || item.comment == null) {
				continue;
			}
			var item_visual_length = expand_tabs_for_width(item.code).length;
			var item_alignment_width = get_alignment_width_for_code(item.code, tokenizer_options).width;
			var original_comment = model.lines[item.index].comment;
			var comment_prefix = sqlLineModel.comment_prefix(original_comment);
			if (item_alignment_width >= maxAlignWidth || target_comment_loc <= 0) {
				text_list[item.index] = sqlLineModel.rebuild_line(item.code, comment_prefix + item.comment);
			} else {
				text_list[item.index] = item.code
					+ repeat_space(target_comment_loc - item_visual_length)
					+ comment_prefix
					+ item.comment;
			}
		}

		if (current_group_key == 'select') {
			last_select_target_comment_loc = target_comment_loc;
		}
		current_group = [];
		current_group_key = null;
	}

	for (let i = 0; i < text_list.length; i++){
		var line_info = model.lines[i];
		var code = line_info.code.replace(/\s+$/ig, '');
		var trimmed = code.replace(/^\s+/ig, '');
		var starts_new_select_block = /^SELECT\b/i.exec(trimmed) || /^GROUP BY\b/i.exec(trimmed);
		var ends_select_block = /^(FROM|WHERE|HAVING|ORDER BY|SORT BY|CLUSTER BY|LIMIT|DISTRIBUTE BY|UNION|JOIN|LEFT|RIGHT|FULL|INNER|CROSS|ON|WITH)\b/i.exec(trimmed)
			|| /^\)/.exec(trimmed);

		if (line_info.isBlank
			|| (line_info.isStandaloneComment && current_group_key != 'select' && !/^case:/.exec(current_group_key || ''))
			|| starts_new_select_block) {
			flush_group();
		}

		if (starts_new_select_block) {
			in_select_block = true;
			condition_group = '';
		} else if (ends_select_block) {
			in_select_block = false;
			if (!/^(WHERE|HAVING|ON)\b/i.exec(trimmed)) {
				condition_group = '';
			}
		}

		if (/^(ON|WHERE|HAVING)\b/i.exec(trimmed)) {
			condition_group = /^HAVING\b/i.exec(trimmed) ? 'having' : 'condition';
		}

		var group_key = get_line_group_key(line_info, paren_depth, case_depth);

		if (group_key == null) {
			if (line_info.isStandaloneComment && (current_group_key == 'select' || /^case:/.exec(current_group_key || ''))) {
				// Keep commented-out SQL lines from splitting the real SQL comment group.
			} else if (current_group_key == 'select' && in_select_block) {
				// Keep multi-line SELECT items from splitting the outer SELECT comment group.
			} else if (/^case:/.exec(current_group_key || '') && (case_depth > 0 || /^(CASE|WHEN|THEN|ELSE|END)\b/i.exec(trimmed))) {
				// Keep non-comment CASE structure lines inside the current CASE comment group.
				if (/^(WHEN|THEN|ELSE)\b/i.exec(trimmed)) {
					current_group.push({
						index: -1,
						code: code,
						comment: null
					});
				}
			} else if (!(current_group_key == 'condition:condition'
				&& /^(FROM|JOIN|LEFT|RIGHT|FULL|INNER|CROSS)\b/i.exec(trimmed))) {
				flush_group();
			}
		} else {
			if (current_group_key != null && current_group_key != group_key) {
				flush_group();
			}
			current_group_key = group_key;
			current_group.push({
				index: i,
				code: code,
				comment: sqlLineModel.comment_body(line_info.comment)
			});
		}

		paren_depth += line_info.parenDelta;
		if (paren_depth < 0) {
			paren_depth = 0;
		}

		case_depth += line_info.caseDelta;
		if (case_depth < 0) {
			case_depth = 0;
		}
	}

	flush_group();

	return text_list.join("\n") + "\n";
}

exports.protect_standalone_comments = protect_standalone_comments;
exports.protect_inline_comments = protect_inline_comments;
exports.restore_comments = restore_comments;
exports.get_first_comment_loc = get_first_comment_loc;
exports.normalize_line_comment_spacing = normalize_line_comment_spacing;
exports.order_comment = order_comment;
exports.split_code_and_comment = split_code_and_comment;
