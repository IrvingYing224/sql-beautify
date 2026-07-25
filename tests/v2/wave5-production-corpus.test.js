var assert = require('assert');
var sqlFormatter = require('../../dist/sql-formatter.cjs');
var corpus = require('./helpers/production-corpus');

var cases = corpus.load_public_cases();

assert.ok(cases.length >= 5, 'production corpus must include at least five public SQL cases');

cases.forEach(function(testCase) {
	var result = corpus.format_case(sqlFormatter, testCase);
	corpus.assert_formatted_contract(sqlFormatter, testCase, result);
});

console.log('v2 production corpus safety tests passed (' + cases.length + ' cases)');
