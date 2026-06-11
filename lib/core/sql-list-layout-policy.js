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
	var queryScope = span
		? sqlScopeModel.find_owner_scope(document.scopes || [], {
			line: span.startLine,
			tokenIndex: span.startTokenIndex
		}, 'query')
		: null;
	if (queryScope && queryScope.id != 0 && typeof queryScope.bodyIndent == 'string') {
		baseIndent = queryScope.bodyIndent;
	}
	return baseIndent;
}

function structured_list_indent(document, nodes, ownerScopeId, ownerKind) {
	return list_base_indent(document, nodes, ownerScopeId) + repeat_space(continuation_width(ownerKind));
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

function item_indent(document, nodes, item) {
	var baseIndent = list_base_indent(document, nodes, item.ownerScopeId);
	return item.id == 'selectItem:0'
		? baseIndent + first_item_prefix(item.ownerKind)
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
	return item.id == 'selectItem:0'
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
