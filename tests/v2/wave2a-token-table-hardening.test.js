'use strict';

/**
 * Wave 2A token-table production invariants + test-only misuse samples.
 * Exhaustive illegal-call matrix is sampled here; production keeps O(1) probes.
 */
var assert = require('assert');
var fs = require('fs');
var path = require('path');

var root = path.join(__dirname, '..', '..');
var corePath = path.join(root, '.tmp', 'v2-core', 'core', 'index.js');
var tokenTablePath = path.join(root, '.tmp', 'v2-core', 'core', 'syntax', 'token-table.js');
var invariantsPath = path.join(root, '.tmp', 'v2-core', 'core', 'syntax', 'invariants.js');

assert.ok(fs.existsSync(corePath), 'build:v2-core required');
var core = require(corePath);
var tokenTableMod = require(tokenTablePath);
var invariants = require(invariantsPath);

var MAX_BROKEN_TABLE_FAILURES = 32;
var TABLE_METHODS = [
    'leafCount', 'syntaxLeafCount', 'codeLeafCount',
    'previousSyntaxLeafIndex', 'nextSyntaxLeafIndex',
    'syntaxOrdinalOfLeaf', 'leafIndexOfSyntaxOrdinal',
    'previousCodeLeafIndex', 'nextCodeLeafIndex',
    'codeOrdinalOfLeaf', 'leafIndexOfCodeOrdinal',
    'depthBefore', 'depthAfter', 'matchingDelimiterIndex',
    'statementRanges', 'statementBoundariesReliable', 'structuralIssues',
    'rangeToSpan', 'normalizedWord', 'codeWordsEqual', 'getLeaf'
];

function lex(source, dialect) {
    return core.lexSql(source, { dialect: dialect || 'hive' });
}

var failures = [];
function test(name, fn) {
    try {
        fn();
        console.log('  ok - ' + name);
    } catch (err) {
        failures.push({ name: name, error: err });
        console.log('  FAIL - ' + name + ': ' + err.message);
    }
}

function assertFails(label, result, codeHint) {
    assert.strictEqual(result.ok, false, label + ' expected ok=false: ' + JSON.stringify(result.failures));
    assert.ok(result.failures.length >= 1, label + ' expected failures');
    if (codeHint) {
        var joined = result.failures.map(function(f) {
            return f.code + ' ' + f.message;
        }).join('\n');
        assert.ok(codeHint.test(joined), label + ' mismatch:\n' + joined);
    }
}

function assertBoundedFailure(label, result, methodName) {
    assertFails(label, result);
    assert.ok(
        result.failures.length <= MAX_BROKEN_TABLE_FAILURES,
        label + ' produced ' + result.failures.length + ' failures; expected <= ' +
            MAX_BROKEN_TABLE_FAILURES
    );
    assert.ok(Array.isArray(result.failures), label + ' failures must be a real Array');
    assert.strictEqual(Object.isFrozen(result.failures), true, label + ' failures must be frozen');
    if (methodName) {
        var methodFailures = result.failures.filter(function(failure) {
            return String(failure.message).indexOf(methodName) >= 0;
        });
        assert.strictEqual(
            methodFailures.length,
            1,
            label + ' expected one primary ' + methodName + ' failure: ' +
                JSON.stringify(result.failures)
        );
    }
}

function validateNoThrow(label, table, leaves) {
    var result;
    assert.doesNotThrow(function() {
        result = invariants.validateTokenTableInvariants(table, leaves);
    }, label + ' must not throw');
    return result;
}

function cloneTable(real, overrides) {
    var t = {};
    TABLE_METHODS.forEach(function(k) {
        if (typeof real[k] === 'function') {
            t[k] = function() {
                return real[k].apply(real, arguments);
            };
        }
    });
    Object.keys(overrides || {}).forEach(function(k) {
        t[k] = overrides[k];
    });
    return t;
}

function countingCloneTable(real, calls) {
    var t = {};
    TABLE_METHODS.forEach(function(k) {
        if (typeof real[k] === 'function') {
            t[k] = function() {
                calls[k] = (calls[k] || 0) + 1;
                return real[k].apply(real, arguments);
            };
        }
    });
    return t;
}

function circuitFixture() {
    var source = "SELECT (a[1]), 'x' AS y -- comment\nFROM t WHERE b = 2; SELECT z";
    var leaves = lex(source).leaves;
    return {
        source: source,
        leaves: leaves,
        table: tokenTableMod.buildStructuralTokenTable(leaves, source)
    };
}

test('TABLE sparse-structuralIssues fails', function() {
    var source = 'SELECT (';
    var leaves = lex(source).leaves;
    var real = tokenTableMod.buildStructuralTokenTable(leaves, source);
    var exp = real.structuralIssues();
    var sparse = new Array(exp.length);
    if (exp.length) sparse[0] = exp[0];
    var r = invariants.validateTokenTableInvariants(cloneTable(real, {
        structuralIssues: function() { return sparse; }
    }), leaves);
    assert.strictEqual(r.ok, false);
    assertFails('sparse-issues', r, /TOKEN_TABLE|dense|holes/i);
});

test('TABLE structuralIssues undefined element fails', function() {
    var source = 'SELECT (';
    var leaves = lex(source).leaves;
    var real = tokenTableMod.buildStructuralTokenTable(leaves, source);
    var forged = real.structuralIssues().slice();
    assert.ok(forged.length >= 1);
    forged[0] = undefined;
    Object.freeze(forged);
    var r = invariants.validateTokenTableInvariants(cloneTable(real, {
        structuralIssues: function() { return forged; }
    }), leaves);
    assert.strictEqual(r.ok, false);
    assertFails('issues-undefined', r, /TOKEN_TABLE|non-null|object/i);
});

test('TABLE structuralIssues null element fails', function() {
    var source = 'SELECT (';
    var leaves = lex(source).leaves;
    var real = tokenTableMod.buildStructuralTokenTable(leaves, source);
    var forged = real.structuralIssues().slice();
    assert.ok(forged.length >= 1);
    forged[0] = null;
    Object.freeze(forged);
    var r = invariants.validateTokenTableInvariants(cloneTable(real, {
        structuralIssues: function() { return forged; }
    }), leaves);
    assert.strictEqual(r.ok, false);
    assertFails('issues-null', r, /TOKEN_TABLE|non-null|object/i);
});

test('TABLE sparse-statementRanges fails', function() {
    var source = 'SELECT 1; SELECT 2';
    var leaves = lex(source).leaves;
    var real = tokenTableMod.buildStructuralTokenTable(leaves, source);
    var exp = real.statementRanges();
    var sparse = new Array(exp.length);
    if (exp.length) sparse[0] = exp[0];
    var r = invariants.validateTokenTableInvariants(cloneTable(real, {
        statementRanges: function() { return sparse; }
    }), leaves);
    assert.strictEqual(r.ok, false);
    assertFails('sparse-ranges', r, /STATEMENT_RANGES|dense|holes/i);
});

test('TABLE statementRanges=[undefined] fails', function() {
    var source = 'SELECT 1';
    var leaves = lex(source).leaves;
    var real = tokenTableMod.buildStructuralTokenTable(leaves, source);
    var r = invariants.validateTokenTableInvariants(cloneTable(real, {
        statementRanges: function() { return Object.freeze([undefined]); }
    }), leaves);
    assert.strictEqual(r.ok, false);
    assertFails('ranges-undefined', r, /STATEMENT_RANGES|non-null|LeafRange/i);
});

test('TABLE statementRanges=[null] fails', function() {
    var source = 'SELECT 1';
    var leaves = lex(source).leaves;
    var real = tokenTableMod.buildStructuralTokenTable(leaves, source);
    var r = invariants.validateTokenTableInvariants(cloneTable(real, {
        statementRanges: function() { return Object.freeze([null]); }
    }), leaves);
    assert.strictEqual(r.ok, false);
    assertFails('ranges-null', r, /STATEMENT_RANGES|non-null|LeafRange/i);
});

test('TABLE mutable structuralIssues fails frozen contract', function() {
    var source = 'SELECT 1';
    var leaves = lex(source).leaves;
    var real = tokenTableMod.buildStructuralTokenTable(leaves, source);
    var r = invariants.validateTokenTableInvariants(cloneTable(real, {
        structuralIssues: function() { return []; }
    }), leaves);
    assert.strictEqual(r.ok, false);
    assertFails('mutable-issues', r, /TOKEN_TABLE|frozen/i);
});

test('TABLE fractional-reverse-ordinal-and-range-end fails', function() {
    var source = 'SELECT 1';
    var leaves = lex(source).leaves;
    var real = tokenTableMod.buildStructuralTokenTable(leaves, source);
    var r = invariants.validateTokenTableInvariants(cloneTable(real, {
        syntaxOrdinalOfLeaf: function(i) {
            if (!Number.isInteger(i)) return 0;
            return real.syntaxOrdinalOfLeaf(i);
        },
        codeOrdinalOfLeaf: function(i) {
            if (!Number.isInteger(i)) return 0;
            return real.codeOrdinalOfLeaf(i);
        },
        rangeToSpan: function(range) {
            if (range && (!Number.isInteger(range.start) || !Number.isInteger(range.end))) {
                return { start: 0, end: 0 };
            }
            return real.rangeToSpan(range);
        }
    }), leaves);
    assert.strictEqual(r.ok, false);
    assertFails('fractional', r, /TOKEN_TABLE|must reject|1\.5|fractional/i);
});

test('TABLE empty-codeWordsEqual-accepts-illegal fails', function() {
    var leaves = lex('').leaves;
    var real = tokenTableMod.buildStructuralTokenTable(leaves, '');
    var r = invariants.validateTokenTableInvariants(cloneTable(real, {
        codeWordsEqual: function() { return true; }
    }), leaves);
    assert.strictEqual(r.ok, false);
    assertFails('empty-cwe', r, /TOKEN_TABLE|must reject|codeWordsEqual/i);
});

test('TABLE second-noncode-codeWordsEqual-accepted fails', function() {
    var source = "SELECT 'x' --c\nFROM t";
    var leaves = lex(source).leaves;
    var real = tokenTableMod.buildStructuralTokenTable(leaves, source);
    var non = [];
    for (var i = 0; i < leaves.length; i++) {
        if (leaves[i].channel !== 'code') non.push(i);
    }
    assert.ok(non.length >= 2);
    var second = non[1];
    var r = invariants.validateTokenTableInvariants(cloneTable(real, {
        codeWordsEqual: function(a, b) {
            if (a === second || b === second) return true;
            return real.codeWordsEqual(a, b);
        }
    }), leaves);
    assert.strictEqual(r.ok, false);
    assertFails('second-noncode', r, /TOKEN_TABLE|must reject|codeWordsEqual/i);
});

test('TABLE missing getLeaf fails preflight before any table API call', function() {
    var fixture = circuitFixture();
    var calls = {};
    var broken = countingCloneTable(fixture.table, calls);
    delete broken.getLeaf;

    var r = validateNoThrow('missing-getLeaf-preflight', broken, fixture.leaves);
    assert.deepStrictEqual(calls, {}, 'preflight failure must not call any table API');
    assert.strictEqual(r.failures.length, 1, JSON.stringify(r.failures));
    assertBoundedFailure('missing-getLeaf-preflight', r, 'getLeaf');
});

test('TABLE getLeaf always throws trips its circuit once', function() {
    var fixture = circuitFixture();
    var calls = 0;
    var r = validateNoThrow('getLeaf-throws', cloneTable(fixture.table, {
        getLeaf: function() {
            calls += 1;
            throw new Error('getLeaf-boom');
        }
    }), fixture.leaves);

    assert.strictEqual(calls, 1, 'getLeaf must stop after its first valid-domain throw');
    assertBoundedFailure('getLeaf-throws', r, 'getLeaf');
});

test('TABLE getLeaf always wrong stops at first canonical mismatch', function() {
    var fixture = circuitFixture();
    assert.ok(fixture.leaves.length >= 2, 'fixture needs a distinct wrong SourceLeaf');
    assert.notStrictEqual(fixture.leaves[0].id, fixture.leaves[1].id);
    var calls = 0;
    var r = validateNoThrow('getLeaf-wrong', cloneTable(fixture.table, {
        getLeaf: function() {
            calls += 1;
            return fixture.leaves[1];
        }
    }), fixture.leaves);

    assert.strictEqual(calls, 1, 'getLeaf must stop at its first canonical mismatch');
    assertBoundedFailure('getLeaf-wrong', r, 'getLeaf');
});

test('TABLE depthBefore throw does not stop healthy depthAfter validation', function() {
    var fixture = circuitFixture();
    var beforeCalls = 0;
    var afterValidCalls = 0;
    var r = validateNoThrow('depthBefore-throws', cloneTable(fixture.table, {
        depthBefore: function() {
            beforeCalls += 1;
            throw new Error('depthBefore-boom');
        },
        depthAfter: function(index) {
            if (Number.isInteger(index) && index >= 0 && index < fixture.leaves.length) {
                afterValidCalls += 1;
            }
            return fixture.table.depthAfter(index);
        }
    }), fixture.leaves);

    assert.strictEqual(beforeCalls, 1, 'depthBefore must stop after its first valid-domain throw');
    assert.strictEqual(
        afterValidCalls,
        fixture.leaves.length,
        'independent depthAfter valid-domain checks must continue'
    );
    assertBoundedFailure('depthBefore-throws', r, 'depthBefore');
});

test('TABLE codeWordsEqual always throws trips its circuit once', function() {
    var fixture = circuitFixture();
    var calls = 0;
    var r = validateNoThrow('codeWordsEqual-throws', cloneTable(fixture.table, {
        codeWordsEqual: function() {
            calls += 1;
            throw new Error('codeWordsEqual-boom');
        }
    }), fixture.leaves);

    assert.strictEqual(calls, 1, 'codeWordsEqual must stop after its first valid-domain throw');
    assertBoundedFailure('codeWordsEqual-throws', r, 'codeWordsEqual');
});

test('TABLE remaining valid-domain methods trip independent circuits once', function() {
    var fixture = circuitFixture();
    [
        'leafIndexOfSyntaxOrdinal',
        'syntaxOrdinalOfLeaf',
        'leafIndexOfCodeOrdinal',
        'codeOrdinalOfLeaf',
        'previousSyntaxLeafIndex',
        'nextSyntaxLeafIndex',
        'previousCodeLeafIndex',
        'nextCodeLeafIndex',
        'matchingDelimiterIndex',
        'depthAfter',
        'rangeToSpan',
        'normalizedWord'
    ].forEach(function(methodName) {
        var calls = 0;
        var overrides = {};
        overrides[methodName] = function() {
            calls += 1;
            throw new Error(methodName + '-boom');
        };
        var label = methodName + '-throws';
        var r = validateNoThrow(
            label,
            cloneTable(fixture.table, overrides),
            fixture.leaves
        );

        assert.strictEqual(calls, 1, methodName + ' must stop after its first valid-domain throw');
        assertBoundedFailure(label, r, methodName);
    });
});

test('TABLE adversarial collection cannot exceed the global failure cap', function() {
    var fixture = circuitFixture();
    var forged = new Array(128);
    for (var i = 0; i < forged.length; i++) {
        forged[i] = null;
    }
    Object.freeze(forged);
    var r = validateNoThrow('bounded-structuralIssues', cloneTable(fixture.table, {
        structuralIssues: function() { return forged; }
    }), fixture.leaves);

    assertBoundedFailure('bounded-structuralIssues', r);
});

test('test-only audit: real table rejects syntaxOrdinalOfLeaf(1.5)', function() {
    var leaves = lex('SELECT 1').leaves;
    var real = tokenTableMod.buildStructuralTokenTable(leaves, 'SELECT 1');
    var threw = false;
    try {
        real.syntaxOrdinalOfLeaf(1.5);
    } catch (_e) {
        threw = true;
    }
    assert.strictEqual(threw, true);
});

test('test-only audit: real table rejects rangeToSpan fractional end', function() {
    var leaves = lex('SELECT 1').leaves;
    var real = tokenTableMod.buildStructuralTokenTable(leaves, 'SELECT 1');
    var threw = false;
    try {
        real.rangeToSpan({ start: 0, end: 0.5 });
    } catch (_e) {
        threw = true;
    }
    assert.strictEqual(threw, true);
});

test('positive real StructuralTokenTable full contract ok', function() {
    var source = "SELECT (a[1]), 'x' AS y; SELECT 2";
    var leaves = lex(source).leaves;
    var real = tokenTableMod.buildStructuralTokenTable(leaves, source);
    var r = invariants.validateTokenTableInvariants(real, leaves);
    assert.strictEqual(r.ok, true, JSON.stringify(r.failures));
});

test('positive real StructuralTokenTable validates across four dialects', function() {
    [
        { dialect: 'generic', source: 'SELECT (a + 1) FROM t;' },
        { dialect: 'hive', source: 'SELECT ${db}, array(1, 2) FROM `t`;' },
        { dialect: 'postgresql', source: "SELECT payload @> 'x', $1 FROM t;" },
        { dialect: 'mysql', source: 'SELECT `a`, ? FROM t WHERE b = 1;' }
    ].forEach(function(sample) {
        var leaves = lex(sample.source, sample.dialect).leaves;
        var real = tokenTableMod.buildStructuralTokenTable(leaves, sample.source);
        var r = invariants.validateTokenTableInvariants(real, leaves);
        assert.strictEqual(
            r.ok,
            true,
            sample.dialect + ': ' + JSON.stringify(r.failures)
        );
        assert.strictEqual(r.failures.length, 0, sample.dialect);
    });
});

test('positive multi unmatched openers ordered multi-set ok', function() {
    // Production residual openers drain LIFO; expected oracle must match order.
    var source = '((';
    var leaves = lex(source).leaves;
    var real = tokenTableMod.buildStructuralTokenTable(leaves, source);
    var issues = real.structuralIssues();
    var openers = issues.filter(function(x) { return x.code === 'STRUCT_UNMATCHED_OPENER'; });
    assert.ok(openers.length >= 2, 'expected multiple unmatched openers');
    // LIFO: last opener index first
    assert.ok(openers[0].leafIndex >= openers[1].leafIndex,
        'expected LIFO residual opener order, got ' + JSON.stringify(openers));
    var r = invariants.validateTokenTableInvariants(real, leaves);
    assert.strictEqual(r.ok, true, JSON.stringify(r.failures));
});

test('illegal objects do not throw', function() {
    [null, 0, false, {}, { leafCount: 1 }].forEach(function(bad, i) {
        var threw = false;
        var r;
        try {
            r = invariants.validateTokenTableInvariants(bad, []);
        } catch (_e) {
            threw = true;
        }
        assert.strictEqual(threw, false, 'case ' + i);
        assert.strictEqual(r.ok, false);
    });
});

if (failures.length > 0) {
    console.error('\n' + failures.length + ' token-table hardening test(s) failed');
    failures.forEach(function(f) {
        console.error(' - ' + f.name + ': ' + f.error.stack);
    });
    process.exit(1);
}
console.log('v2 Wave 2A token-table hardening tests passed');
