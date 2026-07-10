var assert = require('assert');
var cases = require('../fixtures/v2-parser-evaluation-cases');
var evaluator = require('../../scripts/v2-parser-evaluation/evaluator');
var candidate = require('../../scripts/v2-parser-evaluation/candidates/dt-sql-parser');
var probeDtSqlParser = require('../../scripts/v2-parser-evaluation/probe-dt-sql-parser').probe_dt_sql_parser;

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

var astralCommentSource = 'SELECT 1; -- keep ' + String.fromCodePoint(0x1f600);
var astralCommentResult = candidate.analyze({
    id: 'astral-comment',
    dialect: 'hive',
    expectation: 'required',
    source: astralCommentSource,
    atomicLexemes: ['-- keep ' + String.fromCodePoint(0x1f600)],
    tags: ['unicode'],
});
var astralCommentLeaves = astralCommentResult.leaves.filter(function(leaf) {
    return leaf.raw == '-- keep ' + String.fromCodePoint(0x1f600);
});
assert.strictEqual(astralCommentResult.accepted, true);
assert.deepStrictEqual(astralCommentResult.errors, []);
assert.strictEqual(astralCommentResult.nodeCount, 26);
assert.strictEqual(astralCommentResult.nodeSpansValid, true);
assert.deepStrictEqual(astralCommentLeaves, [{
    kind: 'trivia',
    raw: '-- keep ' + String.fromCodePoint(0x1f600),
    span: { start: 10, end: 20 },
}]);
evaluator.assert_leaf_partition(astralCommentSource, astralCommentResult.leaves);

var rejectedCandidate = {
    analyze: function() {
        return {
            accepted: false,
            errors: ['rejected by fake candidate'],
            leaves: [],
            nodeCount: 1,
            nodeSpansValid: true,
        };
    },
};
assert.throws(function() {
    probeDtSqlParser(rejectedCandidate);
}, function(error) {
    return /scale-100 warm-up/.test(error.message)
        && /accepted must be true/.test(error.message)
        && /errors must be empty/.test(error.message);
});

var timedAnalysisCount = 0;
var emptyTimedCandidate = {
    analyze: function() {
        timedAnalysisCount++;
        if (timedAnalysisCount == 4) {
            return {
                accepted: true,
                errors: [],
                leaves: [],
                nodeCount: 0,
                nodeSpansValid: false,
            };
        }
        return {
            accepted: true,
            errors: [],
            leaves: [],
            nodeCount: 1,
            nodeSpansValid: true,
        };
    },
};
assert.throws(function() {
    probeDtSqlParser(emptyTimedCandidate);
}, function(error) {
    return /scale-100 timed sample 3/.test(error.message)
        && /nodeCount must be greater than zero/.test(error.message)
        && /nodeSpansValid must be true/.test(error.message);
});
console.log('dt-sql-parser candidate adapter tests passed');
