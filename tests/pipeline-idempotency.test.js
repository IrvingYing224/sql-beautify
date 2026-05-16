var assert = require('assert');
var sqlShield = require('../lib/sql-shield');
var sqlRenderOptions = require('../lib/sql-render-options');
var sqlFormatPipeline = require('../lib/sql-format-pipeline');
var vkbeautify = require('../vkbeautify');

function format(sql) {
	return vkbeautify.sql(sql, true, false, true, 150, 80).trim();
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
		uppercase: false,
		comma_location: true,
		bracket_char: true,
		as_loc_cnt: 88,
		case_when_then_wrap_length: 33
	},
	'legacy options remain effective when new options are not explicitly configured'
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
		uppercase: true,
		comma_location: false,
		bracket_char: false,
		as_loc_cnt: 120,
		case_when_then_wrap_length: 33
	},
	'new options override legacy options when explicitly configured'
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
