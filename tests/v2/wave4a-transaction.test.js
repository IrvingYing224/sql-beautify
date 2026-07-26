var assert = require('assert');
var performance = require('perf_hooks').performance;
var transaction = require('../../.tmp/v2-core/adapters/transaction/prepare');
var resultBoundary = require('../../.tmp/v2-core/adapters/boundary/format-result-snapshot');
var safeReport = require('../../.tmp/v2-core/adapters/vscode/safe-report');

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
        var output = request.targetId == 'first' ? 'SELECT AAA;\n' : 'S;\n';
        return {
            status: 'formatted',
            text: output,
            diagnostics: [],
            sourceMap: sourceMap(request.source.length, output.length)
        };
    });
    var multiSource = 'select a;\nselect b;\n';
    var ready = await transaction.prepareFormatTransaction({
        source: multiSource,
        documentVersion: 7,
        targets: [
            { id: 'second', start: 10, end: 20, mode: 'fragment' },
            { id: 'first', start: 0, end: 10, mode: 'fragment' }
        ],
        selections: [
            { id: 'primary', targetId: 'second', anchor: 20, active: 10 },
            { id: 'outside', targetId: null, anchor: 20, active: 20 },
            { id: 'secondary', targetId: 'first', anchor: 0, active: 10 }
        ]
    }, executor);
    assert.strictEqual(ready.status, 'ready', 'safe formatted targets must produce a ready transaction');
    assert.deepStrictEqual(ready.edits.map(function(edit) { return edit.targetId; }), ['first', 'second'],
        'transaction targets must be normalized into source order');
    assert.deepStrictEqual(ready.selections, [
        { selectionId: 'primary', selectionAnchor: 15, selectionActive: 12 },
        { selectionId: 'outside', selectionAnchor: 13, selectionActive: 13 },
        { selectionId: 'secondary', selectionAnchor: 0, selectionActive: 12 }
    ], 'selection order/direction must survive source-sorted target edits');
    assert.strictEqual(Object.isFrozen(ready), true, 'transaction result must be frozen');
    assert.strictEqual(Object.isFrozen(ready.edits), true, 'transaction edits must be frozen');
    assert.strictEqual(Object.isFrozen(ready.selections), true, 'transaction selections must be frozen');
    assert.deepStrictEqual(executor.calls.map(function(call) { return call.newline; }),
        ['\n', '\n'], 'all fragments must inherit the complete document EOL');

    var crlfExecutor = createExecutor(function(request) {
        return {
            status: 'unchanged',
            text: request.source,
            diagnostics: [],
            sourceMap: sourceMap(request.source.length, request.source.length)
        };
    });
    var crlfSource = 'select a;\r\nselect b;';
    var crlfResult = await transaction.prepareFormatTransaction({
        source: crlfSource,
        documentVersion: 8,
        targets: [
            { id: 'left', start: 0, end: 9, mode: 'fragment' },
            { id: 'right', start: 11, end: 20, mode: 'fragment' }
        ]
    }, crlfExecutor);
    assert.strictEqual(crlfResult.status, 'unchanged');
    assert.deepStrictEqual(
        crlfExecutor.calls.map(function(call) { return call.newline; }),
        ['\r\n', '\r\n'],
        'fragments without physical EOL must inherit CRLF from the full document'
    );

    var fallbackExecutor = createExecutor(function(request) {
        return {
            status: 'unchanged', text: request.source, diagnostics: [],
            sourceMap: sourceMap(request.source.length, request.source.length)
        };
    });
    var fallbackResult = await transaction.prepareFormatTransaction({
        source: 'select a',
        documentVersion: 9,
        newline: '\r\n',
        targets: [{ id: 'document', start: 0, end: 8, mode: 'document' }]
    }, fallbackExecutor);
    assert.strictEqual(fallbackResult.status, 'unchanged');
    assert.strictEqual(fallbackExecutor.calls[0].newline, '\r\n');

    var invalidNewlineExecutor = createExecutor(function() {
        throw new Error('invalid newline must not reach executor');
    });
    var invalidNewline = await transaction.prepareFormatTransaction({
        source: 'select a',
        documentVersion: 10,
        newline: '\r\r',
        targets: [{ id: 'document', start: 0, end: 8, mode: 'document' }]
    }, invalidNewlineExecutor);
    assert.strictEqual(invalidNewline.status, 'rejected');
    assert.strictEqual(invalidNewlineExecutor.calls.length, 0);

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
    var preservedSource = 'select one;\nselect two;\n';
    var rejected = await transaction.prepareFormatTransaction({
        source: preservedSource,
        documentVersion: 2,
        targets: [
            { id: 'good', start: 0, end: 12, mode: 'fragment' },
            { id: 'bad', start: 12, end: 24, mode: 'fragment' }
        ]
    }, preservedExecutor);
    assert.strictEqual(rejected.status, 'rejected', 'one preserved target must reject the complete transaction');
    assert.strictEqual(preservedExecutor.calls.length, 2, 'all safe target computations happen before edit construction');
    assert.strictEqual(rejected.edits, undefined, 'rejected transaction must never expose partial edits');
    assert.deepStrictEqual(rejected.diagnostics.map(function(item) { return item.targetId; }), ['bad'],
        'target diagnostics must retain absolute target identity');
    assert.deepStrictEqual(rejected.diagnostics[0].span, { start: 12, end: 24 },
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

    var objectText = await transaction.prepareFormatTransaction({
        source: 'select 1',
        documentVersion: 51,
        targets: [{ id: 'document', start: 0, end: 8, mode: 'document' }]
    }, createExecutor(function() {
        return {
            status: 'formatted',
            text: { length: 8 },
            diagnostics: [],
            sourceMap: sourceMap(8, 8)
        };
    }));
    assert.strictEqual(objectText.status, 'rejected',
        'formatted result text must be a primitive string');
    assert.strictEqual(objectText.diagnostics[0].code, 'ADAPTER_RESULT_CONTRACT');
    var boxedText = await transaction.prepareFormatTransaction({
        source: 'select 1',
        documentVersion: 52,
        targets: [{ id: 'document', start: 0, end: 8, mode: 'document' }]
    }, createExecutor(function() {
        return {
            status: 'formatted',
            text: new String('SELECT 1'),
            diagnostics: [],
            sourceMap: sourceMap(8, 8)
        };
    }));
    assert.strictEqual(boxedText.status, 'rejected',
        'boxed strings must not escape the primitive result contract');

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

    var toctouReads = 0;
    var toctouExecutor = createExecutor(function(request) {
        var result = {
            status: 'formatted',
            text: request.source.toUpperCase(),
            diagnostics: [],
            sourceMap: null
        };
        Object.defineProperty(result, 'sourceMap', {
            enumerable: true,
            get: function() {
                toctouReads += 1;
                return toctouReads == 1
                    ? sourceMap(request.source.length, request.source.length)
                    : sourceMap(request.source.length, request.source.length);
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
        'a source map accessor that could change between legal values must fail closed');
    assert.strictEqual(toctou.diagnostics[0].code, 'ADAPTER_RESULT_SNAPSHOT');
    assert.strictEqual(toctouReads, 0, 'formatter result accessors must never be invoked');
    var proxiedResult = await transaction.prepareFormatTransaction({
        source: 'select 1',
        documentVersion: 71,
        targets: [{ id: 'document', start: 0, end: 8, mode: 'document' }]
    }, createExecutor(function(request) {
        return new Proxy({
            status: 'formatted', text: request.source.toUpperCase(), diagnostics: [],
            sourceMap: sourceMap(request.source.length, request.source.length)
        }, {});
    }));
    assert.strictEqual(proxiedResult.status, 'rejected');
    assert.strictEqual(proxiedResult.diagnostics[0].code, 'ADAPTER_RESULT_SNAPSHOT');

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
        source: 'select a;\n',
        documentVersion: 10,
        targets: [changingTarget]
    }, changingTargetExecutor);
    assert.strictEqual(changingTargetResult.status, 'rejected',
        'target accessors must fail closed at the transaction boundary');
    assert.strictEqual(changingTargetExecutor.calls.length, 0,
        'rejected target accessors must not reach the executor');

    var unsafeFragmentExecutor = createExecutor(function() {
        throw new Error('unsafe fragment must not execute');
    });
    var unsafeFragment = await transaction.prepareFormatTransaction({
        source: 'select a from t\n',
        documentVersion: 11,
        targets: [{ id: 'partial', start: 1, end: 15, mode: 'fragment' }]
    }, unsafeFragmentExecutor);
    assert.strictEqual(unsafeFragment.status, 'rejected',
        'fragment range validation must be mandatory for direct transaction callers');
    assert.strictEqual(unsafeFragment.diagnostics[0].code, 'ADAPTER_RANGE_LINE');
    assert.strictEqual(unsafeFragmentExecutor.calls.length, 0);

    var failedFragmentSource = 'select a;\nselect b;\n';
    var failedFragment = await transaction.prepareFormatTransaction({
        source: failedFragmentSource,
        documentVersion: 12,
        targets: [
            { id: 'first-ok', start: 0, end: 10, mode: 'fragment' },
            { id: 'second-fails', start: 10, end: 20, mode: 'fragment' }
        ]
    }, createExecutor(function(request) {
        if (request.targetId == 'second-fails') {
            throw new Error('private executor details');
        }
        return {
            status: 'unchanged', text: request.source, diagnostics: [],
            sourceMap: sourceMap(request.source.length, request.source.length)
        };
    }));
    assert.strictEqual(failedFragment.diagnostics[0].code, 'ADAPTER_EXECUTOR_FAILED');
    assert.deepStrictEqual(failedFragment.diagnostics[0].span, { start: 10, end: 20 },
        'target-level internal failures must use absolute document spans');

    var sortedDiagnosticResult = await transaction.prepareFormatTransaction({
        source: multiSource,
        documentVersion: 13,
        targets: [
            { id: 'z-target', start: 0, end: 10, mode: 'fragment' },
            { id: 'a-target', start: 10, end: 20, mode: 'fragment' }
        ]
    }, createExecutor(function(request) {
        return {
            status: 'formatted', text: request.source.toUpperCase(),
            diagnostics: [{
                code: request.targetId == 'z-target' ? 'FMT_Z' : 'FMT_A',
                severity: 'error', message: 'fatal', capabilityId: null,
                span: { start: 0, end: request.source.length },
                recovery: 'preserve-target'
            }],
            sourceMap: sourceMap(request.source.length, request.source.length)
        };
    }));
    assert.strictEqual(sortedDiagnosticResult.status, 'rejected');
    assert.deepStrictEqual(
        sortedDiagnosticResult.diagnostics.map(function(item) { return item.targetId; }),
        ['a-target', 'z-target'],
        'early rejected diagnostics must use the same stable order as ready results'
    );

    var largeDocument = 'select a;\n' + new Array(30001).join('-- padding\n');
    var resolveBatch;
    var batchCalls = 0;
    var firstYieldExecutor = {
        format: async function() {
            throw new Error('production fragment path must use one batch request');
        },
        validateAndFormat: function(request) {
            batchCalls += 1;
            return new Promise(function(resolve) { resolveBatch = resolve; });
        },
        dispose: async function() {}
    };
    var firstYieldStarted = performance.now();
    var firstYieldPromise = transaction.prepareFormatTransaction({
        source: largeDocument,
        documentVersion: 14,
        targets: [{ id: 'small-fragment', start: 0, end: 9, mode: 'fragment' }]
    }, firstYieldExecutor);
    var firstYieldSyncMs = performance.now() - firstYieldStarted;
    assert.ok(firstYieldSyncMs < 50,
        'a 300+ KB document with a small fragment must reach the batch promise before synchronous analysis');
    assert.strictEqual(batchCalls, 1);
    resolveBatch({
        status: 'completed',
        results: [{
            targetId: 'small-fragment',
            result: {
                status: 'unchanged', text: 'select a;', diagnostics: [],
                sourceMap: sourceMap(9, 9)
            }
        }]
    });
    assert.strictEqual((await firstYieldPromise).status, 'unchanged');

    var exactLimitSource = new Array(524289).join(' ');
    var limitCalls = 0;
    var limitExecutor = createExecutor(function(request) {
        limitCalls += 1;
        return {
            status: 'unchanged', text: request.source, diagnostics: [],
            sourceMap: sourceMap(request.source.length, request.source.length)
        };
    });
    var exactLimit = await transaction.prepareFormatTransaction({
        source: exactLimitSource,
        documentVersion: 15,
        targets: [{
            id: 'document', start: 0, end: exactLimitSource.length, mode: 'document'
        }]
    }, limitExecutor);
    assert.strictEqual(exactLimit.status, 'unchanged',
        '524288 UTF-16 code units must remain accepted');
    var overLimitSource = exactLimitSource + 'x';
    var overLimit = await transaction.prepareFormatTransaction({
        source: overLimitSource,
        documentVersion: 16,
        targets: [{
            id: 'document', start: 0, end: overLimitSource.length, mode: 'document'
        }]
    }, limitExecutor);
    assert.strictEqual(overLimit.status, 'rejected');
    assert.strictEqual(overLimit.diagnostics[0].code, 'ADAPTER_INPUT_LIMIT');
    assert.strictEqual(limitCalls, 1,
        '524289 UTF-16 code units must be rejected before executor dispatch');

    var rawSnapshotInput = {
        status: 'unchanged', text: 'select 1', diagnostics: [],
        sourceMap: sourceMap(8, 8)
    };
    var firstSnapshot = resultBoundary.snapshotFormatResult(rawSnapshotInput);
    var secondSnapshot = resultBoundary.snapshotFormatResult(firstSnapshot);
    assert.notStrictEqual(firstSnapshot, rawSnapshotInput,
        'the first boundary crossing must deep-snapshot an untrusted result');
    assert.strictEqual(secondSnapshot, firstSnapshot,
        'a module-branded snapshot must retain identity at the second boundary');
    var forgedFrozen = Object.freeze({
        status: 'unchanged', text: 'select 1', diagnostics: Object.freeze([]),
        sourceMap: Object.freeze({ entries: Object.freeze([]) })
    });
    assert.notStrictEqual(resultBoundary.snapshotFormatResult(forgedFrozen), forgedFrozen,
        'freezing an external object must not forge the private snapshot brand');
    var clonedSnapshot = structuredClone(firstSnapshot);
    assert.notStrictEqual(resultBoundary.snapshotFormatResult(clonedSnapshot), clonedSnapshot,
        'structured clone must not carry the private snapshot brand');
    assert.strictEqual(
        resultBoundary.isFormatResultSafeForSource(firstSnapshot, 'different'),
        false,
        'snapshot provenance must not bypass current-source validation'
    );
    var brandedFailure = resultBoundary.failedFormatResult(
        'select 1', 'ADAPTER_TEST', 'test failure'
    );
    assert.strictEqual(resultBoundary.snapshotFormatResult(brandedFailure), brandedFailure,
        'adapter-generated failures may use the same private brand fast path');

    var debugSecret = 'select hidden_value from secret_table /private/debug.sql';
    var debugExecutor = new (require(
        '../../.tmp/v2-core/adapters/executor/direct'
    ).DirectFormatterExecutor)(function() {
        throw new Error(debugSecret);
    });
    var debugTransaction = await transaction.prepareFormatTransaction({
        source: 'select 1',
        documentVersion: 17,
        targets: [{ id: 'document', start: 0, end: 8, mode: 'document' }],
        debugEnabled: true
    }, debugExecutor);
    assert.strictEqual(debugTransaction.status, 'rejected');
    assert.strictEqual(debugTransaction.debugEvents.length, 1,
        'transaction results must carry validated opt-in execution events');
    assert.ok(debugTransaction.debugEvents[0].message.indexOf('hidden_value') >= 0);
    var report = safeReport.renderSafeDiagnosticReport({
        extensionVersion: '2.1.0', dialect: 'hive', sourceCodeUnits: 8,
        resultStatus: debugTransaction.status,
        diagnostics: debugTransaction.diagnostics,
        debugEvents: debugTransaction.debugEvents
    });
    assert.ok(report.indexOf('hidden_value') < 0 && report.indexOf('/private/debug.sql') < 0,
        'safe clipboard reports must ignore the opt-in internal debug channel');
    await debugExecutor.dispose();

    console.log('v2 Wave 4A transaction tests passed');
}

run().catch(function(error) {
    console.error(error);
    process.exitCode = 1;
});
