'use strict';

var assert = require('assert');
var fs = require('fs');
var path = require('path');

var root = path.join(__dirname, '..', '..');
var corePath = path.join(root, '.tmp', 'v2-core', 'core', 'index.js');
var invariantsPath = path.join(root, '.tmp', 'v2-core', 'core', 'syntax', 'invariants.js');
var tokenTablePath = path.join(root, '.tmp', 'v2-core', 'core', 'syntax', 'token-table.js');
var parserPath = path.join(root, '.tmp', 'v2-core', 'core', 'syntax', 'parser.js');

assert.ok(fs.existsSync(corePath), 'build:v2-core required');
assert.ok(fs.existsSync(invariantsPath), 'invariants module must exist');

var core = require(corePath);
var invariants = require(invariantsPath);
var tokenTableMod = require(tokenTablePath);
var parser = require(parserPath);

assert.strictEqual(typeof invariants.validateSyntaxInvariants, 'function');
assert.deepStrictEqual(Object.keys(core).sort(), ['formatSql', 'lexSql']);

function lex(source) {
    return core.lexSql(source);
}

function withFacts(node, formatRole, capabilityId) {
    node.capabilityId = capabilityId === undefined ? null : capabilityId;
    node.formatRole = formatRole;
    node.syntaxMarkers = Object.freeze([]);
    return node;
}

function emptyProgram(source) {
    return withFacts({
        id: 0,
        kind: 'program',
        span: { start: 0, end: source.length },
        leafRange: { start: 0, end: 0 },
        children: []
    }, 'intrinsic-container');
}

function makeOpaque(id, start, end, leafStart, leafEnd, boundary) {
    return withFacts({
        id: id,
        kind: 'opaque',
        span: { start: start, end: end },
        leafRange: { start: leafStart, end: leafEnd },
        reasonCode: 'SYN_UNMODELED_CONSTRUCT',
        boundary: boundary || 'statement'
    }, 'opaque');
}

function makeStatement(id, start, end, leafStart, leafEnd, bodyChildId, children) {
    return withFacts({
        id: id,
        kind: 'statement',
        span: { start: start, end: end },
        leafRange: { start: leafStart, end: leafEnd },
        statementKind: bodyChildId === null ? 'empty' : 'opaque',
        bodyChildId: bodyChildId,
        children: children || []
    }, 'intrinsic-container');
}

function makeProgram(start, end, leafStart, leafEnd, children) {
    return withFacts({
        id: 0,
        kind: 'program',
        span: { start: start, end: end },
        leafRange: { start: leafStart, end: leafEnd },
        children: children || []
    }, 'intrinsic-container');
}

function cloneSyntaxTree(node) {
    var clone = Object.assign({}, node);
    if (Array.isArray(node.children)) {
        clone.children = node.children.map(cloneSyntaxTree);
    }
    return clone;
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
    var root = makeProgram(0, source.length, 0, leaves.length, [
            makeStatement(1, 0, source.length, 0, leaves.length, 2, [
                makeOpaque(2, 0, source.length, 0, leaves.length)
            ])
        ]);
    var result = invariants.validateSyntaxInvariants({
        root: root,
        leaves: leaves,
        source: source
    });
    assert.strictEqual(result.ok, true, JSON.stringify(result.failures));
    console.log('  ok - full opaque tree');
})();

(function testCanonicalLeafPartitionStillRejectsMismatchedSource() {
    var source = 'SELECT 1';
    var leaves = lex(source).leaves;
    var root = parser.parseSql(source, { dialect: 'hive', mode: 'document' }).root;
    var result = invariants.validateSyntaxInvariants({
        root: root,
        leaves: leaves,
        source: 'SELECT 2'
    });
    assert.strictEqual(result.ok, false);
    assert.ok(result.failures.some(function(failure) {
        return failure.code === 'INV_LEAF_PARTITION';
    }));
    console.log('  ok - canonical leaf partition remains bound to exact source');
})();

(function testCanonicalProgramRejectsForeignLeafPartition() {
    var delimiterArtifact = parser.parseSqlArtifact('SELECT (a)', {
        dialect: 'hive',
        mode: 'document'
    });
    var commaArtifact = parser.parseSqlArtifact('SELECT a,b', {
        dialect: 'hive',
        mode: 'document'
    });
    var result = invariants.validateSyntaxInvariants({
        root: delimiterArtifact.output.root,
        leaves: commaArtifact.output.leaves,
        source: commaArtifact.source,
        tokenTable: commaArtifact.tokenTable
    });
    assert.strictEqual(result.ok, false);
    assert.ok(result.failures.some(function(failure) {
        return failure.code === 'INV_LEAF_PARTITION';
    }), JSON.stringify(result.failures));
    console.log('  ok - canonical program remains bound to exact leaf partition');
})();

(function testTargetOpaqueMustBeTheUniqueFullProgramFallback() {
    var source = 'SELECT 1;;';
    var leaves = lex(source).leaves;
    var table = tokenTableMod.buildStructuralTokenTable(leaves, source);
    var ranges = table.statementRanges();
    assert.strictEqual(ranges.length, 2);
    var firstSpan = table.rangeToSpan(ranges[0]);
    var secondSpan = table.rangeToSpan(ranges[1]);
    var target = makeOpaque(
        2,
        firstSpan.start,
        firstSpan.end,
        ranges[0].start,
        ranges[0].end,
        'target'
    );
    var root = makeProgram(0, source.length, 0, leaves.length, [
            makeStatement(
                1,
                firstSpan.start,
                firstSpan.end,
                ranges[0].start,
                ranges[0].end,
                2,
                [target]
            ),
            makeStatement(
                3,
                secondSpan.start,
                secondSpan.end,
                ranges[1].start,
                ranges[1].end,
                null,
                []
            )
        ]);
    var result = invariants.validateSyntaxInvariants({
        root: root,
        leaves: leaves,
        source: source,
        tokenTable: table
    });
    assert.strictEqual(result.ok, false);
    assert.ok(result.failures.some(function(failure) {
        return /target opaque.*complete leaf stream/i.test(failure.message);
    }));

    var fullTarget = makeOpaque(2, 0, source.length, 0, leaves.length, 'target');
    var fullRoot = makeProgram(0, source.length, 0, leaves.length, [
            makeStatement(1, 0, source.length, 0, leaves.length, 2, [fullTarget])
        ]);
    var fullResult = invariants.validateSyntaxInvariants({
        root: fullRoot,
        leaves: leaves,
        source: source,
        tokenTable: table
    });
    assert.strictEqual(fullResult.ok, true, JSON.stringify(fullResult.failures));
    console.log('  ok - target opaque is unique full-program fallback');
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
    var root = makeProgram(0, source.length, 0, leaves.length, children);
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
    var root = makeProgram(0, source.length, 0, leaves.length + 5, []);
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
    var root = makeProgram(0, 1, 0, leaves.length, []);
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
    var root = makeProgram(0, source.length, 0, leaves.length, [
        makeStatement(1, 0, source.length, 0, leaves.length, 0, [opaque])
    ]);
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
    var root = makeProgram(0, source.length, 0, leaves.length, [a, b]);
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
    var root = makeProgram(0, 3, 0, 1, [child]);
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
    var root = makeProgram(0, source.length, 0, leaves.length, [stmtA, stmtB]);
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
    var root = makeProgram(0, source.length, 0, leaves.length, [
        makeStatement(1, 0, source.length, 0, leaves.length, 2, [opaque])
    ]);
    var result = invariants.validateSyntaxInvariants({
        root: root,
        leaves: leaves,
        source: source
    });
    assert.strictEqual(result.ok, false);
    console.log('  ok - opaque children fail-closed');
})();

(function testOpaqueCapabilityIdentityShape() {
    var source = 'SELECT 1';
    var leaves = lex(source).leaves;
    [undefined, 'QUALIFY'].forEach(function(capabilityId) {
        var opaque = makeOpaque(2, 0, source.length, 0, leaves.length);
        if (capabilityId === undefined) {
            delete opaque.capabilityId;
        } else {
            opaque.capabilityId = capabilityId;
        }
        var root = makeProgram(0, source.length, 0, leaves.length, [makeStatement(
                1, 0, source.length, 0, leaves.length, 2, [opaque]
            )]);
        var result = invariants.validateSyntaxInvariants({
            root: root,
            leaves: leaves,
            source: source
        });
        assert.strictEqual(result.ok, false);
        assert.ok(result.failures.some(function(failure) {
            return /opaque capabilityId/.test(failure.message);
        }));
    });
    console.log('  ok - opaque capability identity shape fail-closed');
})();

// ---------------------------------------------------------------------------
// Fail-closed: owner reference outside range
// ---------------------------------------------------------------------------
(function testOwnerReference() {
    var source = 'SELECT 1, 2';
    var leaves = lex(source).leaves;
    var list = withFacts({
        id: 2,
        kind: 'list',
        span: { start: 0, end: source.length },
        leafRange: { start: 0, end: leaves.length },
        listRole: 'select-items',
        separatorLeafIds: Object.freeze([leaves.length + 10]),
        children: []
    }, 'intrinsic-container');
    var root = makeProgram(0, source.length, 0, leaves.length, [
        makeStatement(1, 0, source.length, 0, leaves.length, 2, [list])
    ]);
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
        root: makeProgram(0, 1, 0, leaves.length + 1, []),
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

(function testJoinUsingContainerContractFailsClosed() {
    var source = 'SELECT * FROM a JOIN b USING (id)';
    var parsed = parser.parseSql(source, { dialect: 'hive', mode: 'document' });

    function mutateAndValidate(mutator) {
        var rootNode = cloneSyntaxTree(parsed.root);
        var stack = [rootNode];
        var usingClause = null;
        while (stack.length > 0) {
            var node = stack.pop();
            if (node.kind === 'clause' && node.clauseKind === 'join-using') {
                usingClause = node;
                break;
            }
            if (Array.isArray(node.children)) {
                Array.prototype.push.apply(stack, node.children);
            }
        }
        assert.ok(usingClause, 'JOIN USING clause fixture');
        mutator(usingClause);
        return invariants.validateSyntaxInvariants({
            root: rootNode,
            leaves: parsed.leaves,
            source: source,
            tokenTable: tokenTableMod.buildStructuralTokenTable(parsed.leaves, source)
        });
    }

    var wrongRole = mutateAndValidate(function(clause) {
        clause.children[0].listRole = 'select-items';
    });
    assert.strictEqual(wrongRole.ok, false);
    assert.ok(wrongRole.failures.some(function(failure) {
        return /join-using|relationship/i.test(failure.message);
    }), 'JOIN USING wrong list role must fail its container contract');

    var missingChild = mutateAndValidate(function(clause) {
        clause.children = [];
    });
    assert.strictEqual(missingChild.ok, false);
    assert.ok(missingChild.failures.some(function(failure) {
        return /join-using|relationship/i.test(failure.message);
    }), 'JOIN USING missing child must fail its container contract');
    console.log('  ok - JOIN USING container contract fails closed');
})();

console.log('v2 syntax invariants tests passed');
