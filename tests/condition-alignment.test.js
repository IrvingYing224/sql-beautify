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
	'condition blocks keep on where and qualify responsibilities isolated',
	"select * from a left join b on a.id=b.id and b.ds='2026-04-23' or b.flag=1 where a.x=1 and a.y in (1,2) qualify rn=1",
	[
		'SELECT  *',
		'FROM a',
		'LEFT JOIN b',
		'     ON a.id = b.id',
		"    AND b.ds = '2026-04-23'",
		'     OR b.flag = 1',
		'WHERE a.x = 1',
		'  AND a.y IN (1, 2)',
		'QUALIFY rn = 1'
	].join('\n')
);

run_case(
	'where wrapping keeps boolean tails on the condition formatter path',
	'select a from t where x=1 and y=2 or z=3 qualify rn=1',
	[
		'SELECT  a',
		'FROM t',
		'WHERE x = 1',
		'  AND y = 2',
		'   OR z = 3',
		'QUALIFY rn = 1'
	].join('\n')
);

run_case(
	'condition wrapping skips nested boolean operators and between ranges',
	"select a from t where dt between '2026-01-01' and '2026-01-31' and (x=1 or y=2) and case when z=1 and k=2 then 1 else 0 end=1",
	[
		'SELECT  a',
		'FROM t',
		"WHERE dt BETWEEN '2026-01-01' AND '2026-01-31'",
		'  AND (x = 1 OR y = 2)',
		'  AND CASE',
		'          WHEN z = 1 AND k = 2 THEN 1',
		'          ELSE 0',
		'      END = 1'
	].join('\n')
);

console.log('condition alignment tests passed');
