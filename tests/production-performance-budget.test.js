var assert = require('assert');
var sqlFormatter = require('../lib/sql-formatter');
var corpus = require('./helpers/production-corpus');
var performanceReport = require('./helpers/performance-report');

var cases = corpus.load_public_cases();
assert.ok(cases.length >= 5, 'production performance budget requires public corpus cases');

cases.forEach(function(testCase) {
	corpus.format_case(sqlFormatter, testCase);
});

var samples = cases.map(function(testCase) {
	var start = Date.now();
	var result = corpus.format_case(sqlFormatter, testCase);
	var elapsed = Math.max(0, Date.now() - start);
	var inputChars = testCase.sql.length;
	corpus.assert_formatted_contract(sqlFormatter, testCase, result);

	return {
		name: testCase.name,
		inputChars: inputChars,
		elapsedMs: elapsed,
		msPer10kChars: inputChars > 0 ? elapsed / inputChars * 10000 : 0
	};
});

var summary = performanceReport.summarize(samples);

assert.ok(summary.totalElapsedMs < 10000, 'production corpus total elapsed must stay below disaster guard; actual=' + summary.totalElapsedMs + 'ms');
assert.ok(summary.maxMs < 5000, 'production corpus max case elapsed must stay below disaster guard; actual=' + summary.maxMs + 'ms');
assert.ok(summary.p95MsPer10kChars < 5000, 'production corpus p95 normalized elapsed must stay below disaster guard; actual=' + summary.p95MsPer10kChars + 'ms/10k chars');

console.log(performanceReport.format_summary(summary));
