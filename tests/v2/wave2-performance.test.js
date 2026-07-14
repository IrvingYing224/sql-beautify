'use strict';

var assert = require('assert');
var path = require('path');

var root = path.join(__dirname, '..', '..');
var parser = require(path.join(root, '.tmp', 'v2-core', 'core', 'syntax', 'parser.js'));

var SAMPLE_COUNT = 5;
var SCALE_RATIO_GATE = 12;

function makeSource(statementCount) {
    var statements = [];
    for (var i = 0; i < statementCount; i++) {
        statements.push([
            'WITH source_' + i + ' AS (',
            'SELECT id, ROW_NUMBER() OVER (PARTITION BY id ORDER BY ts DESC) AS rn',
            'FROM fact_' + i + " WHERE ds = '2026-07-13'",
            ') SELECT s.id, d.name FROM source_' + i + ' s',
            'LEFT OUTER JOIN dim_' + i + ' d ON s.id = d.id',
            'WHERE s.rn = 1 DISTRIBUTE BY s.id SORT BY d.name DESC LIMIT 100;'
        ].join('\n'));
    }
    return statements.join('\n');
}

function median(values) {
    var sorted = values.slice().sort(function(a, b) { return a - b; });
    return sorted[Math.floor(sorted.length / 2)];
}

function measure(statementCount) {
    var source = makeSource(statementCount);
    var warm = parser.parseSql(source, { dialect: 'hive', mode: 'document' });
    assert.strictEqual(warm.root.children.length, statementCount,
        statementCount + ' statement warm result');
    assert.ok(warm.root.children.every(function(statement) {
        return statement.statementKind === 'query';
    }), statementCount + ' statement warm parse must remain structured');

    var timings = [];
    for (var sample = 0; sample < SAMPLE_COUNT; sample++) {
        var started = process.hrtime.bigint();
        var result = parser.parseSql(source, { dialect: 'hive', mode: 'document' });
        var elapsed = Number(process.hrtime.bigint() - started) / 1e6;
        assert.strictEqual(result.root.children.length, statementCount,
            statementCount + ' statement measured result');
        assert.strictEqual(result.leaves.map(function(leaf) { return leaf.raw; }).join(''), source,
            statementCount + ' statement source conservation');
        timings.push(elapsed);
    }
    return Object.freeze({
        statementCount: statementCount,
        sourceBytes: Buffer.byteLength(source, 'utf8'),
        medianMs: median(timings),
        samplesMs: Object.freeze(timings),
    });
}

var baseline100 = measure(100);
var baseline800 = measure(800);
var baseline1200 = measure(1200);
var ratio800 = baseline800.medianMs / baseline100.medianMs;
var ratio1200 = baseline1200.medianMs / baseline100.medianMs;
var maxRss = process.resourceUsage().maxRSS;

assert.ok(Number.isFinite(ratio800) && ratio800 <= SCALE_RATIO_GATE,
    '800/100 parser scale ratio exceeded ' + SCALE_RATIO_GATE + 'x: ' + ratio800);
assert.ok(Number.isFinite(ratio1200) && ratio1200 <= SCALE_RATIO_GATE,
    '1200/100 parser scale ratio exceeded ' + SCALE_RATIO_GATE + 'x: ' + ratio1200);

console.log('v2 Wave 2 parser performance baseline ' + JSON.stringify({
    samples: [baseline100, baseline800, baseline1200].map(function(item) {
        return {
            statements: item.statementCount,
            sourceBytes: item.sourceBytes,
            medianMs: Number(item.medianMs.toFixed(2))
        };
    }),
    ratio800To100: Number(ratio800.toFixed(2)),
    ratio1200To100: Number(ratio1200.toFixed(2)),
    maxRSS: maxRss,
    scaleRatioGate: SCALE_RATIO_GATE
}));
