'use strict';

var assert = require('assert');
var analysisApi = require('../../.tmp/v2-core/core/analysis/index.js');
var formatApi = require('../../.tmp/v2-core/core/api/format.js');
var lexerApi = require('../../.tmp/v2-core/core/lexer/lossless-lexer.js');

function analyze(source) {
    var result = analysisApi.analyzeSql(source, {
        dialect: 'hive',
        mode: 'document'
    });
    assert.strictEqual(result.status, 'analyzed', source);
    return result;
}

function ownerDiscriminator(node) {
    return node.itemRole || node.expressionKind || node.clauseKind ||
        node.statementKind || null;
}

function bindingRows(analysis) {
    return analysis.index.commentBindings().map(function(binding) {
        var leaf = analysis.leaves[binding.commentLeafId];
        var owner = analysis.index.nodeById(binding.ownerNodeId);
        return [
            leaf.kind,
            leaf.raw,
            binding.placement,
            owner.kind,
            ownerDiscriminator(owner)
        ];
    });
}

function protectedRows(source, dialect) {
    return lexerApi.lexSql(source, { dialect: dialect || 'hive' }).leaves.filter(function(leaf) {
        return leaf.channel === 'protected' ||
            leaf.kind === 'line-comment' ||
            leaf.kind === 'block-comment';
    }).map(function(leaf) {
        return [leaf.kind, leaf.channel, leaf.raw];
    });
}

[
    {
        id: 'one-user-blank-line-between-clauses',
        source: 'select a\n\n\n\nfrom t',
        options: {},
        expected: 'SELECT\n      a\n\nFROM t'
    },
    {
        id: 'one-user-blank-line-between-statements',
        source: 'select 1;\n\n\n\nselect 2',
        options: {},
        expected: 'SELECT 1;\n\nSELECT 2'
    },
    {
        id: 'trailing-line-comment-forces-break-and-keeps-one-blank',
        source: 'select a -- tail\n\n\nfrom t',
        options: {},
        expected: 'SELECT\n      a -- tail\n\nFROM t'
    },
    {
        id: 'multiline-block-comment-keeps-following-physical-break',
        source: 'select a /* multi\r\nline */\n + b from t',
        options: {},
        expected: 'SELECT\r\n      a /* multi\r\nline */\r\n      + b\r\nFROM t'
    },
    {
        id: 'line-owned-dangling-comment-expands-container',
        source: 'select (\n/*dangling*/\na\n) from t',
        options: {},
        expected: [
            'SELECT',
            '      (',
            '          /*dangling*/',
            '          a',
            '      )',
            'FROM t'
        ].join('\n')
    },
    {
        id: 'inline-dangling-comment-stays-inline',
        source: 'select (/*dangling*/a) from t',
        options: {},
        expected: 'SELECT\n      (/*dangling*/a)\nFROM t'
    },
    {
        id: 'leading-comment-uses-binding-owned-break',
        source: 'select /*lead*/ a from t',
        options: {},
        expected: 'SELECT\n      /*lead*/\n      a\nFROM t'
    },
    {
        id: 'trailing-block-comment-stays-before-operator',
        source: 'select a /*tail*/+b from t',
        options: {},
        expected: 'SELECT\n      a /*tail*/ + b\nFROM t'
    },
    {
        id: 'trailing-comma-style-preserves-one-list-blank-line',
        source: 'select a,\n\n\n\nb from t',
        options: { commaStyle: 'trailing' },
        expected: 'SELECT\n    a,\n\n    b\nFROM t'
    }
].forEach(function(testCase) {
    var before = analyze(testCase.source);
    var options = Object.assign({ dialect: 'hive' }, testCase.options);
    var first = formatApi.formatSql(testCase.source, options);
    assert.strictEqual(first.status, 'formatted', testCase.id);
    assert.strictEqual(first.text, testCase.expected, testCase.id);
    assert.deepStrictEqual(
        protectedRows(first.text),
        protectedRows(testCase.source),
        testCase.id + ' protected/comment raw bytes'
    );
    var after = analyze(first.text);
    assert.deepStrictEqual(
        bindingRows(after),
        bindingRows(before),
        testCase.id + ' CommentBinding conservation'
    );
    var second = formatApi.formatSql(first.text, options);
    assert.strictEqual(second.status, 'unchanged', testCase.id + ' repeat');
    assert.strictEqual(second.text, first.text, testCase.id + ' idempotency');
});

(function testVerbatimClaimTerminatesTriviaFallbackScan() {
    var source = 'SeLeCt\t"Mixed Name"  as x, /* keep */\t:value  as y ' +
        'FrOm\tt where a=1 and b>2';
    var options = {
        dialect: 'postgresql',
        keywordCase: 'upper',
        commaStyle: 'trailing',
        indentStyle: 'space',
        caseLayout: 'compactShort',
        caseWhenThenWrapLength: 62,
        maxAlignWidth: 73,
        unsupportedSyntaxPolicy: 'warn'
    };
    var first = formatApi.formatSql(source, options);
    assert.strictEqual(first.status, 'formatted');
    assert.strictEqual(first.text, [
        'SELECT',
        '    "Mixed Name" AS x, /* keep */',
        '    :value AS y',
        'FROM t',
        'WHERE a = 1',
        '    AND b > 2'
    ].join('\n'));
    assert.deepStrictEqual(
        protectedRows(first.text, 'postgresql'),
        protectedRows(source, 'postgresql'),
        'verbatim boundary comment/protected bytes'
    );
    var second = formatApi.formatSql(first.text, options);
    assert.strictEqual(second.status, 'unchanged');
    assert.strictEqual(second.text, first.text);
})();

console.log('v2 Wave 3E trivia layout tests passed');
