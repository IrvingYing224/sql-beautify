'use strict';

var assert = require('assert');
var analysisApi = require('../../.tmp/v2-core/core/analysis/index.js');
var compilerApi = require('../../.tmp/v2-core/core/layout/compiler.js');
var optionsApi = require('../../.tmp/v2-core/core/config/resolve-options.js');
var planApi = require('../../.tmp/v2-core/core/layout/plan.js');
var policyApi = require('../../.tmp/v2-core/core/layout/policy.js');
var claimsApi = require('../../.tmp/v2-core/core/layout/verbatim-claims.js');
var renderApi = require('../../.tmp/v2-core/core/renderer/render.js');

function analyze(source) {
    var result = analysisApi.analyzeSql(source, {
        dialect: 'hive',
        mode: 'document'
    });
    assert.strictEqual(result.status, 'analyzed');
    return result;
}

function options() {
    var result = optionsApi.resolveFormatOptions({ dialect: 'hive' });
    assert.strictEqual(result.ok, true);
    return result.options;
}

(function testNestedIndentAndAlignScopesCompileCanonically() {
    var analysis = analyze('select 1');
    var queryId = analysis.index.queries()[0].id;
    var builder = planApi.createLayoutPlanBuilder(analysis, options());
    assert.ok(builder);
    assert.strictEqual(builder.setKeywordCase(queryId, 0), true);
    assert.strictEqual(builder.replaceGap(queryId, 1, 2, {
        kind: 'hard-line'
    }), true);
    assert.strictEqual(builder.wrapRange(queryId, 1, 3, {
        kind: 'indent',
        levels: 1
    }), true);
    assert.strictEqual(builder.wrapRange(queryId, 1, 3, {
        kind: 'align',
        columns: 2
    }), true);

    var built = builder.finish();
    assert.strictEqual(built.ok, true);
    assert.strictEqual(Object.isFrozen(built.plan.scopeStarts), true);
    assert.strictEqual(Object.isFrozen(built.plan.scopeEnds), true);
    var compiled = compilerApi.compileLayoutPlan(built.plan);
    assert.strictEqual(compiled.ok, true);
    assert.strictEqual(built.plan.statistics.scopeActionCount, 2);
    assert.strictEqual(compiled.statistics.scopeActionVisitCount, 4);
    var rendered = renderApi.renderLayoutArtifact(compiled.artifact);
    assert.strictEqual(rendered.ok, true);
    assert.strictEqual(rendered.text, 'SELECT\n      1');
})();

(function testGroupFamilyConflictIsRegistrationOrderIndependent() {
    [false, true].forEach(function(reverse) {
        var analysis = analyze('select 1');
        var queryId = analysis.index.queries()[0].id;
        var builder = planApi.createLayoutPlanBuilder(analysis, options());
        var decisions = [
            { kind: 'group', mode: 'break' },
            { kind: 'auto-group', maxFlatWidth: 80 }
        ];
        if (reverse) {
            decisions.reverse();
        }
        assert.strictEqual(builder.wrapRange(queryId, 0, 3, decisions[0]), true);
        assert.strictEqual(builder.wrapRange(queryId, 0, 3, decisions[1]), false);
        var result = builder.finish();
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.code, 'LAYOUT_PLAN_CONFLICT');
    });
})();

(function testCrossingScopesFailAtFinalizationIndependentOfRegistrationOrder() {
    [false, true].forEach(function(reverse) {
        var analysis = analyze('select 1+2');
        var queryId = analysis.index.queries()[0].id;
        var builder = planApi.createLayoutPlanBuilder(analysis, options());
        var actions = [
            function() {
                return builder.wrapRange(queryId, 1, 4, {
                    kind: 'indent',
                    levels: 1
                });
            },
            function() {
                return builder.wrapRange(queryId, 3, 5, {
                    kind: 'align',
                    columns: 1
                });
            }
        ];
        if (reverse) {
            actions.reverse();
        }
        assert.strictEqual(actions[0](), true);
        assert.strictEqual(actions[1](), true);
        var result = builder.finish();
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.code, 'LAYOUT_PLAN_SCOPE');
    });
})();

(function testScopeCannotCutAtomicClaimOrHideInsideReplacedGap() {
    var analysis = analyze('select f(1)+2');
    var queryId = analysis.index.queries()[0].id;
    var functionLeafId = analysis.leaves.filter(function(leaf) {
        return leaf.raw === 'f';
    })[0].id;
    var claim = claimsApi.dominatingVerbatimClaims(analysis)
        .claimForLeaf(functionLeafId);
    assert.ok(claim);
    var cutBuilder = planApi.createLayoutPlanBuilder(analysis, options());
    assert.strictEqual(cutBuilder.wrapRange(
        queryId,
        claim.leafRange.start + 1,
        claim.leafRange.end,
        { kind: 'indent', levels: 1 }
    ), false);
    assert.strictEqual(cutBuilder.finish().code, 'LAYOUT_PLAN_DOMINATED');

    var gapAnalysis = analyze('select \n 1');
    var gapQueryId = gapAnalysis.index.queries()[0].id;
    var gapBuilder = planApi.createLayoutPlanBuilder(gapAnalysis, options());
    var itemStart = gapAnalysis.index.queries()[0].children[0].children[0]
        .children[0].leafRange.start;
    assert.ok(itemStart > 2);
    assert.strictEqual(gapBuilder.wrapRange(
        gapQueryId,
        2,
        itemStart,
        { kind: 'indent', levels: 1 }
    ), true);
    assert.strictEqual(gapBuilder.replaceGap(
        gapQueryId,
        1,
        itemStart,
        { kind: 'hard-line' }
    ), true);
    var hidden = gapBuilder.finish();
    assert.strictEqual(hidden.ok, false);
    assert.strictEqual(hidden.code, 'LAYOUT_PLAN_CONFLICT');

    var reverseBuilder = planApi.createLayoutPlanBuilder(
        gapAnalysis,
        options()
    );
    assert.strictEqual(reverseBuilder.replaceGap(
        gapQueryId,
        1,
        itemStart,
        { kind: 'hard-line' }
    ), true);
    assert.strictEqual(reverseBuilder.wrapRange(
        gapQueryId,
        2,
        itemStart,
        { kind: 'indent', levels: 1 }
    ), false, 'gap-first registration must reject a hidden scope boundary');
    assert.strictEqual(reverseBuilder.finish().code, 'LAYOUT_PLAN_CONFLICT');
})();

(function testDecisionSnapshotAndDuplicateTouchingContract() {
    [
        new Proxy({ kind: 'indent', levels: 1 }, {}),
        Object.defineProperty({ kind: 'indent' }, 'levels', {
            enumerable: true,
            get: function() { return 1; }
        }),
        { kind: 'indent', levels: 0 },
        { kind: 'align', columns: Infinity }
    ].forEach(function(decision) {
        var analysis = analyze('select 1');
        var queryId = analysis.index.queries()[0].id;
        var builder = planApi.createLayoutPlanBuilder(analysis, options());
        assert.strictEqual(builder.wrapRange(queryId, 0, 1, decision), false);
        assert.strictEqual(builder.finish().code, 'LAYOUT_PLAN_SCOPE');
    });

    var stable = analyze('select 1');
    var stableQueryId = stable.index.queries()[0].id;
    var stableBuilder = planApi.createLayoutPlanBuilder(stable, options());
    var indent = { kind: 'indent', levels: 1 };
    assert.strictEqual(stableBuilder.wrapRange(stableQueryId, 0, 1, indent), true);
    assert.strictEqual(stableBuilder.wrapRange(stableQueryId, 0, 1, indent), true,
        'exact duplicate scope registration must be idempotent');
    assert.strictEqual(stableBuilder.wrapRange(
        stableQueryId,
        1,
        stable.leaves.length,
        { kind: 'align', columns: 1 }
    ), true, 'touching sibling scopes are canonical');
    var stablePlan = stableBuilder.finish();
    assert.strictEqual(stablePlan.ok, true);
    assert.strictEqual(stablePlan.plan.statistics.scopeActionCount, 2);
    var stableCompiled = compilerApi.compileLayoutPlan(stablePlan.plan);
    assert.strictEqual(stableCompiled.ok, true);
    assert.strictEqual(stableCompiled.statistics.scopeActionVisitCount, 4);
})();

(function testCompleteVerbatimClaimCanBeWrappedWithoutDuplicateEmission() {
    var analysis = analyze('select f(1)');
    var queryId = analysis.index.queries()[0].id;
    var functionLeafId = analysis.leaves.find(function(leaf) {
        return leaf.raw === 'f';
    }).id;
    var claim = claimsApi.dominatingVerbatimClaims(analysis)
        .claimForLeaf(functionLeafId);
    assert.ok(claim);
    var builder = planApi.createLayoutPlanBuilder(analysis, options());
    assert.strictEqual(builder.wrapRange(
        queryId,
        claim.leafRange.start,
        claim.leafRange.end,
        { kind: 'group', mode: 'break' }
    ), true);
    var built = builder.finish();
    assert.strictEqual(built.ok, true);
    var compiled = compilerApi.compileLayoutPlan(built.plan);
    assert.strictEqual(compiled.ok, true);
    assert.strictEqual(compiled.statistics.scopeActionVisitCount, 2);
    var rendered = renderApi.renderLayoutArtifact(compiled.artifact);
    assert.strictEqual(rendered.ok, true);
    assert.strictEqual(rendered.text, analysis.source);
})();

(function testPolicyStatisticsAreSnapshottedAndBudgetedFailClosed() {
    var analysis = analyze('select 1');
    var validBuilder = planApi.createLayoutPlanBuilder(analysis, options());
    var valid = validBuilder.finish({
        nodeVisitCount: 3,
        leafVisitCount: 4,
        directLookupCount: 5
    });
    assert.strictEqual(valid.ok, true);
    assert.strictEqual(valid.plan.statistics.policyNodeVisitCount, 3);
    assert.strictEqual(valid.plan.statistics.policyLeafVisitCount, 4);
    assert.strictEqual(valid.plan.statistics.policyDirectLookupCount, 5);
    assert.strictEqual(Object.isFrozen(valid.plan.statistics), true);

    [
        new Proxy({
            nodeVisitCount: 1,
            leafVisitCount: 1,
            directLookupCount: 1
        }, {}),
        {
            nodeVisitCount: -1,
            leafVisitCount: 0,
            directLookupCount: 0
        },
        {
            nodeVisitCount: analysis.leaves.length,
            leafVisitCount: analysis.leaves.length,
            directLookupCount: Number.MAX_SAFE_INTEGER
        },
        {
            nodeVisitCount: 1,
            leafVisitCount: 1,
            directLookupCount: 1,
            hiddenWork: 1
        },
        Object.defineProperty({
            nodeVisitCount: 1,
            leafVisitCount: 1
        }, 'directLookupCount', {
            enumerable: true,
            get: function() { return 1; }
        })
    ].forEach(function(value) {
        var builder = planApi.createLayoutPlanBuilder(analysis, options());
        var rejected = builder.finish(value);
        assert.strictEqual(rejected.ok, false);
        assert.strictEqual(rejected.code, 'LAYOUT_PLAN_RESOURCE');
    });
})();

(function testIncompletePolicyCannotExposePreviouslyRegisteredActions() {
    var analysis = analyze('select 1');
    var queryId = analysis.index.queries()[0].id;
    var builder = planApi.createLayoutPlanBuilder(analysis, options());
    assert.ok(builder);
    assert.strictEqual(builder.setKeywordCase(queryId, 0), true,
        'probe must register a valid action before the later policy failure');
    var rejected = policyApi.finalizeLayoutPolicyApplication(builder, null);
    assert.strictEqual(rejected.ok, false);
    assert.strictEqual(rejected.code, 'LAYOUT_PLAN_PROVENANCE');
    assert.strictEqual(rejected.plan, undefined,
        'incomplete policy must not expose its otherwise valid partial plan');
    assert.strictEqual(rejected.text, undefined,
        'layout failure must not expose partial output text');
    assert.strictEqual(rejected.sourceMap, undefined,
        'layout failure must not expose a partial source map');
})();

(function testIndentationScopeRejectsUnownedRawNewlineTrivia() {
    var analysis = analyze('select a\n + b');
    var queryId = analysis.index.queries()[0].id;
    var rejectedBuilder = planApi.createLayoutPlanBuilder(analysis, options());
    assert.strictEqual(rejectedBuilder.wrapRange(
        queryId,
        0,
        analysis.leaves.length,
        { kind: 'indent', levels: 1 }
    ), true);
    var rejected = rejectedBuilder.finish();
    assert.strictEqual(rejected.ok, false);
    assert.strictEqual(rejected.code, 'LAYOUT_PLAN_SCOPE');

    var newlineLeafId = analysis.leaves.find(function(leaf) {
        return leaf.kind === 'newline';
    }).id;
    var gapEnd = newlineLeafId + 1;
    while (gapEnd < analysis.leaves.length &&
        analysis.leaves[gapEnd].channel === 'trivia') {
        gapEnd += 1;
    }
    var acceptedBuilder = planApi.createLayoutPlanBuilder(analysis, options());
    assert.strictEqual(acceptedBuilder.replaceGap(
        queryId,
        newlineLeafId,
        gapEnd,
        { kind: 'hard-line' }
    ), true);
    assert.strictEqual(acceptedBuilder.wrapRange(
        queryId,
        0,
        analysis.leaves.length,
        { kind: 'indent', levels: 1 }
    ), true);
    assert.strictEqual(acceptedBuilder.finish().ok, true);
})();

(function testHighScopeCountRemainsDirectAddressLinear() {
    var values = [];
    for (var index = 0; index < 1200; index++) {
        values.push(String(index));
    }
    var analysis = analyze('select ' + values.join(','));
    var queryId = analysis.index.queries()[0].id;
    var list = analysis.index.lists().find(function(node) {
        return node.listRole === 'select-items';
    });
    assert.ok(list);
    var builder = planApi.createLayoutPlanBuilder(analysis, options());
    list.children.forEach(function(member) {
        assert.strictEqual(builder.wrapRange(
            queryId,
            member.leafRange.start,
            member.leafRange.end,
            { kind: 'indent', levels: 1 }
        ), true);
    });
    var built = builder.finish();
    assert.strictEqual(built.ok, true);
    assert.strictEqual(
        built.plan.statistics.scopeActionCount,
        list.children.length
    );
    var compiled = compilerApi.compileLayoutPlan(built.plan);
    assert.strictEqual(compiled.ok, true);
    assert.strictEqual(
        compiled.statistics.scopeActionVisitCount,
        list.children.length * 2
    );
    assert.ok(
        compiled.statistics.directLookupCount <= analysis.leaves.length * 4 + 8,
        'scope boundary lookup count must remain linear in leaves'
    );
})();

console.log('v2 Wave 3C canonical scope-plan tests passed');
