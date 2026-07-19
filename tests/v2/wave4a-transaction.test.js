var assert = require('assert');
var transaction = require('../../.tmp/v2-core/adapters/transaction/prepare');

function diagnostic(source, code) {
    return {
        code: code,
        severity: 'warning',
        message: 'Target was preserved',
        capabilityId: null,
        span: { start: 0, end: source.length },
        recovery: 'preserve-target'
    };
}

function sourceMap(sourceLength, outputLength) {
    var length = Math.min(sourceLength, outputLength, 1);
    return {
        entries: length === 0 ? [] : [{
            source: { start: 0, end: length },
            output: { start: 0, end: length }
        }]
    };
}

function createExecutor(formatter) {
    var calls = [];
    return {
        calls: calls,
        format: async function(request) {
            calls.push(request);
            return formatter(request);
        },
        dispose: async function() {}
    };
}

async function run() {
    var executor = createExecutor(function(request) {
        var output = request.targetId == 'first' ? 'AAAA' : 'C';
        return {
            status: 'formatted',
            text: output,
            diagnostics: [],
            sourceMap: sourceMap(request.source.length, output.length)
        };
    });
    var ready = await transaction.prepareFormatTransaction({
        source: 'a bb ccc',
        documentVersion: 7,
        targets: [
            { id: 'second', start: 5, end: 8, mode: 'fragment' },
            { id: 'first', start: 0, end: 1, mode: 'fragment' }
        ]
    }, executor);
    assert.strictEqual(ready.status, 'ready', 'safe formatted targets must produce a ready transaction');
    assert.deepStrictEqual(ready.edits.map(function(edit) { return edit.targetId; }), ['first', 'second'],
        'transaction targets must be normalized into source order');
    assert.deepStrictEqual(ready.selections, [
        { targetId: 'first', sourceStart: 0, sourceEnd: 1, outputStart: 0, outputEnd: 4 },
        { targetId: 'second', sourceStart: 5, sourceEnd: 8, outputStart: 8, outputEnd: 9 }
    ], 'selection ranges must include cumulative edit deltas');
    assert.strictEqual(Object.isFrozen(ready), true, 'transaction result must be frozen');
    assert.strictEqual(Object.isFrozen(ready.edits), true, 'transaction edits must be frozen');
    assert.strictEqual(Object.isFrozen(ready.selections), true, 'transaction selections must be frozen');

    var overlapExecutor = createExecutor(function() {
        throw new Error('must not run');
    });
    var overlap = await transaction.prepareFormatTransaction({
        source: 'select a',
        documentVersion: 1,
        targets: [
            { id: 'left', start: 0, end: 5, mode: 'fragment' },
            { id: 'right', start: 4, end: 8, mode: 'fragment' }
        ]
    }, overlapExecutor);
    assert.strictEqual(overlap.status, 'rejected', 'overlapping targets must be rejected');
    assert.strictEqual(overlapExecutor.calls.length, 0, 'overlap rejection must happen before formatting');

    var preservedExecutor = createExecutor(function(request) {
        if (request.targetId == 'bad') {
            return {
                status: 'preserved',
                text: request.source,
                diagnostics: [diagnostic(request.source, 'SYN_PRESERVED')]
            };
        }
        return {
            status: 'formatted',
            text: request.source.toUpperCase(),
            diagnostics: [],
            sourceMap: sourceMap(request.source.length, request.source.length)
        };
    });
    var rejected = await transaction.prepareFormatTransaction({
        source: 'one two',
        documentVersion: 2,
        targets: [
            { id: 'good', start: 0, end: 3, mode: 'fragment' },
            { id: 'bad', start: 4, end: 7, mode: 'fragment' }
        ]
    }, preservedExecutor);
    assert.strictEqual(rejected.status, 'rejected', 'one preserved target must reject the complete transaction');
    assert.strictEqual(preservedExecutor.calls.length, 2, 'all safe target computations happen before edit construction');
    assert.strictEqual(rejected.edits, undefined, 'rejected transaction must never expose partial edits');
    assert.deepStrictEqual(rejected.diagnostics.map(function(item) { return item.targetId; }), ['bad'],
        'target diagnostics must retain absolute target identity');
    assert.deepStrictEqual(rejected.diagnostics[0].span, { start: 4, end: 7 },
        'target diagnostics must translate to document offsets');

    var unchangedExecutor = createExecutor(function(request) {
        return {
            status: 'unchanged',
            text: request.source,
            diagnostics: [],
            sourceMap: sourceMap(request.source.length, request.source.length)
        };
    });
    var unchanged = await transaction.prepareFormatTransaction({
        source: 'SELECT 1',
        documentVersion: 3,
        targets: [{ id: 'document', start: 0, end: 8, mode: 'document' }]
    }, unchangedExecutor);
    assert.strictEqual(unchanged.status, 'unchanged', 'all unchanged targets must produce no edits');
    assert.deepStrictEqual(unchanged.edits, []);

    var cancelled = false;
    var token = {
        get isCancellationRequested() {
            return cancelled;
        },
        onCancellationRequested: function() {
            return function() {};
        }
    };
    var cancellationExecutor = createExecutor(function(request) {
        cancelled = true;
        return {
            status: 'formatted',
            text: request.source.toUpperCase(),
            diagnostics: [],
            sourceMap: sourceMap(request.source.length, request.source.length)
        };
    });
    var cancelledResult = await transaction.prepareFormatTransaction({
        source: 'select 1',
        documentVersion: 4,
        targets: [{ id: 'document', start: 0, end: 8, mode: 'document' }],
        cancellation: token
    }, cancellationExecutor);
    assert.strictEqual(cancelledResult.status, 'cancelled', 'post-format cancellation must discard computed output');
    assert.strictEqual(cancelledResult.edits, undefined, 'cancelled transaction must not expose edits');

    var invalidContractExecutor = createExecutor(function() {
        return {
            status: 'failed',
            text: 'changed',
            diagnostics: []
        };
    });
    var invalidContract = await transaction.prepareFormatTransaction({
        source: 'select 1',
        documentVersion: 5,
        targets: [{ id: 'document', start: 0, end: 8, mode: 'document' }]
    }, invalidContractExecutor);
    assert.strictEqual(invalidContract.status, 'rejected', 'invalid executor result must fail closed');
    assert.strictEqual(invalidContract.diagnostics[0].code, 'ADAPTER_RESULT_CONTRACT');

    var errorDiagnosticExecutor = createExecutor(function(request) {
        return {
            status: 'formatted',
            text: request.source.toUpperCase(),
            diagnostics: [
                {
                    code: 'FMT_FATAL',
                    severity: 'error',
                    message: 'Fatal formatter diagnostic',
                    capabilityId: null,
                    span: { start: 0, end: request.source.length },
                    recovery: 'preserve-target'
                }
            ],
            sourceMap: sourceMap(request.source.length, request.source.length)
        };
    });
    var errorDiagnostic = await transaction.prepareFormatTransaction({
        source: 'select 1',
        documentVersion: 6,
        targets: [{ id: 'document', start: 0, end: 8, mode: 'document' }]
    }, errorDiagnosticExecutor);
    assert.strictEqual(errorDiagnostic.status, 'rejected',
        'error diagnostics must reject a transaction even when text is formatted');

    var toctouExecutor = createExecutor(function(request) {
        var reads = 0;
        var result = {
            status: 'formatted',
            text: request.source.toUpperCase(),
            diagnostics: [],
            sourceMap: null
        };
        Object.defineProperty(result, 'sourceMap', {
            enumerable: true,
            get: function() {
                reads += 1;
                return reads == 1
                    ? sourceMap(request.source.length, request.source.length)
                    : { entries: [{
                        source: { start: 9, end: 10 },
                        output: { start: 99, end: 100 }
                    }] };
            }
        });
        return result;
    });
    var toctou = await transaction.prepareFormatTransaction({
        source: 'select 1',
        documentVersion: 7,
        targets: [{ id: 'document', start: 0, end: 8, mode: 'document' }]
    }, toctouExecutor);
    assert.strictEqual(toctou.status, 'rejected',
        'a source map that changes during inspection must fail closed');
    assert.strictEqual(toctou.diagnostics[0].code, 'ADAPTER_RESULT_SNAPSHOT');

    var emptyExecutor = createExecutor(function() {
        throw new Error('empty target must not invoke executor');
    });
    var emptyTarget = await transaction.prepareFormatTransaction({
        source: 'abc',
        documentVersion: 8,
        targets: [{ id: 'cursor', start: 1, end: 1, mode: 'fragment' }]
    }, emptyExecutor);
    assert.strictEqual(emptyTarget.status, 'unchanged',
        'empty targets must be unchanged rather than insertion edits');
    assert.strictEqual(emptyExecutor.calls.length, 0,
        'empty targets must not invoke the formatter');

    var unknownStatusExecutor = createExecutor(function(request) {
        return {
            status: 'bogus',
            text: request.source,
            diagnostics: [diagnostic(request.source, 'FMT_BOGUS')]
        };
    });
    var unknownStatus = await transaction.prepareFormatTransaction({
        source: 'select 1',
        documentVersion: 9,
        targets: [{ id: 'document', start: 0, end: 8, mode: 'document' }]
    }, unknownStatusExecutor);
    assert.strictEqual(unknownStatus.status, 'rejected',
        'unknown executor statuses must not be disguised as unchanged');
    assert.strictEqual(unknownStatus.diagnostics[0].code, 'ADAPTER_RESULT_CONTRACT');

    var targetReads = 0;
    var changingTarget = {};
    Object.defineProperties(changingTarget, {
        id: { enumerable: true, get: function() { return 'target'; } },
        mode: { enumerable: true, get: function() { return 'fragment'; } },
        start: {
            enumerable: true,
            get: function() {
                targetReads += 1;
                return targetReads == 1 ? 0 : 99;
            }
        },
        end: { enumerable: true, get: function() { return 3; } }
    });
    var changingTargetExecutor = createExecutor(function(request) {
        return {
            status: 'formatted',
            text: request.source.toUpperCase(),
            diagnostics: [],
            sourceMap: sourceMap(request.source.length, request.source.length)
        };
    });
    var changingTargetResult = await transaction.prepareFormatTransaction({
        source: 'abc',
        documentVersion: 10,
        targets: [changingTarget]
    }, changingTargetExecutor);
    assert.strictEqual(changingTargetResult.status, 'ready',
        'target properties must be read once into a stable primitive snapshot');
    assert.deepStrictEqual(
        { start: changingTargetResult.edits[0].start, end: changingTargetResult.edits[0].end },
        { start: 0, end: 3 },
        'later target getter values must not alter the frozen transaction range'
    );

    console.log('v2 Wave 4A transaction tests passed');
}

run().catch(function(error) {
    console.error(error);
    process.exitCode = 1;
});
