'use strict';

var assert = require('assert');
var analysisApi = require('../../.tmp/v2-core/core/analysis/index.js');
var formatApi = require('../../.tmp/v2-core/core/api/format.js');
var optionsApi = require('../../.tmp/v2-core/core/config/resolve-options.js');
var policyApi = require('../../.tmp/v2-core/core/layout/policy.js');
var lexerApi = require('../../.tmp/v2-core/core/lexer/lossless-lexer.js');
var cases = require('../fixtures/v2-wave3c-hive-query-cases');

var EXPECTED_FORMATTED_CAPABILITIES = Object.freeze([
    'cluster-by',
    'distribute-by',
    'from',
    'group-by',
    'having',
    'insert-overwrite-partition-select',
    'join',
    'lateral-view',
    'limit',
    'multi-statement',
    'order-by',
    'select-without-from',
    'set-operations',
    'sort-by',
    'subquery',
    'table-function',
    'where',
    'window',
    'with-cte'
]);

function analyze(source) {
    var result = analysisApi.analyzeSql(source, {
        dialect: 'hive',
        mode: 'document'
    });
    assert.strictEqual(result.status, 'analyzed', source);
    return result;
}

function resolveOptions(value) {
    var result = optionsApi.resolveFormatOptions(value);
    assert.strictEqual(result.ok, true);
    return result.options;
}

function planAuthorityNodeIds(plan) {
    var result = new Set();
    plan.leafAuthorityNodeIds.forEach(function(nodeId) {
        if (nodeId !== null) {
            result.add(nodeId);
        }
    });
    plan.gapActions.forEach(function(action) {
        if (action !== null) {
            result.add(action.authorityNodeId);
        }
    });
    plan.scopeStarts.forEach(function(actions) {
        if (actions !== null) {
            actions.forEach(function(action) {
                result.add(action.authorityNodeId);
            });
        }
    });
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

function commentPlacementRows(analysis) {
    function discriminator(node) {
        if (node.kind === 'clause') {
            return node.clauseKind;
        }
        if (node.kind === 'query') {
            return node.queryKind;
        }
        if (node.kind === 'relation') {
            return node.relationKind;
        }
        if (node.kind === 'list') {
            return node.listRole;
        }
        if (node.kind === 'expression') {
            return node.expressionKind;
        }
        return null;
    }
    return analysis.index.commentBindings().map(function(binding) {
        var leaf = analysis.leaves[binding.commentLeafId];
        var owner = analysis.index.nodeById(binding.ownerNodeId);
        var path = [];
        var current = owner;
        while (current) {
            var parent = analysis.index.parentOf(current.id);
            var ordinal = parent === null ? 0 : parent.children.findIndex(
                function(child) { return child.id === current.id; }
            );
            path.push([
                current.kind,
                current.formatRole,
                current.capabilityId,
                discriminator(current),
                ordinal
            ]);
            current = parent;
        }
        return [
            leaf.kind,
            leaf.raw,
            binding.placement,
            path.reverse()
        ];
    });
}

function commentEvidenceMatchesCapability(
    analysis,
    capabilityId,
    commentRaw
) {
    var leaves = analysis.leaves.filter(function(leaf) {
        return (leaf.kind === 'line-comment' || leaf.kind === 'block-comment') &&
            leaf.raw === commentRaw;
    });
    assert.strictEqual(leaves.length, 1,
        capabilityId + ' evidence comment must be unique');
    var leaf = leaves[0];
    var binding = analysis.index.commentBinding(leaf.id);
    assert.ok(binding, capabilityId + ' evidence must have a binding');
    var occurrences = analysis.index.nodes().filter(function(node) {
        return node.capabilityId === capabilityId;
    });
    return occurrences.some(function(occurrence) {
        if (leaf.id < occurrence.leafRange.start ||
            leaf.id >= occurrence.leafRange.end) {
            return false;
        }
        var owner = analysis.index.nodeById(binding.ownerNodeId);
        while (owner) {
            if (owner.id === occurrence.id) {
                return true;
            }
            owner = analysis.index.parentOf(owner.id);
        }
        return false;
    });
}

(function testEveryFormattedCapabilityHasGoldenProtectedAndAuthorityEvidence() {
    var covered = new Set();
    var protectedCovered = new Set();
    cases.forEach(function(testCase) {
        var analysis = analyze(testCase.source);
        var options = resolveOptions(testCase.options);
        var planned = policyApi.buildLayoutPlan(analysis, options);
        assert.strictEqual(planned.ok, true, testCase.id + ' plan');
        var authorities = planAuthorityNodeIds(planned.plan);

        testCase.capabilities.forEach(function(capabilityId) {
            covered.add(capabilityId);
            var occurrences = analysis.index.nodes().filter(function(node) {
                return node.capabilityId === capabilityId;
            });
            assert.ok(occurrences.length > 0,
                testCase.id + ' must contain ' + capabilityId);
            occurrences.forEach(function(node) {
                var capability = analysis.index.capabilityForNode(node.id);
                assert.ok(capability, testCase.id + ' capability lookup');
                assert.strictEqual(capability.state, 'formatted',
                    testCase.id + ' ' + capabilityId + ' registry state');
                assert.strictEqual(authorities.has(node.id), true,
                    testCase.id + ' must register an action for node ' + node.id +
                    ' (' + capabilityId + ')');
            });
        });
        Object.keys(testCase.evidenceByCapability).forEach(function(capabilityId) {
            assert.ok(testCase.capabilities.indexOf(capabilityId) >= 0,
                testCase.id + ' evidence must name a declared capability');
            var evidence = testCase.evidenceByCapability[capabilityId];
            assert.strictEqual(
                commentEvidenceMatchesCapability(
                    analysis,
                    capabilityId,
                    evidence.commentRaw
                ),
                true,
                testCase.id + ' evidence must be inside and owned by ' + capabilityId
            );
            protectedCovered.add(capabilityId);
        });

        var result = formatApi.formatSql(testCase.source, testCase.options);
        assert.strictEqual(result.status, 'formatted', testCase.id);
        assert.strictEqual(result.text, testCase.expected, testCase.id);
        assert.strictEqual(Object.isFrozen(result.sourceMap), true, testCase.id);

        var outputLeaves = lexerApi.lexSql(result.text, {
            dialect: 'hive'
        }).leaves;
        assert.deepStrictEqual(
            protectedRows(outputLeaves),
            protectedRows(analysis.leaves),
            testCase.id + ' protected/comment bytes'
        );
        assert.deepStrictEqual(
            commentPlacementRows(analyze(result.text)),
            commentPlacementRows(analysis),
            testCase.id + ' comment binding conservation'
        );

        var repeated = formatApi.formatSql(result.text, testCase.options);
        assert.strictEqual(repeated.status, 'unchanged',
            testCase.id + ' second status');
        assert.strictEqual(repeated.text, result.text,
            testCase.id + ' strict idempotency');
    });
    assert.deepStrictEqual(
        Array.from(covered).sort(),
        EXPECTED_FORMATTED_CAPABILITIES,
        'Wave 3C golden cases must cover the exact Hive formatted manifest'
    );
    assert.deepStrictEqual(
        Array.from(protectedCovered).sort(),
        EXPECTED_FORMATTED_CAPABILITIES,
        'every Hive formatted capability needs non-empty protected/comment evidence'
    );
})();

(function testKeywordShapedNamesRemainNamesAndOptionsRemainBehavioral() {
    var named = formatApi.formatSql(
        'select window as order from `group` as limit',
        { dialect: 'hive', keywordCase: 'lower', commaStyle: 'trailing' }
    );
    assert.strictEqual(named.status, 'formatted');
    assert.strictEqual(
        named.text,
        'select\n    window as order\nfrom `group` as limit'
    );

    var leading = cases.find(function(testCase) {
        return testCase.id === 'query-clauses-leading';
    });
    var trailing = cases.find(function(testCase) {
        return testCase.id === 'query-clauses-trailing';
    });
    assert.ok(leading && trailing);
    assert.notStrictEqual(leading.expected, trailing.expected,
        'commaStyle must select different proven layouts');

    var caseExpression = formatApi.formatSql(
        "select case when a=1 then 'FROM' else 'x' end as c,b from t",
        { dialect: 'hive', commaStyle: 'leading' }
    );
    assert.strictEqual(caseExpression.status, 'formatted');
    assert.strictEqual(
        caseExpression.text,
        [
            'SELECT',
            '      CASE',
            "          WHEN a = 1 THEN 'FROM'",
            "          ELSE 'x'",
            '      END AS c',
            '    , b',
            'FROM t'
        ].join('\n'),
        'formatted CASE uses the shared expression policy inside a query list'
    );
    assert.strictEqual(
        formatApi.formatSql(caseExpression.text, {
            dialect: 'hive',
            commaStyle: 'leading'
        }).status,
        'unchanged'
    );
})();

(function testWave3DSubqueryExpressionsUseStructuredQueryLayout() {
    [
        {
            id: 'scalar-subquery-expression',
            source: 'select (select 1) as x from t',
            expected: 'SELECT\n      (\n          SELECT 1\n      ) AS x\nFROM t'
        },
        {
            id: 'exists-subquery-expression',
            source: 'select exists(select 1) from t',
            expected: 'SELECT\n      EXISTS (\n          SELECT 1\n      )\nFROM t'
        },
        {
            id: 'in-subquery-expression',
            source: 'select a from t where a in (select b from u)',
            expected: [
                'SELECT',
                '      a',
                'FROM t',
                'WHERE a IN (',
                '    SELECT',
                '          b',
                '    FROM u',
                ')'
            ].join('\n')
        }
    ].forEach(function(testCase) {
        var first = formatApi.formatSql(testCase.source, { dialect: 'hive' });
        assert.strictEqual(first.status, 'formatted', testCase.id);
        assert.strictEqual(first.text, testCase.expected, testCase.id);
        var second = formatApi.formatSql(first.text, { dialect: 'hive' });
        assert.strictEqual(second.status, 'unchanged', testCase.id + ' second status');
        assert.strictEqual(second.text, first.text, testCase.id + ' idempotency');
    });
})();

(function testCommentedStructuralGapsAreCanonicalAndKeepBindings() {
    [
        {
            id: 'trailing-comment-before-trailing-comma',
            source: 'select a --c\n,b from t',
            options: { dialect: 'hive', commaStyle: 'trailing' },
            expected: 'SELECT\n    a --c\n    ,\n    b\nFROM t'
        },
        {
            id: 'leading-comment-after-leading-comma',
            source: 'select a,\n-- before b\nb from t',
            options: { dialect: 'hive', commaStyle: 'leading' },
            expected: 'SELECT\n      a\n    ,\n    -- before b\n      b\nFROM t'
        },
        {
            id: 'consecutive-comment-bindings',
            source: 'select a, -- tail\n/* before b */\n-- line before b\nb from t',
            options: { dialect: 'hive', commaStyle: 'leading' },
            expected: [
                'SELECT',
                '      a',
                '    , -- tail',
                '    /* before b */',
                '    -- line before b',
                '      b',
                'FROM t'
            ].join('\n')
        }
    ].forEach(function(testCase) {
        var before = analyze(testCase.source);
        var first = formatApi.formatSql(testCase.source, testCase.options);
        assert.strictEqual(first.status, 'formatted', testCase.id);
        assert.strictEqual(first.text, testCase.expected, testCase.id);
        var after = analyze(first.text);
        assert.deepStrictEqual(
            commentPlacementRows(after),
            commentPlacementRows(before),
            testCase.id + ' comment binding conservation'
        );
        var second = formatApi.formatSql(first.text, testCase.options);
        assert.strictEqual(second.status, 'unchanged', testCase.id + ' second status');
        assert.strictEqual(second.text, first.text, testCase.id + ' idempotency');
    });
})();

(function testCommentsInsideDelimitedListsDoNotLeakPartialPlans() {
    [
        {
            id: 'join-using-comment',
            source: 'select a from t join u using(/*x*/id,x)',
            expected: 'SELECT\n      a\nFROM t\nJOIN u\n    USING (/*x*/id, x)'
        },
        {
            id: 'partition-comment',
            source: 'insert overwrite table t partition(/*x*/ds=1,hr) select a from s',
            expected: [
                'INSERT OVERWRITE TABLE t',
                'PARTITION (/*x*/ds = 1, hr)',
                'SELECT',
                '      a',
                'FROM s'
            ].join('\n')
        },
        {
            id: 'cte-column-comment',
            source: 'with a(/*x*/c,d) as (select 1) select c from a',
            expected: [
                'WITH',
                '      a(/*x*/c, d) AS (',
                '          SELECT 1',
                '      )',
                'SELECT',
                '      c',
                'FROM a'
            ].join('\n')
        }
    ].forEach(function(testCase) {
        var before = analyze(testCase.source);
        var first = formatApi.formatSql(testCase.source, { dialect: 'hive' });
        assert.strictEqual(first.status, 'formatted', testCase.id);
        assert.strictEqual(first.text, testCase.expected, testCase.id);
        assert.deepStrictEqual(
            commentPlacementRows(analyze(first.text)),
            commentPlacementRows(before),
            testCase.id + ' dangling comment binding conservation'
        );
        var second = formatApi.formatSql(first.text, { dialect: 'hive' });
        assert.strictEqual(second.status, 'unchanged', testCase.id + ' second status');
        assert.strictEqual(second.text, first.text, testCase.id + ' idempotency');
    });
})();

(function testLeadingRelationCommentsReceiveContinuationIndent() {
    [
        {
            id: 'from-leading-comment',
            source: 'select a from -- relation\nt',
            expected: 'SELECT\n      a\nFROM\n    -- relation\n    t'
        },
        {
            id: 'join-leading-comment',
            source: 'select a from t join -- relation\nu on t.id=u.id',
            expected: [
                'SELECT',
                '      a',
                'FROM t',
                'JOIN',
                '    -- relation',
                '    u',
                '    ON t.id = u.id'
            ].join('\n')
        }
    ].forEach(function(testCase) {
        var before = analyze(testCase.source);
        var first = formatApi.formatSql(testCase.source, { dialect: 'hive' });
        assert.strictEqual(first.status, 'formatted', testCase.id);
        assert.strictEqual(first.text, testCase.expected, testCase.id);
        assert.deepStrictEqual(
            commentPlacementRows(analyze(first.text)),
            commentPlacementRows(before),
            testCase.id + ' comment binding conservation'
        );
        assert.strictEqual(
            formatApi.formatSql(first.text, { dialect: 'hive' }).status,
            'unchanged',
            testCase.id + ' idempotency'
        );
    });
})();

(function testMultilineListMembersDoNotAccumulateScopeIndent() {
    [
        {
            id: 'intrinsic-expression-line-break',
            source: 'select a\n + b from t',
            expected: 'SELECT\n      a + b\nFROM t'
        },
        {
            id: 'intrinsic-expression-comment-line-break',
            source: 'select q -- member\n . a from t',
            expected: 'SELECT\n      q -- member\n      .a\nFROM t'
        },
        {
            id: 'intrinsic-expression-crlf',
            source: 'select a\r\n + b from t',
            expected: 'SELECT\n      a + b\nFROM t'
        },
        {
            id: 'named-window-member-comment-line-break',
            source: 'select a from t window w as (partition -- member\n by a)',
            expected: [
                'SELECT',
                '      a',
                'FROM t',
                'WINDOW',
                '      w AS (PARTITION -- member',
                '      BY a)'
            ].join('\n')
        }
    ].forEach(function(testCase) {
        var before = analyze(testCase.source);
        var first = formatApi.formatSql(testCase.source, { dialect: 'hive' });
        assert.strictEqual(first.status, 'formatted', testCase.id);
        assert.strictEqual(first.text, testCase.expected, testCase.id);
        assert.deepStrictEqual(
            commentPlacementRows(analyze(first.text)),
            commentPlacementRows(before),
            testCase.id + ' comment binding conservation'
        );
        var second = formatApi.formatSql(first.text, { dialect: 'hive' });
        assert.strictEqual(second.status, 'unchanged', testCase.id + ' second status');
        assert.strictEqual(second.text, first.text, testCase.id + ' idempotency');
    });
})();

(function testEveryIndentScopeCanonicalizesOwnedRawNewlines() {
    [
        {
            id: 'join-on-line-break',
            source: 'select * from a join b on a.id\n = b.id',
            expected: [
                'SELECT',
                '      *',
                'FROM a',
                'JOIN b',
                '    ON a.id = b.id'
            ].join('\n')
        },
        {
            id: 'join-on-comment-line-break',
            source: 'select * from a join b on a.id -- join\n = b.id',
            expected: [
                'SELECT',
                '      *',
                'FROM a',
                'JOIN b',
                '    ON a.id -- join',
                '    = b.id'
            ].join('\n')
        },
        {
            id: 'join-on-crlf',
            source: 'select * from a join b on a.id\r\n = b.id',
            expected: [
                'SELECT',
                '      *',
                'FROM a',
                'JOIN b',
                '    ON a.id = b.id'
            ].join('\n')
        },
        {
            id: 'parenthesized-query-line-break',
            source: 'select * from (select a from t where a\n =1) q',
            expected: [
                'SELECT',
                '      *',
                'FROM (',
                '    SELECT',
                '          a',
                '    FROM t',
                '    WHERE a = 1',
                ') q'
            ].join('\n')
        },
        {
            id: 'nested-cte-query-line-break',
            source: 'with q as (select a from t where a\n =1) select * from q',
            expected: [
                'WITH',
                '      q AS (',
                '          SELECT',
                '                a',
                '          FROM t',
                '          WHERE a = 1',
                '      )',
                'SELECT',
                '      *',
                'FROM q'
            ].join('\n')
        }
    ].forEach(function(testCase) {
        var before = analyze(testCase.source);
        var first = formatApi.formatSql(testCase.source, { dialect: 'hive' });
        assert.strictEqual(first.status, 'formatted', testCase.id);
        assert.strictEqual(first.text, testCase.expected, testCase.id);
        assert.deepStrictEqual(
            commentPlacementRows(analyze(first.text)),
            commentPlacementRows(before),
            testCase.id + ' comment binding conservation'
        );
        var second = formatApi.formatSql(first.text, { dialect: 'hive' });
        assert.strictEqual(second.status, 'unchanged', testCase.id + ' second status');
        assert.strictEqual(second.text, first.text, testCase.id + ' idempotency');
    });
})();

console.log('v2 Wave 3C Hive query layout tests passed');
