'use strict';

/**
 * Production invariant performance gate (~100k–120k leaves).
 * validation median <= max(500ms, table build median × 20)
 */
var assert = require('assert');
var fs = require('fs');
var path = require('path');

var root = path.join(__dirname, '..', '..');
var corePath = path.join(root, '.tmp', 'v2-core', 'core', 'index.js');
var tokenTablePath = path.join(root, '.tmp', 'v2-core', 'core', 'syntax', 'token-table.js');
var invariantsPath = path.join(root, '.tmp', 'v2-core', 'core', 'syntax', 'invariants.js');
var expectedTablePath = path.join(
    root,
    '.tmp',
    'v2-core',
    'core',
    'syntax',
    'token-table-expected.js'
);

assert.ok(fs.existsSync(corePath), 'build:v2-core required');
var core = require(corePath);
var tokenTableMod = require(tokenTablePath);
var invariants = require(invariantsPath);
var expectedTableMod = require(expectedTablePath);
var MAX_BROKEN_TABLE_FAILURES = 32;
var EMPTY_FACTS = Object.freeze([]);

function withFacts(node, formatRole, capabilityId) {
    node.capabilityId = capabilityId === undefined ? null : capabilityId;
    node.formatRole = formatRole;
    node.syntaxMarkers = EMPTY_FACTS;
    return node;
}

function median(samples) {
    var s = samples.slice().sort(function(a, b) { return a - b; });
    return s[Math.floor(s.length / 2)];
}

function ms(a, b) {
    return Number(b - a) / 1e6;
}

function validateIncompleteTableNoThrow(leaves) {
    var result;
    assert.doesNotThrow(function() {
        result = invariants.validateTokenTableInvariants({}, leaves);
    }, '100k-leaf incomplete table must not throw');
    return result;
}

function assertIncompleteTableResult(result) {
    assert.strictEqual(result.ok, false, 'incomplete table must fail closed');
    assert.ok(result.failures.length >= 1, 'incomplete table must report a failure');
    assert.ok(
        result.failures.length <= MAX_BROKEN_TABLE_FAILURES,
        'incomplete table produced ' + result.failures.length + ' failures; expected <= ' +
            MAX_BROKEN_TABLE_FAILURES
    );
    assert.ok(Array.isArray(result.failures), 'incomplete-table failures must be a real Array');
    assert.strictEqual(
        Object.isFrozen(result.failures),
        true,
        'incomplete-table failures must be frozen'
    );
}

// Deterministic multi-statement corpus (~110k leaves)
var parts = [];
for (var i = 0; i < 6200; i++) {
    parts.push('SELECT a' + i + ', b' + i + ' FROM t' + i + ' WHERE x=' + i);
}
var source = parts.join('; ');

var tLex0 = process.hrtime.bigint();
var leaves = core.lexSql(source, { dialect: 'hive' }).leaves;
var tLex1 = process.hrtime.bigint();
assert.ok(leaves.length >= 100000 && leaves.length <= 130000,
    'expected ~100k-120k leaves, got ' + leaves.length);

var buildSamples = [];
var table;
for (var b = 0; b < 5; b++) {
    var tb0 = process.hrtime.bigint();
    table = tokenTableMod.buildStructuralTokenTable(leaves, source);
    var tb1 = process.hrtime.bigint();
    buildSamples.push(ms(tb0, tb1));
}
var buildMed = median(buildSamples);

var ranges = table.statementRanges();
var children = [];
var nextId = 1;
for (var j = 0; j < ranges.length; j++) {
    var r = ranges[j];
    var span = table.rangeToSpan(r);
    var bodyId = nextId + 1;
    children.push(withFacts({
        id: nextId,
        kind: 'statement',
        statementKind: 'opaque',
        bodyChildId: bodyId,
        leafRange: r,
        span: span,
        children: [withFacts({
            id: bodyId,
            kind: 'opaque',
            reasonCode: 'X',
            boundary: 'statement',
            leafRange: r,
            span: span
        }, 'opaque')]
    }, 'intrinsic-container'));
    nextId = bodyId + 1;
}
var root = withFacts({
    id: 0,
    kind: 'program',
    leafRange: { start: 0, end: leaves.length },
    span: { start: 0, end: source.length },
    children: children
}, 'intrinsic-container');

// A full CST validation owns one independent structural oracle. The nested
// token-table contract must consume that exact oracle instead of rebuilding
// the same O(n) facts a second time.
var originalDeriveExpectedTable = expectedTableMod.deriveExpectedTable;
var deriveExpectedTableCalls = 0;
expectedTableMod.deriveExpectedTable = function() {
    deriveExpectedTableCalls += 1;
    return originalDeriveExpectedTable.apply(this, arguments);
};
var singleOracleResult;
try {
    singleOracleResult = invariants.validateSyntaxInvariants({
        root: root,
        leaves: leaves,
        source: source,
        tokenTable: table
    });
} finally {
    expectedTableMod.deriveExpectedTable = originalDeriveExpectedTable;
}
assert.strictEqual(
    singleOracleResult.ok,
    true,
    'single-oracle validation must pass: ' + JSON.stringify(singleOracleResult.failures.slice(0, 3))
);
assert.strictEqual(
    deriveExpectedTableCalls,
    1,
    'one validateSyntaxInvariants call must derive the expected token table exactly once'
);

// warmup
var warm = invariants.validateSyntaxInvariants({
    root: root,
    leaves: leaves,
    source: source,
    tokenTable: table
});
assert.strictEqual(warm.ok, true, 'warmup must pass: ' + JSON.stringify(warm.failures.slice(0, 3)));
assert.strictEqual(warm.failures.length, 0);

var valSamples = [];
for (var k = 0; k < 7; k++) {
    var tv0 = process.hrtime.bigint();
    var res = invariants.validateSyntaxInvariants({
        root: root,
        leaves: leaves,
        source: source,
        tokenTable: table
    });
    var tv1 = process.hrtime.bigint();
    assert.strictEqual(res.ok, true, 'validation must pass');
    assert.strictEqual(res.failures.length, 0);
    valSamples.push(ms(tv0, tv1));
}
var valMed = median(valSamples);
var gate = Math.max(500, buildMed * 20);
var ratio = valMed / Math.max(buildMed, 0.001);

// Broken-table fail-fast uses the same 100k-leaf corpus. Timing is only a wide
// disaster guard; bounded failures and no-throw behavior are the primary proof.
assertIncompleteTableResult(validateIncompleteTableNoThrow(leaves));
var incompleteTableSamples = [];
for (var q = 0; q < 7; q++) {
    var ti0 = process.hrtime.bigint();
    var incompleteResult = validateIncompleteTableNoThrow(leaves);
    var ti1 = process.hrtime.bigint();
    assertIncompleteTableResult(incompleteResult);
    incompleteTableSamples.push(ms(ti0, ti1));
}
var incompleteTableMed = median(incompleteTableSamples);
var incompleteTableGate = Math.min(250, gate / 2);

console.log(JSON.stringify({
    leaves: leaves.length,
    lexMs: ms(tLex0, tLex1),
    tableBuildMedianMs: buildMed,
    validationMedianMs: valMed,
    ratio: ratio,
    gateMs: gate,
    incompleteTableMedianMs: incompleteTableMed,
    incompleteTableGateMs: incompleteTableGate,
    buildSamples: buildSamples,
    validationSamples: valSamples,
    incompleteTableSamples: incompleteTableSamples
}, null, 2));

assert.ok(
    valMed <= gate,
    'validation median ' + valMed.toFixed(1) + 'ms exceeds gate ' + gate.toFixed(1) +
        'ms (build ' + buildMed.toFixed(1) + 'ms ×20 or 500ms)'
);

assert.ok(
    incompleteTableMed <= incompleteTableGate,
    'incomplete-table median ' + incompleteTableMed.toFixed(1) + 'ms exceeds fail-fast gate ' +
        incompleteTableGate.toFixed(1) + 'ms'
);

console.log('v2 syntax invariants performance tests passed');
