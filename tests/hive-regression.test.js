var assert = require('assert');
var vkbeautify = require('../vkbeautify');

function format(sql) {
	return vkbeautify.sql(sql, true, false, true, 150, 80).trim();
}

function run_case(name, input, expected) {
	var actual = format(input);
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
	"with a as (select user_id,sum(amount) as total_amount -- 总额 from orders group by user_id) select user_id,total_amount from a",
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
	"select user_id,row_number() over(partition by ds order by pay_time desc) as rn -- 排名 from orders",
	[
		'SELECT  user_id',
		'       ,ROW_NUMBER() over(PARTITION BY ds ORDER BY  pay_time DESC) AS rn -- 排名',
		'FROM orders'
	].join('\n')
);

run_case(
	'lateral view explode keeps hive from clause layout',
	"select user_id,tag -- 标签 from user_tags lateral view explode(tags) tmp as tag",
	[
		'SELECT  user_id',
		'       ,tag -- 标签',
		'FROM user_tags lateral view explode(tags) tmp AS tag'
	].join('\n')
);

run_case(
	'insert overwrite partition keeps select aggregate block',
	"insert overwrite table dwd.user_sum partition(dt='2026-04-22') select user_id,sum(amount) as total_amount -- 总金额 from orders group by user_id",
	[
		"INSERT OVERWRITE TABLE dwd.user_sum partition(dt = '2026-04-22')",
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
		"       ,concat_ws( '-',cast(u.user_id AS string),nvl(trim(u.user_name),'unknown'),regexp_replace(date_format(from_unixtime(unix_timestamp(u.create_time,'yyyy-MM-dd HH:mm:ss')),'yyyyMMddHHmmss'),'-','') ) AS user_profile_key -- 用户画像Key",
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
		align_comment(align_as('SELECT  o.user_id', 97, 'user_id'), 121, '用户ID'),
		'       ,SUM(CASE',
		"                WHEN o.status = 'SUCCESS' AND o.pay_time is not null THEN coalesce(o.amount,0)",
		'                ELSE 0',
		align_comment(align_as('            END)', 97, 'success_paid_amount'), 121, '成功支付金额'),
		'       ,COUNT(distinct CASE',
		"                           WHEN o.status = 'SUCCESS' AND coalesce(o.amount,0) > 0 THEN o.order_id",
		'                           ELSE null',
		align_comment(align_as('                       END)', 97, 'success_order_cnt'), 121, '成功订单数'),
		align_comment(align_as('       ,MAX(o.pay_time)', 97, 'last_pay_time'), 121, '最近支付时间'),
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
		"                WHEN o.status = 'SUCCESS' THEN CASE WHEN o.amount > 0 THEN o.amount else 0 end",
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
		'SELECT  o.user_id                 AS user_id                                 -- 用户ID',
		'       ,SUM(coalesce(o.amount,0)) AS total_amount                            -- 总金额',
		'       ,COUNT(*)                  AS order_cnt                               -- 订单数',
		'FROM orders o',
		'GROUP BY  o.user_id',
		'HAVING SUM(coalesce(o.amount, 0)) > 1000 AND COUNT(*) >= 3 AND MAX(CASE',
		"                                                                       WHEN o.status = 'SUCCESS' THEN 1",
		'                                                                       ELSE 0',
		'                                                                   END) = 1; -- 分组过滤条件'
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
		'    SELECT  o.user_id                                                                                                                         AS user_id -- 用户ID',
		'           ,o.order_id                                                                                                                        AS order_id -- 订单ID',
		'           ,CASE',
		"                WHEN o.status = 'SUCCESS' AND o.pay_time is not null THEN concat_ws('#',cast(o.order_id AS string),cast(o.user_id AS string))",
		"                ELSE 'INVALID_ORDER'",
		'            END                                                                                                                               AS order_token -- 订单标识',
		'           ,o.amount                                                                                                                          AS amount -- 金额',
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
		'SELECT  o.user_id                                                                                                                         AS user_id  -- 用户ID',
		'       ,o.order_id                                                                                                                        AS order_id -- 订单ID',
		'       ,CASE',
		"            WHEN o.status = 'SUCCESS' AND o.pay_time is not null THEN concat_ws('#',cast(o.order_id AS string),cast(o.user_id AS string))",
		"            ELSE 'INVALID_ORDER'",
		'        END                                                                                                                               AS order_token -- 订单标识',
		'       ,o.amount                                                                                                                          AS amount   -- 金额',
		'FROM orders o'
	].join('\n')
);

console.log('hive regression tests passed');
