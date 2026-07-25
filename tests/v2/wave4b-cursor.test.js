var assert = require('assert');
var cursor = require('../../.tmp/v2-core/adapters/transaction/cursor');
var transaction = require('../../.tmp/v2-core/adapters/transaction/prepare');

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
