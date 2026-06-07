var assert = require('assert');
var sqlFormatter = require('../lib/sql-formatter');
var sqlSelectMutations = require('../lib/core/sql-select-mutations');
var sqlCaseMutations = require('../lib/core/sql-case-mutations');
var sqlConditionMutations = require('../lib/core/sql-condition-mutations');
var sqlCommentMutations = require('../lib/core/sql-comment-mutations');

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

var input = [
	'select',
	'case -- CASE comment',
	'when a = 1 -- condition comment',
	"then 'x' -- result comment",
	"else 'z'",
	'end as flag,',
	'coalesce(phone, -- phone',
	'email, -- email',
	"'unknown' -- fallback",
	') as contact',
	'from t'
].join('\n');

var actual = format(input);

assert.ok(actual.indexOf("-- condition comment THEN 'x'") < 0, 'THEN is never appended after WHEN comment');
assert.ok(actual.indexOf('AS flag, --') < 0, 'leading comma style must not keep duplicate trailing comma before comment');
assert.ok(actual.indexOf(',coalesce') >= 0, 'next select item keeps leading comma');
assert.strictEqual(format(actual), actual, 'structured pipeline output is idempotent');

assert.strictEqual(
	typeof sqlSelectMutations.apply_select_list_mutations,
	'function',
	'structured SELECT mutation module must expose apply_select_list_mutations'
);
assert.strictEqual(
	typeof sqlCaseMutations.apply_case_mutations,
	'function',
	'structured CASE mutation module must expose apply_case_mutations'
);
assert.strictEqual(
	typeof sqlConditionMutations.apply_condition_mutations,
	'function',
	'structured condition mutation module must expose apply_condition_mutations'
);
assert.strictEqual(
	typeof sqlCommentMutations.apply_comment_alignment_mutations,
	'function',
	'structured comment mutation module must expose apply_comment_alignment_mutations'
);

var nestedSelectActual = format([
	'select',
	'case when city_id in (',
	'1001, -- 北京',
	'1002, -- 上海',
	'1003 -- 广州',
	") then concat_ws(',', name, city)",
	"else 'unknown'",
	'end as city_label,',
	'coalesce(phone, -- 手机',
	'email, -- 邮箱',
	"'unknown' -- 兜底",
	') as contact',
	'from t'
].join('\n'));

assert.ok(nestedSelectActual.indexOf('1001, -- 北京') >= 0, 'IN-list comma before comment is preserved');
assert.ok(nestedSelectActual.indexOf('1002, -- 上海') >= 0, 'second IN-list comma before comment is preserved');
assert.ok(nestedSelectActual.indexOf("concat_ws(',', name, city)") >= 0, 'CASE branch function argument comma spaces are preserved');
assert.ok(/\n\s*,coalesce/.test(nestedSelectActual), 'top-level select separator moves to next item only');
assert.ok(
	nestedSelectActual.indexOf('\n           email,    -- 邮箱') >= 0,
	'structured SELECT function item aligns comments inside multiline function arguments'
);
assert.ok(
	nestedSelectActual.indexOf('\n       )                                         AS contact') >= 0,
	'structured SELECT function item aligns close paren and alias with sibling select items'
);

var closeIndentActual = format([
	'select *',
	'from (',
	'    select 1',
	'        ) x'
].join('\n'));

assert.ok(closeIndentActual.indexOf('\n) x') >= 0, 'closing paren line uses scope close indent');

var keywordActual = format([
	"select 'select from where case when then' as s,",
	'`select from where` as ident -- select from where case when then',
	'from t'
].join('\n'));

assert.ok(/^SELECT\b/.test(keywordActual), 'structured keyword mutation uppercases active SQL keywords');
assert.ok(keywordActual.indexOf("'select from where case when then'") >= 0, 'structured keyword mutation preserves strings');
assert.ok(keywordActual.indexOf('`select from where`') >= 0, 'structured keyword mutation preserves quoted identifiers');
assert.ok(keywordActual.indexOf('-- select from where case when then') >= 0, 'structured keyword mutation preserves comments');

var commentActual = format([
	'select a -- short',
	'b_long_name -- long',
	'from t'
].join('\n'));

assert.ok(commentActual.indexOf('SELECT  a   -- short') >= 0, 'structured comment mutation aligns trailing comments');
assert.ok(commentActual.indexOf('b_long_name -- long') >= 0, 'structured comment mutation keeps widest trailing comment stable');

assert.strictEqual(
	format([
		'select a,b',
		'from t',
		'where x=1',
		'and y=2'
	].join('\n')),
	[
		'SELECT  a',
		'       ,b',
		'FROM t',
		'WHERE x = 1',
		'  AND y = 2'
	].join('\n'),
	'structured pipeline formats basic select list and condition alignment'
);

assert.strictEqual(
	format('select a from t where x=1'),
	[
		'SELECT  a',
		'FROM t',
		'WHERE x = 1'
	].join('\n'),
	'structured pipeline splits same-line FROM and WHERE clauses from token model'
);

assert.strictEqual(
	format("select * from a left join b on a.id=b.id and b.ds='2026-05-17'"),
	[
		'SELECT  *',
		'FROM a',
		'LEFT JOIN b',
		'     ON a.id = b.id',
		"    AND b.ds = '2026-05-17'"
	].join('\n'),
	'structured pipeline splits same-line JOIN, ON, and AND clauses from token model'
);

var structuredWindowJoinActual = format([
	'select row_number() over(partition by a.user_id order by a.dt desc,a.ts desc) as rn',
	'from dwd_orders a',
	'left join dim_user u',
	'on a.user_id = u.user_id'
].join('\n'));

assert.ok(
	structuredWindowJoinActual.indexOf('LEFT\nJOIN') < 0,
	'structured clause mutation keeps multi-token JOIN clause together'
);
assert.ok(
	structuredWindowJoinActual.indexOf('OVER (PARTITION BY a.user_id\nORDER BY') < 0,
	'structured clause mutation does not split ORDER BY inside window spec'
);
assert.ok(
	structuredWindowJoinActual.indexOf('ROW_NUMBER() OVER(PARTITION BY a.user_id ORDER BY  a.dt DESC,a.ts DESC)') >= 0,
	'structured renderer preserves existing ROW_NUMBER window spacing contract'
);

var postgresJsonActual = sqlFormatter.format_sql(
	"select payload->>'id' as id from t where payload ? 'id'",
	{
		keywordCase: 'upper',
		commaStyle: 'leading',
			indentStyle: 'space',
			maxAlignWidth: 150,
			caseWhenThenWrapLength: 80,
			dialect: 'postgres'
		}
	).trim();

assert.ok(
	postgresJsonActual.indexOf("payload->>'id'") >= 0,
	'structured renderer preserves no-space PostgreSQL json extraction operator'
);

var hiveHintActual = sqlFormatter.format_sql(
	[
		'select --+ MAPJOIN(dim)',
		'a.id,',
		'b.name',
		'from fact a'
	].join('\n'),
	{
		keywordCase: 'upper',
		commaStyle: 'leading',
			indentStyle: 'space',
			maxAlignWidth: 150,
			caseWhenThenWrapLength: 80,
			dialect: 'hive'
		}
	).trim();

assert.ok(
	hiveHintActual.indexOf('\n        a.id') >= 0,
	'structured SELECT pass indents first select item after Hive hint line even when it has a separator'
);

assert.strictEqual(
	format([
		'with src as (',
		'select 1 as a',
		')',
		'select * from src'
	].join('\n')),
	[
		'WITH src AS',
		'(',
		'    SELECT  1 AS a',
		')',
		'SELECT  *',
		'FROM src'
	].join('\n'),
	'structured renderer splits CTE query opening paren onto its own line'
);

assert.strictEqual(
	format([
		'with a as (select user_id,sum(amount) as total_amount -- total',
		'from orders group by user_id) select user_id,total_amount from a'
	].join('\n')),
	[
		'WITH a AS',
		'(',
		'    SELECT  user_id',
		'           ,SUM(amount) AS total_amount -- total',
		'    FROM orders',
		'    GROUP BY  user_id',
		')',
		'SELECT  user_id',
		'       ,total_amount',
		'FROM a'
	].join('\n'),
	'structured renderer splits compact CTE query scope boundaries'
);

assert.strictEqual(
	format([
		"insert overwrite table dwd.user_sum partition(dt='2026-04-22') select user_id,sum(amount) as total_amount -- total",
		'from orders group by user_id'
	].join('\n')),
	[
		"INSERT OVERWRITE TABLE dwd.user_sum PARTITION(dt = '2026-04-22')",
		'SELECT  user_id',
		'       ,SUM(amount) AS total_amount -- total',
		'FROM orders',
		'GROUP BY  user_id'
	].join('\n'),
	'structured clause mutation splits INSERT target before SELECT query'
);

var longFunctionItemActual = format([
	'select',
	'    u.user_id as user_id,-- user id',
	'    concat_ws(',
	"        '-',",
	'        cast(u.user_id as string),',
	"        nvl(trim(u.user_name), 'unknown'),",
	"        regexp_replace(date_format(from_unixtime(unix_timestamp(u.create_time, 'yyyy-MM-dd HH:mm:ss')), 'yyyyMMddHHmmss'), '-', '')",
	'    ) as user_profile_key,-- profile key',
	'    u.status as status -- status',
	'from users u'
].join('\n'));

assert.ok(
	longFunctionItemActual.indexOf("       ,concat_ws( '-',CAST(u.user_id AS STRING),nvl(trim(u.user_name),'unknown'),regexp_replace") >= 0,
	'structured SELECT pass collapses over-threshold multiline function item to one logical select item'
);
assert.strictEqual(format(longFunctionItemActual), longFunctionItemActual, 'collapsed multiline function select item is idempotent');

assert.strictEqual(
	format([
		'select *',
		'from t'
	].join('\n')),
	[
		'SELECT  *',
		'FROM t'
	].join('\n'),
	'structured pipeline preserves the existing SELECT star spacing contract'
);

assert.strictEqual(
	format([
		'select',
		"case when a=1 then 'x' else 'z' end as flag",
		'from t'
	].join('\n')),
	[
		'SELECT',
		'       CASE',
		"           WHEN a = 1 THEN 'x'",
		"           ELSE 'z'",
		'       END                     AS flag',
		'FROM t'
	].join('\n'),
	'structured pipeline formats single-line CASE expression from case nodes'
);

var structuredCaseInListActual = format([
	'select case when city_id in (',
	'1001, -- 北京',
	'1002 -- 上海',
	") then 'x' else 'z' end as flag",
	'from t'
].join('\n'));

assert.ok(
	structuredCaseInListActual.indexOf('\n                   1001, -- 北京') >= 0,
	'structured CASE pass keeps IN-list body at CASE value indentation'
);
assert.ok(
	structuredCaseInListActual.indexOf("\n               ) THEN 'x'") >= 0,
	'structured CASE pass keeps multiline IN-list close paren and THEN on one active SQL line'
);
assert.ok(
	structuredCaseInListActual.indexOf("\n               THEN 'x'") < 0,
	'structured CASE pass must not detach THEN from an uncommented multiline IN-list close paren'
);
assert.ok(
	structuredCaseInListActual.indexOf("\n           ELSE\n               'z'") >= 0,
	'structured CASE pass wraps ELSE value when a WHEN condition is multiline'
);
assert.ok(
	structuredCaseInListActual.indexOf('\n       END                   AS flag') >= 0,
	'structured CASE pass aligns END alias spacing from rendered CASE branch width'
);

var nestedCaseActual = format([
	'select',
	"case when a=1 then case when b=2 then 'x' else 'y' end else 'z' end as flag",
	'from t'
].join('\n'));

assert.ok(
	nestedCaseActual.indexOf("WHEN a = 1 THEN CASE WHEN b = 2 THEN 'x' ELSE 'y' END") >= 0,
	'nested CASE inside THEN stays inside the outer branch value'
);
assert.ok(
	nestedCaseActual.indexOf("THEN\n       CASE") < 0,
	'nested CASE inside THEN must not be split as an outer CASE block'
);

var structuredOnCommentActual = format([
	'select *',
	'from a',
	'left join b',
	'on -- join condition',
	'a.id=b.id -- c1',
	"and b.dt='2026-05-17' -- c2"
].join('\n'));

assert.ok(
	structuredOnCommentActual.indexOf('\n     ON -- join condition') >= 0,
	'condition keyword-only comment stays attached to ON without column alignment'
);
assert.ok(
	structuredOnCommentActual.indexOf('ON                   -- join condition') < 0,
	'condition keyword-only comment is not widened by structured comment alignment'
);

var nestedConditionActual = format([
	'select *',
	'from t',
	'where a=1',
	'and (',
	"status='paid'",
	"or refund_status='none'",
	') -- close'
].join('\n'));

assert.ok(
	nestedConditionActual.indexOf('\n  AND (') >= 0,
	'structured condition renderer preserves a space before nested boolean paren'
);
assert.ok(
	nestedConditionActual.indexOf('\n   OR refund_status') < 0,
	'nested OR inside condition parenList is not aligned as a top-level OR'
);

var structuredInListActual = format([
	'select *',
	'from t',
	'where city_id in (',
	'1001, -- 北京',
	'1002 -- 上海',
	') -- close',
	'and status=1'
].join('\n'));

assert.ok(
	structuredInListActual.indexOf('\n    1001, -- 北京') >= 0,
	'structured renderer indents IN-list body from scope bodyIndent'
);
assert.ok(
	structuredInListActual.indexOf('\n    1002 -- 上海') >= 0,
	'structured renderer indents later IN-list body lines from scope bodyIndent'
);
assert.ok(
	structuredInListActual.indexOf('\n  ) -- close') >= 0,
	'structured renderer keeps IN-list close paren on condition close indent'
);

var structuredFunctionActual = format([
	'select *',
	'from t',
	'where coalesce(',
	'a,',
	'b',
	')=1',
	'and y=2'
].join('\n'));

assert.ok(
	structuredFunctionActual.indexOf('\n    a,') >= 0 && structuredFunctionActual.indexOf('\n    b') >= 0,
	'structured renderer indents function-call body lines from scope bodyIndent'
);
assert.ok(
	structuredFunctionActual.indexOf('\n  ) = 1') >= 0,
	'structured renderer keeps function-call close line on condition close indent'
);

console.log('structured pipeline regression tests passed');
