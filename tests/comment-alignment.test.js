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
		'     ON u.user_id = o.user_id   -- 用户关联',
		"    AND o.status = 'SUCCESS'    -- 成功订单",
		'INNER JOIN payments p',
		'     ON o.order_id = p.order_id -- 支付关联',
		'WHERE p.pay_time IS NOT NULL;   -- 有支付时间'
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
		'HAVING COUNT(*) > 1        -- 订单数',
		'   AND SUM(o.amount) > 0   -- 有金额',
		'    OR MAX(o.amount) > 100 -- 大额订单'
	].join('\n')
);

run_case(
	'standalone comments starting with SQL keywords do not leak placeholders',
	[
		'SELECT a.id,a.name,b.order_id',
		'FROM users a',
		'LEFT JOIN orders b ON a.id=b.user_id',
		"WHERE a.status='active'",
		'-- AND b.price > 100',
		'-- WHERE debug filter',
		'-- SELECT debug columns',
		'-- FROM debug TABLE',
		'-- between debug range',
		'-- order by debug order',
		'GROUP BY a.id',
		'HAVING COUNT(b.order_id)>1;'
	].join('\n'),
	[
		'SELECT  a.id',
		'       ,a.name',
		'       ,b.order_id',
		'FROM users a',
		'LEFT JOIN orders b',
		'     ON a.id = b.user_id',
		"WHERE a.status = 'active'",
		'-- AND b.price > 100',
		'-- WHERE debug filter',
		'-- SELECT debug columns',
		'-- FROM debug TABLE',
		'-- between debug range',
		'-- order by debug order',
		'GROUP BY  a.id',
		'HAVING COUNT(b.order_id) > 1;'
	].join('\n')
);

run_case(
	'condition wrapping continues after trailing line comment',
	[
		'select 1',
		'from tb1 t1',
		"where t1.load_biz_dt ='${LOAD_BIU_DT}'",
		"AND T1.DEPARTMENT IN ('AA','BB') -- TEST",
		"AND T1.PROD_ID ='#'",
		"AND T1.ITEM='#'",
		"AND T1.RISK_IND IN ('BB','CC')"
	].join('\n'),
	[
		'SELECT  1',
		'FROM tb1 t1',
		"WHERE t1.load_biz_dt = '${LOAD_BIU_DT}'",
		"  AND T1.DEPARTMENT IN ('AA', 'BB') -- TEST",
		"  AND T1.PROD_ID = '#'",
		"  AND T1.ITEM = '#'",
		"  AND T1.RISK_IND IN ('BB', 'CC')"
	].join('\n')
);

var commented_subquery_actual = format([
	'SELECT  u.user_id   AS user_id',
	'       ,u.user_name AS user_name',
	'FROM users u',
	"WHERE u.status = 'active'",
	'  AND EXISTS ( SELECT 1 FROM payments p WHERE p.user_id = u.user_id',
	'-- AND T1`.RISK_INDIC_CD = \'AA\'',
	'-- AND T1.PRID ',
	"  AND p.pay_status = 'PAID')",
	'-- UNION ALL ',
	'-- SELECT  o.order_id AS order_id',
	'--        ,o.user_id  AS user_id',
	'-- FROM orders o',
	"-- WHERE o.dt = '2026-04-21'",
	'--   AND o.user_id IN ( SELECT u.user_id FROM users u WHERE u.status = \'active\' AND u.city IN (\'NY\', \'LA\'))',
	'--   AND EXISTS ( SELECT 1 FROM payments p WHERE p.order_id = o.order_id AND p.refund_status = \'NONE\'); ',
	'UNION ALL',
	'SELECT  1 AS keep_running'
].join('\n'));

assert.ok(
	commented_subquery_actual.indexOf('\nSELECT  u.user_id\nFROM users u') < 0,
	'standalone commented IN subquery must not become uncommented SQL\n--- actual ---\n' + commented_subquery_actual
);
assert.ok(
	commented_subquery_actual.indexOf('\nSELECT  1\nFROM payments p') < 0,
	'standalone commented EXISTS subquery must not become uncommented SQL\n--- actual ---\n' + commented_subquery_actual
);
assert.ok(
	commented_subquery_actual.indexOf('--   AND o.user_id IN ( SELECT u.user_id FROM users u') >= 0,
	'commented IN subquery line should remain a line comment\n--- actual ---\n' + commented_subquery_actual
);
assert.ok(
	commented_subquery_actual.indexOf('--   AND EXISTS ( SELECT 1 FROM payments p') >= 0,
	'commented EXISTS subquery line should remain a line comment\n--- actual ---\n' + commented_subquery_actual
);

var inline_comment_tail_actual = format([
	'SELECT D1.load_biz_dt AS load_biz_dt -- 加载业务日期',
	'-- ,D1.INDEIC_PRICE AS INDIC_PRICE    -- 风险指标值 -- DELETE LIUJIQIANG 20240412 ',
	',d1.year_pl as year_pl -- 年损益 -- DELETE LIUJIQIANG 20240412 ',
	",'y_pl' as y_pl_loss -- ddd",
	'FROM  -- ${MRISK}.DM_GM_REOP D1 -- DELETE LIUJIQIANG V20 20240412 取数逻辑调整 从总表取数',
	'${MRISK}.MD_GM_REP',
	"WHERE D1.load_biz_dt = '2024-12-31'",
	"AND -- D1.INDIC_CFG_CE ='#'",
	"D1.INDIC_CFG_CE ='$'"
].join('\n'));

assert.ok(
	inline_comment_tail_actual.indexOf('\nDELETE LIUJIQIANG') < 0,
	'inline comment text after a second -- must not be split into SQL\n--- actual ---\n' + inline_comment_tail_actual
);
assert.ok(
	inline_comment_tail_actual.indexOf('-- 年损益 -- DELETE LIUJIQIANG 20240412') >= 0,
	'inline comment containing a second -- should remain on the same line\n--- actual ---\n' + inline_comment_tail_actual
);
assert.ok(
	inline_comment_tail_actual.indexOf('-- ${MRISK}.DM_GM_REOP D1 -- DELETE LIUJIQIANG') >= 0,
	'FROM inline comment with variable and second -- should remain a comment\n--- actual ---\n' + inline_comment_tail_actual
);
assert.ok(
	inline_comment_tail_actual.indexOf("-- D1.INDIC_CFG_CE ='#'") >= 0,
	'condition keyword followed by inline comment should keep the tail commented\n--- actual ---\n' + inline_comment_tail_actual
);

var inline_comment_tail_lines = inline_comment_tail_actual.split('\n');
var load_biz_dt_line = inline_comment_tail_lines.filter(function(line) {
	return line.indexOf('load_biz_dt') >= 0 && line.indexOf('-- 加载业务日期') >= 0;
})[0];
var year_pl_line = inline_comment_tail_lines.filter(function(line) {
	return line.indexOf('year_pl') >= 0 && line.indexOf('-- 年损益') >= 0;
})[0];
var y_pl_loss_line = inline_comment_tail_lines.filter(function(line) {
	return line.indexOf('y_pl_loss') >= 0 && line.indexOf('-- ddd') >= 0;
})[0];

assert.strictEqual(
	year_pl_line.indexOf('--'),
	load_biz_dt_line.indexOf('--'),
	'commented-out select item should not break trailing comment alignment\n--- actual ---\n' + inline_comment_tail_actual
);
assert.strictEqual(
	y_pl_loss_line.indexOf('--'),
	load_biz_dt_line.indexOf('--'),
	'select item comments after a commented-out line should align with previous fields\n--- actual ---\n' + inline_comment_tail_actual
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
		align_comment('       ,ROW_NUMBER() OVER(PARTITION BY o.user_id ORDER BY  o.amount DESC,o.order_id ASC)                                     AS rn', 143, '行号'),
		align_comment('       ,rank() OVER (PARTITION BY o.user_id ORDER BY o.amount DESC)                                                          AS rk', 143, '排名'),
		align_comment('       ,dense_rank() OVER(PARTITION BY o.user_id ORDER BY o.amount DESC)                                                     AS drk', 143, '稠密排名'),
		align_comment('       ,SUM(o.amount) OVER( PARTITION BY o.user_id ORDER BY o.create_time ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW ) AS running_amount', 143, '累计金额'),
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

run_case(
	'case in-list comments align within the select item',
	[
		'SELECT  u.user_id                     AS user_id   -- 用户id',
		'       ,u.user_name                   AS user_name -- 用户名',
		'       ,CASE',
		'            WHEN u.city IN (',
		"                    'NY',                          -- 纽约",
		"                    'LA',                          -- 洛杉矶",
		"                    'SF'                           -- 旧金山",
		"                ) THEN 'west_user'",
		'            WHEN u.city IN (',
		"                    'CHI', -- 芝加哥",
		"                    'HOU', -- 休斯顿",
		"                    'DAL'  -- 达拉斯",
		"                ) THEN 'central_user'",
		'            WHEN u.city IN (',
		"                    'MIA', -- 迈阿密",
		"                    'ATL', -- 亚特兰大",
		"                    'ORL'  -- 奥兰多",
		"                ) THEN 'south_user'",
		'            ELSE',
		"                'other_city_user'",
		'        END                           AS city_group -- 城市',
		'FROM users u;'
	].join('\n'),
	[
		'SELECT  u.user_id                     AS user_id   -- 用户id',
		'       ,u.user_name                   AS user_name -- 用户名',
		'       ,CASE',
		'            WHEN u.city IN (',
		"                    'NY', -- 纽约",
		"                    'LA', -- 洛杉矶",
		"                    'SF'  -- 旧金山",
		"                ) THEN 'west_user'",
		'            WHEN u.city IN (',
		"                    'CHI', -- 芝加哥",
		"                    'HOU', -- 休斯顿",
		"                    'DAL'  -- 达拉斯",
		"                ) THEN 'central_user'",
		'            WHEN u.city IN (',
		"                    'MIA', -- 迈阿密",
		"                    'ATL', -- 亚特兰大",
		"                    'ORL'  -- 奥兰多",
		"                ) THEN 'south_user'",
		'            ELSE',
		"                'other_city_user'",
		'        END                           AS city_group -- 城市',
		'FROM users u;'
	].join('\n')
);

run_case(
	'inline comments containing sql keywords stay comments',
	[
		'select a -- from where group by select',
		'from t',
		'where b=1'
	].join('\n'),
	[
		'SELECT  a -- from where group by select',
		'FROM t',
		'WHERE b = 1'
	].join('\n')
);

run_case(
	'inline comment comma and quoted value stay original text',
	[
		'select case when a in (',
		"    'A' -- ,'ABC'",
		') then 1 else 0 end as c',
		'from t'
	].join('\n'),
	[
		'SELECT',
		'       CASE',
		'           WHEN a IN (',
		"                   'A' -- ,'ABC'",
		'               ) THEN 1',
		'           ELSE',
		'               0',
		'       END              AS c',
		'FROM t'
	].join('\n')
);

console.log('comment alignment tests passed');
