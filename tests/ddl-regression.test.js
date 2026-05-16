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
