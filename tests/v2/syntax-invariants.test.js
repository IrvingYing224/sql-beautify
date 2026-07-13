'use strict';

var assert = require('assert');
var fs = require('fs');
var path = require('path');

var root = path.join(__dirname, '..', '..');
var corePath = path.join(root, '.tmp', 'v2-core', 'core', 'index.js');
var invariantsPath = path.join(root, '.tmp', 'v2-core', 'core', 'syntax', 'invariants.js');
var tokenTablePath = path.join(root, '.tmp', 'v2-core', 'core', 'syntax', 'token-table.js');

assert.ok(fs.existsSync(corePath), 'build:v2-core required');
assert.ok(fs.existsSync(invariantsPath), 'invariants module must exist');

var core = require(corePath);
var invariants = require(invariantsPath);
var tokenTableMod = require(tokenTablePath);

assert.strictEqual(typeof invariants.validateSyntaxInvariants, 'function');
assert.deepStrictEqual(Object.keys(core).sort(), ['lexSql']);

function lex(source) {
    return core.lexSql(source);
}

function emptyProgram(source) {
    return {
        id: 0,
        kind: 'program',
        span: { start: 0, end: source.length },
        leafRange: { start: 0, end: 0 },
        children: []
    };
}

function makeOpaque(id, start, end, leafStart, leafEnd, boundary) {
    return {
        id: id,
        kind: 'opaque',
        span: { start: start, end: end },
        leafRange: { start: leafStart, end: leafEnd },
        reasonCode: 'SYN_UNMODELED_CONSTRUCT',
        boundary: boundary || 'statement'
    };
}

function makeStatement(id, start, end, leafStart, leafEnd, bodyChildId, children) {
    return {
        id: id,
        kind: 'statement',
        span: { start: start, end: end },
        leafRange: { start: leafStart, end: leafEnd },
        statementKind: bodyChildId === null ? 'empty' : 'opaque',
        bodyChildId: bodyChildId,
        children: children || []
    };
}

// ---------------------------------------------------------------------------
// Positive: empty source program
// ---------------------------------------------------------------------------
(function testEmptySource() {
    var source = '';
    var leaves = lex(source).leaves;
    var root = emptyProgram(source);
    root.leafRange = { start: 0, end: 0 };
    root.span = { start: 0, end: 0 };
    var result = invariants.validateSyntaxInvariants({
        root: root,
        leaves: leaves,
        source: source
    });
    assert.strictEqual(result.ok, true, JSON.stringify(result.failures));
    assert.ok(Array.isArray(result.failures));
    assert.strictEqual(Object.isFrozen(result.failures), true);
    console.log('  ok - empty source program');
})();

// ---------------------------------------------------------------------------
// Positive: single opaque covering full source
// ---------------------------------------------------------------------------
(function testFullOpaque() {
    var source = 'SELECT 1';
    var leaves = lex(source).leaves;
    var root = {
        id: 0,
        kind: 'program',
        span: { start: 0, end: source.length },
        leafRange: { start: 0, end: leaves.length },
        children: [
            makeStatement(1, 0, source.length, 0, leaves.length, 2, [
                makeOpaque(2, 0, source.length, 0, leaves.length)
            ])
        ]
    };
    var result = invariants.validateSyntaxInvariants({
        root: root,
        leaves: leaves,
        source: source
    });
    assert.strictEqual(result.ok, true, JSON.stringify(result.failures));
    console.log('  ok - full opaque tree');
})();

// ---------------------------------------------------------------------------
// Positive: two non-overlapping sibling statements
// ---------------------------------------------------------------------------
(function testTwoStatements() {
    var source = 'SELECT 1; SELECT 2';
    var leaves = lex(source).leaves;
    var table = tokenTableMod.buildStructuralTokenTable(leaves, source);
    var ranges = Array.from(table.statementRanges());
    assert.ok(ranges.length >= 1);

    var children = [];
    var nextId = 1;
    for (var i = 0; i < ranges.length; i++) {
        var range = ranges[i];
        var span = table.rangeToSpan(range);
        var opaqueId = nextId + 1;
        var stmt = makeStatement(nextId, span.start, span.end, range.start, range.end, opaqueId, [
            makeOpaque(opaqueId, span.start, span.end, range.start, range.end)
        ]);
        children.push(stmt);
        nextId = opaqueId + 1;
    }
    var root = {
        id: 0,
        kind: 'program',
        span: { start: 0, end: source.length },
        leafRange: { start: 0, end: leaves.length },
        children: children
    };
    var result = invariants.validateSyntaxInvariants({
        root: root,
        leaves: leaves,
        source: source,
        tokenTable: table
    });
    assert.strictEqual(result.ok, true, JSON.stringify(result.failures));
    console.log('  ok - two sibling statements');
})();

// ---------------------------------------------------------------------------
// Fail-closed: leaf range out of bounds
// ---------------------------------------------------------------------------
(function testLeafRangeBounds() {
    var source = 'SELECT 1';
    var leaves = lex(source).leaves;
    var root = {
        id: 0,
        kind: 'program',
        span: { start: 0, end: source.length },
        leafRange: { start: 0, end: leaves.length + 5 },
        children: []
    };
    var result = invariants.validateSyntaxInvariants({
        root: root,
        leaves: leaves,
        source: source
    });
    assert.strictEqual(result.ok, false);
    assert.ok(result.failures.length >= 1);
    console.log('  ok - leaf range bounds fail-closed');
})();

// ---------------------------------------------------------------------------
// Fail-closed: span / leafRange mismatch
// ---------------------------------------------------------------------------
(function testSpanMismatch() {
    var source = 'SELECT 1';
    var leaves = lex(source).leaves;
    var root = {
        id: 0,
        kind: 'program',
        span: { start: 0, end: 1 },
        leafRange: { start: 0, end: leaves.length },
        children: []
    };
    var result = invariants.validateSyntaxInvariants({
        root: root,
        leaves: leaves,
        source: source
    });
    assert.strictEqual(result.ok, false);
    console.log('  ok - span/leafRange mismatch fail-closed');
})();

// ---------------------------------------------------------------------------
// Fail-closed: duplicate / non-contiguous ids
// ---------------------------------------------------------------------------
(function testDuplicateIds() {
    var source = 'SELECT 1';
    var leaves = lex(source).leaves;
    var opaque = makeOpaque(0, 0, source.length, 0, leaves.length);
    var root = {
        id: 0,
        kind: 'program',
        span: { start: 0, end: source.length },
        leafRange: { start: 0, end: leaves.length },
        children: [makeStatement(1, 0, source.length, 0, leaves.length, 0, [opaque])]
    };
    var result = invariants.validateSyntaxInvariants({
        root: root,
        leaves: leaves,
        source: source
    });
    assert.strictEqual(result.ok, false);
    console.log('  ok - duplicate ids fail-closed');
})();

// ---------------------------------------------------------------------------
// Fail-closed: sibling overlap
// ---------------------------------------------------------------------------
(function testSiblingOverlap() {
    var source = 'SELECT 1';
    var leaves = lex(source).leaves;
    // Need non-empty ranges - use partial leaf ranges that overlap
    var a = makeStatement(1, 0, 4, 0, Math.max(1, Math.floor(leaves.length / 2)), null, []);
    // force statementKind empty with empty children but non-empty range - adjust
    a.statementKind = 'empty';
    a.bodyChildId = null;
    var b = makeStatement(2, 2, source.length, 0, leaves.length, null, []);
    b.statementKind = 'empty';
    b.bodyChildId = null;
    var root = {
        id: 0,
        kind: 'program',
        span: { start: 0, end: source.length },
        leafRange: { start: 0, end: leaves.length },
        children: [a, b]
    };
    var result = invariants.validateSyntaxInvariants({
        root: root,
        leaves: leaves,
        source: source
    });
    assert.strictEqual(result.ok, false);
    console.log('  ok - sibling overlap fail-closed');
})();

// ---------------------------------------------------------------------------
// Fail-closed: child not contained by parent
// ---------------------------------------------------------------------------
(function testParentContainment() {
    var source = 'SELECT 1';
    var leaves = lex(source).leaves;
    var child = makeStatement(1, 0, source.length, 0, leaves.length, null, []);
    child.statementKind = 'empty';
    child.bodyChildId = null;
    var root = {
        id: 0,
        kind: 'program',
        span: { start: 0, end: 3 },
        leafRange: { start: 0, end: 1 },
        children: [child]
    };
    var result = invariants.validateSyntaxInvariants({
        root: root,
        leaves: leaves,
        source: source
    });
    assert.strictEqual(result.ok, false);
    console.log('  ok - parent containment fail-closed');
})();

// ---------------------------------------------------------------------------
// Fail-closed: shared child
// ---------------------------------------------------------------------------
(function testSharedChild() {
    var source = 'SELECT 1';
    var leaves = lex(source).leaves;
    var shared = makeOpaque(2, 0, source.length, 0, leaves.length);
    var stmtA = makeStatement(1, 0, source.length, 0, leaves.length, 2, [shared]);
    var stmtB = makeStatement(3, 0, source.length, 0, leaves.length, 2, [shared]);
    var root = {
        id: 0,
        kind: 'program',
        span: { start: 0, end: source.length },
        leafRange: { start: 0, end: leaves.length },
        children: [stmtA, stmtB]
    };
    var result = invariants.validateSyntaxInvariants({
        root: root,
        leaves: leaves,
        source: source
    });
    assert.strictEqual(result.ok, false);
    console.log('  ok - shared child fail-closed');
})();

// ---------------------------------------------------------------------------
// Fail-closed: opaque with children property
// ---------------------------------------------------------------------------
(function testOpaqueChildren() {
    var source = 'SELECT 1';
    var leaves = lex(source).leaves;
    var opaque = makeOpaque(2, 0, source.length, 0, leaves.length);
    opaque.children = [];
    var root = {
        id: 0,
        kind: 'program',
        span: { start: 0, end: source.length },
        leafRange: { start: 0, end: leaves.length },
        children: [makeStatement(1, 0, source.length, 0, leaves.length, 2, [opaque])]
    };
    var result = invariants.validateSyntaxInvariants({
        root: root,
        leaves: leaves,
        source: source
    });
    assert.strictEqual(result.ok, false);
    console.log('  ok - opaque children fail-closed');
})();

// ---------------------------------------------------------------------------
// Fail-closed: owner reference outside range
// ---------------------------------------------------------------------------
(function testOwnerReference() {
    var source = 'SELECT 1, 2';
    var leaves = lex(source).leaves;
    var list = {
        id: 2,
        kind: 'list',
        span: { start: 0, end: source.length },
        leafRange: { start: 0, end: leaves.length },
        listRole: 'select-items',
        separatorLeafIds: [leaves.length + 10],
        children: []
    };
    var root = {
        id: 0,
        kind: 'program',
        span: { start: 0, end: source.length },
        leafRange: { start: 0, end: leaves.length },
        children: [makeStatement(1, 0, source.length, 0, leaves.length, 2, [list])]
    };
    var result = invariants.validateSyntaxInvariants({
        root: root,
        leaves: leaves,
        source: source
    });
    assert.strictEqual(result.ok, false);
    console.log('  ok - owner reference out of range fail-closed');
})();

// ---------------------------------------------------------------------------
// Token table delimiter pair symmetry
// ---------------------------------------------------------------------------
(function testDelimiterSymmetry() {
    var source = 'SELECT (a)';
    var leaves = lex(source).leaves;
    var table = tokenTableMod.buildStructuralTokenTable(leaves, source);
    var result = invariants.validateTokenTableInvariants(table, leaves);
    assert.strictEqual(result.ok, true, JSON.stringify(result.failures));
    console.log('  ok - token table delimiter symmetry');
})();

// ---------------------------------------------------------------------------
// Ordinary illegal object returns structured failures, does not throw
// ---------------------------------------------------------------------------
(function testNoThrowOnIllegal() {
    var result = invariants.validateSyntaxInvariants({
        root: { id: 'x', kind: 'program' },
        leaves: [],
        source: ''
    });
    assert.strictEqual(result.ok, false);
    assert.ok(Array.isArray(result.failures));
    console.log('  ok - illegal object returns failures without throw');
})();

// Failures array must be real frozen array
(function testFailuresImmutability() {
    var source = 'SELECT 1';
    var leaves = lex(source).leaves;
    var result = invariants.validateSyntaxInvariants({
        root: {
            id: 0,
            kind: 'program',
            span: { start: 0, end: 1 },
            leafRange: { start: 0, end: leaves.length + 1 },
            children: []
        },
        leaves: leaves,
        source: source
    });
    assert.strictEqual(result.ok, false);
    assert.ok(Array.isArray(result.failures));
    assert.strictEqual(Object.isFrozen(result.failures), true);
    var before = result.failures.length;
    try {
        result.failures.push({ code: 'x', message: 'y' });
    } catch (_e) { /* ok */ }
    assert.strictEqual(result.failures.length, before);
    console.log('  ok - failures immutability');
})();

console.log('v2 syntax invariants tests passed');
