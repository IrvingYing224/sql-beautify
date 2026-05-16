var sqlCaseUtils = require('./sql-case-utils');
var sqlFormatUtils = require('./sql-format-utils');
var sqlClauseRegistry = require('./sql-clause-registry');
var sqlTokenizer = require('./sql-tokenizer');
var expand_tabs_for_width = sqlFormatUtils.expand_tabs_for_width;
var repeat_space = sqlFormatUtils.repeat_space;
var get_case_balance_delta = sqlCaseUtils.get_case_balance_delta;

function find_root_case_start_loc(line, tokenizerOptions) {
	var tokens = sqlCaseUtils.get_case_tokens(line, tokenizerOptions);

	for (let i = 0; i < tokens.length; i++) {
		if (tokens[i].word == 'CASE' && tokens[i].depth == 1) {
			return tokens[i].start;
		}
	}

	return -1;
}

function is_condition_connector(token) {
	return token && token.type == 'word' && /^(AND|OR)$/i.exec(token.value);
}

function is_ignorable_token(token) {
	return token && (token.type == 'whitespace' || token.type == 'newline');
}

function append_token(output, token) {
	if (token.type == 'whitespace' || token.type == 'newline') {
		if (output !== '' && !/\s$/.test(output)) {
			return output + ' ';
		}
		return output;
	}

	if (token.type == 'punctuation' && /^[,.;)]$/.test(token.value)) {
		return output.replace(/[ \t]+$/g, '') + token.value;
	}

	if (token.type == 'punctuation' && token.value == '(') {
		var had_trailing_space = /[ \t]$/.test(output);
		var compact_output = output.replace(/[ \t]+$/g, '');
		if (/\b(AND|OR|NOT)$/i.exec(compact_output)) {
			return compact_output + ' (';
		}
		if (/\b(IN|EXISTS|IF)$/i.exec(compact_output) && had_trailing_space) {
			return compact_output + ' (';
		}
		return compact_output + token.value;
	}

	if (output !== '' && !/[\s(.]$/.test(output) && token.type != 'operator') {
		output += ' ';
	}

	return output + token.value;
}

function split_code_and_line_comment(tokens) {
	var code_tokens = [];
	var comment_tokens = [];
	var found_comment = false;

	for (var i = 0; i < tokens.length; i++) {
		if (!found_comment && tokens[i].type == 'line_comment') {
			found_comment = true;
		}

		if (found_comment) {
			comment_tokens.push(tokens[i]);
		} else {
			code_tokens.push(tokens[i]);
		}
	}

	return {
		codeTokens: code_tokens,
		commentTokens: comment_tokens
	};
}

function first_code_token(tokens) {
	for (var i = 0; i < tokens.length; i++) {
		if (!is_ignorable_token(tokens[i])) {
			return tokens[i];
		}
	}

	return null;
}

function render_condition_tokens(tokens) {
	var output = '';

	for (var i = 0; i < tokens.length; i++) {
		output = append_token(output, tokens[i]);
	}

	return output
		.replace(/\b(EXISTS|IF)\(/ig, '$1 (')
		.replace(/[ \t]+$/g, '');
}

function resolve_dialect_name(dialect) {
	return dialect && dialect.dialect ? dialect.dialect : (dialect || 'generic');
}

function split_condition_segments(tokens) {
	var segments = [];
	var current_segment = [];
	var paren_depth = 0;
	var case_depth = 0;
	var between_depth = 0;

	for (let i = 0; i < tokens.length; i++) {
		var token = tokens[i];

		if (token.type == 'punctuation' && token.value == '(') {
			paren_depth += 1;
		} else if (token.type == 'punctuation' && token.value == ')' && paren_depth > 0) {
			paren_depth -= 1;
		}

		if (token.type == 'word' && /^CASE$/i.exec(token.value)) {
			case_depth += 1;
		}

		if (token.type == 'word' && /^BETWEEN$/i.exec(token.value)) {
			between_depth += 1;
		}

		if (is_condition_connector(token)) {
			if (/^AND$/i.exec(token.value) && between_depth > 0) {
				between_depth -= 1;
			} else if (paren_depth == 0 && case_depth == 0 && first_code_token(current_segment) != null) {
				var rendered_segment = render_condition_tokens(current_segment);
				if (rendered_segment != '') {
					segments.push(current_segment);
				}
				current_segment = [];
			}
		}

		current_segment.push(token);

		if (token.type == 'word' && /^END$/i.exec(token.value) && case_depth > 0) {
			case_depth -= 1;
		}
	}

	if (render_condition_tokens(current_segment) != '') {
		segments.push(current_segment);
	}

	return segments;
}

function render_line_comment(tokens) {
	var comment = '';
	for (var i = 0; i < tokens.length; i++) {
		comment += tokens[i].value;
	}
	return comment.replace(/^\s+/g, '');
}

function wrap_condition_expression(text, tokenizerOptions) {
	var parts = split_code_and_line_comment(sqlTokenizer.tokenize(text, tokenizerOptions));
	var segments = split_condition_segments(parts.codeTokens);
	var comment = render_line_comment(parts.commentTokens);
	var lines = [];

	for (var i = 0; i < segments.length; i++) {
		var rendered = render_condition_tokens(segments[i]);
		if (rendered == '') {
			continue;
		}
		lines.push(rendered);
	}

	if (comment != '') {
		if (lines.length == 0) {
			lines.push(comment);
		} else {
			lines[lines.length - 1] += ' ' + comment;
		}
	}

	return lines.join('\n');
}

function is_condition_continuation_line(line, tokenizerOptions) {
	var token = first_code_token(sqlTokenizer.tokenize(line, tokenizerOptions));
	return is_condition_connector(token);
}

function resets_condition_block(trimmed, dialect) {
	return sqlClauseRegistry.resets_condition_alignment(trimmed, dialect)
		|| /^\)/.exec(trimmed)
		|| /^\($/.exec(trimmed);
}

function line_starts_condition_or_connector(line, dialect) {
	var trimmed = String(line || '').replace(/^\s+/g, '');
	return sqlClauseRegistry.get_condition_clause(trimmed, dialect) != null
		|| is_condition_continuation_line(trimmed, dialect);
}

function wrap_condition_clauses(str, dialect) {
	var text_list = String(str || '').split('\n');
	var output = [];
	var in_condition_block = false;
	var active_dialect = resolve_dialect_name(dialect);

	for (let i = 0; i < text_list.length; i++) {
		var trimmed = text_list[i].replace(/^\s+/ig, '');

		if (sqlClauseRegistry.get_condition_clause(trimmed, active_dialect) != null) {
			in_condition_block = true;
			output.push(wrap_condition_expression(text_list[i], dialect));
		} else if (in_condition_block && is_condition_continuation_line(text_list[i], dialect)) {
			output.push(wrap_condition_expression(text_list[i], dialect));
		} else {
			if (resets_condition_block(trimmed, active_dialect)) {
				in_condition_block = false;
			}
			output.push(text_list[i]);
		}
	}

	return output.join('\n');
}

function get_line_leading_indent(line) {
	var match = line.match(/^\s*/);
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

	return repeat_space(new_width) + rest;
}

function build_condition_line(prefix_indent, target_keyword_end, keyword, suffix_text) {
	var prefix_width = expand_tabs_for_width(prefix_indent).length;
	var indent_length = target_keyword_end - prefix_width - keyword.length;
	if (indent_length < 0) {
		indent_length = 0;
	}

	return prefix_indent + repeat_space(indent_length) + keyword + suffix_text;
}

function align_condition_clauses(str, dialect) {
	var final_text = "";
	var text_list = str.split("\n");
	var current_target_keyword_end = -1;
	var current_prefix_indent = '';
	var case_indent_delta = 0;
	var case_block_depth = 0;

	for (let i = 0; i < text_list.length; i++) {
		var sen = text_list[i];
		var should_shift_case_line = false;
		var before_case_loc = -1;
		var active_dialect = resolve_dialect_name(dialect);

		if (case_block_depth > 0) {
			should_shift_case_line = !line_starts_condition_or_connector(sen, active_dialect);
			if (should_shift_case_line) {
				sen = shift_line_leading_indent(sen, case_indent_delta);
			}
		}

		before_case_loc = find_root_case_start_loc(sen, dialect);
		var trimmed = sen.replace(/^\s+/ig, '');
		var clause_match = sqlClauseRegistry.get_condition_clause(trimmed, active_dialect);
		var condition_match = trimmed.match(/^(AND|OR)\b/i);
		var aligned_condition_line = false;
		var started_case_block = false;

		if (clause_match != null) {
			var keyword = trimmed.slice(0, clause_match.name.length);
			current_prefix_indent = get_line_leading_indent(sen);
			var prefix_width = expand_tabs_for_width(current_prefix_indent).length;
			if (/^ON$/i.exec(keyword) || /^QUALIFY$/i.exec(keyword)) {
				current_target_keyword_end = prefix_width + 7;
			} else {
				current_target_keyword_end = prefix_width + keyword.length;
			}

			sen = build_condition_line(
				current_prefix_indent,
				current_target_keyword_end,
				keyword,
				trimmed.slice(keyword.length)
			);
			aligned_condition_line = true;
		} else if (condition_match != null && current_target_keyword_end >= 0) {
			var condition_keyword = condition_match[1];
			sen = build_condition_line(
				current_prefix_indent,
				current_target_keyword_end,
				condition_keyword,
				trimmed.slice(condition_keyword.length)
			);
			aligned_condition_line = true;
		} else if (sqlClauseRegistry.resets_condition_alignment(trimmed, active_dialect)
			|| /^\)/.exec(trimmed)
			|| /^\($/.exec(trimmed)) {
			current_target_keyword_end = -1;
			current_prefix_indent = '';
		}

		if (aligned_condition_line) {
			var after_case_loc = find_root_case_start_loc(sen, dialect);
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

exports.wrap_condition_clauses = wrap_condition_clauses;
exports.align_condition_clauses = align_condition_clauses;
