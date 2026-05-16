var assert = require('assert');
var fs = require('fs');
var path = require('path');

var sqlFormatter = require('../lib/sql-formatter');
var sqlCommentFormatter = require('../lib/sql-comment-formatter');
var sqlCaseFormatter = require('../lib/sql-case-formatter');
var sqlSelectFormatter = require('../lib/sql-select-formatter');
var sqlConditionFormatter = require('../lib/sql-condition-formatter');
var sqlDdlFormatter = require('../lib/sql-ddl-formatter');

function read_source(relative_path) {
	return fs.readFileSync(path.join(__dirname, '..', relative_path), 'utf8');
}

function resolve_local_require(from_relative_path, request) {
	if (!/^\.\.?\//.test(request)) {
		return null;
	}

	var resolved = path.normalize(path.join(path.dirname(from_relative_path), request));
	if (!/\.js$/.test(resolved)) {
		resolved += '.js';
	}

	if (resolved.indexOf('lib' + path.sep) !== 0) {
		return null;
	}

	return resolved;
}

function collect_live_formatter_sources(entry_relative_path) {
	var pending = [entry_relative_path];
	var seen = {};
	var sources = {};

	while (pending.length > 0) {
		var current = pending.pop();
		if (seen[current]) {
			continue;
		}
		seen[current] = true;

		var source = read_source(current);
		sources[current] = source;

		source.replace(/require\(['"]([^'"]+)['"]\)/g, function(_, request) {
			var resolved = resolve_local_require(current, request);
			if (resolved && !seen[resolved]) {
				pending.push(resolved);
			}
			return _;
		});
	}

	return sources;
}

assert.strictEqual(typeof sqlFormatter.format_sql, 'function', 'sql-formatter must export format_sql');
assert.strictEqual(typeof sqlCommentFormatter.normalize_line_comment_spacing, 'function', 'comment formatter must export normalize_line_comment_spacing');
assert.strictEqual(typeof sqlCaseFormatter.format_case_blocks, 'function', 'case formatter must export format_case_blocks');
assert.strictEqual(typeof sqlSelectFormatter.format_select_clause_lists, 'function', 'select formatter must export format_select_clause_lists');
assert.strictEqual(typeof sqlSelectFormatter.align_as_in_select_blocks, 'function', 'select formatter must export align_as_in_select_blocks');
assert.strictEqual(typeof sqlConditionFormatter.wrap_condition_clauses, 'function', 'condition formatter must export wrap_condition_clauses');
assert.strictEqual(typeof sqlConditionFormatter.align_condition_clauses, 'function', 'condition formatter must export align_condition_clauses');
assert.strictEqual(typeof sqlDdlFormatter.ddl, 'function', 'DDL formatter must export ddl');
assert.strictEqual(typeof sqlDdlFormatter.extractddl, 'function', 'DDL formatter must export extractddl');
assert.strictEqual(typeof ''.times, 'undefined', 'formatter modules must not pollute String.prototype');

var liveFormatterSources = collect_live_formatter_sources('lib/sql-formatter.js');
var formatterSource = liveFormatterSources['lib/sql-formatter.js'];
var lexicalNormalizerSource = liveFormatterSources['lib/sql-lexical-normalizer.js'];
var conditionFormatterSource = liveFormatterSources['lib/sql-condition-formatter.js'];
var combinedLiveFormatterSource = Object.keys(liveFormatterSources).sort().map(function(relative_path) {
	return '\n/* ' + relative_path + ' */\n' + liveFormatterSources[relative_path];
}).join('\n');

assert.ok(
	conditionFormatterSource,
	'live formatter dependency graph must include sql-condition-formatter so indirect condition_wrap calls are checked'
);

assert.strictEqual(
	/replace_char\s*\(/.test(formatterSource + lexicalNormalizerSource),
	false,
	'live formatter path must not call replace_char string furnace'
);
assert.strictEqual(
	/\bcondition_wrap\s*\(/.test(combinedLiveFormatterSource),
	false,
	'live formatter dependency graph must not call condition_wrap state machine'
);
assert.strictEqual(
	/\bfunction\s+condition_wrap\b|\bcondition_wrap\s*[:=]|exports\.condition_wrap\b/.test(conditionFormatterSource),
	false,
	'condition formatter must not retain the legacy condition_wrap state machine on the live module'
);
assert.strictEqual(
	/except_subquery\s*\(/.test(formatterSource),
	false,
	'live formatter path must not call except_subquery state machine'
);
assert.strictEqual(
	/sqlNormalizePasses\.(bracket_deep|extra)\b/.test(formatterSource),
	false,
	'live formatter path must not call legacy normalize layout helpers'
);

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
