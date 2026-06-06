var sqlTokenizer = require('./sql-tokenizer');
var sqlStructure = require('./sql-structure');
var sqlLineModel = require('./sql-line-model');
var sqlFormatContext = require('./sql-format-context');
var sqlFormatUtils = require('./sql-format-utils');
var sqlCaseUtils = require('./sql-case-utils');
var sqlFormatModel = require('./sql-format-model');
var sqlFormatMutations = require('./sql-format-mutations');
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
				var raw_before = line.slice(cursor, match.index);
				var before = raw_before.replace(/\s+$/ig, '');
				if (before.replace(/^\s+/ig, '') != '') {
					restored_lines.push(before);
				}

				var comment_indent = before == '' ? raw_before : '';
				restored_lines.push(comment_indent + comments[parseInt(match[1], 10)]);
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
			tokens[i].value = sqlLineModel.normalize_comment_marker(tokens[i].value);
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

		if (/^(SELECT|GROUP BY)$/i.exec(trimmed)) {
			return null;
		}

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

function apply_comment_alignment_mutations(document, nodes, mutations, config) {
	var maxAlignWidth = config && config.maxAlignWidth ? config.maxAlignWidth : 150;
	var group = [];
	var pendingSelectGroup = [];
	var conditionKeywords = {
		ON: true,
		WHERE: true,
		HAVING: true,
		QUALIFY: true
	};
	var movedSeparatorsByLine = {};
	var removedTokenIds = {};

	for (var moveIndex = 0; moveIndex < (mutations.separatorMoves || []).length; moveIndex++) {
		var move = mutations.separatorMoves[moveIndex];
		var separator = separator_node_for_id(move.separatorId);
		if (!separator) {
			continue;
		}
		removedTokenIds[String(separator.tokenId)] = true;
		if (move.target && move.target.placement == 'linePrefix' && move.target.lineIndex != null) {
			var lineKey = String(move.target.lineIndex);
			if (!movedSeparatorsByLine[lineKey]) {
				movedSeparatorsByLine[lineKey] = [];
			}
			movedSeparatorsByLine[lineKey].push(move);
		}
	}

	for (var tokenOmissionKey in mutations.tokenOmissions) {
		if (!Object.prototype.hasOwnProperty.call(mutations.tokenOmissions, tokenOmissionKey)) {
			continue;
		}
		removedTokenIds[String(mutations.tokenOmissions[tokenOmissionKey].tokenId)] = true;
	}

	function separator_node_for_id(separatorId) {
		var separators = nodes && nodes.separators ? nodes.separators : [];
		for (var i = 0; i < separators.length; i++) {
			if (separators[i].id == separatorId) {
				return separators[i];
			}
		}
		return null;
	}

	function planned_prefix_width(lineIndex) {
		var width = 0;
		var line = document.lines[lineIndex];
		var moves = movedSeparatorsByLine[String(lineIndex)] || [];
		for (var i = 0; i < moves.length; i++) {
			width += String(moves[i].target.text || '').length;
			if (i == 0 && typeof moves[i].target.indentText == 'string') {
				width += expand_tabs_for_width(moves[i].target.indentText).length
					- expand_tabs_for_width(line ? String(line.raw || '').match(/^\s*/)[0] : '').length;
			}
		}
		return width;
	}

	function normalized_token_value(token) {
		var tokenMutation = sqlFormatMutations.get_for_token(mutations, token.id);
		var value = tokenMutation && tokenMutation.replacement ? tokenMutation.replacement.value : token.value;
		if (token && token.type == 'operator') {
			var unary = /^(=|<>|!=|>=|<=|>|<)([+-])$/.exec(value);
			if (unary) {
				return unary[1] + ' ' + unary[2];
			}
			var arithmeticUnary = /^([*/%])([+-])$/.exec(value);
			if (arithmeticUnary) {
				return arithmeticUnary[1] + ' ' + arithmeticUnary[2];
			}
		}
		return value;
	}

	function original_gap_between(previousToken, token) {
		if (!previousToken || !token || previousToken.line != token.line) {
			return '';
		}
		return String(document.source || '').slice(previousToken.end, token.start);
	}

	function normalized_original_space(previousToken, token) {
		return /[ \t]/.test(original_gap_between(previousToken, token)) ? ' ' : '';
	}

	function is_word_token(token, value) {
		if (!token || token.type != 'word') {
			return false;
		}
		if (typeof value == 'undefined') {
			return true;
		}
		return token.value.toUpperCase() == value;
	}

	function previous_code_token(token) {
		if (!token) {
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

	function token_inside_scope_kind(token, kind) {
		var scopes = document && document.scopes ? document.scopes : [];
		for (var i = 0; i < scopes.length; i++) {
			if (scopes[i].kind == kind
				&& token.index >= scopes[i].startTokenIndex
				&& token.index <= scopes[i].endTokenIndex) {
				return true;
			}
		}
		return false;
	}

	function follows_window_order_by(previousToken, token) {
		if (!is_word_token(previousToken, 'BY')) {
			return false;
		}

		var beforeBy = previous_code_token(previousToken);
		return is_word_token(beforeBy, 'ORDER') && token_inside_scope_kind(token, 'windowSpec');
	}

	function rendered_code_text_for_width(line) {
		var output = '';
		var previousToken = null;
		var sawLineBreak = false;

		for (var i = 0; i < line.codeTokens.length; i++) {
			var token = line.codeTokens[i];
			if (removedTokenIds[String(token.id)]) {
				continue;
			}
			var tokenMutation = sqlFormatMutations.get_for_token(mutations, token.id);
			if (tokenMutation.omission) {
				continue;
			}
			var value = normalized_token_value(token);

			if (tokenMutation.lineBreakBefore) {
				output = output.replace(/[ \t]+$/g, '')
					+ '\n'
					+ tokenMutation.lineBreakBefore.indentText
					+ tokenMutation.lineBreakBefore.prefixText;
				previousToken = null;
				sawLineBreak = true;
			}

			if (tokenMutation.spacingBefore) {
				output = output.replace(/[ \t]+$/g, '') + tokenMutation.spacingBefore.spacingText;
			}

			if (token.type == 'punctuation') {
				if (value == ',' || value == ';' || value == ')' || value == ']' || value == '.') {
					output = output.replace(/[ \t]+$/g, '') + value;
				} else if (value == '(') {
					if (is_word_token(previousToken, 'OVER')) {
						output = output.replace(/[ \t]+$/g, '') + normalized_original_space(previousToken, token) + value;
					} else {
						output = output.replace(/[ \t]+$/g, '') + value;
					}
				} else if (/[ \t(.,\[]$/.test(output) || output == '') {
					output += value;
				} else {
					output += ' ' + value;
				}
			} else if (token.type == 'operator') {
				if (previousToken && previousToken.type == 'punctuation' && previousToken.value == '(' && value == '*') {
					output = output.replace(/[ \t]+$/g, '') + value;
				} else if (previousToken && previousToken.type == 'word' && previousToken.value.toUpperCase() == 'SELECT' && value == '*') {
					output = output.replace(/[ \t]+$/g, '') + '  ' + value;
				} else {
					output = output.replace(/[ \t]+$/g, '') + ' ' + value + ' ';
				}
			} else if (output == '' || /[ \t(.,\[]$/.test(output)) {
				output += value;
				} else if (previousToken && previousToken.type == 'word' && previousToken.value.toUpperCase() == 'SELECT') {
					output += '  ' + value;
				} else if (follows_window_order_by(previousToken, token)) {
					output += '  ' + value;
				} else {
					output += ' ' + value;
				}

			previousToken = token;
		}

		output = output.replace(/[ \t]+$/g, '');
		if (sawLineBreak) {
			var segments = output.split('\n');
			return {
				text: segments[segments.length - 1],
				includesIndent: true,
				segments: segments
			};
		}

		return {
			text: output,
			includesIndent: false,
			segments: [output]
		};
	}

	function planned_unjoined_code_width(line) {
		var rendered = rendered_code_text_for_width(line);
		var codeText = rendered.text;

		if (rendered.includesIndent) {
			if (is_case_branch_value_comment_line(line.index)) {
				return max_segment_width(rendered.segments);
			}
			return expand_tabs_for_width(codeText).length;
		}

		var indent = mutations.lineIndents[String(line.index)];
		if (indent) {
			return expand_tabs_for_width(indent.indentText).length
				+ expand_tabs_for_width(codeText).length;
		}

		return expand_tabs_for_width(String(line.raw || '').match(/^\s*/)[0]).length
			+ expand_tabs_for_width(codeText).length;
	}

	function planned_code_width(line) {
		var join = mutations.lineJoins[String(line.index)];

		if (join && line.index > 0) {
			var rendered = rendered_code_text_for_width(line);
			var previousText = planned_code_segment(document.lines[line.index - 1]).replace(/[ \t]+$/g, '');
			var currentText = rendered.text.replace(/^\s+/g, '');
			return expand_tabs_for_width(previousText).length
				+ String(join.separatorText || ' ').length
				+ expand_tabs_for_width(currentText).length;
		}

		var width = planned_unjoined_code_width(line);
		if (line.hasTrailingComment
			&& !line_has_line_break_mutation(line)
			&& line_inside_case_expr(line)) {
			var rawWidth = expand_tabs_for_width(String(line.codeText || '').replace(/[ \t]+$/g, '')).length;
			if (rawWidth > width) {
				width = rawWidth;
			}
		}
		return width;
	}

	function planned_join_prefix_width(line) {
		if (!mutations.lineJoins[String(line.index)]) {
			return 0;
		}
		return planned_code_width(line) - planned_unjoined_code_width(line);
	}

	function line_has_line_break_mutation(line) {
		for (var i = 0; i < (line.codeTokens || []).length; i++) {
			if (sqlFormatMutations.get_for_token(mutations, line.codeTokens[i].id).lineBreakBefore) {
				return true;
			}
		}
		return false;
	}

	function line_inside_case_expr(line) {
		for (var i = 0; i < (line.codeTokens || []).length; i++) {
			if (token_inside_scope_kind(line.codeTokens[i], 'caseExpr')) {
				return true;
			}
		}
		return false;
	}

	function planned_code_segment(line) {
		var rendered = rendered_code_text_for_width(line);
		if (rendered.includesIndent) {
			return rendered.text;
		}

		var indent = mutations.lineIndents[String(line.index)];
		if (indent) {
			return indent.indentText + rendered.text;
		}

		return String(line.raw || '').match(/^\s*/)[0] + rendered.text;
	}

	function planned_alignment_width(line) {
		var rendered = rendered_code_text_for_width(line);
		if (rendered.includesIndent) {
			if (is_case_branch_value_comment_line(line.index)) {
				return max_segment_alignment_width(rendered.segments);
			}
			return get_alignment_width_for_code(rendered.text, document.tokenizerOptions).width;
		}

		return get_alignment_width_for_code(planned_code_segment(line), document.tokenizerOptions).width;
	}

	function max_segment_width(segments) {
		var width = 0;
		for (var i = 0; i < (segments || []).length; i++) {
			var segmentWidth = expand_tabs_for_width(segments[i]).length;
			if (segmentWidth > width) {
				width = segmentWidth;
			}
		}
		return width;
	}

	function max_segment_alignment_width(segments) {
		var width = 0;
		for (var i = 0; i < (segments || []).length; i++) {
			var segmentWidth = get_alignment_width_for_code(segments[i], document.tokenizerOptions).width;
			if (segmentWidth > width) {
				width = segmentWidth;
			}
		}
		return width;
	}

	function is_condition_keyword_only_comment_line(line) {
		if (!line.hasTrailingComment || line.codeTokens.length != 1) {
			return false;
		}

		var token = line.codeTokens[0];
		return token.type == 'word' && conditionKeywords[token.value.toUpperCase()] === true;
	}

	function is_select_header_comment_line(line) {
		if (!line.hasTrailingComment || line.codeTokens.length != 1) {
			return false;
		}

		var token = line.codeTokens[0];
		return token.type == 'word' && /^(SELECT|GROUP)$/i.exec(token.value);
	}

	function is_close_only_comment_line(line) {
		if (!line.hasTrailingComment || line.codeTokens.length != 1) {
			return false;
		}

		return line.codeTokens[0].type == 'punctuation' && line.codeTokens[0].value == ')';
	}

	function is_parenthesized_scope_body_line(lineIndex) {
		var scopes = document.scopes || [];

		for (var i = 0; i < scopes.length; i++) {
			var scope = scopes[i];
			if (scope.kind != 'inList'
				&& scope.kind != 'functionCall'
				&& scope.kind != 'parenList'
				&& scope.kind != 'windowSpec') {
				continue;
			}

			if (typeof scope.openLine == 'number'
				&& typeof scope.closeLine == 'number'
				&& lineIndex > scope.openLine
				&& lineIndex < scope.closeLine) {
				if (scope.parentScopeId != null) {
					var parent = scopes[scope.parentScopeId];
					if (parent && parent.kind == 'caseExpr') {
						continue;
					}
					if (parent && parent.kind == 'query' && scope.kind == 'functionCall') {
						continue;
					}
				}
				return true;
			}
		}

		return false;
	}

		function is_query_function_open_comment_line(lineIndex) {
			var scopes = document.scopes || [];

		for (var i = 0; i < scopes.length; i++) {
			var scope = scopes[i];
			if (scope.kind == 'functionCall'
				&& scope.parentScopeId != null
				&& scopes[scope.parentScopeId]
				&& scopes[scope.parentScopeId].kind == 'query'
				&& scope.openLine == lineIndex
				&& scope.openLine < scope.closeLine) {
				return true;
			}
		}

			return false;
		}

	function is_condition_bare_continuation_line(lineIndex) {
		var blocks = nodes && nodes.conditionBlocks ? nodes.conditionBlocks : [];
		for (var i = 0; i < blocks.length; i++) {
				for (var c = 0; c < (blocks[i].continuationLines || []).length; c++) {
					if (blocks[i].continuationLines[c].lineIndex == lineIndex) {
						return true;
					}
				}
		}
		return false;
	}

	function is_join_bridge_line(line) {
		if (!line || line.hasTrailingComment || !line.codeText) {
			return false;
		}

		return /^\s*(JOIN|LEFT|RIGHT|FULL|INNER|CROSS|ON)\b/i.exec(line.codeText);
	}

	function condition_segment_keyword(lineIndex) {
		var blocks = nodes && nodes.conditionBlocks ? nodes.conditionBlocks : [];
		for (var i = 0; i < blocks.length; i++) {
			for (var s = 0; s < (blocks[i].segments || []).length; s++) {
				if (blocks[i].segments[s].lineIndex == lineIndex) {
					return blocks[i].keyword;
				}
			}
		}
		return '';
	}

	function is_condition_segment_line(lineIndex) {
		return condition_segment_keyword(lineIndex) != '';
	}

		function group_has_condition_comment() {
			for (var i = 0; i < group.length; i++) {
				if (is_condition_segment_line(group[i].index)) {
					return true;
				}
		}
		return false;
	}

	function is_select_item_line(lineIndex) {
		var items = nodes && nodes.selectItems ? nodes.selectItems : [];
		for (var i = 0; i < items.length; i++) {
			if (lineIndex >= items[i].startLine && lineIndex <= items[i].endLine) {
				return true;
			}
			}
			return false;
		}

		function token_after_case_end_on_same_line(caseNode, lineIndex, value) {
			if (!caseNode || !caseNode.endKeywordToken || caseNode.endKeywordToken.line != lineIndex) {
				return null;
			}

			var line = document.lines[lineIndex];
			for (var i = caseNode.endKeywordToken.index + 1; i < document.tokens.length; i++) {
				var token = document.tokens[i];
				if (!token || token.line != lineIndex) {
					break;
				}
				if (!token.isCode) {
					continue;
				}
				if (line && line.commentStart >= 0 && token.column >= line.commentStart) {
					break;
				}
				if (token.type == 'word' && token.value.toUpperCase() == value) {
					return token;
				}
			}

			return null;
		}

		function is_case_end_alias_comment_line(lineIndex) {
			var line = document.lines[lineIndex];
			if (!line || !line.hasTrailingComment) {
				return false;
			}

			var cases = nodes && nodes.caseExpressions ? nodes.caseExpressions : [];
			for (var i = 0; i < cases.length; i++) {
				if (token_after_case_end_on_same_line(cases[i], lineIndex, 'AS')) {
					return true;
				}
			}

			return false;
		}

		function is_case_branch_value_comment_line(lineIndex) {
			var line = document.lines[lineIndex];
			if (!line || !line.hasTrailingComment || is_case_end_alias_comment_line(lineIndex)) {
				return false;
			}

			var cases = nodes && nodes.caseExpressions ? nodes.caseExpressions : [];
			for (var i = 0; i < cases.length; i++) {
				var caseNode = cases[i];
				for (var b = 0; b < (caseNode.branches || []).length; b++) {
					var branch = caseNode.branches[b];
					if (branch.thenKeywordToken && branch.thenKeywordToken.line == lineIndex) {
						return true;
					}
				}
				if (caseNode.elseKeywordToken && caseNode.elseKeywordToken.line == lineIndex) {
					return true;
				}
			}

			return false;
		}

		function group_has_case_branch_value_comment() {
			for (var i = 0; i < group.length; i++) {
				if (is_case_branch_value_comment_line(group[i].index)) {
					return true;
				}
			}
			return false;
		}

		function line_index_inside_case_expression(lineIndex) {
			var cases = nodes && nodes.caseExpressions ? nodes.caseExpressions : [];
			for (var i = 0; i < cases.length; i++) {
				if (lineIndex >= cases[i].startLine && lineIndex <= cases[i].endLine) {
					return true;
				}
			}
			return false;
		}

			function group_has_select_item_comment() {
				for (var i = 0; i < group.length; i++) {
					if (is_select_item_line(group[i].index)) {
						return true;
				}
		}
		return false;
	}

	function current_group_is_select_only() {
		if (group.length == 0) {
			return false;
		}
		for (var i = 0; i < group.length; i++) {
			if (!is_select_item_line(group[i].index)) {
				return false;
			}
		}
		return true;
	}

	function group_can_bridge_clause_line() {
		return group_has_condition_comment();
	}

		function group_can_bridge_select_to_having(line) {
			return group_has_select_item_comment()
				&& line
				&& !line.hasTrailingComment
				&& /^\s*GROUP\s+BY\b/i.exec(line.codeText || '');
		}

		function is_standalone_comment_between_select_items(line) {
			if (!line || !line.isStandaloneComment || !group_has_select_item_comment()) {
				return false;
			}

			var items = nodes && nodes.selectItems ? nodes.selectItems : [];
			for (var i = 0; i < items.length; i++) {
				for (var j = 0; j < items.length; j++) {
					if (items[i].ownerScopeId == null
						|| items[i].ownerScopeId != items[j].ownerScopeId
						|| items[i].endLine >= line.index
						|| items[j].startLine <= line.index) {
						continue;
					}
					return true;
				}
			}

			return false;
		}

	function select_item_for_line(lineIndex) {
		var items = nodes && nodes.selectItems ? nodes.selectItems : [];
		for (var i = 0; i < items.length; i++) {
			if (lineIndex >= items[i].startLine && lineIndex <= items[i].endLine) {
				return items[i];
			}
		}
		return null;
	}

	function select_owner_for_line(lineIndex) {
		var item = select_item_for_line(lineIndex);
		return item ? item.ownerScopeId : null;
	}

	function pending_select_group_matches(lineIndex) {
		var ownerScopeId = select_owner_for_line(lineIndex);
		if (ownerScopeId == null || pendingSelectGroup.length == 0) {
			return false;
		}
		for (var i = 0; i < pendingSelectGroup.length; i++) {
			if (pendingSelectGroup[i].ownerScopeId != ownerScopeId) {
				return false;
			}
		}
		return true;
	}

	function collapsed_select_item_for_line(lineIndex) {
		var item = select_item_for_line(lineIndex);
		if (!item || !item.tokens || item.tokens.length == 0) {
			return null;
		}
		var firstTokenReplacement = mutations.tokenReplacements[String(item.tokens[0].id)];
		if (!firstTokenReplacement || firstTokenReplacement.value == '') {
			return null;
		}
		for (var i = 1; i < item.tokens.length; i++) {
			if (mutations.tokenOmissions[String(item.tokens[i].id)]) {
				return item;
			}
		}
		return null;
	}

	function is_collapsed_select_item_bridge_line(line) {
		return !!line
			&& !line.hasTrailingComment
			&& !!group_has_select_item_comment()
			&& !!collapsed_select_item_for_line(line.index);
	}

	function is_hive_hint_select_item_line(lineIndex) {
		var item = select_item_for_line(lineIndex);
		if (!item) {
			return false;
		}
		var spans = nodes && nodes.selectSpans ? nodes.selectSpans : [];
		for (var i = 0; i < spans.length; i++) {
			if (spans[i].id != item.ownerScopeId) {
				continue;
			}
			var headerLine = document.lines[spans[i].startLine];
			return headerLine && /^--\+/.test(String(headerLine.commentText || '').replace(/^\s+/g, ''));
		}
		return false;
	}

	function flush_group() {
		if (group.length == 0) {
			return;
		}

	if (current_group_is_select_only() && group.length > 1 && !group_has_case_branch_value_comment()) {
		pendingSelectGroup = group.slice();
	}

			var target = 0;
			for (var i = 0; i < group.length; i++) {
				if (group[i].alignmentWidth >= maxAlignWidth
					&& !is_case_end_alias_comment_line(group[i].index)) {
					continue;
				}
				var width = group[i].codeWidth + 1;
				if (width > target) {
					target = width;
				}
			}

			for (i = 0; i < group.length; i++) {
				if (target > 0
					&& group[i].alignmentWidth < maxAlignWidth
					&& !mutations.lineCommentMoves[String(group[i].index)]) {
					sqlFormatMutations.add_comment_alignment(mutations, group[i].index, target - group[i].joinPrefixWidth);
				}
			}
		group = [];
	}

		for (var i = 0; i < document.lines.length; i++) {
			var line = document.lines[i];
			var comment = String(line.commentText || '').replace(/^\s+/g, '');
			if (mutations.lineCommentMoves[String(line.index)]) {
				continue;
			}
		if (is_condition_keyword_only_comment_line(line)) {
			flush_group();
			continue;
		}
		if (is_select_header_comment_line(line)) {
			flush_group();
			continue;
		}
		if (is_close_only_comment_line(line)) {
			flush_group();
			continue;
		}
			if (is_query_function_open_comment_line(line.index)) {
				if (!is_collapsed_select_item_bridge_line(line)) {
					flush_group();
				}
				continue;
			}
			if (is_condition_bare_continuation_line(line.index)) {
				flush_group();
				continue;
			}
			if (is_parenthesized_scope_body_line(line.index)) {
				if (!is_collapsed_select_item_bridge_line(line)) {
					flush_group();
				}
				continue;
		}

			if (line.hasTrailingComment && !/^--\+/.test(comment)) {
				if (mutations.lineJoins[String(line.index)] && group.length > 0) {
					flush_group();
				}
				if (group_has_case_branch_value_comment() && is_case_end_alias_comment_line(line.index)) {
					flush_group();
				}
				if (group_has_select_item_comment()) {
					var keyword = condition_segment_keyword(line.index);
					if (keyword != '' && keyword != 'HAVING') {
					flush_group();
				}
			}
			if (condition_segment_keyword(line.index) == 'HAVING' && pendingSelectGroup.length > 0 && group.length == 0) {
				group = pendingSelectGroup.slice();
				pendingSelectGroup = [];
			}
				if (pendingSelectGroup.length > 0
					&& group.length == 0
					&& is_select_item_line(line.index)
					&& (select_item_for_line(line.index).startLine == line.index || is_case_end_alias_comment_line(line.index))
					&& (!line_index_inside_case_expression(line.index)
						|| (is_case_end_alias_comment_line(line.index) && planned_code_width(line) >= maxAlignWidth))) {
					if (pending_select_group_matches(line.index)) {
						group = pendingSelectGroup.slice();
					}
					pendingSelectGroup = [];
				}
			if (is_hive_hint_select_item_line(line.index)) {
				flush_group();
				continue;
			}
				group.push({
					index: line.index,
						codeWidth: planned_code_width(line),
						alignmentWidth: planned_alignment_width(line),
						joinPrefixWidth: planned_join_prefix_width(line),
						prefixWidth: planned_prefix_width(line.index),
						ownerScopeId: select_owner_for_line(line.index)
					});
				} else if (is_collapsed_select_item_bridge_line(line)
					|| is_standalone_comment_between_select_items(line)
					|| (line.isStandaloneComment && group_has_case_branch_value_comment() && line_index_inside_case_expression(line.index))
					|| (is_join_bridge_line(line) && group_can_bridge_clause_line())
					|| group_can_bridge_select_to_having(line)) {
				continue;
			} else {
			flush_group();
		}
	}

	flush_group();
}

exports.protect_standalone_comments = protect_standalone_comments;
exports.protect_inline_comments = protect_inline_comments;
exports.restore_comments = restore_comments;
exports.get_first_comment_loc = get_first_comment_loc;
exports.normalize_line_comment_spacing = normalize_line_comment_spacing;
exports.order_comment = order_comment;
exports.apply_comment_alignment_mutations = apply_comment_alignment_mutations;
exports.split_code_and_comment = split_code_and_comment;
