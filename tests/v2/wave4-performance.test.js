'use strict';

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var performance = require('perf_hooks').performance;

var root = path.join(__dirname, '..', '..');
var runtimePath = path.join(root, 'dist', 'v2-core.cjs');
var ddlRuntimePath = path.join(root, 'dist', 'v2-ddl.cjs');
var bridgePath = path.join(root, 'dist', 'v2-format-bridge.cjs');
var workerPath = path.join(root, 'dist', 'v2-worker.cjs');
var runtime = require(runtimePath);
var ddl = require(ddlRuntimePath);
var startingRssBytes = process.memoryUsage().rss;

function statements(count) {
    var values = [];
    for (var index = 0; index < count; index++) {
        values.push('select ' + index + ' as value_' + index + ';');
    }
    return values.join('\n');
}

function columns(count) {
    var values = [];
    for (var index = 0; index < count; index++) {
        values.push('c' + index + ' ARRAY<STRUCT<x:STRING,n:INT>>');
    }
    return 'CREATE TABLE t (\n' + values.join(',\n') + '\n);';
}

function setQuery(count) {
    var values = [];
    for (var index = 0; index < count; index++) {
        values.push('SELECT c' + index + ' AS value FROM t' + index);
    }
    return values.join(' UNION ALL ');
}

function percentile(values, fraction) {
    var sorted = values.slice().sort(function(left, right) { return left - right; });
    return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function measure(source, execute, rounds) {
    var warm = execute(source);
    assert.ok(warm.status === 'formatted' || warm.status === 'unchanged' ||
        warm.status === 'extracted');
    var samples = [];
    for (var index = 0; index < rounds; index++) {
        var started = performance.now();
        var result = execute(source);
        samples.push(performance.now() - started);
        assert.ok(result.status === 'formatted' || result.status === 'unchanged' ||
            result.status === 'extracted');
    }
    return {
        medianMs: percentile(samples, 0.5),
        p95Ms: percentile(samples, 0.95),
        samplesMs: samples
    };
}

function reportFor(count, source, execute) {
    return {
        count: count,
        sourceCodeUnits: source.length,
        timing: measure(source, execute, 20)
    };
}

var counts = [100, 800, 1200];
var formatter = counts.map(function(count) {
    return reportFor(count, statements(count), function(source) {
        return runtime.formatSql(source, { dialect: 'hive' });
    });
});
var hiveDdl = counts.map(function(count) {
    return reportFor(count, columns(count), ddl.formatHiveDdl);
});
var extractDdl = counts.map(function(count) {
    return reportFor(count, setQuery(count), ddl.extractDdl);
});

[
    { label: 'formatter', reports: formatter },
    { label: 'Hive DDL', reports: hiveDdl },
    { label: 'Extract DDL', reports: extractDdl }
].forEach(function(group) {
    assert.ok(group.reports[0].timing.medianMs > 0,
        group.label + ' 100-item production bundle median must be measurable');
    assert.ok(group.reports[2].timing.p95Ms < 5000,
        group.label + ' 1200-item production bundle p95 gate');
    assert.ok(
        group.reports[1].timing.medianMs /
            group.reports[0].timing.medianMs < 12,
        group.label + ' production bundle 8x scale gate'
    );
});

assert.ok(fs.statSync(runtimePath).size < 2 * 1024 * 1024,
    'v2 core production bundle must remain below 2 MiB');
assert.ok(fs.statSync(ddlRuntimePath).size < 2 * 1024 * 1024,
    'v2 DDL production bundle must remain below 2 MiB');
assert.ok(fs.statSync(bridgePath).size < 256 * 1024,
    'v2 bridge production bundle must remain below 256 KiB');
assert.ok(fs.statSync(workerPath).size < 256 * 1024,
    'v2 worker production bundle must remain below 256 KiB');
var finalRssBytes = process.memoryUsage().rss;
var rssGrowthBytes = Math.max(0, finalRssBytes - startingRssBytes);
assert.ok(process.resourceUsage().maxRSS < 1024 * 1024,
    'Wave 4 aggregate performance must remain below 1 GiB peak RSS');
assert.ok(rssGrowthBytes < 512 * 1024 * 1024,
    'Wave 4 aggregate performance must remain below 512 MiB resident growth');

console.log('v2 Wave 4 aggregate performance ' + JSON.stringify({
    formatter: formatter,
    hiveDdl: hiveDdl,
    extractDdl: extractDdl,
    bundleBytes: {
        core: fs.statSync(runtimePath).size,
        ddl: fs.statSync(ddlRuntimePath).size,
        bridge: fs.statSync(bridgePath).size,
        worker: fs.statSync(workerPath).size
    },
    maxRssKb: process.resourceUsage().maxRSS,
    rssGrowthBytes: rssGrowthBytes
}));
