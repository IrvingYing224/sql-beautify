var assert = require('assert');
var cursor = require('../../.tmp/v2-core/adapters/transaction/cursor');
var edits = require('../../.tmp/v2-core/adapters/transaction/edit-preview');
var lines = require('../../.tmp/v2-core/adapters/text/line-index');
var transaction = require('../../.tmp/v2-core/adapters/transaction/prepare');

var lineIndex = lines.buildTextLineIndex('a\r\nb\rc\nd');
assert.deepStrictEqual(lines.positionAtOffset(lineIndex, 0), { line: 0, character: 0 });
assert.deepStrictEqual(lines.positionAtOffset(lineIndex, 3), { line: 1, character: 0 });
assert.deepStrictEqual(lines.positionAtOffset(lineIndex, 5), { line: 2, character: 0 });
assert.deepStrictEqual(lines.positionAtOffset(lineIndex, 7), { line: 3, character: 0 });
assert.strictEqual(lines.positionAtOffset(lineIndex, 2), null,
    'the midpoint of CRLF is not a valid editor position');

var preview = edits.previewTextEdits('0123456789', [
    { start: 6, end: 8, text: 'XYZ' },
    { start: 1, end: 4, text: 'A' }
]);
assert.strictEqual(preview.output, '0A45XYZ89',
    'edit preview must sort, validate and construct output with one chunks/join pass');
assert.strictEqual(edits.mapOffsetThroughEdits(preview, 0), 0);
assert.strictEqual(edits.mapOffsetThroughEdits(preview, 1), 1);
assert.strictEqual(edits.mapOffsetThroughEdits(preview, 3), 2,
    'offsets inside replacements use relative clamp mapping');
assert.strictEqual(edits.mapOffsetThroughEdits(preview, 4), 2,
    'exact edit end maps to replacement end');
assert.strictEqual(edits.mapOffsetThroughEdits(preview, 10), preview.output.length);
assert.deepStrictEqual(edits.mapOffsetsThroughEdits(preview, [10, 1, 3, 4, 0]), [
    preview.output.length, 1, 2, 2, 0
], 'batch offset mapping must preserve input order while scanning edits once');
assert.strictEqual(edits.previewTextEdits('abc', [
    { start: 0, end: 2, text: 'x' },
    { start: 1, end: 3, text: 'y' }
]), null, 'overlapping host edits must fail before editor.edit');

assert.deepStrictEqual(cursor.mapSelectionThroughSourceMap({ anchor: 4, active: 4 }, {
    entries: [
        { source: { start: 0, end: 3 }, output: { start: 0, end: 3 } },
        { source: { start: 5, end: 8 }, output: { start: 6, end: 9 } }
    ]
}, 8, 9), { anchor: 3, active: 3 },
'collapsed cursor in generated gap must remain collapsed');

var executor = {
    format: async function(request) {
        return {
            status: 'formatted',
            text: 'SELECT  a;\n',
            diagnostics: [],
            sourceMap: { entries: [
                { source: { start: 0, end: 6 }, output: { start: 0, end: 6 } },
                { source: { start: 6, end: 9 }, output: { start: 7, end: 10 } },
                { source: { start: 9, end: 10 }, output: { start: 10, end: 11 } }
            ] }
        };
    },
    dispose: async function() {}
};

transaction.prepareFormatTransaction({
    source: 'select a;\n',
    documentVersion: 1,
    targets: [{
        id: 'selection',
        start: 0,
        end: 10,
        mode: 'fragment'
    }],
    selections: [{ id: 'primary', targetId: 'selection', anchor: 7, active: 6 }]
}, executor).then(function(result) {
    assert.strictEqual(result.status, 'ready');
    assert.deepStrictEqual(result.selections[0], {
        selectionId: 'primary',
        selectionAnchor: 8,
        selectionActive: 6
    }, 'backward selection uses left/right affinity, retains direction and adds document offset');
    console.log('v2 Wave 4B cursor tests passed');
}).catch(function(error) {
    console.error(error);
    process.exitCode = 1;
});
