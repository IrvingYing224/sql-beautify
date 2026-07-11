var assert = require('assert');
var fs = require('fs');
var path = require('path');
var cases = require('../fixtures/v2-parser-evaluation-cases');
var evaluator = require('../../scripts/v2-parser-evaluation/evaluator');
var candidate = require('../../scripts/v2-parser-evaluation/candidates/dt-sql-parser');
var probeModule = require('../../scripts/v2-parser-evaluation/probe-dt-sql-parser');
var probeDtSqlParser = probeModule.probe_dt_sql_parser;

assert.strictEqual(candidate.metadata.name, 'dt-sql-parser');
assert.strictEqual(candidate.metadata.version, '4.5.0');
assert.ok(candidate.metadata.license.indexOf('MIT') >= 0);
var directLoad = probeModule.observe_direct_load();
assert.strictEqual(typeof directLoad.success, 'boolean', 'direct load success observation');
if (directLoad.success) {
    assert.strictEqual(directLoad.errorCode, null, 'successful direct load has no error code');
} else {
    assert.ok(/^[A-Z][A-Z0-9_]*$/.test(directLoad.errorCode), 'failed direct load stable error code');
}
cases.forEach(function(testCase) {
    var result = candidate.analyze(testCase);
    assert.ok(['accepted', 'syntax-rejected', 'analysis-failed'].indexOf(result.status) >= 0, testCase.id + ' status');
    assert.strictEqual(typeof result.accepted, 'boolean', testCase.id + ' accepted');
    assert.ok(Array.isArray(result.errors), testCase.id + ' errors');
    assert.ok(result.analysisFailure === null || typeof result.analysisFailure == 'object', testCase.id + ' analysisFailure');
    assert.ok(Array.isArray(result.leaves), testCase.id + ' leaves');
    result.leaves.forEach(function(leaf) {
        assert.ok(['candidate', 'synthetic'].indexOf(leaf.origin) >= 0, testCase.id + ' leaf origin');
    });
    assert.strictEqual(typeof result.nativePartition.valid, 'boolean', testCase.id + ' native partition');
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
    origin: 'candidate',
    raw: '-- keep ' + String.fromCodePoint(0x1f600),
    span: { start: 10, end: 20 },
}]);
evaluator.assert_leaf_partition(astralCommentSource, astralCommentResult.leaves);

var prefixedCase = cases.filter(function(testCase) {
    return testCase.id == 'postgres-prefixed-strings';
})[0];
var prefixedResult = candidate.analyze(prefixedCase);
var prefixedEvidence = Object.create(null);
prefixedResult.leaves.forEach(function(leaf) {
    if (prefixedCase.atomicLexemes.indexOf(leaf.raw) >= 0) {
        prefixedEvidence[leaf.raw] = leaf.origin;
    }
});
assert.strictEqual(prefixedEvidence["E'abc'"], 'candidate');
assert.strictEqual(prefixedEvidence["U&'d\\0061t'"], 'synthetic');
assert.strictEqual(prefixedEvidence['!~*'], 'synthetic');
assert.ok(prefixedResult.nativePartition.nonTriviaGapCount >= 2);

var cheapProbe = {
    bundleEntry: 'esm-named-hive',
    bundleBytes: 1,
    gzipBytes: 1,
    coldStartMedianMs: 1,
    parse100MedianMs: 1,
    parse800MedianMs: 8,
    parse1200MedianMs: 12,
    scaleRatio: 8,
    maxRssKb: 1,
    environment: { node: 'v1.0.0', platform: 'test', arch: 'test', cpu: 'test' },
    directLoad: { success: true, errorCode: null },
    bundledPackages: [{ name: 'dt-sql-parser', version: '4.5.0', license: 'MIT' }],
};
var corpusEvaluation = evaluator.evaluate_candidate(candidate, cases, cheapProbe);
var prefixedOutcome = corpusEvaluation.outcomes.filter(function(item) {
    return item.id == 'postgres-prefixed-strings';
})[0];
assert.strictEqual(prefixedOutcome.atomicPassed, 1);
assert.strictEqual(prefixedOutcome.atomicTotal, 3);
assert.strictEqual(corpusEvaluation.summary.nativeAtomicLexemeRate, 22 / 29);
assert.strictEqual(corpusEvaluation.decision.canOwnLeafStream, false);

function parserConstructors(parser) {
    function Parser() {
        return parser;
    }
    return { hive: Parser };
}

function analyzeWithParser(parser, source) {
    return candidate.create_analyzer(parserConstructors(parser))({
        id: 'injected-parser',
        dialect: 'hive',
        expectation: 'invalid',
        source: source || 'SELECT 1',
        atomicLexemes: [],
        tags: [],
    });
}

['validate', 'getAllTokens', 'parse'].forEach(function(stage) {
    var parser = {
        validate: function() { return []; },
        getAllTokens: function() { return [{ start: 0, stop: 7, channel: 0 }]; },
        parse: function() {
            return { ruleIndex: 0, start: { start: 0 }, stop: { stop: 7 } };
        },
    };
    parser[stage] = function() {
        throw new TypeError('parser crashed');
    };
    var constructors = parserConstructors(parser);
    var analyzer = candidate.create_analyzer(constructors);
    var failure = analyzer({
        id: 'injected-parser',
        dialect: 'hive',
        expectation: 'invalid',
        source: 'SELECT 1',
        atomicLexemes: [],
        tags: [],
    });
    assert.strictEqual(failure.status, 'analysis-failed', stage);
    assert.strictEqual(failure.accepted, false, stage);
    assert.deepStrictEqual(failure.errors, [], stage);
    assert.deepStrictEqual(failure.analysisFailure, {
        stage: stage == 'getAllTokens' ? 'tokenize' : stage,
        message: 'TypeError: parser crashed',
    }, stage);
    var exceptionEvaluation = evaluator.evaluate_candidate({
        metadata: candidate.metadata,
        analyze: analyzer,
    }, [
        {
            id: 'required-' + stage,
            dialect: 'hive',
            expectation: 'required',
            source: 'SELECT 1',
            atomicLexemes: ['SELECT'],
            tags: [],
        },
        {
            id: 'invalid-' + stage,
            dialect: 'hive',
            expectation: 'invalid',
            source: "'",
            atomicLexemes: [],
            tags: [],
        },
    ], cheapProbe);
    var invalidOutcome = exceptionEvaluation.outcomes.filter(function(item) {
        return item.expectation == 'invalid';
    })[0];
    assert.strictEqual(invalidOutcome.status, 'analysis-failed', stage);
    assert.strictEqual(invalidOutcome.rejectionEvidence, false, stage);
    assert.strictEqual(exceptionEvaluation.summary.invalidRejectRate, 0, stage);
    assert.strictEqual(exceptionEvaluation.decision.role, 'rejected', stage);
});

var mixedSyntaxAndTokenFailureAnalyzer = candidate.create_analyzer(parserConstructors({
    validate: function() { return [{ message: 'syntax diagnostic' }]; },
    getAllTokens: function() { throw new TypeError('token crash'); },
    parse: function() { throw new Error('parse must not run'); },
}));
var mixedSyntaxAndTokenFailure = mixedSyntaxAndTokenFailureAnalyzer({
    id: 'syntax-then-token-failure',
    dialect: 'hive',
    expectation: 'invalid',
    source: "'",
    atomicLexemes: [],
    tags: [],
});
assert.strictEqual(mixedSyntaxAndTokenFailure.status, 'analysis-failed');
assert.deepStrictEqual(mixedSyntaxAndTokenFailure.errors, []);
assert.deepStrictEqual(mixedSyntaxAndTokenFailure.analysisFailure, {
    stage: 'tokenize',
    message: 'TypeError: token crash',
});
var mixedFailureEvaluation = evaluator.evaluate_candidate({
    metadata: candidate.metadata,
    analyze: mixedSyntaxAndTokenFailureAnalyzer,
}, [
    {
        id: 'required-mixed-failure',
        dialect: 'hive',
        expectation: 'required',
        source: 'SELECT 1',
        atomicLexemes: ['SELECT'],
        tags: [],
    },
    {
        id: 'invalid-mixed-failure',
        dialect: 'hive',
        expectation: 'invalid',
        source: "'",
        atomicLexemes: [],
        tags: [],
    },
], cheapProbe);
var mixedInvalidOutcome = mixedFailureEvaluation.outcomes.filter(function(item) {
    return item.expectation == 'invalid';
})[0];
assert.strictEqual(mixedInvalidOutcome.status, 'analysis-failed');
assert.deepStrictEqual(mixedInvalidOutcome.analysisFailure, {
    stage: 'tokenize',
    message: 'TypeError: token crash',
});
assert.strictEqual(mixedFailureEvaluation.summary.invalidRejectRate, 0);

var invalidTokenResult = analyzeWithParser({
    validate: function() { return []; },
    getAllTokens: function() {
        return [
            { start: -1, stop: 0, channel: 0 },
            { start: 0, stop: 5, channel: 0 },
            { start: 7, stop: 7, channel: 0 },
        ];
    },
    parse: function() { return { ruleIndex: 0, start: { start: 0 }, stop: { stop: 7 } }; },
});
assert.strictEqual(invalidTokenResult.nativePartition.valid, false);
assert.strictEqual(invalidTokenResult.nativePartition.invalidTokenCount, 1);
evaluator.assert_leaf_partition('SELECT 1', invalidTokenResult.leaves);

var overlappingTokenResult = analyzeWithParser({
    validate: function() { return []; },
    getAllTokens: function() {
        return [
            { start: 0, stop: 5, channel: 0 },
            { start: 4, stop: 7, channel: 0 },
        ];
    },
    parse: function() { return { ruleIndex: 0, start: { start: 0 }, stop: { stop: 7 } }; },
});
assert.strictEqual(overlappingTokenResult.nativePartition.valid, false);
assert.strictEqual(overlappingTokenResult.nativePartition.overlapTokenCount, 1);
assert.strictEqual(overlappingTokenResult.nativePartition.nonTriviaGapCount, 1);
evaluator.assert_leaf_partition('SELECT 1', overlappingTokenResult.leaves);

var outOfOrderTokenResult = analyzeWithParser({
    validate: function() { return []; },
    getAllTokens: function() {
        return [
            { start: 7, stop: 7, channel: 0 },
            { start: 0, stop: 5, channel: 0 },
        ];
    },
    parse: function() { return { ruleIndex: 0, start: { start: 0 }, stop: { stop: 7 } }; },
});
assert.strictEqual(outOfOrderTokenResult.nativePartition.valid, false);
assert.strictEqual(outOfOrderTokenResult.nativePartition.invalidTokenCount, 1);
evaluator.assert_leaf_partition('SELECT 1', outOfOrderTokenResult.leaves);

[
    ['missing', { start: 0, stop: 7 }],
    ['null', { start: 0, stop: 7, channel: null }],
    ['string', { start: 0, stop: 7, channel: '1' }],
    ['negative', { start: 0, stop: 7, channel: -1 }],
    ['NaN', { start: 0, stop: 7, channel: NaN }],
    ['Infinity', { start: 0, stop: 7, channel: Infinity }],
    ['float', { start: 0, stop: 7, channel: 1.5 }],
].forEach(function(spec) {
    var invalidChannelResult = analyzeWithParser({
        validate: function() { return []; },
        getAllTokens: function() { return [spec[1]]; },
        parse: function() { return { ruleIndex: 0, start: { start: 0 }, stop: { stop: 7 } }; },
    });
    assert.strictEqual(invalidChannelResult.nativePartition.valid, false, spec[0]);
    assert.strictEqual(invalidChannelResult.nativePartition.invalidTokenCount, 1, spec[0]);
    assert.strictEqual(invalidChannelResult.nativePartition.overlapTokenCount, 0, spec[0]);
    assert.strictEqual(invalidChannelResult.nativePartition.nonTriviaGapCount, 1, spec[0]);
    assert.deepStrictEqual(invalidChannelResult.leaves, [{
        kind: 'opaque',
        origin: 'synthetic',
        raw: 'SELECT 1',
        span: { start: 0, end: 8 },
    }], spec[0]);
    evaluator.assert_leaf_partition('SELECT 1', invalidChannelResult.leaves);
});

var codeChannelResult = analyzeWithParser({
    validate: function() { return []; },
    getAllTokens: function() { return [{ start: 0, stop: 7, channel: 0 }]; },
    parse: function() { return { ruleIndex: 0, start: { start: 0 }, stop: { stop: 7 } }; },
});
assert.strictEqual(codeChannelResult.nativePartition.valid, true);
assert.strictEqual(codeChannelResult.nativePartition.invalidTokenCount, 0);
assert.strictEqual(codeChannelResult.leaves[0].origin, 'candidate');
assert.strictEqual(codeChannelResult.leaves[0].kind, 'token');
evaluator.assert_leaf_partition('SELECT 1', codeChannelResult.leaves);

var hiddenChannelResult = analyzeWithParser({
    validate: function() { return []; },
    getAllTokens: function() { return [{ start: 0, stop: 7, channel: 7 }]; },
    parse: function() { return { ruleIndex: 0, start: { start: 0 }, stop: { stop: 7 } }; },
});
assert.strictEqual(hiddenChannelResult.nativePartition.valid, true);
assert.strictEqual(hiddenChannelResult.nativePartition.invalidTokenCount, 0);
assert.strictEqual(hiddenChannelResult.leaves[0].origin, 'candidate');
assert.strictEqual(hiddenChannelResult.leaves[0].kind, 'trivia');
evaluator.assert_leaf_partition('SELECT 1', hiddenChannelResult.leaves);

var postgresRangeCase = cases.filter(function(testCase) {
    return testCase.id == 'postgres-dollar-parameter-operators';
})[0];
assert.strictEqual(candidate.analyze(postgresRangeCase).nodeSpansValid, true);

var offsets = [0, 1, 2, 3, 4, 5, 6];
function invalidChildNode() {
    return {
        ruleIndex: 1,
        start: { start: -999 },
        stop: { stop: -999 },
        children: [],
        getText: function() { return 'x'; },
    };
}
function legalNode(children) {
    return {
        ruleIndex: 0,
        start: { start: 0 },
        stop: { stop: 5 },
        children: children,
        getText: function() { return 'SELECT'; },
    };
}

// Real PostgreSQL epsilon: empty children, reverse-empty span, empty getText.
var epsilonInspection = candidate.inspect_nodes({
    ruleIndex: 0,
    start: { start: 5 },
    stop: { stop: 3 },
    children: [],
    getText: function() { return ''; },
}, offsets);
assert.strictEqual(epsilonInspection.valid, true);
assert.strictEqual(epsilonInspection.epsilonCount, 1);

// Real-style null children epsilon (ANTLR empty production).
var nullChildrenEpsilon = candidate.inspect_nodes({
    ruleIndex: 0,
    start: { start: 5 },
    stop: { stop: 4 },
    children: null,
    getText: function() { return ''; },
}, offsets);
assert.strictEqual(nullChildrenEpsilon.valid, true);
assert.strictEqual(nullChildrenEpsilon.epsilonCount, 1);

var undefinedChildrenEpsilon = candidate.inspect_nodes({
    ruleIndex: 0,
    start: { start: 5 },
    stop: { stop: 4 },
    children: undefined,
    getText: function() { return ''; },
}, offsets);
assert.strictEqual(undefinedChildrenEpsilon.valid, true);
assert.strictEqual(undefinedChildrenEpsilon.epsilonCount, 1);

// Raw stop.stop = -1 must fail closed before +1 can invent endIndex 0.
var invalidMinusOneStop = candidate.inspect_nodes({
    ruleIndex: 0,
    start: { start: 5 },
    stop: { stop: -1 },
    children: [],
    getText: function() { return ''; },
}, offsets);
assert.strictEqual(invalidMinusOneStop.valid, false);
assert.strictEqual(invalidMinusOneStop.epsilonCount, 0);

var invalidNegativeStopEpsilon = candidate.inspect_nodes({
    ruleIndex: 0,
    start: { start: 5 },
    stop: { stop: -100 },
    children: [],
    getText: function() { return ''; },
}, offsets);
assert.strictEqual(invalidNegativeStopEpsilon.valid, false);
assert.strictEqual(invalidNegativeStopEpsilon.epsilonCount, 0);

var invalidNegativeStart = candidate.inspect_nodes({
    ruleIndex: 0,
    start: { start: -1 },
    stop: { stop: 3 },
    children: [],
    getText: function() { return ''; },
}, offsets);
assert.strictEqual(invalidNegativeStart.valid, false);
assert.strictEqual(invalidNegativeStart.epsilonCount, 0);

var invalidStartBoundsEpsilon = candidate.inspect_nodes({
    ruleIndex: 0,
    start: { start: 7 },
    stop: { stop: 3 },
    children: [],
    getText: function() { return ''; },
}, offsets);
assert.strictEqual(invalidStartBoundsEpsilon.valid, false);
assert.strictEqual(invalidStartBoundsEpsilon.epsilonCount, 0);

var invalidStopBoundsEpsilon = candidate.inspect_nodes({
    ruleIndex: 0,
    start: { start: 5 },
    stop: { stop: 99 },
    children: [],
    getText: function() { return ''; },
}, offsets);
assert.strictEqual(invalidStopBoundsEpsilon.valid, false);
assert.strictEqual(invalidStopBoundsEpsilon.epsilonCount, 0);

var invalidReverseInspection = candidate.inspect_nodes({
    ruleIndex: 0,
    start: { start: 5 },
    stop: { stop: 3 },
    children: [],
    getText: function() { return 'x'; },
}, offsets);
assert.strictEqual(invalidReverseInspection.valid, false);
assert.strictEqual(invalidReverseInspection.epsilonCount, 0);

var invalidZeroWidthInspection = candidate.inspect_nodes({
    ruleIndex: 0,
    start: { start: 5 },
    stop: { stop: 4 },
    getText: function() { return 'x'; },
}, offsets);
assert.strictEqual(invalidZeroWidthInspection.valid, false);
assert.strictEqual(invalidZeroWidthInspection.epsilonCount, 0);

var invalidBoundsInspection = candidate.inspect_nodes({
    ruleIndex: 0,
    start: { start: 0 },
    stop: { stop: 99 },
    getText: function() { return 'SELECT'; },
}, offsets);
assert.strictEqual(invalidBoundsInspection.valid, false);

var missingEndpointInspection = candidate.inspect_nodes({
    ruleIndex: 0,
    start: { start: 0 },
    children: [],
    getText: function() { return ''; },
}, offsets);
assert.strictEqual(missingEndpointInspection.valid, false);
assert.strictEqual(missingEndpointInspection.epsilonCount, 0);

var normalNodeInspection = candidate.inspect_nodes({
    ruleIndex: 0,
    start: { start: 0 },
    stop: { stop: 5 },
    children: [],
    getText: function() { return 'SELECT'; },
}, offsets);
assert.strictEqual(normalNodeInspection.valid, true);
assert.strictEqual(normalNodeInspection.epsilonCount, 0);

// Non-array / unstable children must fail closed; illegal children cannot escape.
var arrayLikeChildren = candidate.inspect_nodes(
    legalNode({ 0: invalidChildNode(), length: 1 }),
    offsets
);
assert.strictEqual(arrayLikeChildren.valid, false);
assert.strictEqual(arrayLikeChildren.epsilonCount, 0);

var setChildren = candidate.inspect_nodes(
    legalNode(new Set([invalidChildNode()])),
    offsets
);
assert.strictEqual(setChildren.valid, false);
assert.strictEqual(setChildren.epsilonCount, 0);

var sparseChildren = [];
sparseChildren[1] = invalidChildNode();
sparseChildren.length = 2;
var sparseChildrenInspection = candidate.inspect_nodes(legalNode(sparseChildren), offsets);
assert.strictEqual(sparseChildrenInspection.valid, false);
assert.strictEqual(sparseChildrenInspection.epsilonCount, 0);

var nullChildEntry = candidate.inspect_nodes(legalNode([null]), offsets);
assert.strictEqual(nullChildEntry.valid, false);
assert.strictEqual(nullChildEntry.epsilonCount, 0);

var childrenReads = 0;
var unstableChildrenNode = {
    ruleIndex: 0,
    start: { start: 0 },
    stop: { stop: 5 },
    getText: function() { return 'SELECT'; },
};
Object.defineProperty(unstableChildrenNode, 'children', {
    get: function() {
        childrenReads++;
        var children = [{
            ruleIndex: 1,
            start: { start: 1 },
            stop: { stop: 2 },
            children: null,
            getText: function() { return 'EL'; },
        }];
        Object.defineProperty(children, 0, {
            configurable: true,
            enumerable: true,
            get: function() {
                // Structural mutation during dense-array snapshot must fail closed.
                children.push(invalidChildNode());
                return {
                    ruleIndex: 1,
                    start: { start: 1 },
                    stop: { stop: 2 },
                    children: null,
                    getText: function() { return 'EL'; },
                };
            },
        });
        return children;
    },
});
var unstableChildrenInspection = candidate.inspect_nodes(unstableChildrenNode, offsets);
assert.strictEqual(unstableChildrenInspection.valid, false);
assert.strictEqual(unstableChildrenInspection.epsilonCount, 0);
// Strict contract rejects node.children accessors without re-reading.
assert.ok(childrenReads <= 1, 'children accessor must not be re-read after snapshot');

var denseIllegalChild = candidate.inspect_nodes(legalNode([invalidChildNode()]), offsets);
assert.strictEqual(denseIllegalChild.valid, false);
assert.strictEqual(denseIllegalChild.count, 2);
assert.strictEqual(denseIllegalChild.epsilonCount, 0);

var denseLegalChild = candidate.inspect_nodes(legalNode([{
    ruleIndex: 1,
    start: { start: 1 },
    stop: { stop: 2 },
    children: null,
    getText: function() { return 'EL'; },
}]), offsets);
assert.strictEqual(denseLegalChild.valid, true);
assert.strictEqual(denseLegalChild.count, 2);
assert.strictEqual(denseLegalChild.epsilonCount, 0);

// TerminalNode-style missing children property remains a legal empty production.
var missingChildrenTerminal = {
    ruleIndex: 0,
    start: { start: 0 },
    stop: { stop: 5 },
    getText: function() { return 'SELECT'; },
};
assert.strictEqual(Object.prototype.hasOwnProperty.call(missingChildrenTerminal, 'children'), false);
var missingChildrenInspection = candidate.inspect_nodes(missingChildrenTerminal, offsets);
assert.strictEqual(missingChildrenInspection.valid, true);
assert.strictEqual(missingChildrenInspection.epsilonCount, 0);

// Forward-index children replacement: index-0 accessor rewrites not-yet-read illegal index-1.
var forwardChildren = [];
forwardChildren.length = 2;
forwardChildren[1] = invalidChildNode();
var forwardLegalChild = {
    ruleIndex: 1,
    start: { start: 1 },
    stop: { stop: 2 },
    children: null,
    getText: function() { return 'EL'; },
};
var forwardFirstRead = true;
Object.defineProperty(forwardChildren, 0, {
    configurable: true,
    enumerable: true,
    get: function() {
        if (forwardFirstRead) {
            forwardFirstRead = false;
            forwardChildren[1] = {
                ruleIndex: 2,
                start: { start: 3 },
                stop: { stop: 4 },
                children: null,
                getText: function() { return 'CT'; },
            };
        }
        return forwardLegalChild;
    },
});
var forwardChildrenInspection;
assert.doesNotThrow(function() {
    forwardChildrenInspection = candidate.inspect_nodes(legalNode(forwardChildren), offsets);
});
assert.strictEqual(forwardChildrenInspection.valid, false);
assert.strictEqual(forwardChildrenInspection.epsilonCount, 0);

// Array Proxy children containers must fail closed without throwing.
var proxyChildren = new Proxy([{
    ruleIndex: 1,
    start: { start: 1 },
    stop: { stop: 2 },
    children: null,
    getText: function() { return 'EL'; },
}], {});
var proxyChildrenInspection;
assert.doesNotThrow(function() {
    proxyChildrenInspection = candidate.inspect_nodes(legalNode(proxyChildren), offsets);
});
assert.strictEqual(proxyChildrenInspection.valid, false);
assert.strictEqual(proxyChildrenInspection.epsilonCount, 0);

var revokedChildren = Proxy.revocable([{
    ruleIndex: 1,
    start: { start: 1 },
    stop: { stop: 2 },
    children: null,
    getText: function() { return 'EL'; },
}], {});
revokedChildren.revoke();
var revokedChildrenInspection;
assert.doesNotThrow(function() {
    revokedChildrenInspection = candidate.inspect_nodes(legalNode(revokedChildren.proxy), offsets);
});
assert.strictEqual(revokedChildrenInspection.valid, false);
assert.strictEqual(revokedChildrenInspection.epsilonCount, 0);

// Proxy children must not become accepted + valid node spans through the analyzer.
var proxyAnalyzer = candidate.create_analyzer({
    hive: function() {
        return {
            validate: function() { return []; },
            getAllTokens: function() {
                return [{ start: 0, stop: 7, channel: 0 }];
            },
            parse: function() {
                return legalNode(new Proxy([{
                    ruleIndex: 1,
                    start: { start: 1 },
                    stop: { stop: 2 },
                    children: null,
                    getText: function() { return 'EL'; },
                }], {}));
            },
        };
    },
});
var proxyAnalyzerResult = proxyAnalyzer({
    id: 'proxy-children-analyzer',
    dialect: 'hive',
    expectation: 'required',
    source: 'SELECT 1',
    atomicLexemes: [],
    tags: [],
});
assert.notStrictEqual(proxyAnalyzerResult.status + ':' + proxyAnalyzerResult.nodeSpansValid, 'accepted:true');
assert.strictEqual(proxyAnalyzerResult.accepted && proxyAnalyzerResult.nodeSpansValid, false);

// Graph integrity: self-cycle, two-node cycle, and shared child all fail closed.
var selfCycleRoot = legalNode([]);
selfCycleRoot.children = [selfCycleRoot];
var selfCycleInspection;
assert.doesNotThrow(function() {
    selfCycleInspection = candidate.inspect_nodes(selfCycleRoot, offsets);
});
assert.strictEqual(selfCycleInspection.valid, false);
assert.strictEqual(selfCycleInspection.epsilonCount, 0);

var twoNodeChild = {
    ruleIndex: 1,
    start: { start: 1 },
    stop: { stop: 2 },
    children: null,
    getText: function() { return 'EL'; },
};
var twoNodeRoot = legalNode([twoNodeChild]);
twoNodeChild.children = [twoNodeRoot];
var twoNodeInspection;
assert.doesNotThrow(function() {
    twoNodeInspection = candidate.inspect_nodes(twoNodeRoot, offsets);
});
assert.strictEqual(twoNodeInspection.valid, false);
assert.strictEqual(twoNodeInspection.epsilonCount, 0);

var sharedChild = {
    ruleIndex: 1,
    start: { start: 1 },
    stop: { stop: 2 },
    children: null,
    getText: function() { return 'EL'; },
};
var sharedChildInspection;
assert.doesNotThrow(function() {
    sharedChildInspection = candidate.inspect_nodes(legalNode([sharedChild, sharedChild]), offsets);
});
assert.strictEqual(sharedChildInspection.valid, false);
assert.strictEqual(sharedChildInspection.epsilonCount, 0);

var selfCycleAnalyzer = candidate.create_analyzer({
    hive: function() {
        return {
            validate: function() { return []; },
            getAllTokens: function() {
                return [{ start: 0, stop: 7, channel: 0 }];
            },
            parse: function() {
                var root = legalNode([]);
                root.children = [root];
                return root;
            },
        };
    },
});
var selfCycleAnalyzerResult = selfCycleAnalyzer({
    id: 'self-cycle-analyzer',
    dialect: 'hive',
    expectation: 'required',
    source: 'SELECT 1',
    atomicLexemes: [],
    tags: [],
});
assert.strictEqual(selfCycleAnalyzerResult.accepted && selfCycleAnalyzerResult.nodeSpansValid, false);

var twoNodeCycleAnalyzer = candidate.create_analyzer({
    hive: function() {
        return {
            validate: function() { return []; },
            getAllTokens: function() {
                return [{ start: 0, stop: 7, channel: 0 }];
            },
            parse: function() {
                var child = {
                    ruleIndex: 1,
                    start: { start: 1 },
                    stop: { stop: 2 },
                    children: null,
                    getText: function() { return 'EL'; },
                };
                var root = legalNode([child]);
                child.children = [root];
                return root;
            },
        };
    },
});
var twoNodeCycleAnalyzerResult = twoNodeCycleAnalyzer({
    id: 'two-node-cycle-analyzer',
    dialect: 'hive',
    expectation: 'required',
    source: 'SELECT 1',
    atomicLexemes: [],
    tags: [],
});
assert.strictEqual(twoNodeCycleAnalyzerResult.accepted && twoNodeCycleAnalyzerResult.nodeSpansValid, false);

// node.children binding TOCTOU: endpoint/getText must not replace the whole children property.
function replaceChildrenWithInvalid(target) {
    target.children = [invalidChildNode()];
}

var startReplacesChildren = {
    ruleIndex: 0,
    stop: { stop: 5 },
    children: [{
        ruleIndex: 1,
        start: { start: 1 },
        stop: { stop: 2 },
        children: null,
        getText: function() { return 'EL'; },
    }],
    getText: function() { return 'SELECT'; },
};
Object.defineProperty(startReplacesChildren, 'start', {
    configurable: true,
    enumerable: true,
    get: function() {
        replaceChildrenWithInvalid(startReplacesChildren);
        return { start: 0 };
    },
});
var startBindingInspection;
assert.doesNotThrow(function() {
    startBindingInspection = candidate.inspect_nodes(startReplacesChildren, offsets);
});
assert.strictEqual(startBindingInspection.valid, false);
assert.strictEqual(startBindingInspection.epsilonCount, 0);

var startBindingAnalyzer = candidate.create_analyzer({
    hive: function() {
        return {
            validate: function() { return []; },
            getAllTokens: function() {
                return [{ start: 0, stop: 7, channel: 0 }];
            },
            parse: function() {
                var node = {
                    ruleIndex: 0,
                    stop: { stop: 5 },
                    children: [{
                        ruleIndex: 1,
                        start: { start: 1 },
                        stop: { stop: 2 },
                        children: null,
                        getText: function() { return 'EL'; },
                    }],
                    getText: function() { return 'SELECT'; },
                };
                Object.defineProperty(node, 'start', {
                    configurable: true,
                    enumerable: true,
                    get: function() {
                        replaceChildrenWithInvalid(node);
                        return { start: 0 };
                    },
                });
                return node;
            },
        };
    },
});
var startBindingAnalyzerResult = startBindingAnalyzer({
    id: 'start-children-binding-analyzer',
    dialect: 'hive',
    expectation: 'required',
    source: 'SELECT 1',
    atomicLexemes: [],
    tags: [],
});
assert.strictEqual(startBindingAnalyzerResult.accepted && startBindingAnalyzerResult.nodeSpansValid, false);

var stopReplacesChildren = {
    ruleIndex: 0,
    start: { start: 0 },
    children: [{
        ruleIndex: 1,
        start: { start: 1 },
        stop: { stop: 2 },
        children: null,
        getText: function() { return 'EL'; },
    }],
    getText: function() { return 'SELECT'; },
};
Object.defineProperty(stopReplacesChildren, 'stop', {
    configurable: true,
    enumerable: true,
    get: function() {
        replaceChildrenWithInvalid(stopReplacesChildren);
        return { stop: 5 };
    },
});
var stopBindingInspection;
assert.doesNotThrow(function() {
    stopBindingInspection = candidate.inspect_nodes(stopReplacesChildren, offsets);
});
assert.strictEqual(stopBindingInspection.valid, false);
assert.strictEqual(stopBindingInspection.epsilonCount, 0);

var epsilonEmptyArrayBinding = {
    ruleIndex: 0,
    start: { start: 5 },
    stop: { stop: 3 },
    children: [],
};
epsilonEmptyArrayBinding.getText = function() {
    replaceChildrenWithInvalid(epsilonEmptyArrayBinding);
    return '';
};
var epsilonEmptyArrayBindingInspection;
assert.doesNotThrow(function() {
    epsilonEmptyArrayBindingInspection = candidate.inspect_nodes(epsilonEmptyArrayBinding, offsets);
});
assert.strictEqual(epsilonEmptyArrayBindingInspection.valid, false);
assert.strictEqual(epsilonEmptyArrayBindingInspection.epsilonCount, 0);

var epsilonNullBinding = {
    ruleIndex: 0,
    start: { start: 5 },
    stop: { stop: 3 },
    children: null,
};
epsilonNullBinding.getText = function() {
    replaceChildrenWithInvalid(epsilonNullBinding);
    return '';
};
var epsilonNullBindingInspection;
assert.doesNotThrow(function() {
    epsilonNullBindingInspection = candidate.inspect_nodes(epsilonNullBinding, offsets);
});
assert.strictEqual(epsilonNullBindingInspection.valid, false);
assert.strictEqual(epsilonNullBindingInspection.epsilonCount, 0);

var childrenFlagMutation = legalNode([{
    ruleIndex: 1,
    start: { start: 1 },
    stop: { stop: 2 },
    children: null,
    getText: function() { return 'EL'; },
}]);
Object.defineProperty(childrenFlagMutation, 'start', {
    configurable: true,
    enumerable: true,
    get: function() {
        Object.defineProperty(childrenFlagMutation, 'children', {
            value: childrenFlagMutation.children,
            writable: false,
            enumerable: true,
            configurable: true,
        });
        return { start: 0 };
    },
});
var childrenFlagMutationInspection;
assert.doesNotThrow(function() {
    childrenFlagMutationInspection = candidate.inspect_nodes(childrenFlagMutation, offsets);
});
assert.strictEqual(childrenFlagMutationInspection.valid, false);
assert.strictEqual(childrenFlagMutationInspection.epsilonCount, 0);

// Real PostgreSQL epsilon must still pass through the adapter end-to-end.
var realPostgresEpsilonCase = {
    id: 'postgres-real-epsilon-probe',
    dialect: 'postgresql',
    expectation: 'required',
    source: 'SELECT a FROM t WHERE id = $1',
    atomicLexemes: ['$1'],
    tags: ['epsilon'],
};
var realPostgresEpsilon = candidate.analyze(realPostgresEpsilonCase);
assert.strictEqual(realPostgresEpsilon.status, 'accepted');
assert.strictEqual(realPostgresEpsilon.nodeSpansValid, true);
assert.ok(realPostgresEpsilon.nodeCount > 0);

var hiveEntry = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'v2-parser-evaluation', 'candidates', 'dt-entry.js'), 'utf8');
var evaluationEntry = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'v2-parser-evaluation', 'candidates', 'dt-evaluation-entry.js'), 'utf8');
assert.ok(/import\s*\{\s*HiveSQL\s*\}\s*from\s*['"]dt-sql-parser['"]/.test(hiveEntry), 'Hive entry uses ESM named import');
assert.strictEqual(hiveEntry.indexOf("require('dt-sql-parser')"), -1, 'Hive entry avoids root CommonJS require');
['GenericSQL', 'HiveSQL', 'MySQL', 'PostgreSQL'].forEach(function(name) {
    assert.ok(evaluationEntry.indexOf(name) >= 0, 'evaluation entry includes ' + name);
});
assert.strictEqual(evaluationEntry.indexOf("require('dt-sql-parser')"), -1, 'evaluation entry avoids root CommonJS require');

var rejectedCandidate = {
    analyze: function() {
        return {
            status: 'syntax-rejected',
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
        && /status and accepted must describe success/.test(error.message)
        && /errors must be empty/.test(error.message);
});

var timedAnalysisCount = 0;
var emptyTimedCandidate = {
    analyze: function() {
        timedAnalysisCount++;
        if (timedAnalysisCount == 4) {
            return {
                status: 'accepted',
                accepted: true,
                errors: [],
                leaves: [],
                nodeCount: 0,
                nodeSpansValid: false,
            };
        }
        return {
            status: 'accepted',
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
