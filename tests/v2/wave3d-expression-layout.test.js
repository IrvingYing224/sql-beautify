'use strict';

var assert = require('assert');
var analysisApi = require('../../.tmp/v2-core/core/analysis/index.js');
var formatApi = require('../../.tmp/v2-core/core/api/format.js');
var lexerApi = require('../../.tmp/v2-core/core/lexer/lossless-lexer.js');
var claimsApi = require('../../.tmp/v2-core/core/layout/verbatim-claims.js');
var cases = require('../fixtures/v2-wave3d-expression-cases.js');
var closureCases = require('../fixtures/v2-wave3-corpus-cases.js');

var EXPECTED_FORMATTED_EXPRESSION_CAPABILITIES = Object.freeze([
    'case-expression',
    'cast-type',
    'collection-expression',
    'function-call',
    'subquery-expression',
    'window-expression'
]);

function analyze(source, dialect) {
    var result = analysisApi.analyzeSql(source, {
        dialect: dialect || 'hive',
        mode: 'document'
    });
    assert.strictEqual(result.status, 'analyzed', source);
    return result;
}

function protectedRows(leaves) {
    return leaves.filter(function(leaf) {
        return leaf.channel === 'protected' ||
            leaf.kind === 'line-comment' ||
            leaf.kind === 'block-comment';
    }).map(function(leaf) {
        return [leaf.kind, leaf.channel, leaf.raw];
    });
}

function closureCase(id) {
    var value = closureCases.find(function(testCase) { return testCase.id === id; });
    assert.ok(value, 'missing shared Wave 3 corpus case ' + id);
    return value;
}

(function testExpressionGoldensCapabilityAuthorityAndConservation() {
    var covered = new Set();
    cases.forEach(function(testCase) {
        var analysis = analyze(testCase.source);
        var claims = claimsApi.dominatingVerbatimClaims(analysis);
        assert.ok(claims, testCase.id + ' claims');
        testCase.capabilities.forEach(function(capabilityId) {
            covered.add(capabilityId);
            var nodes = analysis.index.nodes().filter(function(node) {
                return node.capabilityId === capabilityId;
            });
            assert.ok(nodes.length > 0, testCase.id + ' contains ' + capabilityId);
            nodes.forEach(function(node) {
                assert.strictEqual(
                    analysis.index.capabilityForNode(node.id).state,
                    'formatted',
                    testCase.id + ' ' + capabilityId + ' state'
                );
                assert.strictEqual(claims.claimForOwner(node.id), null,
                    testCase.id + ' ' + capabilityId + ' must not be verbatim');
            });
        });

        var result = formatApi.formatSql(testCase.source, testCase.options);
        assert.strictEqual(result.status, 'formatted', testCase.id);
        assert.strictEqual(result.text, testCase.expected, testCase.id);
        assert.deepStrictEqual(
            protectedRows(lexerApi.lexSql(result.text, { dialect: 'hive' }).leaves),
            protectedRows(analysis.leaves),
            testCase.id + ' protected bytes'
        );
        var repeated = formatApi.formatSql(result.text, testCase.options);
        assert.strictEqual(repeated.status, 'unchanged', testCase.id + ' repeat');
        assert.strictEqual(repeated.text, result.text, testCase.id + ' idempotency');
    });
    assert.deepStrictEqual(
        Array.from(covered).sort(),
        EXPECTED_FORMATTED_EXPRESSION_CAPABILITIES,
        'Wave 3D goldens cover the exact Hive expression manifest'
    );
})();

(function testCaseStrategiesShareTheRendererThreshold() {
    var source = "select case when a=1 then 'x' else 'y' end from t";
    var compact = formatApi.formatSql(source, {
        dialect: 'hive',
        caseLayout: 'compactShort',
        caseWhenThenWrapLength: 50
    });
    assert.strictEqual(compact.status, 'formatted');
    assert.strictEqual(compact.text, [
        'SELECT',
        "      CASE WHEN a = 1 THEN 'x' ELSE 'y' END",
        'FROM t'
    ].join('\n'));

    var wrapped = formatApi.formatSql(source, {
        dialect: 'hive',
        caseLayout: 'compactShort',
        caseWhenThenWrapLength: 10
    });
    assert.strictEqual(wrapped.status, 'formatted');
    assert.strictEqual(wrapped.text, [
        'SELECT',
        '      CASE',
        '          WHEN a = 1 THEN',
        "              'x'",
        "          ELSE 'y'",
        '      END',
        'FROM t'
    ].join('\n'));
    assert.strictEqual(
        formatApi.formatSql(wrapped.text, {
            dialect: 'hive',
            caseLayout: 'compactShort',
            caseWhenThenWrapLength: 10
        }).status,
        'unchanged'
    );
})();

(function testCompactCaseRejectsCommentAndVerbatimChildren() {
    var options = {
        dialect: 'hive',
        caseLayout: 'compactShort',
        caseWhenThenWrapLength: 200
    };
    [
        {
            id: 'comment',
            source: "select case when a=1 then 'x' /*keep*/ else 'y' end",
            expected: [
                'SELECT CASE',
                "    WHEN a = 1 THEN 'x' /*keep*/",
                "    ELSE 'y'",
                'END'
            ].join('\n')
        },
        {
            id: 'structured-verbatim-child',
            source: "select case when a=1 then ${hiveconf:v} else 'y' end",
            expected: [
                'SELECT CASE',
                '    WHEN a = 1 THEN ${hiveconf:v}',
                "    ELSE 'y'",
                'END'
            ].join('\n')
        }
    ].forEach(function(testCase) {
        var result = formatApi.formatSql(testCase.source, options);
        assert.strictEqual(result.status, 'formatted', testCase.id);
        assert.strictEqual(result.text, testCase.expected, testCase.id);
        assert.strictEqual(
            formatApi.formatSql(result.text, options).status,
            'unchanged',
            testCase.id + ' idempotency'
        );
    });
})();

(function testUnknownExpressionRecoveryStaysMinimalInsideFormattedOwners() {
    var testCase = closureCase('unknown-expression-local-recovery');
    var result = formatApi.formatSql(testCase.source, testCase.options);
    assert.strictEqual(result.status, 'formatted');
    assert.strictEqual(result.text, [
        'SELECT CASE',
        '    WHEN a = 1 THEN f(a => b)',
        "    ELSE 'y'",
        'END'
    ].join('\n'));
    assert.ok(result.diagnostics.some(function(diagnostic) {
        return diagnostic.recovery === 'verbatim-node';
    }), 'unknown child must retain a local recovery diagnostic');
    assert.ok(result.text.indexOf('f(a => b)') >= 0,
        'only the unknown child bytes stay verbatim inside formatted owners');
})();

(function testUnformattedDialectSpecificOperatorsRemainAtomic() {
    [
        [
            'postgresql',
            "select payload->>'x' from t",
            ["SELECT", "      payload->>'x'", "FROM t"].join('\n')
        ],
        [
            'mysql',
            "select payload->>'$.x' from t",
            ["SELECT", "      payload->>'$.x'", "FROM t"].join('\n')
        ]
    ].forEach(function(row) {
        var result = formatApi.formatSql(row[1], { dialect: row[0] });
        assert.strictEqual(result.status, 'formatted', row[0]);
        assert.strictEqual(result.text, row[2], row[0] + ' atomic operator');
        assert.strictEqual(
            formatApi.formatSql(result.text, { dialect: row[0] }).status,
            'unchanged',
            row[0] + ' idempotency'
        );
    });
})();

(function testTemplateParameterStaysStructuredAndByteExact() {
    var testCase = closureCase('structured-template-parameter');
    var analysis = analyze(testCase.source);
    var template = analysis.index.nodes().find(function(node) {
        return node.capabilityId === 'template-parameter';
    });
    assert.ok(template);
    assert.strictEqual(analysis.index.capabilityForNode(template.id).state, 'structured');
    var result = formatApi.formatSql(testCase.source, testCase.options);
    assert.strictEqual(result.status, 'formatted');
    assert.strictEqual(result.text, [
        'SELECT',
        '      ${hiveconf:value} + 1',
        'FROM t'
    ].join('\n'));
})();

console.log('v2 Wave 3D expression layout tests passed');
