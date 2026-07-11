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
        parse100MedianMs: 5,
        parse800MedianMs: 40,
        scaleRatio: 8,
        parse1200MedianMs: 50,
        maxRssKb: 1024,
        environment: {
            node: 'v20.11.1',
            platform: 'linux',
            arch: 'x64',
            cpu: 'Fixture CPU',
        },
        directLoad: {
            success: false,
            errorCode: 'ERR_FIXTURE_DIRECT_LOAD',
        },
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

var schemaFailures = [];
function expectSchemaError(label, action, pattern) {
    try {
        action();
        schemaFailures.push(label + ': did not throw');
    } catch (error) {
        if (!pattern.test(error && error.message ? error.message : String(error))) {
            schemaFailures.push(label + ': wrong error: ' + (error && error.message ? error.message : String(error)));
        }
    }
}

expectSchemaError('candidate object', function() {
    evaluator.evaluate_candidate(null, cases, probe());
}, /candidate must be an object/);
expectSchemaError('candidate metadata', function() {
    evaluator.evaluate_candidate({ analyze: candidate(false).analyze }, cases, probe());
}, /candidate metadata must be an object/);
['name', 'version', 'license'].forEach(function(field) {
    expectSchemaError('candidate metadata ' + field, function() {
        var malformed = candidate(false);
        malformed.metadata[field] = '';
        evaluator.evaluate_candidate(malformed, cases, probe());
    }, new RegExp('candidate metadata ' + field + ' must be a non-empty string'));
});
expectSchemaError('candidate analyze', function() {
    evaluator.evaluate_candidate({ metadata: candidate(false).metadata }, cases, probe());
}, /candidate analyze must be a function/);

expectSchemaError('corpus array', function() {
    evaluator.evaluate_candidate(candidate(false), null, probe());
}, /evaluation cases must be a non-empty array/);
expectSchemaError('non-empty corpus', function() {
    evaluator.evaluate_candidate(candidate(false), [], probe());
}, /evaluation cases must be a non-empty array/);
expectSchemaError('required denominator', function() {
    evaluator.evaluate_candidate(candidate(false), [
        { id: 'invalid-only', dialect: 'hive', expectation: 'invalid', source: "'", atomicLexemes: ["'"], tags: [] },
    ], probe());
}, /evaluation corpus must include a required case/);
expectSchemaError('invalid denominator', function() {
    evaluator.evaluate_candidate(candidate(false), [
        { id: 'required-only', dialect: 'hive', expectation: 'required', source: 'SELECT 1', atomicLexemes: ['SELECT'], tags: [] },
    ], probe());
}, /evaluation corpus must include an invalid case/);
expectSchemaError('atomic denominator', function() {
    evaluator.evaluate_candidate(candidate(false), cases.map(function(testCase) {
        return Object.assign({}, testCase, { atomicLexemes: [] });
    }), probe());
}, /evaluation corpus must include atomic lexeme evidence/);

[
    ['id', '', /case 0 id must be a non-empty string/],
    ['dialect', 'unknown', /case required dialect must be one of/],
    ['expectation', 'unknown', /case required expectation must be one of/],
    ['source', '', /case required source must be a non-empty string/],
    ['atomicLexemes', null, /case required atomicLexemes must be an array/],
    ['tags', null, /case required tags must be an array/],
].forEach(function(spec) {
    expectSchemaError('case field ' + spec[0], function() {
        var malformedCases = cases.map(function(testCase) { return Object.assign({}, testCase); });
        malformedCases[0][spec[0]] = spec[1];
        evaluator.evaluate_candidate(candidate(false), malformedCases, probe());
    }, spec[2]);
});
expectSchemaError('duplicate case id', function() {
    var malformedCases = cases.map(function(testCase) { return Object.assign({}, testCase); });
    malformedCases[1].id = malformedCases[0].id;
    evaluator.evaluate_candidate(candidate(false), malformedCases, probe());
}, /case ids must be unique/);
expectSchemaError('atomic lexeme value', function() {
    var malformedCases = cases.map(function(testCase) { return Object.assign({}, testCase); });
    malformedCases[1].atomicLexemes = ['missing'];
    evaluator.evaluate_candidate(candidate(false), malformedCases, probe());
}, /case atomic atomic lexeme must be a non-empty source substring/);
expectSchemaError('tag value', function() {
    var malformedCases = cases.map(function(testCase) { return Object.assign({}, testCase); });
    malformedCases[0].tags = [null];
    evaluator.evaluate_candidate(candidate(false), malformedCases, probe());
}, /case required tags must contain non-empty strings/);

expectSchemaError('probe object', function() {
    evaluator.evaluate_candidate(candidate(false), cases, null);
}, /probe must be an object/);
['bundleBytes', 'gzipBytes'].forEach(function(field) {
    expectSchemaError('missing probe ' + field, function() {
        var malformedProbe = probe();
        delete malformedProbe[field];
        evaluator.evaluate_candidate(candidate(false), cases, malformedProbe);
    }, new RegExp('probe ' + field + ' must be a positive integer'));
    expectSchemaError('negative probe ' + field, function() {
        evaluator.evaluate_candidate(candidate(false), cases, probe((function() {
            var value = {};
            value[field] = -1;
            return value;
        })()));
    }, new RegExp('probe ' + field + ' must be a positive integer'));
});
['coldStartMedianMs', 'parse100MedianMs', 'parse800MedianMs', 'parse1200MedianMs', 'scaleRatio'].forEach(function(field) {
    expectSchemaError('missing probe ' + field, function() {
        var malformedProbe = probe();
        delete malformedProbe[field];
        evaluator.evaluate_candidate(candidate(false), cases, malformedProbe);
    }, new RegExp('probe ' + field + ' must be a positive finite number'));
    expectSchemaError('negative probe ' + field, function() {
        evaluator.evaluate_candidate(candidate(false), cases, probe((function() {
            var value = {};
            value[field] = -1;
            return value;
        })()));
    }, new RegExp('probe ' + field + ' must be a positive finite number'));
    expectSchemaError('zero probe ' + field, function() {
        evaluator.evaluate_candidate(candidate(false), cases, probe((function() {
            var value = {};
            value[field] = 0;
            return value;
        })()));
    }, new RegExp('probe ' + field + ' must be a positive finite number'));
});
expectSchemaError('NaN probe measurement', function() {
    evaluator.evaluate_candidate(candidate(false), cases, probe({ coldStartMedianMs: NaN }));
}, /probe coldStartMedianMs must be a positive finite number/);
expectSchemaError('contradictory scale ratio', function() {
    evaluator.evaluate_candidate(candidate(false), cases, probe({
        parse100MedianMs: 5,
        parse800MedianMs: 65,
        scaleRatio: 1,
    }));
}, /probe scaleRatio must match parse100MedianMs and parse800MedianMs/);
expectSchemaError('probe maxRssKb', function() {
    evaluator.evaluate_candidate(candidate(false), cases, probe({ maxRssKb: -1 }));
}, /probe maxRssKb must be a positive integer/);
expectSchemaError('probe environment', function() {
    evaluator.evaluate_candidate(candidate(false), cases, probe({ environment: null }));
}, /probe environment must be an object/);
['node', 'platform', 'arch', 'cpu'].forEach(function(field) {
    expectSchemaError('probe environment ' + field, function() {
        var malformedEnvironment = Object.assign({}, probe().environment);
        malformedEnvironment[field] = '';
        evaluator.evaluate_candidate(candidate(false), cases, probe({ environment: malformedEnvironment }));
    }, new RegExp('probe environment ' + field + ' must be a non-empty string'));
});
expectSchemaError('probe directLoad', function() {
    evaluator.evaluate_candidate(candidate(false), cases, probe({ directLoad: null }));
}, /probe directLoad must be an object/);
expectSchemaError('probe directLoad success', function() {
    evaluator.evaluate_candidate(candidate(false), cases, probe({ directLoad: { success: 'no', errorCode: null } }));
}, /probe directLoad success must be a boolean/);
expectSchemaError('probe directLoad failure code', function() {
    evaluator.evaluate_candidate(candidate(false), cases, probe({ directLoad: { success: false, errorCode: null } }));
}, /failed direct load must include a stable error code/);
expectSchemaError('probe directLoad success contradiction', function() {
    evaluator.evaluate_candidate(candidate(false), cases, probe({
        directLoad: { success: true, errorCode: 'ERR_CONTRADICTORY' },
    }));
}, /successful direct load must not include an error code/);
expectSchemaError('probe package list', function() {
    evaluator.evaluate_candidate(candidate(false), cases, probe({ bundledPackages: [] }));
}, /probe bundledPackages must be a non-empty array/);
expectSchemaError('probe malformed package', function() {
    evaluator.evaluate_candidate(candidate(false), cases, probe({ bundledPackages: [null] }));
}, /probe bundled package 0 must be an object/);
['name', 'version', 'license'].forEach(function(field) {
    expectSchemaError('probe package ' + field, function() {
        var malformedPackage = { name: 'fake', version: '1.0.0', license: 'MIT' };
        malformedPackage[field] = '';
        evaluator.evaluate_candidate(candidate(false), cases, probe({ bundledPackages: [malformedPackage] }));
    }, new RegExp('probe bundled package 0 ' + field + ' must be a non-empty string'));
});
assert.deepStrictEqual(schemaFailures, [], 'evaluation schema must abort before classification');

var resultContractFailures = [];
function checkResultContract(label, action) {
    try {
        action();
    } catch (error) {
        resultContractFailures.push(label + ': ' + (error && error.message ? error.message : String(error)));
    }
}

checkResultContract('malformed errors are contained without rejection evidence', function() {
    var malformedErrors = candidate(false);
    var validAnalyze = malformedErrors.analyze;
    malformedErrors.analyze = function(testCase) {
        var result = validAnalyze(testCase);
        if (testCase.expectation == 'invalid') {
            result.errors = 'rejected';
        }
        return result;
    };
    var result = evaluator.evaluate_candidate(malformedErrors, cases, probe());
    var invalidOutcome = result.outcomes.filter(function(item) { return item.expectation == 'invalid'; })[0];
    assert.strictEqual(invalidOutcome.accepted, false);
    assert.strictEqual(invalidOutcome.rejectionEvidence, false);
    assert.ok(/malformed result/.test(invalidOutcome.errors[0]));
    assert.strictEqual(result.summary.invalidRejectRate, 0);
    assert.strictEqual(result.decision.role, 'rejected');
});

checkResultContract('accepted result with errors is contradictory', function() {
    var contradictory = candidate(false);
    var validAnalyze = contradictory.analyze;
    contradictory.analyze = function(testCase) {
        var result = validAnalyze(testCase);
        if (testCase.id == 'required') {
            result.errors = ['contradictory error'];
        }
        return result;
    };
    var result = evaluator.evaluate_candidate(contradictory, cases, probe());
    var requiredOutcome = result.outcomes.filter(function(item) { return item.id == 'required'; })[0];
    assert.strictEqual(requiredOutcome.accepted, false);
    assert.strictEqual(requiredOutcome.rejectionEvidence, false);
    assert.ok(/malformed result/.test(requiredOutcome.errors[0]));
    assert.strictEqual(result.summary.requiredParseRate, 0.5);
    assert.strictEqual(result.decision.role, 'rejected');
});

checkResultContract('silent invalid rejection is not evidence', function() {
    var silentInvalid = candidate(false);
    var validAnalyze = silentInvalid.analyze;
    silentInvalid.analyze = function(testCase) {
        var result = validAnalyze(testCase);
        if (testCase.expectation == 'invalid') {
            result.errors = [];
        }
        return result;
    };
    var result = evaluator.evaluate_candidate(silentInvalid, cases, probe());
    var invalidOutcome = result.outcomes.filter(function(item) { return item.expectation == 'invalid'; })[0];
    assert.strictEqual(invalidOutcome.accepted, false);
    assert.strictEqual(invalidOutcome.rejectionEvidence, false);
    assert.deepStrictEqual(invalidOutcome.errors, []);
    assert.strictEqual(result.summary.invalidRejectRate, 0);
    assert.strictEqual(result.decision.role, 'rejected');
});

checkResultContract('thrown invalid analysis is contained without rejection evidence', function() {
    var throwingInvalid = candidate(false);
    var validAnalyze = throwingInvalid.analyze;
    throwingInvalid.analyze = function(testCase) {
        if (testCase.expectation == 'invalid') {
            throw new Error('candidate crashed on user SQL');
        }
        return validAnalyze(testCase);
    };
    var result;
    assert.doesNotThrow(function() {
        result = evaluator.evaluate_candidate(throwingInvalid, cases, probe());
    });
    var invalidOutcome = result.outcomes.filter(function(item) { return item.expectation == 'invalid'; })[0];
    assert.strictEqual(invalidOutcome.accepted, false);
    assert.strictEqual(invalidOutcome.rejectionEvidence, false);
    assert.ok(/candidate analyze threw/.test(invalidOutcome.errors[0]));
    assert.strictEqual(result.summary.invalidRejectRate, 0);
    assert.strictEqual(result.decision.role, 'rejected');
});

checkResultContract('malformed leaf result is explicit and contained', function() {
    var malformedLeaves = candidate(false);
    var validAnalyze = malformedLeaves.analyze;
    malformedLeaves.analyze = function(testCase) {
        var result = validAnalyze(testCase);
        if (testCase.id == 'required') {
            result.leaves = [null];
        }
        return result;
    };
    var result;
    assert.doesNotThrow(function() {
        result = evaluator.evaluate_candidate(malformedLeaves, cases, probe());
    });
    var requiredOutcome = result.outcomes.filter(function(item) { return item.id == 'required'; })[0];
    assert.strictEqual(requiredOutcome.accepted, false);
    assert.strictEqual(requiredOutcome.rejectionEvidence, false);
    assert.ok(/malformed result/.test(requiredOutcome.errors[0]));
    assert.strictEqual(result.decision.role, 'rejected');
});

checkResultContract('throwing result field is contained', function() {
    var throwingResultField = candidate(false);
    var validAnalyze = throwingResultField.analyze;
    throwingResultField.analyze = function(testCase) {
        if (testCase.id != 'required') {
            return validAnalyze(testCase);
        }
        var result = validAnalyze(testCase);
        Object.defineProperty(result, 'errors', {
            get: function() {
                throw new Error('candidate result getter crashed');
            },
        });
        return result;
    };
    var result;
    assert.doesNotThrow(function() {
        result = evaluator.evaluate_candidate(throwingResultField, cases, probe());
    });
    var requiredOutcome = result.outcomes.filter(function(item) { return item.id == 'required'; })[0];
    assert.strictEqual(requiredOutcome.accepted, false);
    assert.strictEqual(requiredOutcome.rejectionEvidence, false);
    assert.ok(/candidate result inspection threw/.test(requiredOutcome.errors[0]));
    assert.strictEqual(result.decision.role, 'rejected');
});

assert.deepStrictEqual(resultContractFailures, [], 'candidate result failures must be contained and fail closed');

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
assert.throws(function() {
    evaluator.assert_leaf_partition('abc', [
        { raw: 'abd', span: { start: 0, end: 3 } },
    ]);
}, /rebuild source/);
assert.throws(function() {
    evaluator.assert_leaf_partition('abc', [
        { raw: 'ab', span: { start: 0, end: 2 } },
    ]);
}, /cover source/);
console.log('v2 parser evaluation harness tests passed');
