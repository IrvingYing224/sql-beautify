var assert = require('assert');
var vkbeautify = require('../vkbeautify');

function format(sql) {
	return vkbeautify.sql(sql, true, false, true, 150, 80).trim();
}

function format_lower(sql) {
	return vkbeautify.sql(sql, false, false, true, 150, 80).trim();
}

function run_case(name, input, expected) {
	var actual = format(input);
	assert.strictEqual(actual, expected.trim(), name + '\n--- actual ---\n' + actual + '\n--- expected ---\n' + expected.trim());
}

function run_lower_case(name, input, expected) {
	var actual = format_lower(input);
	assert.strictEqual(actual, expected.trim(), name + '\n--- actual ---\n' + actual + '\n--- expected ---\n' + expected.trim());
}

function align_as(code, targetWidth, alias) {
	return code + ' '.repeat(targetWidth - code.length) + ' AS ' + alias;
}

function align_comment(code, targetWidth, comment) {
	return code + ' '.repeat(targetWidth - code.length) + '-- ' + comment;
}

run_case(
	'cte with aggregate subquery keeps hive layout',
	[
		"with a as (select user_id,sum(amount) as total_amount -- 总额",
		"from orders group by user_id) select user_id,total_amount from a"
	].join('\n'),
	[
		'WITH a AS',
		'(',
		'    SELECT  user_id',
		'           ,SUM(amount) AS total_amount -- 总额',
		'    FROM orders',
		'    GROUP BY  user_id',
		')',
		'SELECT  user_id',
		'       ,total_amount',
		'FROM a'
	].join('\n')
);

run_case(
	'window function keeps over partition order layout',
	[
		"select user_id,row_number() over(partition by ds order by pay_time desc) as rn -- 排名",
		"from orders"
	].join('\n'),
	[
		'SELECT  user_id',
		'       ,ROW_NUMBER() OVER(PARTITION BY ds ORDER BY  pay_time DESC) AS rn -- 排名',
		'FROM orders'
	].join('\n')
);

run_case(
	'lateral view explode keeps hive from clause layout',
	[
		"select user_id,tag -- 标签",
		"from user_tags lateral view explode(tags) tmp as tag"
	].join('\n'),
	[
		'SELECT  user_id',
		'       ,tag -- 标签',
		'FROM user_tags LATERAL VIEW EXPLODE(tags) tmp AS tag'
	].join('\n')
);

run_case(
	'insert overwrite partition keeps select aggregate block',
	[
		"insert overwrite table dwd.user_sum partition(dt='2026-04-22') select user_id,sum(amount) as total_amount -- 总金额",
		"from orders group by user_id"
	].join('\n'),
	[
		"INSERT OVERWRITE TABLE dwd.user_sum PARTITION(dt = '2026-04-22')",
		'SELECT  user_id',
		'       ,SUM(amount) AS total_amount -- 总金额',
		'FROM orders',
		'GROUP BY  user_id'
	].join('\n')
);

run_case(
	'long nested expression respects as alignment threshold for comments',
	[
		'select',
		'    u.user_id as user_id,-- 用户ID',
		'    concat_ws(',
		"        '-',",
		'        cast(u.user_id as string),',
		"        nvl(trim(u.user_name), 'unknown'),",
		"        regexp_replace(date_format(from_unixtime(unix_timestamp(u.create_time, 'yyyy-MM-dd HH:mm:ss')), 'yyyyMMddHHmmss'), '-', '')",
		'    ) as user_profile_key,-- 用户画像Key',
		'    u.status as status,-- 状态',
		'    u.dt as dt -- 分区日期',
		'from users u;'
	].join('\n'),
	[
		'SELECT  u.user_id AS user_id -- 用户ID',
		"       ,concat_ws( '-', CAST(u.user_id AS STRING), nvl(trim(u.user_name), 'unknown'), regexp_replace(date_format(from_unixtime(unix_timestamp(u.create_time, 'yyyy-MM-dd HH:mm:ss')), 'yyyyMMddHHmmss'), '-', '') ) AS user_profile_key -- 用户画像Key",
		'       ,u.status  AS status  -- 状态',
		'       ,u.dt      AS dt      -- 分区日期',
		'FROM users u;'
	].join('\n')
);

run_case(
	'aggregate case columns keep hive syntax and aligned comments',
	[
		'select',
		'    o.user_id as user_id,-- 用户ID',
		"    sum(case when o.status = 'SUCCESS' and o.pay_time is not null then coalesce(o.amount, 0) else 0 end) as success_paid_amount,-- 成功支付金额",
		"    count(distinct case when o.status = 'SUCCESS' and coalesce(o.amount, 0) > 0 then o.order_id else null end) as success_order_cnt,-- 成功订单数",
		'    max(o.pay_time) as last_pay_time -- 最近支付时间',
		'from orders o',
		'group by o.user_id;'
	].join('\n'),
	[
		align_comment(align_as('SELECT  o.user_id', 98, 'user_id'), 122, '用户ID'),
		'       ,SUM(CASE',
		"                WHEN o.status = 'SUCCESS' AND o.pay_time IS NOT NULL THEN coalesce(o.amount, 0)",
		'                ELSE 0',
		align_comment(align_as('            END)', 98, 'success_paid_amount'), 122, '成功支付金额'),
		'       ,COUNT(DISTINCT CASE',
		"                           WHEN o.status = 'SUCCESS' AND coalesce(o.amount, 0) > 0 THEN o.order_id",
		'                           ELSE NULL',
		align_comment(align_as('                       END)', 98, 'success_order_cnt'), 122, '成功订单数'),
		align_comment(align_as('       ,MAX(o.pay_time)', 98, 'last_pay_time'), 122, '最近支付时间'),
		'FROM orders o',
		'GROUP BY  o.user_id;'
	].join('\n')
);

run_case(
	'nested aggregate case keeps inner case inline',
	[
		'select',
		"    sum(case when o.status = 'SUCCESS' then case when o.amount > 0 then o.amount else 0 end else 0 end) as paid_amount -- 已支付金额",
		'from orders o;'
	].join('\n'),
	[
		'SELECT  SUM(CASE',
		"                WHEN o.status = 'SUCCESS' THEN CASE WHEN o.amount > 0 THEN o.amount ELSE 0 END",
		'                ELSE 0',
		align_comment(align_as('            END)', 94, 'paid_amount'), 110, '已支付金额'),
		'FROM orders o;'
	].join('\n')
);

run_case(
	'having inline case becomes uppercase case block',
	[
		'SELECT  o.user_id                 AS user_id                                                                              -- 用户ID',
		'       ,SUM(coalesce(o.amount,0)) AS total_amount                                                                         -- 总金额',
		'       ,COUNT(*)                  AS order_cnt                                                                            -- 订单数',
		'FROM orders o',
		'GROUP BY  o.user_id',
		"HAVING SUM(coalesce(o.amount, 0)) > 1000 AND COUNT(*) >= 3 AND MAX(case WHEN o.status = 'SUCCESS' THEN 1 else 0 end) = 1; -- 分组过滤条件"
	].join('\n'),
	[
		'SELECT  o.user_id                  AS user_id      -- 用户ID',
		'       ,SUM(coalesce(o.amount, 0)) AS total_amount -- 总金额',
		'       ,COUNT(*)                   AS order_cnt    -- 订单数',
		'FROM orders o',
		'GROUP BY  o.user_id',
		'HAVING SUM(coalesce(o.amount, 0)) > 1000',
		'   AND COUNT(*) >= 3',
		'   AND MAX(CASE',
		"               WHEN o.status = 'SUCCESS' THEN 1",
		'               ELSE 0',
		'           END) = 1;                               -- 分组过滤条件'
	].join('\n')
);

run_case(
	'where case keeps boolean condition inside branch',
	[
		"select u.user_id as user_id, u.user_name as user_name, case when u.status='active' and u.age>=18 then 'valid_user' else 'invalid_user' end as user_flag",
		'from users u',
		"where case when u.city='NY' and u.age>25 then 1 else 0 end = 1;"
	].join(' '),
	[
		'SELECT  u.user_id                                                      AS user_id',
		'       ,u.user_name                                                    AS user_name',
		'       ,CASE',
		"            WHEN u.status = 'active' AND u.age >= 18 THEN 'valid_user'",
		"            ELSE 'invalid_user'",
		'        END                                                            AS user_flag',
		'FROM users u',
		'WHERE CASE',
		"          WHEN u.city = 'NY' AND u.age > 25 THEN 1",
		'          ELSE 0',
		'      END = 1;'
	].join('\n')
);

var commented_multiline_conditions_actual = format([
	'select',
	'case -- CASE 内部注释',
	'when u.age < 18 -- 年龄条件',
	"then 'child' -- 结果1",
	'when u.age between 18 and 60 -- 条件2',
	"then 'adult' -- 结果2",
	"else 'senior' -- 默认结果",
	'end as age_phase',
	'from dim.user_info u',
	'join fact.order_info o',
	'on -- ON 关键字单独成行',
	'u.id = o.user_id -- 关联条件1',
	"and o.dt = '2026-05-17' -- 关联条件2",
	"where u.dt = '2026-05-17'",
	'and u.city_id in ( -- 跨行 IN 列表',
	'1001, -- 北京',
	'1002, -- 上海',
	'-- 夹在IN列表中间的独立注释',
	'1003, -- 广州',
	'1004 -- 深圳',
	') -- IN 右括号',
	'and ( -- 多层逻辑括号',
	"o.pay_status = 'paid' -- 状态限制",
	"or o.refund_status = 'none' -- 退款限制",
	') -- 逻辑右括号'
].join('\n'));

assert.ok(
	commented_multiline_conditions_actual.indexOf("-- 年龄条件 THEN 'child'") < 0,
	'CASE WHEN trailing comment must not consume following THEN\n--- actual ---\n' + commented_multiline_conditions_actual
);
assert.ok(
	/WHEN u\.age < 18\s+-- 年龄条件\n\s+THEN 'child'\s+-- 结果1/.test(commented_multiline_conditions_actual),
	'CASE WHEN trailing comment should keep THEN on an active SQL line\n--- actual ---\n' + commented_multiline_conditions_actual
);
assert.ok(
	commented_multiline_conditions_actual.indexOf('\n    1001, -- 北京') >= 0
		&& commented_multiline_conditions_actual.indexOf('\n    1002, -- 上海') >= 0
		&& commented_multiline_conditions_actual.indexOf('\n    1003, -- 广州') >= 0,
	'IN-list value commas before trailing comments must be preserved\n--- actual ---\n' + commented_multiline_conditions_actual
);
assert.ok(
	commented_multiline_conditions_actual.indexOf('\n  ) -- IN 右括号\n  AND (') >= 0,
	'condition-list closing paren and following AND should inherit WHERE block indentation\n--- actual ---\n' + commented_multiline_conditions_actual
);
assert.ok(
	commented_multiline_conditions_actual.indexOf('\n     ON -- ON 关键字单独成行\n        u.id = o.user_id') >= 0,
	'first ON condition after an ON-only comment line should inherit the ON block indentation\n--- actual ---\n' + commented_multiline_conditions_actual
);

var commented_case_item_separator_actual = format([
	'select',
	'case -- CASE 注释',
	'when a = 1 -- 条件注释',
	"then 'x' -- 结果注释",
	"else 'z'",
	'end as age_phase, -- CASE 结束注释',
	'coalesce(phone, -- 手机',
	'email, -- 邮箱',
	"'unknown' -- 兜底",
	') as contact',
	'from t'
].join('\n'));

assert.ok(
	commented_case_item_separator_actual.indexOf('AS age_phase, -- CASE 结束注释\n       ,coalesce') < 0,
	'CASE select item separator should not remain both trailing and leading\n--- actual ---\n' + commented_case_item_separator_actual
);
assert.ok(
	commented_case_item_separator_actual.indexOf('AS age_phase -- CASE 结束注释\n       ,coalesce') >= 0,
	'CASE select item separator should use the existing leading-comma style after a trailing comment\n--- actual ---\n' + commented_case_item_separator_actual
);
assert.ok(
	/\n       \)\s+AS contact/.test(commented_case_item_separator_actual),
	'multiline select expression closing paren should inherit the select item indentation\n--- actual ---\n' + commented_case_item_separator_actual
);

var bracket_index_actual = format([
	"SELECT  u.matrix ['level' ]                         AS vl      -- Map 类型：故意在方括号内部留空格",
	"       ,u.info.base.gender                          AS gen     -- Struct 类型：故意在点号前后留空格",
	"       ,u.tags [0 ]                                 AS ain_tag -- Array 类型：紧贴与断开测试",
	"       ,CAST( SUM( u.order_amt ) AS DECIMAL(10,2) ) AS amt",
	"       ,gRoUpInG__iD                                AS gid     -- Hive 独有增强聚合内置变量",
	"FROM dim.user_complex_profile u",
	"WHERE dt = '2026-05-17'",
	"  AND u.matrix [ 'status' ] = 'active'",
	"GROUP BY  u.matrix ['level' ]",
	"         ,u.info.base.gender",
	"         ,u.tags [0 ]",
	"         ,WITH GROUPING SETS ( ( u.matrix ['level' ],u.info.base.gender ) -- 组合一",
	"             ,( u.tags [0 ] )                                             -- 组合二",
	"             ,( )                                                         -- 空聚合组合",
	");"
].join('\n'));

[
	"u.matrix['level']",
	"u.tags[0]",
	"u.matrix['status']",
	"WITH GROUPING SETS ( ( u.matrix['level'], u.info.base.gender )",
	"AS vl",
	"AS ain_tag"
].forEach(function(expected) {
	assert.ok(
		bracket_index_actual.indexOf(expected) >= 0,
		'Hive bracket index spacing should be compact for ' + expected + '\n--- actual ---\n' + bracket_index_actual
	);
});

[
	"matrix ['level' ]",
	"matrix [ 'status' ]",
	"tags [0 ]",
	",WITH GROUPING SETS"
].forEach(function(forbidden) {
	assert.strictEqual(
		bracket_index_actual.indexOf(forbidden),
		-1,
		'Hive bracket index spacing should not keep padded form ' + forbidden + '\n--- actual ---\n' + bracket_index_actual
	);
});

run_case(
	'hive group by with cube and rollup are suffixes without leading comma',
	[
		'select a,b,count(*) as cnt from t group by a,b with cube',
		'union all',
		'select a,b,count(*) as cnt from t group by a,b with rollup'
	].join('\n'),
	[
		'SELECT  a',
		'       ,b',
		'       ,COUNT(*) AS cnt',
		'FROM t',
		'GROUP BY  a',
		'         ,b',
		'          WITH CUBE',
		'UNION ALL',
		'SELECT  a',
		'       ,b',
		'       ,COUNT(*) AS cnt',
		'FROM t',
		'GROUP BY  a',
		'         ,b',
		'          WITH ROLLUP'
	].join('\n')
);

run_case(
	'hive group by with grouping sets is a suffix without leading comma',
	'select a,b,count(*) from t group by a,b with grouping sets ((a,b),(a),())',
	[
		'SELECT  a',
		'       ,b',
		'       ,COUNT(*)',
		'FROM t',
		'GROUP BY  a',
		'         ,b',
		'          WITH GROUPING SETS ((a, b),(a),())'
	].join('\n')
);

run_case(
	'where and-case condition keeps end aligned with case',
	[
		'SELECT  u.user_id   AS user_id',
		'       ,u.user_name AS user_name',
		'       ,o.order_id  AS order_id',
		'       ,o.amount    AS amount',
		'       ,CASE WHEN o.amount > 0 AND o.order_id is not null THEN o.amount  ELSE 0 END  as cc',
		'FROM users u',
		'LEFT JOIN orders o',
		'     ON u.user_id = o.user_id',
		"    AND o.status = 'SUCCESS'",
		'    AND o.amount > 0',
		"WHERE u.status = 'active'",
		"  AND (u.age >= 18 OR u.city = 'NY')",
		"  AND nvl(u.user_name, '') <> ''",
		'  AND CASE WHEN o.amount > 0 AND o.order_id is not null THEN o.amount  ELSE 0 END > 50',
		"  AND dt BETWEEN '2021-01-01' AND '2022-12-31'",
		';'
	].join('\n'),
	[
		'SELECT  u.user_id                                                      AS user_id',
		'       ,u.user_name                                                    AS user_name',
		'       ,o.order_id                                                     AS order_id',
		'       ,o.amount                                                       AS amount',
		'       ,CASE',
		'            WHEN o.amount > 0 AND o.order_id IS NOT NULL THEN o.amount',
		'            ELSE 0',
		'        END                                                            AS cc',
		'FROM users u',
		'LEFT JOIN orders o',
		'     ON u.user_id = o.user_id',
		"    AND o.status = 'SUCCESS'",
		'    AND o.amount > 0',
		"WHERE u.status = 'active'",
		"  AND (u.age >= 18 OR u.city = 'NY')",
		"  AND nvl(u.user_name, '') <> ''",
		'  AND CASE',
		'          WHEN o.amount > 0 AND o.order_id IS NOT NULL THEN o.amount',
		'          ELSE 0',
		'      END > 50',
		"  AND dt BETWEEN '2021-01-01' AND '2022-12-31'",
		';'
	].join('\n')
);

run_case(
	'having case keeps boolean condition inside aggregate branch',
	[
		'select o.user_id,count(*) as order_cnt',
		'from orders o',
		'group by o.user_id',
		"having max(case when o.status='SUCCESS' and o.pay_time is not null then 1 else 0 end) = 1 and count(*)>1;"
	].join(' '),
	[
		'SELECT  o.user_id',
		'       ,COUNT(*)  AS order_cnt',
		'FROM orders o',
		'GROUP BY  o.user_id',
		'HAVING MAX(CASE',
		"               WHEN o.status = 'SUCCESS' AND o.pay_time IS NOT NULL THEN 1",
		'               ELSE 0',
		'           END) = 1',
		'   AND COUNT(*) > 1;'
	].join('\n')
);

run_case(
	'condition clauses align keyword tails and protect nested boolean expressions',
	[
		"select u.user_id,count(*) as order_cnt",
		"from users u left join orders o on u.user_id=o.user_id and o.status='SUCCESS' or o.status='PAID'",
		"where u.dt between '2026-04-01' and '2026-04-23' and u.country in('CN','US') or (u.age>18 and u.status='ACTIVE')",
		"group by u.user_id having count(*)>1 and sum(o.amount)>0 or max(o.amount)>100;"
	].join(' '),
	[
		'SELECT  u.user_id',
		'       ,COUNT(*)  AS order_cnt',
		'FROM users u',
		'LEFT JOIN orders o',
		'     ON u.user_id = o.user_id',
		"    AND o.status = 'SUCCESS'",
		"     OR o.status = 'PAID'",
		"WHERE u.dt BETWEEN '2026-04-01' AND '2026-04-23'",
		"  AND u.country IN('CN', 'US')",
		"   OR (u.age > 18 AND u.status = 'ACTIVE')",
		'GROUP BY  u.user_id',
		'HAVING COUNT(*) > 1',
		'   AND SUM(o.amount) > 0',
		'    OR MAX(o.amount) > 100;'
	].join('\n')
);

run_lower_case(
	'lowercase condition clauses align keyword tails',
	"select * from a left join b on a.id=b.id and a.ds=b.ds or b.flag=1 where a.x=1 and a.y=2 or a.z=3;",
	[
		'select  *',
		'from a',
		'left join b',
		'     on a.id = b.id',
		'    and a.ds = b.ds',
		'     or b.flag = 1',
		'where a.x = 1',
		'  and a.y = 2',
		'   or a.z = 3;'
	].join('\n')
);

run_case(
	'cte case end aligns with case keyword',
	[
		'WITH order_base AS',
		'(',
		'    SELECT  o.user_id                                                            AS user_id     -- 用户ID',
		'           ,o.order_id                                                           AS order_id    -- 订单ID',
		'           ,CASE',
		"             WHEN o.status = 'SUCCESS' AND o.pay_time is not null",
		"                 THEN concat_ws('#',cast(o.order_id AS string),cast(o.user_id AS string))",
		'             ELSE',
		"                 'INVALID_ORDER'",
		'         END                                                                  AS order_token -- 订单标识',
		'           ,o.amount                                                             AS amount      -- 金额',
		'    FROM orders o',
		')',
		'SELECT  us.user_id      AS user_id      -- 用户ID',
		'       ,us.order_cnt    AS order_cnt    -- 订单数',
		'       ,us.total_amount AS total_amount -- 总金额',
		'FROM user_stat us;'
	].join('\n'),
	[
		'WITH order_base AS',
		'(',
		'    SELECT  o.user_id                                                                                                                           AS user_id     -- 用户ID',
		'           ,o.order_id                                                                                                                          AS order_id    -- 订单ID',
		'           ,CASE',
		"                WHEN o.status = 'SUCCESS' AND o.pay_time IS NOT NULL THEN concat_ws('#', CAST(o.order_id AS STRING), CAST(o.user_id AS STRING))",
		"                ELSE 'INVALID_ORDER'",
		'            END                                                                                                                                 AS order_token -- 订单标识',
		'           ,o.amount                                                                                                                            AS amount      -- 金额',
		'    FROM orders o',
		')',
		'SELECT  us.user_id      AS user_id      -- 用户ID',
		'       ,us.order_cnt    AS order_cnt    -- 订单数',
		'       ,us.total_amount AS total_amount -- 总金额',
		'FROM user_stat us;'
	].join('\n')
);

run_case(
	'inner cte select does not align alias as with cast as',
	[
		'SELECT  o.user_id                                                               AS user_id  -- 用户ID',
		'       ,o.order_id                                                              AS order_id -- 订单ID',
		'       ,CASE',
		"            WHEN o.status = 'SUCCESS' AND o.pay_time is not null",
		"                THEN concat_ws('#',cast(o.order_id AS string),cast(o.user_id AS string))",
		'            ELSE',
		"                'INVALID_ORDER'",
		'        END                                                                  AS order_token -- 订单标识',
		'       ,o.amount                                                                AS amount   -- 金额',
		'FROM orders o'
	].join('\n'),
	[
		'SELECT  o.user_id                                                                                                                           AS user_id     -- 用户ID',
		'       ,o.order_id                                                                                                                          AS order_id    -- 订单ID',
		'       ,CASE',
		"            WHEN o.status = 'SUCCESS' AND o.pay_time IS NOT NULL THEN concat_ws('#', CAST(o.order_id AS STRING), CAST(o.user_id AS STRING))",
		"            ELSE 'INVALID_ORDER'",
		'        END                                                                                                                                 AS order_token -- 订单标识',
		'       ,o.amount                                                                                                                            AS amount      -- 金额',
		'FROM orders o'
	].join('\n')
);

run_case(
	'hive left semi and anti joins stay on one join line',
	"select a.id from a left semi join b on a.id=b.id left anti join c on a.id=c.id full outer join d on a.id=d.id",
	[
		'SELECT  a.id',
		'FROM a',
		'LEFT SEMI JOIN b',
		'     ON a.id = b.id',
		'LEFT ANTI JOIN c',
		'     ON a.id = c.id',
		'FULL OUTER JOIN d',
		'     ON a.id = d.id'
	].join('\n')
);

run_case(
	'hive distribute sort and cluster clauses each start a clause line',
	"select a,b from t distribute by a sort by b cluster by c",
	[
		'SELECT  a',
		'       ,b',
		'FROM t',
		'DISTRIBUTE BY a',
		'SORT BY b',
		'CLUSTER BY c'
	].join('\n')
);

run_lower_case(
	'lowercase hive join and distribution clauses',
	"select a.id from a left semi join b on a.id=b.id distribute by a.id sort by b.id cluster by a.id",
	[
		'select  a.id',
		'from a',
		'left semi join b',
		'     on a.id = b.id',
		'distribute by a.id',
		'sort by b.id',
		'cluster by a.id'
	].join('\n')
);

run_case(
	'exists subquery expands compact inner query',
	"select * from a where exists (select 1 from b where b.id=a.id and b.ds='2026-04-24') and a.x=1",
	[
		'SELECT  *',
		'FROM a',
		'WHERE EXISTS (',
		'    SELECT  1',
		'    FROM b',
		"    WHERE b.id = a.id AND b.ds = '2026-04-24'",
		')',
		'  AND a.x = 1'
	].join('\n')
);

run_case(
	'not exists without bracket space expands compact inner query',
	"select * from a where not exists(select 1 from b where b.id=a.id)",
	[
		'SELECT  *',
		'FROM a',
		'WHERE NOT EXISTS (',
		'    SELECT  1',
		'    FROM b',
		'    WHERE b.id = a.id',
		')'
	].join('\n')
);

run_lower_case(
	'lowercase exists subquery expands compact inner query',
	"select * from a where exists(select 1 from b where b.id=a.id)",
	[
		'select  *',
		'from a',
		'where exists (',
		'    select  1',
		'    from b',
		'    where b.id = a.id',
		')'
	].join('\n')
);

run_case(
	'hive keyword uppercase covers select expressions and predicates',
	"select distinct cast(a as string) as s, if(a is null, true, false) as f from t where a is not null and b rlike '^x' and c regexp 'y' and d not like 'z'",
	[
		'SELECT DISTINCT',
		'        CAST(a AS STRING)          AS s',
		'       ,if(a IS NULL, TRUE, FALSE) AS f',
		'FROM t',
		'WHERE a IS NOT NULL',
		"  AND b RLIKE '^x'",
		"  AND c REGEXP 'y'",
		"  AND d NOT LIKE 'z'"
	].join('\n')
);

run_case(
	'hive lateral view and grouping keywords are uppercased',
	"select * from t lateral view outer posexplode(arr) lv as pos,item where item is not null group by rollup(pos), cube(item), grouping sets ((pos),(item))",
	[
		'SELECT  *',
		'FROM t LATERAL VIEW OUTER POSEXPLODE(arr) lv AS pos, item',
		'WHERE item IS NOT NULL',
		'GROUP BY  ROLLUP(pos)',
		'         ,CUBE(item)',
		'         ,GROUPING SETS ((pos),(item))'
	].join('\n')
);

run_case(
	'hive ddl storage and set operation keywords are uppercased',
	"create external table if not exists db.t stored as parquet tblproperties('k'='v') as select a from s intersect select a from u except select a from v",
	[
		"CREATE EXTERNAL TABLE IF NOT EXISTS db.t STORED AS PARQUET TBLPROPERTIES('k' = 'v') AS",
		'SELECT  a',
		'FROM s',
		'INTERSECT',
		'SELECT  a',
		'FROM u',
		'EXCEPT',
		'SELECT  a',
		'FROM v'
	].join('\n')
);

run_case(
	'hive partition and window frame keywords are uppercased',
	"insert overwrite table db.t partition(ds) select row_number() over(partition by a order by b rows between unbounded preceding and current row) as rn, ds from s distribute by ds sort by rn",
	[
		'INSERT OVERWRITE TABLE db.t PARTITION(ds)',
		'SELECT  ROW_NUMBER() OVER(PARTITION BY a ORDER BY  b ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS rn',
		'       ,ds',
		'FROM s',
		'DISTRIBUTE BY ds',
		'SORT BY rn'
	].join('\n')
);

run_case(
	'hive set config key and value preserve original case',
	"set hive.exec.dynamic.partition = true;",
	'SET hive.exec.dynamic.partition = true;'
);

run_case(
	'hive set config mode preserves original case',
	"set hive.exec.dynamic.partition.mode = nonstrict;",
	'SET hive.exec.dynamic.partition.mode = nonstrict;'
);

run_case(
	'consecutive hive set configs keep separate lines',
	[
		"set hive.exec.dynamic.partition=true;",
		"set hive.exec.dynamic.partition.mode=non-strict;"
	].join('\n'),
	[
		'SET hive.exec.dynamic.partition = true;',
		'SET hive.exec.dynamic.partition.mode = non-strict;'
	].join('\n')
);

run_case(
	'dotted identifiers do not uppercase keyword-like parts',
	"select t.partition, t.true from db.table t where t.partition is not null",
	[
		'SELECT  t.partition',
		'       ,t.true',
		'FROM db.table t',
		'WHERE t.partition IS NOT NULL'
	].join('\n')
);

run_lower_case(
	'lowercase hive keyword coverage remains lowercase',
	"select distinct cast(a as string) as s from t lateral view outer posexplode(arr) lv as pos,item where a is not null group by rollup(a), grouping sets ((a)) intersect select a from s",
	[
		'select distinct',
		'        cast(a as string) as s',
		'from t lateral view outer posexplode(arr) lv as pos, item',
		'where a is not null',
		'group by  rollup(a)',
		'         ,grouping sets ((a))',
		'intersect',
		'select  a',
		'from s'
	].join('\n')
);

run_case(
	'hive variable substitutions preserve bytes in table names and predicates',
	"select a from ${db}.tbl where dt=${hivevar:day} and path=${hiveconf:warehouse}",
	[
		'SELECT  a',
		'FROM ${db}.tbl',
		'WHERE dt = ${hivevar:day}',
		'  AND path = ${hiveconf:warehouse}'
	].join('\n')
);

run_case(
	'hive variable substitutions remain stable after formatting',
	format("select a from ${db}.tbl where dt=${hivevar:day}"),
	[
		'SELECT  a',
		'FROM ${db}.tbl',
		'WHERE dt = ${hivevar:day}'
	].join('\n')
);

console.log('hive regression tests passed');
