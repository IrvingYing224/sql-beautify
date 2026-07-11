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
var ALLOWED_DIALECTS = ['hive', 'generic', 'postgresql', 'mysql'];
var ALLOWED_EXPECTATIONS = ['required', 'opaque', 'invalid'];

function rate(passed, total) {
    return passed / total;
}

function license_allowed(value) {
    return typeof value == 'string' && ALLOWED_LICENSES.indexOf(value) >= 0;
}

function is_object(value) {
    return value !== null && typeof value == 'object' && !Array.isArray(value);
}

function is_non_empty_string(value) {
    return typeof value == 'string' && value.trim().length > 0;
}

function is_dense_array(value) {
    if (!Array.isArray(value)) {
        return false;
    }
    for (var index = 0; index < value.length; index++) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) {
            return false;
        }
    }
    return true;
}

function assert_candidate_schema(candidate) {
    assert.ok(is_object(candidate), 'candidate must be an object');
    assert.ok(is_object(candidate.metadata), 'candidate metadata must be an object');
    ['name', 'version', 'license'].forEach(function(field) {
        assert.ok(
            is_non_empty_string(candidate.metadata[field]),
            'candidate metadata ' + field + ' must be a non-empty string'
        );
    });
    assert.strictEqual(typeof candidate.analyze, 'function', 'candidate analyze must be a function');
}

function assert_cases_schema(cases) {
    assert.ok(Array.isArray(cases) && cases.length > 0, 'evaluation cases must be a non-empty array');
    assert.ok(is_dense_array(cases), 'evaluation cases must be a dense array');
    var ids = Object.create(null);
    var requiredCount = 0;
    var invalidCount = 0;
    var atomicTotal = 0;
    for (var caseIndex = 0; caseIndex < cases.length; caseIndex++) {
        var testCase = cases[caseIndex];
        var label = is_non_empty_string(testCase && testCase.id) ? testCase.id : String(caseIndex);
        assert.ok(is_object(testCase), 'case ' + caseIndex + ' must be an object');
        assert.ok(is_non_empty_string(testCase.id), 'case ' + caseIndex + ' id must be a non-empty string');
        assert.ok(!ids[testCase.id], 'case ids must be unique: ' + testCase.id);
        ids[testCase.id] = true;
        assert.ok(
            ALLOWED_DIALECTS.indexOf(testCase.dialect) >= 0,
            'case ' + label + ' dialect must be one of ' + ALLOWED_DIALECTS.join(', ')
        );
        assert.ok(
            ALLOWED_EXPECTATIONS.indexOf(testCase.expectation) >= 0,
            'case ' + label + ' expectation must be one of ' + ALLOWED_EXPECTATIONS.join(', ')
        );
        assert.ok(is_non_empty_string(testCase.source), 'case ' + label + ' source must be a non-empty string');
        assert.ok(Array.isArray(testCase.atomicLexemes), 'case ' + label + ' atomicLexemes must be an array');
        assert.ok(is_dense_array(testCase.atomicLexemes), 'case ' + label + ' atomicLexemes must be a dense array');
        var atomicValues = Object.create(null);
        for (var atomicIndex = 0; atomicIndex < testCase.atomicLexemes.length; atomicIndex++) {
            var lexeme = testCase.atomicLexemes[atomicIndex];
            assert.ok(
                is_non_empty_string(lexeme) && testCase.source.indexOf(lexeme) >= 0,
                'case ' + label + ' atomic lexeme must be a non-empty source substring'
            );
            assert.ok(!atomicValues[lexeme], 'case ' + label + ' atomic lexemes must be unique');
            atomicValues[lexeme] = true;
        }
        assert.ok(Array.isArray(testCase.tags), 'case ' + label + ' tags must be an array');
        assert.ok(is_dense_array(testCase.tags), 'case ' + label + ' tags must be a dense array');
        var tagsValid = true;
        for (var tagIndex = 0; tagIndex < testCase.tags.length; tagIndex++) {
            if (!is_non_empty_string(testCase.tags[tagIndex])) {
                tagsValid = false;
                break;
            }
        }
        assert.ok(tagsValid, 'case ' + label + ' tags must contain non-empty strings');
        if (testCase.expectation == 'required') {
            requiredCount++;
        }
        if (testCase.expectation == 'invalid') {
            invalidCount++;
        }
        atomicTotal += testCase.atomicLexemes.length;
    }
    assert.ok(requiredCount > 0, 'evaluation corpus must include a required case');
    assert.ok(invalidCount > 0, 'evaluation corpus must include an invalid case');
    assert.ok(atomicTotal > 0, 'evaluation corpus must include atomic lexeme evidence');
}

function assert_probe_schema(probe) {
    assert.ok(is_object(probe), 'probe must be an object');
    ['bundleBytes', 'gzipBytes'].forEach(function(field) {
        assert.ok(Number.isInteger(probe[field]) && probe[field] > 0, 'probe ' + field + ' must be a positive integer');
    });
    ['coldStartMedianMs', 'parse100MedianMs', 'parse800MedianMs', 'parse1200MedianMs', 'scaleRatio'].forEach(function(field) {
        assert.ok(
            typeof probe[field] == 'number' && Number.isFinite(probe[field]) && probe[field] > 0,
            'probe ' + field + ' must be a positive finite number'
        );
    });
    var expectedScaleRatio = probe.parse800MedianMs / Math.max(0.001, probe.parse100MedianMs);
    var scaleTolerance = Math.max(1e-12, Math.abs(expectedScaleRatio) * 1e-12);
    assert.ok(
        Math.abs(probe.scaleRatio - expectedScaleRatio) <= scaleTolerance,
        'probe scaleRatio must match parse100MedianMs and parse800MedianMs'
    );
    assert.ok(Number.isInteger(probe.maxRssKb) && probe.maxRssKb > 0, 'probe maxRssKb must be a positive integer');
    assert.ok(is_object(probe.environment), 'probe environment must be an object');
    ['node', 'platform', 'arch', 'cpu'].forEach(function(field) {
        assert.ok(
            is_non_empty_string(probe.environment[field]),
            'probe environment ' + field + ' must be a non-empty string'
        );
    });
    assert.ok(is_object(probe.directLoad), 'probe directLoad must be an object');
    assert.strictEqual(typeof probe.directLoad.success, 'boolean', 'probe directLoad success must be a boolean');
    if (probe.directLoad.success) {
        assert.strictEqual(
            probe.directLoad.errorCode,
            null,
            'successful direct load must not include an error code'
        );
    } else {
        assert.ok(
            is_non_empty_string(probe.directLoad.errorCode)
                && /^[A-Z][A-Z0-9_]*$/.test(probe.directLoad.errorCode),
            'failed direct load must include a stable error code'
        );
    }
    assert.ok(
        Array.isArray(probe.bundledPackages) && probe.bundledPackages.length > 0,
        'probe bundledPackages must be a non-empty array'
    );
    assert.ok(is_dense_array(probe.bundledPackages), 'probe bundledPackages must be a dense array');
    for (var packageIndex = 0; packageIndex < probe.bundledPackages.length; packageIndex++) {
        var item = probe.bundledPackages[packageIndex];
        assert.ok(is_object(item), 'probe bundled package ' + packageIndex + ' must be an object');
        ['name', 'version', 'license'].forEach(function(field) {
            assert.ok(
                is_non_empty_string(item[field]),
                'probe bundled package ' + packageIndex + ' ' + field + ' must be a non-empty string'
            );
        });
    }
}

function rejected_result(message) {
    return {
        accepted: false,
        errors: [message],
        leaves: [],
        nodeCount: 0,
        nodeSpansValid: false,
        rejectionEvidence: false,
    };
}

function normalize_result(result) {
    if (!result || typeof result != 'object' || Array.isArray(result)) {
        return rejected_result('candidate returned malformed result');
    }
    var accepted = result.accepted;
    var errors = result.errors;
    var leaves = result.leaves;
    var nodeCount = result.nodeCount;
    var nodeSpansValid = result.nodeSpansValid;
    var failures = [];
    if (typeof accepted != 'boolean') {
        failures.push('accepted must be a boolean');
    }
    var errorsValid = is_dense_array(errors);
    if (errorsValid) {
        for (var errorIndex = 0; errorIndex < errors.length; errorIndex++) {
            if (!is_non_empty_string(errors[errorIndex])) {
                errorsValid = false;
                break;
            }
        }
    }
    if (!errorsValid) {
        failures.push('errors must be an array of non-empty strings');
    }
    var leavesValid = is_dense_array(leaves);
    if (leavesValid) {
        for (var leafIndex = 0; leafIndex < leaves.length; leafIndex++) {
            var leaf = leaves[leafIndex];
            if (!is_object(leaf)
                || !is_non_empty_string(leaf.kind)
                || typeof leaf.raw != 'string'
                || !is_object(leaf.span)
                || !Number.isInteger(leaf.span.start)
                || !Number.isInteger(leaf.span.end)
                || leaf.span.start < 0
                || leaf.span.end < leaf.span.start) {
                leavesValid = false;
                break;
            }
        }
    }
    if (!leavesValid) {
        failures.push('leaves must contain structurally valid source leaves');
    }
    if (!Number.isInteger(nodeCount) || nodeCount < 0) {
        failures.push('nodeCount must be a non-negative integer');
    }
    if (typeof nodeSpansValid != 'boolean') {
        failures.push('nodeSpansValid must be a boolean');
    }
    if (accepted === true && Array.isArray(errors) && errors.length > 0) {
        failures.push('accepted result must not include errors');
    }
    if (failures.length > 0) {
        return rejected_result('candidate returned malformed result: ' + failures.join('; '));
    }
    return {
        accepted: accepted,
        errors: errors,
        leaves: leaves,
        nodeCount: nodeCount,
        nodeSpansValid: nodeSpansValid,
        rejectionEvidence: accepted === false && errors.length > 0,
    };
}

function assert_leaf_partition(source, leaves) {
    assert.ok(Array.isArray(leaves), 'candidate leaves must be an array');
    assert.ok(is_dense_array(leaves), 'candidate leaves must be a dense array');
    var cursor = 0;
    var rebuilt = '';
    for (var leafIndex = 0; leafIndex < leaves.length; leafIndex++) {
        var leaf = leaves[leafIndex];
        assert.strictEqual(leaf.span.start, cursor, 'leaf partition must be gap-free at ' + leafIndex);
        assert.strictEqual(leaf.span.end, leaf.span.start + leaf.raw.length, 'leaf end at ' + leafIndex);
        rebuilt += leaf.raw;
        cursor = leaf.span.end;
    }
    assert.strictEqual(cursor, source.length, 'leaf partition must cover source');
    assert.strictEqual(rebuilt, source, 'leaf raw values must rebuild source');
}

function evaluate_case(candidate, testCase) {
    var result;
    var analyzeThrew = false;
    try {
        result = candidate.analyze(testCase);
    } catch (error) {
        analyzeThrew = true;
        result = rejected_result('candidate analyze threw: '
            + (error && error.message ? error.message : String(error)));
    }
    if (!analyzeThrew) {
        try {
            result = normalize_result(result);
        } catch (error) {
            result = rejected_result('candidate result inspection threw: '
                + (error && error.message ? error.message : String(error)));
        }
    }
    var roundTrip = true;
    try {
        assert_leaf_partition(testCase.source, result.leaves);
    } catch (error) {
        roundTrip = false;
    }
    var atomicPassed = 0;
    for (var atomicIndex = 0; atomicIndex < testCase.atomicLexemes.length; atomicIndex++) {
        var lexeme = testCase.atomicLexemes[atomicIndex];
        for (var leafIndex = 0; leafIndex < result.leaves.length; leafIndex++) {
            var leaf = result.leaves[leafIndex];
            if (leaf && typeof leaf.raw == 'string' && leaf.raw == lexeme) {
                atomicPassed++;
                break;
            }
        }
    }
    return {
        id: testCase.id,
        expectation: testCase.expectation,
        accepted: result.accepted,
        errors: result.errors,
        rejectionEvidence: result.rejectionEvidence,
        nodeCount: result.nodeCount,
        nodeSpansValid: result.nodeSpansValid,
        roundTrip: roundTrip,
        atomicPassed: atomicPassed,
        atomicTotal: testCase.atomicLexemes.length,
    };
}

function evaluate_candidate(candidate, cases, probe) {
    assert_candidate_schema(candidate);
    assert_cases_schema(cases);
    assert_probe_schema(probe);
    var outcomes = [];
    for (var caseIndex = 0; caseIndex < cases.length; caseIndex++) {
        outcomes.push(evaluate_case(candidate, cases[caseIndex]));
    }
    var required = outcomes.filter(function(item) { return item.expectation == 'required'; });
    var invalid = outcomes.filter(function(item) { return item.expectation == 'invalid'; });
    var atomicPassed = outcomes.reduce(function(total, item) { return total + item.atomicPassed; }, 0);
    var atomicTotal = outcomes.reduce(function(total, item) { return total + item.atomicTotal; }, 0);
    var summary = {
        totalCases: outcomes.length,
        requiredParseRate: rate(required.filter(function(item) { return item.accepted; }).length, required.length),
        invalidRejectRate: rate(invalid.filter(function(item) { return item.rejectionEvidence; }).length, invalid.length),
        roundTripRate: rate(outcomes.filter(function(item) { return item.roundTrip; }).length, outcomes.length),
        requiredNodeSpanRate: rate(required.filter(function(item) {
            return item.accepted && item.nodeCount > 0 && item.nodeSpansValid;
        }).length, required.length),
        atomicLexemeRate: rate(atomicPassed, atomicTotal),
    };
    var licensePass = license_allowed(candidate.metadata.license) && probe.bundledPackages.length > 0;
    for (var packageIndex = 0; licensePass && packageIndex < probe.bundledPackages.length; packageIndex++) {
        licensePass = license_allowed(probe.bundledPackages[packageIndex].license);
    }
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
