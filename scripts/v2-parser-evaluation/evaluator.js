var assert = require('assert');
var utilTypes = require('util').types;
var GATES = Object.freeze({
    requiredParseRate: 1,
    invalidRejectRate: 1,
    sourceRoundTripRate: 1,
    requiredNodeSpanRate: 1,
    nativeTokenPartitionRate: 1,
    nativeTokenCoverageRate: 1,
    nativeAtomicLexemeRate: 1,
    maxBundleBytes: 5 * 1024 * 1024,
    maxGzipBytes: 1536 * 1024,
    maxColdStartMedianMs: 400,
    maxScaleRatio: 12,
});
var ALLOWED_LICENSES = ['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC'];
var ALLOWED_DIALECTS = ['hive', 'generic', 'postgresql', 'mysql'];
var ALLOWED_EXPECTATIONS = ['required', 'opaque', 'invalid'];
var ALLOWED_STATUSES = ['accepted', 'syntax-rejected', 'analysis-failed'];
var ALLOWED_FAILURE_STAGES = ['validate', 'tokenize', 'parse', 'analyze', 'normalize'];

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
        for (var tagIndex = 0; tagIndex < testCase.tags.length; tagIndex++) {
            assert.ok(
                is_non_empty_string(testCase.tags[tagIndex]),
                'case ' + label + ' tags must contain non-empty strings'
            );
        }
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
    assert.strictEqual(probe.bundleEntry, 'esm-named-hive', 'probe bundleEntry must identify the ESM named Hive entry');
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
        assert.strictEqual(probe.directLoad.errorCode, null, 'successful direct load must not include an error code');
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

function analysis_failed_result(stage, message) {
    return {
        status: 'analysis-failed',
        accepted: false,
        errors: [],
        analysisFailure: {
            stage: stage,
            message: message,
        },
        leaves: [],
        nativePartition: {
            valid: false,
            invalidTokenCount: 1,
            overlapTokenCount: 0,
            nonTriviaGapCount: 1,
        },
        nodeCount: 0,
        nodeSpansValid: false,
        rejectionEvidence: false,
    };
}

function is_own_data_descriptor(descriptor) {
    return !!descriptor
        && Object.prototype.hasOwnProperty.call(descriptor, 'value')
        && typeof descriptor.get != 'function'
        && typeof descriptor.set != 'function';
}

// Strict dense data-array snapshot for candidate evidence arrays.
// Baseline is descriptor-first so index accessors cannot rewrite unread slots.
function snapshot_dense_array(value, failureMessage, mapItem) {
    try {
        if (utilTypes.isProxy(value)) {
            return { ok: false, message: failureMessage, items: [] };
        }
        if (!Array.isArray(value)) {
            return { ok: false, message: failureMessage, items: [] };
        }
        var initialLength = value.length;
        if (!Number.isInteger(initialLength) || initialLength < 0) {
            return { ok: false, message: failureMessage, items: [] };
        }
        var baseline = [];
        for (var index = 0; index < initialLength; index++) {
            var descriptor = Object.getOwnPropertyDescriptor(value, index);
            if (!is_own_data_descriptor(descriptor)) {
                return { ok: false, message: failureMessage, items: [] };
            }
            baseline.push({
                value: descriptor.value,
                writable: descriptor.writable,
                enumerable: descriptor.enumerable,
                configurable: descriptor.configurable,
            });
        }
        var snapshot = [];
        for (var mapIndex = 0; mapIndex < baseline.length; mapIndex++) {
            var mapped = mapItem(baseline[mapIndex].value);
            if (!mapped.ok) {
                return { ok: false, message: mapped.message || failureMessage, items: [] };
            }
            snapshot.push(mapped.value);
        }
        // Re-check structural stability after all field copies.
        if (value.length !== initialLength) {
            return { ok: false, message: failureMessage, items: [] };
        }
        for (var checkIndex = 0; checkIndex < initialLength; checkIndex++) {
            var checkDescriptor = Object.getOwnPropertyDescriptor(value, checkIndex);
            if (!is_own_data_descriptor(checkDescriptor)
                || checkDescriptor.value !== baseline[checkIndex].value
                || checkDescriptor.writable !== baseline[checkIndex].writable
                || checkDescriptor.enumerable !== baseline[checkIndex].enumerable
                || checkDescriptor.configurable !== baseline[checkIndex].configurable) {
                return { ok: false, message: failureMessage, items: [] };
            }
        }
        // No new trailing own indexes beyond the original dense length.
        if (Object.prototype.hasOwnProperty.call(value, initialLength)) {
            return { ok: false, message: failureMessage, items: [] };
        }
        return { ok: true, message: null, items: snapshot };
    } catch (error) {
        return { ok: false, message: failureMessage, items: [] };
    }
}

function copy_errors(value, failures) {
    var result = snapshot_dense_array(value, 'errors must be an array of non-empty strings', function(item) {
        if (!is_non_empty_string(item)) {
            return { ok: false, message: 'errors must be an array of non-empty strings' };
        }
        return { ok: true, value: item };
    });
    if (!result.ok) {
        failures.push(result.message);
        return [];
    }
    return result.items;
}

function copy_leaves(value, failures) {
    var result = snapshot_dense_array(value, 'leaves must contain structurally valid source leaves', function(leaf) {
        if (!is_object(leaf)) {
            return { ok: false, message: 'leaves must contain structurally valid source leaves' };
        }
        var kind = leaf.kind;
        var origin = leaf.origin;
        var raw = leaf.raw;
        var span = leaf.span;
        var start = span && span.start;
        var end = span && span.end;
        if (!is_non_empty_string(kind)
            || ['candidate', 'synthetic'].indexOf(origin) < 0
            || (origin == 'candidate' && ['token', 'trivia'].indexOf(kind) < 0)
            || (origin == 'synthetic' && ['gap', 'opaque'].indexOf(kind) < 0)
            || typeof raw != 'string'
            || !is_object(span)
            || !Number.isInteger(start)
            || !Number.isInteger(end)
            || start < 0
            || end < start) {
            return { ok: false, message: 'leaves must contain structurally valid source leaves' };
        }
        return {
            ok: true,
            value: Object.freeze({
                kind: kind,
                origin: origin,
                raw: raw,
                span: Object.freeze({ start: start, end: end }),
            }),
        };
    });
    if (!result.ok) {
        failures.push(result.message);
        return [];
    }
    return Object.freeze(result.items);
}

function copy_analysis_failure(value, failures) {
    if (value === null) {
        return null;
    }
    if (!is_object(value)) {
        failures.push('analysisFailure must be null or a structured failure');
        return null;
    }
    var stage = value.stage;
    var message = value.message;
    if (ALLOWED_FAILURE_STAGES.indexOf(stage) < 0 || !is_non_empty_string(message)) {
        failures.push('analysisFailure must contain a stable stage and message');
        return null;
    }
    return Object.freeze({ stage: stage, message: message });
}

function copy_native_partition(value, failures) {
    if (!is_object(value)) {
        failures.push('nativePartition must be a structured object');
        return null;
    }
    var valid = value.valid;
    var invalidTokenCount = value.invalidTokenCount;
    var overlapTokenCount = value.overlapTokenCount;
    var nonTriviaGapCount = value.nonTriviaGapCount;
    if (typeof valid != 'boolean'
        || !Number.isInteger(invalidTokenCount) || invalidTokenCount < 0
        || !Number.isInteger(overlapTokenCount) || overlapTokenCount < 0
        || !Number.isInteger(nonTriviaGapCount) || nonTriviaGapCount < 0
        || (valid && (invalidTokenCount > 0 || overlapTokenCount > 0))
        || (!valid && invalidTokenCount == 0 && overlapTokenCount == 0)) {
        failures.push('nativePartition must contain consistent non-negative evidence');
        return null;
    }
    return Object.freeze({
        valid: valid,
        invalidTokenCount: invalidTokenCount,
        overlapTokenCount: overlapTokenCount,
        nonTriviaGapCount: nonTriviaGapCount,
    });
}

function normalize_result(result) {
    if (!result || typeof result != 'object' || Array.isArray(result)) {
        return analysis_failed_result('normalize', 'candidate returned malformed result');
    }
    var failures = [];
    var status = result.status;
    var accepted = result.accepted;
    var errors = copy_errors(result.errors, failures);
    var analysisFailure = copy_analysis_failure(result.analysisFailure, failures);
    var leaves = copy_leaves(result.leaves, failures);
    var nativePartition = copy_native_partition(result.nativePartition, failures);
    var nodeCount = result.nodeCount;
    var nodeSpansValid = result.nodeSpansValid;
    if (ALLOWED_STATUSES.indexOf(status) < 0) {
        failures.push('status must describe accepted, syntax-rejected, or analysis-failed');
    }
    if (typeof accepted != 'boolean') {
        failures.push('accepted must be a boolean');
    }
    if (!Number.isInteger(nodeCount) || nodeCount < 0) {
        failures.push('nodeCount must be a non-negative integer');
    }
    if (typeof nodeSpansValid != 'boolean') {
        failures.push('nodeSpansValid must be a boolean');
    }
    if (status == 'accepted' && (accepted !== true || errors.length > 0 || analysisFailure !== null)) {
        failures.push('accepted status must contain only successful evidence');
    }
    if (status == 'syntax-rejected' && (accepted !== false || errors.length == 0 || analysisFailure !== null)) {
        failures.push('syntax-rejected status must contain parser syntax diagnostics only');
    }
    if (status == 'analysis-failed' && (accepted !== false || errors.length > 0 || analysisFailure === null)) {
        failures.push('analysis-failed status must contain an internal analysis failure only');
    }
    if (failures.length > 0) {
        return analysis_failed_result('normalize', 'candidate returned malformed result: ' + failures.join('; '));
    }
    var derivedNonTriviaGapCount = leaves.filter(function(leaf) {
        return leaf.origin == 'synthetic' && !/^\s*$/.test(leaf.raw);
    }).length;
    if (nativePartition.nonTriviaGapCount != derivedNonTriviaGapCount) {
        return analysis_failed_result(
            'normalize',
            'candidate nativePartition.nonTriviaGapCount contradicts derived leaf evidence'
        );
    }
    return Object.freeze({
        status: status,
        accepted: accepted,
        errors: Object.freeze(errors),
        analysisFailure: analysisFailure,
        leaves: leaves,
        nativePartition: nativePartition,
        nodeCount: nodeCount,
        nodeSpansValid: nodeSpansValid,
        rejectionEvidence: status == 'syntax-rejected',
    });
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
        result = analysis_failed_result(
            'analyze',
            'candidate analyze threw: ' + (error && error.message ? error.message : String(error))
        );
    }
    if (!analyzeThrew) {
        try {
            result = normalize_result(result);
        } catch (error) {
            result = analysis_failed_result(
                'normalize',
                'candidate result inspection threw: '
                    + (error && error.message ? error.message : String(error))
            );
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
            if (leaf.origin == 'candidate' && leaf.raw == lexeme) {
                atomicPassed++;
                break;
            }
        }
    }
    var nativeCoverageComplete = result.nativePartition.valid
        && result.nativePartition.nonTriviaGapCount == 0;
    return Object.freeze({
        id: testCase.id,
        expectation: testCase.expectation,
        status: result.status,
        accepted: result.accepted,
        errors: result.errors,
        analysisFailure: result.analysisFailure,
        rejectionEvidence: result.rejectionEvidence,
        nodeCount: result.nodeCount,
        nodeSpansValid: result.nodeSpansValid,
        roundTrip: roundTrip,
        nativePartitionValid: result.nativePartition.valid,
        nativeCoverageComplete: nativeCoverageComplete,
        invalidTokenCount: result.nativePartition.invalidTokenCount,
        overlapTokenCount: result.nativePartition.overlapTokenCount,
        nonTriviaGapCount: result.nativePartition.nonTriviaGapCount,
        atomicPassed: atomicPassed,
        atomicTotal: testCase.atomicLexemes.length,
    });
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
        requiredParseRate: rate(required.filter(function(item) { return item.status == 'accepted'; }).length, required.length),
        invalidRejectRate: rate(invalid.filter(function(item) { return item.rejectionEvidence; }).length, invalid.length),
        sourceRoundTripRate: rate(outcomes.filter(function(item) { return item.roundTrip; }).length, outcomes.length),
        requiredNodeSpanRate: rate(required.filter(function(item) {
            return item.status == 'accepted' && item.nodeCount > 0 && item.nodeSpansValid;
        }).length, required.length),
        nativeTokenPartitionRate: rate(outcomes.filter(function(item) {
            return item.nativePartitionValid;
        }).length, outcomes.length),
        nativeTokenCoverageRate: rate(outcomes.filter(function(item) {
            return item.nativeCoverageComplete;
        }).length, outcomes.length),
        nativeAtomicLexemeRate: rate(atomicPassed, atomicTotal),
    };
    var licensePass = license_allowed(candidate.metadata.license) && probe.bundledPackages.length > 0;
    for (var packageIndex = 0; licensePass && packageIndex < probe.bundledPackages.length; packageIndex++) {
        licensePass = license_allowed(probe.bundledPackages[packageIndex].license);
    }
    var grammarPass = summary.requiredParseRate >= GATES.requiredParseRate
        && summary.invalidRejectRate >= GATES.invalidRejectRate
        && summary.sourceRoundTripRate >= GATES.sourceRoundTripRate
        && summary.requiredNodeSpanRate >= GATES.requiredNodeSpanRate;
    var packagingPass = probe.bundleBytes <= GATES.maxBundleBytes
        && probe.gzipBytes <= GATES.maxGzipBytes;
    var performancePass = probe.coldStartMedianMs <= GATES.maxColdStartMedianMs
        && probe.scaleRatio <= GATES.maxScaleRatio;
    var tokenOwnershipPass = summary.sourceRoundTripRate >= GATES.sourceRoundTripRate
        && summary.nativeTokenPartitionRate >= GATES.nativeTokenPartitionRate
        && summary.nativeTokenCoverageRate >= GATES.nativeTokenCoverageRate
        && summary.nativeAtomicLexemeRate >= GATES.nativeAtomicLexemeRate;
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
            canOwnLeafStream: tokenOwnershipPass,
            tokenOwnershipPass: tokenOwnershipPass,
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
