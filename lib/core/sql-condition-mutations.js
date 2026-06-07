var sqlFormatUtils = require('./sql-format-utils');
var sqlFormatMutations = require('./sql-format-mutations');
var sqlFormatNavigation = require('./sql-format-navigation');
var expand_tabs_for_width = sqlFormatUtils.expand_tabs_for_width;
var repeat_space = sqlFormatUtils.repeat_space;

function is_condition_connector(token) {
	return token && token.type == 'word' && /^(AND|OR)$/i.exec(token.value);
}

function get_line_leading_indent(line) {
	var match = line.match(/^\s*/);
	return match == null ? '' : match[0];
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

exports.apply_condition_mutations = apply_condition_mutations;
