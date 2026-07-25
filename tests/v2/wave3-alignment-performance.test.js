'use strict';

var assert = require('assert');
var childProcess = require('child_process');
var os = require('os');

function aliasSource(count) {
    var items = [];
    for (var index = 0; index < count; index++) {
        items.push('column_' + index + ' as alias_' + (index % 37));
    }
    return 'select ' + items.join(', ') + ' from t';
}

function commentSource(count) {
    var items = [];
    for (var index = 0; index < count; index++) {
        items.push((index % 2 === 0 ? 'a_' : 'long_column_') + index +
            ' -- comment-' + index);
    }
    return 'select ' + items.join('\n, ') + ' from t';
}

function median(values) {
    var sorted = values.slice().sort(function(left, right) { return left - right; });
    return sorted[Math.floor(sorted.length / 2)];
}

function alignmentTargetCount(source, options) {
    var analysisApi = require('../../.tmp/v2-core/core/analysis/index.js');
    var alignmentApi = require('../../.tmp/v2-core/core/layout/alignment-policy.js');
    var compilerApi = require('../../.tmp/v2-core/core/layout/compiler.js');
    var optionsApi = require('../../.tmp/v2-core/core/config/resolve-options.js');
    var policyApi = require('../../.tmp/v2-core/core/layout/policy.js');
    var rendererApi = require('../../.tmp/v2-core/core/renderer/render.js');
    var analysis = analysisApi.analyzeSql(source, {
        dialect: options.dialect,
        mode: 'document'
    });
    var resolved = optionsApi.resolveFormatOptions(options);
    assert.strictEqual(analysis.status, 'analyzed');
    assert.strictEqual(resolved.ok, true);
    var planned = policyApi.buildLayoutPlan(analysis, resolved.options);
    assert.strictEqual(planned.ok, true);
    var compiled = compilerApi.compileLayoutPlan(planned.plan);
    assert.strictEqual(compiled.ok, true);
    var rendered = rendererApi.renderLayoutArtifact(compiled.artifact);
    assert.strictEqual(rendered.ok, true);
    var alignment = alignmentApi.deriveLayoutAlignmentPlan(
        analysis,
        resolved.options,
        rendered
    );
    assert.ok(alignment);
    return alignment.targets.length;
}

function worker(kind, count) {
    var formatApi = require('../../.tmp/v2-core/core/api/format.js');
    var lexerApi = require('../../.tmp/v2-core/core/lexer/lossless-lexer.js');
    var source = kind === 'alias' ? aliasSource(count) : commentSource(count);
    var options = {
        dialect: 'hive',
        commaStyle: 'leading',
        maxAlignWidth: 150,
        keywordCase: 'upper'
    };
    var samples = [];
    var latest;
    for (var warmup = 0; warmup < 2; warmup++) {
        latest = formatApi.formatSqlWithStatistics(source, options);
    }
    for (var sample = 0; sample < 5; sample++) {
        var started = process.hrtime.bigint();
        latest = formatApi.formatSqlWithStatistics(source, options);
        samples.push(Number(process.hrtime.bigint() - started) / 1e6);
    }
    var repeated = formatApi.formatSql(latest.result.text, options);
    var comments = lexerApi.lexSql(latest.result.text, { dialect: 'hive' }).leaves.filter(
        function(leaf) { return leaf.kind === 'line-comment' || leaf.kind === 'block-comment'; }
    );
    var cpu = os.cpus()[0];
    process.stdout.write(JSON.stringify({
        kind: kind,
        count: count,
        medianMs: median(samples),
        samplesMs: samples,
        sourceCodeUnits: source.length,
        outputCodeUnits: latest.result.text.length,
        status: latest.result.status,
        repeatedStatus: repeated.status,
        idempotent: repeated.text === latest.result.text,
        commentCount: comments.length,
        alignmentTargetCount: alignmentTargetCount(source, options),
        statistics: latest.statistics,
        maxRssKb: process.resourceUsage().maxRSS,
        environment: {
            node: process.version,
            platform: process.platform,
            arch: process.arch,
            cpu: cpu ? cpu.model : 'unknown'
        }
    }));
}

function run(kind, count) {
    var result = childProcess.spawnSync(
        process.execPath,
        [__filename, '--worker', kind, String(count)],
        { cwd: process.cwd(), encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, timeout: 30000 }
    );
    assert.strictEqual(result.status, 0,
        kind + '/' + count + ' alignment worker failed:\n' +
        result.stdout + '\n' + result.stderr);
    return JSON.parse(result.stdout);
}

if (process.argv[2] === '--worker') {
    worker(process.argv[3], Number(process.argv[4]));
} else {
    var reports = ['alias', 'comment'].map(function(kind) {
        return [100, 800, 1200].map(function(count) { return run(kind, count); });
    });
    reports.forEach(function(scale) {
        scale.forEach(function(report) {
            var inputUnits = Math.max(
                1,
                report.statistics.leafCount + report.statistics.syntaxNodeCount
            );
            assert.strictEqual(report.status, 'formatted', report.kind + '/' + report.count);
            assert.strictEqual(report.repeatedStatus, 'unchanged',
                report.kind + '/' + report.count + ' idempotency status');
            assert.strictEqual(report.idempotent, true,
                report.kind + '/' + report.count + ' repeated text');
            assert.ok(report.outputCodeUnits > report.sourceCodeUnits,
                report.kind + '/' + report.count + ' must execute multiline layout');
            assert.ok(report.alignmentTargetCount > 0,
                report.kind + '/' + report.count + ' must derive alignment targets');
            assert.ok(report.alignmentTargetCount <= report.count * 2,
                report.kind + '/' + report.count + ' alignment targets must stay linear');
            assert.ok(report.statistics.leafVisitCount <= inputUnits * 12 + 128);
            assert.ok(report.statistics.directLookupCount <= inputUnits * 18 + 256);
            assert.ok(report.statistics.policyLeafVisitCount <= inputUnits * 6 + 128);
            assert.ok(report.statistics.policyDirectLookupCount <= inputUnits * 12 + 256);
            assert.ok(report.maxRssKb > 0 && report.maxRssKb < 1024 * 1024,
                report.kind + '/' + report.count + ' maxRSS gate');
            if (report.kind === 'comment') {
                assert.strictEqual(report.commentCount, report.count,
                    report.kind + '/' + report.count + ' comment conservation');
            }
        });
        var ratio800 = scale[1].medianMs / scale[0].medianMs;
        var ratio1200 = scale[2].medianMs / scale[0].medianMs;
        assert.ok(ratio800 / 8 <= 1.5,
            scale[0].kind + ' alignment 800 normalized ratio');
        assert.ok(ratio1200 / 12 <= 1.5,
            scale[0].kind + ' alignment 1200 normalized ratio');
    });
    console.log('v2 Wave 3 alignment performance ' + JSON.stringify({
        reports: reports,
        normalizedRatios: reports.map(function(scale) {
            return {
                kind: scale[0].kind,
                count800: scale[1].medianMs / scale[0].medianMs / 8,
                count1200: scale[2].medianMs / scale[0].medianMs / 12
            };
        })
    }));
}
