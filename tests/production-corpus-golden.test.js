var assert = require('assert');
var path = require('path');
var sqlFormatter = require('../lib/sql-formatter');
var corpus = require('./helpers/production-corpus');

var updateSnapshots = process.env.SQL_BEAUTIFY_UPDATE_SNAPSHOTS == '1';
var cases = corpus.load_public_cases();

assert.ok(cases.length >= 5, 'production corpus must include at least five public SQL cases');

cases.forEach(function(testCase) {
	var result = corpus.format_case(sqlFormatter, testCase);
	corpus.assert_formatted_contract(sqlFormatter, testCase, result);

	if (updateSnapshots) {
		corpus.write_snapshot(testCase, result.text);
		return;
	}

	var expected = corpus.read_snapshot(testCase);
	assert.notStrictEqual(
		expected,
		null,
		[
			'Missing production corpus snapshot for ' + testCase.name,
			'Expected snapshot: ' + path.relative(process.cwd(), testCase.snapshotPath),
			'Run: SQL_BEAUTIFY_UPDATE_SNAPSHOTS=1 node tests/production-corpus-golden.test.js'
		].join('\n')
	);

	assert.strictEqual(
		result.text,
		expected,
		[
			'Production corpus snapshot changed for ' + testCase.name,
			'Snapshot: ' + path.relative(process.cwd(), testCase.snapshotPath),
			'Review the formatter output diff. If the change is intentional, run:',
			'SQL_BEAUTIFY_UPDATE_SNAPSHOTS=1 node tests/production-corpus-golden.test.js'
		].join('\n')
	);
});

console.log('production corpus golden tests passed (' + cases.length + ' cases)');
