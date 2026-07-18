'use strict';

var assert = require('assert');
var analysisApi = require('../../.tmp/v2-core/core/analysis/index.js');
var alignmentApi = require('../../.tmp/v2-core/core/layout/alignment-policy.js');
var compilerApi = require('../../.tmp/v2-core/core/layout/compiler.js');
var formatApi = require('../../.tmp/v2-core/core/api/format.js');
var lexerApi = require('../../.tmp/v2-core/core/lexer/lossless-lexer.js');
var optionsApi = require('../../.tmp/v2-core/core/config/resolve-options.js');
var planApi = require('../../.tmp/v2-core/core/layout/plan.js');
var policyApi = require('../../.tmp/v2-core/core/layout/policy.js');
var rendererApi = require('../../.tmp/v2-core/core/renderer/render.js');

function format(source, extra) {
    return formatApi.formatSql(source, Object.assign({ dialect: 'hive' }, extra));
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

function assertStable(id, source, options, expected) {
    var first = format(source, options);
    assert.strictEqual(first.status, 'formatted', id);
    assert.strictEqual(first.text, expected, id);
    assert.deepStrictEqual(
        protectedRows(first.text, options && options.dialect),
        protectedRows(source, options && options.dialect),
        id + ' protected/comment bytes'
    );
    var second = format(first.text, options);
    assert.strictEqual(second.status, 'unchanged', id + ' repeat');
    assert.strictEqual(second.text, first.text, id + ' idempotency');
}

(function testAliasAndTrailingCommentAlignmentUseRendererColumns() {
    assertStable(
        'alias-alignment',
        'select a as x, long_name as y from t',
        {},
        [
            'SELECT',
            '      a         AS x',
            '    , long_name AS y',
            'FROM t'
        ].join('\n')
    );
    assertStable(
        'trailing-comment-alignment',
        'select a --x\n, long_name --y\nfrom t',
        {},
        [
            'SELECT',
            '      a         --x',
            '    , long_name --y',
            'FROM t'
        ].join('\n')
    );
    assertStable(
        'alias-and-comment-alignment',
        'select a as x --one\n, longer as y --two\nfrom t',
        {},
        [
            'SELECT',
            '      a      AS x --one',
            '    , longer AS y --two',
            'FROM t'
        ].join('\n')
    );
})();

(function testMaximumWidthBoundaryIsStrict() {
    var source = 'select a as x, long_name as y from t';
    assert.strictEqual(format(source, { maxAlignWidth: 16 }).text, [
        'SELECT',
        '      a AS x',
        '    , long_name AS y',
        'FROM t'
    ].join('\n'));
    assert.strictEqual(format(source, { maxAlignWidth: 17 }).text, [
        'SELECT',
        '      a         AS x',
        '    , long_name AS y',
        'FROM t'
    ].join('\n'));
})();

(function testUnicodeAndTabDisplayWidthsShareRendererMetrics() {
    assertStable(
        'cjk-width',
        'select `\u540d\u5b57` as x, abc as y from t',
        {},
        [
            'SELECT',
            '      `\u540d\u5b57` AS x',
            '    , abc    AS y',
            'FROM t'
        ].join('\n')
    );
    assertStable(
        'emoji-width',
        "select '\ud83d\udc4d' as x, abc as y from t",
        {},
        [
            'SELECT',
            "      '\ud83d\udc4d' AS x",
            '    , abc  AS y',
            'FROM t'
        ].join('\n')
    );
    assertStable(
        'tab-indent-width',
        'select a as x, longer as y from t',
        { indentStyle: 'tab' },
        [
            'SELECT',
            '\t  a      AS x',
            '\t, longer AS y',
            'FROM t'
        ].join('\n')
    );
})();

(function testMultilineRowsTerminateIndependentGroups() {
    var source = [
        'select a as x, longer as y,',
        'case when b=1 then 1 else 2 end as middle,',
        'c as z, widest_name as q from t'
    ].join(' ');
    assertStable(
        'multiline-group-termination',
        source,
        {},
        [
            'SELECT',
            '      a      AS x',
            '    , longer AS y',
            '    , CASE',
            '        WHEN b = 1 THEN 1',
            '        ELSE 2',
            '    END AS middle',
            '    , c           AS z',
            '    , widest_name AS q',
            'FROM t'
        ].join('\n')
    );
    assertStable(
        'multiline-protected-leaf-terminates-group',
        'select a as `x\ny`, longer_name as z from t',
        {},
        [
            'SELECT',
            '      a AS `x\ny`',
            '    , longer_name AS z',
            'FROM t'
        ].join('\n')
    );
})();

(function testPhysicalTriviaLinesTerminateAlignmentGroups() {
    assertStable(
        'blank-line-group-termination',
        'select a as x,\n\nlonger_name as y from t',
        { commaStyle: 'trailing' },
        [
            'SELECT',
            '    a AS x,',
            '',
            '    longer_name AS y',
            'FROM t'
        ].join('\n')
    );
    assertStable(
        'independent-comment-line-group-termination',
        'select a as x,\n/* keep */\nlonger_name as y from t',
        { commaStyle: 'trailing' },
        [
            'SELECT',
            '    a AS x,',
            '    /* keep */',
            '    longer_name AS y',
            'FROM t'
        ].join('\n')
    );
})();

(function testNoEligibleGroupDoesNotCreateBehaviorDrift() {
    assertStable(
        'single-alias-no-group',
        'select a as x from t',
        {},
        ['SELECT', '      a AS x', 'FROM t'].join('\n')
    );
})();

(function testAlignmentPlanProvenanceAndPadDecisionFailClosed() {
    var source = 'select a as x, longer as y from t';
    var analysis = analysisApi.analyzeSql(source, {
        dialect: 'hive',
        mode: 'document'
    });
    var resolved = optionsApi.resolveFormatOptions({ dialect: 'hive' });
    assert.strictEqual(analysis.status, 'analyzed');
    assert.strictEqual(resolved.ok, true);

    var base = policyApi.buildLayoutPlan(analysis, resolved.options);
    assert.strictEqual(base.ok, true);
    var compiled = compilerApi.compileLayoutPlan(base.plan);
    assert.strictEqual(compiled.ok, true);
    var rendered = rendererApi.renderLayoutArtifact(compiled.artifact);
    assert.strictEqual(rendered.ok, true);
    var alignment = alignmentApi.deriveLayoutAlignmentPlan(
        analysis,
        resolved.options,
        rendered
    );
    assert.ok(alignment);
    assert.strictEqual(
        alignmentApi.isCanonicalLayoutAlignmentPlan(
            alignment,
            analysis,
            resolved.options
        ),
        true
    );
    assert.ok(Object.isFrozen(alignment) && Object.isFrozen(alignment.targets));
    assert.ok(alignment.targets.length > 0);
    var aligned = policyApi.buildLayoutPlan(
        analysis,
        resolved.options,
        alignment
    );
    assert.strictEqual(aligned.ok, true);
    assert.ok(aligned.plan.gapActions.some(function(action) {
        return action && action.decision.kind === 'pad-to-column';
    }));
    var alignedCompiled = compilerApi.compileLayoutPlan(aligned.plan);
    assert.strictEqual(alignedCompiled.ok, true);
    var alignedRendered = rendererApi.renderLayoutArtifact(
        alignedCompiled.artifact
    );
    assert.strictEqual(alignedRendered.ok, true);
    var pipeline = formatApi.formatSqlWithStatistics(source, {
        dialect: 'hive'
    });
    assert.strictEqual(pipeline.result.text, alignedRendered.text);
    assert.strictEqual(
        pipeline.statistics.planActionCount,
        aligned.plan.statistics.actionCount
    );
    assert.strictEqual(
        pipeline.statistics.leafEmissionCount,
        alignedCompiled.statistics.leafEmissionCount
    );
    assert.strictEqual(
        pipeline.statistics.scopeActionVisitCount,
        alignedCompiled.statistics.scopeActionVisitCount
    );
    assert.strictEqual(
        pipeline.statistics.policyLeafVisitCount,
        aligned.plan.statistics.policyLeafVisitCount
    );
    assert.strictEqual(
        pipeline.statistics.leafVisitCount,
        aligned.plan.statistics.leafVisitCount +
            aligned.plan.statistics.policyLeafVisitCount +
            alignedCompiled.statistics.leafVisitCount +
            pipeline.statistics.equivalenceSourceLeafVisitCount +
            pipeline.statistics.equivalenceOutputLeafVisitCount
    );
    assert.strictEqual(
        pipeline.statistics.directLookupCount,
        aligned.plan.statistics.directLookupCount +
            aligned.plan.statistics.policyDirectLookupCount +
            alignedCompiled.statistics.directLookupCount +
            pipeline.statistics.metricsSummaryLookupCount +
            pipeline.statistics.renderMetricsLookupCount +
            pipeline.statistics.equivalenceDirectLookupCount
    );

    var forged = policyApi.buildLayoutPlan(
        analysis,
        resolved.options,
        Object.freeze({ targets: Object.freeze([]) })
    );
    assert.strictEqual(forged.ok, false);
    assert.strictEqual(forged.code, 'LAYOUT_PLAN_PROVENANCE');

    var equivalentOptions = optionsApi.resolveFormatOptions({ dialect: 'hive' });
    assert.strictEqual(equivalentOptions.ok, true);
    assert.notStrictEqual(equivalentOptions.options, resolved.options);
    assert.strictEqual(
        alignmentApi.isCanonicalLayoutAlignmentPlan(
            alignment,
            analysis,
            equivalentOptions.options
        ),
        false,
        'canonical plans must bind the exact canonical options identity'
    );
    assert.strictEqual(
        policyApi.buildLayoutPlan(
            analysis,
            equivalentOptions.options,
            alignment
        ).ok,
        false,
        'cross-options canonical alignment plan must fail closed'
    );

    var otherAnalysis = analysisApi.analyzeSql(
        'select short as x, much_longer as y from u',
        { dialect: 'hive', mode: 'document' }
    );
    assert.strictEqual(otherAnalysis.status, 'analyzed');
    assert.strictEqual(
        policyApi.buildLayoutPlan(
            otherAnalysis,
            resolved.options,
            alignment
        ).ok,
        false,
        'cross-source canonical alignment plan must fail closed'
    );
    var otherBase = policyApi.buildLayoutPlan(
        otherAnalysis,
        resolved.options
    );
    assert.strictEqual(otherBase.ok, true);
    var otherCompiled = compilerApi.compileLayoutPlan(otherBase.plan);
    assert.strictEqual(otherCompiled.ok, true);
    var otherRendered = rendererApi.renderLayoutArtifact(
        otherCompiled.artifact
    );
    assert.strictEqual(otherRendered.ok, true);
    assert.strictEqual(
        alignmentApi.deriveLayoutAlignmentPlan(
            analysis,
            resolved.options,
            otherRendered
        ),
        null,
        'cross-artifact canonical render result must fail closed'
    );
    assert.strictEqual(
        alignmentApi.deriveLayoutAlignmentPlan(
            analysis,
            resolved.options,
            Object.assign({}, rendered)
        ),
        null,
        'render-result clones must not inherit artifact provenance'
    );

    assertStable(
        'verbatim-row-group-termination',
        "select a as x, longer as y, payload->>'x' as j, " +
            'c as z, widest_name as q from t',
        { dialect: 'postgresql' },
        [
            'SELECT',
            '      a      AS x',
            '    , longer AS y',
            "    , payload->>'x' AS j",
            '    , c           AS z',
            '    , widest_name AS q',
            'FROM t'
        ].join('\n')
    );

    var builder = planApi.createLayoutPlanBuilder(analysis, resolved.options);
    assert.ok(builder);
    var query = analysis.index.queries()[0];
    assert.ok(query);
    assert.strictEqual(builder.replaceGap(
        query.id,
        query.leafRange.start + 1,
        query.leafRange.start + 1,
        { kind: 'pad-to-column', targetColumn: 0 }
    ), false);
    var poisoned = builder.finish();
    assert.strictEqual(poisoned.ok, false);
    assert.strictEqual(poisoned.code, 'LAYOUT_PLAN_GAP');
})();

console.log('v2 Wave 3E alignment and option tests passed');
