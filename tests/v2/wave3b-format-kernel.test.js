'use strict';

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var analysisApi = require('../../.tmp/v2-core/core/analysis/index.js');
var compilerApi = require('../../.tmp/v2-core/core/layout/compiler.js');
var fixtures = require('../fixtures/v2-parser-evaluation-cases');
var layoutCases = require('../fixtures/v2-layout-cases');
var formatApi = require('../../.tmp/v2-core/core/api/format.js');
var optionsApi = require('../../.tmp/v2-core/core/config/resolve-options.js');
var planApi = require('../../.tmp/v2-core/core/layout/plan.js');
var policyApi = require('../../.tmp/v2-core/core/layout/policy.js');
var renderApi = require('../../.tmp/v2-core/core/renderer/render.js');

var root = path.join(__dirname, '..', '..');

function options(input) {
    var resolved = optionsApi.resolveFormatOptions(input);
    assert.strictEqual(resolved.ok, true);
    return resolved.options;
}

function analyze(source, dialect) {
    return analysisApi.analyzeSql(source, {
        dialect: dialect,
        mode: 'document'
    });
}

function assertSafeOriginal(result, source, expectedStatus) {
    assert.strictEqual(result.status, expectedStatus);
    assert.strictEqual(result.text, source);
    assert.strictEqual(result.sourceMap, undefined,
        expectedStatus + ' must not expose a partial source map');
    assert.strictEqual(Object.isFrozen(result), true);
    assert.strictEqual(Object.isFrozen(result.diagnostics), true);
}

(function testCommittedHiveFirstGoldenCases() {
    layoutCases.forEach(function(testCase) {
        var result = formatApi.formatSql(testCase.source, testCase.options);
        assert.strictEqual(result.status, testCase.status, testCase.id);
        assert.strictEqual(result.text, testCase.expected, testCase.id);
        if (result.status === 'formatted' || result.status === 'unchanged') {
            var repeated = formatApi.formatSql(result.text, testCase.options);
            assert.strictEqual(repeated.text, result.text,
                testCase.id + ' must be idempotent');
        }
    });
})();

(function testIdentityCompilerRoundTripsTheWave0Corpus() {
    var exercised = 0;
    var exercisedIds = new Set();
    var productionCases = [
        'hive-cte-window-comments.sql',
        'hive-template-variables.sql'
    ].map(function(fileName) {
        return {
            id: 'production/' + fileName,
            dialect: 'hive',
            source: fs.readFileSync(path.join(
                root,
                'tests',
                'fixtures',
                'production-corpus',
                'public',
                fileName
            ), 'utf8')
        };
    });
    fixtures.concat(productionCases).forEach(function(testCase) {
        var artifact = analyze(testCase.source, testCase.dialect);
        if (artifact.status !== 'analyzed') {
            return;
        }
        var built = policyApi.buildIdentityLayoutPlan(
            artifact,
            options({ dialect: testCase.dialect })
        );
        assert.strictEqual(built.ok, true, testCase.id + ' identity plan');
        assert.strictEqual(planApi.isCanonicalLayoutPlan(built.plan), true);
        var compiled = compilerApi.compileLayoutPlan(built.plan);
        assert.strictEqual(compiled.ok, true, testCase.id + ' identity compile');
        var rendered = renderApi.renderLayoutArtifact(compiled.artifact);
        assert.strictEqual(rendered.ok, true, testCase.id + ' identity render');
        assert.strictEqual(rendered.text, testCase.source,
            testCase.id + ' identity source round-trip');
        assert.ok(compiled.statistics.leafVisitCount <= artifact.leaves.length + 1,
            testCase.id + ' compiler leaf visits must stay linear');
        assert.ok(compiled.statistics.directLookupCount <= artifact.leaves.length * 4 + 8,
            testCase.id + ' compiler lookups must stay linear');
        exercised += 1;
        exercisedIds.add(testCase.id);
    });
    assert.ok(exercised >= 12,
        'identity compiler must exercise Wave 0 and production-shaped Wave 2 inputs');
    productionCases.forEach(function(testCase) {
        assert.strictEqual(exercisedIds.has(testCase.id), true,
            testCase.id + ' must complete identity plan/compile/render');
    });
})();

(function testPlanConflictAndDominatingRangeFailClosed() {
    var artifact = analyze('SELECT  1', 'hive');
    assert.strictEqual(artifact.status, 'analyzed');
    var builder = planApi.createLayoutPlanBuilder(
        artifact,
        options({ dialect: 'hive' })
    );
    assert.ok(builder);
    var queryId = artifact.index.queries()[0].id;
    assert.strictEqual(builder.replaceGap(queryId, 1, 2, {
        kind: 'space',
        columns: 1
    }), true);
    assert.strictEqual(builder.replaceGap(queryId, 1, 2, {
        kind: 'hard-line'
    }), false, 'same-boundary incompatible decisions must conflict');
    var conflicted = builder.finish();
    assert.strictEqual(conflicted.ok, false);
    assert.strictEqual(conflicted.code, 'LAYOUT_PLAN_CONFLICT');
    assert.strictEqual(conflicted.plan, undefined);

    var claimedArtifact = analyze('select ${hiveconf:value}', 'hive');
    assert.strictEqual(claimedArtifact.status, 'analyzed');
    var claimedBuilder = planApi.createLayoutPlanBuilder(
        claimedArtifact,
        options({ dialect: 'hive' })
    );
    assert.ok(claimedBuilder);
    var claimedQueryId = claimedArtifact.index.queries()[0].id;
    var functionLeafId = claimedArtifact.leaves.find(function(leaf) {
        return leaf.raw === '${hiveconf:value}';
    }).id;
    assert.strictEqual(
        claimedBuilder.setKeywordCase(claimedQueryId, functionLeafId),
        false,
        'dominating unformatted expression must reject descendant actions'
    );
    var dominated = claimedBuilder.finish();
    assert.strictEqual(dominated.ok, false);
    assert.strictEqual(dominated.code, 'LAYOUT_PLAN_DOMINATED');
})();

(function testBoundaryInsertionDeletionAndAuthorityAreCanonical() {
    var adjacent = analyze('select 1+2', 'hive');
    assert.strictEqual(adjacent.status, 'analyzed');
    var adjacentQueryId = adjacent.index.queries()[0].id;
    var adjacentBuilder = planApi.createLayoutPlanBuilder(
        adjacent,
        options({ dialect: 'hive' })
    );
    var plusLeafId = adjacent.leaves.filter(function(leaf) {
        return leaf.raw === '+';
    })[0].id;
    var rightLeafId = adjacent.leaves.filter(function(leaf) {
        return leaf.raw === '2';
    })[0].id;
    assert.strictEqual(adjacentBuilder.replaceGap(
        adjacentQueryId,
        plusLeafId,
        plusLeafId,
        { kind: 'space', columns: 1 }
    ), true, 'zero-width boundary before an operator must accept insertion');
    assert.strictEqual(adjacentBuilder.replaceGap(
        adjacentQueryId,
        rightLeafId,
        rightLeafId,
        { kind: 'space', columns: 1 }
    ), true, 'zero-width boundary after an operator must accept insertion');
    var adjacentPlan = adjacentBuilder.finish();
    assert.strictEqual(adjacentPlan.ok, true);
    var adjacentCompiled = compilerApi.compileLayoutPlan(adjacentPlan.plan);
    assert.strictEqual(adjacentCompiled.ok, true);
    assert.strictEqual(
        renderApi.renderLayoutArtifact(adjacentCompiled.artifact).text,
        'select 1 + 2'
    );

    var aroundClaim = analyze('select ${hiveconf:value}+2', 'hive');
    assert.strictEqual(aroundClaim.status, 'analyzed');
    var aroundQueryId = aroundClaim.index.queries()[0].id;
    var aroundBuilder = planApi.createLayoutPlanBuilder(
        aroundClaim,
        options({ dialect: 'hive' })
    );
    var functionStart = aroundClaim.leaves.filter(function(leaf) {
        return leaf.raw === '${hiveconf:value}';
    })[0].id;
    var afterFunction = aroundClaim.leaves.filter(function(leaf) {
        return leaf.raw === '+';
    })[0].id;
    assert.strictEqual(aroundBuilder.replaceGap(
        aroundQueryId,
        functionStart,
        functionStart,
        { kind: 'space', columns: 1 }
    ), true);
    assert.strictEqual(aroundBuilder.replaceGap(
        aroundQueryId,
        afterFunction,
        afterFunction,
        { kind: 'space', columns: 1 }
    ), true);
    var aroundPlan = aroundBuilder.finish();
    assert.strictEqual(aroundPlan.ok, true);
    var aroundCompiled = compilerApi.compileLayoutPlan(aroundPlan.plan);
    assert.strictEqual(aroundCompiled.ok, true);
    assert.strictEqual(
        renderApi.renderLayoutArtifact(aroundCompiled.artifact).text,
        'select  ${hiveconf:value} +2',
        'actions on both sides of a verbatim claim must be emitted'
    );

    var spaced = analyze('select 1 + 2', 'hive');
    assert.strictEqual(spaced.status, 'analyzed');
    var spacedQueryId = spaced.index.queries()[0].id;
    var spacedBuilder = planApi.createLayoutPlanBuilder(
        spaced,
        options({ dialect: 'hive' })
    );
    var plusId = spaced.leaves.filter(function(leaf) {
        return leaf.raw === '+';
    })[0].id;
    var twoId = spaced.leaves.filter(function(leaf) {
        return leaf.raw === '2';
    })[0].id;
    assert.strictEqual(spacedBuilder.replaceGap(
        spacedQueryId,
        plusId - 1,
        plusId,
        { kind: 'empty' }
    ), true);
    assert.strictEqual(spacedBuilder.replaceGap(
        spacedQueryId,
        twoId - 1,
        twoId,
        { kind: 'empty' }
    ), true);
    var emptyPlan = spacedBuilder.finish();
    assert.strictEqual(emptyPlan.ok, true);
    var emptyCompiled = compilerApi.compileLayoutPlan(emptyPlan.plan);
    assert.strictEqual(emptyCompiled.ok, true);
    assert.strictEqual(
        renderApi.renderLayoutArtifact(emptyCompiled.artifact).text,
        'select 1+2'
    );

    var leading = analyze('\nselect 1', 'hive');
    assert.strictEqual(leading.status, 'analyzed');
    var leadingQueryId = leading.index.queries()[0].id;
    var outsideBuilder = planApi.createLayoutPlanBuilder(
        leading,
        options({ dialect: 'hive' })
    );
    assert.strictEqual(outsideBuilder.replaceGap(
        leadingQueryId,
        0,
        1,
        { kind: 'space', columns: 1 }
    ), false, 'query-external leading trivia must lack formatted authority');
    var outside = outsideBuilder.finish();
    assert.strictEqual(outside.ok, false);
    assert.strictEqual(outside.code, 'LAYOUT_PLAN_AUTHORITY');
})();

(function testHiveNoFromFormattingAndContextualKeywordProof() {
    var minimal = formatApi.formatSql('select    1', { dialect: 'hive' });
    assert.strictEqual(minimal.status, 'formatted');
    assert.strictEqual(minimal.text, 'SELECT 1');
    assert.deepStrictEqual(minimal.sourceMap.entries, [
        { source: { start: 0, end: 6 }, output: { start: 0, end: 6 } },
        { source: { start: 10, end: 11 }, output: { start: 7, end: 8 } }
    ], 'generated SELECT gap must remain unmapped');

    var adjacent = formatApi.formatSql('select(1)', { dialect: 'hive' });
    assert.strictEqual(adjacent.status, 'formatted');
    assert.strictEqual(adjacent.text, 'SELECT (1)',
        'formatted SELECT head/body spacing must not depend on source trivia');

    var upper = formatApi.formatSql('select    window as order', {
        dialect: 'hive',
        keywordCase: 'upper'
    });
    assert.strictEqual(upper.status, 'formatted');
    assert.strictEqual(upper.text, 'SELECT window AS order');
    assert.strictEqual(Object.isFrozen(upper.sourceMap), true);
    assert.strictEqual(Object.isFrozen(upper.sourceMap.entries), true);
    assert.ok(upper.sourceMap.entries.length >= 2,
        'generated replacement whitespace must create a source-map gap');

    var lower = formatApi.formatSql('SELECT    WINDOW AS ORDER', {
        dialect: 'hive',
        keywordCase: 'lower'
    });
    assert.strictEqual(lower.status, 'formatted');
    assert.strictEqual(lower.text, 'select WINDOW as ORDER',
        'keyword-shaped identifier and alias bytes must stay exact');

    var second = formatApi.formatSql(upper.text, {
        dialect: 'hive',
        keywordCase: 'upper'
    });
    assert.strictEqual(second.status, 'unchanged');
    assert.strictEqual(second.text, upper.text,
        'Hive no-FROM baseline must be idempotent after one pass');
})();

(function testProtectedCommentsAndFinalNewlineStayExact() {
    [
        {
            source: "select    'from  WHERE' -- keep  bytes",
            expected: "SELECT 'from  WHERE' -- keep  bytes"
        },
        {
            source: 'select    1 /* keep  FROM */\n',
            expected: 'SELECT 1 /* keep  FROM */\n'
        },
        {
            source: 'select 1 /*a*/ /*b*/',
            expected: 'SELECT 1 /*a*/ /*b*/'
        },
        {
            source: 'select 1 /*a\r\nb*/ + 2',
            expected: 'SELECT 1 /*a\r\nb*/ + 2'
        },
        {
            source: 'select\r\n1\r\n',
            expected: 'SELECT 1\r\n'
        }
    ].forEach(function(testCase) {
        var result = formatApi.formatSql(testCase.source, { dialect: 'hive' });
        assert.strictEqual(result.status, 'formatted');
        assert.strictEqual(result.text, testCase.expected);
        var repeated = formatApi.formatSql(result.text, { dialect: 'hive' });
        assert.strictEqual(repeated.text, result.text);
    });

    ['document', 'statement', 'fragment'].forEach(function(mode) {
        var without = formatApi.formatSql('select  1', { dialect: 'hive' }, mode);
        var withLf = formatApi.formatSql('select  1\n', { dialect: 'hive' }, mode);
        assert.strictEqual(without.text, 'SELECT 1',
            mode + ' without final LF');
        assert.strictEqual(withLf.text, 'SELECT 1\n',
            mode + ' with final LF');

        var eofComment = formatApi.formatSql(
            'select  1 -- keep EOF',
            { dialect: 'hive' },
            mode
        );
        assert.strictEqual(eofComment.status, 'formatted', mode + ' EOF comment');
        assert.strictEqual(eofComment.text, 'SELECT 1 -- keep EOF',
            mode + ' EOF comment must not manufacture a final LF');
    });
})();

(function testUnformattedDialectsRemainIdentityAndHiveQueriesUseWave3C() {
    ['generic', 'postgresql', 'mysql'].forEach(function(dialect) {
        var result = formatApi.formatSql('select    1', {
            dialect: dialect,
            keywordCase: 'upper'
        });
        assert.strictEqual(result.status, 'unchanged', dialect);
        assert.strictEqual(result.text, 'select    1', dialect);
    });

    var from = formatApi.formatSql('select    a from t', {
        dialect: 'hive',
        keywordCase: 'upper'
    });
    assert.strictEqual(from.status, 'formatted');
    assert.strictEqual(from.text, 'SELECT\n      a\nFROM t');

    [
        '(select     1)',
        'WITH q AS (select  1) select  2',
        'select  1 UNION select  2',
        'select  1;\nselect  2'
    ].forEach(function(source) {
        var wrapped = formatApi.formatSql(source, { dialect: 'hive' });
        assert.strictEqual(wrapped.status, 'formatted', source);
        var repeated = formatApi.formatSql(wrapped.text, { dialect: 'hive' });
        assert.strictEqual(repeated.status, 'unchanged', source);
        assert.strictEqual(repeated.text, wrapped.text, source);
    });

    var formattedChild = formatApi.formatSql('select     f(  1 )', {
        dialect: 'hive'
    });
    assert.strictEqual(formattedChild.status, 'formatted');
    assert.strictEqual(formattedChild.text, 'SELECT f(1)',
        'function-call child must use Wave 3D delimiter spacing');
})();

(function testPreservedAndFailedNeverLeakPartialOutput() {
    var malformed = "SELECT 'unterminated";
    assertSafeOriginal(
        formatApi.formatSql(malformed, { dialect: 'hive' }),
        malformed,
        'preserved'
    );

    var unsupported = 'SELECT * FROM t QUALIFY row_number() OVER () = 1';
    assertSafeOriginal(
        formatApi.formatSql(unsupported, {
            dialect: 'hive',
            unsupportedSyntaxPolicy: 'bail_out'
        }),
        unsupported,
        'preserved'
    );

    var proxy = new Proxy({ dialect: 'hive' }, {});
    assertSafeOriginal(
        formatApi.formatSql('select  1', proxy),
        'select  1',
        'failed'
    );
    assertSafeOriginal(
        formatApi.formatSql('select  1', { dialect: 'hive' }, 'invalid-mode'),
        'select  1',
        'failed'
    );
})();

(function testCanonicalPlanCannotBeClonedIntoCompiler() {
    var artifact = analyze('SELECT 1', 'hive');
    assert.strictEqual(artifact.status, 'analyzed');
    var built = policyApi.buildIdentityLayoutPlan(
        artifact,
        options({ dialect: 'hive' })
    );
    assert.strictEqual(built.ok, true);
    var rejected = compilerApi.compileLayoutPlan(Object.assign({}, built.plan));
    assert.strictEqual(rejected.ok, false);
    assert.strictEqual(rejected.artifact, undefined);
})();

(function testInternalStatisticsRemainLinearAndFrozen() {
    var terms = [];
    for (var index = 0; index < 1200; index++) {
        terms.push(String(index));
    }
    var source = 'select  ' + terms.join(', ');
    var run = formatApi.formatSqlWithStatistics(source, { dialect: 'hive' });
    assert.strictEqual(run.result.status, 'formatted');
    assert.strictEqual(Object.isFrozen(run), true);
    assert.strictEqual(Object.isFrozen(run.statistics), true);
    var inputUnits = run.statistics.leafCount + run.statistics.syntaxNodeCount;
    assert.ok(run.statistics.leafVisitCount <= inputUnits * 8 + 64);
    assert.ok(run.statistics.leafEmissionCount <= run.statistics.leafCount + 1);
    assert.ok(run.statistics.directLookupCount <= inputUnits * 12 + 128);
    assert.ok(run.statistics.planActionCount <= run.statistics.maxPlanActions);
    assert.ok(run.statistics.policyNodeVisitCount <= inputUnits * 4 + 64);
    assert.ok(run.statistics.policyLeafVisitCount <= inputUnits * 4 + 64);
    assert.ok(run.statistics.policyDirectLookupCount <= inputUnits * 8 + 128);
})();

console.log('v2 Wave 3B format kernel tests passed');
