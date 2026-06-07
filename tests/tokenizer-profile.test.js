var assert = require('assert');
var sqlFormatter = require('../lib/sql-formatter');
var formatterProfile = require('./helpers/formatter-profile');

function default_options(options) {
	return Object.assign({
		keywordCase: 'upper',
		commaStyle: 'leading',
		indentStyle: 'space',
		maxAlignWidth: 150,
		caseWhenThenWrapLength: 80,
		dialect: 'generic',
		unsupportedSyntaxPolicy: 'preserve'
	}, options || {});
}

function performance_corpus() {
	var simpleUnit = 'select a as col_a, b as col_b from t where x=1 and y=2;\n';
	var commentHeavyCaseUnit = [
		'select',
		'case when city_id in (',
		'1001, -- city one',
		'1002 -- city two',
		") then concat_ws(',', name, city)",
		"else 'unknown'",
		'end as city_label',
		'from dim_user',
		"where ds='2026-05-17' and status=1;"
	].join('\n') + '\n';
	var nestedListUnit = [
		'select *',
		'from fact_orders',
		'where coalesce(',
		'buyer_id,',
		'payer_id',
		') in (',
		'1001, -- buyer one',
		'1002 -- buyer two',
		')',
		'and exists(select 1 from dim_user u where u.id=fact_orders.buyer_id);'
	].join('\n') + '\n';

	return new Array(1001).join(simpleUnit)
		+ new Array(101).join(commentHeavyCaseUnit)
		+ new Array(101).join(nestedListUnit);
}

var differentialCorpus = [
	{
		name: 'cte case join window comments',
		sql: [
			'with src as (',
			'select a.user_id,',
			'case when a.city_id in (',
			'1001, -- 北京',
			'1002 -- 上海',
			') then 1 else 0 end as city_flag,',
			'row_number() over(partition by a.user_id order by a.dt desc,a.ts desc) as rn',
			'from dwd_orders a',
			'left join dim_user u',
			'on -- join condition',
			'a.user_id = u.user_id',
			"and u.dt = '2026-05-17'",
			')',
			'select * from src where rn=1'
		].join('\n'),
		options: {}
	},
	{
		name: 'hive hint and hash comments',
		sql: [
			'select --+ MAPJOIN(dim)',
			'a.id,',
			'case when a.status = 1 then a.name else null end as user_name',
			'from fact a',
			'where a.ds = "2026-05-17"'
		].join('\n'),
		options: { dialect: 'hive' }
	},
	{
		name: 'postgres dollar string and json operators',
		sql: "select $$CASE WHEN -- keep$$ as s, payload->>'id' as id from t where payload ? 'id'",
		options: { dialect: 'postgres' }
	}
];

var inputs = [performance_corpus()];
for (var i = 0; i < differentialCorpus.length; i++) {
	inputs.push(differentialCorpus[i].sql);
}
var originalChars = inputs.join('\n').length;

var result = formatterProfile.with_tokenizer_profile(originalChars, function() {
	var perfOutput = sqlFormatter.format_sql(inputs[0], default_options());
	assert.ok(perfOutput.indexOf('-- city one') >= 0, 'profile corpus preserves CASE comments');
	assert.ok(perfOutput.indexOf('-- buyer one') >= 0, 'profile corpus preserves nested list comments');

	for (var i = 0; i < differentialCorpus.length; i++) {
		var item = differentialCorpus[i];
		var once = sqlFormatter.format_sql(item.sql, default_options(item.options)).trim();
		var twice = sqlFormatter.format_sql(once, default_options(item.options)).trim();
		assert.strictEqual(twice, once, item.name + ' remains idempotent during profile run');
	}
});

var profile = result.profile;
var topCallers = formatterProfile.top_callers(profile, 8);

assert.ok(profile.calls > 0, 'profile must count tokenizer calls');
assert.ok(profile.totalChars >= originalChars, 'profile must count tokenized characters');
assert.ok(profile.charRatio > 0, 'profile must expose tokenized/original character ratio');
assert.ok(profile.calls < 5000, 'tokenizer call count must stay below wide regression guard; actual=' + profile.calls);
assert.ok(profile.charRatio < 25, 'tokenized character ratio must stay below wide regression guard; actual=' + profile.charRatio);
assert.ok(topCallers.length > 0, 'profile must report tokenizer call sites');

console.log('tokenizer profile calls=' + profile.calls
	+ ' chars=' + profile.totalChars
	+ ' ratio=' + profile.charRatio.toFixed(2)
	+ ' top=' + topCallers.map(function(item) {
		return item.calls + 'x ' + item.source;
	}).join(' | '));
