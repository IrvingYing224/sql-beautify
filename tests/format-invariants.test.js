var assert = require('assert');
var formatDocument = require('../lib/core/sql-format-document');
var nodes = require('../lib/core/sql-format-nodes');
var mutations = require('../lib/core/sql-format-mutations');
var invariants = require('../lib/core/sql-format-invariants');
var scopeModel = require('../lib/core/sql-scope-model');
var formatNavigation = require('../lib/core/sql-format-navigation');
var listLayoutPolicy = require('../lib/core/sql-list-layout-policy');

function extract_structured_nodes(sql, config) {
	config = Object.assign({ dialect: 'generic' }, config || {});
	var doc = formatDocument.from_text(sql, config);
	doc.scopes = scopeModel.build(doc, config);
	formatNavigation.attach_scope_index(doc);
	return nodes.extract(doc, config);
}

function build_structured_document(sql, config) {
	config = Object.assign({ dialect: 'generic' }, config || {});
	var doc = formatDocument.from_text(sql, config);
	doc.scopes = scopeModel.build(doc, config);
	formatNavigation.attach_scope_index(doc);
	doc.nodes = nodes.extract(doc, config);
	return doc;
}

function first_item_for_owner(extractedNodes, ownerKind) {
	for (var i = 0; i < (extractedNodes.selectItems || []).length; i++) {
		if (extractedNodes.selectItems[i].ownerKind == ownerKind) {
			return extractedNodes.selectItems[i];
		}
	}
	return null;
}

function token_values(tokens) {
	return (tokens || []).map(function(token) {
		return token.value;
	});
}

function token_values_for_owner(extractedNodes, ownerScopeId) {
	return (extractedNodes.selectItems || []).filter(function(item) {
		return item.ownerScopeId == ownerScopeId;
	}).map(function(item) {
		return token_values(item.tokens);
	});
}

function select_span_starting_on(extractedNodes, lineIndex) {
	for (var i = 0; i < (extractedNodes.selectSpans || []).length; i++) {
		if (extractedNodes.selectSpans[i].kind == 'selectList'
			&& extractedNodes.selectSpans[i].startLine == lineIndex) {
			return extractedNodes.selectSpans[i];
		}
	}
	return null;
}

var nodeShapeSql = [
	'select',
	'case when city_id in (',
	'1001, -- city one',
	'1002 -- city two',
	") then concat_ws(',', name, city)",
	"else 'unknown'",
	'end as city_label,',
	'sum(amount) over(partition by user_id order by ds) as total_amount',
	'from fact_orders',
	"where ds = '2026-06-07'",
	'and status between 1 and 3',
	'group by city_label, user_id'
].join('\n');

var nodeShape = extract_structured_nodes(nodeShapeSql);

assert.deepStrictEqual(
	nodeShape.selectSpans.map(function(span) {
		return {
			id: span.id,
			kind: span.kind,
			startLine: span.startLine,
			endLine: span.endLine
		};
	}),
	[
		{
			id: 'selectList:0',
			kind: 'selectList',
			startLine: 0,
			endLine: 7
		},
		{
			id: 'groupByList:1',
			kind: 'groupByList',
			startLine: 11,
			endLine: 11
		}
	],
	'node extractor must preserve select and group-by list spans'
);

assert.deepStrictEqual(
	nodeShape.separators.map(function(separator) {
		return {
			id: separator.id,
			ownerScopeId: separator.ownerScopeId,
			ownerKind: separator.ownerKind,
			line: separator.line
		};
	}),
	[
		{
			id: 'separator:0',
			ownerScopeId: 2,
			ownerKind: 'inList',
			line: 2
		},
		{
			id: 'separator:1',
			ownerScopeId: 3,
			ownerKind: 'functionCall',
			line: 4
		},
		{
			id: 'separator:2',
			ownerScopeId: 3,
			ownerKind: 'functionCall',
			line: 4
		},
		{
			id: 'separator:3',
			ownerScopeId: 'selectList:0',
			ownerKind: 'selectList',
			line: 6
		},
		{
			id: 'separator:4',
			ownerScopeId: 'groupByList:1',
			ownerKind: 'groupByList',
			line: 11
		}
	],
	'node extractor must preserve separator ownership and ID order'
);

assert.deepStrictEqual(
	nodeShape.selectItems.map(function(item) {
		return {
			id: item.id,
			ownerScopeId: item.ownerScopeId,
			ownerKind: item.ownerKind,
			startLine: item.startLine,
			endLine: item.endLine,
			separatorId: item.separatorId,
			tokens: token_values(item.tokens)
		};
	}),
	[
		{
			id: 'selectItem:0',
			ownerScopeId: 'selectList:0',
			ownerKind: 'selectList',
			startLine: 1,
			endLine: 6,
			separatorId: 'separator:3',
			tokens: [
				'case',
				'when',
				'city_id',
				'in',
				'(',
				'1001',
				',',
				'1002',
				')',
				'then',
				'concat_ws',
				'(',
				"','",
				',',
				'name',
				',',
				'city',
				')',
				'else',
				"'unknown'",
				'end',
				'as',
				'city_label'
			]
		},
		{
			id: 'selectItem:1',
			ownerScopeId: 'selectList:0',
			ownerKind: 'selectList',
			startLine: 7,
			endLine: 7,
			separatorId: null,
			tokens: [
				'sum',
				'(',
				'amount',
				')',
				'over',
				'(',
				'partition',
				'by',
				'user_id',
				'order',
				'by',
				'ds',
				')',
				'as',
				'total_amount'
			]
		},
		{
			id: 'selectItem:2',
			ownerScopeId: 'groupByList:1',
			ownerKind: 'groupByList',
			startLine: 11,
			endLine: 11,
			separatorId: 'separator:4',
			tokens: [
				'by',
				'city_label'
			]
		},
		{
			id: 'selectItem:3',
			ownerScopeId: 'groupByList:1',
			ownerKind: 'groupByList',
			startLine: 11,
			endLine: 11,
			separatorId: null,
			tokens: [
				'user_id'
			]
		}
	],
	'node extractor must preserve select item shape and token attribution'
);

var distinctShape = extract_structured_nodes('select distinct a, b from t');
var distinctSpan = select_span_starting_on(distinctShape, 0);

assert.ok(distinctSpan, 'SELECT DISTINCT span must be extracted');
assert.deepStrictEqual(
	{
		kind: distinctSpan.kind,
		modifierKind: distinctSpan.header && distinctSpan.header.modifier
			? distinctSpan.header.modifier.kind
			: null,
		itemsStartTokenIndex: distinctSpan.itemsStartTokenIndex
	},
	{
		kind: 'selectList',
		modifierKind: 'DISTINCT',
		itemsStartTokenIndex: 2
	},
	'SELECT DISTINCT must model DISTINCT as a span header modifier'
);
assert.deepStrictEqual(
	token_values_for_owner(distinctShape, distinctSpan.id),
	[
		['a'],
		['b']
	],
	'SELECT DISTINCT items must contain only real fields'
);
assert.deepStrictEqual(
	distinctShape.selectItems.filter(function(item) {
		return item.ownerScopeId == distinctSpan.id;
	}).map(function(item) {
		return item.ordinalInOwner;
	}),
	[0, 1],
	'SELECT DISTINCT items must have owner-local ordinals'
);
assert.ok(
	!distinctShape.selectItems.some(function(item) {
		return token_values(item.tokens).indexOf('distinct') >= 0;
	}),
	'DISTINCT must not be extracted as a select item token'
);

var allShape = extract_structured_nodes('select all a, b from t');
var allSpan = select_span_starting_on(allShape, 0);

assert.ok(allSpan, 'SELECT ALL span must be extracted');
assert.strictEqual(
	allSpan.header && allSpan.header.modifier && allSpan.header.modifier.kind,
	'ALL',
	'SELECT ALL must model ALL as a span header modifier'
);
assert.deepStrictEqual(
	token_values_for_owner(allShape, allSpan.id),
	[
		['a'],
		['b']
	],
	'SELECT ALL items must contain only real fields'
);

var countDistinctShape = extract_structured_nodes('select count(distinct a) as c from t');
var countDistinctSpan = select_span_starting_on(countDistinctShape, 0);

assert.ok(countDistinctSpan, 'COUNT(DISTINCT ...) select span must be extracted');
assert.strictEqual(
	countDistinctSpan.header && countDistinctSpan.header.modifier,
	null,
	'COUNT(DISTINCT ...) must not become a SELECT header modifier'
);
assert.deepStrictEqual(
	token_values_for_owner(countDistinctShape, countDistinctSpan.id),
	[
		['count', '(', 'distinct', 'a', ')', 'as', 'c']
	],
	'COUNT(DISTINCT ...) must remain inside the real select item'
);

assert.strictEqual(nodeShape.caseExpressions.length, 1, 'node shape fixture must extract one CASE expression');
assert.deepStrictEqual(
	{
		id: nodeShape.caseExpressions[0].id,
		startLine: nodeShape.caseExpressions[0].startLine,
		endLine: nodeShape.caseExpressions[0].endLine,
		caseKeyword: nodeShape.caseExpressions[0].caseKeywordToken.value,
		endKeyword: nodeShape.caseExpressions[0].endKeywordToken.value,
		whenTokens: token_values(nodeShape.caseExpressions[0].branches[0].whenTokens),
		thenTokens: token_values(nodeShape.caseExpressions[0].branches[0].thenTokens),
		elseKeyword: nodeShape.caseExpressions[0].elseKeywordToken.value,
		elseTokens: token_values(nodeShape.caseExpressions[0].elseTokens)
	},
	{
		id: 'caseExpr:0',
		startLine: 1,
		endLine: 6,
		caseKeyword: 'case',
		endKeyword: 'end',
		whenTokens: [
			'city_id',
			'in',
			'(',
			'1001',
			',',
			'1002',
			')'
		],
		thenTokens: [
			'concat_ws',
			'(',
			"','",
			',',
			'name',
			',',
			'city',
			')'
		],
		elseKeyword: 'else',
		elseTokens: [
			"'unknown'"
		]
	},
	'node extractor must preserve CASE branch token ownership'
);

assert.deepStrictEqual(
	nodeShape.conditionBlocks.map(function(block) {
		return {
			id: block.id,
			keyword: block.keyword,
			startLine: block.startLine,
			endLine: block.endLine,
			segments: block.segments.map(function(segment) {
				return {
					lineIndex: segment.lineIndex,
					kind: segment.kind,
					connector: segment.connector,
					tokens: token_values(segment.tokens)
				};
			}),
			continuationLines: block.continuationLines,
			closeLines: block.closeLines
		};
	}),
	[
		{
			id: 'conditionBlock:0',
			keyword: 'WHERE',
			startLine: 9,
			endLine: 10,
			segments: [
				{
					lineIndex: 9,
					kind: 'clause',
					connector: 'WHERE',
					tokens: [
						'where',
						'ds',
						'=',
						"'2026-06-07'"
					]
				},
				{
					lineIndex: 10,
					kind: 'connector',
					connector: 'AND',
					tokens: [
						'and',
						'status',
						'between',
						'1',
						'and',
						'3'
					]
				}
			],
			continuationLines: [],
			closeLines: []
		}
	],
	'node extractor must preserve condition block segment shape'
);

var sql = [
	'select',
	'case -- CASE comment',
	'when a = 1 -- condition comment',
	"then 'x' -- result comment",
	"else 'z'",
	'end as flag,',
	'coalesce(phone, -- phone',
	'email, -- email',
	"'unknown' -- fallback",
	') as contact',
	'from t'
].join('\n');

var doc = formatDocument.from_text(sql, { dialect: 'generic' });
doc.scopes = scopeModel.build(doc, { dialect: 'generic' });
var extracted = nodes.extract(doc, { dialect: 'generic' });

assert.ok(extracted.caseExpressions.length == 1, 'one case expression is extracted');
assert.strictEqual(extracted.caseExpressions[0].branches[0].whenComment, '-- condition comment');
assert.strictEqual(extracted.caseExpressions[0].branches[0].thenComment, '-- result comment');
assert.ok(extracted.selectItems.length >= 2, 'select items are extracted');
assert.ok(extracted.separators.every(function(separator) {
	return separator.ownerKind == 'selectList' || separator.ownerKind == 'functionCall';
}), 'separators are bound to owner scope');

assert.doesNotThrow(function() {
	invariants.assert_document_safe(doc, extracted);
});

var nestedSeparatorSql = [
	'select',
	"concat_ws(',', a, b) as c,",
	'case when x in (',
	'1, -- one',
	'2 -- two',
	') then y else z end as d',
	'from t'
].join('\n');

var nestedDoc = formatDocument.from_text(nestedSeparatorSql, { dialect: 'generic' });
nestedDoc.scopes = scopeModel.build(nestedDoc, { dialect: 'generic' });
var nestedNodes = nodes.extract(nestedDoc, { dialect: 'generic' });

assert.ok(nestedNodes.separators.some(function(separator) {
	return separator.ownerKind == 'functionCall';
}), 'function argument comma has functionCall owner');
assert.ok(nestedNodes.separators.some(function(separator) {
	return separator.ownerKind == 'inList';
}), 'IN-list comma has inList owner');
assert.ok(nestedNodes.separators.some(function(separator) {
	return separator.ownerKind == 'selectList';
}), 'select item comma has selectList owner');

var unsafeFunctionSeparator = nestedNodes.separators.filter(function(separator) {
	return separator.ownerKind == 'functionCall';
})[0];
var unsafeMutationPlan = mutations.create();
mutations.add_separator_move(unsafeMutationPlan, unsafeFunctionSeparator.id, {
	placement: 'linePrefix',
	lineIndex: unsafeFunctionSeparator.line + 1,
	text: ','
});

assert.throws(
	function() {
		invariants.assert_mutation_plan_safe(nestedDoc, nestedNodes, unsafeMutationPlan);
	},
	/functionCall/,
	'mutation invariants must reject moving function argument separators'
);

var unsafeCommentMoveSql = [
	'select',
	'a as a -- a comment',
	',b as b -- b comment',
	'from t'
].join('\n');
var unsafeCommentMoveDoc = formatDocument.from_text(unsafeCommentMoveSql, { dialect: 'generic' });
unsafeCommentMoveDoc.scopes = scopeModel.build(unsafeCommentMoveDoc, { dialect: 'generic' });
var unsafeCommentMoveNodes = nodes.extract(unsafeCommentMoveDoc, { dialect: 'generic' });
var unsafeCommentMovePlan = mutations.create();
mutations.add_line_comment_move(unsafeCommentMovePlan, 2, 1);

assert.throws(
	function() {
		invariants.assert_mutation_plan_safe(unsafeCommentMoveDoc, unsafeCommentMoveNodes, unsafeCommentMovePlan);
	},
	/comment move/,
	'mutation invariants must reject moving comments across select items'
);

function first_token_of_type(document, type) {
	for (var i = 0; i < document.tokens.length; i++) {
		if (document.tokens[i].type == type) {
			return document.tokens[i];
		}
	}
	return null;
}

var unsafeTokenMutationSql = [
	"select 'from where' as s -- comment from where",
	'from t'
].join('\n');
var unsafeTokenMutationDoc = formatDocument.from_text(unsafeTokenMutationSql, { dialect: 'generic' });
unsafeTokenMutationDoc.scopes = scopeModel.build(unsafeTokenMutationDoc, { dialect: 'generic' });
var unsafeTokenMutationNodes = nodes.extract(unsafeTokenMutationDoc, { dialect: 'generic' });
var unsafeSpacingPlan = mutations.create();
mutations.add_spacing_before_token(
	unsafeSpacingPlan,
	first_token_of_type(unsafeTokenMutationDoc, 'string_literal').id,
	' '
);

assert.throws(
	function() {
		invariants.assert_mutation_plan_safe(unsafeTokenMutationDoc, unsafeTokenMutationNodes, unsafeSpacingPlan);
	},
	/protected token/,
	'mutation invariants must reject spacing changes on string literals'
);

var unsafeLineBreakPlan = mutations.create();
mutations.add_line_break_before_token(
	unsafeLineBreakPlan,
	first_token_of_type(unsafeTokenMutationDoc, 'line_comment').id,
	'',
	''
);

assert.throws(
	function() {
		invariants.assert_mutation_plan_safe(unsafeTokenMutationDoc, unsafeTokenMutationNodes, unsafeLineBreakPlan);
	},
	/protected token/,
	'mutation invariants must reject line breaks before comments'
);

var unsafeWhitespaceSpacingPlan = mutations.create();
mutations.add_spacing_before_token(
	unsafeWhitespaceSpacingPlan,
	first_token_of_type(unsafeTokenMutationDoc, 'whitespace').id,
	' '
);

assert.throws(
	function() {
		invariants.assert_mutation_plan_safe(unsafeTokenMutationDoc, unsafeTokenMutationNodes, unsafeWhitespaceSpacingPlan);
	},
	/non-code token/,
	'mutation invariants must reject spacing changes on whitespace tokens'
);

var unsafeNewlineBreakPlan = mutations.create();
mutations.add_line_break_before_token(
	unsafeNewlineBreakPlan,
	first_token_of_type(unsafeTokenMutationDoc, 'newline').id,
	'',
	''
);

assert.throws(
	function() {
		invariants.assert_mutation_plan_safe(unsafeTokenMutationDoc, unsafeTokenMutationNodes, unsafeNewlineBreakPlan);
	},
	/non-code token/,
	'mutation invariants must reject line breaks before newline tokens'
);

var unsafeTokenOmissionPlan = mutations.create();
mutations.add_token_omission(
	unsafeTokenOmissionPlan,
	first_token_of_type(unsafeTokenMutationDoc, 'string_literal').id
);

assert.throws(
	function() {
		invariants.assert_mutation_plan_safe(unsafeTokenMutationDoc, unsafeTokenMutationNodes, unsafeTokenOmissionPlan);
	},
	/protected token/,
	'mutation invariants must reject omitting string literal tokens'
);

var unsafeCodeTokenOmissionPlan = mutations.create();
mutations.add_token_omission(
	unsafeCodeTokenOmissionPlan,
	first_token_of_type(unsafeTokenMutationDoc, 'word').id
);

assert.throws(
	function() {
		invariants.assert_mutation_plan_safe(unsafeTokenMutationDoc, unsafeTokenMutationNodes, unsafeCodeTokenOmissionPlan);
	},
	/token omission/,
	'mutation invariants must reject omitting active SQL word tokens'
);

var unsafeEmptyReplacementPlan = mutations.create();
mutations.add_token_replacement(
	unsafeEmptyReplacementPlan,
	first_token_of_type(unsafeTokenMutationDoc, 'word').id,
	''
);

assert.throws(
	function() {
		invariants.assert_mutation_plan_safe(unsafeTokenMutationDoc, unsafeTokenMutationNodes, unsafeEmptyReplacementPlan);
	},
	/token replacement/,
	'mutation invariants must reject empty replacements that delete active SQL'
);

var unsafeIndentTextPlan = mutations.create();
mutations.add_line_indent(unsafeIndentTextPlan, 0, 'DROP ');

assert.throws(
	function() {
		invariants.assert_mutation_plan_safe(unsafeTokenMutationDoc, unsafeTokenMutationNodes, unsafeIndentTextPlan);
	},
	/line indent/,
	'mutation invariants must reject non-whitespace line indents'
);

var unsafeSpacingTextPlan = mutations.create();
mutations.add_spacing_before_token(
	unsafeSpacingTextPlan,
	first_token_of_type(unsafeTokenMutationDoc, 'word').id,
	' -- '
);

assert.throws(
	function() {
		invariants.assert_mutation_plan_safe(unsafeTokenMutationDoc, unsafeTokenMutationNodes, unsafeSpacingTextPlan);
	},
	/spacing/,
	'mutation invariants must reject non-whitespace spacing text'
);

var unsafeLineBreakPrefixPlan = mutations.create();
mutations.add_line_break_before_token(
	unsafeLineBreakPrefixPlan,
	first_token_of_type(unsafeTokenMutationDoc, 'word').id,
	'',
	'DROP '
);

assert.throws(
	function() {
		invariants.assert_mutation_plan_safe(unsafeTokenMutationDoc, unsafeTokenMutationNodes, unsafeLineBreakPrefixPlan);
	},
	/line break/,
	'mutation invariants must reject unsafe line break prefixes'
);

var unsafeJoinSeparatorPlan = mutations.create();
mutations.add_line_join(unsafeJoinSeparatorPlan, 1, ' -- ');

assert.throws(
	function() {
		invariants.assert_mutation_plan_safe(unsafeTokenMutationDoc, unsafeTokenMutationNodes, unsafeJoinSeparatorPlan);
	},
	/line join/,
	'mutation invariants must reject non-whitespace line join separators'
);

var unsafeSeparatorMoveSql = [
	'select a,',
	'b',
	'from t'
].join('\n');
var unsafeSeparatorMoveDoc = formatDocument.from_text(unsafeSeparatorMoveSql, { dialect: 'generic' });
unsafeSeparatorMoveDoc.scopes = scopeModel.build(unsafeSeparatorMoveDoc, { dialect: 'generic' });
var unsafeSeparatorMoveNodes = nodes.extract(unsafeSeparatorMoveDoc, { dialect: 'generic' });
var unsafeSelectSeparator = unsafeSeparatorMoveNodes.separators.filter(function(separator) {
	return separator.ownerKind == 'selectList';
})[0];
var unsafeSeparatorMovePlan = mutations.create();
mutations.add_separator_move(unsafeSeparatorMovePlan, unsafeSelectSeparator.id, {
	placement: 'linePrefix',
	lineIndex: 1,
	text: 'DROP ',
	indentText: ''
});

assert.throws(
	function() {
		invariants.assert_mutation_plan_safe(unsafeSeparatorMoveDoc, unsafeSeparatorMoveNodes, unsafeSeparatorMovePlan);
	},
	/separator move/,
	'mutation invariants must reject unsafe separator move text'
);

var unsafeOmittedIndentSql = [
	'select a',
	'',
	'from t'
].join('\n');
var unsafeOmittedIndentDoc = formatDocument.from_text(unsafeOmittedIndentSql, { dialect: 'generic' });
unsafeOmittedIndentDoc.scopes = scopeModel.build(unsafeOmittedIndentDoc, { dialect: 'generic' });
var unsafeOmittedIndentNodes = nodes.extract(unsafeOmittedIndentDoc, { dialect: 'generic' });
var unsafeOmittedIndentPlan = mutations.create();
mutations.add_line_omission(unsafeOmittedIndentPlan, 1);
mutations.add_line_indent(unsafeOmittedIndentPlan, 1, '    ');

assert.throws(
	function() {
		invariants.assert_mutation_plan_safe(unsafeOmittedIndentDoc, unsafeOmittedIndentNodes, unsafeOmittedIndentPlan);
	},
	/line mutation conflict/,
	'mutation invariants must reject indenting omitted lines'
);

var unsafeSeparatorTargetOmissionSql = [
	'select a,',
	'',
	'b',
	'from t'
].join('\n');
var unsafeSeparatorTargetOmissionDoc = formatDocument.from_text(unsafeSeparatorTargetOmissionSql, { dialect: 'generic' });
unsafeSeparatorTargetOmissionDoc.scopes = scopeModel.build(unsafeSeparatorTargetOmissionDoc, { dialect: 'generic' });
var unsafeSeparatorTargetOmissionNodes = nodes.extract(unsafeSeparatorTargetOmissionDoc, { dialect: 'generic' });
var unsafeSeparatorTargetOmission = unsafeSeparatorTargetOmissionNodes.separators.filter(function(separator) {
	return separator.ownerKind == 'selectList';
})[0];
var unsafeSeparatorTargetOmissionPlan = mutations.create();
mutations.add_line_omission(unsafeSeparatorTargetOmissionPlan, 1);
mutations.add_separator_move(unsafeSeparatorTargetOmissionPlan, unsafeSeparatorTargetOmission.id, {
	placement: 'linePrefix',
	lineIndex: 1,
	text: ',',
	indentText: ''
});

assert.throws(
	function() {
		invariants.assert_mutation_plan_safe(
			unsafeSeparatorTargetOmissionDoc,
			unsafeSeparatorTargetOmissionNodes,
			unsafeSeparatorTargetOmissionPlan
		);
	},
	/separator move/,
	'mutation invariants must reject moving separators to omitted lines'
);

var unsafeLineOmissionSql = [
	'select',
	'a as a -- keep this comment',
	'from t'
].join('\n');
var unsafeLineOmissionDoc = formatDocument.from_text(unsafeLineOmissionSql, { dialect: 'generic' });
unsafeLineOmissionDoc.scopes = scopeModel.build(unsafeLineOmissionDoc, { dialect: 'generic' });
var unsafeLineOmissionNodes = nodes.extract(unsafeLineOmissionDoc, { dialect: 'generic' });
var unsafeLineOmissionPlan = mutations.create();
mutations.add_line_omission(unsafeLineOmissionPlan, 1);

assert.throws(
	function() {
		invariants.assert_mutation_plan_safe(unsafeLineOmissionDoc, unsafeLineOmissionNodes, unsafeLineOmissionPlan);
	},
	/line omission/,
	'mutation invariants must reject omitting a line with a trailing comment'
);

var unsafeCodeLineOmissionSql = [
	'select a',
	'from t'
].join('\n');
var unsafeCodeLineOmissionDoc = formatDocument.from_text(unsafeCodeLineOmissionSql, { dialect: 'generic' });
unsafeCodeLineOmissionDoc.scopes = scopeModel.build(unsafeCodeLineOmissionDoc, { dialect: 'generic' });
var unsafeCodeLineOmissionNodes = nodes.extract(unsafeCodeLineOmissionDoc, { dialect: 'generic' });
var unsafeCodeLineOmissionPlan = mutations.create();
mutations.add_line_omission(unsafeCodeLineOmissionPlan, 1);

assert.throws(
	function() {
		invariants.assert_mutation_plan_safe(unsafeCodeLineOmissionDoc, unsafeCodeLineOmissionNodes, unsafeCodeLineOmissionPlan);
	},
	/line omission/,
	'mutation invariants must reject omitting unhandled code lines'
);

var unsafeStandaloneJoinSql = [
	'select a',
	'-- keep standalone comment',
	'from t'
].join('\n');
var unsafeStandaloneJoinDoc = formatDocument.from_text(unsafeStandaloneJoinSql, { dialect: 'generic' });
unsafeStandaloneJoinDoc.scopes = scopeModel.build(unsafeStandaloneJoinDoc, { dialect: 'generic' });
var unsafeStandaloneJoinNodes = nodes.extract(unsafeStandaloneJoinDoc, { dialect: 'generic' });
var unsafeStandaloneJoinPlan = mutations.create();
mutations.add_line_join(unsafeStandaloneJoinPlan, 1, ' ');

assert.throws(
	function() {
		invariants.assert_mutation_plan_safe(unsafeStandaloneJoinDoc, unsafeStandaloneJoinNodes, unsafeStandaloneJoinPlan);
	},
	/line join/,
	'mutation invariants must reject joining standalone comment lines'
);

var unsafeJoinAfterCommentSql = [
	'select a -- keep this comment',
	'from t'
].join('\n');
var unsafeJoinAfterCommentDoc = formatDocument.from_text(unsafeJoinAfterCommentSql, { dialect: 'generic' });
unsafeJoinAfterCommentDoc.scopes = scopeModel.build(unsafeJoinAfterCommentDoc, { dialect: 'generic' });
var unsafeJoinAfterCommentNodes = nodes.extract(unsafeJoinAfterCommentDoc, { dialect: 'generic' });
var unsafeJoinAfterCommentPlan = mutations.create();
mutations.add_line_join(unsafeJoinAfterCommentPlan, 1, ' ');

assert.throws(
	function() {
		invariants.assert_mutation_plan_safe(unsafeJoinAfterCommentDoc, unsafeJoinAfterCommentNodes, unsafeJoinAfterCommentPlan);
	},
	/line join/,
	'mutation invariants must reject joining after a trailing comment line'
);

var groupBySql = [
	'select a',
	'from t',
	'group by a,',
	'b'
].join('\n');
var groupDoc = formatDocument.from_text(groupBySql, { dialect: 'generic' });
groupDoc.scopes = scopeModel.build(groupDoc, { dialect: 'generic' });
var groupNodes = nodes.extract(groupDoc, { dialect: 'generic' });

assert.ok(groupNodes.separators.some(function(separator) {
	return separator.ownerKind == 'groupByList';
}), 'GROUP BY top-level comma has groupByList owner');

var orderBySql = [
	'select a',
	'from t',
	'order by a,',
	'b'
].join('\n');
var orderDoc = formatDocument.from_text(orderBySql, { dialect: 'generic' });
orderDoc.scopes = scopeModel.build(orderDoc, { dialect: 'generic' });
var orderNodes = nodes.extract(orderDoc, { dialect: 'generic' });

assert.ok(orderNodes.separators.some(function(separator) {
	return separator.ownerKind == 'orderByList';
}), 'ORDER BY top-level comma has orderByList owner');

assert.strictEqual(listLayoutPolicy.first_item_prefix('selectList'), 'SELECT  ', 'SELECT list first item prefix is stable');
assert.strictEqual(listLayoutPolicy.first_item_prefix('groupByList'), 'GROUP BY  ', 'GROUP BY list first item prefix is stable');
assert.strictEqual(listLayoutPolicy.first_item_prefix('orderByList'), 'ORDER BY  ', 'ORDER BY list first item prefix is stable');
assert.strictEqual(listLayoutPolicy.continuation_width('selectList'), 7, 'SELECT continuation width is stable');
assert.strictEqual(listLayoutPolicy.continuation_width('groupByList'), 9, 'GROUP BY continuation width is stable');
assert.strictEqual(listLayoutPolicy.continuation_width('orderByList'), 9, 'ORDER BY continuation width is stable');

var selectPolicyDoc = build_structured_document([
	'select a,',
	'b',
	'from t'
].join('\n'));
var selectPolicyItem = first_item_for_owner(selectPolicyDoc.nodes, 'selectList');
assert.ok(selectPolicyItem, 'SELECT policy fixture must extract a selectList item');
assert.strictEqual(
	listLayoutPolicy.item_indent(selectPolicyDoc, selectPolicyDoc.nodes, selectPolicyItem),
	'SELECT  ',
	'SELECT first item indentation is policy-owned'
);
assert.strictEqual(
	listLayoutPolicy.case_item_indent(selectPolicyDoc, selectPolicyDoc.nodes, selectPolicyItem),
	'       ',
	'SELECT first CASE item indentation is policy-owned'
);

var groupPolicyItem = first_item_for_owner(groupNodes, 'groupByList');
assert.ok(groupPolicyItem, 'GROUP BY policy fixture must extract a groupByList item');
assert.strictEqual(
	listLayoutPolicy.structured_list_indent(groupDoc, groupNodes, groupPolicyItem.ownerScopeId, groupPolicyItem.ownerKind),
	'         ',
	'GROUP BY continuation indentation is policy-owned'
);
assert.strictEqual(
	listLayoutPolicy.case_item_indent(groupDoc, groupNodes, groupPolicyItem),
	'         ',
	'GROUP BY CASE item indentation is policy-owned'
);

var orderPolicyItem = first_item_for_owner(orderNodes, 'orderByList');
assert.ok(orderPolicyItem, 'ORDER BY policy fixture must extract an orderByList item');
assert.strictEqual(
	listLayoutPolicy.structured_list_indent(orderDoc, orderNodes, orderPolicyItem.ownerScopeId, orderPolicyItem.ownerKind),
	'         ',
	'ORDER BY continuation indentation is policy-owned'
);
assert.strictEqual(
	listLayoutPolicy.case_item_indent(orderDoc, orderNodes, orderPolicyItem),
	'          ',
	'ORDER BY CASE item indentation is policy-owned'
);

var windowOnlyDoc = build_structured_document(
	'select row_number() over(partition by ds order by pay_time desc, created_at desc) as rn from orders'
);
assert.strictEqual(
	windowOnlyDoc.nodes.selectSpans.some(function(span) { return span.kind == 'orderByList'; }),
	false,
	'window ORDER BY must remain outside top-level orderByList extraction'
);

var nestedCaseSql = [
	'select',
	'case when a = 1 then case when b = 2 then x else y end',
	'else z end as flag',
	'from t'
].join('\n');
var nestedCaseDoc = formatDocument.from_text(nestedCaseSql, { dialect: 'generic' });
nestedCaseDoc.scopes = scopeModel.build(nestedCaseDoc, { dialect: 'generic' });
var nestedCaseNodes = nodes.extract(nestedCaseDoc, { dialect: 'generic' });
var outerCase = nestedCaseNodes.caseExpressions.filter(function(caseNode) {
	var scope = nestedCaseDoc.scopes.filter(function(item) {
		return item.id == caseNode.scopeId;
	})[0];
	return scope && scope.parentScopeId == 0;
})[0];

assert.strictEqual(outerCase.branches.length, 1, 'nested CASE must not create extra outer branches');
assert.ok(outerCase.branches[0].thenTokens.some(function(token) {
	return token.type == 'word' && token.value.toLowerCase() == 'case';
}), 'nested CASE stays inside outer THEN value');
assert.strictEqual(
	outerCase.elseTokens.map(function(token) { return token.value; }).join(' '),
	'z',
	'outer ELSE owns only its own value'
);

var conditionSql = [
	'select *',
	'from a',
	'left join b',
	'on -- join condition',
	'a.id = b.id',
	'and b.dt in (',
	'1, -- one',
	'2 -- two',
	')'
].join('\n');
var conditionDoc = formatDocument.from_text(conditionSql, { dialect: 'generic' });
conditionDoc.scopes = scopeModel.build(conditionDoc, { dialect: 'generic' });
var conditionNodes = nodes.extract(conditionDoc, { dialect: 'generic' });
var onBlock = conditionNodes.conditionBlocks.filter(function(block) {
	return block.keyword == 'ON';
})[0];

assert.strictEqual(onBlock.comment, '-- join condition', 'ON block keeps keyword-line comment binding');
assert.ok(onBlock.continuationLines.some(function(line) {
	return line.lineIndex == 4 && line.kind == 'bare';
}), 'bare expression after ON comment stays in ON condition block');
assert.ok(onBlock.segments.some(function(segment) {
	return segment.lineIndex == 5 && segment.connector == 'AND';
}), 'top-level AND segment belongs to ON condition block');
assert.ok(onBlock.closeLines.some(function(line) {
	return line.lineIndex == 8;
}), 'condition close line is owned by condition block');

var nestedBooleanSql = [
	'select *',
	'from t',
	'where a = 1',
	'and (',
	"status = 'paid'",
	"or refund_status = 'none'",
	')'
].join('\n');
var nestedBooleanDoc = formatDocument.from_text(nestedBooleanSql, { dialect: 'generic' });
nestedBooleanDoc.scopes = scopeModel.build(nestedBooleanDoc, { dialect: 'generic' });
var nestedBooleanNodes = nodes.extract(nestedBooleanDoc, { dialect: 'generic' });
var nestedBooleanBlock = nestedBooleanNodes.conditionBlocks.filter(function(block) {
	return block.keyword == 'WHERE';
})[0];

assert.ok(nestedBooleanDoc.scopes.some(function(scope) {
	var parent = nestedBooleanDoc.scopes.filter(function(item) {
		return item.id == scope.parentScopeId;
	})[0];
	return scope.kind == 'parenList' && parent && parent.kind == 'conditionBlock';
}), 'nested boolean parentheses are owned as condition parenList');
assert.ok(!nestedBooleanBlock.segments.some(function(segment) {
	return segment.lineIndex == 5 && segment.connector == 'OR';
}), 'nested OR inside condition parenList is not a top-level condition segment');

var nestedQuerySelectSql = [
	'with src as (',
	'select a.user_id,',
	'case when a.city_id in (',
	'1001, -- one',
	'1002 -- two',
	') then 1 else 0 end as city_flag,',
	'row_number() over(partition by a.user_id order by a.dt desc,a.ts desc) as rn',
	'from dwd_orders a',
	')',
	'select * from src'
].join('\n');
var nestedQueryDoc = formatDocument.from_text(nestedQuerySelectSql, { dialect: 'generic' });
nestedQueryDoc.scopes = scopeModel.build(nestedQueryDoc, { dialect: 'generic' });
var nestedQueryNodes = nodes.extract(nestedQueryDoc, { dialect: 'generic' });

assert.ok(nestedQueryNodes.separators.some(function(separator) {
	return separator.line == 1 && separator.ownerKind == 'selectList';
}), 'nested query select-list comma has selectList owner');
assert.doesNotThrow(function() {
	invariants.assert_document_safe(nestedQueryDoc, nestedQueryNodes);
}, 'nested query select-list separators satisfy ownership invariants');

var cteSingleItemSql = [
	'with src as (',
	'select 1 as a',
	')',
	'select * from src'
].join('\n');
var cteSingleItemDoc = formatDocument.from_text(cteSingleItemSql, { dialect: 'generic' });
cteSingleItemDoc.scopes = scopeModel.build(cteSingleItemDoc, { dialect: 'generic' });
var cteSingleItemNodes = nodes.extract(cteSingleItemDoc, { dialect: 'generic' });
var innerCteSpan = cteSingleItemNodes.selectSpans.filter(function(span) {
	return span.startLine == 1;
})[0];

assert.ok(innerCteSpan, 'CTE inner SELECT span is extracted');
assert.strictEqual(innerCteSpan.endLine, 1, 'CTE inner SELECT span stops before close paren and outer SELECT');
assert.ok(!cteSingleItemNodes.selectItems.some(function(item) {
	return item.ownerScopeId == innerCteSpan.id && item.startLine > 1;
}), 'CTE inner SELECT list must not own close paren or outer query tokens');

console.log('format invariant tests passed');
