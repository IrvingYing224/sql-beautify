var sqlFormatMutations = require('./sql-format-mutations');
var sqlListLayoutPolicy = require('./sql-list-layout-policy');

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
		&& (separator.ownerKind == 'selectList'
			|| separator.ownerKind == 'groupByList'
			|| separator.ownerKind == 'orderByList');
}

function line_starts_with_leading_separator(document, item) {
	var line = document && item ? document.lines[item.startLine] : null;
	return line && /^\s*,/.test(String(line.codeText || ''));
}

function apply_first_item_spacing(document, nodes, mutations, item) {
	if (item.ownerKind != 'orderByList'
		|| !sqlListLayoutPolicy.is_first_item_in_owner(nodes, item)
		|| !item.tokens
		|| item.tokens.length == 0) {
		return;
	}
	sqlFormatMutations.add_spacing_before_token(mutations, item.tokens[0].id, '  ');
}

function apply_between_item_comment_indents(document, nodes, mutations, item, nextItem) {
	if (!nextItem || item.ownerScopeId != nextItem.ownerScopeId) {
		return;
	}
	if (nextItem.startLine <= item.endLine + 1) {
		return;
	}
	var indent = sqlListLayoutPolicy.structured_list_indent(document, nodes, item.ownerScopeId, item.ownerKind);
	for (var lineIndex = item.endLine + 1; lineIndex < nextItem.startLine; lineIndex++) {
		var line = document.lines[lineIndex];
		if (line && line.isStandaloneComment) {
			sqlFormatMutations.add_line_indent(mutations, lineIndex, indent);
		}
	}
}

function move_leading_comma_separator(document, nodes, mutations, item, nextItem) {
	if (!item.separatorId) {
		return;
	}

	var separator = find_separator_node(nodes, item.separatorId);
	if (!is_structured_list_separator(separator)
		|| !nextItem
		|| nextItem.ownerScopeId != item.ownerScopeId) {
		return;
	}

	if (separator.line == nextItem.startLine) {
		var sameLine = document.lines[separator.line];
		var beforeSeparator = sameLine ? sameLine.raw.slice(0, separator.column).replace(/^\s+|\s+$/g, '') : '';
		if (beforeSeparator == '') {
			return;
		}
		sqlFormatMutations.add_separator_move(mutations, separator.id, {
			placement: 'removed'
		});
		sqlFormatMutations.add_line_break_before_token(
			mutations,
			nextItem.tokens[0].id,
			sqlListLayoutPolicy.structured_list_indent(document, nodes, item.ownerScopeId, separator.ownerKind),
			','
		);
		return;
	}

	var separatorLine = document.lines[separator.line];
	if (!separatorLine || !/,\s*$/.test(separatorLine.codeText)) {
		return;
	}

	sqlFormatMutations.add_separator_move(mutations, separator.id, {
		lineIndex: nextItem.startLine,
		placement: 'linePrefix',
		text: ',',
		indentText: sqlListLayoutPolicy.structured_list_indent(document, nodes, item.ownerScopeId, separator.ownerKind)
	});
}

function apply_list_layout_mutations(document, nodes, mutations, config) {
	if (!document || !nodes || !mutations || !config || config.commaStyle != 'leading') {
		return;
	}

	for (var i = 0; i < (nodes.selectItems || []).length; i++) {
		var item = nodes.selectItems[i];
		var nextItem = nodes.selectItems[i + 1];
		apply_first_item_spacing(document, nodes, mutations, item);
		if (line_starts_with_leading_separator(document, item)) {
			sqlFormatMutations.add_line_indent(
				mutations,
				item.startLine,
				sqlListLayoutPolicy.structured_list_indent(document, nodes, item.ownerScopeId, item.ownerKind)
			);
		}
		apply_between_item_comment_indents(document, nodes, mutations, item, nextItem);
		move_leading_comma_separator(document, nodes, mutations, item, nextItem);
	}
}

exports.apply_list_layout_mutations = apply_list_layout_mutations;
