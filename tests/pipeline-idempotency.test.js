var assert = require('assert');
var sqlShield = require('../lib/sql-shield');
var sqlRenderOptions = require('../lib/sql-render-options');
var sqlFormatPipeline = require('../lib/sql-format-pipeline');
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

var shieldInput = [
	"select `MiXeD From` as c, 'can\\'t from where' as s /* FROM WHERE */",
	"from t -- CASE WHEN THEN FROM WHERE"
].join('\n');
var shielded = sqlShield.protect(shieldInput);

assert.ok(
	shielded.text.indexOf('MiXeD From') < 0
		&& shielded.text.indexOf("can\\'t from where") < 0
		&& shielded.text.indexOf('FROM WHERE') < 0
		&& shielded.text.indexOf('CASE WHEN THEN') < 0,
	'shield must hide strings, quoted identifiers, block comments, and line comments'
);
assert.strictEqual(
	sqlShield.restore(shielded.text, shielded.tokens),
	shieldInput,
	'shield restore must reproduce original text exactly'
);

assert.deepStrictEqual(
	sqlRenderOptions.normalize({
		uppercase: false,
		comma_location: true,
		bracket_char: true,
		as_loc_cnt: 88,
		case_when_then_wrap_length: 33,
		keywordCase: 'upper',
		commaStyle: 'leading',
		indentStyle: 'tab',
		maxAlignWidth: 120
	}, {
		keywordCase: false,
		commaStyle: false,
		indentStyle: false,
		maxAlignWidth: false
	}),
	{
		keywordCase: 'lower',
		commaStyle: 'trailing',
		indentStyle: 'space',
		maxAlignWidth: 88,
		caseWhenThenWrapLength: 33,
		dialect: 'generic',
		languageMode: 'sql',
		unsupportedSyntaxPolicy: 'preserve'
	},
	'legacy options remain effective when new options are not explicitly configured through canonical normalization'
);

assert.deepStrictEqual(
	sqlRenderOptions.normalize({
		uppercase: false,
		comma_location: true,
		bracket_char: true,
		as_loc_cnt: 88,
		case_when_then_wrap_length: 33,
		keywordCase: 'upper',
		commaStyle: 'leading',
		indentStyle: 'tab',
		maxAlignWidth: 120
	}, {
		keywordCase: true,
		commaStyle: true,
		indentStyle: true,
		maxAlignWidth: true
	}),
	{
		keywordCase: 'upper',
		commaStyle: 'leading',
		indentStyle: 'tab',
		maxAlignWidth: 120,
		caseWhenThenWrapLength: 33,
		dialect: 'generic',
		languageMode: 'sql',
		unsupportedSyntaxPolicy: 'preserve'
	},
	'new options override legacy options when explicitly configured'
);

assert.deepStrictEqual(
	sqlRenderOptions.normalize({
		keywordCase: 'upper',
		commaStyle: 'leading',
		indentStyle: 'tab',
		maxAlignWidth: 120,
		caseWhenThenWrapLength: 33,
		dialect: 'generic',
		languageMode: 'sql'
	}, {
		canonical: true
	}),
	{
		keywordCase: 'upper',
		commaStyle: 'leading',
		indentStyle: 'tab',
		maxAlignWidth: 120,
		caseWhenThenWrapLength: 33,
		dialect: 'generic',
		languageMode: 'sql',
		unsupportedSyntaxPolicy: 'preserve'
	},
	'canonical options remain canonical through render option normalization'
);

assert.strictEqual(
	sqlFormatPipeline.run(' select a ', [
		function(text) { return text.replace(/^\s+|\s+$/g, ''); },
		function(text) { return text.toUpperCase(); }
	]),
	'SELECT A',
	'format pipeline must run passes in order'
);

var idempotentInput = [
	"select `MiXeD From` as ident_name,",
	"       'can\\'t from where' as escaped_string,",
	"       a /* keep FROM WHERE CASE WHEN THEN */",
	"from t",
	"where note = '-- CASE WHEN THEN FROM WHERE';"
].join('\n');

assert.strictEqual(
	format(format(idempotentInput)),
	format(idempotentInput),
	'full SQL formatting pipeline must be idempotent for protected token boundaries'
);

[
	{
		indentStyle: 'tab',
		expected: [
			'SELECT  *',
			'FROM',
			'(',
			'\tSELECT  a',
			'\tFROM t',
			'\tWHERE EXISTS (',
			'\t\tSELECT  1',
			'\t\tFROM t2',
			'\t\tWHERE t2.id = t.id',
			'\t)',
			') x'
		].join('\n')
	},
	{
		indentStyle: 'space',
		expected: [
			'SELECT  *',
			'FROM',
			'(',
			'    SELECT  a',
			'    FROM t',
			'    WHERE EXISTS (',
			'        SELECT  1',
			'        FROM t2',
			'        WHERE t2.id = t.id',
			'    )',
			') x'
		].join('\n')
	}
].forEach(function(testCase) {
	var input = [
		'select *',
		'from (',
		'select a',
		'from t',
		'where exists (',
		'select 1',
		'from t2',
		'where t2.id=t.id',
		')',
		') x'
	].join('\n');
	var actual = format_with_indent(input, testCase.indentStyle);

	assert.strictEqual(
		actual,
		testCase.expected,
		'line-tail opening parenthesis must increase next-line indent for exists subquery: ' + testCase.indentStyle
			+ '\n--- actual ---\n' + actual + '\n--- expected ---\n' + testCase.expected
	);
});

[
	{
		indentStyle: 'tab',
		expected: [
			'SELECT  *',
			'FROM t',
			'WHERE a.id IN (',
			'\tSELECT  id',
			'\tFROM t2',
			'\tWHERE flag = 1',
			')'
		].join('\n')
	},
	{
		indentStyle: 'space',
		expected: [
			'SELECT  *',
			'FROM t',
			'WHERE a.id IN (',
			'    SELECT  id',
			'    FROM t2',
			'    WHERE flag = 1',
			')'
		].join('\n')
	}
].forEach(function(testCase) {
	var input = [
		'select *',
		'from t',
		'where a.id in (',
		'select id',
		'from t2',
		'where flag=1',
		')'
	].join('\n');
	var actual = format_with_indent(input, testCase.indentStyle);

	assert.strictEqual(
		actual,
		testCase.expected,
		'line-tail opening parenthesis must increase next-line indent for inline subquery: ' + testCase.indentStyle
			+ '\n--- actual ---\n' + actual + '\n--- expected ---\n' + testCase.expected
	);
});
