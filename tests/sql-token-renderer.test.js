var assert = require('assert');
var formatDocument = require('../lib/core/sql-format-document');
var scopeModel = require('../lib/core/sql-scope-model');
var navigation = require('../lib/core/sql-format-navigation');
var tokenRenderer = require('../lib/core/sql-token-renderer');
var tokenSpacing = require('../lib/core/sql-render-token-spacing');

function document_for(sql, options) {
	var config = Object.assign({ dialect: 'generic' }, options || {});
	var doc = formatDocument.from_text(sql, config);
	doc.scopes = scopeModel.build(doc, config);
	navigation.attach_scope_index(doc);
	return doc;
}

function code_tokens(doc) {
	return doc.codeTokens || [];
}

function tokens_between(tokens, startWord, endWord) {
	var start = -1;
	var end = tokens.length;
	for (var i = 0; i < tokens.length; i++) {
		if (tokens[i].type == 'word' && tokens[i].value.toUpperCase() == startWord && start < 0) {
			start = i;
		} else if (tokens[i].type == 'word' && tokens[i].value.toUpperCase() == endWord && start >= 0) {
			end = i;
			break;
		}
	}
	return tokens.slice(start, end);
}

function tokens_from_word(tokens, startWord) {
	for (var i = 0; i < tokens.length; i++) {
		if (tokens[i].type == 'word' && tokens[i].value.toUpperCase() == startWord) {
			return tokens.slice(i);
		}
	}
	return [];
}

function assert_render(name, document, tokens, options, expected) {
	var actual = tokenRenderer.render_tokens(document, tokens, options || {});
	assert.strictEqual(
		actual,
		expected,
		name + '\n--- actual ---\n' + actual + '\n--- expected ---\n' + expected
	);
	assert.strictEqual(
		tokenSpacing.render_visible_tokens(document, tokens, options || {}),
		actual,
		name + ' must match shared token spacing helper'
	);
}

var selectDoc = document_for('select row_number() over(partition by a order by b desc,c desc) as rn from t');
var selectTokens = tokens_between(code_tokens(selectDoc), 'ROW_NUMBER', 'AS');
assert_render(
	'token renderer preserves existing window ORDER BY spacing when requested',
	selectDoc,
	selectTokens,
	{
		applyKeywordCase: true,
		keywordCase: 'upper',
		unaryNumberMode: 'select',
		windowOrderBySpacing: true
	},
	'ROW_NUMBER() OVER(PARTITION BY a ORDER BY  b DESC, c DESC)'
);

assert_render(
	'token renderer keeps snippet window ORDER BY spacing opt-in',
	selectDoc,
	selectTokens,
	{},
	'row_number() over(partition by a order by b desc, c desc)'
);

assert_render(
	'token renderer skips null and undefined tokens',
	selectDoc,
	[null].concat(selectTokens.slice(0, 1)).concat([undefined]),
	{
		applyKeywordCase: true,
		keywordCase: 'lower'
	},
	'row_number'
);

assert_render(
	'token renderer handles null tokens before select binary plus',
	selectDoc,
	[selectTokens[0], null, {
		id: 'synthetic-plus',
		index: 1000,
		line: 0,
		type: 'operator',
		value: '+'
	}, {
		id: 'synthetic-one',
		index: 1001,
		line: 0,
		type: 'number',
		value: '1'
	}],
	{
		unaryNumberMode: 'select'
	},
	'row_number + 1'
);

var caseDoc = document_for('select case when x in (1, 2) then a +1 else coalesce(b, c) end as v from t');
var caseTokens = tokens_between(code_tokens(caseDoc), 'CASE', 'AS');
var preserveCommaGapTokenIndexes = {};
for (var i = 0; i < caseTokens.length; i++) {
	if (caseTokens[i].value == '2' || caseTokens[i].value == 'c') {
		preserveCommaGapTokenIndexes[String(caseTokens[i].index)] = true;
	}
}
assert_render(
	'token renderer preserves CASE-specific IN spacing, unary number, and function comma spacing',
	caseDoc,
	caseTokens,
	{
		spaceBeforeInParen: true,
		preserveCommaGapTokenIndexes: preserveCommaGapTokenIndexes,
		preserveCommaGapExceptFunctionName: 'COALESCE',
		unaryNumberMode: 'case'
	},
	'case when x in (1, 2) then a +1 else coalesce(b, c) end'
);

var existsCaseDoc = document_for('select case when exists(select 1) then 1 else 0 end as flag from t');
assert_render(
	'token renderer keeps non-IN parens compact for CASE width planning',
	existsCaseDoc,
	tokens_between(code_tokens(existsCaseDoc), 'CASE', 'AS'),
	{
		spaceBeforeInParen: true,
		preserveCommaGapTokenIndexes: {},
		preserveCommaGapExceptFunctionName: 'COALESCE',
		unaryNumberMode: 'case'
	},
	'case when exists(select 1) then 1 else 0 end'
);

var commaDoc = document_for("select coalesce(phone,email,'unknown') as contact_info from users where channel in ('app','web') order by dt desc,event_time desc");
assert_render(
	'token renderer normalizes function argument comma spacing',
	commaDoc,
	tokens_between(code_tokens(commaDoc), 'COALESCE', 'AS'),
	{},
	"coalesce(phone, email, 'unknown')"
);
assert_render(
	'token renderer normalizes IN-list comma spacing',
	commaDoc,
	tokens_between(code_tokens(commaDoc), 'WHERE', 'ORDER'),
	{},
	"where channel in ('app', 'web')"
);
assert_render(
	'token renderer normalizes ORDER BY comma spacing',
	commaDoc,
	tokens_from_word(code_tokens(commaDoc), 'ORDER'),
	{},
	'order by dt desc, event_time desc'
);

var leadingCommaDoc = document_for('select a,b,c from t');
assert_render(
	'token renderer keeps leading comma prefix compact',
	leadingCommaDoc,
	code_tokens(leadingCommaDoc).slice(2, 4),
	{},
	',b'
);

var aggregateDoc = document_for('select count(*) as order_cnt from orders');
assert_render(
	'token renderer keeps aggregate star compact for width planning',
	aggregateDoc,
	tokens_between(code_tokens(aggregateDoc), 'COUNT', 'AS'),
	{},
	'count(*)'
);

var postgresJsonDoc = document_for("select payload->>'order_id' as order_id, payload ? 'coupon' as has_coupon from events", {
	dialect: 'postgres'
});
assert_render(
	'token renderer preserves legacy snippet width for no-space json operators',
	postgresJsonDoc,
	tokens_between(code_tokens(postgresJsonDoc), 'PAYLOAD', 'AS'),
	{},
	"payload ->> 'order_id'"
);

var spacedScopeDoc = document_for('select fn(a,b) as c from t');
var fnTokens = tokens_between(code_tokens(spacedScopeDoc), 'FN', 'AS');
var spacedScopeId = null;
for (var s = 0; s < spacedScopeDoc.scopes.length; s++) {
	if (spacedScopeDoc.scopes[s].kind == 'functionCall') {
		spacedScopeId = spacedScopeDoc.scopes[s].id;
		break;
	}
}
assert_render(
	'token renderer supports caller-requested outer scope spacing',
	spacedScopeDoc,
	fnTokens,
	{
		spacedScopeId: spacedScopeId
	},
	'fn( a, b )'
);

console.log('sql token renderer tests passed');
