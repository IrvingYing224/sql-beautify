'use strict';

var assert = require('assert');
var sourceMaps = require('../../.tmp/v2-core/core/source/source-map');
var cursor = require('../../.tmp/v2-core/adapters/transaction/cursor');

function median(values) {
    var sorted = values.slice().sort(function(left, right) { return left - right; });
    return sorted[Math.floor(sorted.length / 2)];
}

function sourceMapFixture(entryCount) {
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
    return {
        sourceMap: sourceMap,
        sourceLength: sourceLength,
        outputLength: outputLength
    };
}

function measure(entryCount) {
    var fixture = sourceMapFixture(entryCount);
    var mapper = sourceMaps.createSourceOffsetMapper(
        fixture.sourceMap, fixture.sourceLength, fixture.outputLength
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

function measureCloneAndSelections(entryCount, selectionCount) {
    var fixture = sourceMapFixture(entryCount);
    var cloneSamples = [];
    var cloned = null;
    for (var cloneSample = 0; cloneSample < 3; cloneSample++) {
        var cloneStart = process.hrtime.bigint();
        cloned = structuredClone(fixture.sourceMap);
        cloneSamples.push(Number(process.hrtime.bigint() - cloneStart) / 1e6);
    }
    assert.ok(cloned);
    assert.strictEqual(cloned.entries.length, entryCount);
    assert.ok(sourceMaps.canonicalSourceMapSnapshot(
        cloned, fixture.sourceLength, fixture.outputLength
    ), '80k structured clone must remain a canonicalizable source map');

    var selectionSamples = [];
    var selectionChecksum = 0;
    for (var selectionSample = 0; selectionSample < 5; selectionSample++) {
        var selectionStart = process.hrtime.bigint();
        for (var selectionIndex = 0; selectionIndex < selectionCount; selectionIndex++) {
            var entryIndex = (selectionIndex * 17) % entryCount;
            var sourceStart = entryIndex * 2;
            var forward = selectionIndex % 2 === 0;
            var mapped = cursor.mapSelectionThroughSourceMap(forward ? {
                anchor: sourceStart,
                active: sourceStart + 1
            } : {
                anchor: sourceStart + 1,
                active: sourceStart
            }, fixture.sourceMap, fixture.sourceLength, fixture.outputLength);
            assert.ok(mapped, 'large-map selection must remain mappable');
            assert.strictEqual(mapped.anchor < mapped.active, forward,
                'large-map selection direction must be preserved');
            selectionChecksum += mapped.anchor + mapped.active;
        }
        selectionSamples.push(
            Number(process.hrtime.bigint() - selectionStart) / 1e6
        );
    }
    assert.ok(selectionChecksum > 0);
    return {
        entries: entryCount,
        cloneMedianMs: median(cloneSamples),
        cloneSamplesMs: cloneSamples,
        selections: selectionCount,
        selectionMedianMs: median(selectionSamples),
        selectionSamplesMs: selectionSamples
    };
}

var result100 = measure(1000);
var result800 = measure(8000);
var result1200 = measure(12000);
var result80k = measure(80000);
var largeMapOperations = measureCloneAndSelections(80000, 4096);
var ratio800 = result800.medianMs / result100.medianMs;
var ratio1200 = result1200.medianMs / result100.medianMs;
var ratio80kTo1k = result80k.medianMs / result100.medianMs;

assert.ok(ratio800 <= 4,
    'cached binary source-map 800/100 lookup ratio must be <= 4, got ' + ratio800);
assert.ok(ratio1200 <= 5,
    'cached binary source-map 1200/100 lookup ratio must be <= 5, got ' + ratio1200);
assert.ok(ratio80kTo1k <= 8,
    'cached binary source-map 80k/1k lookup ratio must be <= 8, got ' +
        ratio80kTo1k);

console.log('v2 source map performance ' + JSON.stringify({
    result100: result100,
    result800: result800,
    result1200: result1200,
    result80k: result80k,
    largeMapOperations: largeMapOperations,
    ratio800: ratio800,
    ratio1200: ratio1200,
    ratio80kTo1k: ratio80kTo1k
}));
