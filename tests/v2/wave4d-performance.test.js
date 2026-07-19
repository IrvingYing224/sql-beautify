'use strict';

var assert = require('assert');
var performance = require('perf_hooks').performance;
var ddl = require('../../.tmp/v2-core/experimental/ddl');

function columns(count) {
    var values = [];
    for (var index = 0; index < count; index++) {
        values.push('c' + index + ' STRING');
    }
    return 'CREATE TABLE t (\n' + values.join(',\n') + '\n)';
}

function deepStruct(depth) {
    var value = 'STRING';
    for (var index = depth - 1; index >= 0; index--) {
        value = 'STRUCT<f' + index + ':' + value + '>';
    }
    return 'CREATE TABLE t (payload ' + value + ')';
}

function longComment() {
    return "CREATE TABLE t (payload STRING COMMENT '" + new Array(100001).join('x') + "')";
}

function setQuery(branches) {
    var values = [];
    for (var index = 0; index < branches; index++) {
        values.push('SELECT c' + index + ' AS value FROM t' + index);
    }
    return values.join(' UNION ALL ');
}

function percentile(values, fraction) {
    var sorted = values.slice().sort(function(a, b) { return a - b; });
    return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function runCase(source, rounds) {
    var warm = ddl.formatHiveDdl(source);
    assert.ok(warm.status === 'formatted' || warm.status === 'unchanged');
    var samples = [];
    for (var index = 0; index < rounds; index++) {
        var started = performance.now();
        var result = ddl.formatHiveDdl(source);
        samples.push(performance.now() - started);
        assert.ok(result.status === 'formatted' || result.status === 'unchanged');
    }
    return {
        medianMs: percentile(samples, 0.5),
        p95Ms: percentile(samples, 0.95),
        samplesMs: samples
    };
}

function runExtractCase(source, rounds) {
    var warm = ddl.extractDdl(source);
    assert.strictEqual(warm.status, 'extracted');
    var samples = [];
    for (var index = 0; index < rounds; index++) {
        var started = performance.now();
        var result = ddl.extractDdl(source);
        samples.push(performance.now() - started);
        assert.strictEqual(result.status, 'extracted');
    }
    return {
        medianMs: percentile(samples, 0.5),
        p95Ms: percentile(samples, 0.95),
        samplesMs: samples
    };
}

var counts = [100, 800, 1200];
var reports = counts.map(function(count) {
    var source = columns(count);
    return {
        columns: count,
        sourceCodeUnits: source.length,
        timing: runCase(source, 5)
    };
});
assert.ok(reports[2].timing.p95Ms < 5000, '1200-column DDL p95 gate');
assert.ok(
    reports[2].timing.medianMs / Math.max(reports[0].timing.medianMs, 1) < 12,
    'DDL 8x scale ratio must remain bounded'
);

var special = [
    { kind: 'deep-struct', source: deepStruct(24) },
    { kind: 'long-comment', source: longComment() }
].map(function(item) {
    return {
        kind: item.kind,
        sourceCodeUnits: item.source.length,
        timing: runCase(item.source, 3)
    };
});
special.forEach(function(report) {
    assert.ok(report.timing.p95Ms < 5000, report.kind + ' DDL p95 gate');
});

var setReports = counts.map(function(count) {
    var source = setQuery(count);
    return {
        branches: count,
        sourceCodeUnits: source.length,
        timing: runExtractCase(source, 5)
    };
});
assert.ok(setReports[2].timing.p95Ms < 5000, '1200-branch Extract DDL p95 gate');
assert.ok(
    setReports[1].timing.medianMs / Math.max(setReports[0].timing.medianMs, 1) < 12,
    'Extract DDL 8x set-query scale ratio must remain bounded'
);
assert.ok(process.resourceUsage().maxRSS < 2 * 1024 * 1024,
    'DDL performance test must remain below 2 GB RSS');

for (var fuzz = 0; fuzz < 128; fuzz++) {
    var source = 'CREATE TABLE t (' +
        (fuzz % 3 === 0 ? 'c' + fuzz + ' ARRAY<STRING>' :
            fuzz % 3 === 1 ? 'c' + fuzz + ' DECIMAL(18,2)' :
                'c' + fuzz + ' STRING COMMENT \'v,' + fuzz + '\'') +
        (fuzz % 7 === 0 ? ', PRIMARY KEY (c' + fuzz + ')' : '') + ')';
    var result = ddl.formatHiveDdl(source);
    assert.ok(result && typeof result.text === 'string');
    assert.ok(result.status === 'formatted' || result.status === 'unchanged' ||
        result.status === 'preserved' || result.status === 'failed');
    if (result.status !== 'formatted' && result.status !== 'unchanged') {
        assert.strictEqual(result.text, source);
    }
}

console.log('v2 Wave 4D DDL performance and no-throw tests passed ' + JSON.stringify({
    reports: reports,
    special: special,
    setReports: setReports
}));
