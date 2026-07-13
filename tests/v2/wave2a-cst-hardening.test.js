'use strict';

/**
 * Wave 2A CST / Program coverage / relationship contract regressions.
 * Production invariant surface only (not exhaustive token-table misuse).
 */
var assert = require('assert');
var fs = require('fs');
var path = require('path');

var root = path.join(__dirname, '..', '..');
var corePath = path.join(root, '.tmp', 'v2-core', 'core', 'index.js');
var tokenTablePath = path.join(root, '.tmp', 'v2-core', 'core', 'syntax', 'token-table.js');
var invariantsPath = path.join(root, '.tmp', 'v2-core', 'core', 'syntax', 'invariants.js');

assert.ok(fs.existsSync(corePath), 'build:v2-core required');
assert.ok(fs.existsSync(invariantsPath), 'invariants required');

var core = require(corePath);
var tokenTableMod = require(tokenTablePath);
var invariants = require(invariantsPath);

function lex(source) {
    return core.lexSql(source, { dialect: 'hive' });
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
        assert.ok(codeHint.test(joined), label + ' code/message mismatch:\n' + joined);
    }
}

function spanOfLeaves(leaves, range) {
    if (range.start === range.end) {
        if (leaves.length === 0) return { start: 0, end: 0 };
        if (range.start === 0) return { start: 0, end: 0 };
        if (range.start === leaves.length) {
            var last = leaves[leaves.length - 1];
            return { start: last.span.end, end: last.span.end };
        }
        return { start: leaves[range.start].span.start, end: leaves[range.start].span.start };
    }
    return {
        start: leaves[range.start].span.start,
        end: leaves[range.end - 1].span.end
    };
}

function programWith(children, leaves, source) {
    return {
        id: 0,
        kind: 'program',
        span: { start: 0, end: source.length },
        leafRange: { start: 0, end: leaves.length },
        children: children
    };
}

function opaqueStmtTree(source, leaves, range, boundary) {
    var span = spanOfLeaves(leaves, range);
    return {
        id: 1,
        kind: 'statement',
        statementKind: 'opaque',
        bodyChildId: 2,
        leafRange: range,
        span: span,
        children: [{
            id: 2,
            kind: 'opaque',
            reasonCode: 'SYN_UNMODELED_CONSTRUCT',
            boundary: boundary || 'statement',
            leafRange: range,
            span: span
        }]
    };
}

// --- Program coverage ---
test('final A1 partial statement coverage fails', function() {
    var source = 'SELECT 1; SELECT 2';
    var leaves = lex(source).leaves;
    var table = tokenTableMod.buildStructuralTokenTable(leaves, source);
    var onlyFirst = table.statementRanges()[0];
    var r = invariants.validateSyntaxInvariants({
        root: programWith([opaqueStmtTree(source, leaves, onlyFirst)], leaves, source),
        leaves: leaves,
        source: source
    });
    assert.strictEqual(r.ok, false);
    assertFails('A1', r, /ROOT_COVERAGE|statement count|expected/i);
});

test('final A2 false split SELECT 1 fails', function() {
    var source = 'SELECT 1';
    var leaves = lex(source).leaves;
    var mid = Math.max(1, Math.floor(leaves.length / 2));
    var r1 = { start: 0, end: mid };
    var r2 = { start: mid, end: leaves.length };
    var s1 = opaqueStmtTree(source, leaves, r1);
    var s2 = {
        id: 3,
        kind: 'statement',
        statementKind: 'opaque',
        bodyChildId: 4,
        leafRange: r2,
        span: spanOfLeaves(leaves, r2),
        children: [{
            id: 4,
            kind: 'opaque',
            reasonCode: 'X',
            boundary: 'statement',
            leafRange: r2,
            span: spanOfLeaves(leaves, r2)
        }]
    };
    var r = invariants.validateSyntaxInvariants({
        root: programWith([s1, s2], leaves, source),
        leaves: leaves,
        source: source
    });
    assert.strictEqual(r.ok, false);
    assertFails('A2', r, /ROOT_COVERAGE/i);
});

test('final A4 trivia-only fake empty Statement fails', function() {
    var source = '  -- comment\n';
    var leaves = lex(source).leaves;
    var range = { start: 0, end: leaves.length };
    var stmt = {
        id: 1,
        kind: 'statement',
        statementKind: 'empty',
        bodyChildId: null,
        leafRange: range,
        span: spanOfLeaves(leaves, range),
        children: []
    };
    var r = invariants.validateSyntaxInvariants({
        root: programWith([stmt], leaves, source),
        leaves: leaves,
        source: source
    });
    assert.strictEqual(r.ok, false);
    assertFails('A4', r, /ROOT_COVERAGE|expected 0/i);
});

test('final A5 empty source zero-leaf Statement fails', function() {
    var r = invariants.validateSyntaxInvariants({
        root: programWith([{
            id: 1,
            kind: 'statement',
            statementKind: 'empty',
            bodyChildId: null,
            leafRange: { start: 0, end: 0 },
            span: { start: 0, end: 0 },
            children: []
        }], [], ''),
        leaves: [],
        source: ''
    });
    assert.strictEqual(r.ok, false);
    assert.ok(r.failures.some(function(f) {
        return f.code === 'INV_ROOT_COVERAGE' || f.code === 'INV_EMPTY_RANGE';
    }));
});

// --- Relationship / opaque / alias ---
test('TREE opaque-under-expression-wrong-boundary fails', function() {
    var source = 'SELECT 1';
    var leaves = lex(source).leaves;
    var range = { start: 0, end: leaves.length };
    var query = {
        id: 2,
        kind: 'query',
        queryKind: 'select',
        setOperatorLeafIds: [],
        leafRange: range,
        span: spanOfLeaves(leaves, range),
        children: [{
            id: 3,
            kind: 'expression',
            expressionKind: 'literal',
            operatorLeafIds: [],
            leafRange: range,
            span: spanOfLeaves(leaves, range),
            children: [{
                id: 4,
                kind: 'opaque',
                reasonCode: 'X',
                boundary: 'statement',
                leafRange: range,
                span: spanOfLeaves(leaves, range)
            }]
        }]
    };
    var stmt = {
        id: 1,
        kind: 'statement',
        statementKind: 'query',
        bodyChildId: 2,
        leafRange: range,
        span: spanOfLeaves(leaves, range),
        children: [query]
    };
    var r = invariants.validateSyntaxInvariants({
        root: programWith([stmt], leaves, source),
        leaves: leaves,
        source: source
    });
    assert.strictEqual(r.ok, false);
    assertFails('opaque-expr', r, /RELATIONSHIP|boundary|expression|statement/i);
});

test('TREE Expression + opaque(expression) ok', function() {
    var source = 'SELECT 1';
    var leaves = lex(source).leaves;
    var range = { start: 0, end: leaves.length };
    var query = {
        id: 2,
        kind: 'query',
        queryKind: 'select',
        setOperatorLeafIds: [],
        leafRange: range,
        span: spanOfLeaves(leaves, range),
        children: [{
            id: 3,
            kind: 'expression',
            expressionKind: 'literal',
            operatorLeafIds: [],
            leafRange: range,
            span: spanOfLeaves(leaves, range),
            children: [{
                id: 4,
                kind: 'opaque',
                reasonCode: 'X',
                boundary: 'expression',
                leafRange: range,
                span: spanOfLeaves(leaves, range)
            }]
        }]
    };
    var stmt = {
        id: 1,
        kind: 'statement',
        statementKind: 'query',
        bodyChildId: 2,
        leafRange: range,
        span: spanOfLeaves(leaves, range),
        children: [query]
    };
    var r = invariants.validateSyntaxInvariants({
        root: programWith([stmt], leaves, source),
        leaves: leaves,
        source: source
    });
    assert.strictEqual(r.ok, true, JSON.stringify(r.failures));
});

test('TREE list + opaque(target) fails', function() {
    var source = 'SELECT 1';
    var leaves = lex(source).leaves;
    var range = { start: 0, end: leaves.length };
    var itemRange = { start: 2, end: 3 };
    var opaque = {
        id: 5,
        kind: 'opaque',
        reasonCode: 'X',
        boundary: 'target',
        leafRange: itemRange,
        span: spanOfLeaves(leaves, itemRange)
    };
    var item = {
        id: 4,
        kind: 'list-item',
        itemRole: 'select-item',
        alias: null,
        modifierLeafIds: [],
        valueChildId: 5,
        leafRange: itemRange,
        span: spanOfLeaves(leaves, itemRange),
        children: [opaque]
    };
    var list = {
        id: 3,
        kind: 'list',
        listRole: 'select-items',
        separatorLeafIds: [],
        leafRange: itemRange,
        span: spanOfLeaves(leaves, itemRange),
        children: [item]
    };
    var query = {
        id: 2,
        kind: 'query',
        queryKind: 'select',
        setOperatorLeafIds: [],
        leafRange: range,
        span: spanOfLeaves(leaves, range),
        children: [list]
    };
    var stmt = {
        id: 1,
        kind: 'statement',
        statementKind: 'query',
        bodyChildId: 2,
        leafRange: range,
        span: spanOfLeaves(leaves, range),
        children: [query]
    };
    var r = invariants.validateSyntaxInvariants({
        root: programWith([stmt], leaves, source),
        leaves: leaves,
        source: source
    });
    assert.strictEqual(r.ok, false);
    assertFails('opaque-target', r, /RELATIONSHIP|boundary|target/i);
});

test('TREE alias-name-overlaps-AS fails', function() {
    var source = 'SELECT 1 AS x';
    var leaves = lex(source).leaves;
    var asIdx = leaves.findIndex(function(l) {
        return l.channel === 'code' && l.raw.toLowerCase() === 'as';
    });
    var nameIdx = leaves.findIndex(function(l) {
        return l.kind === 'identifier' && l.raw === 'x';
    });
    var numIdx = leaves.findIndex(function(l) {
        return l.kind === 'number';
    });
    var range = { start: 0, end: leaves.length };
    var itemRange = { start: numIdx, end: leaves.length };
    var nameRange = { start: asIdx, end: nameIdx + 1 };
    var val = {
        id: 5,
        kind: 'expression',
        expressionKind: 'literal',
        operatorLeafIds: [],
        leafRange: { start: numIdx, end: numIdx + 1 },
        span: spanOfLeaves(leaves, { start: numIdx, end: numIdx + 1 }),
        children: []
    };
    var item = {
        id: 4,
        kind: 'list-item',
        itemRole: 'select-item',
        alias: { keywordLeafId: asIdx, nameLeafRange: nameRange },
        modifierLeafIds: [],
        valueChildId: 5,
        leafRange: itemRange,
        span: spanOfLeaves(leaves, itemRange),
        children: [val]
    };
    var list = {
        id: 3,
        kind: 'list',
        listRole: 'select-items',
        separatorLeafIds: [],
        leafRange: itemRange,
        span: spanOfLeaves(leaves, itemRange),
        children: [item]
    };
    var query = {
        id: 2,
        kind: 'query',
        queryKind: 'select',
        setOperatorLeafIds: [],
        leafRange: range,
        span: spanOfLeaves(leaves, range),
        children: [list]
    };
    var stmt = {
        id: 1,
        kind: 'statement',
        statementKind: 'query',
        bodyChildId: 2,
        leafRange: range,
        span: spanOfLeaves(leaves, range),
        children: [query]
    };
    var r = invariants.validateSyntaxInvariants({
        root: programWith([stmt], leaves, source),
        leaves: leaves,
        source: source
    });
    assert.strictEqual(r.ok, false);
    assertFails('alias-overlap', r, /RELATIONSHIP|keywordLeafId|before name/i);
});

test('TREE alias-empty-name fails', function() {
    var source = 'SELECT 1 AS x';
    var leaves = lex(source).leaves;
    var asIdx = leaves.findIndex(function(l) {
        return l.channel === 'code' && l.raw.toLowerCase() === 'as';
    });
    var numIdx = leaves.findIndex(function(l) {
        return l.kind === 'number';
    });
    var range = { start: 0, end: leaves.length };
    var itemRange = { start: numIdx, end: leaves.length };
    var emptyName = { start: asIdx, end: asIdx };
    var val = {
        id: 5,
        kind: 'expression',
        expressionKind: 'literal',
        operatorLeafIds: [],
        leafRange: { start: numIdx, end: numIdx + 1 },
        span: spanOfLeaves(leaves, { start: numIdx, end: numIdx + 1 }),
        children: []
    };
    var item = {
        id: 4,
        kind: 'list-item',
        itemRole: 'select-item',
        alias: { keywordLeafId: asIdx, nameLeafRange: emptyName },
        modifierLeafIds: [],
        valueChildId: 5,
        leafRange: itemRange,
        span: spanOfLeaves(leaves, itemRange),
        children: [val]
    };
    var list = {
        id: 3,
        kind: 'list',
        listRole: 'select-items',
        separatorLeafIds: [],
        leafRange: itemRange,
        span: spanOfLeaves(leaves, itemRange),
        children: [item]
    };
    var query = {
        id: 2,
        kind: 'query',
        queryKind: 'select',
        setOperatorLeafIds: [],
        leafRange: range,
        span: spanOfLeaves(leaves, range),
        children: [list]
    };
    var stmt = {
        id: 1,
        kind: 'statement',
        statementKind: 'query',
        bodyChildId: 2,
        leafRange: range,
        span: spanOfLeaves(leaves, range),
        children: [query]
    };
    var r = invariants.validateSyntaxInvariants({
        root: programWith([stmt], leaves, source),
        leaves: leaves,
        source: source
    });
    assert.strictEqual(r.ok, false);
    assertFails('alias-empty', r, /RELATIONSHIP|non-empty|nameLeafRange/i);
});

test('TREE alias trivia-only name fails', function() {
    var source = 'SELECT 1 AS x';
    var leaves = lex(source).leaves;
    var asIdx = leaves.findIndex(function(l) {
        return l.channel === 'code' && l.raw.toLowerCase() === 'as';
    });
    var numIdx = leaves.findIndex(function(l) {
        return l.kind === 'number';
    });
    // whitespace after AS is trivia-only range
    var wsAfterAs = asIdx + 1;
    assert.strictEqual(leaves[wsAfterAs].channel, 'trivia');
    var range = { start: 0, end: leaves.length };
    var itemRange = { start: numIdx, end: leaves.length };
    var triviaName = { start: wsAfterAs, end: wsAfterAs + 1 };
    var val = {
        id: 5,
        kind: 'expression',
        expressionKind: 'literal',
        operatorLeafIds: [],
        leafRange: { start: numIdx, end: numIdx + 1 },
        span: spanOfLeaves(leaves, { start: numIdx, end: numIdx + 1 }),
        children: []
    };
    var item = {
        id: 4,
        kind: 'list-item',
        itemRole: 'select-item',
        alias: { keywordLeafId: asIdx, nameLeafRange: triviaName },
        modifierLeafIds: [],
        valueChildId: 5,
        leafRange: itemRange,
        span: spanOfLeaves(leaves, itemRange),
        children: [val]
    };
    var list = {
        id: 3,
        kind: 'list',
        listRole: 'select-items',
        separatorLeafIds: [],
        leafRange: itemRange,
        span: spanOfLeaves(leaves, itemRange),
        children: [item]
    };
    var query = {
        id: 2,
        kind: 'query',
        queryKind: 'select',
        setOperatorLeafIds: [],
        leafRange: range,
        span: spanOfLeaves(leaves, range),
        children: [list]
    };
    var stmt = {
        id: 1,
        kind: 'statement',
        statementKind: 'query',
        bodyChildId: 2,
        leafRange: range,
        span: spanOfLeaves(leaves, range),
        children: [query]
    };
    var r = invariants.validateSyntaxInvariants({
        root: programWith([stmt], leaves, source),
        leaves: leaves,
        source: source
    });
    assert.strictEqual(r.ok, false);
    assertFails('alias-trivia-name', r, /RELATIONSHIP|syntax leaf|nameLeafRange/i);
});

test('TREE alias name before AS fails', function() {
    var source = 'SELECT 1 AS x';
    var leaves = lex(source).leaves;
    var asIdx = leaves.findIndex(function(l) {
        return l.channel === 'code' && l.raw.toLowerCase() === 'as';
    });
    var numIdx = leaves.findIndex(function(l) {
        return l.kind === 'number';
    });
    var range = { start: 0, end: leaves.length };
    var itemRange = { start: numIdx, end: leaves.length };
    // name is the number before AS
    var nameBefore = { start: numIdx, end: numIdx + 1 };
    var val = {
        id: 5,
        kind: 'expression',
        expressionKind: 'literal',
        operatorLeafIds: [],
        leafRange: { start: numIdx, end: numIdx + 1 },
        span: spanOfLeaves(leaves, { start: numIdx, end: numIdx + 1 }),
        children: []
    };
    var item = {
        id: 4,
        kind: 'list-item',
        itemRole: 'select-item',
        alias: { keywordLeafId: asIdx, nameLeafRange: nameBefore },
        modifierLeafIds: [],
        valueChildId: 5,
        leafRange: itemRange,
        span: spanOfLeaves(leaves, itemRange),
        children: [val]
    };
    var list = {
        id: 3,
        kind: 'list',
        listRole: 'select-items',
        separatorLeafIds: [],
        leafRange: itemRange,
        span: spanOfLeaves(leaves, itemRange),
        children: [item]
    };
    var query = {
        id: 2,
        kind: 'query',
        queryKind: 'select',
        setOperatorLeafIds: [],
        leafRange: range,
        span: spanOfLeaves(leaves, range),
        children: [list]
    };
    var stmt = {
        id: 1,
        kind: 'statement',
        statementKind: 'query',
        bodyChildId: 2,
        leafRange: range,
        span: spanOfLeaves(leaves, range),
        children: [query]
    };
    var r = invariants.validateSyntaxInvariants({
        root: programWith([stmt], leaves, source),
        leaves: leaves,
        source: source
    });
    assert.strictEqual(r.ok, false);
    assertFails('alias-name-before-as', r, /RELATIONSHIP|before name|keywordLeafId/i);
});

test('final positive alias with explicit AS ok', function() {
    var source = 'SELECT 1 AS x';
    var leaves = lex(source).leaves;
    var asIdx = leaves.findIndex(function(l) {
        return l.channel === 'code' && l.raw.toLowerCase() === 'as';
    });
    var nameIdx = leaves.findIndex(function(l) {
        return l.kind === 'identifier' && l.raw === 'x';
    });
    var numIdx = leaves.findIndex(function(l) {
        return l.kind === 'number';
    });
    var range = { start: 0, end: leaves.length };
    var itemRange = { start: numIdx, end: leaves.length };
    var val = {
        id: 5,
        kind: 'expression',
        expressionKind: 'literal',
        operatorLeafIds: [],
        leafRange: { start: numIdx, end: numIdx + 1 },
        span: spanOfLeaves(leaves, { start: numIdx, end: numIdx + 1 }),
        children: []
    };
    var item = {
        id: 4,
        kind: 'list-item',
        itemRole: 'select-item',
        alias: {
            keywordLeafId: asIdx,
            nameLeafRange: { start: nameIdx, end: nameIdx + 1 }
        },
        modifierLeafIds: [],
        valueChildId: 5,
        leafRange: itemRange,
        span: spanOfLeaves(leaves, itemRange),
        children: [val]
    };
    var list = {
        id: 3,
        kind: 'list',
        listRole: 'select-items',
        separatorLeafIds: [],
        leafRange: itemRange,
        span: spanOfLeaves(leaves, itemRange),
        children: [item]
    };
    var query = {
        id: 2,
        kind: 'query',
        queryKind: 'select',
        setOperatorLeafIds: [],
        leafRange: range,
        span: spanOfLeaves(leaves, range),
        children: [list]
    };
    var stmt = {
        id: 1,
        kind: 'statement',
        statementKind: 'query',
        bodyChildId: 2,
        leafRange: range,
        span: spanOfLeaves(leaves, range),
        children: [query]
    };
    var r = invariants.validateSyntaxInvariants({
        root: programWith([stmt], leaves, source),
        leaves: leaves,
        source: source
    });
    assert.strictEqual(r.ok, true, JSON.stringify(r.failures));
});

test('final positive alias without AS ok', function() {
    var source = 'SELECT 1 x';
    var leaves = lex(source).leaves;
    var numIdx = leaves.findIndex(function(l) { return l.kind === 'number'; });
    var nameIdx = leaves.findIndex(function(l) {
        return l.kind === 'identifier' && l.raw === 'x';
    });
    var range = { start: 0, end: leaves.length };
    var itemRange = { start: numIdx, end: leaves.length };
    var val = {
        id: 5,
        kind: 'expression',
        expressionKind: 'literal',
        operatorLeafIds: [],
        leafRange: { start: numIdx, end: numIdx + 1 },
        span: spanOfLeaves(leaves, { start: numIdx, end: numIdx + 1 }),
        children: []
    };
    var item = {
        id: 4,
        kind: 'list-item',
        itemRole: 'select-item',
        alias: {
            keywordLeafId: null,
            nameLeafRange: { start: nameIdx, end: nameIdx + 1 }
        },
        modifierLeafIds: [],
        valueChildId: 5,
        leafRange: itemRange,
        span: spanOfLeaves(leaves, itemRange),
        children: [val]
    };
    var list = {
        id: 3,
        kind: 'list',
        listRole: 'select-items',
        separatorLeafIds: [],
        leafRange: itemRange,
        span: spanOfLeaves(leaves, itemRange),
        children: [item]
    };
    var query = {
        id: 2,
        kind: 'query',
        queryKind: 'select',
        setOperatorLeafIds: [],
        leafRange: range,
        span: spanOfLeaves(leaves, range),
        children: [list]
    };
    var stmt = {
        id: 1,
        kind: 'statement',
        statementKind: 'query',
        bodyChildId: 2,
        leafRange: range,
        span: spanOfLeaves(leaves, range),
        children: [query]
    };
    var r = invariants.validateSyntaxInvariants({
        root: programWith([stmt], leaves, source),
        leaves: leaves,
        source: source
    });
    assert.strictEqual(r.ok, true, JSON.stringify(r.failures));
});

test('final B5b nested Statement under Query fails', function() {
    var source = 'SELECT 1';
    var leaves = lex(source).leaves;
    var range = { start: 0, end: leaves.length };
    var nested = {
        id: 3,
        kind: 'statement',
        statementKind: 'opaque',
        bodyChildId: 4,
        leafRange: range,
        span: spanOfLeaves(leaves, range),
        children: [{
            id: 4,
            kind: 'opaque',
            reasonCode: 'X',
            boundary: 'statement',
            leafRange: range,
            span: spanOfLeaves(leaves, range)
        }]
    };
    var query = {
        id: 2,
        kind: 'query',
        queryKind: 'select',
        setOperatorLeafIds: [],
        leafRange: range,
        span: spanOfLeaves(leaves, range),
        children: [nested]
    };
    var stmt = {
        id: 1,
        kind: 'statement',
        statementKind: 'query',
        bodyChildId: 2,
        leafRange: range,
        span: spanOfLeaves(leaves, range),
        children: [query]
    };
    var r = invariants.validateSyntaxInvariants({
        root: programWith([stmt], leaves, source),
        leaves: leaves,
        source: source
    });
    assert.strictEqual(r.ok, false);
    assertFails('nested-stmt', r, /RELATIONSHIP|StatementNode|Program/i);
});

test('final positive empty + trivia Program ok', function() {
    var r1 = invariants.validateSyntaxInvariants({
        root: { id: 0, kind: 'program', span: { start: 0, end: 0 }, leafRange: { start: 0, end: 0 }, children: [] },
        leaves: [],
        source: ''
    });
    assert.strictEqual(r1.ok, true, JSON.stringify(r1.failures));
    var source = '  \n';
    var leaves = lex(source).leaves;
    var r2 = invariants.validateSyntaxInvariants({
        root: programWith([], leaves, source),
        leaves: leaves,
        source: source
    });
    assert.strictEqual(r2.ok, true, JSON.stringify(r2.failures));
});

if (failures.length > 0) {
    console.error('\n' + failures.length + ' CST hardening test(s) failed');
    failures.forEach(function(f) {
        console.error(' - ' + f.name + ': ' + f.error.stack);
    });
    process.exit(1);
}
console.log('v2 Wave 2A CST hardening tests passed');
