var assert = require('assert');
var vkbeautify = require('../vkbeautify');

function run_contains(name, input, fragments) {
	var actual = vkbeautify.sqlddl(input).trim();

	for (var i = 0; i < fragments.length; i++) {
		assert.ok(
			actual.indexOf(fragments[i]) >= 0,
			name + '\n--- missing fragment ---\n' + fragments[i] + '\n--- actual ---\n' + actual
		);
	}
}

run_contains(
	'ddl keeps decimal precision and scale',
	"create table t (price decimal(18,2) comment '金额')",
	[
		'price',
		'DECIMAL(18,2)',
		"COMMENT '金额'"
	]
);

run_contains(
	'ddl keeps array type',
	"create table t (tags array<string> comment '标签')",
	[
		'tags',
		'ARRAY<STRING>',
		"COMMENT '标签'"
	]
);

run_contains(
	'ddl keeps map type comma',
	"create table t (props map<string,string> comment '属性')",
	[
		'props',
		'MAP<STRING,STRING>',
		"COMMENT '属性'"
	]
);

run_contains(
	'ddl keeps struct type comma',
	"create table t (info struct<name:string,age:int> comment '信息')",
	[
		'info',
		'STRUCT<name:STRING,age:INT>',
		"COMMENT '信息'"
	]
);

run_contains(
	'ddl keeps comma inside comment text',
	"create table t (name string comment 'a,b,c')",
	[
		'name',
		'STRING',
		"COMMENT 'a,b,c'"
	]
);

run_contains(
	'ddl keeps table suffix clauses outside the column list',
	"create table t (id bigint comment 'id') partitioned by (ds string) stored as parquet",
	[
		"PARTITIONED BY",
		"STORED AS PARQUET"
	]
);

run_contains(
	'ddl keeps comment text with SQL-looking words',
	"create table t (name string comment 'from,where,case when then')",
	[
		"COMMENT 'from,where,case when then'"
	]
);

var extracted = vkbeautify.extractddl("insert overwrite table target select a as user_id -- 用户ID\n,b as amount -- 金额\nfrom source");
[
	'user_id',
	'amount',
	'COMMENT',
	'用户ID',
	'金额'
].forEach(function(fragment) {
	assert.ok(
		extracted.indexOf(fragment) >= 0,
		'extract ddl remains experimental but produces column comments\n--- missing fragment ---\n' + fragment + '\n--- actual ---\n' + extracted
	);
});

assert.ok(
	!/^\s*,?\s*target\s+BIGINT\b/im.test(extracted),
	'extract ddl must not treat INSERT target table as a column\n--- actual ---\n' + extracted
);

function assert_extract_columns(name, input, expected, forbidden) {
	var actual = vkbeautify.extractddl(input);

	expected.forEach(function(fragment) {
		assert.ok(
			actual.indexOf(fragment) >= 0,
			name + '\n--- missing fragment ---\n' + fragment + '\n--- actual ---\n' + actual
		);
	});

	forbidden.forEach(function(pattern) {
		assert.ok(
			!pattern.test(actual),
			name + '\n--- forbidden pattern ---\n' + pattern + '\n--- actual ---\n' + actual
		);
	});
}

assert_extract_columns(
	'extract ddl skips CTE internals and insert target',
	"with s as (select a,b from source) insert overwrite table target select a as user_id -- 用户ID\n,b as amount -- 金额\nfrom s",
	['user_id', 'amount', '用户ID', '金额'],
	[/^\s*,?\s*target\s+BIGINT\b/im, /^\s*,?\s*a\s+BIGINT\b/im, /^\s*,?\s*b\s+BIGINT\b/im]
);

assert_extract_columns(
	'extract ddl ignores line comment marker inside string',
	"select concat('--', a) as user_id -- 用户ID\nfrom source",
	['user_id', '用户ID'],
	[/^\s*,?\s*concat\b/im]
);

assert_extract_columns(
	'extract ddl ignores SQL words and comment markers inside CASE strings',
	"select case when a=1 then 'from,where' else 'x--y' end as label -- 标签\nfrom source",
	['label', '标签'],
	[/^\s*,?\s*where\b/im, /^\s*,?\s*y\b/im]
);

assert_extract_columns(
	'extract ddl respects function argument commas',
	"select named_struct('a',a,'b',b) as payload -- 结构\nfrom source",
	['payload', '结构'],
	[/^\s*,?\s*a\s+BIGINT\b/im, /^\s*,?\s*b\s+BIGINT\b/im]
);

assert_extract_columns(
	'extract ddl treats less-than as comparison operator in CASE',
	"select case when a < b then c else d end as label -- 标签\n,e as amount -- 金额\nfrom source",
	['label', 'amount', '标签', '金额'],
	[/^\s*,?\s*a\s+BIGINT\b/im]
);

run_contains(
	'ddl keeps complex type comma boundaries',
	"create table t (props map<string,string> comment '属性', info struct<a:int,b:string> comment '结构')",
	[
		'props',
		'MAP<STRING,STRING>',
		"COMMENT '属性'",
		'info',
		'STRUCT<a:INT,b:STRING>',
		"COMMENT '结构'"
	]
);

console.log('ddl regression tests passed');
