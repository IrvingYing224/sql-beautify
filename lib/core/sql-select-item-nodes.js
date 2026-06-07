var scopeModel = require('./sql-scope-model');
var sqlNodeUtils = require('./sql-node-utils');
var sqlListNodes = require('./sql-list-nodes');

var tokens_in_range = sqlNodeUtils.tokens_in_range;

function find_select_items(document, selectSpans, separators) {
	var spans = selectSpans || sqlListNodes.create_list_spans(document);
	var separatorList = separators || sqlListNodes.find_separators(document, spans);
	var items = [];

	function push_item(span, itemTokens, separatorId) {
		if (itemTokens.length == 0) {
			return;
		}
		items.push({
			id: 'selectItem:' + items.length,
			ownerScopeId: span.id,
			ownerKind: span.kind,
			startTokenIndex: itemTokens[0].index,
			endTokenIndex: itemTokens[itemTokens.length - 1].index,
			startLine: itemTokens[0].line,
			endLine: itemTokens[itemTokens.length - 1].line,
			tokens: itemTokens,
			separatorId: separatorId
		});
	}

	function push_line_split_items(span, itemTokens, separatorId) {
		if (itemTokens.length == 0) {
			return;
		}
		for (var n = 0; n < itemTokens.length; n++) {
			var owner = scopeModel.find_owner_scope(document.scopes || [], itemTokens[n], [
				'caseExpr',
				'functionCall',
				'inList',
				'parenList',
				'windowSpec'
			]);
			if (owner) {
				push_item(span, itemTokens, separatorId);
				return;
			}
		}
		var current = [];
		for (var t = 0; t < itemTokens.length; t++) {
			if (current.length > 0 && itemTokens[t].line != current[current.length - 1].line) {
				push_item(span, current, null);
				current = [];
			}
			current.push(itemTokens[t]);
		}
		push_item(span, current, separatorId);
	}

	for (var i = 0; i < spans.length; i++) {
		var span = spans[i];
		var start = span.startTokenIndex + 1;
		var selectSeparators = separatorList.filter(function(separator) {
			return separator.ownerScopeId == span.id;
		});

		for (var s = 0; s < selectSeparators.length; s++) {
			var separator = selectSeparators[s];
			var itemTokens = tokens_in_range(document, start, separator.tokenIndex - 1);
			push_line_split_items(span, itemTokens, separator.id);
			start = separator.tokenIndex + 1;
		}

		var trailingTokens = tokens_in_range(document, start, span.endTokenIndex);
		push_line_split_items(span, trailingTokens, null);
	}

	return items;
}

exports.find_select_items = find_select_items;
