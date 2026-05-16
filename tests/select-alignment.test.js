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

run_case(
	'continuation select lines split additional top level items after case expressions',
	[
		'select a.user_id as user_id,',
		'       a.user_name as name,',
		'       a.city as city_name,case',
		'                                when a.age is null then -1',
		'                                when a.age < 18 then 0',
		'                                else 1',
		'                            end as age_group,b.order_cnt as order_count,b.pay_amt as pay_amount,substr(c.last_login_time,1,10) as login_date',
		'from t'
	].join('\n'),
	[
		'SELECT  a.user_id                       AS user_id',
		'       ,a.user_name                     AS name',
		'       ,a.city                          AS city_name',
		'       ,CASE',
		'            WHEN a.age IS NULL THEN - 1',
		'            WHEN a.age < 18    THEN 0',
		'            ELSE 1',
		'        END                             AS age_group',
		'       ,b.order_cnt                     AS order_count',
		'       ,b.pay_amt                       AS pay_amount',
		'       ,substr(c.last_login_time,1,10)  AS login_date',
		'FROM t'
	].join('\n')
);

run_case(
	'standalone comment between select items keeps next item comma without orphan comma line',
	[
		'select a as x,b as y,',
		'-- cmt',
		'case when z=1 then 1 else 0 end as z from t'
	].join('\n'),
	[
		'SELECT  a                     AS x',
		'       ,b                     AS y',
		'-- cmt',
		'       ,CASE',
		'            WHEN z = 1 THEN 1',
		'            ELSE 0',
		'        END                   AS z',
		'FROM t'
	].join('\n')
);

console.log('select alignment tests passed');
