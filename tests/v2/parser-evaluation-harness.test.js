var assert = require('assert');
var evaluator = require('../../scripts/v2-parser-evaluation/evaluator');
var cases = [
    { id: 'required', dialect: 'hive', expectation: 'required', source: 'SELECT 1', atomicLexemes: [], tags: [] },
    { id: 'atomic', dialect: 'postgresql', expectation: 'required', source: '$1', atomicLexemes: ['$1'], tags: [] },
    { id: 'invalid', dialect: 'hive', expectation: 'invalid', source: "'", atomicLexemes: [], tags: [] },
];

function candidate(failRequired) {
    return {
        metadata: { name: 'fake', version: '1.0.0', license: 'MIT' },
        analyze: function(testCase) {
            var accepted = testCase.expectation != 'invalid';
            if (failRequired && testCase.id == 'required') {
                accepted = false;
            }
            return {
                accepted: accepted,
                errors: accepted ? [] : ['rejected'],
                leaves: [{ kind: 'token', raw: testCase.source, span: { start: 0, end: testCase.source.length } }],
                nodeCount: accepted ? 1 : 0,
                nodeSpansValid: accepted,
            };
        },
    };
}

function probe(overrides) {
    return Object.assign({
        bundleBytes: 1024,
        gzipBytes: 512,
        coldStartMedianMs: 10,
        scaleRatio: 8,
        parse1200MedianMs: 50,
        bundledPackages: [{ name: 'fake', version: '1.0.0', license: 'MIT' }],
    }, overrides || {});
}

var runtime = evaluator.evaluate_candidate(candidate(false), cases, probe());
assert.strictEqual(runtime.decision.role, 'runtime-grammar-backend');
assert.strictEqual(runtime.decision.canOwnLeafStream, true);
var oracle = evaluator.evaluate_candidate(candidate(false), cases, probe({
    bundleBytes: evaluator.GATES.maxBundleBytes + 1,
}));
assert.strictEqual(oracle.decision.role, 'development-oracle');
var rejected = evaluator.evaluate_candidate(candidate(true), cases, probe());
assert.strictEqual(rejected.decision.role, 'rejected');
assert.throws(function() {
    evaluator.assert_leaf_partition('abc', [
        { raw: 'a', span: { start: 0, end: 1 } },
        { raw: 'c', span: { start: 2, end: 3 } },
    ]);
}, /gap-free/);
console.log('v2 parser evaluation harness tests passed');
