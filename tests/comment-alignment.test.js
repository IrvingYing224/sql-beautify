var assert = require('assert');
var vkbeautify = require('../vkbeautify');
var sqlFormatter = require('../lib/sql-formatter');

function format(sql) {
	return vkbeautify.sql(sql, true, false, true, 150, 80).trim();
}

function run_case(name, input, expected) {
	var actual = format(input);
	assert.strictEqual(actual, expected.trim(), name + '\n--- actual ---\n' + actual + '\n--- expected ---\n' + expected.trim());
}

function format_with_options(sql, options) {
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

function comment_column(line) {
	return line.indexOf('--');
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
		'ORDER BY  total_amount DESC;'
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
		align_comment('SELECT  o.user_id                                                                                                           AS user_id', 142, '用户ID'),
		align_comment('       ,o.order_id                                                                                                          AS order_id', 142, '订单ID'),
		align_comment('       ,o.amount                                                                                                            AS amount', 142, '金额'),
		align_comment('       ,ROW_NUMBER() OVER(PARTITION BY o.user_id ORDER BY  o.amount DESC, o.order_id ASC)                                   AS rn', 142, '行号'),
		align_comment('       ,rank() OVER (PARTITION BY o.user_id ORDER BY  o.amount DESC)                                                         AS rk', 142, '排名'),
		align_comment('       ,dense_rank() OVER(PARTITION BY o.user_id ORDER BY  o.amount DESC)                                                   AS drk', 142, '稠密排名'),
		align_comment('       ,SUM(o.amount) OVER(PARTITION BY o.user_id ORDER BY  o.create_time ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running_amount', 142, '累计金额'),
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
		'SELECT  u.user_id                                                                                                                               AS user_id   -- 用户ID',
		'       ,u.user_name                                                                                                                             AS user_name -- 用户名',
		'       ,CASE',
		"            WHEN u.status = 'active' AND u.age >= 18 AND nvl(u.email, '') <> '' AND length(regexp_replace(nvl(u.phone, ''), '[^0-9]', '')) = 11",
		"                THEN 'valid_active_user'",
		'            ELSE',
		"                'invalid_or_inactive_user'",
		'        END                                                                                                                                     AS user_flag -- 用户标记',
		'       ,u.city                                                                                                                                  AS city      -- 城市',
		'FROM users u;'
	].join('\n')
);

var multiline_case_alias_comment_actual = format([
	'SELECT  base.user_id',
	'       ,bAsE.user_type',
	'       ,CAST(bAsE.total_score AS InTeGeR)                AS score        -- 基础类型转换',
	"       ,CoAlEsCe(base.phone,bAsE.email,'unknown')        AS contact_info -- 多参数函数",
	'       ,CASE',
	"            WHEN base.age < 18              THEN 'minor'",
	"            WHEN base.age BETWEEN 18 AND 60 THEN 'adult'",
	"            ELSE 'senior'",
	'        END                                              AS age_group -- 多行 CASE 字段',
	'       ,dAtE_sUb(CAST(base.login_date AS DATE),7)        AS wEeK_aGo  -- 函数套函数',
	'FROM a'
].join('\n'));

var multiline_case_alias_comment_lines = multiline_case_alias_comment_actual.split('\n');
var multiline_case_alias_comment_columns = multiline_case_alias_comment_lines.filter(function(line) {
	return line.indexOf('--') >= 0;
}).map(function(line) {
	return line.indexOf('--');
});

assert.deepStrictEqual(
	multiline_case_alias_comment_columns,
	[73, 73, 73, 73],
	'multiline CASE alias select item should align trailing field comments with sibling select items\n--- actual ---\n' + multiline_case_alias_comment_actual
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
		'SELECT  u.user_id                     AS user_id    -- 用户id',
		'       ,u.user_name                   AS user_name  -- 用户名',
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
	'standalone comment before drop does not indent drop statement',
	[
		'-- vcdsfdsfds ',
		'drop table dws.fdjsaf',
		'create table dws.dfds'
	].join('\n'),
	[
		'-- vcdsfdsfds',
		'DROP TABLE dws.fdjsaf',
		'CREATE TABLE dws.dfds'
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

run_case(
	'production-style comment note does not break following case comment alignment',
	[
		'select  a.user_id as user_id -- 用户ID',
		'       ,a.city    as city    -- 城市',
		'-- 风险标签口径: 仅统计近30天',
		'       ,case when a.risk_score >= 80 then \'high\' else \'normal\' end as risk_tag -- 风险标签',
		'from ads_user_risk a'
	].join('\n'),
		[
			'SELECT  a.user_id                               AS user_id  -- 用户ID',
			'       ,a.city                                  AS city     -- 城市',
			'       -- 风险标签口径: 仅统计近30天',
			'       ,CASE',
		'            WHEN a.risk_score >= 80 THEN \'high\'',
		'            ELSE \'normal\'',
		'        END                                     AS risk_tag -- 风险标签',
		'FROM ads_user_risk a'
	].join('\n')
);

var compactCaseCommentAlignment = format_with_options(
	[
		"select id as id -- 用户ID",
		",case when status=1 then 'Y' else 'N' end as is_active -- 是否活跃",
		",created_at as created_at -- 创建时间",
		"from users"
	].join('\n'),
	{ caseLayout: 'compactShort' }
);
var compactCaseCommentLines = compactCaseCommentAlignment.split('\n').filter(function(line) {
	return line.indexOf('--') >= 0;
});
assert.strictEqual(
	compactCaseCommentLines.length,
	3,
	'compact CASE comment alignment test must keep three trailing comments\n--- actual ---\n' + compactCaseCommentAlignment
);
assert.strictEqual(
	comment_column(compactCaseCommentLines[0]),
	comment_column(compactCaseCommentLines[1]),
	'compact CASE trailing comment must align with preceding select item\n--- actual ---\n' + compactCaseCommentAlignment
);
assert.strictEqual(
	comment_column(compactCaseCommentLines[1]),
	comment_column(compactCaseCommentLines[2]),
	'compact CASE trailing comment must align with following select item\n--- actual ---\n' + compactCaseCommentAlignment
);
assert.ok(
	compactCaseCommentAlignment.indexOf("CASE WHEN status = 1 THEN 'Y' ELSE 'N' END AS is_active") >= 0,
	'compact CASE should stay on one line in comment alignment path\n--- actual ---\n' + compactCaseCommentAlignment
);

var productionSelectCommentAlignmentInput = [
	'SELECT DISTINCT',
	'  t.idx_id AS idx_cd,  -- 指标资产代码',
	'  t.idx_nm AS idx_nm,  -- 指标名称',
	'  t.orgnumber AS orig_org_cd,  -- 原组织代码',
	'  CONCAT(t.year, \'-\', t.period) AS date_cd,  -- 日期代码',
	'  t.year,  -- 所属年份',
	'  CASE ',
	"    WHEN t.period IN ('01', '02', '03') THEN 'Q1'",
	"    WHEN t.period IN ('04', '05', '06') THEN 'Q2'",
	'    ELSE t.period',
	'  END AS quat,  -- 所属季度',
	'  t.ly_mtd_amount AS ly_mtd_amount,  -- 上年同月值',
	'  t.mtd_yoy_amount AS mtd_yoy_amount,  --上年同月值变动额',
	'  t.five_year_inc_rate as five_year_inc_rate,  --5年复合增长率',
	'  t.jq_bdgt_cmplt_rate as jq_bdgt_cmplt_rate,   --久其预算完成比率',
	'  t.src_id as idx_source_cd,  -- 指标源系统代码',
	'  SUBSTR(FROM_UNIXTIME(UNIX_TIMESTAMP()),1,10) AS dw_etl_dt,  -- 数据写入日期',
	'  SUBSTR(FROM_UNIXTIME(UNIX_TIMESTAMP()),11,9) AS dw_etl_tm,  -- 数据写入时间',
	'  t.prt_dt,  --分区',
	'  t.rpt_nm   --报表类型',
	'FROM ads_cmhk_fms_fdas.hafdas_mrpt_index_ss_tmp6 t'
].join('\n');
var productionSelectCommentAlignmentOnce = format(productionSelectCommentAlignmentInput);
var productionSelectCommentAlignmentTwice = format(productionSelectCommentAlignmentOnce);
var productionSelectCommentAlignmentColumns = productionSelectCommentAlignmentOnce.split('\n').filter(function(line) {
	return line.indexOf('--') >= 0;
}).map(comment_column);

assert.strictEqual(
	productionSelectCommentAlignmentTwice,
	productionSelectCommentAlignmentOnce,
	'production-style select trailing comments should be idempotent after one pass\n--- once ---\n' + productionSelectCommentAlignmentOnce + '\n--- twice ---\n' + productionSelectCommentAlignmentTwice
);
assert.deepStrictEqual(
	productionSelectCommentAlignmentColumns,
	productionSelectCommentAlignmentColumns.map(function() { return productionSelectCommentAlignmentColumns[0]; }),
	'production-style select trailing comments should align after one pass\n--- actual ---\n' + productionSelectCommentAlignmentOnce
);

console.log('comment alignment tests passed');
