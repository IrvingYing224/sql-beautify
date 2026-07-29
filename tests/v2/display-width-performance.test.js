'use strict';

var assert = require('assert');
var display = require('../../.tmp/v2-core/core/renderer/display-width');

function median(values) {
    var sorted = values.slice().sort(function(left, right) { return left - right; });
    return sorted[Math.floor(sorted.length / 2)];
}

function measure(text, expectedWidth, repeats) {
    var samples = [];
    for (var warmup = 0; warmup < 3; warmup++) {
        assert.strictEqual(display.displayWidth(text), expectedWidth);
    }
    for (var sample = 0; sample < 7; sample++) {
        var start = process.hrtime.bigint();
        for (var repeat = 0; repeat < repeats; repeat++) {
            assert.strictEqual(display.displayWidth(text), expectedWidth);
        }
        samples.push(Number(process.hrtime.bigint() - start) / 1e6 / repeats);
    }
    return { medianMs: median(samples), samplesMs: samples };
}

var ascii100 = measure('a'.repeat(100000), 100000, 20);
var ascii800 = measure('a'.repeat(800000), 800000, 3);
var ascii1200 = measure('a'.repeat(1200000), 1200000, 2);
var clusterHeavy = measure('界'.repeat(100000), 200000, 2);
var ratio800 = ascii800.medianMs / ascii100.medianMs;
var ratio1200 = ascii1200.medianMs / ascii100.medianMs;

assert.ok(ratio800 <= 12,
    'ASCII display width 800/100 ratio must be <= 12, got ' + ratio800);
assert.ok(ratio1200 <= 18,
    'ASCII display width 1200/100 ratio must be <= 18, got ' + ratio1200);
assert.ok(ascii100.medianMs < clusterHeavy.medianMs * 0.5,
    'ASCII fast path must materially beat per-cluster Unicode scanning: ASCII=' +
        ascii100.medianMs + 'ms cluster=' + clusterHeavy.medianMs + 'ms');

console.log('v2 display width performance ' + JSON.stringify({
    ascii100: ascii100,
    ascii800: ascii800,
    ascii1200: ascii1200,
    clusterHeavy: clusterHeavy,
    ratio800: ratio800,
    ratio1200: ratio1200
}));
