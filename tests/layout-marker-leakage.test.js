var assert = require('assert');
var sqlFormatter = require('../lib/sql-formatter');

function format(sql) {
	return sqlFormatter.format_sql(sql, {
		keywordCase: 'upper',
		commaStyle: 'leading',
		indentStyle: 'tab',
		maxAlignWidth: 150,
		caseWhenThenWrapLength: 80,
		dialect: 'generic'
	});
}

function assert_preserves_literal(name, sql, expectedLiteral) {
	var formatted = format(sql);
	assert.ok(
		formatted.indexOf(expectedLiteral) >= 0,
		name + ' must preserve user-authored marker-like literal\n--- actual ---\n' + formatted
	);
}

assert_preserves_literal(
	'WHEREiscomment string literal',
	"select 'WHEREiscomment' as marker_value from t",
	"'WHEREiscomment'"
);
assert_preserves_literal(
	'shouldhavenbehind string literal',
	"select 'shouldhavenbehind' as marker_value from t",
	"'shouldhavenbehind'"
);
assert_preserves_literal(
	'{comma} string literal',
	"select '{comma}' as marker_value from t",
	"'{comma}'"
);
assert_preserves_literal(
	'UNIONALLALL string literal',
	"select 'UNIONALLALL' as marker_value from t",
	"'UNIONALLALL'"
);

assert_preserves_literal(
	'WHEREiscomment line comment',
	"select a -- WHEREiscomment\nfrom t",
	'-- WHEREiscomment'
);
assert_preserves_literal(
	'shouldhavenbehind line comment',
	"select a -- shouldhavenbehind\nfrom t",
	'-- shouldhavenbehind'
);
assert_preserves_literal(
	'{comma} line comment',
	"select a -- {comma}\nfrom t",
	'-- {comma}'
);
assert_preserves_literal(
	'UNIONALLALL line comment',
	"select a -- UNIONALLALL\nfrom t",
	'-- UNIONALLALL'
);

console.log('layout marker leakage tests passed');
