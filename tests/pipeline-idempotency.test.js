var assert = require('assert');
var sqlShield = require('../lib/sql-shield');
var sqlRenderOptions = require('../lib/sql-render-options');
var sqlFormatPipeline = require('../lib/sql-format-pipeline');
var sqlFormatModel = require('../lib/core/sql-format-model');
var sqlFormatContext = require('../lib/core/sql-format-context');
var sqlNormalizePasses = require('../lib/core/sql-normalize-passes');
var sqlDialect = require('../lib/core/sql-dialect');
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
		keywordCase: 'lower',
		commaStyle: 'trailing',
		indentStyle: 'space',
		maxAlignWidth: 88,
		caseWhenThenWrapLength: 33
	}, {
		keywordCase: true,
		commaStyle: true,
		indentStyle: true,
		maxAlignWidth: true,
		caseWhenThenWrapLength: true
	}),
	{
		keywordCase: 'lower',
		commaStyle: 'trailing',
		indentStyle: 'space',
		maxAlignWidth: 88,
		caseWhenThenWrapLength: 33,
		caseLayout: 'expanded',
		dialect: 'hive',
		languageMode: 'sql',
		unsupportedSyntaxPolicy: 'preserve'
	},
	'canonical config normalization must not depend on removed legacy option names'
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
		caseLayout: 'expanded',
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

var modeled = sqlFormatModel.from_text([
	'select a -- keep',
	'from t',
	'where x=(1 + 2) and y=2'
].join('\n'), { dialect: 'generic' });

assert.strictEqual(modeled.lines.length, 3, 'format model must preserve line count');
assert.strictEqual(modeled.lines[0].comment, '-- keep', 'format model must expose trailing comments');
assert.strictEqual(modeled.lines[0].hasTrailingComment, true, 'format model must expose trailing comment state');
assert.strictEqual(modeled.lines[2].parenDelta, 0, 'format model must expose paren delta');

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

var whitespaceContractInput = [
	'select a,b from t',
	'',
	'',
	'where x=1'
].join('\r\n');

assert.strictEqual(
	sqlFormatter.format_sql(whitespaceContractInput, {
		keywordCase: 'upper',
		commaStyle: 'leading',
		indentStyle: 'tab',
		maxAlignWidth: 150,
		caseWhenThenWrapLength: 80,
		dialect: 'generic'
	}),
	[
		'SELECT  a',
		'       ,b',
		'FROM t',
		'',
		'WHERE x = 1',
		''
	].join('\n'),
	'formatter must preserve a single user blank line, normalize CRLF to LF, and keep a single trailing newline'
);

var setPayloadSource = 'set key=$$a  b$$;\nselect 1';
var setPayloadContext = sqlFormatContext.create_context(setPayloadSource);
var setPayloadProtected = sqlNormalizePasses.protect_set_payloads(
	setPayloadSource,
	setPayloadContext,
	sqlDialect.get_capabilities('postgres')
).text;

assert.ok(
	setPayloadProtected.indexOf(';\nselect 1') >= 0,
	'SET payload protection must preserve physical newline before the next statement'
);

assert.strictEqual(
	sqlFormatter.format_sql(setPayloadSource, {
		keywordCase: 'upper',
		commaStyle: 'leading',
		indentStyle: 'tab',
		maxAlignWidth: 150,
		caseWhenThenWrapLength: 80,
		dialect: 'postgres'
	}),
	[
		'SET key = $$a  b$$;',
		'SELECT  1',
		''
	].join('\n'),
	'SET payload normalization must preserve PostgreSQL dollar-quoted string bytes'
);

assert.strictEqual(
	sqlFormatter.format_sql('select $$) )$$ as s, func(a) from t', {
		keywordCase: 'upper',
		commaStyle: 'leading',
		indentStyle: 'tab',
		maxAlignWidth: 150,
		caseWhenThenWrapLength: 80,
		dialect: 'postgres'
	}),
	[
		'SELECT  $$) )$$ AS s',
		'       ,func(a)',
		'FROM t',
		''
	].join('\n'),
	'layout indentation must ignore parentheses inside PostgreSQL dollar-quoted strings'
);

assert.strictEqual(
	sqlFormatter.format_sql([
		'select * from t',
		'where a in (',
		'1 # keep ) ) comment',
		'and b=2',
		')'
	].join('\n'), {
		keywordCase: 'upper',
		commaStyle: 'leading',
		indentStyle: 'tab',
		maxAlignWidth: 150,
		caseWhenThenWrapLength: 80,
		dialect: 'mysql'
	}),
	[
		'SELECT  *',
		'FROM t',
		'WHERE a IN ( 1 # keep ) ) comment',
		'\tAND b = 2',
		'  )',
		''
	].join('\n'),
	'layout indentation must ignore parentheses inside MySQL hash line comments'
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
