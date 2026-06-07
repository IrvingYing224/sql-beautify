var sqlCaseNodes = require('./sql-case-nodes');
var sqlConditionNodes = require('./sql-condition-nodes');
var sqlListNodes = require('./sql-list-nodes');
var sqlSelectItemNodes = require('./sql-select-item-nodes');

function create_list_spans(document, options) {
	return sqlListNodes.create_list_spans(document, options);
}

function find_separators(document, selectSpans) {
	return sqlListNodes.find_separators(document, selectSpans);
}

function find_select_items(document, selectSpans, separators) {
	return sqlSelectItemNodes.find_select_items(document, selectSpans, separators);
}

function find_case_expressions(document) {
	return sqlCaseNodes.find_case_expressions(document);
}

function find_condition_blocks(document) {
	return sqlConditionNodes.find_condition_blocks(document);
}

function extract(document, options) {
	if (!document.scopes) {
		document.scopes = [];
	}
	var selectSpans = create_list_spans(document, options);
	var separators = find_separators(document, selectSpans);
	var extracted = {
		selectItems: find_select_items(document, selectSpans, separators),
		caseExpressions: find_case_expressions(document),
		conditionBlocks: find_condition_blocks(document),
		separators: separators,
		selectSpans: selectSpans
	};
	document.nodes = extracted;
	return extracted;
}

exports.extract = extract;
exports.find_select_items = find_select_items;
exports.find_case_expressions = find_case_expressions;
exports.find_condition_blocks = find_condition_blocks;
exports.find_separators = find_separators;
