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
function assertMalformedResultRejected(payload) {
    var malformed = candidate(false);
    malformed.analyze = function() { return payload; };
    var result;
    assert.doesNotThrow(function() {
        result = evaluator.evaluate_candidate(malformed, cases, probe());
    });
    assert.strictEqual(result.decision.grammarPass, false);
    assert.strictEqual(result.decision.role, 'rejected');
}
assertMalformedResultRejected({
    accepted: true,
    errors: [],
    leaves: [null],
    nodeCount: 1,
    nodeSpansValid: true,
});
assertMalformedResultRejected(null);
assertMalformedResultRejected({
    accepted: true,
    errors: [],
    nodeCount: 1,
    nodeSpansValid: true,
});
var emptyTree = candidate(false);
var analyzeWithNodes = emptyTree.analyze;
emptyTree.analyze = function(testCase) {
    var result = analyzeWithNodes(testCase);
    if (testCase.expectation == 'required') {
        result.nodeCount = 0;
        result.nodeSpansValid = true;
    }
    return result;
};
var emptyTreeResult = evaluator.evaluate_candidate(emptyTree, cases, probe());
assert.strictEqual(emptyTreeResult.summary.requiredNodeSpanRate, 0);
assert.strictEqual(emptyTreeResult.decision.grammarPass, false);
assert.strictEqual(emptyTreeResult.decision.role, 'rejected');
var compoundBundledLicenseResult = evaluator.evaluate_candidate(candidate(false), cases, probe({
    bundledPackages: [{ name: 'bad', version: '1.0.0', license: 'GPL-3.0 WITH MIT exception' }],
}));
assert.strictEqual(compoundBundledLicenseResult.decision.licensePass, false);
assert.strictEqual(compoundBundledLicenseResult.decision.role, 'rejected');
var compoundCandidateLicense = candidate(false);
compoundCandidateLicense.metadata.license = 'MIT OR GPL-3.0';
var compoundCandidateLicenseResult = evaluator.evaluate_candidate(compoundCandidateLicense, cases, probe());
assert.strictEqual(compoundCandidateLicenseResult.decision.licensePass, false);
assert.strictEqual(compoundCandidateLicenseResult.decision.role, 'rejected');
assert.throws(function() {
    evaluator.assert_leaf_partition('abc', [
        { raw: 'a', span: { start: 0, end: 1 } },
        { raw: 'c', span: { start: 2, end: 3 } },
    ]);
}, /gap-free/);
console.log('v2 parser evaluation harness tests passed');
