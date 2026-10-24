'use strict';

// The lossless lexer (floor 1): leaves rebuild the source, and the Hive classification that floor 5
// relies on (strings, comments, templates and other protected text are single leaves).

var assert = require('assert');
var test = require('node:test');
var lexSql = require('./helpers/src')({ lexer: 'core/lexer/lossless-lexer' }).lexer.lexSql;

function hive(source) {
    return lexSql(source);
}

function assertConserves(source, output) {
    assert.strictEqual(output.leaves.map(function(leaf) { return leaf.raw; }).join(''), source);
    var cursor = 0;
    output.leaves.forEach(function(leaf, index) {
        assert.strictEqual(leaf.id, index);
        assert.strictEqual(leaf.span.start, cursor);
        assert.ok(leaf.span.end > leaf.span.start);
        assert.strictEqual(leaf.raw, source.slice(leaf.span.start, leaf.span.end));
        cursor = leaf.span.end;
    });
    assert.strictEqual(cursor, source.length);
    output.diagnostics.forEach(function(item) {
        assert.ok(item.span.start >= 0 && item.span.start <= item.span.end && item.span.end <= source.length);
    });
}

function leavesWithRaw(output, raw) {
    return output.leaves.filter(function(leaf) { return leaf.raw === raw; });
}

function mulberry32(seed) {
    var t = seed >>> 0;
    return function() {
        t += 0x6D2B79F5;
        var r = Math.imul(t ^ (t >>> 15), 1 | t);
        r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
        return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
}

test('U-L1: leaves partition the source', function() {
    assert.deepStrictEqual(hive(''), { leaves: [], diagnostics: [] });
    ['SELECT 1', 'SELECT 1\r\nFROM t\r\n', '﻿SELECT 1', 'SELECT 用户 FROM t -- 中文注释', "SELECT '😀' -- 保留 FROM 😀"]
        .forEach(function(source) { assertConserves(source, hive(source)); });
    assert.deepStrictEqual(hive('SELECT 1').leaves.map(function(leaf) { return leaf.kind; }), ['keyword', 'whitespace', 'number']);
    var newlines = hive('SELECT 1\r\nFROM t\r\n').leaves.filter(function(leaf) { return leaf.kind === 'newline'; });
    assert.deepStrictEqual(newlines.map(function(leaf) { return leaf.raw; }), ['\r\n', '\r\n']);
});

test('U-L2: Hive classification of protected and unusual text', function() {
    var rows = [
        ['﻿SELECT 1', '﻿', 'byte-order-mark', 'trivia'],
        ['SELECT﻿1', '﻿', 'unknown', 'protected'],
        ["SELECT '😀' -- 保留 FROM 😀", "'😀'", 'string', 'protected'],
        ["SELECT '😀' -- 保留 FROM 😀", '-- 保留 FROM 😀', 'line-comment', 'trivia'],
        ['SELECT 中文字段 FROM t', '中文字段', 'unknown', 'protected'],
        ['SELECT @@\\§©中文😀\uD800\uD801 FROM t', '@@\\§©中文😀\uD800\uD801', 'unknown', 'protected'],
        ['SELECT a @@ b', '@@', 'unknown', 'protected'],
        ["SELECT 'a''b'", "'a''b'", 'string', 'protected'],
        ['SELECT 1 -- left right', '-- left right', 'line-comment', 'trivia'],
        ['SELECT 1 -- left\u0085right', '-- left\u0085right', 'line-comment', 'trivia'],
        ['SELECT 1 -- left right', '-- left right', 'line-comment', 'trivia'],
        ['SELECT ${db}.t', '${db}.t', 'parameter', 'protected'],
        ['SELECT ${db} .t', '${db}', 'parameter', 'protected'],
        ['SELECT ${hivevar:day}', '${hivevar:day}', 'parameter', 'protected'],
        ['SELECT ${hiveconf:${hivevar:key}}', '${hiveconf:${hivevar:key}}', 'parameter', 'protected'],
        ['SELECT :id', ':', 'punctuation', 'code'],
        ["SELECT X'AF'", "X'AF'", 'string', 'protected'],
        ["SELECT B'101'", "B'101'", 'string', 'protected'],
        ['SELECT 1--2', '--2', 'line-comment', 'trivia'],
        ['SELECT 5.', '5.', 'number', 'code'],
        ['PARTITIONED BY', 'PARTITIONED', 'keyword', 'code']
    ];
    rows.forEach(function(row) {
        var output = hive(row[0]);
        assertConserves(row[0], output);
        var found = leavesWithRaw(output, row[1]);
        assert.strictEqual(found.length, 1, JSON.stringify(row));
        assert.deepStrictEqual([found[0].kind, found[0].channel], [row[2], row[3]], JSON.stringify(row));
    });
    assert.strictEqual(hive('﻿SELECT 1').leaves[0].raw, '﻿');
    assert.strictEqual(leavesWithRaw(hive("SELECT '😀'"), "'😀'")[0].span.end - 7, 4);
    assert.ok(!hive('SELECT :id').leaves.some(function(leaf) { return leaf.kind === 'parameter'; }));

    var backslash = hive('SELECT \\');
    assert.ok(backslash.leaves.some(function(leaf) { return leaf.kind === 'unknown'; }));
    assert.deepStrictEqual(backslash.diagnostics, []);

    var shifts = hive('SELECT a >> b FROM t');
    assert.strictEqual(leavesWithRaw(shifts, '>').length, 2);
    assert.strictEqual(leavesWithRaw(shifts, '>>').length, 0);

    var struct = hive('SELECT STRUCT<a:INT>, STRUCT<a :INT>, STRUCT<a: INT>, STRUCT<a : INT>, STRUCT<`a`:BIGINT>, STRUCT<`a` :BIGINT>');
    assert.ok(!struct.leaves.some(function(leaf) { return leaf.kind === 'parameter'; }));
    var colons = leavesWithRaw(struct, ':');
    assert.strictEqual(colons.length, 6);
    assert.ok(colons.every(function(leaf) { return leaf.kind === 'punctuation' && leaf.channel === 'code'; }));

    // Lexemes of the Hive corpus fixtures that must stay one leaf each.
    var corpus = "SELECT '2026-07-11', `t(`, `a,b`, 'a  b', 'a', 'b', 'x', 'k', 'literal', 'y', 'n' FROM ${db}.src -- 保留 FROM 😀\n" +
        'WHERE ds = ${hivevar:day}';
    var output = hive(corpus);
    ["'2026-07-11'", '`t(`', '`a,b`', "'a  b'", "'a'", "'b'", "'x'", "'k'", "'literal'", "'y'", "'n'",
        '${db}.src', '-- 保留 FROM 😀', '${hivevar:day}'].forEach(function(raw) {
        assert.strictEqual(leavesWithRaw(output, raw).length, 1, raw);
    });
});

test('U-L3: an unterminated construct is one leaf to the end with one error', function() {
    [
        ["SELECT 'unterminated FROM t", "'", 'LEX_UNTERMINATED_STRING'],
        ['SELECT `open FROM t', '`', 'LEX_UNTERMINATED_QUOTED_IDENTIFIER'],
        ['SELECT /* open', '/*', 'LEX_UNTERMINATED_BLOCK_COMMENT'],
        ['SELECT ${open', '${', 'LEX_UNTERMINATED_TEMPLATE'],
        ['SELECT ${outer:${inner}', '${', 'LEX_UNTERMINATED_TEMPLATE']
    ].forEach(function(row) {
        var output = hive(row[0]);
        var span = { start: row[0].indexOf(row[1]), end: row[0].length };
        assert.deepStrictEqual(output.diagnostics.map(function(item) {
            return [item.code, item.severity, item.recovery, item.span];
        }), [[row[2], 'error', 'preserve-target', span]], row[0]);
        assert.strictEqual(output.leaves.filter(function(leaf) {
            return leaf.span.start === span.start && leaf.span.end === span.end;
        }).length, 1, row[0]);
    });
});

test('U-L4: deterministic fuzz conserves the source and lexes the same twice', function() {
    var rng = mulberry32(0xC0FFEE42);
    var fragments = [
        'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'JOIN', 'ON', 'AS', 'CASE', 'WHEN', 'THEN', 'END',
        'user_id', 'fact_orders', 'src', 'dst', 'id', 'ts', 'ds',
        '用户', '订单', '😀', '🚀', '中文',
        ' ', '  ', '\t', '\n', '\r\n', '\r',
        "'abc'", "'a''b'", '"x"', '`a,b`', '`t(`',
        '-- comment', '/* block */', '/* a /* b */ c */',
        '${db}', '${hivevar:day}', '$1', ':id', '@user_id', '?',
        '<=>', '==', '!=', '<=', '>=', '<>', '::', ':=', '->>', '->', '@>', '<@', '?|', '?&', '@?', '@@', '!~*',
        '1', '0', '42', '1.5', '.5', '5.', '1e10', '1.5e-3', '0xAF', '0b101',
        "E'abc'", "U&'d\\0061t'", "_utf8mb4'abc'", "X'AF'", "B'101'",
        '(', ')', ',', ';', '.', '[', ']',
        '\\', '§', '©',
        "'unterminated", '/* open', '${open', '`open', '$tag$open'
    ];
    for (var index = 0; index < 500; index++) {
        var count = 1 + Math.floor(rng() * 12);
        var parts = [];
        for (var part = 0; part < count; part++) {
            parts.push(fragments[Math.floor(rng() * fragments.length)]);
        }
        var source = parts.join('');
        var first = lexSql(source);
        assertConserves(source, first);
        assert.deepStrictEqual(lexSql(source), first);
    }
});
