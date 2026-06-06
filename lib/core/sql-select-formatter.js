var sqlTokenizer = require('./sql-tokenizer');
var sqlStructure = require('./sql-structure');
var sqlTokenPrimitives = require('./sql-token-primitives');
var sqlCaseUtils = require('./sql-case-utils');
var sqlFormatUtils = require('./sql-format-utils');
var sqlClauseRegistry = require('./sql-clause-registry');
var sqlFormatMutations = require('./sql-format-mutations');
var sqlFormatDocument = require('./sql-format-document');
var sqlScopeModel = require('./sql-scope-model');
var sqlFormatNodes = require('./sql-format-nodes');
var sqlKeywords = require('./sql-keywords');
var sqlGroupByExtension = require('./sql-group-by-extension');
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

function has_top_level_trailing_comma(code, tokenizerOptions) {
	var tokens = sqlTokenizer.tokenize(String(code || ''), tokenizerOptions);
	var paren_depth = 0;
	var bracket_depth = 0;
	var last_code_token = null;

	for (var i = 0; i < tokens.length; i++) {
		var token = tokens[i];
		if (token.type == 'whitespace' || token.type == 'newline') {
			continue;
		}

		if (token.type == 'punctuation' && token.value == '(') {
			paren_depth += 1;
		} else if (token.type == 'punctuation' && token.value == ')' && paren_depth > 0) {
			paren_depth -= 1;
		} else if (token.type == 'punctuation' && token.value == '[') {
			bracket_depth += 1;
		} else if (token.type == 'punctuation' && token.value == ']' && bracket_depth > 0) {
			bracket_depth -= 1;
		}

		last_code_token = {
			token: token,
			paren_depth: paren_depth,
			bracket_depth: bracket_depth
		};
	}

	return last_code_token != null
		&& last_code_token.token.type == 'punctuation'
		&& last_code_token.token.value == ','
		&& last_code_token.paren_depth == 0
		&& last_code_token.bracket_depth == 0;
}

function get_paren_delta(text, tokenizerOptions) {
	var parts = split_code_and_comment(text, tokenizerOptions);
	var tokens = sqlTokenizer.tokenize(parts.code, tokenizerOptions);
	var delta = 0;

	for (var i = 0; i < tokens.length; i++) {
		if (tokens[i].type == 'punctuation' && tokens[i].value == '(') {
			delta += 1;
		} else if (tokens[i].type == 'punctuation' && tokens[i].value == ')') {
			delta -= 1;
		}
	}

	return delta;
}

function move_top_level_separator_before_comment(line, tokenizerOptions) {
	var parts = split_code_and_comment(line, tokenizerOptions);
	var code = parts.code.replace(/\s+$/ig, '');
	var comment = parts.comment.replace(/^\s+|\s+$/g, '');

	if (comment == '' || !has_top_level_trailing_comma(code, tokenizerOptions)) {
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

function append_select_item_lines(lines, prefix, item_text, tokenizerOptions, comment_prefix) {
	var extracted = extract_leading_standalone_comment_markers(item_text, tokenizerOptions);

	for (let i = 0; i < extracted.markers.length; i++) {
		lines.push(String(comment_prefix || '') + extracted.markers[i]);
	}

	var normalized = normalize_select_item_text(extracted.remainder.replace(/^\s+/ig, '').replace(/\s+$/ig, ''));
	if (normalized == '') {
		return false;
	}

	lines.push(prefix + normalized);
	return true;
}

function append_split_select_items(lines, items, tokenizerOptions, get_prefix) {
	var emitted_count = 0;
	var pending_comma = false;

	for (let i = 0; i < items.length; i++) {
		var prefix = get_prefix(emitted_count);
		var comment_prefix = prefix.replace(/,$/, ' ');
		if (append_select_item_lines(lines, prefix, items[i], tokenizerOptions, comment_prefix)) {
			emitted_count += 1;
			pending_comma = false;
		} else if (i == items.length - 1 && emitted_count > 0) {
			pending_comma = true;
		}
	}

	return {
		emitted_count: emitted_count,
		pending_comma: pending_comma
	};
}

function next_code_token(tokens, index) {
	for (var i = index + 1; i < tokens.length; i++) {
		if (tokens[i].type != 'whitespace' && tokens[i].type != 'newline') {
			return tokens[i];
		}
	}

	return null;
}

function next_code_token_index(tokens, index) {
	for (var i = index + 1; i < tokens.length; i++) {
		if (tokens[i].type != 'whitespace' && tokens[i].type != 'newline') {
			return i;
		}
	}

	return -1;
}

function is_group_by_with_extension_start(text, tokenizerOptions) {
	var tokens = sqlTokenizer.tokenize(String(text || ''), tokenizerOptions);
	var first = null;
	var first_index = -1;

	for (var i = 0; i < tokens.length; i++) {
		if (tokens[i].type == 'whitespace' || tokens[i].type == 'newline') {
			continue;
		}
		first = tokens[i];
		first_index = i;
		break;
	}

	if (!first || first.type != 'word' || !/^WITH$/i.exec(first.value)) {
		return false;
	}

	var second_index = next_code_token_index(tokens, first_index);
	var second = second_index >= 0 ? tokens[second_index] : null;
	if (!second || second.type != 'word') {
		return false;
	}

	if (/^(CUBE|ROLLUP)$/i.exec(second.value)) {
		return true;
	}

	if (!/^GROUPING$/i.exec(second.value)) {
		return false;
	}

	var third = next_code_token(tokens, second_index);
	return third && third.type == 'word' && /^SETS$/i.exec(third.value);
}

function find_top_level_group_by_with_extension_loc(text, tokenizerOptions) {
	var source = String(text || '');
	var tokens = sqlTokenizer.tokenize(source, tokenizerOptions);
	var paren_depth = 0;
	var bracket_depth = 0;

	for (var i = 0; i < tokens.length; i++) {
		var token = tokens[i];

		if (token.type == 'punctuation' && token.value == '(') {
			paren_depth += 1;
			continue;
		}

		if (token.type == 'punctuation' && token.value == ')') {
			if (paren_depth > 0) {
				paren_depth -= 1;
			}
			continue;
		}

		if (token.type == 'punctuation' && token.value == '[') {
			bracket_depth += 1;
			continue;
		}

		if (token.type == 'punctuation' && token.value == ']') {
			if (bracket_depth > 0) {
				bracket_depth -= 1;
			}
			continue;
		}

		if (paren_depth != 0 || bracket_depth != 0) {
			continue;
		}

		if (token.type == 'word'
			&& /^WITH$/i.exec(token.value)
			&& is_group_by_with_extension_start(source.slice(token.start), tokenizerOptions)) {
			return token.start;
		}
	}

	return -1;
}

function append_group_by_with_extension_line(lines, extension_text, continuation_indent) {
	var normalized = normalize_select_item_text(String(extension_text || '').replace(/^\s+/ig, '').replace(/\s+$/ig, ''));
	if (normalized == '') {
		return false;
	}

	lines.push(continuation_indent + ' ' + normalized);
	return true;
}

function indent_nested_select_item_line(line, continuation_indent) {
	var trimmed = String(line || '').replace(/^\s+/ig, '');
	if (/^\)/.exec(trimmed)) {
		return continuation_indent + trimmed;
	}
	return continuation_indent + '    ' + trimmed;
}

function is_line_comment_only(text, tokenizerOptions) {
	var parts = split_code_and_comment(text, tokenizerOptions);
	return parts.code.replace(/^\s+|\s+$/g, '') == ''
		&& parts.comment.replace(/^\s+|\s+$/g, '') != '';
}

function format_select_clause_line_info(line, keyword, continuation_indent, tokenizerOptions, options) {
	var trimmed = line.replace(/^\s+/ig, '').replace(/\s+$/ig, '');
	var keyword_match = trimmed.match(new RegExp('^' + keyword.replace(/ /g, '\\s+') + '\\b', 'i'));

	if (keyword_match == null) {
		return {
			text: line,
			item_count: 0,
			pending_comma: false
		};
	}

	var remainder = trimmed.slice(keyword_match[0].length).replace(/^\s+/ig, '').replace(/\s+$/ig, '');
	if (remainder == '') {
		return {
			text: keyword,
			item_count: 0,
			pending_comma: false
		};
	}

	var extension_text = '';
	if (options && options.groupBy) {
		var extension_loc = find_top_level_group_by_with_extension_loc(remainder, tokenizerOptions);
		if (extension_loc >= 0) {
			extension_text = remainder.slice(extension_loc).replace(/^\s+/ig, '').replace(/\s+$/ig, '');
			remainder = remainder.slice(0, extension_loc).replace(/\s*,?\s*$/ig, '');
		}
	}

	if (is_line_comment_only(remainder, tokenizerOptions)) {
		return {
			text: keyword + ' ' + remainder,
			item_count: 0,
			pending_comma: false
		};
	}

	var items = sqlTokenPrimitives.split_top_level_items(remainder, tokenizerOptions);
	var lines = [];
	var append_result = append_split_select_items(lines, items, tokenizerOptions, function(emitted_count) {
		return emitted_count == 0 ? keyword + '  ' : continuation_indent + ',';
	});

	if (extension_text != '') {
		append_group_by_with_extension_line(lines, extension_text, continuation_indent);
	}

	if (append_result.emitted_count == 0) {
		if (lines.length > 0) {
			return {
				text: keyword + '\n' + lines.join('\n'),
				item_count: 0,
				pending_comma: false
			};
		}

		return {
			text: keyword,
			item_count: 0,
			pending_comma: false
		};
	}

	return {
		text: lines.join('\n'),
		item_count: append_result.emitted_count,
		pending_comma: append_result.pending_comma
	};
}

function should_treat_as_select_item_line(trimmed, dialect, case_depth) {
	return trimmed != ''
		&& case_depth == 0
		&& !/^,/.exec(trimmed)
		&& !/^(WHEN|THEN|ELSE|END)\b/i.exec(trimmed)
		&& !/^\)/.exec(trimmed)
		&& !is_select_block_end(trimmed, dialect);
}

function format_select_clause_lists(str, dialect) {
	var text_list = String(str || '').split('\n');
	var output = [];
	var in_select_list = false;
	var continuation_indent = '       ';
	var pending_leading_comma = false;
	var select_item_count = 0;
	var case_depth = 0;
	var select_paren_depth = 0;
	var tokenizerOptions = dialect;

	for (let i = 0; i < text_list.length; i++) {
		var separator_result = {
			line: text_list[i],
			moved: false
		};

		if (pending_leading_comma) {
			var pending_trimmed = text_list[i].replace(/^\s+/ig, '');
			var pending_extracted = extract_leading_standalone_comment_markers(pending_trimmed, tokenizerOptions);
			if (in_select_list
				&& pending_extracted.markers.length > 0
				&& pending_extracted.remainder == '') {
				// Preserve the pending comma for the next real select item line.
			} else if (in_select_list && should_treat_as_select_item_line(pending_trimmed, dialect, case_depth)) {
				text_list[i] = continuation_indent + ',' + pending_trimmed;
				pending_leading_comma = false;
			} else {
				pending_leading_comma = false;
			}
		}

		var trimmed = text_list[i].replace(/^\s+/ig, '');
		var line_case_delta = sqlCaseUtils.get_case_balance_delta(text_list[i], tokenizerOptions);

		function advance_select_state(line_for_parens) {
			case_depth += line_case_delta;
			if (case_depth < 0) {
				case_depth = 0;
			}
			if (in_select_list) {
				select_paren_depth += get_paren_delta(line_for_parens, tokenizerOptions);
				if (select_paren_depth < 0) {
					select_paren_depth = 0;
				}
			}
		}

		if (/^SELECT\b/i.exec(trimmed)) {
			separator_result = move_top_level_separator_before_comment(text_list[i], tokenizerOptions);
			text_list[i] = separator_result.line;
			trimmed = text_list[i].replace(/^\s+/ig, '');
			in_select_list = true;
			continuation_indent = '       ';
			select_item_count = 0;
			case_depth = 0;
			var select_result = format_select_clause_line_info(text_list[i], 'SELECT', '       ', tokenizerOptions);
			output.push(select_result.text);
			select_item_count += select_result.item_count;
			pending_leading_comma = select_item_count > 0 && (separator_result.moved || select_result.pending_comma);
			advance_select_state(text_list[i]);
			continue;
		}

		if (/^GROUP BY\b/i.exec(trimmed)) {
			separator_result = move_top_level_separator_before_comment(text_list[i], tokenizerOptions);
			text_list[i] = separator_result.line;
			trimmed = text_list[i].replace(/^\s+/ig, '');
			in_select_list = true;
			continuation_indent = '         ';
			select_item_count = 0;
			case_depth = 0;
			var group_result = format_select_clause_line_info(text_list[i], 'GROUP BY', '         ', tokenizerOptions, {
				groupBy: true
			});
			output.push(group_result.text);
			select_item_count += group_result.item_count;
			pending_leading_comma = select_item_count > 0 && (separator_result.moved || group_result.pending_comma);
			advance_select_state(text_list[i]);
			continue;
		}

		if (in_select_list && /^,/.exec(trimmed)) {
			separator_result = move_top_level_separator_before_comment(text_list[i], tokenizerOptions);
			text_list[i] = separator_result.line;
			trimmed = text_list[i].replace(/^\s+/ig, '');
			if (continuation_indent == '         ' && is_group_by_with_extension_start(trimmed.slice(1), tokenizerOptions)) {
				append_group_by_with_extension_line(output, trimmed.slice(1), continuation_indent);
				pending_leading_comma = false;
				advance_select_state(text_list[i]);
				continue;
			}

			var continuation_items = sqlTokenPrimitives.split_top_level_items(trimmed.slice(1), tokenizerOptions);
			var continuation_result = append_split_select_items(output, continuation_items, tokenizerOptions, function() {
				return continuation_indent + ',';
			});
			select_item_count += continuation_result.emitted_count;
			pending_leading_comma = select_item_count > 0
				&& (separator_result.moved || continuation_result.pending_comma || continuation_result.emitted_count == 0);
			advance_select_state(text_list[i]);
			continue;
		}

		if (in_select_list) {
			var marker_only = extract_leading_standalone_comment_markers(trimmed, tokenizerOptions);
			if (marker_only.markers.length > 0 && marker_only.remainder == '') {
				for (let j = 0; j < marker_only.markers.length; j++) {
					output.push(continuation_indent + marker_only.markers[j]);
				}
				advance_select_state(text_list[i]);
				continue;
			}
		}

		if (in_select_list && select_paren_depth > 0) {
			text_list[i] = indent_nested_select_item_line(text_list[i], continuation_indent);
			output.push(text_list[i]);
			pending_leading_comma = false;
			advance_select_state(text_list[i]);
			continue;
		}

		if (in_select_list && (/^\)/.exec(trimmed) || is_select_block_end(trimmed, dialect))) {
			in_select_list = false;
			select_item_count = 0;
			case_depth = 0;
			select_paren_depth = 0;
		}

		if (in_select_list && should_treat_as_select_item_line(trimmed, dialect, case_depth)) {
			separator_result = move_top_level_separator_before_comment(text_list[i], tokenizerOptions);
			text_list[i] = separator_result.line;
			trimmed = text_list[i].replace(/^\s+/ig, '');
			var item_items = sqlTokenPrimitives.split_top_level_items(trimmed, tokenizerOptions);
			var item_result = append_split_select_items(output, item_items, tokenizerOptions, function(emitted_count) {
				return select_item_count + emitted_count == 0 ? continuation_indent + ' ' : continuation_indent + ',';
			});
			if (item_result.emitted_count > 0) {
				select_item_count += item_result.emitted_count;
				pending_leading_comma = separator_result.moved || item_result.pending_comma;
				advance_select_state(text_list[i]);
				continue;
			}
		}

		output.push(text_list[i]);
		pending_leading_comma = in_select_list && select_item_count > 0 && separator_result.moved;
		advance_select_state(text_list[i]);
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

	function is_standalone_comment_marker_line(line) {
		return /^\s*\{SQLBEAUTIFY_standalone_comment_\d+_\d+\}\s*$/.test(String(line || ''));
	}

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

		if (in_block && current_item != null && !is_standalone_comment_marker_line(text_list[i])) {
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

function find_separator_node(nodes, separatorId) {
	for (var i = 0; i < (nodes.separators || []).length; i++) {
		if (nodes.separators[i].id == separatorId) {
			return nodes.separators[i];
		}
	}
	return null;
}

function is_structured_list_separator(separator) {
	return separator
		&& (separator.ownerKind == 'selectList' || separator.ownerKind == 'groupByList');
}

function find_select_span(nodes, ownerScopeId) {
	for (var i = 0; i < (nodes.selectSpans || []).length; i++) {
		if (nodes.selectSpans[i].id == ownerScopeId) {
			return nodes.selectSpans[i];
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

function case_scope_for_item(document, item) {
	for (var i = 0; i < (document.scopes || []).length; i++) {
		var scope = document.scopes[i];
		if (scope.kind == 'caseExpr'
			&& scope.startTokenIndex >= item.startTokenIndex
			&& scope.endTokenIndex <= item.endTokenIndex) {
			return scope;
		}
	}
	return null;
}

function case_node_for_item(nodes, item) {
	for (var i = 0; i < (nodes.caseExpressions || []).length; i++) {
		var caseNode = nodes.caseExpressions[i];
		if (caseNode.caseKeywordToken
			&& caseNode.caseKeywordToken.index >= item.startTokenIndex
			&& caseNode.caseKeywordToken.index <= item.endTokenIndex) {
			return caseNode;
		}
	}
	return null;
}

function tokens_between_same_line(document, startToken, endToken) {
	var result = [];
	if (!startToken || !endToken) {
		return result;
	}
	for (var i = startToken.index + 1; i < document.tokens.length; i++) {
		var token = document.tokens[i];
		if (!token || token.index >= endToken.index || token.line != startToken.line) {
			break;
		}
		if (token.isCode) {
			result.push(token);
		}
	}
	return result;
}

function token_inside_scope_kind(document, token, kind) {
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

function follows_window_order_by(document, tokens, index) {
	var token = tokens && tokens[index];
	if (!token || index < 2 || !token_inside_scope_kind(document, token, 'windowSpec')) {
		return false;
	}
	return tokens[index - 1]
		&& tokens[index - 2]
		&& tokens[index - 1].type == 'word'
		&& tokens[index - 1].value.toUpperCase() == 'BY'
		&& tokens[index - 2].type == 'word'
		&& tokens[index - 2].value.toUpperCase() == 'ORDER';
}

function token_scope_by_open_index(document, token) {
	var scopes = document && document.scopes ? document.scopes : [];
	for (var i = 0; i < scopes.length; i++) {
		if (scopes[i].openTokenIndex == token.index) {
			return scopes[i];
		}
	}
	return null;
}

function token_scope_by_close_index(document, token) {
	var scopes = document && document.scopes ? document.scopes : [];
	for (var i = 0; i < scopes.length; i++) {
		if (scopes[i].closeTokenIndex == token.index) {
			return scopes[i];
		}
	}
	return null;
}

function render_node_tokens_with_options(document, tokens, options, spacedScopeId) {
	var output = '';
	var useUpperKeywordCase = !options || options.keywordCase !== 'lower';
	for (var i = 0; i < (tokens || []).length; i++) {
		var token = tokens[i];
		if (!token) {
			continue;
		}
		var value = token.value;
		if (token.type == 'word' && sqlKeywords.is_keyword(value)) {
			value = useUpperKeywordCase ? value.toUpperCase() : value.toLowerCase();
		}
		if (output == '') {
			output = value;
		} else if (token.type == 'punctuation'
			&& (value == ',' || value == ';' || value == ']' || value == '.')) {
			output = output.replace(/[ \t]+$/g, '') + value;
		} else if (token.type == 'punctuation' && value == ')') {
			var closeScope = token_scope_by_close_index(document, token);
			var closePrefix = closeScope && closeScope.id == spacedScopeId ? ' ' : '';
			output = output.replace(/[ \t]+$/g, '') + closePrefix + value;
		} else if (token.type == 'punctuation' && token.value == '(') {
			var openScope = token_scope_by_open_index(document, token);
			var openSuffix = openScope && openScope.id == spacedScopeId ? ' ' : '';
			output = output.replace(/[ \t]+$/g, '') + value + openSuffix;
		} else if (token.type == 'number'
			&& i > 0
			&& tokens[i - 1]
			&& tokens[i - 1].type == 'operator'
			&& /^[+-]$/.test(tokens[i - 1].value)
			&& (i < 2
				|| tokens[i - 2].type == 'operator'
				|| (tokens[i - 2].type == 'word' && /^(THEN|ELSE|WHEN|IN|AND|OR|NOT|SELECT)$/i.exec(tokens[i - 2].value))
				|| (tokens[i - 2].type == 'punctuation' && /^(,|\(|\[)$/.test(tokens[i - 2].value)))) {
			output += value;
		} else if (follows_window_order_by(document, tokens, i)) {
			output += '  ' + value;
		} else if (/[\s(.,\[]$/.test(output)) {
			output += value;
		} else {
			output += ' ' + value;
		}
	}
	return output;
}

function render_node_tokens(document, tokens) {
	return render_node_tokens_with_options(document, tokens, null);
}

function structured_list_indent(document, nodes, ownerScopeId, ownerKind) {
	var span = find_select_span(nodes, ownerScopeId);
	var line = span ? document.lines[span.startLine] : null;
	var baseIndent = line ? String(line.raw || '').match(/^\s*/)[0] : '';
	var queryScope = span
		? sqlScopeModel.find_owner_scope(document.scopes || [], {
			line: span.startLine,
			tokenIndex: span.startTokenIndex
		}, 'query')
		: null;
	if (queryScope && queryScope.id != 0 && typeof queryScope.bodyIndent == 'string') {
		baseIndent = queryScope.bodyIndent;
	}
	return baseIndent + (ownerKind == 'groupByList' ? '         ' : '       ');
}

function item_indent(document, nodes, item) {
	var span = find_select_span(nodes, item.ownerScopeId);
	var line = span ? document.lines[span.startLine] : null;
	var baseIndent = line ? String(line.raw || '').match(/^\s*/)[0] : '';
	var queryScope = span
		? sqlScopeModel.find_owner_scope(document.scopes || [], {
			line: span.startLine,
			tokenIndex: span.startTokenIndex
		}, 'query')
		: null;
	if (queryScope && queryScope.id != 0 && typeof queryScope.bodyIndent == 'string') {
		baseIndent = queryScope.bodyIndent;
	}
	return item.id == 'selectItem:0'
		? baseIndent + (item.ownerKind == 'groupByList' ? 'GROUP BY  ' : 'SELECT  ')
		: structured_list_indent(document, nodes, item.ownerScopeId, item.ownerKind) + ',';
}

function token_inside_nested_scope(document, item, token) {
	for (var i = 0; i < (document.scopes || []).length; i++) {
		var scope = document.scopes[i];
		if (scope.kind != 'functionCall'
			&& scope.kind != 'inList'
			&& scope.kind != 'windowSpec'
			&& scope.kind != 'parenList') {
			continue;
		}
		if (token.index > scope.startTokenIndex && token.index < scope.endTokenIndex) {
			return true;
		}
	}
	return false;
}

function find_as_token(document, item) {
	var match = null;
	for (var i = 0; i < (item.tokens || []).length; i++) {
		if (item.tokens[i].type == 'word'
			&& item.tokens[i].value.toUpperCase() == 'AS'
			&& !token_inside_nested_scope(document, item, item.tokens[i])) {
			match = item.tokens[i];
		}
	}
	return match;
}

function effective_line_indent(document, mutations, lineIndex) {
	var lineIndent = mutations && mutations.lineIndents
		? mutations.lineIndents[String(lineIndex)]
		: null;
	if (lineIndent) {
		return lineIndent.indentText;
	}
	var line = document.lines[lineIndex];
	return line ? String(line.raw || '').match(/^\s*/)[0] : '';
}

function effective_token_line_indent(document, mutations, token) {
	var tokenMutation = token && mutations
		? sqlFormatMutations.get_for_token(mutations, token.id)
		: null;
	if (tokenMutation && tokenMutation.lineBreakBefore) {
		return tokenMutation.lineBreakBefore.indentText;
	}
	return effective_line_indent(document, mutations, token ? token.line : -1);
}

function rendered_item_width_before_as(document, nodes, item, mutations) {
	var asToken = find_as_token(document, item);
	var caseScope = case_scope_for_item(document, item);
	if (!asToken) {
		return 0;
	}
	if (caseScope && asToken.index > caseScope.endTokenIndex) {
		var caseNode = case_node_for_item(nodes, item);
		var endToken = caseNode && caseNode.endKeywordToken ? caseNode.endKeywordToken : null;
		var suffixTokens = endToken
			? [endToken].concat(tokens_between_same_line(document, endToken, asToken))
			: [];
		return effective_token_line_indent(document, mutations, endToken).length
			+ render_node_tokens(document, suffixTokens).length;
	}
	var functionScope = top_level_function_scope_for_item(document, item);
	if (functionScope
		&& typeof functionScope.closeTokenIndex == 'number'
		&& asToken.index > functionScope.closeTokenIndex
		&& asToken.line == functionScope.closeLine) {
		return effective_line_indent(document, mutations, functionScope.closeLine).length + ')'.length;
	}
	var width = item_indent(document, nodes, item).length;
	var beforeAsTokens = [];
	for (var i = 0; i < (item.tokens || []).length; i++) {
		var token = item.tokens[i];
		if (token.index >= asToken.index) {
			break;
		}
		if (token.line != item.startLine) {
			continue;
		}
		beforeAsTokens.push(token);
	}
	return width + render_node_tokens(document, beforeAsTokens).length;
}

function max_rendered_item_width_before_as(document, nodes, item, mutations) {
	var width = rendered_item_width_before_as(document, nodes, item, mutations);
	var caseScope = case_scope_for_item(document, item);
	var asToken = find_as_token(document, item);
	var caseNode = case_node_for_item(nodes, item);

	if (caseScope && asToken && asToken.index > caseScope.endTokenIndex) {
		var caseIndent = item_indent(document, nodes, item);
		var maxWidth = caseIndent.length + 'END'.length;
		for (var b = 0; b < (caseNode && caseNode.branches || []).length; b++) {
			var branch = caseNode.branches[b];
			var whenText = render_node_tokens(document, [branch.whenKeywordToken].concat(branch.whenTokens || []));
			var thenText = branch.thenKeywordToken
				? render_node_tokens(document, [branch.thenKeywordToken].concat(branch.thenTokens || []))
				: '';
			var branchText = whenText + (thenText != '' ? ' ' + thenText : '');
			var branchWidth = caseIndent.length + 4 + branchText.length;
			if (branchWidth > maxWidth) {
				maxWidth = branchWidth;
			}
		}
		if (caseNode && caseNode.elseKeywordToken) {
			var elseText = render_node_tokens(document, [caseNode.elseKeywordToken].concat(caseNode.elseTokens || []));
			var elseWidth = caseIndent.length + 4 + elseText.length;
			if (elseWidth > maxWidth) {
				maxWidth = elseWidth;
			}
		}
		return maxWidth;
	}

	return width;
}

function rendered_item_width_without_as(document, nodes, item) {
	return item_indent(document, nodes, item).length + render_node_tokens(document, item.tokens || []).length;
}

function existing_case_alias_target_width(document, item, asToken, width, mutations) {
	var caseScope = case_scope_for_item(document, item);
	if (!caseScope || !asToken || asToken.index <= caseScope.endTokenIndex) {
		return null;
	}

	var tokenMutation = sqlFormatMutations.get_for_token(mutations, asToken.id);
	if (!tokenMutation.spacingBefore) {
		return null;
	}

	return width + tokenMutation.spacingBefore.spacingText.length - 1;
}

function apply_select_as_alignment_mutations(document, nodes, mutations, config) {
	var maxAlignWidth = config && config.maxAlignWidth ? config.maxAlignWidth : 150;
	var groups = {};
	var groupOrder = [];

	for (var i = 0; i < (nodes.selectItems || []).length; i++) {
		var item = nodes.selectItems[i];
		var asToken = find_as_token(document, item);
		var key = String(item.ownerScopeId);
		if (item.tokens
			&& item.tokens.length > 0
			&& mutations.tokenReplacements[String(item.tokens[0].id)]
			&& mutations.tokenReplacements[String(item.tokens[0].id)].value != '') {
			groups[key] = groups[key] || [];
			if (groupOrder.indexOf(key) < 0) {
				groupOrder.push(key);
			}
			groups[key].push({
				item: item,
				asToken: null,
				width: 0,
				maxWidth: rendered_item_width_without_as(document, nodes, item)
			});
			continue;
		}
		if (!groups[key]) {
			groups[key] = [];
			groupOrder.push(key);
		}
		if (!asToken) {
			groups[key].push({
				item: item,
				asToken: null,
				width: 0,
				maxWidth: rendered_item_width_without_as(document, nodes, item)
			});
			continue;
		}
		var width = rendered_item_width_before_as(document, nodes, item, mutations);
		var maxWidth = max_rendered_item_width_before_as(document, nodes, item, mutations);
		var caseAliasTarget = existing_case_alias_target_width(document, item, asToken, width, mutations);
		if (caseAliasTarget != null) {
			maxWidth = caseAliasTarget;
		}

		groups[key].push({
			item: item,
			asToken: asToken,
			width: width,
			maxWidth: maxWidth
		});
	}

	for (var g = 0; g < groupOrder.length; g++) {
		var group = groups[groupOrder[g]];
		var target = 0;
		for (var w = 0; w < group.length; w++) {
			if (group[w].maxWidth > target && group[w].maxWidth < maxAlignWidth) {
				target = group[w].maxWidth;
			}
		}
		for (var a = 0; a < group.length; a++) {
			if (!group[a].asToken) {
				continue;
			}
			var spacing = target - group[a].width + 1;
			sqlFormatMutations.add_spacing_before_token(
				mutations,
				group[a].asToken.id,
				repeat_space(spacing < 1 ? 1 : spacing)
			);
		}
	}
}

function has_select_hint_line(document, item) {
	if (!document || !item || item.ownerKind != 'selectList') {
		return false;
	}

	var previousLine = document.lines[item.startLine - 1];
	if (!previousLine || !previousLine.hasTrailingComment || !/^--\+/.test(previousLine.commentText)) {
		return false;
	}

	return previousLine.codeTokens.length == 1
		&& previousLine.codeTokens[0].type == 'word'
		&& /^SELECT$/i.exec(previousLine.codeTokens[0].value);
}

function has_select_header_comment_line(document, nodes, item) {
	if (!document || !nodes || !item || item.ownerKind != 'selectList' || item.id != 'selectItem:0') {
		return false;
	}
	var span = find_select_span(nodes, item.ownerScopeId);
	if (!span || item.startLine <= span.startLine) {
		return false;
	}
	var line = document.lines[span.startLine];
	return line
		&& line.hasTrailingComment
		&& line.codeTokens.length == 1
		&& line.codeTokens[0].type == 'word'
		&& /^SELECT$/i.exec(line.codeTokens[0].value);
}

function apply_between_item_comment_indents(document, nodes, mutations, item, nextItem) {
	if (!nextItem || item.ownerScopeId != nextItem.ownerScopeId) {
		return;
	}
	if (nextItem.startLine <= item.endLine + 1) {
		return;
	}
	var indent = structured_list_indent(document, nodes, item.ownerScopeId, item.ownerKind);
	for (var lineIndex = item.endLine + 1; lineIndex < nextItem.startLine; lineIndex++) {
		var line = document.lines[lineIndex];
		if (line && line.isStandaloneComment) {
			sqlFormatMutations.add_line_indent(mutations, lineIndex, indent);
		}
	}
}

function token_inside_item(token, item) {
	return token
		&& item
		&& token.index >= item.startTokenIndex
		&& token.index <= item.endTokenIndex;
}

function top_level_function_scope_for_item(document, item, includeSingleLine) {
	for (var i = 0; i < (document.scopes || []).length; i++) {
		var scope = document.scopes[i];
		if (scope.kind != 'functionCall'
			|| scope.parentScopeId != 0) {
			continue;
		}
		if (!includeSingleLine && scope.openLine >= scope.closeLine) {
			continue;
		}

		var openToken = document.tokens[scope.openTokenIndex];
		var closeToken = document.tokens[scope.closeTokenIndex];
		if (token_inside_item(openToken, item) && token_inside_item(closeToken, item)) {
			return scope;
		}
	}
	return null;
}

function first_word_after_scope_close(document, scope, word) {
	if (!scope || typeof scope.closeTokenIndex != 'number') {
		return null;
	}

	var closeToken = document.tokens[scope.closeTokenIndex];
	if (!closeToken) {
		return null;
	}

	for (var i = closeToken.index + 1; i < document.tokens.length; i++) {
		var token = document.tokens[i];
		if (token.line != closeToken.line) {
			return null;
		}
		if (token.type == 'whitespace' || token.type == 'newline') {
			continue;
		}
		if (token.type == 'word' && token.value.toUpperCase() == word) {
			return token;
		}
	}
	return null;
}

function function_item_alias_spacing(document, nodes, mutations, item, itemIndent) {
	var maxWidth = 0;
	for (var i = 0; i < (nodes.selectItems || []).length; i++) {
		var other = nodes.selectItems[i];
		if (other.ownerScopeId != item.ownerScopeId || other.startLine >= item.startLine) {
			continue;
		}

		for (var tokenIndex = 0; tokenIndex < (other.tokens || []).length; tokenIndex++) {
			var token = other.tokens[tokenIndex];
			if (token.type != 'word' || token.value.toUpperCase() != 'AS') {
				continue;
			}

			var line = document.lines[token.line];
			var tokenMutation = sqlFormatMutations.get_for_token(mutations, token.id);
			var lineIndent = mutations.lineIndents[String(token.line)];
			var width;
			if (tokenMutation.spacingBefore) {
				var beforeAs = String(line.codeText || '').slice(0, token.column).replace(/\s+$/g, '');
				width = (lineIndent ? lineIndent.indentText.length : String(line.raw || '').match(/^\s*/)[0].length)
					+ beforeAs.replace(/^\s+/g, '').length
					+ tokenMutation.spacingBefore.spacingText.length;
			} else {
				width = token.column;
			}

			if (width > maxWidth) {
				maxWidth = width;
			}
			break;
		}
	}

	var beforeAsWidth = itemIndent.length + 1;
	var spacingWidth = maxWidth - beforeAsWidth;
	return repeat_space(spacingWidth < 1 ? 1 : spacingWidth);
}

function apply_multiline_function_item_mutations(document, nodes, mutations, item, config) {
	var scope = top_level_function_scope_for_item(document, item, true);
	if (!scope) {
		return;
	}

	var itemIndent = structured_list_indent(document, nodes, item.ownerScopeId, item.ownerKind);
	var collapsedText = render_node_tokens_with_options(document, item.tokens || [], config, scope.id);
	var collapsedWidth = itemIndent.length + 1 + collapsedText.length;
	var maxAlignWidth = config && config.maxAlignWidth
		? config.maxAlignWidth
		: 150;
	var originalCode = '';
	for (var lineIndexForCode = item.startLine; lineIndexForCode <= item.endLine; lineIndexForCode++) {
		originalCode += (lineIndexForCode == item.startLine ? '' : ' ')
			+ String(document.lines[lineIndexForCode] ? document.lines[lineIndexForCode].codeText : '').replace(/^\s+|\s+$/g, '');
	}
	var alreadyCollapsedWithOuterGap = scope.openLine == scope.closeLine
		&& /\(\s+/.test(originalCode)
		&& /\s+\)\s+AS\b/i.test(originalCode);

	if (collapsedWidth >= maxAlignWidth
		&& item.tokens
		&& item.tokens.length > 0
		&& (scope.openLine < scope.closeLine || alreadyCollapsedWithOuterGap)) {
		sqlFormatMutations.add_token_replacement(mutations, item.tokens[0].id, collapsedText);
		for (var tokenIndex = 1; tokenIndex < item.tokens.length; tokenIndex++) {
			sqlFormatMutations.add_token_omission(mutations, item.tokens[tokenIndex].id);
		}
		var endLine = document.lines[item.endLine];
		if (endLine && endLine.hasTrailingComment && item.endLine != item.startLine) {
			sqlFormatMutations.add_line_comment_move(mutations, item.endLine, item.startLine);
		}
		if (item.endLine > item.startLine) {
			for (var omittedLine = item.startLine + 1; omittedLine <= item.endLine; omittedLine++) {
				sqlFormatMutations.add_line_omission(mutations, omittedLine);
			}
		}
		return;
	}

	if (scope.openLine >= scope.closeLine) {
		return;
	}

	for (var lineIndex = scope.openLine + 1; lineIndex < scope.closeLine; lineIndex++) {
		sqlFormatMutations.add_line_indent(mutations, lineIndex, itemIndent + '    ');
	}
	sqlFormatMutations.add_line_indent(mutations, scope.closeLine, itemIndent);

	var asToken = first_word_after_scope_close(document, scope, 'AS');
	if (asToken) {
		sqlFormatMutations.add_spacing_before_token(
			mutations,
			asToken.id,
			function_item_alias_spacing(document, nodes, mutations, item, itemIndent)
		);
	}
}

	function line_starts_with_leading_separator(document, item) {
		var line = document && item ? document.lines[item.startLine] : null;
		return line && /^\s*,/.test(String(line.codeText || ''));
	}

	function select_span_by_id(nodes, ownerScopeId) {
		var spans = nodes && nodes.selectSpans ? nodes.selectSpans : [];
		for (var i = 0; i < spans.length; i++) {
			if (spans[i].id == ownerScopeId) {
				return spans[i];
			}
		}
		return null;
	}

	function is_first_item_in_owner(nodes, item) {
		var items = nodes && nodes.selectItems ? nodes.selectItems : [];
		for (var i = 0; i < items.length; i++) {
			if (items[i].ownerScopeId != item.ownerScopeId) {
				continue;
			}
			return items[i].id == item.id;
		}
		return false;
	}

	function should_join_select_header_first_item(document, nodes, item) {
		if (!item || item.ownerKind != 'selectList' || !is_first_item_in_owner(nodes, item)) {
			return false;
		}
		if (item.tokens
			&& item.tokens.length > 0
			&& item.tokens[0].type == 'word'
			&& item.tokens[0].value.toUpperCase() == 'CASE') {
			return false;
		}

		var span = select_span_by_id(nodes, item.ownerScopeId);
		var headerLine = span ? document.lines[span.startLine] : null;
		if (!headerLine
			|| headerLine.hasTrailingComment
			|| item.startLine != span.startLine + 1
			|| headerLine.codeTokens.length != 1
			|| headerLine.codeTokens[0].type != 'word'
			|| headerLine.codeTokens[0].value.toUpperCase() != 'SELECT') {
			return false;
		}

		return true;
	}

	function active_code_tokens(document) {
		var tokens = [];
		for (var i = 0; i < (document.tokens || []).length; i++) {
			if (document.tokens[i].isCode) {
				tokens.push(document.tokens[i]);
			}
		}
		return tokens;
	}

	function nearest_group_by_span_before_token(nodes, token) {
		var spans = nodes && nodes.selectSpans ? nodes.selectSpans : [];
		var match = null;

		for (var i = 0; i < spans.length; i++) {
			if (spans[i].kind != 'groupByList' || spans[i].endTokenIndex >= token.index) {
				continue;
			}
			if (!match || spans[i].endTokenIndex > match.endTokenIndex) {
				match = spans[i];
			}
		}

		return match;
	}

	function line_has_code_before_token_except(document, token, ignoredToken) {
		var line = token && document.lines[token.line];
		if (!line) {
			return false;
		}

		for (var i = 0; i < line.codeTokens.length; i++) {
			if (line.codeTokens[i].index >= token.index) {
				return false;
			}
			if (ignoredToken && line.codeTokens[i].id == ignoredToken.id) {
				continue;
			}
			return true;
		}

		return false;
	}

	function apply_group_by_extension_mutations(document, nodes, mutations) {
		var tokens = active_code_tokens(document);

		for (var i = 0; i < tokens.length; i++) {
			if (!sqlGroupByExtension.is_start(tokens, i)) {
				continue;
			}

			var token = tokens[i];
			var span = nearest_group_by_span_before_token(nodes, token);
			if (!span) {
				continue;
			}

			var previous = tokens[i - 1];
			var leadingComma = previous
				&& previous.type == 'punctuation'
				&& previous.value == ','
				? previous
				: null;
			var indent = structured_list_indent(document, nodes, span.id, span.kind) + ' ';

			if (leadingComma) {
				sqlFormatMutations.add_token_omission(mutations, leadingComma.id);
			}
			if (line_has_code_before_token_except(document, token, leadingComma)) {
				sqlFormatMutations.add_line_break_before_token(mutations, token.id, indent, '');
			} else {
				sqlFormatMutations.add_line_indent(mutations, token.line, indent);
			}
		}
	}

	function apply_select_list_mutations(document, nodes, mutations, config) {
	if (!document || !nodes || !mutations || !config || config.commaStyle != 'leading') {
		return;
	}

	for (var i = 0; i < (nodes.selectItems || []).length; i++) {
			var item = nodes.selectItems[i];
			var nextItem = nodes.selectItems[i + 1];
			if (should_join_select_header_first_item(document, nodes, item)) {
				sqlFormatMutations.add_line_join(mutations, item.startLine, '  ');
			}
			if (has_select_hint_line(document, item)) {
			sqlFormatMutations.add_line_indent(mutations, item.startLine, structured_list_indent(document, nodes, item.ownerScopeId, item.ownerKind) + ' ');
		}
		if (has_select_header_comment_line(document, nodes, item)) {
			sqlFormatMutations.add_line_indent(mutations, item.startLine, structured_list_indent(document, nodes, item.ownerScopeId, item.ownerKind) + ' ');
		}
		if (line_starts_with_leading_separator(document, item)) {
			sqlFormatMutations.add_line_indent(mutations, item.startLine, structured_list_indent(document, nodes, item.ownerScopeId, item.ownerKind));
		}
		apply_between_item_comment_indents(document, nodes, mutations, item, nextItem);
		apply_multiline_function_item_mutations(document, nodes, mutations, item, config);
		if (!item.separatorId) {
			continue;
		}

		var separator = find_separator_node(nodes, item.separatorId);
		var nextItem = nodes.selectItems[i + 1];
		if (!is_structured_list_separator(separator)
			|| !nextItem
			|| nextItem.ownerScopeId != item.ownerScopeId) {
			continue;
		}

		if (separator.line == nextItem.startLine) {
			var sameLine = document.lines[separator.line];
			var beforeSeparator = sameLine ? sameLine.raw.slice(0, separator.column).replace(/^\s+|\s+$/g, '') : '';
			if (beforeSeparator == '') {
				continue;
			}
			sqlFormatMutations.add_separator_move(mutations, separator.id, {
				placement: 'removed'
			});
			sqlFormatMutations.add_line_break_before_token(
				mutations,
				nextItem.tokens[0].id,
				structured_list_indent(document, nodes, item.ownerScopeId, separator.ownerKind),
				','
			);
		} else {
			var separatorLine = document.lines[separator.line];
			if (!separatorLine || !/,\s*$/.test(separatorLine.codeText)) {
				continue;
			}

			sqlFormatMutations.add_separator_move(mutations, separator.id, {
				lineIndex: nextItem.startLine,
				placement: 'linePrefix',
				text: ',',
				indentText: structured_list_indent(document, nodes, item.ownerScopeId, separator.ownerKind)
			});
		}
	}

	apply_group_by_extension_mutations(document, nodes, mutations);
	apply_select_as_alignment_mutations(document, nodes, mutations, config);
}

function split_same_line_select_separators(str, tokenizerOptions) {
	var document = sqlFormatDocument.from_text(str, tokenizerOptions);
	document.scopes = sqlScopeModel.build(document, tokenizerOptions);
	var nodes = sqlFormatNodes.extract(document, tokenizerOptions);
	var splitByLine = {};
	var separators = (nodes.separators || []).slice().sort(function(a, b) {
		return a.tokenIndex - b.tokenIndex;
	});

	for (var i = 0; i < separators.length; i++) {
		var separator = separators[i];
		if (separator.ownerKind != 'selectList' && separator.ownerKind != 'groupByList') {
			continue;
		}
		if (splitByLine[String(separator.line)]) {
			continue;
		}

		var line = document.lines[separator.line];
		var before = line.raw.slice(0, separator.column).replace(/\s+$/g, '');
		var after = line.raw.slice(separator.column + 1).replace(/^\s+/g, '');
		if (before.replace(/^\s+|\s+$/g, '') == '' || after.replace(/^\s+|\s+$/g, '') == '') {
			continue;
		}

		splitByLine[String(separator.line)] = {
			before: before,
			after: line.raw.match(/^\s*/)[0] + ',' + after
		};
	}

	if (Object.keys(splitByLine).length == 0) {
		return str;
	}

	var output = [];
	for (i = 0; i < document.lines.length; i++) {
		var split = splitByLine[String(i)];
		if (split) {
			output.push(split.before);
			output.push(split.after);
		} else {
			output.push(document.lines[i].raw);
		}
	}

	return output.join('\n');
}

exports.expand_tabs_for_width = expand_tabs_for_width;
exports.format_select_clause_lists = format_select_clause_lists;
exports.apply_select_list_mutations = apply_select_list_mutations;
exports.split_same_line_select_separators = split_same_line_select_separators;
exports.align_as_in_select_blocks = align_as_in_select_blocks;
exports.apply_trailing_comma_style = apply_trailing_comma_style;
exports.repair_orphan_leading_commas = repair_orphan_leading_commas;
