var assert = require('assert');

var sqlFormatter = require('../lib/sql-formatter');
var sqlCommentFormatter = require('../lib/sql-comment-formatter');
var sqlCaseFormatter = require('../lib/sql-case-formatter');
var sqlSelectFormatter = require('../lib/sql-select-formatter');
var sqlConditionFormatter = require('../lib/sql-condition-formatter');
var sqlDdlFormatter = require('../lib/sql-ddl-formatter');

assert.strictEqual(typeof sqlFormatter.format_sql, 'function', 'sql-formatter must export format_sql');
assert.strictEqual(typeof sqlCommentFormatter.normalize_line_comment_spacing, 'function', 'comment formatter must export normalize_line_comment_spacing');
assert.strictEqual(typeof sqlCaseFormatter.format_case_blocks, 'function', 'case formatter must export format_case_blocks');
assert.strictEqual(typeof sqlSelectFormatter.align_as_in_select_blocks, 'function', 'select formatter must export align_as_in_select_blocks');
assert.strictEqual(typeof sqlConditionFormatter.align_condition_clauses, 'function', 'condition formatter must export align_condition_clauses');
assert.strictEqual(typeof sqlDdlFormatter.ddl, 'function', 'DDL formatter must export ddl');
assert.strictEqual(typeof sqlDdlFormatter.extractddl, 'function', 'DDL formatter must export extractddl');

var placeholderFormatted = sqlFormatter.format_sql('select NEEDReplace as c from t', {
	uppercase: true,
	comma_location: false,
	bracket_char: true,
	as_loc_cnt: 150,
	case_when_then_wrap_length: 80,
	dialect: 'generic'
});

assert.ok(
	placeholderFormatted.indexOf('NEEDReplace') >= 0,
	'sql-formatter must preserve placeholder-like user text\n--- actual ---\n' + placeholderFormatted
);
assert.strictEqual(
	placeholderFormatted.indexOf('undefined'),
	-1,
	'sql-formatter must not convert placeholder-like user text to undefined'
);

var postgresFormatted = sqlFormatter.format_sql("select data->>'name' as name from t", {
	uppercase: true,
	comma_location: false,
	bracket_char: true,
	as_loc_cnt: 150,
	case_when_then_wrap_length: 80,
	dialect: 'postgres'
});

assert.ok(
	postgresFormatted.indexOf("data->>'name'") >= 0,
	"sql-formatter must preserve PostgreSQL JSON text operator\n--- actual ---\n" + postgresFormatted
);
assert.strictEqual(
	postgresFormatted.indexOf('->  >'),
	-1,
	'sql-formatter must not split PostgreSQL JSON operator'
);

console.log('module boundary tests passed');
