var sqlTokenizer = require('./sql-tokenizer');
var sqlStructure = require('./sql-structure');
var sqlLineModel = require('./sql-line-model');
var sqlFormatContext = require('./sql-format-context');
var sqlFormatUtils = require('./sql-format-utils');
var sqlCaseUtils = require('./sql-case-utils');
var expand_tabs_for_width = sqlFormatUtils.expand_tabs_for_width;
var repeat_space = sqlFormatUtils.repeat_space;
var get_case_balance_delta = sqlCaseUtils.get_case_balance_delta;
var find_top_level_as_loc = sqlCaseUtils.find_top_level_as_loc;
var get_alignment_width_for_code = sqlCaseUtils.get_alignment_width_for_code;

function split_code_and_comment(text) {
	return sqlStructure.split_code_and_comment(text);
}

function protect_standalone_comments(str, context) {
	var text_list = str.split("\n");
	for (let i = 0; i < text_list.length; i++) {
		if (/^\s*--/.exec(text_list[i])) {
			var comment_text = text_list[i].replace(/^\s*/, "").replace(/\s+$/ig, "");
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
		if (/^\s*--/.exec(text_list[i])) {
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

	for (var i = 0; i < comments.length; i++) {
		var marker = context.marker('standalone_comment', i);
		var pattern = new RegExp('\\s*' + sqlFormatContext.escape_regex(marker) + '\\s*', 'g');
		result = result.replace(pattern, function(match, offset, source) {
			var prefix = offset == 0 ? '' : '\n';
			var suffix = offset + match.length >= source.length ? '' : '\n';
			return prefix + comments[i] + suffix;
		});
	}

	return result;
}

//遍历替换逻辑

function normalize_line_comment_spacing(str) {
	var tokens = sqlTokenizer.tokenize(str);

	for (let i = 0; i < tokens.length; i++) {
		if (tokens[i].type == 'line_comment') {
			tokens[i].value = tokens[i].value.replace(/^--([^\s\-\n])/, "-- $1");
		}
	}

	return sqlTokenizer.join_tokens(tokens);
}

function order_comment(str, maxAlignWidth){
	var text_list = str.split("\n");
	var current_group_key = null;
	var current_group = [];
	var paren_depth = 0;
	var case_depth = 0;
	var in_select_block = false;
	var condition_group = '';
	var last_select_target_comment_loc = 0;

	function get_code_paren_delta(code) {
		var tokens = sqlTokenizer.tokenize(code);
		var delta = 0;

		for (let i = 0; i < tokens.length; i++) {
			if (tokens[i].type == 'punctuation' && tokens[i].value == '(') {
				delta += 1;
			} else if (tokens[i].type == 'punctuation' && tokens[i].value == ')') {
				delta -= 1;
			}
		}

		return delta;
	}

	function get_line_group_key(line_info, before_paren_depth, before_case_depth) {
		if (!line_info.hasTrailingComment) {
			return null;
		}

		var code = line_info.code.replace(/\s+$/ig, '');
		var trimmed = code.replace(/^\s+/ig, '');
		var line_case_delta = get_case_balance_delta(code);
		var line_starts_case = /^(CASE|WHEN|THEN|ELSE)\b/i.exec(trimmed);
		var line_is_case_end_alias = /^END\b/i.exec(trimmed) && find_top_level_as_loc(code) >= 0;

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
			var alignment_width = get_alignment_width_for_code(current_group[i].code).width;
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
			var item_alignment_width = get_alignment_width_for_code(item.code).width;
			if (item_alignment_width >= maxAlignWidth || target_comment_loc <= 0) {
				text_list[item.index] = sqlLineModel.rebuild_line(item.code, '-- ' + item.comment);
			} else {
				text_list[item.index] = item.code + repeat_space(target_comment_loc - item_visual_length) + '-- ' + item.comment;
			}
		}

		if (current_group_key == 'select') {
			last_select_target_comment_loc = target_comment_loc;
		}
		current_group = [];
		current_group_key = null;
	}

	for (let i = 0; i < text_list.length; i++){
		var line_info = sqlLineModel.from_text(text_list[i])[0];
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

		paren_depth += get_code_paren_delta(code);
		if (paren_depth < 0) {
			paren_depth = 0;
		}

		case_depth += get_case_balance_delta(code);
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
