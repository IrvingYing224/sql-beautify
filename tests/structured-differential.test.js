var assert = require('assert');
var sqlFormatter = require('../lib/sql-formatter');

function format(sql, options) {
	return sqlFormatter.format_sql(sql, Object.assign({
		keywordCase: 'upper',
		commaStyle: 'leading',
		indentStyle: 'space',
		maxAlignWidth: 150,
		caseWhenThenWrapLength: 80,
		dialect: 'generic',
		unsupportedSyntaxPolicy: 'preserve'
	}, options || {})).trim();
}

var corpus = [
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
		assertions: function(output) {
			assert.ok(output.indexOf('-- 北京') >= 0, 'CTE corpus preserves IN-list comment');
			assert.ok(output.indexOf('-- join condition') >= 0, 'CTE corpus preserves ON comment');
			assert.ok(output.indexOf('\n,\n') < 0, 'CTE corpus must not create standalone comma lines');
		}
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
		options: { dialect: 'hive' },
		assertions: function(output) {
			assert.ok(output.indexOf('--+ MAPJOIN(dim)') >= 0, 'Hive corpus preserves hint comment');
			assert.ok(output.indexOf('\n,\n') < 0, 'Hive corpus must not create standalone comma lines');
		}
	},
	{
		name: 'postgres dollar string and json operators',
		sql: "select $$CASE WHEN -- keep$$ as s, payload->>'id' as id from t where payload ? 'id'",
		options: { dialect: 'postgres' },
		assertions: function(output) {
			assert.ok(output.indexOf('$$CASE WHEN -- keep$$') >= 0, 'Postgres corpus preserves dollar string');
			assert.ok(output.indexOf("payload->>'id'") >= 0, 'Postgres corpus preserves json operator tokens');
		}
	}
];

corpus.forEach(function(item) {
	var once = format(item.sql, item.options);
	var twice = format(once, item.options);
	assert.strictEqual(twice, once, item.name + ' must be idempotent');
	assert.ok(once.indexOf('-- keep THEN') < 0, item.name + ' must not synthesize comment/code text');
	item.assertions(once);
});

console.log('structured differential tests passed');
