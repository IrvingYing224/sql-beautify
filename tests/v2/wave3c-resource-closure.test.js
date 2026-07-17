'use strict';

var assert = require('assert');
var childProcess = require('child_process');
var crypto = require('crypto');

function deepCteSource(depth) {
    var query = "select 'leaf' as v";
    for (var index = depth - 1; index >= 0; index--) {
        query = 'with q' + index + ' as (' + query +
            ') select v from q' + index;
    }
    return query;
}

function commentDenseListSource(count) {
    var items = [];
    for (var index = 0; index < count; index++) {
        items.push('a' + index + ' /*c' + index + '*/');
    }
    return 'select ' + items.join(', ') + ' from t';
}

function sourceFor(kind) {
    if (kind === 'deep-formatted') {
        return deepCteSource(32);
    }
    if (kind === 'deep-budget') {
        return deepCteSource(64);
    }
    if (kind === 'large-comment') {
        return 'select /*' + 'x'.repeat(250000) + '*/ 1';
    }
    if (kind === 'comment-dense-list') {
        return commentDenseListSource(2000);
    }
    throw new Error('unknown Wave 3C resource case ' + kind);
}

function commentEvidence(lexerApi, source) {
    var hash = crypto.createHash('sha256');
    var count = 0;
    lexerApi.lexSql(source, { dialect: 'hive' }).leaves.forEach(function(leaf) {
        if (leaf.kind === 'line-comment' || leaf.kind === 'block-comment') {
            count += 1;
            hash.update(leaf.kind + '\0' + leaf.raw.length + '\0' + leaf.raw);
        }
    });
    return { count: count, digest: hash.digest('hex') };
}

function worker(kind) {
    var formatApi = require('../../.tmp/v2-core/core/api/format.js');
    var lexerApi = require('../../.tmp/v2-core/core/lexer/lossless-lexer.js');
    var source = sourceFor(kind);
    var sourceComments = commentEvidence(lexerApi, source);
    var started = process.hrtime.bigint();
    var first = formatApi.formatSqlWithStatistics(source, { dialect: 'hive' });
    var second = formatApi.formatSqlWithStatistics(first.result.text, {
        dialect: 'hive'
    });
    var elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    var outputComments = commentEvidence(lexerApi, first.result.text);
    process.stdout.write(JSON.stringify({
        kind: kind,
        sourceCodeUnits: source.length,
        outputCodeUnits: first.result.text.length,
        firstStatus: first.result.status,
        secondStatus: second.result.status,
        originalReturned: first.result.text === source,
        idempotent: second.result.text === first.result.text,
        diagnosticMessages: first.result.diagnostics.map(function(value) {
            return value.message;
        }),
        sourceComments: sourceComments,
        outputComments: outputComments,
        statistics: first.statistics,
        elapsedMs: elapsedMs,
        maxRssKb: process.resourceUsage().maxRSS
    }));
}

function runIsolated(kind) {
    var result = childProcess.spawnSync(
        process.execPath,
        [__filename, '--worker', kind],
        {
            cwd: process.cwd(),
            encoding: 'utf8',
            maxBuffer: 1024 * 1024,
            timeout: 30000
        }
    );
    assert.strictEqual(
        result.status,
        0,
        kind + ' isolated worker failed:\n' + result.stdout + '\n' +
            result.stderr + '\nerror=' + String(result.error || 'none') +
            '\nsignal=' + String(result.signal || 'none')
    );
    return JSON.parse(result.stdout);
}

if (process.argv[2] === '--worker') {
    worker(process.argv[3]);
} else {
    var reports = [
        'deep-formatted',
        'deep-budget',
        'large-comment',
        'comment-dense-list'
    ].map(runIsolated);

    reports.forEach(function(report) {
        assert.ok(report.elapsedMs > 0 && report.elapsedMs < 15000,
            report.kind + ' must remain inside the 15s disaster gate');
        assert.ok(report.maxRssKb > 0 && report.maxRssKb < 1024 * 1024,
            report.kind + ' must remain below the 1 GiB maxRSS gate');
        assert.strictEqual(report.idempotent, true, report.kind + ' idempotency');
        assert.deepStrictEqual(
            report.outputComments,
            report.sourceComments,
            report.kind + ' comment byte conservation'
        );
        assert.ok(report.statistics.planActionCount <=
            report.statistics.maxPlanActions);
        var inputUnits = Math.max(1,
            report.statistics.leafCount + report.statistics.syntaxNodeCount);
        assert.ok(report.statistics.policyNodeVisitCount <= inputUnits * 4 + 64);
        assert.ok(report.statistics.policyLeafVisitCount <= inputUnits * 4 + 64);
        assert.ok(report.statistics.policyDirectLookupCount <= inputUnits * 8 + 128);
    });

    var deepFormatted = reports[0];
    assert.strictEqual(deepFormatted.firstStatus, 'formatted');
    assert.strictEqual(deepFormatted.secondStatus, 'unchanged');
    assert.ok(deepFormatted.outputCodeUnits > deepFormatted.sourceCodeUnits);
    assert.ok(deepFormatted.statistics.scopeActionCount >= 96);

    var deepBudget = reports[1];
    assert.ok(deepBudget.firstStatus === 'failed' ||
        deepBudget.firstStatus === 'preserved');
    assert.strictEqual(deepBudget.originalReturned, true);
    assert.ok(deepBudget.diagnosticMessages.some(function(message) {
        return /resource|budget/i.test(message);
    }), 'deep budget refusal must expose a bounded resource diagnostic');

    var largeComment = reports[2];
    assert.strictEqual(largeComment.sourceComments.count, 1);
    assert.strictEqual(largeComment.firstStatus, 'formatted');
    assert.strictEqual(largeComment.secondStatus, 'unchanged');

    var dense = reports[3];
    assert.strictEqual(dense.sourceComments.count, 2000);
    assert.strictEqual(dense.firstStatus, 'formatted');
    assert.strictEqual(dense.secondStatus, 'unchanged');
    assert.ok(dense.outputCodeUnits > dense.sourceCodeUnits);

    console.log('v2 Wave 3C resource closure ' + JSON.stringify(reports));
}
