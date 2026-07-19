var assert = require('assert');
var host = require('../../.tmp/v2-core/adapters/transaction/host-transaction');

function sourceMap(length) {
    return { entries: length === 0 ? [] : [{
        source: { start: 0, end: length },
        output: { start: 0, end: length }
    }] };
}

function executor(formatter) {
    return {
        format: async function(request) { return formatter(request); },
        dispose: async function() {}
    };
}

async function run() {
    var documentIdentity = {};
    var source = 'select a;\nselect b;\n';
    var applyCalls = 0;
    var result = await host.runHostTransaction({
        document: { identity: documentIdentity, source: source, version: 4 },
        targets: [
            { id: 'right', start: 10, end: 19, mode: 'fragment' },
            { id: 'left', start: 0, end: 9, mode: 'fragment' }
        ]
    }, executor(function(request) {
        return {
            status: 'formatted',
            text: request.source.toUpperCase(),
            diagnostics: [],
            sourceMap: sourceMap(request.source.length)
        };
    }), {
        currentDocument: function() {
            return { identity: documentIdentity, source: source, version: 4 };
        },
        apply: async function(transaction) {
            applyCalls += 1;
            assert.deepStrictEqual(transaction.edits.map(function(edit) {
                return edit.targetId;
            }), ['left', 'right'], 'commit receives one sorted atomic edit set');
            return true;
        }
    });
    assert.strictEqual(result.status, 'ready');
    assert.strictEqual(applyCalls, 1, 'multi-selection transaction commits exactly once');

    var staleApplyCalls = 0;
    var stale = await host.runHostTransaction({
        document: { identity: documentIdentity, source: source, version: 4 },
        targets: [{ id: 'document', start: 0, end: source.length, mode: 'document' }]
    }, executor(function(request) {
        return { status: 'formatted', text: request.source.toUpperCase(), diagnostics: [],
            sourceMap: sourceMap(request.source.length) };
    }), {
        currentDocument: function() {
            return { identity: documentIdentity, source: source + ' changed', version: 5 };
        },
        apply: async function() { staleApplyCalls += 1; return true; }
    });
    assert.strictEqual(stale.status, 'rejected');
    assert.strictEqual(stale.diagnostics[0].code, 'ADAPTER_STALE_DOCUMENT');
    assert.strictEqual(staleApplyCalls, 0, 'stale document must reject before commit');

    var otherIdentity = await host.runHostTransaction({
        document: { identity: documentIdentity, source: source, version: 4 },
        targets: [{ id: 'document', start: 0, end: source.length, mode: 'document' }]
    }, executor(function(request) {
        return { status: 'formatted', text: request.source.toUpperCase(), diagnostics: [],
            sourceMap: sourceMap(request.source.length) };
    }), {
        currentDocument: function() {
            return { identity: {}, source: source, version: 4 };
        },
        apply: async function() { throw new Error('must not apply'); }
    });
    assert.strictEqual(otherIdentity.diagnostics[0].code, 'ADAPTER_STALE_DOCUMENT',
        'active document identity change must reject even with same source/version');

    var rejected = await host.runHostTransaction({
        document: { identity: documentIdentity, source: source, version: 4 },
        targets: [{ id: 'document', start: 0, end: source.length, mode: 'document' }]
    }, executor(function(request) {
        return { status: 'formatted', text: request.source.toUpperCase(), diagnostics: [],
            sourceMap: sourceMap(request.source.length) };
    }), {
        currentDocument: function() {
            return { identity: documentIdentity, source: source, version: 4 };
        },
        apply: async function() { return false; }
    });
    assert.strictEqual(rejected.diagnostics[0].code, 'ADAPTER_EDIT_REJECTED');

    var thrownCommit = await host.runHostTransaction({
        document: { identity: documentIdentity, source: source, version: 4 },
        targets: [{ id: 'document', start: 0, end: source.length, mode: 'document' }]
    }, executor(function(request) {
        return { status: 'formatted', text: request.source.toUpperCase(), diagnostics: [],
            sourceMap: sourceMap(request.source.length) };
    }), {
        currentDocument: function() {
            return { identity: documentIdentity, source: source, version: 4 };
        },
        apply: async function() { throw new Error('host failed'); }
    });
    assert.strictEqual(thrownCommit.diagnostics[0].code, 'ADAPTER_EDIT_REJECTED',
        'commit throw must become a stable rejected result');

    var thrownCurrent = await host.runHostTransaction({
        document: { identity: documentIdentity, source: source, version: 4 },
        targets: [{ id: 'document', start: 0, end: source.length, mode: 'document' }]
    }, executor(function(request) {
        return { status: 'formatted', text: request.source.toUpperCase(), diagnostics: [],
            sourceMap: sourceMap(request.source.length) };
    }), {
        currentDocument: function() { throw new Error('host read failed'); },
        apply: async function() { throw new Error('must not apply'); }
    });
    assert.strictEqual(thrownCurrent.diagnostics[0].code, 'ADAPTER_HOST_FAILED',
        'current document read throw must be contained');

    var cancelledBeforeApply = false;
    var cancelledApplyCalls = 0;
    var cancelledBeforeCommit = await host.runHostTransaction({
        document: { identity: documentIdentity, source: source, version: 4 },
        targets: [{ id: 'document', start: 0, end: source.length, mode: 'document' }],
        cancellation: {
            get isCancellationRequested() { return cancelledBeforeApply; },
            onCancellationRequested: function() { return function() {}; }
        }
    }, executor(function(request) {
        return { status: 'formatted', text: request.source.toUpperCase(), diagnostics: [],
            sourceMap: sourceMap(request.source.length) };
    }), {
        currentDocument: function() {
            cancelledBeforeApply = true;
            return { identity: documentIdentity, source: source, version: 4 };
        },
        apply: async function() { cancelledApplyCalls += 1; return true; }
    });
    assert.strictEqual(cancelledBeforeCommit.status, 'cancelled',
        'cancellation during stale-document validation must stop before apply');
    assert.strictEqual(cancelledApplyCalls, 0,
        'cancelled results must never enter the host edit set');

    var disposerCalls = 0;
    await host.runHostTransaction({
        document: { identity: documentIdentity, source: source, version: 4 },
        targets: [{ id: 'document', start: 0, end: source.length, mode: 'document' }],
        cancellation: {
            isCancellationRequested: false,
            onCancellationRequested: function() {
                return function() { disposerCalls += 1; };
            }
        }
    }, executor(function(request) {
        return { status: 'formatted', text: request.source.toUpperCase(), diagnostics: [],
            sourceMap: sourceMap(request.source.length) };
    }), {
        currentDocument: function() {
            return { identity: documentIdentity, source: source, version: 4 };
        },
        apply: async function() { return true; }
    });
    assert.strictEqual(disposerCalls, 2,
        'prepare and host cancellation observations must each dispose exactly once');

    console.log('v2 Wave 4B multi-selection tests passed');
}

run().catch(function(error) {
    console.error(error);
    process.exitCode = 1;
});
