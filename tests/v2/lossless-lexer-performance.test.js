'use strict';

var assert = require('assert');
var path = require('path');
var fs = require('fs');

var root = path.join(__dirname, '..', '..');
var corePath = path.join(root, '.tmp', 'v2-core', 'core', 'index.js');
assert.ok(fs.existsSync(corePath), 'build:v2-core must produce .tmp/v2-core before performance tests');

var lexSql = require(corePath).lexSql;

var STATEMENT = [
    'WITH src AS (',
    "  SELECT user_id, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY ts DESC) AS rn",
    "  FROM fact_orders -- keep FROM 😀",
    "  WHERE ds = '2026-07-11' AND status <=> 'ok'",
    ')',
    'INSERT OVERWRITE TABLE dst PARTITION (ds=${hivevar:day})',
    'SELECT user_id, item FROM src',
    'LATERAL VIEW EXPLODE(items) e AS item',
    'WHERE rn = 1 AND amount >= 1.5e-3',
    'DISTRIBUTE BY user_id SORT BY ts DESC;'
].join('\n');

function reconstruct(output) {
    return output.leaves.map(function(leaf) {
        return leaf.raw;
    }).join('');
}

function buildSource(statementCount) {
    var parts = [];
    for (var i = 0; i < statementCount; i++) {
        parts.push(STATEMENT.replace(/user_id/g, 'user_id_' + i));
    }
    return parts.join('\n');
}

function median(values) {
    var sorted = values.slice().sort(function(a, b) {
        return a - b;
    });
    var mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 0) {
        return (sorted[mid - 1] + sorted[mid]) / 2;
    }
    return sorted[mid];
}

/**
 * Measure one statement-count scale.
 * repeatsPerSample: how many times to lex the same source inside one timed sample
 * so sub-millisecond 100-case measurements remain stable.
 * reported medianMs is normalized to a single pass over the source.
 */
function measureScale(statementCount, repeatsPerSample) {
    var source = buildSource(statementCount);

    for (var w = 0; w < 2; w++) {
        for (var r = 0; r < repeatsPerSample; r++) {
            var warm = lexSql(source, { dialect: 'hive' });
            assert.strictEqual(reconstruct(warm), source);
        }
    }

    var samples = [];
    var leafCount = 0;
    for (var i = 0; i < 7; i++) {
        var start = process.hrtime.bigint();
        var output = null;
        for (var j = 0; j < repeatsPerSample; j++) {
            output = lexSql(source, { dialect: 'hive' });
        }
        var end = process.hrtime.bigint();
        assert.ok(output);
        assert.strictEqual(reconstruct(output), source);
        leafCount = output.leaves.length;
        // normalize to one pass
        samples.push((Number(end - start) / 1e6) / repeatsPerSample);
    }

    // process.resourceUsage().maxRSS is the cumulative peak RSS for this Node process
    // (kilobytes on Linux/macOS). It is NOT an independent per-scale peak.
    var processPeakRssKb = typeof process.resourceUsage === 'function'
        ? process.resourceUsage().maxRSS
        : Math.round(process.memoryUsage().rss / 1024);

    return {
        statements: statementCount,
        chars: source.length,
        leaves: leafCount,
        medianMs: median(samples),
        samples: samples,
        processPeakRssKb: processPeakRssKb,
        repeatsPerSample: repeatsPerSample
    };
}

function measureUnknownScale(patternCount, repeatsPerSample) {
    var source = '中😀§'.repeat(patternCount);
    var samples = [];
    var output;
    for (var warmup = 0; warmup < 2; warmup++) {
        output = lexSql(source, { dialect: 'hive' });
        assert.strictEqual(reconstruct(output), source);
        assert.strictEqual(output.leaves.length, 1);
        assert.strictEqual(output.leaves[0].kind, 'unknown');
    }
    for (var sample = 0; sample < 7; sample++) {
        var start = process.hrtime.bigint();
        for (var repeat = 0; repeat < repeatsPerSample; repeat++) {
            output = lexSql(source, { dialect: 'hive' });
        }
        samples.push(
            Number(process.hrtime.bigint() - start) /
                1e6 /
                repeatsPerSample
        );
    }
    assert.strictEqual(reconstruct(output), source);
    assert.strictEqual(output.leaves.length, 1);
    return {
        patterns: patternCount,
        codePoints: patternCount * 3,
        codeUnits: source.length,
        leaves: output.leaves.length,
        medianMs: median(samples),
        samples: samples
    };
}

// Keep 100-case samples out of sub-millisecond noise by repeating inside the sample.
var result100 = measureScale(100, 30);
var result800 = measureScale(800, 4);
var result1200 = measureScale(1200, 3);

// Plan gates compare total work scale: time(N)/time(100).
// Near-linear ideal: 800/100 ≈ 8, 1200/100 ≈ 12.
var ratio800 = result800.medianMs / result100.medianMs;
var ratio1200 = result1200.medianMs / result100.medianMs;
var unknown100 = measureUnknownScale(10000, 30);
var unknown800 = measureUnknownScale(80000, 4);
var unknown1200 = measureUnknownScale(120000, 3);
var unknownRatio800 = unknown800.medianMs / unknown100.medianMs;
var unknownRatio1200 = unknown1200.medianMs / unknown100.medianMs;

var report = {
    result100: {
        statements: result100.statements,
        chars: result100.chars,
        leaves: result100.leaves,
        medianMs: result100.medianMs,
        processPeakRssKb: result100.processPeakRssKb
    },
    result800: {
        statements: result800.statements,
        chars: result800.chars,
        leaves: result800.leaves,
        medianMs: result800.medianMs,
        processPeakRssKb: result800.processPeakRssKb
    },
    result1200: {
        statements: result1200.statements,
        chars: result1200.chars,
        leaves: result1200.leaves,
        medianMs: result1200.medianMs,
        processPeakRssKb: result1200.processPeakRssKb
    },
    ratio800: ratio800,
    ratio1200: ratio1200,
    unknownRuns: {
        result100: unknown100,
        result800: unknown800,
        result1200: unknown1200,
        ratio800: unknownRatio800,
        ratio1200: unknownRatio1200
    },
    processPeakRssNote: 'processPeakRssKb is process.resourceUsage().maxRSS for the whole test process; cumulative, not independent per scale'
};

console.log(JSON.stringify(report, null, 2));

assert.ok(
    ratio800 <= 12,
    '800/100 scale ratio must be <= 12 (near-linear gate), got ' + ratio800
);
assert.ok(
    ratio1200 <= 18,
    '1200/100 scale ratio must be <= 18 (disaster gate), got ' + ratio1200
);
assert.ok(
    unknownRatio800 <= 12,
    'merged unknown 800/100 scale ratio must be <= 12, got ' +
        unknownRatio800
);
assert.ok(
    unknownRatio1200 <= 18,
    'merged unknown 1200/100 scale ratio must be <= 18, got ' +
        unknownRatio1200
);

console.log('v2 lossless lexer performance tests passed');
