var assert = require('assert');
var vkbeautify = require('../vkbeautify');

function format(sql, uppercase, wrapLength) {
	return vkbeautify.sql(sql, uppercase !== false, false, false, 150, wrapLength || 50).trim();
}

function run_case(name, input, expected, uppercase, wrapLength) {
	var actual = format(input, uppercase, wrapLength);
	assert.strictEqual(actual, expected.trim(), name + '\n--- actual ---\n' + actual + '\n--- expected ---\n' + expected.trim());
}

function align_as(code, targetWidth, alias) {
	return code + ' '.repeat(targetWidth - code.length) + ' AS ' + alias;
}

run_case(
	'searched case aligns CASE/WHEN/END',
	"select case when a=1 then 'x' when b=2 then 'y' else 'z' end as c from t",
	"SELECT\n       CASE\n           WHEN a = 1 THEN 'x'\n           WHEN b = 2 THEN 'y'\n           ELSE 'z'\n       END                     AS c\nFROM t"
);

run_case(
	'simple case keeps operand on CASE line',
	"select case status when 1 then 'a' -- one\nwhen 2 then 'b' -- two\nelse 'c' -- three\nend as flag from t",
	"SELECT\n       CASE status\n           WHEN 1 THEN 'a' -- one\n           WHEN 2 THEN 'b' -- two\n           ELSE 'c'        -- three\n       END                 AS flag\nFROM t"
);

run_case(
	'long when or then wraps all THEN and ELSE values',
	"select case when very_long_column_name = 1 and another_col = 2 and third_col = 3 then some_really_long_expression + another_really_long_expression -- long then\nwhen b=2 then y -- short\nelse z -- else\nend as c from t",
	"SELECT\n       CASE\n           WHEN very_long_column_name = 1 AND another_col = 2 AND third_col = 3\n               THEN some_really_long_expression + another_really_long_expression -- long then\n           WHEN b = 2\n               THEN y                                                            -- short\n           ELSE\n               z                                                                 -- else\n       END                                                                       AS c\nFROM t"
);

run_case(
	'group by case uses the same block layout',
	"select a from t group by case when a=1 then 'x' when b=2 then 'y' else 'z' end",
	"SELECT  a\nFROM t\nGROUP BY\n         CASE\n             WHEN a = 1 THEN 'x'\n             WHEN b = 2 THEN 'y'\n             ELSE 'z'\n         END"
);

run_case(
	'lowercase mode keeps comma case blocks formatted',
	"select a,case when a=1 then 'x' when b=2 then 'y' else 'z' end as c from t",
	"select  a\n       ,case\n            when a = 1 then 'x'\n            when b = 2 then 'y'\n            else 'z'\n        end                     as c\nfrom t",
	false
);

run_case(
	'end on the same line as final when still reformats',
	"SELECT CASE  WHEN name = 'fdsfsdfsdafsdafdsfsdafsdfsdfsdfsdfsdfsdfsdafsdfsdafsdfa' THEN 123  -- c1\n            WHEN name = 'fdsfsdfsdafsdafdsfsdafsdfsdfsdfsdfsdfsdfsdafsdfsdafsdfb' THEN 132  -- c2\n            WHEN name = 'fdsfsdfsdafsdafd' THEN 25  END AS alias -- c3\nFROM t",
	"SELECT\n       CASE\n           WHEN name = 'fdsfsdfsdafsdafdsfsdafsdfsdfsdfsdfsdfsdfsdafsdfsdafsdfa'\n               THEN 123                                                                   -- c1\n           WHEN name = 'fdsfsdfsdafsdafdsfsdafsdfsdfsdfsdfsdfsdfsdafsdfsdafsdfb'\n               THEN 132                                                                   -- c2\n           WHEN name = 'fdsfsdfsdafsdafd'\n               THEN 25\n       END                                                                       AS alias -- c3\nFROM t"
);

run_case(
	'mixed columns align AS after the widest CASE branch',
	"SELECT  1 AS f -- com1\n       ,2 AS cc -- fdsfa\n       ,3 AS bb -- ccc\n       ,CASE\n            WHEN name = 'aa'  THEN 123 -- c1\n            WHEN name = 'bbb' THEN 132 -- c2\n            WHEN name = 'ccc' THEN 25\n        END  AS alias -- c3\nFROM t;",
	"SELECT  1                              AS f     -- com1\n       ,2                              AS cc    -- fdsfa\n       ,3                              AS bb    -- ccc\n       ,CASE\n            WHEN name = 'aa'  THEN 123          -- c1\n            WHEN name = 'bbb' THEN 132          -- c2\n            WHEN name = 'ccc' THEN 25\n        END                            AS alias -- c3\nFROM t;"
);

run_case(
	'aggregate wrapper keeps case syntax valid',
	"select sum(case when o.status='SUCCESS' then o.amount else 0 end) as amt from orders o",
	[
		'SELECT  SUM(CASE',
		"                WHEN o.status = 'SUCCESS' THEN o.amount",
		'                ELSE 0',
		align_as('            END)', 55, 'amt'),
		'FROM orders o'
	].join('\n')
);

run_case(
	'count distinct wrapper keeps case syntax valid',
	"select count(distinct case when o.status='SUCCESS' then o.order_id else null end) as cnt from orders o",
	[
		'SELECT  COUNT(DISTINCT CASE',
		"                           WHEN o.status = 'SUCCESS' THEN o.order_id",
		'                           ELSE NULL',
		align_as('                       END)', 68, 'cnt'),
		'FROM orders o'
	].join('\n')
);

run_case(
	'nested case stays attached to outer branch',
	[
		'select',
		'    case',
		'        when a=1 then',
		'            case',
		'                when b=2 then x',
		'                else y',
		'            end',
		'        else z',
		'    end as flag',
		'from t'
	].join('\n'),
	[
		'SELECT',
		'       CASE',
		'           WHEN a = 1 THEN CASE WHEN b = 2 THEN x else y end',
		'           ELSE z',
		align_as('       END', 60, 'flag'),
		'FROM t'
	].join('\n')
);

run_case(
	'multiline in-list when conditions keep comments',
	[
		'SELECT',
		'    u.user_id AS user_id,',
		'    u.user_name AS user_name,',
		'    CASE',
		'        WHEN u.city IN (',
		"            'NY',   -- 纽约",
		"            'LA',   -- 洛杉矶",
		"            'SF'    -- 旧金山",
		"        ) THEN 'west_user'",
		'',
		'        WHEN u.city IN (',
		"            'CHI',  -- 芝加哥",
		"            'HOU',  -- 休斯顿",
		"            'DAL'   -- 达拉斯",
		"        ) THEN 'central_user'",
		'',
		'        WHEN u.city IN (',
		"            'MIA',  -- 迈阿密",
		"            'ATL',  -- 亚特兰大",
		"            'ORL'   -- 奥兰多",
		"        ) THEN 'south_user'",
		'',
		"        ELSE 'other_city_user'",
		'    END AS city_group',
		'FROM users u;'
	].join('\n'),
	[
		'SELECT  u.user_id                     AS user_id',
		'       ,u.user_name                   AS user_name',
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
		'        END                           AS city_group',
		'FROM users u;'
	].join('\n')
);

run_case(
	'commented in-list value does not steal then comment',
	[
		'SELECT  p.order_id                                                       AS order_id',
		'       ,p.channel                                                        AS channel',
		'       ,CASE',
		"            WHEN p.channel IN ('ALIPAY','WECHAT' -- ,'ABC'",
		'            ) ',
		"            THEN 'online_payment'  -- 主流线上支付渠道",
		"            ELSE 'other_payment'                                         -- 其他支付方式",
		'        END                                                              AS payment_type',
		'FROM payments p;'
	].join('\n'),
	[
		'SELECT  p.order_id                      AS order_id',
		'       ,p.channel                       AS channel',
		'       ,CASE',
		'            WHEN p.channel IN (',
		"                    'ALIPAY','WECHAT' -- ,'ABC'",
		"                ) THEN 'online_payment' -- 主流线上支付渠道",
		'            ELSE',
		"                'other_payment'         -- 其他支付方式",
		'        END                             AS payment_type',
		'FROM payments p;'
	].join('\n')
);

run_case(
	'comment on closing condition line keeps then active',
	[
		'SELECT  p.order_id                       AS order_id',
		'       ,p.channel                        AS channel',
		'       ,CASE',
		'            WHEN p.channel IN (',
		"                    'ALIPAY', -- 支付宝",
		"                    'WECHAT'  -- 微信支付",
		"                ) THEN 'online_payment'",
		'            WHEN p.channel IN (',
		"                    'BANK',    -- 银行转账",
		"                    'TRANSFER' -- 对公转账",
		"                ) THEN 'offline_payment'",
		'            WHEN p.channel IN (',
		"                    'CASH', -- 现金支付",
		"                    'POS'   -- 刷卡支付",
		'                )   -- test',
		"                  THEN 'store_payment'",
		'            ELSE',
		"                'other_payment'",
		'        END                              AS payment_type',
		'FROM payments p;'
	].join('\n'),
	[
		'SELECT  p.order_id                       AS order_id',
		'       ,p.channel                        AS channel',
		'       ,CASE',
		'            WHEN p.channel IN (',
		"                    'ALIPAY', -- 支付宝",
		"                    'WECHAT'  -- 微信支付",
		"                ) THEN 'online_payment'",
		'            WHEN p.channel IN (',
		"                    'BANK',    -- 银行转账",
		"                    'TRANSFER' -- 对公转账",
		"                ) THEN 'offline_payment'",
		'            WHEN p.channel IN (',
		"                    'CASH', -- 现金支付",
		"                    'POS'   -- 刷卡支付",
		'                ) -- test',
		"                THEN 'store_payment'",
		'            ELSE',
		"                'other_payment'",
		'        END                              AS payment_type',
		'FROM payments p;'
	].join('\n')
);

run_case(
	'commented out case branches are preserved',
	[
		'SELECT  p.order_id                                                       AS order_id',
		'       ,p.channel                                                        AS channel',
		'       ,CASE',
		"            WHEN p.channel IN ('ALIPAY','WECHAT') THEN 'online_payment'  -- 主流线上支付渠道",
		"            -- WHEN p.channel IN ('BANK','TRANSFER') THEN 'offline_payment' -- 银行线下支付",
		"            -- WHEN p.channel IN ('CASH','POS')      THEN 'store_payment'   -- 门店支付方式",
		"            WHEN p.channel IN ('COUPON','POINT')  THEN 'virtual_payment' -- 虚拟资产支付",
		"            ELSE 'other_payment'                                         -- 其他支付方式",
		'        END                                                              AS payment_type',
		'FROM payments p;'
	].join('\n'),
	[
		'SELECT  p.order_id                                                       AS order_id',
		'       ,p.channel                                                        AS channel',
		'       ,CASE',
		"            WHEN p.channel IN ('ALIPAY','WECHAT') THEN 'online_payment'  -- 主流线上支付渠道",
		"            -- WHEN p.channel IN ('BANK','TRANSFER') THEN 'offline_payment' -- 银行线下支付",
		"            -- WHEN p.channel IN ('CASH','POS')      THEN 'store_payment'   -- 门店支付方式",
		"            WHEN p.channel IN ('COUPON','POINT')  THEN 'virtual_payment' -- 虚拟资产支付",
		"            ELSE 'other_payment'                                         -- 其他支付方式",
		'        END                                                              AS payment_type',
		'FROM payments p;'
	].join('\n')
);

run_case(
	'commented out multiline case branch before else is preserved',
	[
		'SELECT  p.order_id                                                       AS order_id',
		'       ,p.channel                                                        AS channel',
		'       ,CASE',
		"            WHEN p.channel IN ('ALIPAY','WECHAT') THEN 'online_payment'  -- 主流线上支付渠道",
		"            -- WHEN p.channel = 'TEST'",
		"            -- THEN 'offline_payment' -- 银行线下支付",
		"            ELSE 'other_payment'                                         -- 其他支付方式",
		'        END                                                              AS payment_type',
		'FROM payments p;'
	].join('\n'),
	[
		'SELECT  p.order_id                                                      AS order_id',
		'       ,p.channel                                                       AS channel',
		'       ,CASE',
		"            WHEN p.channel IN ('ALIPAY','WECHAT') THEN 'online_payment' -- 主流线上支付渠道",
		"            -- WHEN p.channel = 'TEST'",
		"            -- THEN 'offline_payment' -- 银行线下支付",
		"            ELSE 'other_payment'                                        -- 其他支付方式",
		'        END                                                             AS payment_type',
		'FROM payments p;'
	].join('\n')
);

console.log('case-when tests passed');
