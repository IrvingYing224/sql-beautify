var assert = require('assert');
var vkbeautify = require('../vkbeautify');

function format(sql, uppercase, wrapLength) {
	return vkbeautify.sql(sql, uppercase !== false, false, false, 150, wrapLength || 50).trim();
}

function run_case(name, input, expected, uppercase, wrapLength) {
	var actual = format(input, uppercase, wrapLength);
	assert.strictEqual(actual, expected.trim(), name + '\n--- actual ---\n' + actual + '\n--- expected ---\n' + expected.trim());
}

run_case(
	'searched case aligns CASE/WHEN/END',
	"select case when a=1 then 'x' when b=2 then 'y' else 'z' end as c from t",
	"SELECT\n       CASE\n           WHEN a = 1 THEN 'x'\n           WHEN b = 2 THEN 'y'\n           ELSE 'z'\n       END AS c\nFROM t"
);

run_case(
	'simple case keeps operand on CASE line',
	"select case status when 1 then 'a' -- one\nwhen 2 then 'b' -- two\nelse 'c' -- three\nend as flag from t",
	"SELECT\n       CASE status\n           WHEN 1 THEN 'a'  -- one\n           WHEN 2 THEN 'b'  -- two\n           ELSE 'c'         -- three\n       END AS flag\nFROM t"
);

run_case(
	'long when or then wraps all THEN and ELSE values',
	"select case when very_long_column_name = 1 and another_col = 2 and third_col = 3 then some_really_long_expression + another_really_long_expression -- long then\nwhen b=2 then y -- short\nelse z -- else\nend as c from t",
	"SELECT\n       CASE\n           WHEN very_long_column_name = 1 AND another_col = 2 AND third_col = 3\n               THEN some_really_long_expression + another_really_long_expression  -- long then\n           WHEN b = 2\n               THEN y                                                             -- short\n           ELSE\n               z                                                                  -- else\n       END AS c\nFROM t"
);

run_case(
	'group by case uses the same block layout',
	"select a from t group by case when a=1 then 'x' when b=2 then 'y' else 'z' end",
	"SELECT  a\nFROM t\nGROUP BY\n         CASE\n             WHEN a = 1 THEN 'x'\n             WHEN b = 2 THEN 'y'\n             ELSE 'z'\n         END"
);

run_case(
	'lowercase mode keeps comma case blocks formatted',
	"select a,case when a=1 then 'x' when b=2 then 'y' else 'z' end as c from t",
	"select  a\n       ,case\n            when a = 1 then 'x'\n            when b = 2 then 'y'\n            else 'z'\n        end as c\nfrom t",
	false
);

run_case(
	'end on the same line as final when still reformats',
	"SELECT CASE  WHEN name = 'fdsfsdfsdafsdafdsfsdafsdfsdfsdfsdfsdfsdfsdafsdfsdafsdfa' THEN 123  -- c1\n            WHEN name = 'fdsfsdfsdafsdafdsfsdafsdfsdfsdfsdfsdfsdfsdafsdfsdafsdfb' THEN 132  -- c2\n            WHEN name = 'fdsfsdfsdafsdafd' THEN 25  END AS alias -- c3\nFROM t",
	"SELECT\n       CASE\n           WHEN name = 'fdsfsdfsdafsdafdsfsdafsdfsdfsdfsdfsdfsdfsdafsdfsdafsdfa'\n               THEN 123  -- c1\n           WHEN name = 'fdsfsdfsdafsdafdsfsdafsdfsdfsdfsdfsdfsdfsdafsdfsdafsdfb'\n               THEN 132  -- c2\n           WHEN name = 'fdsfsdfsdafsdafd'\n               THEN 25\n       END AS alias      -- c3\nFROM t"
);

console.log('case-when tests passed');
