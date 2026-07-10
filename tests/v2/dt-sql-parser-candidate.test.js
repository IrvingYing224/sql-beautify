var assert = require('assert');
var cases = require('../fixtures/v2-parser-evaluation-cases');
var evaluator = require('../../scripts/v2-parser-evaluation/evaluator');
var candidate = require('../../scripts/v2-parser-evaluation/candidates/dt-sql-parser');

assert.strictEqual(candidate.metadata.name, 'dt-sql-parser');
assert.strictEqual(candidate.metadata.version, '4.5.0');
assert.ok(candidate.metadata.license.indexOf('MIT') >= 0);
cases.forEach(function(testCase) {
    var result = candidate.analyze(testCase);
    assert.strictEqual(typeof result.accepted, 'boolean', testCase.id + ' accepted');
    assert.ok(Array.isArray(result.errors), testCase.id + ' errors');
    assert.ok(Array.isArray(result.leaves), testCase.id + ' leaves');
    assert.strictEqual(typeof result.nodeCount, 'number', testCase.id + ' nodeCount');
    assert.strictEqual(typeof result.nodeSpansValid, 'boolean', testCase.id + ' nodeSpansValid');
    evaluator.assert_leaf_partition(testCase.source, result.leaves);
});
console.log('dt-sql-parser candidate adapter tests passed');
