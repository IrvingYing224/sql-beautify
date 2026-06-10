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
	'select list split keeps as alignment and case ownership',
	'select a as a_col,b_long as b_col,case when x=1 then y else z end as c from t',
	[
		'SELECT  a                     AS a_col',
		'       ,b_long                AS b_col',
		'       ,CASE',
		'            WHEN x = 1 THEN y',
		'            ELSE z',
		'        END                   AS c',
		'FROM t'
	].join('\n')
);

run_case(
	'select item normalization stays inside select formatter',
	"select concat_ws('-', cast(id as string), name) as user_key,status as status from users",
	[
		"SELECT  concat_ws('-', CAST(id AS STRING), name) AS user_key",
		'       ,status                                   AS status',
		'FROM users'
	].join('\n')
);

run_case(
	'comma spacing normalizes function arguments and order keys',
	"select coalesce(phone,email,'unknown') as contact_info from users order by dt desc,event_time desc",
	[
		"SELECT  coalesce(phone, email, 'unknown') AS contact_info",
		'FROM users',
		'ORDER BY  dt DESC',
		'         ,event_time DESC'
	].join('\n')
);

run_case(
	'top-level order by keeps function args and in-list commas inline while splitting sort keys',
	"select id from users order by coalesce(last_login,created_at) desc,case when status in ('active','trial') then 0 else 1 end asc,id",
	[
		'SELECT  id',
		'FROM users',
		'ORDER BY  coalesce(last_login, created_at) DESC',
		"         ,CASE",
		"              WHEN status IN ('active', 'trial') THEN 0",
		'              ELSE 1',
		'          END ASC',
		'         ,id'
	].join('\n')
);

run_case(
	'continuation select lines split additional top level items after case expressions',
	[
		'select a.user_id as user_id,',
		'       a.user_name as name,',
		'       a.city as city_name,case',
		'                                when a.age is null then -1',
		'                                when a.age < 18 then 0',
		'                                else 1',
		'                            end as age_group,b.order_cnt as order_count,b.pay_amt as pay_amount,substr(c.last_login_time,1,10) as login_date',
		'from t'
	].join('\n'),
	[
		'SELECT  a.user_id                        AS user_id',
		'       ,a.user_name                      AS name',
		'       ,a.city                           AS city_name',
		'       ,CASE',
		'            WHEN a.age IS NULL THEN -1',
		'            WHEN a.age < 18    THEN 0',
		'            ELSE 1',
		'        END                              AS age_group',
		'       ,b.order_cnt                      AS order_count',
		'       ,b.pay_amt                        AS pay_amount',
		'       ,substr(c.last_login_time, 1, 10) AS login_date',
		'FROM t'
	].join('\n')
);

run_case(
	'unary minus keeps signed literal while binary minus stays spaced',
	'select -1 as neg_value,a-1 as delta from t',
	[
		'SELECT  -1    AS neg_value',
		'       ,a - 1 AS delta',
		'FROM t'
	].join('\n')
);

run_case(
	'unary signed literals after arithmetic operators keep prefix sign separate from binary operator',
	'select 1*-1 as mul_neg,1/-1 as div_neg,1*+2 as mul_pos from t',
	[
		'SELECT  1 * -1 AS mul_neg',
		'       ,1 / -1 AS div_neg',
		'       ,1 * +2 AS mul_pos',
		'FROM t'
	].join('\n')
);

var qualify_identifier_select_actual = format('select qualify as c, pivot as p from keyword_named_columns where pivot(p) = 1;');

assert.strictEqual(
	format(qualify_identifier_select_actual),
	qualify_identifier_select_actual,
	'QUALIFY-shaped select-list identifier with leading comma alignment must be idempotent\n--- actual ---\n' + qualify_identifier_select_actual
);

run_case(
	'standalone comment between select items keeps next item comma without orphan comma line',
	[
		'select a as x,b as y,',
		'-- cmt',
		'case when z=1 then 1 else 0 end as z from t'
	].join('\n'),
	[
		'SELECT  a                     AS x',
		'       ,b                     AS y',
		'       -- cmt',
		'       ,CASE',
		'            WHEN z = 1 THEN 1',
		'            ELSE 0',
		'        END                   AS z',
		'FROM t'
	].join('\n')
);

run_case(
	'production-style select keeps standalone comment and window field split',
	[
		'with src as (',
		'select a.dt as dt,a.user_id as user_id,',
		'-- 订单金额口径',
		'case when a.pay_amt > 0 then a.pay_amt else 0 end as pay_amt,row_number() over(partition by a.user_id order by a.dt desc,a.event_time desc) as rn',
		'from dwd_orders a',
		')',
		'select * from src'
	].join('\n'),
	[
		'WITH src AS',
		'(',
		'    SELECT  a.dt                                                                             AS dt',
		'           ,a.user_id                                                                        AS user_id',
		'           -- 订单金额口径',
		'           ,CASE',
		'                WHEN a.pay_amt > 0 THEN a.pay_amt',
		'                ELSE 0',
		'            END                                                                              AS pay_amt',
		'           ,ROW_NUMBER() OVER(PARTITION BY a.user_id ORDER BY  a.dt DESC, a.event_time DESC) AS rn',
		'    FROM dwd_orders a',
		')',
		'SELECT  *',
		'FROM src'
	].join('\n')
);

run_case(
	'select header trailing comment does not become a select item',
	[
		'SELECT   -- 获取活跃用户基本信息',
		'id, name -- 故意在逗号前面留一大堆空格',
		'-- 这里故意塞进一长串',
		'-- 连续的单行注释',
		'-- 用来测试插件是否会把它们合并，或者打乱缩进',
		"       ,sPlIt(hobbies,',') AS hobby_list",
		'FROM dim.user_info_raw -- 紧贴在表名后面的注释',
		"WHERE dt = '2026-05-17'",
		"  AND status = 'active' -- 仅保留活跃状态"
	].join('\n'),
	[
		'SELECT -- 获取活跃用户基本信息',
		'        id',
		'       ,name -- 故意在逗号前面留一大堆空格',
		'       -- 这里故意塞进一长串',
		'       -- 连续的单行注释',
		'       -- 用来测试插件是否会把它们合并，或者打乱缩进',
		"       ,sPlIt(hobbies, ',') AS hobby_list",
		'FROM dim.user_info_raw -- 紧贴在表名后面的注释',
		"WHERE dt = '2026-05-17'",
		"  AND status = 'active' -- 仅保留活跃状态"
	].join('\n')
);

var hive_hint_select_input = [
	'sElEcT   --+ MAPJOIN(tmp_user)',
	'-- 💥 终极测试点：Hive 专属的单行 Hint 格式 (--+)',
	'-- 绝大多数格式化工具（如 SQLFluff）遇到 `--+` 都会强行格式化为 `-- +`，从而直接导致 Hint 废掉！',
	'tmp_user.id   aS   u_id,',
	'tmp_user.name   ,   ',
	'h.hobby   as   single_hobby,',
	'nVl(t2.act_days,0)   +   1   as   score,   -- 基础分 +1（测试行尾对齐）',
	'rOw_NuMbEr()   oVeR(   pArTiTiOn   bY   h.hobby   oRdEr   bY   nVl(t2.act_days,0)   dEsC   rOwS   bEtWeEn   uNbOuNdEd   pReCeDiNg   aNd   cUrReNt   rOw)   As   rank_id  -- 极其冗长的窗口边界定义',
	'fRoM   tmp_user'
].join('\n');
var hive_hint_select_actual = format(hive_hint_select_input);

assert.ok(
	hive_hint_select_actual.indexOf('SELECT --+ MAPJOIN(tmp_user)') == 0,
	'Hive --+ hint after SELECT must keep marker spacing\n--- actual ---\n' + hive_hint_select_actual
);
assert.ok(
	hive_hint_select_actual.indexOf('-- + MAPJOIN') < 0,
	'Hive --+ hint must not be normalized to a plain comment\n--- actual ---\n' + hive_hint_select_actual
);
assert.ok(
	hive_hint_select_actual.indexOf('\n        tmp_user.id') >= 0,
	'first real select item after SELECT hint should be indented without a leading comma\n--- actual ---\n' + hive_hint_select_actual
);
assert.ok(
	hive_hint_select_actual.indexOf('\n       ,tmp_user.id') < 0,
	'first real select item after SELECT hint must not receive a leading comma\n--- actual ---\n' + hive_hint_select_actual
);
assert.ok(
	hive_hint_select_actual.indexOf('\n       tmp_user.id') < 0,
	'first real select item after SELECT hint should align code with following comma-prefixed items\n--- actual ---\n' + hive_hint_select_actual
);
assert.strictEqual(
	format(hive_hint_select_actual),
	hive_hint_select_actual,
	'Hive hint select formatting should be idempotent\n--- actual ---\n' + hive_hint_select_actual
);

run_case(
	'select comma migration never touches nested in-list or function arguments',
	[
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
	].join('\n'),
	[
		'SELECT',
		'       CASE',
		'           WHEN city_id IN (',
		'                   1001, -- 北京',
		'                   1002, -- 上海',
		'                   1003  -- 广州',
		"               ) THEN concat_ws(',', name, city)",
		'           ELSE',
		"               'unknown'",
		'       END                                       AS city_label',
		'       ,coalesce(phone, -- 手机',
		'           email,    -- 邮箱',
		"           'unknown' -- 兜底",
		'       )                                         AS contact',
		'FROM t'
	].join('\n')
);

console.log('select alignment tests passed');
