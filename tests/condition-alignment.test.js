var assert = require('assert');
var vkbeautify = require('../vkbeautify');
var sqlFormatter = require('../lib/sql-formatter');

function format(sql) {
	return vkbeautify.sql(sql, true, false, true, 150, 80).trim();
}

function format_with_indent(sql, indentStyle) {
	return sqlFormatter.format_sql(sql, {
		keywordCase: 'upper',
		commaStyle: 'leading',
		indentStyle: indentStyle,
		maxAlignWidth: 150,
		caseWhenThenWrapLength: 80,
		dialect: 'generic'
	}).trim();
}

function run_case(name, input, expected) {
	var actual = format(input);
	assert.strictEqual(actual, expected.trim(), name + '\n--- actual ---\n' + actual + '\n--- expected ---\n' + expected.trim());
}

function run_indent_case(name, input, indentStyle, expected) {
	var actual = format_with_indent(input, indentStyle);
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

run_case(
	'unary signed literals after comparison operators stay readable',
	'select * from t where a=-1 and b=+2 and c>=-3 and d<=+4',
	[
		'SELECT  *',
		'FROM t',
		'WHERE a = -1',
		'  AND b = +2',
		'  AND c >= -3',
		'  AND d <= +4'
	].join('\n')
);

run_indent_case(
	'condition alignment preserves nested where indent for space style',
	[
		'select *',
		'from (',
		'select a',
		'from t',
		'where b=1 and c=2 or d=3',
		') x'
	].join('\n'),
	'space',
	[
		'SELECT  *',
		'FROM',
		'(',
		'    SELECT  a',
		'    FROM t',
		'    WHERE b = 1',
		'      AND c = 2',
		'       OR d = 3',
		') x'
	].join('\n')
);

console.log('condition alignment tests passed');
