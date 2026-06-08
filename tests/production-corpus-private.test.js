var assert = require('assert');
var path = require('path');
var sqlFormatter = require('../lib/sql-formatter');
var corpus = require('./helpers/production-corpus');

var privateRoot = process.env.SQL_BEAUTIFY_CORPUS_DIR;

if (!privateRoot) {
	console.log('private production corpus skipped: SQL_BEAUTIFY_CORPUS_DIR is not set');
	process.exit(0);
}

var cases = corpus.load_private_cases(privateRoot);
assert.ok(cases.length > 0, 'private production corpus has no .sql files: ' + privateRoot);

cases.forEach(function(testCase) {
	var result = corpus.format_case(sqlFormatter, testCase);
	corpus.assert_formatted_contract(sqlFormatter, testCase, result);
});

console.log('private production corpus tests passed (' + cases.length + ' cases from ' + path.resolve(privateRoot) + ')');
