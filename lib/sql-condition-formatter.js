var sqlCaseFormatter = require('./sql-case-formatter');
var sqlFormatUtils = require('./sql-format-utils');
sqlFormatUtils.install_string_times();
var expand_tabs_for_width = sqlFormatUtils.expand_tabs_for_width;
var get_case_balance_delta = sqlCaseFormatter.get_case_balance_delta;
var find_root_case_start_loc = sqlCaseFormatter.find_root_case_start_loc;

function condition_wrap(text) {
	var text_final = '';
	var if_cnt = 0;
    var if_bracket_cnt = 0;
    var bracket_cnt = 0;
	var case_depth = 0;
	var between_and_cnt = 0;
	var in_comment = false;
	text = text.replace('IF (', 'IF(').replace('IN (', 'IN(').replace('if (', 'IF(').replace('if(', 'IF(');
	var text_list = text.split(" ");

	for (let i = 0; i < text_list.length; i++) {
        let t = i;
        var last_str = i == 0 ? "" : text_list[i - 1];

		if (/^--/.exec(text_list[t])) {
			in_comment = true;
		}

		if (in_comment) {
			if (text_list[t].indexOf('\n') >= 0 || text_list[t].indexOf('shouldhavenbehind') >= 0) {
				in_comment = false;
			}
			continue;
		}

		if (/BETWEEN/.exec(text_list[t])) {
			between_and_cnt += 1;
		}

        // 如果and后面本身就跟着括号，等同于存在if(或者in
		if (/IF\(/.exec(text_list[t]) || /IN\(/.exec(text_list[t])) {
            if_cnt += 1;
		}

		if (/\(/.exec(text_list[t]) && if_cnt > 0 && text_list[t].indexOf('IF(') == -1 && text_list[t].indexOf('IN(') == -1) {
			if_bracket_cnt += 1;
		}

		if (/\)/.exec(text_list[t]) && if_cnt > 0 && if_bracket_cnt > 0) {
			if_bracket_cnt -= 1;
		}

		if (/\)/.exec(text_list[t]) && if_cnt > 0 && if_bracket_cnt == 0) {
			if_cnt -= 1;
        }

		for (let p = 0; p < text_list[t].length; p++) {
			if (/\(/.exec(text_list[t][p])){
				bracket_cnt += 1;
			}
			if (/\)/.exec(text_list[t][p])) {
				bracket_cnt -= 1;
			}
		}

		if (/^(AND|OR)$/i.exec(text_list[t])) {
			if (between_and_cnt == 0 && if_cnt == 0 && bracket_cnt == 0 && case_depth == 0) {
				text_list[t] = '\n' + text_list[t];
			}
			if (/^AND$/i.exec(text_list[t]) && between_and_cnt > 0) {
					between_and_cnt -= 1;
			}
			
		}

		case_depth += get_case_balance_delta(text_list[t]);
		if (case_depth < 0) {
			case_depth = 0;
		}

	}

	for (let i = 0; i < text_list.length; i++) {
		let v = i;
		text_final += text_list[v] + ' ';
		text_final = text_final.replace('IN(', 'IN (');
	}

	return text_final

};

function get_condition_leading_tabs(line) {
	var match = line.match(/^\t*/);
	return match == null ? '' : match[0];
}

function shift_line_leading_indent(line, delta) {
	if (delta == 0 || line == '') {
		return line;
	}

	var match = line.match(/^\s*/);
	var leading = match == null ? '' : match[0];
	var rest = line.slice(leading.length);
	var new_width = expand_tabs_for_width(leading).length + delta;

	if (new_width < 0) {
		new_width = 0;
	}

	return " ".times(new_width) + rest;
}

function build_condition_line(prefix_tabs, target_keyword_end, keyword, suffix_text) {
	var prefix_width = expand_tabs_for_width(prefix_tabs).length;
	var indent_length = target_keyword_end - prefix_width - keyword.length;
	if (indent_length < 0) {
		indent_length = 0;
	}

	return prefix_tabs + " ".times(indent_length) + keyword + suffix_text;
}

function align_condition_clauses(str) {
	var final_text = "";
	var text_list = str.split("\n");
	var current_target_keyword_end = -1;
	var current_prefix_tabs = '';
	var case_indent_delta = 0;
	var case_block_depth = 0;

	for (let i = 0; i < text_list.length; i++) {
		var sen = text_list[i];
		var should_shift_case_line = false;
		var before_case_loc = -1;

		if (case_block_depth > 0) {
			should_shift_case_line = !/^(ON|WHERE|HAVING|AND|OR)\b/i.exec(sen.replace(/^\s+/ig, ''));
			if (should_shift_case_line) {
				sen = shift_line_leading_indent(sen, case_indent_delta);
			}
		}

		before_case_loc = find_root_case_start_loc(sen);
		var trimmed = sen.replace(/^\s+/ig, '');
		var clause_match = trimmed.match(/^(ON|WHERE|HAVING)\b/i);
		var condition_match = trimmed.match(/^(AND|OR)\b/i);
		var aligned_condition_line = false;
		var started_case_block = false;

		if (clause_match != null) {
			var keyword = clause_match[1];
			current_prefix_tabs = get_condition_leading_tabs(sen);
			var prefix_width = expand_tabs_for_width(current_prefix_tabs).length;
			if (/^ON$/i.exec(keyword)) {
				current_target_keyword_end = prefix_width + 7;
			} else {
				current_target_keyword_end = prefix_width + keyword.length;
			}

			sen = build_condition_line(
				current_prefix_tabs,
				current_target_keyword_end,
				keyword,
				trimmed.slice(keyword.length)
			);
			aligned_condition_line = true;
		} else if (condition_match != null && current_target_keyword_end >= 0) {
			var condition_keyword = condition_match[1];
			sen = build_condition_line(
				current_prefix_tabs,
				current_target_keyword_end,
				condition_keyword,
				trimmed.slice(condition_keyword.length)
			);
			aligned_condition_line = true;
		} else if (/^(SELECT|FROM|JOIN|LEFT|RIGHT|FULL|INNER|CROSS|GROUP BY|ORDER BY|SORT BY|CLUSTER BY|LIMIT|DISTRIBUTE BY|UNION|WITH)\b/i.exec(trimmed)
			|| /^\)/.exec(trimmed)
			|| /^\($/.exec(trimmed)) {
			current_target_keyword_end = -1;
			current_prefix_tabs = '';
		}

		if (aligned_condition_line) {
			var after_case_loc = find_root_case_start_loc(sen);
			var line_case_delta = get_case_balance_delta(sen);
			if (after_case_loc >= 0 && line_case_delta > 0) {
				case_indent_delta = before_case_loc >= 0 ? after_case_loc - before_case_loc : 0;
				case_block_depth = line_case_delta;
				started_case_block = true;
			}
		}

		if (!started_case_block && case_block_depth > 0 && should_shift_case_line) {
			case_block_depth += get_case_balance_delta(sen);
			if (case_block_depth <= 0) {
				case_block_depth = 0;
				case_indent_delta = 0;
			}
		}

		if (sen != "") {
			final_text += sen + "\n";
		}
	}

	return final_text;
}

exports.condition_wrap = condition_wrap;
exports.align_condition_clauses = align_condition_clauses;
