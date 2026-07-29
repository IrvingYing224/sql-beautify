'use strict';

var assert = require('assert');
var sourceMaps = require('../../.tmp/v2-core/core/source/source-map');

function median(values) {
    var sorted = values.slice().sort(function(left, right) { return left - right; });
    return sorted[Math.floor(sorted.length / 2)];
}

function measure(entryCount) {
    var entries = [];
    for (var index = 0; index < entryCount; index++) {
        entries.push({
            source: { start: index * 2, end: index * 2 + 1 },
            output: { start: index * 3, end: index * 3 + 1 }
        });
    }
    var sourceLength = entryCount * 2;
    var outputLength = entryCount * 3;
    var sourceMap = sourceMaps.canonicalSourceMapSnapshot(
        { entries: entries }, sourceLength, outputLength
    );
    assert.ok(sourceMap);
    var mapper = sourceMaps.createSourceOffsetMapper(
        sourceMap, sourceLength, outputLength
    );
    assert.ok(mapper);
    var samples = [];
    var checksum = 0;
    for (var warmup = 0; warmup < 2; warmup++) {
        for (var warmQuery = 0; warmQuery < 20000; warmQuery++) {
            checksum += mapper.map((warmQuery % entryCount) * 2, 'right');
        }
    }
    for (var sample = 0; sample < 7; sample++) {
        var start = process.hrtime.bigint();
        for (var query = 0; query < 200000; query++) {
            checksum += mapper.map((query % entryCount) * 2, 'right');
        }
        samples.push(Number(process.hrtime.bigint() - start) / 1e6);
    }
    assert.ok(checksum > 0);
    return { entries: entryCount, medianMs: median(samples), samplesMs: samples };
}

var result100 = measure(1000);
var result800 = measure(8000);
var result1200 = measure(12000);
var ratio800 = result800.medianMs / result100.medianMs;
var ratio1200 = result1200.medianMs / result100.medianMs;

assert.ok(ratio800 <= 4,
    'cached binary source-map 800/100 lookup ratio must be <= 4, got ' + ratio800);
assert.ok(ratio1200 <= 5,
    'cached binary source-map 1200/100 lookup ratio must be <= 5, got ' + ratio1200);

console.log('v2 source map performance ' + JSON.stringify({
    result100: result100,
    result800: result800,
    result1200: result1200,
    ratio800: ratio800,
    ratio1200: ratio1200
}));
