var assert = require('assert');
var formatDocument = require('../lib/core/sql-format-document');

var doc = formatDocument.from_text([
	"select `from` as c, '-- THEN' as s -- keep THEN",
	'from t',
	'where x in (',
	'1, -- one',
	'2 -- two',
	')'
].join('\n'), { dialect: 'generic' });

assert.strictEqual(doc.lines.length, 6, 'document preserves physical lines');
assert.strictEqual(doc.lines[0].commentText, '-- keep THEN', 'trailing comment is separated');
assert.ok(doc.lines[0].codeTokens.every(function(token) {
	return token.type != 'line_comment';
}), 'line comment never enters codeTokens');
assert.ok(doc.tokens.some(function(token) {
	return token.type == 'quoted_identifier' && token.value == '`from`';
}), 'quoted identifier is preserved as token');
assert.ok(doc.tokens.some(function(token) {
	return token.type == 'string_literal' && token.value == "'-- THEN'";
}), 'string literal containing comment marker is preserved as literal');
var firstToken = doc.tokens[0];
assert.strictEqual(doc.tokenById[String(firstToken.id)], firstToken, 'document indexes tokens by id');
assert.strictEqual(doc.tokenByIndex[String(firstToken.index)], firstToken, 'document indexes tokens by tokenizer index');
assert.ok(doc.codeTokens.length > 0, 'document exposes active code tokens');
assert.strictEqual(
	doc.codeTokens[doc.codeTokenPositionByIndex[String(firstToken.index)]],
	firstToken,
	'document indexes active code token positions by tokenizer index'
);
assert.strictEqual(doc.lineByIndex[String(doc.lines[0].index)], doc.lines[0], 'document indexes lines by line index');
assert.ok(doc.lines[3].commentText == '-- one', 'nested list item comment is separated');

console.log('format document model tests passed');
