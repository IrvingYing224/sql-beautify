'use strict';

var assert = require('assert');
var path = require('path');

var root = path.join(__dirname, '..', '..');
var parser = require(path.join(root, '.tmp', 'v2-core', 'core', 'syntax', 'parser.js'));
var invariants = require(path.join(root, '.tmp', 'v2-core', 'core', 'syntax', 'invariants.js'));
var tokenTable = require(path.join(root, '.tmp', 'v2-core', 'core', 'syntax', 'token-table.js'));

var SAMPLE_COUNT = 5;
var SCALE_RATIO_GATE = 12;
var ALIAS_RATIO_400_GATE = 8;
var ALIAS_RATIO_800_GATE = 12;

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

function makeAliasColumnListSource(relationCount) {
    var source = 'SELECT * FROM t0 qualify(c0)';
    for (var index = 1; index < relationCount; index++) {
        source += (index % 2 === 0 ? ', ' : ' CROSS JOIN ') +
            't' + index + ' qualify(c' + index + ')';
    }
    return source;
}

function measureAliasColumnLists(relationCount) {
    var source = makeAliasColumnListSource(relationCount);
    var warm = parser.parseSql(source, { dialect: 'postgresql', mode: 'document' });
    assert.deepStrictEqual(warm.root.children.map(function(statement) {
        return statement.statementKind;
    }), ['query'], relationCount + ' relation alias-list warm parse');

    var timings = [];
    for (var sample = 0; sample < SAMPLE_COUNT; sample++) {
        var started = process.hrtime.bigint();
        var result = parser.parseSql(source, {
            dialect: 'postgresql',
            mode: 'document'
        });
        timings.push(Number(process.hrtime.bigint() - started) / 1e6);
        assert.deepStrictEqual(result.root.children.map(function(statement) {
            return statement.statementKind;
        }), ['query'], relationCount + ' relation alias-list measured parse');
        assert.strictEqual(result.leaves.map(function(leaf) {
            return leaf.raw;
        }).join(''), source, relationCount + ' relation alias-list source conservation');
        assert.strictEqual(result.diagnostics.some(function(diagnostic) {
            return diagnostic.recovery === 'preserve-statement' ||
                diagnostic.recovery === 'preserve-target' ||
                /proof budget/i.test(diagnostic.message);
        }), false, relationCount + ' legal alias lists must not widen recovery');
    }
    return Object.freeze({
        relationCount: relationCount,
        medianMs: median(timings),
        samplesMs: Object.freeze(timings)
    });
}

function makeAddChain(termCount) {
    var terms = ['x'];
    for (var index = 1; index < termCount; index++) {
        terms.push(String(index));
    }
    return terms.join(' + ');
}

function assertDeepResult(source, result, expectedStatementKind, label) {
    assert.deepStrictEqual(result.root.children.map(function(statement) {
        return statement.statementKind;
    }), [expectedStatementKind], label + ' statement kind');
    assert.strictEqual(result.leaves.map(function(leaf) {
        return leaf.raw;
    }).join(''), source, label + ' source conservation');
    assert.strictEqual(result.diagnostics.some(function(diagnostic) {
        return diagnostic.code === 'SYN_INTERNAL_INVARIANT' ||
            diagnostic.recovery === 'preserve-target' ||
            /Maximum call stack/i.test(diagnostic.message);
    }), false, label + ' must not hit internal fallback');
    var checked = invariants.validateSyntaxInvariants({
        root: result.root,
        leaves: result.leaves,
        source: source,
        tokenTable: tokenTable.buildStructuralTokenTable(result.leaves, source)
    });
    assert.strictEqual(
        checked.ok,
        true,
        label + ' invariant failures: ' + JSON.stringify(checked.failures)
    );
}

function measureDeepBinaryChains() {
    var wide = makeAddChain(3000);
    var qualify = makeAddChain(1500);
    var cases = [
        {
            label: 'wide SELECT expression',
            source: 'SELECT ' + wide,
            expected: 'query'
        },
        {
            label: 'wide WHERE expression',
            source: 'SELECT * FROM t WHERE ' + wide + ' > 0',
            expected: 'query'
        },
        {
            label: 'wide real QUALIFY expression',
            source: 'SELECT * FROM t q QUALIFY ' + qualify + ' > 0',
            expected: 'opaque',
            requireQualify: true
        },
        {
            label: 'wide QUALIFY after alias column list',
            source: 'SELECT * FROM t q(c) QUALIFY ' + qualify + ' > 0',
            expected: 'opaque',
            requireQualify: true
        },
        {
            label: 'wide table function with alias column list',
            source: 'SELECT * FROM fn(' + qualify + ') q(c) QUALIFY flag',
            expected: 'opaque',
            requireQualify: true
        },
        {
            label: 'wide JOIN table-function continuation',
            source: 'SELECT * FROM t qualify JOIN fn(' + qualify + ') u ON true',
            expected: 'query'
        }
    ];
    var started = process.hrtime.bigint();
    cases.forEach(function(testCase) {
        var result = parser.parseSql(testCase.source, {
            dialect: 'hive',
            mode: 'document'
        });
        assertDeepResult(testCase.source, result, testCase.expected, testCase.label);
        if (testCase.requireQualify) {
            assert.ok(result.diagnostics.some(function(diagnostic) {
                return diagnostic.recovery === 'preserve-statement' &&
                    /QUALIFY/.test(diagnostic.message);
            }), testCase.label + ' must retain QUALIFY capability identity');
        } else {
            assert.deepStrictEqual(result.diagnostics, [], testCase.label + ' diagnostics');
        }
    });
    return Number(process.hrtime.bigint() - started) / 1e6;
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
var aliases100 = measureAliasColumnLists(100);
var aliases400 = measureAliasColumnLists(400);
var aliases800 = measureAliasColumnLists(800);
var aliasRatio400 = aliases400.medianMs / aliases100.medianMs;
var aliasRatio800 = aliases800.medianMs / aliases100.medianMs;
var deepBinaryChainsMs = measureDeepBinaryChains();
var maxRss = process.resourceUsage().maxRSS;

assert.ok(Number.isFinite(ratio800) && ratio800 <= SCALE_RATIO_GATE,
    '800/100 parser scale ratio exceeded ' + SCALE_RATIO_GATE + 'x: ' + ratio800);
assert.ok(Number.isFinite(ratio1200) && ratio1200 <= SCALE_RATIO_GATE,
    '1200/100 parser scale ratio exceeded ' + SCALE_RATIO_GATE + 'x: ' + ratio1200);
assert.ok(Number.isFinite(aliasRatio400) && aliasRatio400 <= ALIAS_RATIO_400_GATE,
    '400/100 alias-list scale ratio exceeded ' + ALIAS_RATIO_400_GATE + 'x: ' +
        aliasRatio400);
assert.ok(Number.isFinite(aliasRatio800) && aliasRatio800 <= ALIAS_RATIO_800_GATE,
    '800/100 alias-list scale ratio exceeded ' + ALIAS_RATIO_800_GATE + 'x: ' +
        aliasRatio800);
assert.ok(Number.isFinite(deepBinaryChainsMs) && deepBinaryChainsMs < 2500,
    'deep binary-chain probes exceeded 2500ms: ' + deepBinaryChainsMs);

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
    aliasListSamples: [aliases100, aliases400, aliases800].map(function(item) {
        return {
            relations: item.relationCount,
            medianMs: Number(item.medianMs.toFixed(2))
        };
    }),
    aliasListRatio400To100: Number(aliasRatio400.toFixed(2)),
    aliasListRatio800To100: Number(aliasRatio800.toFixed(2)),
    deepBinaryChainsMs: Number(deepBinaryChainsMs.toFixed(2)),
    maxRSS: maxRss,
    scaleRatioGate: SCALE_RATIO_GATE,
    aliasListRatio400Gate: ALIAS_RATIO_400_GATE,
    aliasListRatio800Gate: ALIAS_RATIO_800_GATE
}));
