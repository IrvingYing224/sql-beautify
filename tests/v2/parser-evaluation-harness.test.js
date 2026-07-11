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
                status: accepted ? 'accepted' : 'syntax-rejected',
                accepted: accepted,
                errors: accepted ? [] : ['rejected'],
                analysisFailure: null,
                leaves: [{
                    kind: 'token',
                    origin: 'candidate',
                    raw: testCase.source,
                    span: { start: 0, end: testCase.source.length },
                }],
                nativePartition: {
                    valid: true,
                    invalidTokenCount: 0,
                    overlapTokenCount: 0,
                    nonTriviaGapCount: 0,
                },
                nodeCount: accepted ? 1 : 0,
                nodeSpansValid: accepted,
            };
        },
    };
}

function probe(overrides) {
    return Object.assign({
        bundleEntry: 'esm-named-hive',
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
assert.strictEqual(runtime.decision.tokenOwnershipPass, true);
var oracle = evaluator.evaluate_candidate(candidate(false), cases, probe({
    bundleBytes: evaluator.GATES.maxBundleBytes + 1,
}));
assert.strictEqual(oracle.decision.role, 'development-oracle');
var rejected = evaluator.evaluate_candidate(candidate(true), cases, probe());
assert.strictEqual(rejected.decision.role, 'rejected');
assert.strictEqual(rejected.decision.grammarPass, false);
assert.strictEqual(rejected.decision.tokenOwnershipPass, true);
assert.strictEqual(rejected.decision.canOwnLeafStream, true);

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
expectSchemaError('dense corpus', function() {
    var sparseCases = cases.slice();
    delete sparseCases[0];
    evaluator.evaluate_candidate(candidate(false), sparseCases, probe());
}, /evaluation cases must be a dense array/);
expectSchemaError('required denominator', function() {
    evaluator.evaluate_candidate(candidate(false), cases.filter(function(item) {
        return item.expectation != 'required';
    }), probe());
}, /evaluation corpus must include a required case/);
expectSchemaError('invalid denominator', function() {
    evaluator.evaluate_candidate(candidate(false), cases.filter(function(item) {
        return item.expectation != 'invalid';
    }), probe());
}, /evaluation corpus must include an invalid case/);
expectSchemaError('atomic denominator', function() {
    var noAtomic = cases.map(function(item) {
        return Object.assign({}, item, { atomicLexemes: [] });
    });
    evaluator.evaluate_candidate(candidate(false), noAtomic, probe());
}, /evaluation corpus must include atomic lexeme evidence/);
expectSchemaError('duplicate case id', function() {
    var duplicate = cases.slice();
    duplicate[1] = Object.assign({}, cases[0], { id: cases[0].id });
    evaluator.evaluate_candidate(candidate(false), duplicate, probe());
}, /case ids must be unique/);
expectSchemaError('case dialect', function() {
    var badDialect = cases.slice();
    badDialect[0] = Object.assign({}, cases[0], { dialect: 'oracle' });
    evaluator.evaluate_candidate(candidate(false), badDialect, probe());
}, /dialect must be one of/);
expectSchemaError('case expectation', function() {
    var badExpectation = cases.slice();
    badExpectation[0] = Object.assign({}, cases[0], { expectation: 'optional' });
    evaluator.evaluate_candidate(candidate(false), badExpectation, probe());
}, /expectation must be one of/);
expectSchemaError('case source', function() {
    var badSource = cases.slice();
    badSource[0] = Object.assign({}, cases[0], { source: '   ' });
    evaluator.evaluate_candidate(candidate(false), badSource, probe());
}, /source must be a non-empty string/);
expectSchemaError('case atomicLexemes dense', function() {
    var badAtomic = cases.slice();
    var sparseAtomic = ['SELECT'];
    delete sparseAtomic[0];
    badAtomic[0] = Object.assign({}, cases[0], { atomicLexemes: sparseAtomic });
    evaluator.evaluate_candidate(candidate(false), badAtomic, probe());
}, /atomicLexemes must be a dense array/);
expectSchemaError('case tags dense', function() {
    var badTags = cases.slice();
    var sparseTags = ['hive'];
    delete sparseTags[0];
    badTags[0] = Object.assign({}, cases[0], { tags: sparseTags });
    evaluator.evaluate_candidate(candidate(false), badTags, probe());
}, /tags must be a dense array/);
expectSchemaError('probe object', function() {
    evaluator.evaluate_candidate(candidate(false), cases, null);
}, /probe must be an object/);
expectSchemaError('probe bundleEntry', function() {
    evaluator.evaluate_candidate(candidate(false), cases, probe({ bundleEntry: 'wrong' }));
}, /probe bundleEntry must identify the ESM named Hive entry/);
expectSchemaError('probe scaleRatio', function() {
    evaluator.evaluate_candidate(candidate(false), cases, probe({ scaleRatio: 1 }));
}, /probe scaleRatio must match/);
expectSchemaError('probe bundledPackages dense', function() {
    var sparsePackages = [{ name: 'fake', version: '1.0.0', license: 'MIT' }];
    delete sparsePackages[0];
    evaluator.evaluate_candidate(candidate(false), cases, probe({ bundledPackages: sparsePackages }));
}, /probe bundledPackages must be a dense array/);
assert.deepStrictEqual(schemaFailures, [], 'schema validation failures');

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
    assert.ok(/malformed result/.test(invalidOutcome.analysisFailure.message));
    assert.strictEqual(result.summary.invalidRejectRate, 0);
    assert.strictEqual(result.decision.role, 'rejected');
});

checkResultContract('sparse errors are contained without rejection evidence', function() {
    var sparseErrors = candidate(false);
    var validAnalyze = sparseErrors.analyze;
    sparseErrors.analyze = function(testCase) {
        var result = validAnalyze(testCase);
        if (testCase.expectation == 'invalid') {
            result.errors = new Array(1);
        }
        return result;
    };
    var result;
    assert.doesNotThrow(function() {
        result = evaluator.evaluate_candidate(sparseErrors, cases, probe());
    });
    var invalidOutcome = result.outcomes.filter(function(item) { return item.expectation == 'invalid'; })[0];
    assert.strictEqual(invalidOutcome.accepted, false);
    assert.strictEqual(invalidOutcome.rejectionEvidence, false);
    assert.ok(/malformed result/.test(invalidOutcome.analysisFailure.message));
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
    assert.ok(/malformed result/.test(requiredOutcome.analysisFailure.message));
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
    assert.ok(/candidate analyze threw/.test(invalidOutcome.analysisFailure.message));
    assert.strictEqual(result.summary.invalidRejectRate, 0);
    assert.strictEqual(result.decision.role, 'rejected');
});

checkResultContract('analysis failure status is not syntax rejection evidence', function() {
    var failedAnalysis = candidate(false);
    var validAnalyze = failedAnalysis.analyze;
    failedAnalysis.analyze = function(testCase) {
        var result = validAnalyze(testCase);
        if (testCase.expectation == 'invalid') {
            result.status = 'analysis-failed';
            result.errors = [];
            result.analysisFailure = {
                stage: 'validate',
                message: 'TypeError: parser crashed',
            };
        }
        return result;
    };
    var result = evaluator.evaluate_candidate(failedAnalysis, cases, probe());
    var invalidOutcome = result.outcomes.filter(function(item) { return item.expectation == 'invalid'; })[0];
    assert.strictEqual(invalidOutcome.status, 'analysis-failed');
    assert.deepStrictEqual(invalidOutcome.errors, []);
    assert.deepStrictEqual(invalidOutcome.analysisFailure, {
        stage: 'validate',
        message: 'TypeError: parser crashed',
    });
    assert.strictEqual(invalidOutcome.rejectionEvidence, false);
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
    assert.ok(/malformed result/.test(requiredOutcome.analysisFailure.message));
    assert.strictEqual(result.decision.role, 'rejected');
});

checkResultContract('sparse leaves are explicit and contained', function() {
    var sparseLeaves = candidate(false);
    var validAnalyze = sparseLeaves.analyze;
    sparseLeaves.analyze = function(testCase) {
        var result = validAnalyze(testCase);
        if (testCase.expectation == 'invalid') {
            result.leaves = new Array(1);
        }
        return result;
    };
    var result;
    assert.doesNotThrow(function() {
        result = evaluator.evaluate_candidate(sparseLeaves, cases, probe());
    });
    var invalidOutcome = result.outcomes.filter(function(item) { return item.expectation == 'invalid'; })[0];
    assert.strictEqual(invalidOutcome.accepted, false);
    assert.strictEqual(invalidOutcome.rejectionEvidence, false);
    assert.ok(/malformed result/.test(invalidOutcome.analysisFailure.message));
    assert.strictEqual(result.summary.invalidRejectRate, 0);
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
    assert.ok(/candidate result inspection threw/.test(requiredOutcome.analysisFailure.message));
    assert.strictEqual(result.decision.role, 'rejected');
});

checkResultContract('leaf raw is copied once into a stable snapshot', function() {
    var delayedRaw = candidate(false);
    var validAnalyze = delayedRaw.analyze;
    var rawReads = 0;
    delayedRaw.analyze = function(testCase) {
        var result = validAnalyze(testCase);
        if (testCase.id == 'required') {
            Object.defineProperty(result.leaves[0], 'raw', {
                get: function() {
                    rawReads++;
                    if (rawReads > 1) {
                        throw new Error('delayed raw getter crashed');
                    }
                    return testCase.source;
                },
            });
        }
        return result;
    };
    var result;
    assert.doesNotThrow(function() {
        result = evaluator.evaluate_candidate(delayedRaw, cases, probe());
    });
    var requiredOutcome = result.outcomes.filter(function(item) { return item.id == 'required'; })[0];
    assert.strictEqual(rawReads, 1);
    assert.strictEqual(requiredOutcome.status, 'accepted');
    assert.strictEqual(requiredOutcome.roundTrip, true);
    assert.strictEqual(requiredOutcome.atomicPassed, 0);
    assert.strictEqual(requiredOutcome.rejectionEvidence, false);
});

function assertArrayMutationFailsClosed(label, mutate) {
    checkResultContract(label, function() {
        var mutating = candidate(false);
        var validAnalyze = mutating.analyze;
        mutating.analyze = function(testCase) {
            var result = validAnalyze(testCase);
            if (testCase.id == 'required') {
                mutate(result, testCase);
            }
            return result;
        };
        var result;
        assert.doesNotThrow(function() {
            result = evaluator.evaluate_candidate(mutating, cases, probe());
        }, label + ' must not throw from evaluate_candidate');
        var requiredOutcome = result.outcomes.filter(function(item) { return item.id == 'required'; })[0];
        var atomicOutcome = result.outcomes.filter(function(item) { return item.id == 'atomic'; })[0];
        var invalidOutcome = result.outcomes.filter(function(item) { return item.id == 'invalid'; })[0];
        assert.strictEqual(requiredOutcome.status, 'analysis-failed', label);
        assert.strictEqual(requiredOutcome.accepted, false, label);
        assert.strictEqual(requiredOutcome.rejectionEvidence, false, label);
        assert.strictEqual(requiredOutcome.analysisFailure.stage, 'normalize', label);
        assert.ok(/malformed result|inspection threw/.test(requiredOutcome.analysisFailure.message), label);
        assert.strictEqual(atomicOutcome.status, 'accepted', label + ' other cases continue');
        assert.strictEqual(invalidOutcome.rejectionEvidence, true, label + ' other cases continue');
        assert.strictEqual(result.summary.requiredParseRate, 0.5, label);
        assert.strictEqual(result.decision.role, 'rejected', label);
    });
}

assertArrayMutationFailsClosed('leaf array push during raw getter fails closed', function(result, testCase) {
    var leaves = result.leaves;
    Object.defineProperty(leaves[0], 'raw', {
        get: function() {
            leaves.push(null);
            return testCase.source;
        },
    });
});

assertArrayMutationFailsClosed('leaf array pop during raw getter fails closed', function(result, testCase) {
    var leaves = result.leaves;
    Object.defineProperty(leaves[0], 'raw', {
        get: function() {
            leaves.pop();
            return testCase.source;
        },
    });
});

assertArrayMutationFailsClosed('leaf array replace during raw getter fails closed', function(result, testCase) {
    var leaves = result.leaves;
    Object.defineProperty(leaves[0], 'raw', {
        get: function() {
            leaves[0] = {
                kind: 'token',
                origin: 'candidate',
                raw: testCase.source,
                span: { start: 0, end: testCase.source.length },
            };
            return testCase.source;
        },
    });
});

assertArrayMutationFailsClosed('leaf array delete/sparse during raw getter fails closed', function(result, testCase) {
    var leaves = result.leaves;
    Object.defineProperty(leaves[0], 'raw', {
        get: function() {
            delete leaves[0];
            return testCase.source;
        },
    });
});

assertArrayMutationFailsClosed('error array mutation during error getter fails closed', function(result) {
    result.status = 'syntax-rejected';
    result.accepted = false;
    result.errors = ['syntax diagnostic'];
    result.nodeCount = 0;
    result.nodeSpansValid = false;
    var errors = result.errors;
    Object.defineProperty(errors, 0, {
        configurable: true,
        enumerable: true,
        get: function() {
            errors.push('extra diagnostic');
            return 'syntax diagnostic';
        },
    });
});

assertArrayMutationFailsClosed('throwing leaf proxy fails only its case closed', function(result) {
    result.leaves[0] = new Proxy(result.leaves[0], {
        get: function(target, property) {
            if (property == 'raw') {
                throw new Error('leaf proxy crashed');
            }
            return target[property];
        },
    });
});

checkResultContract('stable delayed leaf getter without array mutation remains accepted', function() {
    var stableGetter = candidate(false);
    var validAnalyze = stableGetter.analyze;
    var rawReads = 0;
    stableGetter.analyze = function(testCase) {
        var result = validAnalyze(testCase);
        if (testCase.id == 'required') {
            Object.defineProperty(result.leaves[0], 'raw', {
                get: function() {
                    rawReads++;
                    return testCase.source;
                },
            });
        }
        return result;
    };
    var result;
    assert.doesNotThrow(function() {
        result = evaluator.evaluate_candidate(stableGetter, cases, probe());
    });
    var requiredOutcome = result.outcomes.filter(function(item) { return item.id == 'required'; })[0];
    assert.strictEqual(rawReads, 1);
    assert.strictEqual(requiredOutcome.status, 'accepted');
    assert.strictEqual(requiredOutcome.accepted, true);
    assert.strictEqual(requiredOutcome.roundTrip, true);
    assert.strictEqual(requiredOutcome.rejectionEvidence, false);
    assert.strictEqual(result.decision.role, 'runtime-grammar-backend');
});

// Forward-index replacement: index-0 accessor rewrites not-yet-read index-1.
// Failure must come from the evidence-array contract, not from span/source mismatch.
checkResultContract('forward-index leaf replacement fails closed', function() {
    var mutating = candidate(false);
    var validAnalyze = mutating.analyze;
    mutating.analyze = function(testCase) {
        var result = validAnalyze(testCase);
        if (testCase.id == 'required') {
            var firstLeaf = {
                kind: 'token',
                origin: 'candidate',
                raw: 'SELECT',
                span: { start: 0, end: 6 },
            };
            var secondLeaf = {
                kind: 'token',
                origin: 'candidate',
                raw: ' 1',
                span: { start: 6, end: 8 },
            };
            var leaves = [];
            leaves.length = 2;
            leaves[1] = null;
            var firstRead = true;
            Object.defineProperty(leaves, 0, {
                configurable: true,
                enumerable: true,
                get: function() {
                    if (firstRead) {
                        firstRead = false;
                        leaves[1] = secondLeaf;
                    }
                    return firstLeaf;
                },
            });
            result.leaves = leaves;
        }
        return result;
    };
    var result;
    assert.doesNotThrow(function() {
        result = evaluator.evaluate_candidate(mutating, cases, probe());
    });
    var requiredOutcome = result.outcomes.filter(function(item) { return item.id == 'required'; })[0];
    var atomicOutcome = result.outcomes.filter(function(item) { return item.id == 'atomic'; })[0];
    var invalidOutcome = result.outcomes.filter(function(item) { return item.id == 'invalid'; })[0];
    assert.strictEqual(requiredOutcome.status, 'analysis-failed');
    assert.strictEqual(requiredOutcome.accepted, false);
    assert.strictEqual(requiredOutcome.rejectionEvidence, false);
    assert.strictEqual(requiredOutcome.roundTrip, false);
    assert.strictEqual(requiredOutcome.analysisFailure.stage, 'normalize');
    assert.ok(/malformed result|inspection threw/.test(requiredOutcome.analysisFailure.message));
    assert.strictEqual(atomicOutcome.status, 'accepted');
    assert.strictEqual(invalidOutcome.rejectionEvidence, true);
    assert.strictEqual(result.summary.requiredParseRate, 0.5);
    assert.strictEqual(result.decision.role, 'rejected');
});

checkResultContract('forward-index error replacement fails closed without rejection evidence', function() {
    var mutating = candidate(false);
    var validAnalyze = mutating.analyze;
    mutating.analyze = function(testCase) {
        var result = validAnalyze(testCase);
        if (testCase.expectation == 'invalid') {
            result.status = 'syntax-rejected';
            result.accepted = false;
            result.nodeCount = 0;
            result.nodeSpansValid = false;
            var errors = [];
            errors.length = 2;
            errors[1] = null;
            var firstRead = true;
            Object.defineProperty(errors, 0, {
                configurable: true,
                enumerable: true,
                get: function() {
                    if (firstRead) {
                        firstRead = false;
                        errors[1] = 'second diagnostic';
                    }
                    return 'syntax diagnostic';
                },
            });
            result.errors = errors;
        }
        return result;
    };
    var result;
    assert.doesNotThrow(function() {
        result = evaluator.evaluate_candidate(mutating, cases, probe());
    });
    var invalidOutcome = result.outcomes.filter(function(item) { return item.expectation == 'invalid'; })[0];
    assert.strictEqual(invalidOutcome.status, 'analysis-failed');
    assert.strictEqual(invalidOutcome.accepted, false);
    assert.strictEqual(invalidOutcome.rejectionEvidence, false);
    assert.strictEqual(invalidOutcome.analysisFailure.stage, 'normalize');
    assert.ok(/malformed result|inspection threw/.test(invalidOutcome.analysisFailure.message));
    assert.strictEqual(result.summary.invalidRejectRate, 0);
    assert.strictEqual(result.decision.role, 'rejected');
});

function assertEvidenceArrayProxyFailsClosed(label, mutate) {
    checkResultContract(label, function() {
        var mutating = candidate(false);
        var validAnalyze = mutating.analyze;
        mutating.analyze = function(testCase) {
            var result = validAnalyze(testCase);
            if (testCase.id == 'required') {
                mutate(result, testCase);
            }
            return result;
        };
        var result;
        assert.doesNotThrow(function() {
            result = evaluator.evaluate_candidate(mutating, cases, probe());
        }, label + ' must not throw from evaluate_candidate');
        var requiredOutcome = result.outcomes.filter(function(item) { return item.id == 'required'; })[0];
        var atomicOutcome = result.outcomes.filter(function(item) { return item.id == 'atomic'; })[0];
        var invalidOutcome = result.outcomes.filter(function(item) { return item.id == 'invalid'; })[0];
        assert.strictEqual(requiredOutcome.status, 'analysis-failed', label);
        assert.strictEqual(requiredOutcome.accepted, false, label);
        assert.strictEqual(requiredOutcome.rejectionEvidence, false, label);
        assert.strictEqual(requiredOutcome.analysisFailure.stage, 'normalize', label);
        assert.ok(/malformed result|inspection threw/.test(requiredOutcome.analysisFailure.message), label);
        assert.strictEqual(atomicOutcome.status, 'accepted', label + ' other cases continue');
        assert.strictEqual(invalidOutcome.rejectionEvidence, true, label + ' other cases continue');
        assert.strictEqual(result.summary.requiredParseRate, 0.5, label);
        assert.strictEqual(result.decision.role, 'rejected', label);
    });
}

assertEvidenceArrayProxyFailsClosed('transparent leaves Array Proxy fails closed', function(result) {
    result.leaves = new Proxy(result.leaves, {});
});

assertEvidenceArrayProxyFailsClosed('revoked leaves Array Proxy fails closed', function(result) {
    var revocable = Proxy.revocable(result.leaves, {});
    revocable.revoke();
    result.leaves = revocable.proxy;
});

assertEvidenceArrayProxyFailsClosed('transparent errors Array Proxy fails closed', function(result) {
    result.status = 'syntax-rejected';
    result.accepted = false;
    result.errors = new Proxy(['syntax diagnostic'], {});
    result.nodeCount = 0;
    result.nodeSpansValid = false;
});

assertEvidenceArrayProxyFailsClosed('revoked errors Array Proxy fails closed', function(result) {
    result.status = 'syntax-rejected';
    result.accepted = false;
    var revocable = Proxy.revocable(['syntax diagnostic'], {});
    revocable.revoke();
    result.errors = revocable.proxy;
    result.nodeCount = 0;
    result.nodeSpansValid = false;
});

checkResultContract('synthetic leaves cannot satisfy native atomic or ownership evidence', function() {
    var syntheticAtomic = candidate(false);
    var validAnalyze = syntheticAtomic.analyze;
    syntheticAtomic.analyze = function(testCase) {
        var result = validAnalyze(testCase);
        if (testCase.id == 'atomic') {
            result.leaves[0].origin = 'synthetic';
            result.leaves[0].kind = 'gap';
            result.nativePartition.nonTriviaGapCount = 1;
        }
        return result;
    };
    var result = evaluator.evaluate_candidate(syntheticAtomic, cases, probe());
    var atomicOutcome = result.outcomes.filter(function(item) { return item.id == 'atomic'; })[0];
    assert.strictEqual(atomicOutcome.roundTrip, true);
    assert.strictEqual(atomicOutcome.atomicPassed, 0);
    assert.strictEqual(atomicOutcome.nativeCoverageComplete, false);
    assert.strictEqual(result.summary.nativeAtomicLexemeRate, 0);
    assert.strictEqual(result.summary.nativeTokenCoverageRate, 2 / 3);
    assert.strictEqual(result.decision.tokenOwnershipPass, false);
    assert.strictEqual(result.decision.canOwnLeafStream, false);
});

checkResultContract('candidate gap evidence cannot contradict a zero-gap leaf snapshot', function() {
    var contradictoryGapCount = candidate(false);
    var validAnalyze = contradictoryGapCount.analyze;
    contradictoryGapCount.analyze = function(testCase) {
        var result = validAnalyze(testCase);
        if (testCase.expectation == 'invalid') {
            result.nativePartition.nonTriviaGapCount = 1;
        }
        return result;
    };
    var result = evaluator.evaluate_candidate(contradictoryGapCount, cases, probe());
    var invalidOutcome = result.outcomes.filter(function(item) {
        return item.expectation == 'invalid';
    })[0];
    assert.strictEqual(invalidOutcome.status, 'analysis-failed');
    assert.strictEqual(invalidOutcome.accepted, false);
    assert.strictEqual(invalidOutcome.analysisFailure.stage, 'normalize');
    assert.ok(/nonTriviaGapCount/.test(invalidOutcome.analysisFailure.message));
    assert.strictEqual(invalidOutcome.rejectionEvidence, false);
    assert.strictEqual(invalidOutcome.nativePartitionValid, false);
    assert.strictEqual(invalidOutcome.nativeCoverageComplete, false);
    assert.strictEqual(result.summary.invalidRejectRate, 0);
    assert.strictEqual(result.summary.nativeTokenPartitionRate, 2 / 3);
    assert.strictEqual(result.summary.nativeTokenCoverageRate, 2 / 3);
    assert.strictEqual(result.decision.tokenOwnershipPass, false);
    assert.strictEqual(result.decision.canOwnLeafStream, false);
});

checkResultContract('zero candidate gap evidence cannot contradict a synthetic non-trivia gap', function() {
    var contradictoryLeaves = candidate(false);
    var validAnalyze = contradictoryLeaves.analyze;
    contradictoryLeaves.analyze = function(testCase) {
        var result = validAnalyze(testCase);
        if (testCase.id == 'required') {
            result.leaves[0].origin = 'synthetic';
            result.leaves[0].kind = 'gap';
        }
        return result;
    };
    var result = evaluator.evaluate_candidate(contradictoryLeaves, cases, probe());
    var requiredOutcome = result.outcomes.filter(function(item) { return item.id == 'required'; })[0];
    assert.strictEqual(requiredOutcome.status, 'analysis-failed');
    assert.strictEqual(requiredOutcome.accepted, false);
    assert.strictEqual(requiredOutcome.analysisFailure.stage, 'normalize');
    assert.ok(/nonTriviaGapCount/.test(requiredOutcome.analysisFailure.message));
    assert.strictEqual(requiredOutcome.nativePartitionValid, false);
    assert.strictEqual(requiredOutcome.nativeCoverageComplete, false);
    assert.strictEqual(result.summary.requiredParseRate, 0.5);
    assert.strictEqual(result.summary.nativeTokenPartitionRate, 2 / 3);
    assert.strictEqual(result.summary.nativeTokenCoverageRate, 2 / 3);
    assert.strictEqual(result.decision.tokenOwnershipPass, false);
    assert.strictEqual(result.decision.canOwnLeafStream, false);
});

checkResultContract('matching candidate and derived gap evidence remains valid', function() {
    var matchingGapEvidence = candidate(false);
    var validAnalyze = matchingGapEvidence.analyze;
    matchingGapEvidence.analyze = function(testCase) {
        var result = validAnalyze(testCase);
        if (testCase.id == 'required') {
            result.leaves[0].origin = 'synthetic';
            result.leaves[0].kind = 'gap';
            result.nativePartition.nonTriviaGapCount = 1;
        }
        return result;
    };
    var matchingOne = evaluator.evaluate_candidate(matchingGapEvidence, cases, probe());
    var requiredOutcome = matchingOne.outcomes.filter(function(item) { return item.id == 'required'; })[0];
    assert.strictEqual(requiredOutcome.status, 'accepted');
    assert.strictEqual(requiredOutcome.analysisFailure, null);
    assert.strictEqual(requiredOutcome.roundTrip, true);
    assert.strictEqual(requiredOutcome.nonTriviaGapCount, 1);
    assert.strictEqual(requiredOutcome.nativePartitionValid, true);
    assert.strictEqual(requiredOutcome.nativeCoverageComplete, false);

    var matchingZero = evaluator.evaluate_candidate(candidate(false), cases, probe());
    assert.strictEqual(matchingZero.decision.tokenOwnershipPass, true);
    assert.strictEqual(matchingZero.decision.canOwnLeafStream, true);
});

checkResultContract('raw reconstruction with an incorrect span cannot own the leaf stream', function() {
    var incorrectSpan = candidate(false);
    var validAnalyze = incorrectSpan.analyze;
    incorrectSpan.analyze = function(testCase) {
        var result = validAnalyze(testCase);
        if (testCase.id == 'required') {
            result.leaves[0].span.end = testCase.source.length + 1;
        }
        return result;
    };
    var result = evaluator.evaluate_candidate(incorrectSpan, cases, probe());
    var requiredOutcome = result.outcomes.filter(function(item) { return item.id == 'required'; })[0];
    assert.strictEqual(requiredOutcome.roundTrip, false);
    assert.strictEqual(requiredOutcome.nativePartitionValid, true);
    assert.strictEqual(requiredOutcome.nativeCoverageComplete, true);
    assert.strictEqual(result.summary.sourceRoundTripRate, 2 / 3);
    assert.strictEqual(result.summary.nativeTokenPartitionRate, 1);
    assert.strictEqual(result.summary.nativeTokenCoverageRate, 1);
    assert.strictEqual(result.summary.nativeAtomicLexemeRate, 1);
    assert.strictEqual(result.decision.grammarPass, false);
    assert.strictEqual(result.decision.tokenOwnershipPass, false);
    assert.strictEqual(result.decision.canOwnLeafStream, false);
});

['gap', 'overlap'].forEach(function(partitionFailure) {
    checkResultContract(partitionFailure + ' in candidate spans cannot own the leaf stream', function() {
        var invalidSpanPartition = candidate(false);
        var validAnalyze = invalidSpanPartition.analyze;
        invalidSpanPartition.analyze = function(testCase) {
            var result = validAnalyze(testCase);
            if (testCase.id == 'required') {
                result.leaves = [
                    {
                        kind: 'token',
                        origin: 'candidate',
                        raw: 'SELECT',
                        span: { start: 0, end: 6 },
                    },
                    {
                        kind: 'token',
                        origin: 'candidate',
                        raw: ' 1',
                        span: partitionFailure == 'gap'
                            ? { start: 7, end: 9 }
                            : { start: 5, end: 7 },
                    },
                ];
            }
            return result;
        };
        var result = evaluator.evaluate_candidate(invalidSpanPartition, cases, probe());
        var requiredOutcome = result.outcomes.filter(function(item) { return item.id == 'required'; })[0];
        assert.strictEqual(requiredOutcome.roundTrip, false);
        assert.strictEqual(requiredOutcome.nativePartitionValid, true);
        assert.strictEqual(requiredOutcome.nativeCoverageComplete, true);
        assert.strictEqual(result.summary.sourceRoundTripRate, 2 / 3);
        assert.strictEqual(result.summary.nativeTokenPartitionRate, 1);
        assert.strictEqual(result.summary.nativeTokenCoverageRate, 1);
        assert.strictEqual(result.summary.nativeAtomicLexemeRate, 1);
        assert.strictEqual(result.decision.tokenOwnershipPass, false);
        assert.strictEqual(result.decision.canOwnLeafStream, false);
    });
});

checkResultContract('complete source reconstruction and native evidence permit leaf ownership', function() {
    var result = evaluator.evaluate_candidate(candidate(false), cases, probe());
    assert.strictEqual(result.summary.sourceRoundTripRate, 1);
    assert.strictEqual(result.summary.nativeTokenPartitionRate, 1);
    assert.strictEqual(result.summary.nativeTokenCoverageRate, 1);
    assert.strictEqual(result.summary.nativeAtomicLexemeRate, 1);
    assert.strictEqual(result.decision.tokenOwnershipPass, true);
    assert.strictEqual(result.decision.canOwnLeafStream, true);
});

checkResultContract('invalid and overlapping native token evidence fails ownership', function() {
    ['invalidTokenCount', 'overlapTokenCount'].forEach(function(field) {
        var malformedNativePartition = candidate(false);
        var validAnalyze = malformedNativePartition.analyze;
        malformedNativePartition.analyze = function(testCase) {
            var result = validAnalyze(testCase);
            if (testCase.id == 'atomic') {
                result.nativePartition.valid = false;
                result.nativePartition[field] = 1;
            }
            return result;
        };
        var result = evaluator.evaluate_candidate(malformedNativePartition, cases, probe());
        assert.strictEqual(result.summary.nativeTokenPartitionRate, 2 / 3, field);
        assert.strictEqual(result.decision.tokenOwnershipPass, false, field);
        assert.strictEqual(result.decision.canOwnLeafStream, false, field);
    });
});

function shadowArrayMethods(array) {
    var methods = ['map', 'filter', 'some', 'every', 'forEach'];
    for (var index = 0; index < methods.length; index++) {
        Object.defineProperty(array, methods[index], {
            value: function() {
                throw new Error('evidence array method was invoked');
            },
        });
    }
    return array;
}

checkResultContract('shadowed evidence array methods are not invoked', function() {
    var shadowedCases = cases.map(function(testCase) {
        var clonedCase = Object.assign({}, testCase);
        clonedCase.atomicLexemes = shadowArrayMethods(testCase.atomicLexemes.slice());
        clonedCase.tags = shadowArrayMethods(testCase.tags.slice());
        return clonedCase;
    });
    shadowArrayMethods(shadowedCases);
    var shadowedProbe = probe({
        bundledPackages: shadowArrayMethods(probe().bundledPackages.slice()),
    });
    var shadowedCandidate = candidate(false);
    var validAnalyze = shadowedCandidate.analyze;
    shadowedCandidate.analyze = function(testCase) {
        var result = validAnalyze(testCase);
        result.errors = shadowArrayMethods(result.errors);
        result.leaves = shadowArrayMethods(result.leaves);
        return result;
    };
    var result;
    assert.doesNotThrow(function() {
        result = evaluator.evaluate_candidate(shadowedCandidate, shadowedCases, shadowedProbe);
    });
    assert.strictEqual(result.decision.role, 'runtime-grammar-backend');
    assert.strictEqual(result.decision.canOwnLeafStream, true);
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
