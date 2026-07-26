var assert = require('assert');
var sqlFormatter = require('../../dist/sql-formatter.cjs');
var corpus = require('./helpers/production-corpus');

var cases = corpus.load_public_cases();

var EXPECTED_FILES = [
    'cjk-identifier-generic.sql',
    'cjk-identifier-hive.sql',
    'cjk-identifier-mysql.sql',
    'cjk-identifier-postgresql.sql',
    'hive-crlf-bom-comments.sql',
    'hive-cte-window-comments.sql',
    'hive-insert-into.sql',
    'hive-large-cte-window-case.sql',
    'hive-preserve-ddl.sql',
    'hive-preserve-delete.sql',
    'hive-preserve-explain.sql',
    'hive-preserve-grouping-sets.sql',
    'hive-preserve-transform.sql',
    'hive-preserve-update.sql',
    'hive-set.sql',
    'hive-template-variables.sql',
    'hive-trailing-comma-line-comment.sql',
    'postgres-json-dollar.sql',
    'unsupported-match-recognize.sql',
    'unsupported-pivot-qualify-safety.sql'
];

assert.deepStrictEqual(cases.map(function(testCase) {
    return testCase.relativePath;
}).sort(), EXPECTED_FILES, 'production corpus exact SQL manifest');

cases.forEach(function(testCase) {
	if (testCase.minimumBytes !== null) {
		assert.ok(Buffer.byteLength(testCase.sql, 'utf8') >= testCase.minimumBytes,
			testCase.name + ' minimum production-shaped byte size');
	}
	var result = corpus.format_case(sqlFormatter, testCase);
	corpus.assert_formatted_contract(sqlFormatter, testCase, result);
});

console.log('v2 production corpus safety tests passed (' + cases.length + ' cases)');
