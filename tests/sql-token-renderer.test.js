var assert = require('assert');
var formatDocument = require('../lib/core/sql-format-document');
var scopeModel = require('../lib/core/sql-scope-model');
var navigation = require('../lib/core/sql-format-navigation');
var tokenRenderer = require('../lib/core/sql-token-renderer');

function document_for(sql, options) {
	var doc = formatDocument.from_text(sql, Object.assign({ dialect: 'generic' }, options || {}));
	doc.scopes = scopeModel.build(doc, Object.assign({ dialect: 'generic' }, options || {}));
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

var selectDoc = document_for('select row_number() over(partition by a order by b desc,c desc) as rn from t');
var selectTokens = tokens_between(code_tokens(selectDoc), 'ROW_NUMBER', 'AS');
assert.strictEqual(
	tokenRenderer.render_tokens(selectDoc, selectTokens, {
		applyKeywordCase: true,
		keywordCase: 'upper',
		unaryNumberMode: 'select',
		windowOrderBySpacing: true
	}),
	'ROW_NUMBER() OVER(PARTITION BY a ORDER BY  b DESC, c DESC)',
	'token renderer preserves existing window ORDER BY spacing'
);

assert.strictEqual(
	tokenRenderer.render_tokens(selectDoc, [null].concat(selectTokens.slice(0, 1)).concat([undefined]), {
		applyKeywordCase: true,
		keywordCase: 'lower'
	}),
	'row_number',
	'token renderer skips null and undefined tokens'
);

assert.strictEqual(
	tokenRenderer.render_tokens(selectDoc, [selectTokens[0], null, {
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
	}], {
		unaryNumberMode: 'select'
	}),
	'row_number + 1',
	'token renderer handles null tokens before select unary numbers'
);

var caseDoc = document_for('select case when x in (1, 2) then a +1 else coalesce(b, c) end as v from t');
var caseTokens = tokens_between(code_tokens(caseDoc), 'CASE', 'AS');
var preserveCommaGapTokenIndexes = {};
for (var i = 0; i < caseTokens.length; i++) {
	if (caseTokens[i].value == '2' || caseTokens[i].value == 'c') {
		preserveCommaGapTokenIndexes[String(caseTokens[i].index)] = true;
	}
}
assert.strictEqual(
	tokenRenderer.render_tokens(caseDoc, caseTokens, {
		spaceBeforeInParen: true,
		preserveCommaGapTokenIndexes: preserveCommaGapTokenIndexes,
		preserveCommaGapExceptFunctionName: 'COALESCE',
		unaryNumberMode: 'case'
	}),
	'case when x in (1, 2) then a +1 else coalesce(b, c) end',
	'token renderer preserves CASE-specific IN spacing, unary number, and function comma spacing'
);

console.log('sql token renderer tests passed');
