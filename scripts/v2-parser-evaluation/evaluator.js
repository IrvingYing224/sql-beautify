var assert = require('assert');
var GATES = Object.freeze({
    requiredParseRate: 1,
    invalidRejectRate: 1,
    roundTripRate: 1,
    requiredNodeSpanRate: 1,
    maxBundleBytes: 5 * 1024 * 1024,
    maxGzipBytes: 1536 * 1024,
    maxColdStartMedianMs: 400,
    maxScaleRatio: 12,
});
var ALLOWED_LICENSES = ['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC'];

function rate(passed, total) {
    return total == 0 ? 1 : passed / total;
}

function license_allowed(value) {
    return typeof value == 'string' && ALLOWED_LICENSES.indexOf(value) >= 0;
}

function rejected_result(message) {
    return {
        accepted: false,
        errors: [message],
        leaves: [],
        nodeCount: 0,
        nodeSpansValid: false,
    };
}

function normalize_result(result) {
    if (!result || typeof result != 'object' || Array.isArray(result)) {
        return rejected_result('candidate returned malformed result');
    }
    return {
        accepted: result.accepted === true,
        errors: Array.isArray(result.errors) ? result.errors : [],
        leaves: Array.isArray(result.leaves) ? result.leaves : [],
        nodeCount: Number.isInteger(result.nodeCount) && result.nodeCount >= 0 ? result.nodeCount : 0,
        nodeSpansValid: result.nodeSpansValid === true,
    };
}

function assert_leaf_partition(source, leaves) {
    assert.ok(Array.isArray(leaves), 'candidate leaves must be an array');
    var cursor = 0;
    var rebuilt = '';
    leaves.forEach(function(leaf, index) {
        assert.strictEqual(leaf.span.start, cursor, 'leaf partition must be gap-free at ' + index);
        assert.strictEqual(leaf.span.end, leaf.span.start + leaf.raw.length, 'leaf end at ' + index);
        rebuilt += leaf.raw;
        cursor = leaf.span.end;
    });
    assert.strictEqual(cursor, source.length, 'leaf partition must cover source');
    assert.strictEqual(rebuilt, source, 'leaf raw values must rebuild source');
}

function evaluate_case(candidate, testCase) {
    var result;
    try {
        result = normalize_result(candidate.analyze(testCase));
    } catch (error) {
        result = rejected_result(error && error.message ? error.message : String(error));
    }
    var roundTrip = true;
    try {
        assert_leaf_partition(testCase.source, result.leaves);
    } catch (error) {
        roundTrip = false;
    }
    var atomicPassed = testCase.atomicLexemes.filter(function(lexeme) {
        return result.leaves.some(function(leaf) {
            return leaf && typeof leaf.raw == 'string' && leaf.raw == lexeme;
        });
    }).length;
    return {
        id: testCase.id,
        expectation: testCase.expectation,
        accepted: result.accepted === true,
        errors: Array.isArray(result.errors) ? result.errors : [],
        nodeCount: result.nodeCount,
        nodeSpansValid: result.nodeSpansValid === true,
        roundTrip: roundTrip,
        atomicPassed: atomicPassed,
        atomicTotal: testCase.atomicLexemes.length,
    };
}

function evaluate_candidate(candidate, cases, probe) {
    var outcomes = cases.map(function(testCase) { return evaluate_case(candidate, testCase); });
    var required = outcomes.filter(function(item) { return item.expectation == 'required'; });
    var invalid = outcomes.filter(function(item) { return item.expectation == 'invalid'; });
    var atomicPassed = outcomes.reduce(function(total, item) { return total + item.atomicPassed; }, 0);
    var atomicTotal = outcomes.reduce(function(total, item) { return total + item.atomicTotal; }, 0);
    var summary = {
        totalCases: outcomes.length,
        requiredParseRate: rate(required.filter(function(item) { return item.accepted; }).length, required.length),
        invalidRejectRate: rate(invalid.filter(function(item) { return !item.accepted; }).length, invalid.length),
        roundTripRate: rate(outcomes.filter(function(item) { return item.roundTrip; }).length, outcomes.length),
        requiredNodeSpanRate: rate(required.filter(function(item) {
            return item.accepted && item.nodeCount > 0 && item.nodeSpansValid;
        }).length, required.length),
        atomicLexemeRate: rate(atomicPassed, atomicTotal),
    };
    var licensePass = license_allowed(candidate.metadata.license)
        && probe.bundledPackages.length > 0
        && probe.bundledPackages.every(function(item) { return license_allowed(item.license); });
    var grammarPass = summary.requiredParseRate >= GATES.requiredParseRate
        && summary.invalidRejectRate >= GATES.invalidRejectRate
        && summary.roundTripRate >= GATES.roundTripRate
        && summary.requiredNodeSpanRate >= GATES.requiredNodeSpanRate;
    var packagingPass = probe.bundleBytes <= GATES.maxBundleBytes
        && probe.gzipBytes <= GATES.maxGzipBytes;
    var performancePass = probe.coldStartMedianMs <= GATES.maxColdStartMedianMs
        && probe.scaleRatio <= GATES.maxScaleRatio;
    var role = 'rejected';
    if (grammarPass && licensePass) {
        role = packagingPass && performancePass ? 'runtime-grammar-backend' : 'development-oracle';
    }
    return {
        candidate: candidate.metadata,
        gates: GATES,
        outcomes: outcomes,
        summary: summary,
        probe: probe,
        decision: {
            role: role,
            canOwnLeafStream: summary.roundTripRate == 1 && summary.atomicLexemeRate == 1,
            grammarPass: grammarPass,
            licensePass: licensePass,
            packagingPass: packagingPass,
            performancePass: performancePass,
        },
    };
}

exports.GATES = GATES;
exports.assert_leaf_partition = assert_leaf_partition;
exports.evaluate_candidate = evaluate_candidate;
