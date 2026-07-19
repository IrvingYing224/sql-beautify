var assert = require('assert');
var crypto = require('crypto');
var fs = require('fs');
var path = require('path');
var performance = require('perf_hooks').performance;

var root = path.join(__dirname, '..', '..');
var directModule = require('../../.tmp/v2-core/adapters/executor/direct');
var persistentModule = require('../../.tmp/v2-core/adapters/executor/persistent-worker');
var connectionModule = require('../../.tmp/v2-core/adapters/executor/worker-connection');

function digest(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function statements(count) {
    var values = [];
    for (var index = 0; index < count; index++) {
        values.push('select ' + index + ' as value_' + index + ';');
    }
    return values.join('\n');
}

function cteChain(count) {
    var values = [];
    for (var index = 0; index < count; index++) {
        if (index === 0) {
            values.push('c0 as (select 0 as value)');
        } else {
            values.push('c' + index + ' as (select value + 1 as value from c' + (index - 1) + ')');
        }
    }
    return 'with ' + values.join(', ') + ' select value from c' + (count - 1) + ';';
}

function largeComment(size) {
    return '/*' + new Array(size + 1).join('x') + '*/\nselect 1;';
}

function request(source) {
    return { source: source, options: { dialect: 'hive' }, mode: 'document',
        documentVersion: 1, targetId: 'performance' };
}

function percentile(values, fraction) {
    var sorted = values.slice().sort(function(a, b) { return a - b; });
    return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

async function runCase(executor, source, rounds) {
    await executor.format(request(source));
    var samples = [];
    for (var index = 0; index < rounds; index++) {
        var started = performance.now();
        var result = await executor.format(request(source));
        samples.push(performance.now() - started);
        assert.ok(result.status == 'formatted' || result.status == 'unchanged');
    }
    return {
        medianMs: percentile(samples, 0.5),
        p95Ms: percentile(samples, 0.95),
        samplesMs: samples
    };
}

async function run() {
    var runtimePath = path.join(root, 'dist', 'v2-core.cjs');
    var workerPath = path.join(root, 'dist', 'v2-worker.cjs');
    var direct = new directModule.DirectFormatterExecutor();
    var worker = new persistentModule.PersistentWorkerExecutor({
        workerFactory: connectionModule.createNodeWorkerFactory(workerPath, runtimePath),
        runtimeDigest: digest(runtimePath)
    });
    var counts = [100, 800, 1200];
    var report = [];
    for (var index = 0; index < counts.length; index++) {
        var source = statements(counts[index]);
        report.push({
            statements: counts[index],
            sourceCodeUnits: source.length,
            direct: await runCase(direct, source, 5),
            worker: await runCase(worker, source, 5)
        });
    }
    assert.ok(report[2].worker.p95Ms < 5000, '1200-statement worker p95 gate');
    assert.ok(report[2].worker.medianMs / Math.max(report[0].worker.medianMs, 1) < 12,
        'worker scale must remain bounded');

    var specialSources = [
        { kind: 'large-cte', source: cteChain(80) },
        { kind: 'large-comment', source: largeComment(100000) }
    ];
    var specialReport = [];
    for (var specialIndex = 0; specialIndex < specialSources.length; specialIndex++) {
        var special = specialSources[specialIndex];
        var specialTiming = await runCase(worker, special.source, 3);
        assert.ok(specialTiming.p95Ms < 5000,
            special.kind + ' worker p95 gate');
        specialReport.push({
            kind: special.kind,
            sourceCodeUnits: special.source.length,
            timing: specialTiming
        });
    }

    var cancelState = { cancelled: false, listeners: [] };
    var cancelToken = {
        get isCancellationRequested() { return cancelState.cancelled; },
        onCancellationRequested: function(listener) {
            cancelState.listeners.push(listener);
            return function() {
                var index = cancelState.listeners.indexOf(listener);
                if (index >= 0) cancelState.listeners.splice(index, 1);
            };
        }
    };
    var cancelStarted = performance.now();
    var cancelledPromise = worker.format({
        source: largeComment(100000), options: { dialect: 'hive' }, mode: 'document',
        documentVersion: 2, targetId: 'cancel-latency', cancellation: cancelToken
    });
    cancelState.cancelled = true;
    cancelState.listeners.slice().forEach(function(listener) { listener(); });
    var cancelledResult = await cancelledPromise;
    var cancellationLatencyMs = performance.now() - cancelStarted;
    assert.strictEqual(cancelledResult.diagnostics[0].code, 'ADAPTER_CANCELLED');
    assert.ok(cancellationLatencyMs < 500, 'worker cancellation latency gate');
    var stats = worker.statistics();
    assert.ok(stats.workerStartMs >= 0);
    assert.ok(stats.lastFormattingMs >= 0);
    assert.ok(stats.lastRoundTripMs >= 0);
    assert.ok(stats.lastTransferMs >= 0);
    assert.ok(process.resourceUsage().maxRSS < 2 * 1024 * 1024,
        'executor performance test must remain below 2 GB RSS');
    await worker.dispose();
    await direct.dispose();
    console.log('v2 Wave 4C performance ' + JSON.stringify({
        report: report,
        specialReport: specialReport,
        cancellationLatencyMs: cancellationLatencyMs,
        stats: stats
    }));
}

run().catch(function(error) {
    console.error(error);
    process.exitCode = 1;
});
