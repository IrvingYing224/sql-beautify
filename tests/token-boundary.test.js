var assert = require('assert');
var vkbeautify = require('../vkbeautify');
var sqlFormatter = require('../lib/sql-formatter');

function format(sql, uppercase) {
	return vkbeautify.sql(sql, uppercase !== false, false, true, 150, 80).trim();
}

function assert_contains(name, input, expectedFragment, uppercase) {
	var actual = format(input, uppercase);
	assert.ok(
		actual.indexOf(expectedFragment) >= 0,
		name + '\n--- missing fragment ---\n' + expectedFragment + '\n--- actual ---\n' + actual
	);
}

function assert_idempotent(name, input) {
	var once = format(input);
	var twice = format(once);
	assert.strictEqual(twice, once, name + '\n--- once ---\n' + once + '\n--- twice ---\n' + twice);
}

function assert_exact(name, input, expected) {
	var actual = format(input);
	assert.strictEqual(actual, expected.trim(), name + '\n--- actual ---\n' + actual + '\n--- expected ---\n' + expected.trim());
}

function format_structured(sql, dialect) {
	return sqlFormatter.format_sql(sql, {
		keywordCase: 'upper',
		commaStyle: 'leading',
		indentStyle: 'space',
		maxAlignWidth: 150,
		caseWhenThenWrapLength: 80,
		dialect: dialect || 'generic'
	}).trim();
}

function assert_structured_contains(name, input, expectedFragment, dialect) {
	var actual = format_structured(input, dialect);
	assert.ok(
		actual.indexOf(expectedFragment) >= 0,
		name + '\n--- missing fragment ---\n' + expectedFragment + '\n--- actual ---\n' + actual
	);
}

assert_contains(
	'block comments keep SQL-looking content unchanged',
	"select a /* keep from where CASE WHEN THEN, MixedCase */ from t where b=1",
	"/* keep from where CASE WHEN THEN, MixedCase */"
);

assert_contains(
	'quoted identifiers keep mixed case and keyword text unchanged',
	"select `MiXeD Select From` as `Alias From` from `Db`.`TableName`",
	"`MiXeD Select From`"
);

assert_contains(
	'quoted identifier aliases keep mixed case and keyword text unchanged',
	"select `MiXeD Select From` as `Alias From` from `Db`.`TableName`",
	"`Alias From`"
);

assert_contains(
	'backslash escaped string stays intact',
	"select 'can\\'t from where' as s, a from t",
	"'can\\'t from where'"
);

assert_contains(
	'doubled single quote string stays intact',
	"select 'it''s from where' as s from t",
	"'it''s from where'"
);

assert_contains(
	'CASE keywords inside string and line comment are not parsed as SQL',
	"select '-- CASE WHEN THEN FROM WHERE' as s -- CASE WHEN THEN FROM WHERE\nfrom t",
	"'-- CASE WHEN THEN FROM WHERE'"
);

assert_contains(
	'line comments keep CASE keywords unchanged',
	"select '-- CASE WHEN THEN FROM WHERE' as s -- CASE WHEN THEN FROM WHERE\nfrom t",
	"-- CASE WHEN THEN FROM WHERE"
);

assert_exact(
	'shield-like user identifier is not restored as protected token',
	"select SQLSHIELDX0X, 'abc' as s from t",
	[
		"SELECT  SQLSHIELDX0X",
		"       ,'abc'        AS s",
		"FROM t"
	].join('\n')
);

assert_exact(
	'standalone block comments keep their own line',
	"select a\n/* where disabled */\nfrom t",
	[
		"SELECT  a",
		"/* where disabled */",
		"FROM t"
	].join('\n')
);

assert_exact(
	'trailing block comments stay on the code line',
	"select a /* where disabled */ from t",
	[
		"SELECT  a /* where disabled */",
		"FROM t"
	].join('\n')
);

assert_idempotent(
	'token boundary formatting is idempotent',
	[
		"select `MiXeD Select From` as ident_name,",
		"       'can\\'t from where' as escaped_string,",
		"       'it''s from where' as doubled_string,",
		"       a /* keep from where CASE WHEN THEN, MixedCase */",
		"from t",
		"where note = '-- CASE WHEN THEN FROM WHERE';"
	].join('\n')
);

assert_structured_contains(
	'structured keyword mutation preserves SQL-looking line comment text',
	"select a -- select from where case when then\nfrom t",
	"-- select from where case when then"
);

assert_structured_contains(
	'structured keyword mutation preserves SQL-looking string literal text',
	"select 'select from where case when then' as s from t",
	"'select from where case when then'"
);

assert_structured_contains(
	'structured keyword mutation preserves SQL-looking quoted identifier text',
	"select `select from where` as ident from t",
	"`select from where`"
);

assert_structured_contains(
	'structured keyword mutation preserves postgres dollar string text',
	"select $$select from where case when then$$ as s from t",
	"$$select from where case when then$$",
	'postgres'
);
