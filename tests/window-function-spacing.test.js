var assert = require('assert');
var sqlFormatter = require('../lib/sql-formatter');

function format(sql) {
	return sqlFormatter.format_sql(sql, {
		keywordCase: 'upper',
		commaStyle: 'leading',
		indentStyle: 'space',
		maxAlignWidth: 150,
		caseWhenThenWrapLength: 80,
		dialect: 'generic'
	}).trim();
}

function assert_contains(name, input, expectedFragment) {
	var actual = format(input);
	assert.ok(
		actual.indexOf(expectedFragment) >= 0,
		name + '\n--- missing fragment ---\n' + expectedFragment + '\n--- actual ---\n' + actual
	);
	return actual;
}

var compactOver = assert_contains(
	'window OVER without original gap stays compact and ORDER BY expression keeps double-space contract',
	'select row_number() over(partition by ds order by pay_time desc) as rn from orders',
	'ROW_NUMBER() OVER(PARTITION BY ds ORDER BY  pay_time DESC) AS rn'
);

assert.ok(
	compactOver.indexOf('OVER (PARTITION BY ds') < 0,
	'compact OVER(...) must not be rewritten to OVER (...)\n--- actual ---\n' + compactOver
);

assert_contains(
	'window OVER with original gap preserves that gap',
	'select rank() over (partition by ds order by pay_time desc) as rk from orders',
	'rank() OVER (PARTITION BY ds ORDER BY  pay_time DESC) AS rk'
);

assert_contains(
	'window ORDER BY keeps double-space before the first ordered expression only',
	'select row_number() over(partition by ds order by pay_time desc, created_at desc) as rn from orders',
	'ROW_NUMBER() OVER(PARTITION BY ds ORDER BY  pay_time DESC,created_at DESC) AS rn'
);

console.log('window function spacing tests passed');
