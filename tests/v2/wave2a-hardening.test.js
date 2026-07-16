'use strict';

/**
 * Wave 2A final hardening regressions (Important I1–I5 + minors).
 * These tests encode the Codex probe failures that must stay fixed.
 */
var assert = require('assert');
var fs = require('fs');
var path = require('path');

var root = path.join(__dirname, '..', '..');
var corePath = path.join(root, '.tmp', 'v2-core', 'core', 'index.js');
var tokenTablePath = path.join(root, '.tmp', 'v2-core', 'core', 'syntax', 'token-table.js');
var cursorPath = path.join(root, '.tmp', 'v2-core', 'core', 'syntax', 'cursor.js');
var invariantsPath = path.join(root, '.tmp', 'v2-core', 'core', 'syntax', 'invariants.js');
var dialectsPath = path.join(root, '.tmp', 'v2-core', 'core', 'dialects', 'index.js');

assert.ok(fs.existsSync(corePath), 'build:v2-core required');
assert.ok(fs.existsSync(tokenTablePath), 'token-table required');
assert.ok(fs.existsSync(cursorPath), 'cursor required');
assert.ok(fs.existsSync(invariantsPath), 'invariants required');
assert.ok(fs.existsSync(dialectsPath), 'dialects required');

var core = require(corePath);
var tokenTableMod = require(tokenTablePath);
var cursorMod = require(cursorPath);
var invariantRuntime = require(invariantsPath);
var dialects = require(dialectsPath);

var EMPTY_FACTS = Object.freeze([]);

function hasOwn(value, key) {
    return Object.prototype.hasOwnProperty.call(value, key);
}

function frozenRange(value) {
    if (!value || typeof value !== 'object') {
        return value;
    }
    return Object.freeze({ start: value.start, end: value.end });
}

function formatFactsFor(node) {
    var formatRole = 'intrinsic-container';
    if (node.kind === 'opaque') {
        formatRole = 'opaque';
    } else if (node.kind === 'relation' && node.relationKind === 'table') {
        formatRole = 'intrinsic-primitive';
    } else if (node.kind === 'expression') {
        if (
            node.expressionKind === 'identifier' ||
            node.expressionKind === 'wildcard' ||
            node.expressionKind === 'literal' ||
            node.expressionKind === 'parameter' ||
            node.expressionKind === 'typed-literal' ||
            (node.expressionKind === 'frame-bound' &&
                (!Array.isArray(node.children) || node.children.length === 0))
        ) {
            formatRole = 'intrinsic-primitive';
        }
    } else if (node.kind === 'type-expression') {
        formatRole = 'intrinsic-primitive';
    }
    return { capabilityId: null, formatRole: formatRole };
}

function supplyWave3Facts(node) {
    if (!node || typeof node !== 'object') {
        return;
    }
    var facts = formatFactsFor(node);
    if (!hasOwn(node, 'capabilityId')) {
        node.capabilityId = facts.capabilityId;
    }
    if (!hasOwn(node, 'formatRole')) {
        node.formatRole = facts.formatRole;
    }
    if (!hasOwn(node, 'syntaxMarkers')) {
        node.syntaxMarkers = EMPTY_FACTS;
    } else if (Array.isArray(node.syntaxMarkers) && !Object.isFrozen(node.syntaxMarkers)) {
        node.syntaxMarkers = Object.freeze(node.syntaxMarkers.map(function(marker) {
            return marker && typeof marker === 'object' ? Object.freeze(marker) : marker;
        }));
    }
    if ((node.kind === 'clause' || node.kind === 'list') &&
        Array.isArray(node.separatorLeafIds) && !Object.isFrozen(node.separatorLeafIds)) {
        node.separatorLeafIds = Object.freeze(node.separatorLeafIds.slice());
    }
    if (node.kind === 'clause' && !hasOwn(node, 'separatorLeafIds')) {
        node.separatorLeafIds = EMPTY_FACTS;
    }
    if (node.kind === 'expression') {
        if (Array.isArray(node.operatorLeafIds) && !Object.isFrozen(node.operatorLeafIds)) {
            node.operatorLeafIds = Object.freeze(node.operatorLeafIds.slice());
        }
        if (!hasOwn(node, 'operatorOccurrences')) {
            node.operatorOccurrences = EMPTY_FACTS;
        }
    }
    if (node.kind === 'cte' && node.nameLeafRange) {
        node.nameLeafRange = frozenRange(node.nameLeafRange);
    }
    if (node.kind === 'relation') {
        if (!hasOwn(node, 'nameLeafRange')) {
            node.nameLeafRange = node.relationKind === 'table' && node.leafRange
                ? Object.freeze({
                    start: node.leafRange.start,
                    end: Math.min(node.leafRange.start + 1, node.leafRange.end)
                })
                : null;
        } else if (node.nameLeafRange) {
            node.nameLeafRange = frozenRange(node.nameLeafRange);
        }
        if (node.alias && typeof node.alias === 'object') {
            node.alias = Object.freeze({
                keywordLeafId: node.alias.keywordLeafId,
                nameLeafRange: frozenRange(node.alias.nameLeafRange)
            });
        }
    }
    if (Array.isArray(node.children)) {
        node.children.forEach(supplyWave3Facts);
    }
}

var invariants = Object.assign({}, invariantRuntime, {
    validateSyntaxInvariants: function(input) {
        supplyWave3Facts(input.root);
        return invariantRuntime.validateSyntaxInvariants(input);
    }
});

function lex(source, dialect) {
    return core.lexSql(source, dialect ? { dialect: dialect } : undefined);
}

function tableFor(source, dialect) {
    var output = lex(source, dialect);
    return {
        source: source,
        leaves: output.leaves,
        table: tokenTableMod.buildStructuralTokenTable(output.leaves, source)
    };
}

function syntaxSequence(table, leaves) {
    assert.strictEqual(typeof table.syntaxLeafCount, 'function', 'syntaxLeafCount API required');
    var seq = [];
    for (var i = 0; i < table.syntaxLeafCount(); i++) {
        var idx = table.leafIndexOfSyntaxOrdinal(i);
        var leaf = leaves[idx];
        seq.push({
            index: idx,
            kind: leaf.kind,
            channel: leaf.channel,
            raw: leaf.raw,
            span: { start: leaf.span.start, end: leaf.span.end }
        });
    }
    return seq;
}

function assertImmutableArray(arr, label) {
    assert.ok(Array.isArray(arr), label + ' must be a real Array');
    assert.strictEqual(Object.isFrozen(arr), true, label + ' must be frozen');
    var before = arr.length;
    var threw = false;
    try {
        arr.push({ forged: true });
    } catch (_e) {
        threw = true;
    }
    assert.strictEqual(arr.length, before, label + ' length must not change after push');
    // Callback third-arg mutation must not succeed
    if (arr.length > 0 && typeof arr.forEach === 'function') {
        arr.forEach(function(_v, _i, a) {
            var len = a.length;
            try {
                a.push('x');
            } catch (_err) { /* ok */ }
            try {
                a[0] = null;
            } catch (_err2) { /* ok */ }
            try {
                a.length = 0;
            } catch (_err3) { /* ok */ }
            assert.strictEqual(a.length, len, label + ' callback array must stay frozen');
            assert.strictEqual(Object.isFrozen(a), true, label + ' callback array frozen');
        });
    }
    // Normal array methods work
    assert.ok(typeof arr.slice === 'function');
    assert.ok(typeof arr.map === 'function');
    assert.ok(typeof arr.reduce === 'function' || arr.length === 0);
    if (arr.length > 0) {
        var joined = arr.map(function(x) { return typeof x === 'object' ? 'o' : String(x); }).join(',');
        assert.strictEqual(typeof joined, 'string');
    }
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

// =============================================================================
// I1: protected syntax leaves must not be skipped
// =============================================================================
test('I1 syntax sequence includes string/parameter/quoted-id/?', function() {
    var source = "SELECT 'x', ${db}.`t` WHERE id = ?";
    var t = tableFor(source, 'hive');
    var seq = syntaxSequence(t.table, t.leaves);
    var raws = seq.map(function(s) { return s.raw; });
    assert.ok(raws.indexOf("'x'") >= 0, 'string leaf must appear in syntax sequence');
    assert.ok(raws.indexOf('${db}') >= 0, 'parameter leaf must appear');
    assert.ok(raws.indexOf('`t`') >= 0, 'quoted-identifier must appear');
    assert.ok(raws.indexOf('?') >= 0, 'positional parameter must appear');
    // Exact expected non-trivia syntax order
    var expected = ['SELECT', "'x'", ',', '${db}', '.', '`t`', 'WHERE', 'id', '=', '?'];
    assert.deepStrictEqual(raws, expected, 'syntax sequence raws mismatch\n' + JSON.stringify(seq, null, 2));
    seq.forEach(function(entry) {
        assert.ok(entry.channel === 'code' || entry.channel === 'protected', 'syntax channel');
        assert.strictEqual(entry.span.end - entry.span.start, entry.raw.length);
        assert.strictEqual(t.source.slice(entry.span.start, entry.span.end), entry.raw);
    });
});

test('I1 protected-only fragments have non-empty syntax view', function() {
    ["'x'", '${p}', '`quoted`', '\\'].forEach(function(source) {
        var t = tableFor(source, 'hive');
        assert.ok(t.table.syntaxLeafCount() > 0, 'syntaxLeafCount for ' + JSON.stringify(source));
        var seq = syntaxSequence(t.table, t.leaves);
        assert.ok(seq.length > 0, 'sequence for ' + JSON.stringify(source));
        // remainder / statement presence: protected-only must not look empty
        var ranges = t.table.statementRanges();
        assert.ok(Array.isArray(ranges));
        // At least one range covering the syntax content when source non-empty
        if (source.length > 0 && t.leaves.some(function(l) { return l.channel !== 'trivia'; })) {
            assert.ok(ranges.length >= 1, 'statement range for protected-only ' + JSON.stringify(source));
        }
    });
});

test('I1 unknown is atomic syntax leaf (no false adjacency across it)', function() {
    var source = 'SELECT \\ FROM t';
    var t = tableFor(source, 'hive');
    var unknownIdx = -1;
    for (var i = 0; i < t.leaves.length; i++) {
        if (t.leaves[i].kind === 'unknown') {
            unknownIdx = i;
            break;
        }
    }
    assert.ok(unknownIdx >= 0, 'unknown leaf present');
    assert.strictEqual(typeof t.table.syntaxOrdinalOfLeaf, 'function');
    var ord = t.table.syntaxOrdinalOfLeaf(unknownIdx);
    assert.ok(typeof ord === 'number');
    var prev = t.table.previousSyntaxLeafIndex(unknownIdx);
    var next = t.table.nextSyntaxLeafIndex(unknownIdx);
    if (prev !== null) {
        assert.strictEqual(t.table.nextSyntaxLeafIndex(prev), unknownIdx);
    }
    if (next !== null) {
        assert.strictEqual(t.table.previousSyntaxLeafIndex(next), unknownIdx);
    }
});

test('I1 parser cursor advanceSyntax visits protected leaves', function() {
    var source = "SELECT 'x', ${db}.`t` WHERE id = ?";
    var t = tableFor(source, 'hive');
    var cursor = cursorMod.createTokenCursor(t.table);
    assert.strictEqual(typeof cursor.advanceSyntax, 'function', 'advanceSyntax required');
    assert.strictEqual(typeof cursor.peekSyntax, 'function', 'peekSyntax required');
    // Misleading code-only parser APIs must not be the primary path
    assert.strictEqual(typeof cursor.advanceCode, 'undefined', 'advanceCode must be removed');
    assert.strictEqual(typeof cursor.peekCode, 'undefined', 'peekCode must be removed');

    var visited = [];
    // Position at first syntax leaf
    while (!cursor.isAtEnd()) {
        var leaf = cursor.current();
        if (leaf && (leaf.channel === 'code' || leaf.channel === 'protected')) {
            visited.push(leaf.raw);
            if (!cursor.advanceSyntax()) break;
        } else {
            if (!cursor.advance()) break;
        }
    }
    assert.ok(visited.indexOf("'x'") >= 0);
    assert.ok(visited.indexOf('${db}') >= 0);
    assert.ok(visited.indexOf('`t`') >= 0);
    assert.ok(visited.indexOf('?') >= 0);
});

test('I1 delimiter still ignores punctuation inside protected raw', function() {
    var t = tableFor("SELECT '(;[]' -- )\nFROM t");
    var issues = t.table.structuralIssues();
    assert.strictEqual(issues.length, 0);
    for (var i = 0; i < t.leaves.length; i++) {
        if (t.leaves[i].channel === 'code') {
            assert.strictEqual(t.table.depthBefore(i), 0);
        }
    }
});

// =============================================================================
// I2: real immutable arrays
// =============================================================================
test('I2 statementRanges is real frozen Array; callback cannot mutate', function() {
    var t = tableFor('SELECT 1; SELECT 2;');
    var ranges = t.table.statementRanges();
    assertImmutableArray(ranges, 'statementRanges');
    // stable snapshot
    var ranges2 = t.table.statementRanges();
    assert.strictEqual(ranges, ranges2, 'repeated statementRanges should return cached snapshot');
});

test('I2 structuralIssues is real frozen Array', function() {
    var t = tableFor('SELECT (a');
    var issues = t.table.structuralIssues();
    assertImmutableArray(issues, 'structuralIssues');
    assert.strictEqual(t.table.structuralIssues(), issues, 'cached structuralIssues');
});

test('I2 dialect capabilities immutable real Array', function() {
    var hive = dialects.getDialect('hive');
    var caps = hive.listCapabilities();
    assertImmutableArray(caps, 'listCapabilities');
    assert.strictEqual(hive.listCapabilities(), caps, 'cached capabilities');
    var ops = hive.listOperatorSemantics();
    assertImmutableArray(ops, 'listOperatorSemantics');
});

test('I2 invariant failures immutable real Array', function() {
    var result = invariants.validateSyntaxInvariants({
        root: { id: 0, kind: 'program', span: { start: 0, end: 0 }, leafRange: { start: 0, end: 0 } },
        leaves: [],
        source: ''
    });
    assert.strictEqual(result.ok, false, 'missing children must fail');
    assertImmutableArray(result.failures, 'invariant failures');
});

// =============================================================================
// I3: fail-closed invariants
// =============================================================================
test('I3 missing children fails', function() {
    var r = invariants.validateSyntaxInvariants({
        root: { id: 0, kind: 'program', span: { start: 0, end: 0 }, leafRange: { start: 0, end: 0 } },
        leaves: [],
        source: ''
    });
    assert.strictEqual(r.ok, false);
    assert.ok(r.failures.length >= 1);
});

test('I3 children object not array fails', function() {
    var r = invariants.validateSyntaxInvariants({
        root: {
            id: 0,
            kind: 'program',
            span: { start: 0, end: 0 },
            leafRange: { start: 0, end: 0 },
            children: { 0: null }
        },
        leaves: [],
        source: ''
    });
    assert.strictEqual(r.ok, false);
});

test('I3 program direct opaque child fails', function() {
    var source = 'SELECT 1';
    var leaves = lex(source).leaves;
    var r = invariants.validateSyntaxInvariants({
        root: {
            id: 0,
            kind: 'program',
            span: { start: 0, end: source.length },
            leafRange: { start: 0, end: leaves.length },
            children: [{
                id: 1,
                kind: 'opaque',
                span: { start: 0, end: source.length },
                leafRange: { start: 0, end: leaves.length },
                reasonCode: 'X',
                capabilityId: null,
                boundary: 'statement'
            }]
        },
        leaves: leaves,
        source: source
    });
    assert.strictEqual(r.ok, false);
    assert.ok(r.failures.some(function(f) {
        return /statement|child|kind/i.test(f.code + ' ' + f.message);
    }));
});

test('I3 unknown kind fails', function() {
    var r = invariants.validateSyntaxInvariants({
        root: {
            id: 0,
            kind: 'program',
            span: { start: 0, end: 0 },
            leafRange: { start: 0, end: 0 },
            children: [{
                id: 1,
                kind: 'alien',
                span: { start: 0, end: 0 },
                leafRange: { start: 0, end: 0 },
                statementKind: 'empty',
                bodyChildId: null,
                children: []
            }]
        },
        leaves: [],
        source: ''
    });
    assert.strictEqual(r.ok, false);
});

test('I3 illegal statementKind fails', function() {
    var r = invariants.validateSyntaxInvariants({
        root: {
            id: 0,
            kind: 'program',
            span: { start: 0, end: 0 },
            leafRange: { start: 0, end: 0 },
            children: [{
                id: 1,
                kind: 'statement',
                span: { start: 0, end: 0 },
                leafRange: { start: 0, end: 0 },
                statementKind: 'merge',
                bodyChildId: null,
                children: []
            }]
        },
        leaves: [],
        source: ''
    });
    assert.strictEqual(r.ok, false);
});

test('I3 list missing fields / bad separator type fails', function() {
    var source = 'SELECT 1, 2';
    var leaves = lex(source).leaves;
    var list = {
        id: 2,
        kind: 'list',
        span: { start: 0, end: source.length },
        leafRange: { start: 0, end: leaves.length },
        // missing listRole / separatorLeafIds
        children: []
    };
    var r = invariants.validateSyntaxInvariants({
        root: {
            id: 0,
            kind: 'program',
            span: { start: 0, end: source.length },
            leafRange: { start: 0, end: leaves.length },
            children: [{
                id: 1,
                kind: 'statement',
                span: { start: 0, end: source.length },
                leafRange: { start: 0, end: leaves.length },
                statementKind: 'opaque',
                bodyChildId: 2,
                children: [list]
            }]
        },
        leaves: leaves,
        source: source
    });
    assert.strictEqual(r.ok, false);

    list.listRole = 'select-items';
    list.separatorLeafIds = ['not-a-number'];
    var r2 = invariants.validateSyntaxInvariants({
        root: {
            id: 0,
            kind: 'program',
            span: { start: 0, end: source.length },
            leafRange: { start: 0, end: leaves.length },
            children: [{
                id: 1,
                kind: 'statement',
                span: { start: 0, end: source.length },
                leafRange: { start: 0, end: leaves.length },
                statementKind: 'opaque',
                bodyChildId: 2,
                children: [list]
            }]
        },
        leaves: leaves,
        source: source
    });
    assert.strictEqual(r2.ok, false);
});

test('I3 source/leaves partition mismatch fails', function() {
    var source = 'SELECT 1';
    var leaves = lex(source).leaves;
    var broken = leaves.map(function(l, i) {
        if (i === 0) {
            return Object.assign({}, l, { raw: 'XXXXXX' });
        }
        return l;
    });
    // keep spans same length by padding - actually SELECT vs XXXXXX same length 6
    broken[0] = Object.assign({}, leaves[0], { raw: 'XXXXXX' });
    var r = invariants.validateSyntaxInvariants({
        root: {
            id: 0,
            kind: 'program',
            span: { start: 0, end: source.length },
            leafRange: { start: 0, end: broken.length },
            children: []
        },
        leaves: broken,
        source: source
    });
    assert.strictEqual(r.ok, false);
    assert.ok(r.failures.some(function(f) {
        return /partition|raw|source|slice|reconstruct/i.test(f.code + ' ' + f.message);
    }));
});

test('I3 opaque with children property fails even if empty array', function() {
    var source = 'SELECT 1';
    var leaves = lex(source).leaves;
    var opaque = {
        id: 2,
        kind: 'opaque',
        span: { start: 0, end: source.length },
        leafRange: { start: 0, end: leaves.length },
        reasonCode: 'SYN_UNMODELED_CONSTRUCT',
        capabilityId: null,
        boundary: 'statement',
        children: []
    };
    var r = invariants.validateSyntaxInvariants({
        root: {
            id: 0,
            kind: 'program',
            span: { start: 0, end: source.length },
            leafRange: { start: 0, end: leaves.length },
            children: [{
                id: 1,
                kind: 'statement',
                span: { start: 0, end: source.length },
                leafRange: { start: 0, end: leaves.length },
                statementKind: 'opaque',
                bodyChildId: 2,
                children: [opaque]
            }]
        },
        leaves: leaves,
        source: source
    });
    assert.strictEqual(r.ok, false);
});

test('I3 non-program empty leafRange fails', function() {
    var source = 'SELECT 1';
    var leaves = lex(source).leaves;
    var r = invariants.validateSyntaxInvariants({
        root: {
            id: 0,
            kind: 'program',
            span: { start: 0, end: source.length },
            leafRange: { start: 0, end: leaves.length },
            children: [{
                id: 1,
                kind: 'statement',
                span: { start: 0, end: 0 },
                leafRange: { start: 0, end: 0 },
                statementKind: 'empty',
                bodyChildId: null,
                children: []
            }]
        },
        leaves: leaves,
        source: source
    });
    assert.strictEqual(r.ok, false);
});

test('I3 broken token table fails validateTokenTableInvariants', function() {
    var source = 'SELECT (a)';
    var leaves = lex(source).leaves;
    var real = tokenTableMod.buildStructuralTokenTable(leaves, source);
    // Hand-broken table with asymmetric match and wrong depth
    var openIdx = -1;
    var closeIdx = -1;
    for (var i = 0; i < leaves.length; i++) {
        if (leaves[i].channel === 'code' && leaves[i].raw === '(') openIdx = i;
        if (leaves[i].channel === 'code' && leaves[i].raw === ')') closeIdx = i;
    }
    assert.ok(openIdx >= 0 && closeIdx >= 0);
    var broken = {
        leafCount: function() { return leaves.length; },
        syntaxLeafCount: function() { return real.syntaxLeafCount(); },
        codeLeafCount: function() { return real.codeLeafCount(); },
        matchingDelimiterIndex: function(idx) {
            if (idx === openIdx) return closeIdx;
            if (idx === closeIdx) return null; // asymmetric
            return null;
        },
        depthBefore: function() { return 0; },
        depthAfter: function(idx) {
            if (idx === openIdx) return 0; // wrong: should be 1
            return 0;
        },
        previousSyntaxLeafIndex: function() { return null; },
        nextSyntaxLeafIndex: function() { return null; },
        syntaxOrdinalOfLeaf: function() { return 0; },
        leafIndexOfSyntaxOrdinal: function() { return 0; },
        previousCodeLeafIndex: function() { return null; },
        nextCodeLeafIndex: function() { return null; },
        codeOrdinalOfLeaf: function() { return 0; },
        leafIndexOfCodeOrdinal: function() { return 0; },
        statementRanges: function() { return Object.freeze([]); },
        statementBoundariesReliable: function() { return true; },
        structuralIssues: function() { return Object.freeze([]); },
        rangeToSpan: function() { return { start: 0, end: 0 }; },
        normalizedWord: function() { return ''; },
        codeWordsEqual: function() { return false; },
        getLeaf: function(i) { return leaves[i]; }
    };
    var result = invariants.validateTokenTableInvariants(broken, leaves);
    assert.strictEqual(result.ok, false, 'hand-broken table must fail');
    assert.ok(result.failures.length >= 1);
});

// =============================================================================
// I4: typed CST child facts (type-level + runtime)
// =============================================================================
test('I4 positive tree with bodyChildId / valueChildId passes', function() {
    var source = 'SELECT 1';
    var leaves = lex(source).leaves;
    var opaque = {
        id: 2,
        kind: 'opaque',
        span: { start: 0, end: source.length },
        leafRange: { start: 0, end: leaves.length },
        reasonCode: 'SYN_UNMODELED_CONSTRUCT',
        capabilityId: null,
        boundary: 'statement'
    };
    var stmt = {
        id: 1,
        kind: 'statement',
        span: { start: 0, end: source.length },
        leafRange: { start: 0, end: leaves.length },
        statementKind: 'opaque',
        bodyChildId: 2,
        children: [opaque]
    };
    var root = {
        id: 0,
        kind: 'program',
        span: { start: 0, end: source.length },
        leafRange: { start: 0, end: leaves.length },
        children: [stmt]
    };
    var r = invariants.validateSyntaxInvariants({ root: root, leaves: leaves, source: source });
    assert.strictEqual(r.ok, true, JSON.stringify(r.failures));
});

test('I4 orphan bodyChildId fails', function() {
    var source = 'SELECT 1';
    var leaves = lex(source).leaves;
    var opaque = {
        id: 2,
        kind: 'opaque',
        span: { start: 0, end: source.length },
        leafRange: { start: 0, end: leaves.length },
        reasonCode: 'SYN_UNMODELED_CONSTRUCT',
        capabilityId: null,
        boundary: 'statement'
    };
    var stmt = {
        id: 1,
        kind: 'statement',
        span: { start: 0, end: source.length },
        leafRange: { start: 0, end: leaves.length },
        statementKind: 'opaque',
        bodyChildId: 999,
        children: [opaque]
    };
    var root = {
        id: 0,
        kind: 'program',
        span: { start: 0, end: source.length },
        leafRange: { start: 0, end: leaves.length },
        children: [stmt]
    };
    var r = invariants.validateSyntaxInvariants({ root: root, leaves: leaves, source: source });
    assert.strictEqual(r.ok, false);
});

// =============================================================================
// I5: multi-fixity operators
// =============================================================================
test('I5 + and - have both prefix and infix semantics', function() {
    var hive = dialects.getDialect('hive');
    assert.strictEqual(typeof hive.getOperatorSemantics, 'function');
    var plusPrefix = hive.getOperatorSemantics('+', 'prefix');
    var plusInfix = hive.getOperatorSemantics('+', 'infix');
    var minusPrefix = hive.getOperatorSemantics('-', 'postfix') || hive.getOperatorSemantics('-', 'prefix');
    var minusInfix = hive.getOperatorSemantics('-', 'infix');
    assert.ok(plusPrefix, '+ prefix required');
    assert.ok(plusInfix, '+ infix required');
    assert.ok(hive.getOperatorSemantics('-', 'prefix'), '- prefix required');
    assert.ok(minusInfix, '- infix required');
    assert.ok(
        plusPrefix.form === 'symbol' ||
            plusPrefix.form === 'keyword' ||
            plusPrefix.form === 'compound' ||
            plusPrefix.form === 'special',
        '+ prefix form must be a declared OperatorForm'
    );
    var empty1 = hive.listOperatorSemanticsForKey('__no_such_operator__');
    var empty2 = hive.listOperatorSemanticsForKey('__no_such_operator__');
    assert.strictEqual(empty1, empty2, 'unknown operator key must return stable empty array identity');
    assert.strictEqual(empty1.length, 0);
    assert.ok(Object.isFrozen(empty1));
    // list must include multiple entries for +
    var all = hive.listOperatorSemantics();
    var plusEntries = all.filter(function(op) { return op.key === '+'; });
    assert.ok(plusEntries.length >= 2, '+ must have >=2 fixity entries, got ' + plusEntries.length);
    // old single-arity-only API must not be the only path
    var listed = hive.listOperatorSemanticsForKey ? hive.listOperatorSemanticsForKey('+') : plusEntries;
    assert.ok(listed.length >= 2);
});

// =============================================================================
// Minors
// =============================================================================
test('minor cursor rejects invalid initial index', function() {
    var t = tableFor('SELECT 1');
    assert.throws(function() {
        cursorMod.createTokenCursor(t.table, -1);
    }, /out of range|invalid|bounds/i);
    assert.throws(function() {
        cursorMod.createTokenCursor(t.table, 1.5);
    }, /out of range|invalid|bounds/i);
    assert.throws(function() {
        cursorMod.createTokenCursor(t.table, t.leaves.length + 5);
    }, /out of range|invalid|bounds/i);
});

test('minor unmatched closer/mixed preserve reliable prefix', function() {
    var closer = tableFor('SELECT 1; SELECT ) x; SELECT 3');
    assert.strictEqual(closer.table.statementBoundariesReliable(), false);
    var cr = closer.table.statementRanges();
    assert.ok(cr.length >= 2, 'prefix preserved after unmatched closer, got ' + cr.length);
    var first = closer.leaves.slice(cr[0].start, cr[0].end).map(function(l) { return l.raw; }).join('');
    assert.ok(first.indexOf('1') >= 0 && first.indexOf(';') >= 0);

    var mixed = tableFor('SELECT 1; SELECT (a]; SELECT 3');
    assert.strictEqual(mixed.table.statementBoundariesReliable(), false);
    var mr = mixed.table.statementRanges();
    assert.ok(mr.length >= 2, 'prefix preserved after mixed delimiter, got ' + mr.length);
});

// Root runtime still lexSql only
test('root runtime keys only lexSql', function() {
    assert.deepStrictEqual(Object.keys(core).sort(), ['lexSql']);
});

// =============================================================================
// Invariant Contract Closure — CST fail-open counterexamples
// =============================================================================

function assertFails(label, result, codeHint) {
    assert.strictEqual(result.ok, false, label + ' must fail-closed, got ok=true');
    assert.ok(result.failures.length >= 1, label + ' must report failures');
    if (codeHint) {
        assert.ok(
            result.failures.some(function(f) {
                return codeHint.test(f.code + ' ' + f.message);
            }),
            label + ' expected failure matching ' + codeHint + ', got ' +
                result.failures.map(function(f) { return f.code; }).join(',')
        );
    }
}

function validOpaqueTree(source) {
    var leaves = lex(source).leaves;
    var opaque = {
        id: 2,
        kind: 'opaque',
        span: { start: 0, end: source.length },
        leafRange: { start: 0, end: leaves.length },
        reasonCode: 'SYN_UNMODELED_CONSTRUCT',
        capabilityId: null,
        boundary: 'statement'
    };
    return {
        leaves: leaves,
        root: {
            id: 0,
            kind: 'program',
            span: { start: 0, end: source.length },
            leafRange: { start: 0, end: leaves.length },
            children: [{
                id: 1,
                kind: 'statement',
                span: { start: 0, end: source.length },
                leafRange: { start: 0, end: leaves.length },
                statementKind: 'opaque',
                bodyChildId: 2,
                children: [opaque]
            }]
        }
    };
}

test('closure A1 empty program children with SQL syntax fails', function() {
    var source = 'SELECT 1';
    var leaves = lex(source).leaves;
    var r = invariants.validateSyntaxInvariants({
        root: {
            id: 0,
            kind: 'program',
            span: { start: 0, end: source.length },
            leafRange: { start: 0, end: leaves.length },
            children: []
        },
        leaves: leaves,
        source: source
    });
    assertFails('A1', r, /ROOT_COVERAGE|empty children|syntax/i);
});

test('closure A2 query statement null bodyChildId fails', function() {
    var source = 'SELECT 1';
    var leaves = lex(source).leaves;
    var r = invariants.validateSyntaxInvariants({
        root: {
            id: 0,
            kind: 'program',
            span: { start: 0, end: source.length },
            leafRange: { start: 0, end: leaves.length },
            children: [{
                id: 1,
                kind: 'statement',
                span: { start: 0, end: source.length },
                leafRange: { start: 0, end: leaves.length },
                statementKind: 'query',
                bodyChildId: null,
                children: []
            }]
        },
        leaves: leaves,
        source: source
    });
    assertFails('A2', r, /RELATIONSHIP|bodyChildId|required/i);
});

test('closure A3 alias.keywordLeafId out of owner fails', function() {
    var source = 'SELECT 1';
    var leaves = lex(source).leaves;
    var r = invariants.validateSyntaxInvariants({
        root: {
            id: 0,
            kind: 'program',
            span: { start: 0, end: source.length },
            leafRange: { start: 0, end: leaves.length },
            children: [{
                id: 1,
                kind: 'statement',
                span: { start: 0, end: source.length },
                leafRange: { start: 0, end: leaves.length },
                statementKind: 'opaque',
                bodyChildId: 2,
                children: [{
                    id: 2,
                    kind: 'relation',
                    span: { start: 0, end: source.length },
                    leafRange: { start: 0, end: leaves.length },
                    relationKind: 'table',
                    alias: { keywordLeafId: 999, nameLeafRange: { start: 0, end: 1 } },
                    bodyChildId: null,
                    children: []
                }]
            }]
        },
        leaves: leaves,
        source: source
    });
    assertFails('A3', r, /OWNER_REFERENCE|keywordLeafId|out of/i);
});

test('closure A4 clause head/body range outside owner fails', function() {
    var source = 'SELECT 1';
    var leaves = lex(source).leaves;
    var r = invariants.validateSyntaxInvariants({
        root: {
            id: 0,
            kind: 'program',
            span: { start: 0, end: source.length },
            leafRange: { start: 0, end: leaves.length },
            children: [{
                id: 1,
                kind: 'statement',
                span: { start: 0, end: source.length },
                leafRange: { start: 0, end: leaves.length },
                statementKind: 'opaque',
                bodyChildId: 2,
                children: [{
                    id: 2,
                    kind: 'clause',
                    span: { start: 0, end: source.length },
                    leafRange: { start: 0, end: leaves.length },
                    clauseKind: 'select',
                    headLeafRange: { start: 0, end: leaves.length + 2 },
                    bodyLeafRange: { start: 0, end: 1 },
                    children: []
                }]
            }]
        },
        leaves: leaves,
        source: source
    });
    assertFails('A4', r, /OWNER_REFERENCE|headLeafRange|out of/i);
});

test('closure A5 CTE queryChildId pointing to ListNode fails', function() {
    var source = 'SELECT 1';
    var leaves = lex(source).leaves;
    var listNode = {
        id: 3,
        kind: 'list',
        span: { start: 0, end: source.length },
        leafRange: { start: 0, end: leaves.length },
        listRole: 'select-items',
        separatorLeafIds: [],
        children: []
    };
    var r = invariants.validateSyntaxInvariants({
        root: {
            id: 0,
            kind: 'program',
            span: { start: 0, end: source.length },
            leafRange: { start: 0, end: leaves.length },
            children: [{
                id: 1,
                kind: 'statement',
                span: { start: 0, end: source.length },
                leafRange: { start: 0, end: leaves.length },
                statementKind: 'opaque',
                bodyChildId: 2,
                children: [{
                    id: 2,
                    kind: 'cte',
                    span: { start: 0, end: source.length },
                    leafRange: { start: 0, end: leaves.length },
                    nameLeafRange: { start: 0, end: 1 },
                    queryChildId: 3,
                    columnListChildId: null,
                    children: [listNode]
                }]
            }]
        },
        leaves: leaves,
        source: source
    });
    assertFails('A5', r, /RELATIONSHIP|queryChildId|query\|opaque|list/i);
});

test('closure A6 ListNode children ExpressionNode fails', function() {
    var source = 'SELECT 1';
    var leaves = lex(source).leaves;
    var expr = {
        id: 3,
        kind: 'expression',
        span: { start: 0, end: source.length },
        leafRange: { start: 0, end: leaves.length },
        expressionKind: 'literal',
        operatorLeafIds: [],
        children: []
    };
    var r = invariants.validateSyntaxInvariants({
        root: {
            id: 0,
            kind: 'program',
            span: { start: 0, end: source.length },
            leafRange: { start: 0, end: leaves.length },
            children: [{
                id: 1,
                kind: 'statement',
                span: { start: 0, end: source.length },
                leafRange: { start: 0, end: leaves.length },
                statementKind: 'opaque',
                bodyChildId: 2,
                children: [{
                    id: 2,
                    kind: 'list',
                    span: { start: 0, end: source.length },
                    leafRange: { start: 0, end: leaves.length },
                    listRole: 'select-items',
                    separatorLeafIds: [],
                    children: [expr]
                }]
            }]
        },
        leaves: leaves,
        source: source
    });
    assertFails('A6', r, /RELATIONSHIP|list-item|expression/i);
});

test('closure A7 case condition and value same child fails', function() {
    var source = 'SELECT 1';
    var leaves = lex(source).leaves;
    var e1 = {
        id: 3,
        kind: 'expression',
        span: { start: 0, end: source.length },
        leafRange: { start: 0, end: leaves.length },
        expressionKind: 'literal',
        operatorLeafIds: [],
        children: []
    };
    var r = invariants.validateSyntaxInvariants({
        root: {
            id: 0,
            kind: 'program',
            span: { start: 0, end: source.length },
            leafRange: { start: 0, end: leaves.length },
            children: [{
                id: 1,
                kind: 'statement',
                span: { start: 0, end: source.length },
                leafRange: { start: 0, end: leaves.length },
                statementKind: 'opaque',
                bodyChildId: 2,
                children: [{
                    id: 2,
                    kind: 'case-branch',
                    span: { start: 0, end: source.length },
                    leafRange: { start: 0, end: leaves.length },
                    branchKind: 'when',
                    conditionChildId: 3,
                    valueChildId: 3,
                    children: [e1]
                }]
            }]
        },
        leaves: leaves,
        source: source
    });
    assertFails('A7', r, /RELATIONSHIP|distinct/i);
});

test('closure A8 opaque relation with extra structured child fails', function() {
    var source = 'SELECT 1';
    var leaves = lex(source).leaves;
    var mid = Math.max(1, Math.floor(leaves.length / 2));
    var span1 = leaves[0].span;
    var span2end = leaves[leaves.length - 1].span.end;
    var opq = {
        id: 3,
        kind: 'opaque',
        span: { start: 0, end: leaves[mid - 1].span.end },
        leafRange: { start: 0, end: mid },
        reasonCode: 'X',
        capabilityId: null,
        boundary: 'relation'
    };
    var extra = {
        id: 4,
        kind: 'expression',
        span: { start: leaves[mid].span.start, end: span2end },
        leafRange: { start: mid, end: leaves.length },
        expressionKind: 'literal',
        operatorLeafIds: [],
        children: []
    };
    var r = invariants.validateSyntaxInvariants({
        root: {
            id: 0,
            kind: 'program',
            span: { start: 0, end: source.length },
            leafRange: { start: 0, end: leaves.length },
            children: [{
                id: 1,
                kind: 'statement',
                span: { start: 0, end: source.length },
                leafRange: { start: 0, end: leaves.length },
                statementKind: 'opaque',
                bodyChildId: 2,
                children: [{
                    id: 2,
                    kind: 'relation',
                    span: { start: 0, end: source.length },
                    leafRange: { start: 0, end: leaves.length },
                    relationKind: 'opaque',
                    alias: null,
                    bodyChildId: 3,
                    children: [opq, extra]
                }]
            }]
        },
        leaves: leaves,
        source: source
    });
    assertFails('A8', r, /EXTRA_CHILD|unreferenced|RELATIONSHIP/i);
    void span1;
});

test('closure A9 illegal leaf kind/channel combo fails', function() {
    var source = 'SELECT 1';
    var leaves = lex(source).leaves.map(function(l, i) {
        if (i === 0) {
            return Object.assign({}, l, { kind: 'string', channel: 'code' });
        }
        return l;
    });
    var r = invariants.validateSyntaxInvariants({
        root: {
            id: 0,
            kind: 'program',
            span: { start: 0, end: source.length },
            leafRange: { start: 0, end: leaves.length },
            children: []
        },
        leaves: leaves,
        source: source
    });
    assertFails('A9', r, /LEAF_PARTITION|kind\/channel|mismatch/i);
});

test('closure A10 non-string source fails', function() {
    var r = invariants.validateSyntaxInvariants({
        root: {
            id: 0,
            kind: 'program',
            span: { start: 0, end: 0 },
            leafRange: { start: 0, end: 0 },
            children: []
        },
        leaves: [],
        source: 42
    });
    assertFails('A10', r, /SOURCE_TYPE|primitive string/i);
});

// Positive: trivia-only may have empty children
test('closure positive trivia-only empty program ok', function() {
    var source = '  \n  ';
    var leaves = lex(source).leaves;
    var r = invariants.validateSyntaxInvariants({
        root: {
            id: 0,
            kind: 'program',
            span: { start: 0, end: source.length },
            leafRange: { start: 0, end: leaves.length },
            children: []
        },
        leaves: leaves,
        source: source
    });
    assert.strictEqual(r.ok, true, JSON.stringify(r.failures));
});

test('closure positive valid opaque tree ok', function() {
    var t = validOpaqueTree('SELECT 1');
    var r = invariants.validateSyntaxInvariants({
        root: t.root,
        leaves: t.leaves,
        source: 'SELECT 1'
    });
    assert.strictEqual(r.ok, true, JSON.stringify(r.failures));
});

// =============================================================================
// Token-table independent validation counterexamples
// =============================================================================

function cloneTable(real, overrides) {
    var t = {};
    [
        'leafCount', 'syntaxLeafCount', 'codeLeafCount',
        'previousSyntaxLeafIndex', 'nextSyntaxLeafIndex',
        'syntaxOrdinalOfLeaf', 'leafIndexOfSyntaxOrdinal',
        'previousCodeLeafIndex', 'nextCodeLeafIndex',
        'codeOrdinalOfLeaf', 'leafIndexOfCodeOrdinal',
        'depthBefore', 'depthAfter', 'matchingDelimiterIndex',
        'statementRanges', 'statementBoundariesReliable', 'structuralIssues',
        'rangeToSpan', 'normalizedWord', 'codeWordsEqual', 'getLeaf'
    ].forEach(function(k) {
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

test('closure B1 missing syntax API fails', function() {
    var source = 'SELECT 1';
    var leaves = lex(source).leaves;
    var r = invariants.validateTokenTableInvariants({
        leafCount: function() { return leaves.length; },
        codeLeafCount: function() { return 0; },
        matchingDelimiterIndex: function() { return null; },
        depthBefore: function() { return 0; },
        depthAfter: function() { return 0; },
        statementRanges: function() { return Object.freeze([]); },
        statementBoundariesReliable: function() { return true; },
        structuralIssues: function() { return Object.freeze([]); },
        getLeaf: function(i) { return leaves[i]; }
    }, leaves);
    assertFails('B1', r, /TOKEN_TABLE|missing required API|syntax/i);
});

test('closure B2 syntaxLeafCount 0 with syntax leaves fails', function() {
    var source = 'SELECT 1';
    var leaves = lex(source).leaves;
    var real = tokenTableMod.buildStructuralTokenTable(leaves, source);
    var r = invariants.validateTokenTableInvariants(cloneTable(real, {
        syntaxLeafCount: function() { return 0; }
    }), leaves);
    assertFails('B2', r, /ORDINAL|syntaxLeafCount/i);
});

test('closure B3 deleted syntax adjacency fails', function() {
    var source = 'SELECT 1';
    var leaves = lex(source).leaves;
    var real = tokenTableMod.buildStructuralTokenTable(leaves, source);
    var r = invariants.validateTokenTableInvariants(cloneTable(real, {
        previousSyntaxLeafIndex: function() { return null; },
        nextSyntaxLeafIndex: function() { return null; }
    }), leaves);
    assertFails('B3', r, /ADJACENCY/i);
});

test('closure B4 code count mismatch fails', function() {
    var source = 'SELECT 1';
    var leaves = lex(source).leaves;
    var real = tokenTableMod.buildStructuralTokenTable(leaves, source);
    var r = invariants.validateTokenTableInvariants(cloneTable(real, {
        codeLeafCount: function() { return 0; }
    }), leaves);
    assertFails('B4', r, /ORDINAL|codeLeafCount/i);
});

test('closure B5 depth always 0 with unmatched opener fails', function() {
    var source = 'SELECT (a';
    var leaves = lex(source).leaves;
    var real = tokenTableMod.buildStructuralTokenTable(leaves, source);
    var r = invariants.validateTokenTableInvariants(cloneTable(real, {
        depthBefore: function() { return 0; },
        depthAfter: function() { return 0; }
    }), leaves);
    assertFails('B5', r, /DEPTH_CONSISTENCY/i);
});

test('closure B6 fake pair on non-delimiter fails', function() {
    var source = 'SELECT 1';
    var leaves = lex(source).leaves;
    var real = tokenTableMod.buildStructuralTokenTable(leaves, source);
    // Find two code leaves that are not delimiters
    var a = -1;
    var b = -1;
    for (var i = 0; i < leaves.length; i++) {
        if (leaves[i].channel === 'code' && leaves[i].raw !== '(' && leaves[i].raw !== ')') {
            if (a < 0) a = i;
            else if (b < 0) { b = i; break; }
        }
    }
    assert.ok(a >= 0 && b >= 0);
    var r = invariants.validateTokenTableInvariants(cloneTable(real, {
        matchingDelimiterIndex: function(idx) {
            if (idx === a) return b;
            if (idx === b) return a;
            return real.matchingDelimiterIndex(idx);
        }
    }), leaves);
    assertFails('B6', r, /DELIMITER_PAIR/i);
});

test('closure B7 negative count fails', function() {
    var source = 'SELECT 1';
    var leaves = lex(source).leaves;
    var real = tokenTableMod.buildStructuralTokenTable(leaves, source);
    var r = invariants.validateTokenTableInvariants(cloneTable(real, {
        syntaxLeafCount: function() { return -1; }
    }), leaves);
    assertFails('B7', r, /TOKEN_TABLE|ORDINAL|non-negative|integer/i);
});

test('closure B8 throwing method fails closed', function() {
    var source = 'SELECT 1';
    var leaves = lex(source).leaves;
    var real = tokenTableMod.buildStructuralTokenTable(leaves, source);
    var r = invariants.validateTokenTableInvariants(cloneTable(real, {
        syntaxLeafCount: function() { throw new Error('boom'); }
    }), leaves);
    assertFails('B8', r, /TOKEN_TABLE|threw|boom/i);
});

test('closure positive real token table ok', function() {
    var source = 'SELECT (a[1])';
    var leaves = lex(source).leaves;
    var real = tokenTableMod.buildStructuralTokenTable(leaves, source);
    var r = invariants.validateTokenTableInvariants(real, leaves);
    assert.strictEqual(r.ok, true, JSON.stringify(r.failures));
});


// Residual Important fail-opens from independent review
test('closure residual empty statement must not own SQL syntax', function() {
    var source = 'SELECT 1';
    var leaves = lex(source).leaves;
    var r = invariants.validateSyntaxInvariants({
        root: {
            id: 0,
            kind: 'program',
            span: { start: 0, end: source.length },
            leafRange: { start: 0, end: leaves.length },
            children: [{
                id: 1,
                kind: 'statement',
                span: { start: 0, end: source.length },
                leafRange: { start: 0, end: leaves.length },
                statementKind: 'empty',
                bodyChildId: null,
                children: []
            }]
        },
        leaves: leaves,
        source: source
    });
    assertFails('empty-stmt-sql', r, /RELATIONSHIP|empty statement|non-semicolon/i);
});

test('closure residual empty statementRanges fails', function() {
    var source = 'SELECT 1; SELECT 2';
    var leaves = lex(source).leaves;
    var real = tokenTableMod.buildStructuralTokenTable(leaves, source);
    var r = invariants.validateTokenTableInvariants(cloneTable(real, {
        statementRanges: function() { return Object.freeze([]); }
    }), leaves);
    assertFails('empty-ranges', r, /STATEMENT_RANGES/i);
});

test('closure residual lie statementBoundariesReliable fails', function() {
    var source = 'SELECT (a';
    var leaves = lex(source).leaves;
    var real = tokenTableMod.buildStructuralTokenTable(leaves, source);
    var r = invariants.validateTokenTableInvariants(cloneTable(real, {
        statementBoundariesReliable: function() { return true; }
    }), leaves);
    assertFails('lie-reliable', r, /TOKEN_TABLE|statementBoundariesReliable/i);
});

test('closure residual wrong structural issue fails', function() {
    var source = 'SELECT (a';
    var leaves = lex(source).leaves;
    var real = tokenTableMod.buildStructuralTokenTable(leaves, source);
    var r = invariants.validateTokenTableInvariants(cloneTable(real, {
        structuralIssues: function() {
            return Object.freeze([{
                code: 'STRUCT_UNRELIABLE_STATEMENT_BOUNDARY',
                leafIndex: 0,
                message: 'forged'
            }]);
        }
    }), leaves);
    assertFails('wrong-issue', r, /DELIMITER_PAIR|missing expected structural issue/i);
});

test('closure residual statementBoundariesReliable throw fails', function() {
    var source = 'SELECT 1';
    var leaves = lex(source).leaves;
    var real = tokenTableMod.buildStructuralTokenTable(leaves, source);
    var r = invariants.validateTokenTableInvariants(cloneTable(real, {
        statementBoundariesReliable: function() { throw new Error('reliable-boom'); }
    }), leaves);
    assertFails('reliable-throw', r, /TOKEN_TABLE|threw|reliable-boom/i);
});
test('closure residual fabricated structural issue on clean SQL fails', function() {
    var source = 'SELECT 1';
    var leaves = lex(source).leaves;
    var real = tokenTableMod.buildStructuralTokenTable(leaves, source);
    var r = invariants.validateTokenTableInvariants(cloneTable(real, {
        structuralIssues: function() {
            return Object.freeze([{
                code: 'STRUCT_UNMATCHED_OPENER',
                leafIndex: 0,
                message: 'fabricated'
            }]);
        }
    }), leaves);
    assertFails('fabricated-issue', r, /DELIMITER_PAIR|unexpected structural issue/i);
});

// =============================================================================


if (failures.length > 0) {
    console.error('\n' + failures.length + ' hardening test(s) failed');
    failures.forEach(function(f) {
        console.error(' - ' + f.name + ': ' + f.error.stack);
    });
    process.exit(1);
}

console.log('v2 Wave 2A hardening tests passed');
