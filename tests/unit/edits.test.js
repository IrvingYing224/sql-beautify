'use strict';

// computeEdits for queries (plan §5.4, §5.5): range classification, multi-target atomicity, newline,
// selection and diagnostic mapping. Expected values were measured on 2.2.1 (P4a keeps them).

var assert = require('assert');
var crypto = require('crypto');
var fs = require('fs');
var path = require('path');
var test = require('node:test');
var m = require('./helpers/src')({
    compute: 'edits/compute',
    range: 'edits/range',
    offsets: 'edits/offsets',
    sourceMap: 'core/source/source-map',
    environment: 'core/renderer/environment'
});

function format(source, targets, extra) {
    return m.compute.computeEdits(Object.assign({
        op: 'format',
        source: source,
        targets: targets || [{ id: 'document', start: 0, end: source.length, mode: 'document' }],
        selections: [],
        options: {},
        newline: m.environment.inferRenderNewline(source, '\n'),
        tabSize: 4
    }, extra));
}

function fragment(id, start, end) {
    return { id: id, start: start, end: end, mode: 'fragment' };
}

function diagnostics(result) {
    return result.diagnostics.map(function(item) {
        return [item.code, item.severity, item.span.start, item.span.end, item.targetId];
    });
}

function edits(result) {
    return result.edits.map(function(edit) { return [edit.targetId, edit.start, edit.end, edit.text]; });
}

/** The range class of one fragment target: its parse mode when accepted, else the code. */
function rangeClass(source, start, end) {
    var result = m.range.validateFormatTargets(source, [fragment('x', start, end)], 'hive');
    return result.ok ? result.modes.get('x') : result.code;
}

var S = 'select a,\n       b\nfrom t\nwhere x = 1\n';

test('U1 U2: edits come in source order; selections keep request order and direction', function() {
    var source = 'select   a;\nselect   b;\n';
    var result = format(source, [fragment('second', 12, 24), fragment('first', 0, 12)], {
        selections: [
            { targetId: 'second', anchor: 24, active: 12 },
            { targetId: null, anchor: 24, active: 24 },
            { targetId: 'first', anchor: 0, active: 12 }
        ]
    });
    assert.strictEqual(result.status, 'ready');
    assert.deepStrictEqual(edits(result), [['first', 0, 12, 'SELECT a;\n'], ['second', 12, 24, 'SELECT b;\n']]);
    assert.deepStrictEqual(result.selections, [{ anchor: 20, active: 10 }, { anchor: 20, active: 20 }, { anchor: 0, active: 10 }]);
});

test('U3: contiguous whole statements format as a document', function() {
    for (var source of ['select a;\nselect b;\nselect c;\n', 'select a;\nselect b;']) {
        var result = format(source, [fragment('x', 0, 19)]);
        assert.deepStrictEqual(edits(result), [['x', 0, 19, 'SELECT a;\nSELECT b;']]);
    }
});

test('U4: fragments use the document newline', function() {
    var result = format('select a, b from t;\r\nselect c, d from u;', [fragment('left', 0, 19), fragment('right', 21, 40)]);
    assert.deepStrictEqual(edits(result), [
        ['left', 0, 19, 'SELECT\r\n      a\r\n    , b\r\nFROM t;'],
        ['right', 21, 40, 'SELECT\r\n      c\r\n    , d\r\nFROM u;']
    ]);
});

test('U6 U7 U8 U11 U12: overlap, one preserved target, all unchanged, empty and partial targets', function() {
    var result = format('select a', [fragment('left', 0, 5), fragment('right', 4, 8)]);
    assert.strictEqual(result.status, 'rejected');
    assert.deepStrictEqual(diagnostics(result), [['ADAPTER_TRANSACTION_TARGET', 'error', 0, 8, null]]);

    result = format(S, [fragment('select', 0, 18), fragment('where', 26, 37)]);
    assert.deepStrictEqual([result.status, result.edits], ['rejected', []]);
    assert.deepStrictEqual(diagnostics(result), [['SYN_UNMODELED_CONSTRUCT', 'warning', 26, 37, 'where']]);

    result = format('SELECT 1');
    assert.deepStrictEqual(result, { status: 'unchanged', edits: [], selections: [], diagnostics: [], debugEvents: [] });
    assert.strictEqual(format('abc', [fragment('empty', 1, 1)]).status, 'unchanged');

    result = format('select a from t\n', [fragment('partial', 1, 15)]);
    // K26: a range rejection is information about the request, not an error in the SQL.
    assert.deepStrictEqual(diagnostics(result), [['ADAPTER_RANGE_LINE', 'info', 1, 15, 'partial']]);
});

test('U10: diagnostics of a ready result are in output coordinates, widened over layout gaps', function() {
    var result = format('select a div b from t');
    assert.deepStrictEqual(edits(result), [['document', 0, 21, 'SELECT\n      a div b\nFROM t']]);
    assert.deepStrictEqual(diagnostics(result), [['SYN_UNEXPECTED_TOKEN', 'warning', 6, 21, 'document']]);
});

test('U13: 524,288 code units are accepted, one more is rejected before formatting', function() {
    assert.strictEqual(format(' '.repeat(524288)).status, 'unchanged');
    assert.deepStrictEqual(diagnostics(format(' '.repeat(524288) + 'x')),
        [['ADAPTER_INPUT_LIMIT', 'error', 0, 524289, null]]);
});

test('U-TX: one target over the output limit rejects all 24', function() {
    var heavy = fs.readFileSync(path.join(__dirname, '..', 'golden', 'cases', 'explicit', 'resource', 'nested-case-80.in.txt'), 'utf8')
        .replace(/\n$/, '');
    function lines(withHeavy) {
        return Array.from({ length: 24 }, function(_, index) {
            return withHeavy && index === 17 ? heavy + ';\n' : 'select c' + index + ';\n';
        });
    }
    function targets(values) {
        var start = 0;
        return values.map(function(line, index) {
            start += line.length;
            return fragment('line:' + index, start - line.length, start);
        });
    }
    var source = lines(true).join('');
    var result = format(source, targets(lines(true)));
    assert.deepStrictEqual([result.status, result.edits], ['rejected', []]);
    assert.deepStrictEqual(diagnostics(result), [['RENDER_OUTPUT_LIMIT', 'warning', 194, 2927, 'line:17']]);
    result = format(lines(false).join(''), targets(lines(false)));
    assert.strictEqual(result.edits.length, 24);
    assert.deepStrictEqual(edits(result)[0], ['line:0', 0, 11, 'SELECT c0;\n']);
});

test('R1 R4 R5: clause, list and statement fragments, end to end', function() {
    assert.deepStrictEqual(edits(format(S, [fragment('select', 0, 18)])), [['select', 0, 18, 'SELECT\n      a\n    , b']]);
    // Fragment-mode core preserves FROM, WHERE and list fragments (2.2.1 behavior).
    for (var targets of [[[19, 25]], [[26, 37]], [[26, 38]], [[19, 25], [26, 37]]]) {
        var result = format(S, targets.map(function(value, index) { return fragment('t' + index, value[0], value[1]); }));
        assert.strictEqual(result.status, 'rejected');
        assert.deepStrictEqual(result.diagnostics.map(function(item) { return item.code; }),
            targets.map(function() { return 'SYN_UNMODELED_CONSTRUCT'; }));
    }
    assert.strictEqual(rangeClass('select a from t\n', 0, 15), 'fragment');
    result = format('select\n  a,\n  b\nfrom t\n', [fragment('list', 7, 15)]);
    assert.deepStrictEqual(diagnostics(result), [['SYN_UNMODELED_CONSTRUCT', 'warning', 7, 15, 'list']]);
    assert.strictEqual(rangeClass(S, 3, 3), 'fragment');
    assert.strictEqual(rangeClass(S, 0, 38), 'document');
    for (var mode of ['fragment', 'document']) {
        result = format('select (\n', [{ id: 'x', start: 0, end: 9, mode: mode }]);
        assert.deepStrictEqual(diagnostics(result), [['SYN_UNMATCHED_DELIMITER', 'warning', 0, 9, 'x']]);
    }
});

test('R2-R7: range codes', function() {
    var cases = [
        [S, 1, 18, 'ADAPTER_RANGE_LINE'],
        [S, 17, 37, 'ADAPTER_RANGE_LINE'],
        [S, 26, 35, 'ADAPTER_RANGE_LINE'],
        ['select a;\nselect b;\nselect c;\n', 0, 17, 'ADAPTER_RANGE_LINE'],
        ['select a;\nselect b;\nselect c;\n', 0, 8, 'ADAPTER_RANGE_LINE'],
        ['select a;\nselect b;\nselect c;\n', 0, 9, 'fragment'],
        ['select a;\r\nselect b;\r\n', 0, 9, 'fragment'],
        ['select a;\r\nselect b;\r\n', 0, 11, 'fragment'],
        ['select a;\r\nselect b;\r\n', 11, 20, 'fragment'],
        ['select a;\r\nselect b;\r\n', 0, 10, 'ADAPTER_RANGE_LINE'],
        ['select a;\r\nselect b;\r\n', 10, 20, 'ADAPTER_RANGE_LINE'],
        ['select a;\rselect b;\r', 10, 19, 'fragment'],
        ["select 'a\\nb' from t\n", 10, 13, 'ADAPTER_RANGE_PROTECTED'],
        ['select a /* comment */ from t\n', 0, 12, 'ADAPTER_RANGE_PROTECTED'],
        ['select `a` from t\n', 0, 9, 'ADAPTER_RANGE_PROTECTED'],
        ['select ${param} from t\n', 0, 10, 'ADAPTER_RANGE_PROTECTED'],
        ['select\n  a,\n  b\nfrom t\n', 7, 15, 'fragment'],
        ['select\n  a,\n  b\nfrom t\n', 7, 11, 'ADAPTER_RANGE_OWNERSHIP'],
        [S, 19, 37, 'ADAPTER_RANGE_OWNERSHIP'],
        ['select a\nqualify row_number() over (order by a)=1\n', 0, 8, 'ADAPTER_RANGE_OPAQUE'],
        ['select a;\nCREATE TABLE t(x INT);\nselect b;\n', 10, 32, 'ADAPTER_RANGE_OPAQUE'],
        ['select a;\nCREATE TABLE t(x INT);\nselect b;\n', 0, 9, 'fragment'],
        ['select one;\nselect a div b from t;\n', 12, 35, 'ADAPTER_RANGE_OPAQUE'],
        ['-- first\nselect a;\n/* last */\n  ', 19, 29, 'ADAPTER_RANGE_EMPTY'],
        [' \t\nselect a;\n\t \nselect b;\n   ', 0, 2, 'ADAPTER_RANGE_EMPTY']
    ];
    cases.forEach(function(value) {
        assert.strictEqual(rangeClass(value[0], value[1], value[2]), value[3], JSON.stringify(value));
    });
});

test('R8: every range of eight sources classifies as in 2.2.1', function() {
    var expected = [
        ['select a,\n b\nfrom t\nwhere x=1\n', '4b1e1c2382ce70ac'],
        ['select a;\r\n\r\nselect b;\r\nselect c;\r\n', '0e6e9864cbdf024c'],
        ['select a;\rselect b;\r', '37b352b0aaeb9c28'],
        ['-- first\nselect a;\n/* last */\n  ', '4deb591d74a20628'],
        ["select 'a\nb', `x\ny` from t;\nselect c;", 'c5d2468ffb058d38'],
        ['select a;\nCREATE TABLE t(x INT);\nselect b;\n', '09554b1e7b6e6977'],
        ['﻿select a;\n;\nselect b;\n', 'f1b580867fc6523d'],
        [' \t\nselect a;\n\t \nselect b;\n   ', 'c8f20e92a6ce9bab']
    ];
    expected.forEach(function(value) {
        var source = value[0];
        var lines = [];
        for (var start = 0; start <= source.length; start++) {
            for (var end = start; end <= source.length; end++) {
                lines.push(start + ':' + end + '=' + rangeClass(source, start, end));
            }
        }
        assert.strictEqual(crypto.createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 16), value[1],
            JSON.stringify(source));
    });
});

test('C2: delta mapping for edits without a source map', function() {
    var values = [{ start: 1, end: 4, text: 'A' }, { start: 6, end: 8, text: 'XYZ' }];
    assert.strictEqual(m.offsets.applyEdits('0123456789', values), '0A45XYZ89');
    // K20: an offset inside an edit maps to the replacement start, not into the replacement.
    assert.deepStrictEqual([0, 1, 3, 4, 5, 7, 8, 10].map(function(offset) {
        return m.offsets.mapThroughEdits(values, offset);
    }), [0, 1, 1, 2, 3, 4, 7, 9]);
});

test('C3 S1 S2: source-map mapping of cursors, selections and offsets', function() {
    var result = format('select   a;\n', [fragment('x', 0, 12)], {
        selections: [{ targetId: 'x', anchor: 10, active: 7 }, { targetId: 'x', anchor: 8, active: 8 }]
    });
    assert.deepStrictEqual(edits(result), [['x', 0, 12, 'SELECT a;\n']]);
    assert.deepStrictEqual(result.selections, [{ anchor: 8, active: 6 }, { anchor: 6, active: 6 }]);

    var map = { entries: [{ source: { start: 0, end: 3 }, output: { start: 0, end: 3 } }, { source: { start: 5, end: 8 }, output: { start: 6, end: 9 } }] };
    var mapper = m.sourceMap.createSourceOffsetMapper(map, 10, 12);
    assert.deepStrictEqual([[2, 'exact'], [4, 'left'], [4, 'right'], [4, 'exact'], [5, 'left'], [5, 'right'], [10, 'left'], [10, 'right']]
        .map(function(value) { return mapper.map(value[0], value[1]); }), [2, 3, 6, null, 3, 6, 9, 12]);
    mapper = m.sourceMap.createSourceOffsetMapper({ entries: [{ source: { start: 0, end: 1 }, output: { start: 0, end: 1 } }] }, 1, 4);
    assert.strictEqual(mapper.map(1, 'right'), 4);
    mapper = m.sourceMap.createSourceOffsetMapper({ entries: [map.entries[1]] }, 10, 12);
    assert.deepStrictEqual([[0, 'left'], [0, 'right'], [0, 'exact'], [5, 'left']]
        .map(function(value) { return mapper.map(value[0], value[1]); }), [0, 6, null, 0]);
    assert.strictEqual(m.sourceMap.createSourceOffsetMapper({ entries: [] }, 0, 0).map(0, 'exact'), 0);
    assert.deepStrictEqual([[0, 8], [8, 0], [4, 4]].map(function(value) {
        return m.offsets.mapSelection({ anchor: value[0], active: value[1] }, map, 10, 12);
    }), [{ anchor: 0, active: 9 }, { anchor: 9, active: 0 }, { anchor: 3, active: 3 }]);
});
