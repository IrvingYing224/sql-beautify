var assert = require('assert');
var formatDocument = require('../lib/core/sql-format-document');
var scopeModel = require('../lib/core/sql-scope-model');
var navigation = require('../lib/core/sql-format-navigation');

var sql = [
    "select a, '-- keep select' as s -- trailing comment",
    'from t',
    'where a in (',
    '1, -- one',
    '2 -- two',
    ')'
].join('\n');

var doc = formatDocument.from_text(sql, { dialect: 'generic' });
doc.scopes = scopeModel.build(doc, { dialect: 'generic' });
navigation.attach_scope_index(doc);

var selectToken = doc.tokens.filter(function(token) {
    return token.type == 'word' && token.value.toUpperCase() == 'SELECT';
})[0];
var fromToken = doc.tokens.filter(function(token) {
    return token.type == 'word' && token.value.toUpperCase() == 'FROM';
})[0];
var stringToken = doc.tokens.filter(function(token) {
    return token.type == 'string_literal';
})[0];
var commaToken = doc.tokens.filter(function(token) {
    return token.type == 'punctuation' && token.value == ',';
})[0];

assert.strictEqual(navigation.token_by_id(doc, selectToken.id), selectToken, 'token lookup by id uses document index');
assert.strictEqual(navigation.token_by_index(doc, fromToken.index), fromToken, 'token lookup by index uses document index');
assert.strictEqual(navigation.line_by_index(doc, 0), doc.lines[0], 'line lookup by index returns physical line');
assert.strictEqual(navigation.active_tokens(doc)[0], selectToken, 'active tokens preserve source order');
assert.strictEqual(navigation.previous_code_token(doc, fromToken).value.toUpperCase(), 's'.toUpperCase(), 'previous code token skips comments and whitespace');
assert.strictEqual(navigation.next_code_token(doc, commaToken), stringToken, 'next code token skips whitespace');

var whereScope = doc.scopes.filter(function(scope) {
    return scope.kind == 'conditionBlock' && scope.keyword == 'WHERE';
})[0];
assert.ok(whereScope, 'WHERE condition scope exists');
assert.strictEqual(navigation.scope_by_id(doc, whereScope.id), whereScope, 'scope lookup by id uses attached scope index');

console.log('format navigation tests passed');
