'use strict';

var assert = require('assert');
var analysisApi = require('../../.tmp/v2-core/core/analysis/index.js');
var formatApi = require('../../.tmp/v2-core/core/api/format.js');
var optionsApi = require('../../.tmp/v2-core/core/config/resolve-options.js');
var planApi = require('../../.tmp/v2-core/core/layout/plan.js');
var policyApi = require('../../.tmp/v2-core/core/layout/policy.js');

function repeat(value, count) {
    return new Array(count + 1).join(value);
}

function assertIdempotent(source, options) {
    var first = formatApi.formatSqlWithStatistics(source, options);
    assert.notStrictEqual(first.result.status, 'failed', 'first pass');
    var second = formatApi.formatSql(first.result.text, options);
    assert.strictEqual(second.status, 'unchanged', 'second pass');
    assert.strictEqual(second.text, first.result.text, 'strict idempotency');
    return first;
}

(function testMaximumStructuredExpressionDepthIsIterative() {
    var parenthesized = 'select ' + repeat('(', 255) + 'x' + repeat(')', 255);
    var prefix = 'select ' + repeat('not ', 255) + 'x';
    [parenthesized, prefix].forEach(function(source) {
        var run = assertIdempotent(source, { dialect: 'hive' });
        assert.strictEqual(run.result.status, 'formatted');
        assert.strictEqual(run.result.diagnostics.some(function(diagnostic) {
            return diagnostic.code === 'SYN_MAX_DEPTH_EXCEEDED';
        }), false);
        assert.ok(run.statistics.scopeActionVisitCount ===
            run.statistics.scopeActionCount * 2);
    });
})();

(function testDepthOverflowRemainsLocallyVerbatimAndBounded() {
    var payload = repeat('(', 256) + 'x' + repeat(')', 256);
    var source = 'select ' + payload;
    var run = assertIdempotent(source, { dialect: 'hive' });
    assert.strictEqual(run.result.status, 'formatted');
    assert.ok(run.result.diagnostics.some(function(diagnostic) {
        return diagnostic.code === 'SYN_MAX_DEPTH_EXCEEDED';
    }));
    assert.strictEqual(run.result.text.slice('SELECT '.length), payload,
        'opaque depth overflow must retain the exact expression bytes');
})();

(function testLongOperatorChainStaysLinear() {
    var source = 'select ' + new Array(2001).fill('x').join('+') + ' from t';
    var started = process.hrtime.bigint();
    var run = assertIdempotent(source, { dialect: 'hive' });
    var elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    var inputUnits = Math.max(
        1,
        run.statistics.leafCount + run.statistics.syntaxNodeCount
    );
    assert.strictEqual(run.result.status, 'formatted');
    assert.ok(elapsedMs < 1500, 'long expression exceeded the disaster gate');
    assert.ok(run.statistics.planActionCount <= run.statistics.maxPlanActions);
    assert.ok(run.statistics.policyNodeVisitCount <= inputUnits * 3 + 64);
    assert.ok(run.statistics.policyLeafVisitCount <= inputUnits * 2 + 64);
    assert.ok(run.statistics.policyDirectLookupCount <= inputUnits * 5 + 128);
    assert.ok(run.statistics.docNodeCount <= inputUnits * 2 + 64);
})();

(function testSoftLinePlanDecisionIsCanonicalAndFailClosed() {
    var source = "select case when a=1 then 'x' else 'y' end";
    var analysis = analysisApi.analyzeSql(source, {
        dialect: 'hive',
        mode: 'document'
    });
    var resolved = optionsApi.resolveFormatOptions({
        dialect: 'hive',
        caseLayout: 'compactShort',
        caseWhenThenWrapLength: 50
    });
    assert.strictEqual(analysis.status, 'analyzed');
    assert.strictEqual(resolved.ok, true);
    var planned = policyApi.buildLayoutPlan(analysis, resolved.options);
    assert.strictEqual(planned.ok, true);
    assert.ok(planned.plan.gapActions.some(function(action) {
        return action !== null && action.decision.kind === 'soft-line' &&
            action.decision.flat === 'space';
    }), 'CASE plan must compile through canonical soft lines');
    assert.ok(planned.plan.scopeStarts.some(function(actions) {
        return actions !== null && actions.some(function(action) {
            return action.decision.kind === 'auto-group' &&
                action.decision.maxFlatWidth === 50;
        });
    }), 'CASE plan must carry the renderer-owned threshold');

    var simple = analysisApi.analyzeSql('select 1', {
        dialect: 'hive',
        mode: 'document'
    });
    var simpleOptions = optionsApi.resolveFormatOptions({ dialect: 'hive' });
    assert.strictEqual(simple.status, 'analyzed');
    assert.strictEqual(simpleOptions.ok, true);
    var builder = planApi.createLayoutPlanBuilder(simple, simpleOptions.options);
    var query = simple.index.queries()[0];
    assert.ok(builder && query);
    assert.strictEqual(builder.replaceGap(query.id, 1, 2, {
        kind: 'soft-line',
        flat: 'tab'
    }), false, 'invalid soft-line flat value must poison the plan');
    var failed = builder.finish();
    assert.strictEqual(failed.ok, false);
    assert.strictEqual(failed.code, 'LAYOUT_PLAN_GAP');
})();

console.log('v2 Wave 3D expression resource closure tests passed');
