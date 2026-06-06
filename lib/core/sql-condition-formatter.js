var sqlCaseUtils = require('./sql-case-utils');
var sqlFormatUtils = require('./sql-format-utils');
var sqlClauseRegistry = require('./sql-clause-registry');
var sqlTokenizer = require('./sql-tokenizer');
var sqlFormatModel = require('./sql-format-model');
var sqlFormatMutations = require('./sql-format-mutations');
var sqlFormatNavigation = require('./sql-format-navigation');
var expand_tabs_for_width = sqlFormatUtils.expand_tabs_for_width;
var repeat_space = sqlFormatUtils.repeat_space;

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

	if (token.type == 'punctuation' && (token.value == '[' || token.value == ']')) {
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

	if (
		output !== ''
		&& !/[\s(.\[]$/.test(output)
		&& token.type != 'operator'
		&& !(
			/[+-]$/.test(output)
			&& (
				token.type == 'number'
				|| token.type == 'word'
				|| token.type == 'string_literal'
				|| token.type == 'quoted_identifier'
				|| token.type == 'placeholder'
				|| (token.type == 'punctuation' && token.value == '(')
			)
		)
	) {
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

function build_condition_value_line(prefix_indent, target_keyword_end, text) {
	var prefix_width = expand_tabs_for_width(prefix_indent).length;
	var indent_length = target_keyword_end - prefix_width + 1;
	if (indent_length < 0) {
		indent_length = 0;
	}

	return prefix_indent + repeat_space(indent_length) + text;
}

function build_condition_nested_line(prefix_indent, target_keyword_end, text) {
	var prefix_width = expand_tabs_for_width(prefix_indent).length;
	var indent_length = target_keyword_end - prefix_width - 3;
	if (indent_length < 0) {
		indent_length = 0;
	}

	return prefix_indent + repeat_space(indent_length) + text;
}

function get_line_leading_closers(tokens) {
	var first_code_seen = false;
	var leading_closers = 0;

	for (var i = 0; i < tokens.length; i++) {
		var token = tokens[i];
		if (token.type == 'whitespace' || token.type == 'newline') {
			continue;
		}

		if (token.type == 'punctuation' && token.value == ')' && !first_code_seen) {
			leading_closers += 1;
		}

		first_code_seen = true;
	}

	return leading_closers;
}

function is_bare_condition_continuation(trimmed, active_dialect) {
	return trimmed != ''
		&& !/^--/.exec(trimmed)
		&& !/^#/.exec(trimmed)
		&& !is_standalone_comment_marker_line(trimmed)
		&& !/^\)/.exec(trimmed)
		&& !/^\($/.exec(trimmed)
		&& !/^;/.exec(trimmed)
		&& !/^(CASE|WHEN|THEN|ELSE|END)\b/i.exec(trimmed)
		&& !sqlClauseRegistry.resets_condition_alignment(trimmed, active_dialect)
		&& sqlClauseRegistry.get_condition_clause(trimmed, active_dialect) == null;
}

function is_standalone_comment_marker_line(line) {
	return /^\s*\{SQLBEAUTIFY_standalone_comment_\d+_\d+\}\s*$/.test(String(line || ''));
}

function align_condition_clauses(str, dialect) {
	var text_list = str.split("\n");
	var model = sqlFormatModel.from_text(str, dialect);
	var output = [];
	var current_target_keyword_end = -1;
	var current_prefix_indent = '';
	var case_indent_delta = 0;
	var case_block_depth = 0;
	var condition_paren_depth = 0;
	var active_dialect = resolve_dialect_name(dialect);

	for (let i = 0; i < text_list.length; i++) {
		var sen = text_list[i];
		var should_shift_case_line = false;
		var before_case_loc = -1;
		var line_case_delta = model.lines[i].caseDelta;
		var leading_closers = get_line_leading_closers(model.lines[i].codeTokens);
		var before_condition_paren_depth = condition_paren_depth;
		if (leading_closers > 0) {
			before_condition_paren_depth -= leading_closers;
			if (before_condition_paren_depth < 0) {
				before_condition_paren_depth = 0;
			}
		}

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

		if (is_standalone_comment_marker_line(trimmed)) {
			if (current_target_keyword_end >= 0) {
				sen = trimmed;
			}
		} else if (clause_match != null) {
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
		} else if (condition_match != null && current_target_keyword_end >= 0 && before_condition_paren_depth == 0) {
			var condition_keyword = condition_match[1];
			sen = build_condition_line(
				current_prefix_indent,
				current_target_keyword_end,
				condition_keyword,
				trimmed.slice(condition_keyword.length)
			);
			aligned_condition_line = true;
		} else if (current_target_keyword_end >= 0
			&& /^\)/.exec(trimmed)
			&& condition_paren_depth > 0) {
			sen = build_condition_nested_line(
				current_prefix_indent,
				current_target_keyword_end,
				trimmed
			);
		} else if (current_target_keyword_end >= 0
			&& before_condition_paren_depth == 0
			&& is_bare_condition_continuation(trimmed, active_dialect)) {
			sen = build_condition_value_line(
				current_prefix_indent,
				current_target_keyword_end,
				trimmed
			);
		} else if (sqlClauseRegistry.resets_condition_alignment(trimmed, active_dialect)
			|| /^\)/.exec(trimmed)
			|| /^\($/.exec(trimmed)) {
			current_target_keyword_end = -1;
			current_prefix_indent = '';
			condition_paren_depth = 0;
		}

		if (aligned_condition_line) {
			var after_case_loc = find_root_case_start_loc(sen, dialect);
			if (after_case_loc >= 0 && line_case_delta > 0) {
				case_indent_delta = before_case_loc >= 0 ? after_case_loc - before_case_loc : 0;
				case_block_depth = line_case_delta;
				started_case_block = true;
			}
		}

		if (!started_case_block && case_block_depth > 0 && should_shift_case_line) {
			case_block_depth += line_case_delta;
			if (case_block_depth <= 0) {
				case_block_depth = 0;
				case_indent_delta = 0;
			}
		}

		if (sen != "") {
			output.push(sen);
		}

		if (current_target_keyword_end >= 0) {
			condition_paren_depth += model.lines[i].parenDelta;
			if (condition_paren_depth < 0) {
				condition_paren_depth = 0;
			}
		}
	}

	return output.length == 0 ? '' : output.join('\n') + '\n';
}

function suffix_after_prefix(value, prefix) {
	value = String(value || '');
	prefix = String(prefix || '');

	if (value.slice(0, prefix.length) == prefix) {
		return value.slice(prefix.length);
	}

	return '';
}

function line_indent_with_mutation(document, lineIndex, mutations) {
	var line = document.lines[lineIndex];
	var indent = line ? get_line_leading_indent(line.raw) : '';
	var mutation = mutations && mutations.lineIndents
		? mutations.lineIndents[String(lineIndex)]
		: null;

	return mutation ? mutation.indentText : indent;
}

function condition_target_keyword_end(block, document, mutations) {
	var prefix_indent = condition_base_indent(block, document, mutations);
	var prefix_width = expand_tabs_for_width(prefix_indent).length;

	if (/^(ON|QUALIFY)$/i.exec(block.keyword)) {
		return prefix_width + 7;
	}

	return prefix_width + String(block.keyword || '').length;
}

function condition_base_indent(block, document, mutations) {
	var line = document.lines[block.startLine];
	var lineIndent = line ? get_line_leading_indent(line.raw) : '';
	var scope = sqlFormatNavigation.scope_by_id(document, block.scopeId);
	var parent = scope ? sqlFormatNavigation.scope_by_id(document, scope.parentScopeId) : null;
	var parentIndent = '';

	if (parent && parent.kind == 'query' && typeof parent.bodyIndent == 'string') {
		parentIndent = line_indent_with_mutation(document, parent.openLine, mutations)
			+ suffix_after_prefix(parent.bodyIndent, parent.openIndent);
	}
	if (/^(ON|QUALIFY)$/i.exec(block.keyword || '')) {
		return parentIndent;
	}
	if (parentIndent != '') {
		return parentIndent;
	}

	return lineIndent;
}

function condition_clause_indent(block, document, mutations) {
	var prefix_indent = condition_base_indent(block, document, mutations);
	var prefix_width = expand_tabs_for_width(prefix_indent).length;
	var target = condition_target_keyword_end(block, document, mutations);
	var keyword_length = String(block.keyword || '').length;
	var width = target - prefix_width - keyword_length;

	if (width < 0) {
		width = 0;
	}

	return prefix_indent + repeat_space(width);
}

function condition_connector_indent(block, connector, document, mutations) {
	var prefix_indent = condition_base_indent(block, document, mutations);
	var prefix_width = expand_tabs_for_width(prefix_indent).length;
	var target = condition_target_keyword_end(block, document, mutations);
	var width = target - prefix_width - String(connector || '').length;

	if (width < 0) {
		width = 0;
	}

	return prefix_indent + repeat_space(width);
}

function condition_bare_indent(block, document, mutations) {
	var prefix_indent = condition_base_indent(block, document, mutations);
	var prefix_width = expand_tabs_for_width(prefix_indent).length;
	var target = condition_target_keyword_end(block, document, mutations);
	var width = target - prefix_width + 1;

	if (width < 0) {
		width = 0;
	}

	return prefix_indent + repeat_space(width);
}

function condition_close_indent(block, document, mutations) {
	var prefix_indent = condition_base_indent(block, document, mutations);
	var prefix_width = expand_tabs_for_width(prefix_indent).length;
	var target = condition_target_keyword_end(block, document, mutations);
	var width = target - prefix_width - 3;

	if (width < 0) {
		width = 0;
	}

	return prefix_indent + repeat_space(width);
}

function line_has_code_comma(line) {
	for (var i = 0; i < (line.codeTokens || []).length; i++) {
		if (line.codeTokens[i].type == 'punctuation' && line.codeTokens[i].value == ',') {
			return true;
		}
	}
	return false;
}

function line_has_code_after_token(document, lineIndex, tokenIndex) {
	for (var i = tokenIndex + 1; i < (document.tokens || []).length; i++) {
		var token = document.tokens[i];
		if (!token || token.line != lineIndex) {
			continue;
		}
		if (token.isCode) {
			return true;
		}
	}
	return false;
}

function should_join_hash_comment_inlist_first_value(document, scope) {
	if (!scope
		|| scope.kind != 'inList'
		|| typeof scope.openLine != 'number'
		|| typeof scope.closeLine != 'number'
		|| scope.openLine + 1 >= scope.closeLine) {
		return false;
	}

	var parent = sqlFormatNavigation.scope_by_id(document, scope.parentScopeId);
	var valueLine = document.lines[scope.openLine + 1];
	if (!parent
		|| parent.kind != 'conditionBlock'
		|| !valueLine
		|| !valueLine.hasTrailingComment
		|| !/^#/.test(valueLine.commentText)
		|| valueLine.codeTokens.length == 0
		|| line_has_code_comma(valueLine)
		|| is_condition_connector(valueLine.codeTokens[0])) {
		return false;
	}

	return !line_has_code_after_token(document, scope.openLine, scope.openTokenIndex);
}

function apply_condition_inlist_joins(document, mutations) {
	for (var i = 0; i < (document.scopes || []).length; i++) {
		var scope = document.scopes[i];
		if (should_join_hash_comment_inlist_first_value(document, scope)) {
			sqlFormatMutations.add_line_join(mutations, scope.openLine + 1, ' ');
		}
	}
}

function apply_condition_mutations(document, nodes, mutations, config) {
	if (!document || !nodes || !mutations) {
		return;
	}

	for (var i = 0; i < (nodes.conditionBlocks || []).length; i++) {
		var block = nodes.conditionBlocks[i];
		var clauseToken = block.segments
			&& block.segments[0]
			&& block.segments[0].tokens
			&& block.segments[0].tokens[0]
			? block.segments[0].tokens[0]
			: null;
		var clauseTokenMutation = clauseToken ? sqlFormatMutations.get_for_token(mutations, clauseToken.id) : null;

		if (!clauseTokenMutation || !clauseTokenMutation.lineBreakBefore) {
			sqlFormatMutations.add_line_indent(
				mutations,
				block.startLine,
				condition_clause_indent(block, document, mutations)
			);
		}

			for (var s = 0; s < (block.segments || []).length; s++) {
				var segment = block.segments[s];
				if (segment.kind != 'connector') {
					continue;
				}
				if (segment.lineIndex == block.startLine) {
					sqlFormatMutations.add_line_break_before_token(
						mutations,
						segment.tokens[0].id,
						condition_connector_indent(block, segment.connector, document, mutations),
						''
					);
				} else {
					sqlFormatMutations.add_line_indent(
						mutations,
						segment.lineIndex,
						condition_connector_indent(block, segment.connector, document, mutations)
					);
				}
			}

		for (var c = 0; c < (block.continuationLines || []).length; c++) {
			sqlFormatMutations.add_line_indent(
				mutations,
				block.continuationLines[c].lineIndex,
				condition_bare_indent(block, document, mutations)
			);
		}

		for (var q = 0; q < (block.closeLines || []).length; q++) {
			sqlFormatMutations.add_line_indent(
				mutations,
				block.closeLines[q].lineIndex,
				condition_close_indent(block, document, mutations)
			);
		}
	}

	apply_condition_inlist_joins(document, mutations);
}

exports.wrap_condition_clauses = wrap_condition_clauses;
exports.align_condition_clauses = align_condition_clauses;
exports.apply_condition_mutations = apply_condition_mutations;
