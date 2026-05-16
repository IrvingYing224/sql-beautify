var assert = require('assert');
var vkbeautify = require('../vkbeautify');

function format(sql) {
	return vkbeautify.sql(sql, true, false, true, 150, 80).trim();
}

function run_case(name, input, expected) {
	var actual = format(input);
	assert.strictEqual(actual, expected.trim(), name + '\n--- actual ---\n' + actual + '\n--- expected ---\n' + expected.trim());
}

run_case(
	'select list split keeps as alignment and case ownership',
	'select a as a_col,b_long as b_col,case when x=1 then y else z end as c from t',
	[
		'SELECT  a                     AS a_col',
		'       ,b_long                AS b_col',
		'       ,CASE',
		'            WHEN x = 1 THEN y',
		'            ELSE z',
		'        END                   AS c',
		'FROM t'
	].join('\n')
);

run_case(
	'select item normalization stays inside select formatter',
	"select concat_ws('-', cast(id as string), name) as user_key,status as status from users",
	[
		"SELECT  concat_ws('-',CAST(id AS STRING),name) AS user_key",
		'       ,status                                 AS status',
		'FROM users'
	].join('\n')
);

console.log('select alignment tests passed');
