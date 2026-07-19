var assert = require('assert');
var cursor = require('../../.tmp/v2-core/adapters/transaction/cursor');
var transaction = require('../../.tmp/v2-core/adapters/transaction/prepare');

assert.deepStrictEqual(cursor.mapSelectionThroughSourceMap({ start: 4, end: 4 }, {
    entries: [
        { source: { start: 0, end: 3 }, output: { start: 0, end: 3 } },
        { source: { start: 5, end: 8 }, output: { start: 6, end: 9 } }
    ]
}, 8, 9), { start: 3, end: 3 },
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
        mode: 'fragment',
        selection: { start: 6, end: 7 }
    }]
}, executor).then(function(result) {
    assert.strictEqual(result.status, 'ready');
    assert.deepStrictEqual(result.selections[0], {
        targetId: 'selection',
        sourceStart: 0,
        sourceEnd: 10,
        outputStart: 0,
        outputEnd: 11,
        selectionStart: 6,
        selectionEnd: 8
    }, 'cursor selection uses left/right affinity plus document offset');
    console.log('v2 Wave 4B cursor tests passed');
}).catch(function(error) {
    console.error(error);
    process.exitCode = 1;
});
