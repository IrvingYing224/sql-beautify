var assert = require('assert');
var vkbeautify = require('../vkbeautify');

function format(sql) {
	return vkbeautify.sql(sql, true, false, true, 150, 80).trim();
}

function run_case(name, input, expected) {
	var actual = format(input);
	assert.strictEqual(actual, expected.trim(), name + '\n--- actual ---\n' + actual + '\n--- expected ---\n' + expected.trim());
}

function align_comment(code, targetWidth, comment) {
	return code + ' '.repeat(targetWidth - code.length) + '-- ' + comment;
}

run_case(
	'trailing comments in nested select keep one-space minimum gap',
	[
		'SELECT  t.user_id   AS user_id   -- 用户ID ',
		'       ,t.order_cnt AS order_cnt -- 订单数 ',
		'FROM',
		'(',
		'    SELECT  o.user_id AS user_id    -- 用户ID ',
		'           ,COUNT(*)  AS order_cnt  -- 订单数 ',
		'    FROM orders o',
		'    GROUP BY  o.user_id',
		') t',
		'WHERE t.order_cnt > 5;           -- 过滤'
	].join('\n'),
	[
		'SELECT  t.user_id   AS user_id   -- 用户ID',
		'       ,t.order_cnt AS order_cnt -- 订单数',
		'FROM',
		'(',
		'    SELECT  o.user_id AS user_id   -- 用户ID',
		'           ,COUNT(*)  AS order_cnt -- 订单数',
		'    FROM orders o',
		'    GROUP BY  o.user_id',
		') t',
		'WHERE t.order_cnt > 5; -- 过滤'
	].join('\n')
);

run_case(
	'comments stay aligned within the same from-join-where block',
	[
		'SELECT  u.user_id   AS user_id   -- 用户ID',
		'       ,u.user_name AS user_name -- 用户名',
		'       ,o.order_id  AS order_id  -- 订单ID',
		'       ,o.amount    AS amount    -- 金额',
		'FROM users u',
		'LEFT JOIN orders o',
		'ON u.user_id = o.user_id  -- 用户关联',
		" AND o.status = 'SUCCESS' -- 成功订单",
		'INNER JOIN payments p',
		'ON o.order_id = p.order_id -- 支付关联',
		'WHERE p.pay_time IS NOT NULL; -- 有支付时间'
	].join('\n'),
	[
		'SELECT  u.user_id   AS user_id   -- 用户ID',
		'       ,u.user_name AS user_name -- 用户名',
		'       ,o.order_id  AS order_id  -- 订单ID',
		'       ,o.amount    AS amount    -- 金额',
		'FROM users u',
		'LEFT JOIN orders o',
		'     ON u.user_id = o.user_id    -- 用户关联',
		"    AND o.status = 'SUCCESS'     -- 成功订单",
		'INNER JOIN payments p',
		'     ON o.order_id = p.order_id  -- 支付关联',
		'WHERE p.pay_time IS NOT NULL;    -- 有支付时间'
	].join('\n')
);

run_case(
	'comments stay aligned within the same select-group-having block',
	[
		'SELECT  u.country     AS country      -- 国家',
		'       ,COUNT(*)      AS user_cnt     -- 用户数',
		'       ,AVG(u.age)    AS avg_age      -- 平均年龄',
		'       ,SUM(o.amount) AS total_amount -- 总金额',
		'FROM users u',
		'LEFT JOIN orders o',
		'ON u.user_id = o.user_id',
		'GROUP BY  u.country',
		'HAVING COUNT(*) > 10      -- 用户数过滤',
		' AND SUM(o.amount) > 1000 -- 金额过滤',
		'ORDER BY total_amount DESC;'
	].join('\n'),
	[
		'SELECT  u.country     AS country      -- 国家',
		'       ,COUNT(*)      AS user_cnt     -- 用户数',
		'       ,AVG(u.age)    AS avg_age      -- 平均年龄',
		'       ,SUM(o.amount) AS total_amount -- 总金额',
		'FROM users u',
		'LEFT JOIN orders o',
		'     ON u.user_id = o.user_id',
		'GROUP BY  u.country',
		'HAVING COUNT(*) > 10                  -- 用户数过滤',
		'   AND SUM(o.amount) > 1000           -- 金额过滤',
		'ORDER BY total_amount DESC;'
	].join('\n')
);

run_case(
	'condition clauses align keyword tails and comments',
	[
		'select *',
		'from users u',
		'left join orders o',
		"on u.user_id=o.user_id -- 用户关联",
		"and o.status='SUCCESS' -- 成功订单",
		"or o.status='PAID' -- 已支付订单",
		"where u.dt='2026-04-23' -- 分区日期",
		"and u.country='CN' -- 中国用户",
		"or u.country='US' -- 美国用户",
		'group by u.user_id',
		'having count(*)>1 -- 订单数',
		'and sum(o.amount)>0 -- 有金额',
		'or max(o.amount)>100 -- 大额订单'
	].join('\n'),
	[
		'SELECT  *',
		'FROM users u',
		'LEFT JOIN orders o',
		'     ON u.user_id = o.user_id -- 用户关联',
		"    AND o.status = 'SUCCESS'  -- 成功订单",
		"     OR o.status = 'PAID'     -- 已支付订单",
		"WHERE u.dt = '2026-04-23'     -- 分区日期",
		"  AND u.country = 'CN'        -- 中国用户",
		"   OR u.country = 'US'        -- 美国用户",
		'GROUP BY  u.user_id',
		'HAVING COUNT(*) > 1           -- 订单数',
		'   AND SUM(o.amount) > 0      -- 有金额',
		'    OR MAX(o.amount) > 100    -- 大额订单'
	].join('\n')
);

run_case(
	'long window function columns still align trailing comments',
	[
		'SELECT  o.user_id                                                                                                            AS user_id -- 用户ID',
		'       ,o.order_id                                                                                                           AS order_id -- 订单ID',
		'       ,o.amount                                                                                                             AS amount -- 金额',
		'       ,ROW_NUMBER() over(PARTITION BY o.user_id ORDER BY  o.amount desc,o.order_id ASC)                                     AS rn -- 行号',
		'       ,rank() OVER (PARTITION BY o.user_id ORDER BY o.amount DESC)                                                          AS rk -- 排名',
		'       ,dense_rank() over(PARTITION BY o.user_id ORDER BY o.amount DESC)                                                     AS drk -- 稠密排名',
		'       ,SUM(o.amount) over( PARTITION BY o.user_id ORDER BY o.create_time rows BETWEEN unbounded preceding AND current row ) AS running_amount -- 累计金额',
		'FROM orders o;'
	].join('\n'),
	[
		align_comment('SELECT  o.user_id                                                                                                            AS user_id', 143, '用户ID'),
		align_comment('       ,o.order_id                                                                                                           AS order_id', 143, '订单ID'),
		align_comment('       ,o.amount                                                                                                             AS amount', 143, '金额'),
		align_comment('       ,ROW_NUMBER() over(PARTITION BY o.user_id ORDER BY  o.amount desc,o.order_id ASC)                                     AS rn', 143, '行号'),
		align_comment('       ,rank() OVER (PARTITION BY o.user_id ORDER BY o.amount DESC)                                                          AS rk', 143, '排名'),
		align_comment('       ,dense_rank() over(PARTITION BY o.user_id ORDER BY o.amount DESC)                                                     AS drk', 143, '稠密排名'),
		align_comment('       ,SUM(o.amount) over( PARTITION BY o.user_id ORDER BY o.create_time rows BETWEEN unbounded preceding AND current row ) AS running_amount', 143, '累计金额'),
		'FROM orders o;'
	].join('\n')
);

run_case(
	'wide aliased case rows keep trailing comments aligned with as width threshold',
	[
		'SELECT  u.user_id                                                                                                                           AS user_id -- 用户ID',
		'       ,u.user_name                                                                                                                         AS user_name -- 用户名',
		'       ,CASE',
		"            WHEN u.status = 'active' AND u.age >= 18 AND nvl(u.email,'') <> '' AND length(regexp_replace(nvl(u.phone,''),'[^0-9]','')) = 11",
		"                THEN 'valid_active_user'",
		'            ELSE',
		"                'invalid_or_inactive_user'",
		'        END                                                                                                                                 AS user_flag -- 用户标记',
		'       ,u.city                                                                                                                              AS city -- 城市',
		'FROM users u;'
	].join('\n'),
	[
		'SELECT  u.user_id                                                                                                                           AS user_id   -- 用户ID',
		'       ,u.user_name                                                                                                                         AS user_name -- 用户名',
		'       ,CASE',
		"            WHEN u.status = 'active' AND u.age >= 18 AND nvl(u.email,'') <> '' AND length(regexp_replace(nvl(u.phone,''),'[^0-9]','')) = 11",
		"                THEN 'valid_active_user'",
		'            ELSE',
		"                'invalid_or_inactive_user'",
		'        END                                                                                                                                 AS user_flag -- 用户标记',
		'       ,u.city                                                                                                                              AS city      -- 城市',
		'FROM users u;'
	].join('\n')
);

console.log('comment alignment tests passed');
