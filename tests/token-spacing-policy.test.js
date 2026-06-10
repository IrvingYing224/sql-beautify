var assert = require('assert');
var sqlFormatter = require('../lib/sql-formatter');

function format(sql) {
	return sqlFormatter.format_sql(sql, {
		keywordCase: 'upper',
		commaStyle: 'leading',
		indentStyle: 'space',
		maxAlignWidth: 150,
		caseWhenThenWrapLength: 80,
		dialect: 'generic',
		unsupportedSyntaxPolicy: 'preserve'
	}).trim();
}

function run_case(name, input, expected) {
	var actual = format(input);
	assert.strictEqual(
		actual,
		expected.trim(),
		name + '\n--- actual ---\n' + actual + '\n--- expected ---\n' + expected.trim()
	);
}

function assert_contains(name, input, expectedFragment) {
	var actual = format(input);
	assert.ok(
		actual.indexOf(expectedFragment) >= 0,
		name + '\n--- missing fragment ---\n' + expectedFragment + '\n--- actual ---\n' + actual
	);
	return actual;
}

run_case(
	'inline comma spacing is consistent across function args, in lists, and order keys',
	"select coalesce(phone,email,'unknown') as contact_info from users where channel in ('app','web') order by dt desc,event_time desc",
	[
		"SELECT  coalesce(phone, email, 'unknown') AS contact_info",
		'FROM users',
		"WHERE channel IN ('app', 'web')",
		'ORDER BY dt DESC, event_time DESC'
	].join('\n')
);

assert_contains(
	'window order by keeps existing first-expression double-space and normal comma spacing',
	'select row_number() over(partition by ds order by pay_time desc,created_at desc) as rn from orders',
	'ROW_NUMBER() OVER(PARTITION BY ds ORDER BY  pay_time DESC, created_at DESC) AS rn'
);

run_case(
	'leading select comma style remains compact after comma',
	'select a,b,c from t',
	[
		'SELECT  a',
		'       ,b',
		'       ,c',
		'FROM t'
	].join('\n')
);

run_case(
	'comment alignment uses final rendered widths after comma normalization',
	[
		'SELECT  base.user_id',
		'       ,bAsE.user_type',
		'       ,CAST(bAsE.total_score AS InTeGeR)                AS score        -- 测试点1：基础类型转换 CAST 的空格清理',
		"       ,CoAlEsCe(base.phone,bAsE.email,'unknown')        AS contact_info -- 测试点2：多参数函数的逗号与空格清洗",
		'       ,CASE',
		"            WHEN base.age < 18              THEN 'minor'",
		"            WHEN base.age BETWEEN 18 AND 60 THEN 'adult'",
		"            ELSE 'senior'",
		'        END                                              AS age_group -- 测试点3：横向极度拥挤、完全不换行的 CASE WHEN',
		'       ,dAtE_sUb(CAST(base.login_date AS DATE),7)        AS wEeK_aGo  -- 测试点4：函数套函数（DATE_SUB 嵌套 CAST）',
		'FROM a'
	].join('\n'),
	[
		'SELECT  base.user_id',
		'       ,bAsE.user_type',
		'       ,CAST(bAsE.total_score AS InTeGeR)                AS score        -- 测试点1：基础类型转换 CAST 的空格清理',
		"       ,CoAlEsCe(base.phone, bAsE.email, 'unknown')      AS contact_info -- 测试点2：多参数函数的逗号与空格清洗",
		'       ,CASE',
		"            WHEN base.age < 18              THEN 'minor'",
		"            WHEN base.age BETWEEN 18 AND 60 THEN 'adult'",
		"            ELSE 'senior'",
		'        END                                              AS age_group    -- 测试点3：横向极度拥挤、完全不换行的 CASE WHEN',
		'       ,dAtE_sUb(CAST(base.login_date AS DATE), 7)       AS wEeK_aGo     -- 测试点4：函数套函数（DATE_SUB 嵌套 CAST）',
		'FROM a'
	].join('\n')
);

run_case(
	'case exists width planning keeps existing end alias alignment',
	'select case when exists(select 1) then 1 else 0 end as flag from t',
	[
		'SELECT',
		'        CASE',
		'            WHEN EXISTS ( SELECT 1) THEN 1',
		'            ELSE 0',
		'        END                              AS flag',
		'FROM t'
	].join('\n')
);

console.log('token spacing policy tests passed');
