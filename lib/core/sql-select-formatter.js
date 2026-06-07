var sqlTokenizer = require('./sql-tokenizer');
var sqlStructure = require('./sql-structure');
var sqlTokenPrimitives = require('./sql-token-primitives');
var sqlCaseUtils = require('./sql-case-utils');
var sqlFormatUtils = require('./sql-format-utils');
var sqlClauseRegistry = require('./sql-clause-registry');
var sqlSelectMutations = require('./sql-select-mutations');
var sqlFormatDocument = require('./sql-format-document');
var sqlScopeModel = require('./sql-scope-model');
var sqlFormatNodes = require('./sql-format-nodes');
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

function apply_select_list_mutations(document, nodes, mutations, config) {
	return sqlSelectMutations.apply_select_list_mutations(document, nodes, mutations, config);
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
