'use strict';

var assert = require('assert');
var fs = require('fs');
var path = require('path');

var root = path.join(__dirname, '..', '..');
var corePath = path.join(root, '.tmp', 'v2-core', 'core', 'index.js');
var tokenTablePath = path.join(root, '.tmp', 'v2-core', 'core', 'syntax', 'token-table.js');
var cursorPath = path.join(root, '.tmp', 'v2-core', 'core', 'syntax', 'cursor.js');

assert.ok(fs.existsSync(corePath), 'build:v2-core required');
assert.ok(fs.existsSync(tokenTablePath), 'token-table module must exist');

var core = require(corePath);
var tokenTableMod = require(tokenTablePath);
var buildStructuralTokenTable = tokenTableMod.buildStructuralTokenTable;
assert.strictEqual(typeof buildStructuralTokenTable, 'function');

// Root must not export token table or other internal helpers.
assert.deepStrictEqual(Object.keys(core).sort(), ['formatSql', 'lexSql']);

function lex(source, dialect) {
    return core.lexSql(source, dialect ? { dialect: dialect } : undefined);
}

function tableFor(source, dialect) {
    var output = lex(source, dialect);
    return {
        source: source,
        leaves: output.leaves,
        table: buildStructuralTokenTable(output.leaves, source)
    };
}

function assertImmutableArray(value, label) {
    assert.ok(Array.isArray(value), label + ' must be a real Array');
    assert.strictEqual(Object.isFrozen(value), true, label + ' must be frozen');
    var before = value.length;
    try {
        value.push({ forged: true });
    } catch (_e) { /* ok */ }
    assert.strictEqual(value.length, before, label + ' immutable after push');
}

function codeLeafIndexes(leaves) {
    var indexes = [];
    for (var i = 0; i < leaves.length; i++) {
        if (leaves[i].channel === 'code') {
            indexes.push(i);
        }
    }
    return indexes;
}

// ---------------------------------------------------------------------------
// Empty / trivia-only / semicolon-only
// ---------------------------------------------------------------------------
(function testEmpty() {
    var t = tableFor('');
    assert.strictEqual(t.table.leafCount(), 0);
    assert.strictEqual(t.table.codeLeafCount(), 0);
    assert.deepStrictEqual(t.table.statementRanges().slice ? Array.from(t.table.statementRanges()) : t.table.statementRanges(), []);
    assert.deepStrictEqual(t.table.structuralIssues().length !== undefined ? Array.from(t.table.structuralIssues()) : [], []);
    assert.deepStrictEqual(t.table.rangeToSpan({ start: 0, end: 0 }), { start: 0, end: 0 });
    console.log('  ok - empty');
})();

(function testTriviaOnly() {
    var t = tableFor('  -- comment\n  ');
    assert.ok(t.table.leafCount() > 0);
    assert.strictEqual(t.table.codeLeafCount(), 0);
    var ranges = Array.from(t.table.statementRanges());
    assert.strictEqual(ranges.length, 0, 'trivia-only must not create pseudo statements');
    console.log('  ok - trivia-only');
})();

(function testSemicolonOnly() {
    var t = tableFor(';');
    assert.strictEqual(t.table.codeLeafCount(), 1);
    var ranges = Array.from(t.table.statementRanges());
    assert.strictEqual(ranges.length, 1);
    assert.strictEqual(ranges[0].start, 0);
    assert.strictEqual(ranges[0].end, 1);
    console.log('  ok - semicolon-only');
})();

(function testConsecutiveSemicolons() {
    var t = tableFor(';;');
    var ranges = Array.from(t.table.statementRanges());
    assert.strictEqual(ranges.length, 2, 'each semicolon forms an empty statement');
    assert.strictEqual(ranges[0].end - ranges[0].start, 1);
    assert.strictEqual(ranges[1].end - ranges[1].start, 1);
    console.log('  ok - consecutive semicolons');
})();

// ---------------------------------------------------------------------------
// Code adjacency / ordinal
// ---------------------------------------------------------------------------
(function testCodeAdjacency() {
    var t = tableFor('SELECT 1 FROM t');
    var codes = codeLeafIndexes(t.leaves);
    assert.ok(codes.length >= 4);

    // First code leaf has no previous
    assert.strictEqual(t.table.previousCodeLeafIndex(codes[0]), null);
    assert.strictEqual(t.table.nextCodeLeafIndex(codes[0]), codes[1]);

    // Last code leaf has no next
    var last = codes[codes.length - 1];
    assert.strictEqual(t.table.nextCodeLeafIndex(last), null);
    assert.strictEqual(t.table.previousCodeLeafIndex(last), codes[codes.length - 2]);

    // Ordinal mapping
    for (var i = 0; i < codes.length; i++) {
        assert.strictEqual(t.table.codeOrdinalOfLeaf(codes[i]), i);
        assert.strictEqual(t.table.leafIndexOfCodeOrdinal(i), codes[i]);
    }

    // Trivia leaf rejects code adjacency with clear error or null-safe policy
    var triviaIndex = -1;
    for (var j = 0; j < t.leaves.length; j++) {
        if (t.leaves[j].channel !== 'code') {
            triviaIndex = j;
            break;
        }
    }
    if (triviaIndex >= 0) {
        assert.throws(function() {
            t.table.previousCodeLeafIndex(triviaIndex);
        }, /code leaf|not a code leaf|channel/i);
    }

    // Out of range rejects
    assert.throws(function() {
        t.table.nextCodeLeafIndex(-1);
    }, /out of range|bounds|invalid/i);
    assert.throws(function() {
        t.table.nextCodeLeafIndex(t.leaves.length + 5);
    }, /out of range|bounds|invalid/i);

    console.log('  ok - code adjacency and ordinals');
})();

// ---------------------------------------------------------------------------
// Delimiter matching and depth
// ---------------------------------------------------------------------------
(function testParenMatching() {
    var t = tableFor('SELECT (a + (b))');
    // Find open parens
    var opens = [];
    var closes = [];
    for (var i = 0; i < t.leaves.length; i++) {
        if (t.leaves[i].channel === 'code' && t.leaves[i].raw === '(') {
            opens.push(i);
        }
        if (t.leaves[i].channel === 'code' && t.leaves[i].raw === ')') {
            closes.push(i);
        }
    }
    assert.strictEqual(opens.length, 2);
    assert.strictEqual(closes.length, 2);
    assert.strictEqual(t.table.matchingDelimiterIndex(opens[0]), closes[1]);
    assert.strictEqual(t.table.matchingDelimiterIndex(opens[1]), closes[0]);
    assert.strictEqual(t.table.matchingDelimiterIndex(closes[0]), opens[1]);
    assert.strictEqual(t.table.matchingDelimiterIndex(closes[1]), opens[0]);

    // Depth before/after
    assert.strictEqual(t.table.depthBefore(opens[0]), 0);
    assert.strictEqual(t.table.depthAfter(opens[0]), 1);
    assert.strictEqual(t.table.depthBefore(opens[1]), 1);
    assert.strictEqual(t.table.depthAfter(opens[1]), 2);
    console.log('  ok - paren matching and depth');
})();

(function testBracketMatching() {
    var t = tableFor('SELECT a[1]');
    var open = -1;
    var close = -1;
    for (var i = 0; i < t.leaves.length; i++) {
        if (t.leaves[i].channel === 'code' && t.leaves[i].raw === '[') open = i;
        if (t.leaves[i].channel === 'code' && t.leaves[i].raw === ']') close = i;
    }
    assert.ok(open >= 0 && close >= 0);
    assert.strictEqual(t.table.matchingDelimiterIndex(open), close);
    assert.strictEqual(t.table.matchingDelimiterIndex(close), open);
    console.log('  ok - bracket matching');
})();

// Protected leaves: punctuation inside string/comment must not participate
(function testProtectedPunctuation() {
    var t = tableFor("SELECT '(;[]' -- )\nFROM t");
    var codeParens = 0;
    for (var i = 0; i < t.leaves.length; i++) {
        var leaf = t.leaves[i];
        if (leaf.channel === 'code' && (leaf.raw === '(' || leaf.raw === ')')) {
            codeParens++;
        }
    }
    // No code-level paren in this source
    assert.strictEqual(codeParens, 0);
    // No structural issues for protected punctuation
    var issues = Array.from(t.table.structuralIssues());
    assert.strictEqual(issues.length, 0, 'protected punctuation must not create structural issues');
    // Depth stays 0 throughout code leaves
    for (var j = 0; j < t.leaves.length; j++) {
        if (t.leaves[j].channel === 'code') {
            assert.strictEqual(t.table.depthBefore(j), 0);
            assert.strictEqual(t.table.depthAfter(j), 0);
        }
    }
    console.log('  ok - protected punctuation ignored');
})();

// ---------------------------------------------------------------------------
// CRLF / emoji span integrity
// ---------------------------------------------------------------------------
(function testCrLfAndEmoji() {
    var source = "SELECT '\uD83D\uDE00';\r\nSELECT 2";
    var t = tableFor(source);
    // range covering all leaves
    var full = t.table.rangeToSpan({ start: 0, end: t.leaves.length });
    assert.deepStrictEqual(full, { start: 0, end: source.length });
    // empty range at start
    assert.deepStrictEqual(t.table.rangeToSpan({ start: 0, end: 0 }), { start: 0, end: 0 });
    // empty range at end
    assert.deepStrictEqual(
        t.table.rangeToSpan({ start: t.leaves.length, end: t.leaves.length }),
        { start: source.length, end: source.length }
    );
    // non-empty first leaf
    if (t.leaves.length > 0) {
        var first = t.table.rangeToSpan({ start: 0, end: 1 });
        assert.deepStrictEqual(first, t.leaves[0].span);
    }
    console.log('  ok - CRLF/emoji span integrity');
})();

// ---------------------------------------------------------------------------
// Statement segmentation
// ---------------------------------------------------------------------------
(function testTopLevelStatements() {
    var t = tableFor('SELECT 1; SELECT 2;');
    var ranges = Array.from(t.table.statementRanges());
    assert.strictEqual(ranges.length, 2);
    // First statement includes trailing semicolon
    var firstSlice = t.leaves.slice(ranges[0].start, ranges[0].end).map(function(l) { return l.raw; }).join('');
    assert.ok(firstSlice.indexOf(';') >= 0, 'semicolon belongs to previous statement');
    assert.ok(/SELECT\s+1\s*;/.test(firstSlice.replace(/\s+/g, ' ').trim()) || firstSlice.indexOf('1') >= 0);
    console.log('  ok - top-level statement segmentation');
})();

(function testParenthesizedSemicolonDoesNotSplit() {
    var t = tableFor('SELECT (SELECT 1; SELECT 2); SELECT 3');
    var ranges = Array.from(t.table.statementRanges());
    // Only one reliable top-level split after outer close paren semicolon... wait:
    // Source: SELECT (SELECT 1; SELECT 2); SELECT 3
    // Top-level semicolons: after ), and maybe none at end
    // So 2 statements: "SELECT (SELECT 1; SELECT 2);" and " SELECT 3"
    assert.strictEqual(ranges.length, 2, 'inner semicolons must not split document statements, got ' + ranges.length);
    var first = t.leaves.slice(ranges[0].start, ranges[0].end).map(function(l) { return l.raw; }).join('');
    assert.ok(first.indexOf('SELECT 2') >= 0 || first.indexOf('2') >= 0);
    assert.ok(first.indexOf(';') >= 0);
    console.log('  ok - parenthesized subquery semicolon does not split');
})();

(function testCommentSemicolonDoesNotSplit() {
    var t = tableFor('SELECT 1; -- done;\nSELECT 2');
    var ranges = Array.from(t.table.statementRanges());
    assert.strictEqual(ranges.length, 2);
    console.log('  ok - comment semicolon does not split');
})();

(function testBlockCommentSemicolon() {
    var t = tableFor('SELECT 1 /* ; */ ; SELECT 2');
    var ranges = Array.from(t.table.statementRanges());
    assert.strictEqual(ranges.length, 2);
    console.log('  ok - block comment semicolon does not split');
})();

// ---------------------------------------------------------------------------
// Unmatched delimiters
// ---------------------------------------------------------------------------
(function testUnmatchedCloser() {
    var t = tableFor('SELECT )');
    var issues = Array.from(t.table.structuralIssues());
    assert.ok(issues.length >= 1, 'unmatched closer must produce structural issue');
    assert.ok(issues.some(function(issue) {
        return /unmatched|closer|delimiter/i.test(issue.code || issue.kind || '');
    }));
    console.log('  ok - unmatched closer');
})();

(function testUnmatchedOpener() {
    var t = tableFor('SELECT (a');
    var issues = Array.from(t.table.structuralIssues());
    assert.ok(issues.length >= 1, 'unmatched opener must produce structural issue');
    console.log('  ok - unmatched opener');
})();

(function testMixedDelimiter() {
    var t = tableFor('SELECT (a]');
    var issues = Array.from(t.table.structuralIssues());
    assert.ok(issues.length >= 1, 'mixed delimiter must produce structural issue');
    console.log('  ok - mixed delimiter');
})();

// Statement boundary unreliable: after unmatched opener, later top-level semicolon
// must not be trusted as a sync point for further segmentation guesses.
// Already-closed reliable prefix ranges must still be preserved (design §8 / §10.1).
(function testUnreliableBoundaryStopsGuessing() {
    // No reliable prefix: opener fails before any completed statement.
    var t = tableFor('SELECT (a; SELECT 2; SELECT 3');
    var issues = Array.from(t.table.structuralIssues());
    assert.ok(issues.length >= 1);
    var ranges = Array.from(t.table.statementRanges());
    assert.strictEqual(t.table.statementBoundariesReliable(), false);
    // Must not invent multiple trusted top-level statements from later semicolons.
    assert.strictEqual(ranges.length, 1, 'no prior closed range; single remainder range expected, got ' + ranges.length);
    console.log('  ok - unreliable boundary does not guess further splits');
})();

(function testUnreliableBoundaryPreservesPrefixRanges() {
    // First statement closes reliably; later unmatched opener stops further splits.
    var t = tableFor('SELECT 1; SELECT (a; SELECT 2; SELECT 3');
    assert.strictEqual(t.table.statementBoundariesReliable(), false);
    var ranges = Array.from(t.table.statementRanges());
    assert.ok(ranges.length >= 2, 'must preserve reliable prefix statement before failure, got ' + ranges.length);
    // First range must be the closed "SELECT 1;"
    var first = t.leaves.slice(ranges[0].start, ranges[0].end).map(function(l) { return l.raw; }).join('');
    assert.ok(/SELECT\s*1\s*;/.test(first.replace(/\s+/g, ' ').trim()) || (first.indexOf('1') >= 0 && first.indexOf(';') >= 0));
    // Must not produce 4 ranges from every semicolon
    assert.ok(ranges.length < 4, 'must not trust every subsequent semicolon, got ' + ranges.length);
    // Remainder after first closed statement is one untrusted range
    assert.strictEqual(ranges.length, 2, 'prefix + single remainder expected, got ' + ranges.length);
    console.log('  ok - unreliable boundary preserves reliable prefix ranges');
})();

// < > are operators, not type delimiters in global table
(function testAngleBracketsAreOperators() {
    var t = tableFor('SELECT a < b, c > d');
    for (var i = 0; i < t.leaves.length; i++) {
        if (t.leaves[i].channel === 'code' && (t.leaves[i].raw === '<' || t.leaves[i].raw === '>')) {
            assert.strictEqual(
                t.table.matchingDelimiterIndex(i),
                null,
                '< > must not be paired as delimiters in global token table'
            );
            assert.strictEqual(t.table.depthBefore(i), 0);
            assert.strictEqual(t.table.depthAfter(i), 0);
        }
    }
    console.log('  ok - angle brackets remain operators');
})();

// ---------------------------------------------------------------------------
// Immutability / determinism
// ---------------------------------------------------------------------------
(function testNoMutableLeakage() {
    var t = tableFor('SELECT (1), [2]; SELECT 3');
    assertImmutableArray(t.table.statementRanges(), 'statementRanges');
    assertImmutableArray(t.table.structuralIssues(), 'structuralIssues');
    assert.strictEqual(t.table.statementRanges(), t.table.statementRanges(), 'cached ranges');

    // Deterministic rebuild
    var t2 = tableFor('SELECT (1), [2]; SELECT 3');
    assert.deepStrictEqual(
        Array.from(t.table.statementRanges()),
        Array.from(t2.table.statementRanges())
    );
    assert.deepStrictEqual(
        Array.from(t.table.structuralIssues()).map(function(i) { return i.code || i.kind; }),
        Array.from(t2.table.structuralIssues()).map(function(i) { return i.code || i.kind; })
    );
    console.log('  ok - immutability and determinism');
})();

// Normalized word comparison helper — code leaf only
(function testNormalizedWord() {
    var t = tableFor('SELECT Select');
    var codes = codeLeafIndexes(t.leaves);
    assert.ok(codes.length >= 2);
    assert.strictEqual(t.table.normalizedWord(codes[0]), 'select');
    assert.strictEqual(t.table.normalizedWord(codes[1]), 'select');
    assert.ok(t.table.codeWordsEqual(codes[0], codes[1]));

    // Trivia / protected rejected
    var nonCode = -1;
    for (var i = 0; i < t.leaves.length; i++) {
        if (t.leaves[i].channel !== 'code') {
            nonCode = i;
            break;
        }
    }
    // If no trivia in this source, use a different source
    if (nonCode < 0) {
        var t2 = tableFor('SELECT /*x*/ 1');
        for (var j = 0; j < t2.leaves.length; j++) {
            if (t2.leaves[j].channel !== 'code') {
                assert.throws(function() {
                    t2.table.normalizedWord(j);
                }, /code leaf|not a code leaf|channel/i);
                break;
            }
        }
    } else {
        assert.throws(function() {
            t.table.normalizedWord(nonCode);
        }, /code leaf|not a code leaf|channel/i);
    }
    console.log('  ok - normalized word helper');
})();

// Cursor module exists and moves without copying arrays
(function testCursor() {
    assert.ok(fs.existsSync(cursorPath), 'cursor module must exist');
    var cursorMod = require(cursorPath);
    assert.strictEqual(typeof cursorMod.createTokenCursor, 'function');
    var t = tableFor('SELECT 1 FROM t');
    var cursor = cursorMod.createTokenCursor(t.table);
    assert.strictEqual(typeof cursor.leafIndex, 'function');
    assert.strictEqual(typeof cursor.advance, 'function');
    assert.strictEqual(typeof cursor.advanceSyntax, 'function');
    assert.strictEqual(typeof cursor.advanceCode, 'undefined');
    var start = cursor.leafIndex();
    cursor.advance();
    assert.notStrictEqual(cursor.leafIndex(), start);
    console.log('  ok - cursor');
})();

// ---------------------------------------------------------------------------
// 100k leaves performance probe: per-query must not full-scan
// ---------------------------------------------------------------------------
(function testScaleProbe() {
    var parts = [];
    for (var i = 0; i < 5000; i++) {
        parts.push('SELECT a, b, c FROM t' + i + ' WHERE x = ' + i);
        if (i % 10 === 9) parts.push(';');
    }
    var source = parts.join(' ');
    var output = lex(source);
    assert.ok(output.leaves.length > 20000, 'probe should produce many leaves, got ' + output.leaves.length);

    var buildStart = process.hrtime.bigint();
    var table = buildStructuralTokenTable(output.leaves, source);
    var buildMs = Number(process.hrtime.bigint() - buildStart) / 1e6;

    // Many random adjacency queries should be cheap relative to rebuild
    var queryStart = process.hrtime.bigint();
    var codeCount = table.codeLeafCount();
    for (var q = 0; q < 10000; q++) {
        var ord = q % codeCount;
        var idx = table.leafIndexOfCodeOrdinal(ord);
        table.previousCodeLeafIndex(idx);
        table.nextCodeLeafIndex(idx);
        table.depthBefore(idx);
    }
    var queryMs = Number(process.hrtime.bigint() - queryStart) / 1e6;

    // Heuristic: 10k indexed queries should not approach a full rebuild cost * large factor
    // if each query rescanned all leaves. Allow generous margin for CI noise.
    assert.ok(
        queryMs < Math.max(buildMs * 5, 200),
        '10k adjacency queries took ' + queryMs.toFixed(2) + 'ms vs build ' + buildMs.toFixed(2) +
            'ms — possible per-query full scan'
    );
    console.log('  ok - scale probe (leaves=' + output.leaves.length +
        ', buildMs=' + buildMs.toFixed(2) + ', query10kMs=' + queryMs.toFixed(2) + ')');
})();

console.log('v2 syntax token table tests passed');
