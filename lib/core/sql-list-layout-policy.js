var sqlFormatUtils = require('./sql-format-utils');
var sqlScopeModel = require('./sql-scope-model');

var repeat_space = sqlFormatUtils.repeat_space;

function find_list_span(nodes, ownerScopeId) {
	for (var i = 0; i < (nodes.selectSpans || []).length; i++) {
		if (nodes.selectSpans[i].id == ownerScopeId) {
			return nodes.selectSpans[i];
		}
	}
	return null;
}

function first_item_prefix(ownerKind) {
	if (ownerKind == 'groupByList') {
		return 'GROUP BY  ';
	}
	if (ownerKind == 'orderByList') {
		return 'ORDER BY  ';
	}
	return 'SELECT  ';
}

function continuation_width(ownerKind) {
	if (ownerKind == 'groupByList' || ownerKind == 'orderByList') {
		return 9;
	}
	return 7;
}

function list_base_indent(document, nodes, ownerScopeId) {
	var span = find_list_span(nodes, ownerScopeId);
	var line = span ? document.lines[span.startLine] : null;
	var baseIndent = line ? String(line.raw || '').match(/^\s*/)[0] : '';
	var queryScope = list_owner_query_scope(document, span);
	if (queryScope && queryScope.id != 0 && typeof queryScope.bodyIndent == 'string') {
		baseIndent = queryScope.bodyIndent;
	}
	return baseIndent;
}

function list_owner_query_scope(document, span) {
	return span
		? sqlScopeModel.find_owner_scope(document.scopes || [], {
			line: span.startLine,
			tokenIndex: span.startTokenIndex
		}, 'query')
		: null;
}

function structured_list_indent(document, nodes, ownerScopeId, ownerKind) {
	return list_base_indent(document, nodes, ownerScopeId) + repeat_space(continuation_width(ownerKind));
}

function is_first_item_in_owner(nodes, item) {
	if (!item) {
		return false;
	}
	if (typeof item.ordinalInOwner == 'number') {
		return item.ordinalInOwner == 0;
	}
	var items = nodes && nodes.selectItems ? nodes.selectItems : [];
	for (var i = 0; i < items.length; i++) {
		if (items[i].ownerScopeId != item.ownerScopeId) {
			continue;
		}
		return items[i].id == item.id;
	}
	return false;
}

function span_has_header_modifier(nodes, ownerScopeId) {
	var span = find_list_span(nodes, ownerScopeId);
	return !!(span && span.kind == 'selectList' && span.header && span.header.modifier);
}

function first_item_body_indent(document, nodes, item) {
	var baseIndent = list_base_indent(document, nodes, item.ownerScopeId);
	if (item.ownerKind == 'selectList' && span_has_header_modifier(nodes, item.ownerScopeId)) {
		return baseIndent + repeat_space(8);
	}
	return baseIndent + first_item_prefix(item.ownerKind);
}

function item_contains_nested_select_list(nodes, item) {
	var spans = nodes && nodes.selectSpans ? nodes.selectSpans : [];
	for (var i = 0; i < spans.length; i++) {
		if (spans[i].kind == 'selectList'
			&& spans[i].id != item.ownerScopeId
			&& spans[i].startTokenIndex >= item.startTokenIndex
			&& spans[i].endTokenIndex <= item.endTokenIndex) {
			return true;
		}
	}
	return false;
}

function is_root_select_list(document, nodes, item) {
	var span = find_list_span(nodes, item.ownerScopeId);
	var queryScope = list_owner_query_scope(document, span);
	return !queryScope || queryScope.id == 0;
}

function use_compact_first_case_indent(document, nodes, item) {
	return item.ownerKind == 'selectList'
		&& is_first_item_in_owner(nodes, item)
		&& is_root_select_list(document, nodes, item)
		&& !item_contains_nested_select_list(nodes, item)
		&& !span_has_header_modifier(nodes, item.ownerScopeId);
}

function item_indent(document, nodes, item) {
	return is_first_item_in_owner(nodes, item)
		? first_item_body_indent(document, nodes, item)
		: structured_list_indent(document, nodes, item.ownerScopeId, item.ownerKind) + ',';
}

function case_item_indent(document, nodes, item) {
	var baseIndent = list_base_indent(document, nodes, item.ownerScopeId);
	if (item.ownerKind == 'orderByList') {
		return baseIndent + repeat_space(10);
	}
	if (item.ownerKind == 'groupByList') {
		return baseIndent + repeat_space(9);
	}
	if (item.ownerKind == 'selectList' && span_has_header_modifier(nodes, item.ownerScopeId)) {
		return baseIndent + repeat_space(8);
	}
	return use_compact_first_case_indent(document, nodes, item)
		? baseIndent + repeat_space(7)
		: baseIndent + repeat_space(8);
}

exports.first_item_prefix = first_item_prefix;
exports.continuation_width = continuation_width;
exports.list_base_indent = list_base_indent;
exports.structured_list_indent = structured_list_indent;
exports.item_indent = item_indent;
exports.case_item_indent = case_item_indent;
exports.is_first_item_in_owner = is_first_item_in_owner;
