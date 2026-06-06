var assert = require('assert');
var formatDocument = require('../lib/core/sql-format-document');
var scopeModel = require('../lib/core/sql-scope-model');

var sql = [
	'select',
	'case when city_id in (',
	'1001, -- 北京',
	'1002 -- 上海',
	") then concat_ws(',', name, city)",
	"else 'unknown'",
	'end as city_label',
	'from t',
	'left join x',
	'on -- join condition',
	't.id = x.id',
	'and x.ds in (',
	"'2026-05-17',",
	"'2026-05-18'",
	')'
].join('\n');

var doc = formatDocument.from_text(sql, { dialect: 'generic' });
var scopes = scopeModel.build(doc, { dialect: 'generic' });

assert.ok(scopes.find(function(scope) {
	return scope.kind == 'caseExpr';
}), 'case expression scope is detected');
assert.ok(scopes.find(function(scope) {
	return scope.kind == 'inList' && scope.startLine == 1 && scope.endLine == 4;
}), 'WHEN in-list scope is detected across comments');
assert.ok(scopes.find(function(scope) {
	return scope.kind == 'functionCall' && /concat_ws/i.test(scope.ownerText);
}), 'function call scope is detected');
assert.ok(scopes.find(function(scope) {
	return scope.kind == 'conditionBlock' && scope.keyword == 'ON' && scope.startLine == 9 && scope.endLine == 14;
}), 'ON condition block includes comment line and first condition');
assert.ok(scopes.find(function(scope) {
	return scope.kind == 'inList' && scope.startLine == 11 && scope.endLine == 14;
}), 'condition in-list scope is detected');
assert.ok(scopes.find(function(scope) {
	return scope.kind == 'inList' && scope.closeIndentOwnerKind == 'conditionBlock';
}), 'IN-list closing paren inherits condition block owner');

var nestedQuerySql = [
	'select *',
	'from (',
	'select a',
	'from t',
	'where b=1 and c=2',
	') x'
].join('\n');
var nestedQueryDoc = formatDocument.from_text(nestedQuerySql, { dialect: 'generic' });
var nestedQueryScopes = scopeModel.build(nestedQueryDoc, { dialect: 'generic' });
var nestedWhereScope = nestedQueryScopes.find(function(scope) {
	return scope.kind == 'conditionBlock' && scope.keyword == 'WHERE';
});

assert.ok(nestedWhereScope, 'nested query WHERE condition scope is detected');
assert.strictEqual(
	nestedWhereScope.endLine,
	4,
	'nested query WHERE condition scope must stop before the subquery close line'
);

console.log('format scope model tests passed');
