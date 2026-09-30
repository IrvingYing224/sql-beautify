'use strict';

var assert = require('assert');
var path = require('path');
var runtime = require('../../../dist/runtime.cjs');

function token() {
    var listeners = new Set();
    return {
        isCancellationRequested: false,
        onCancellationRequested: function(listener) {
            listeners.add(listener);
            return { dispose: function() { listeners.delete(listener); } };
        },
        cancel: function() {
            this.isCancellationRequested = true;
            Array.from(listeners).forEach(function(listener) { listener(); });
        },
        listenerCount: function() { return listeners.size; }
    };
}

module.exports = async function(h) {
    var source = 'select a,b from t;\n\nCREATE TABLE t (x INT);';
    var formatOptions = { tabSize: 2, insertSpaces: true };
    var sessions = [];

    function setup(text, runtimeOverride) {
        var document = new h.Document(text === undefined ? source : text);
        var editor = new h.Editor(document, [new h.Selection(new h.Position(0, 0), new h.Position(0, 0))]);
        var host = h.createVscode(document, editor);
        var executor = runtime.createProductionFormatterExecutor({
            runtimePath: path.resolve(__dirname, '../../../dist/runtime.cjs'),
            workerPath: path.resolve(__dirname, '../../../dist/formatter-worker.cjs')
        });
        var session = h.adapter.createVscodeExtension(host.vscode, runtimeOverride || runtime, executor,
            { extensionVersion: '2.2.0' });
        session.activate({ subscriptions: [] });
        sessions.push(session);
        return { document: document, editor: editor, host: host, executor: executor,
            documentProvider: host.providers[0].provider,
            rangeProvider: host.providers[1].provider, session: session };
    }

    function latest(fixture) {
        var values = fixture.host.diagnosticValues;
        return values.length === 0 ? [] : values[values.length - 1].values;
    }

    function provider(fixture, cancellation) {
        return fixture.documentProvider.provideDocumentFormattingEdits(
            fixture.document, formatOptions, cancellation || token()
        );
    }

    async function apply(fixture, edits) {
        return await fixture.editor.edit(function(builder) {
            edits.forEach(function(edit) { builder.replace(edit.range, edit.newText); });
        });
    }

    function assertWarning(fixture, explanation) {
        var values = latest(fixture);
        assert.deepStrictEqual(values.map(function(item) { return item.code; }),
            ['SYN_UNSUPPORTED_STATEMENT'], explanation);
        var start = fixture.document.offsetAt(values[0].range.start);
        var end = fixture.document.offsetAt(values[0].range.end);
        // Opaque statement spans own their leading trivia. Check the covered
        // output, rather than assuming the range starts at the CREATE token.
        assert.strictEqual(fixture.document.text.slice(start, end).trim(), 'CREATE TABLE t (x INT);',
            'diagnostics must use the applied output coordinate space');
        assert.strictEqual(end, fixture.document.text.length);
    }

    function replaceDocument(fixture, text, changes) {
        var previousLength = fixture.document.text.length;
        fixture.document.text = text;
        fixture.document.version += 1;
        fixture.host.changeDocument(fixture.document, changes === undefined
            ? [{ rangeOffset: 0, rangeLength: previousLength, text: text }] : changes);
    }

    try {
        var batchCalls = 0;
        var batchRuntime = Object.assign({}, runtime, {
            prepareFormatTransaction: async function(request, executor) {
                batchCalls += 1;
                return await runtime.prepareFormatTransaction(request, executor);
            }
        });
        var ranges = setup('select a,b from t;\n\nselect c,d from u;', batchRuntime);
        var validRanges = [
            new h.Range(new h.Position(0, 0), new h.Position(0, 18)),
            new h.Range(new h.Position(2, 0), new h.Position(2, 18))
        ];
        var multiple = ranges.rangeProvider.provideDocumentRangesFormattingEdits;
        assert.strictEqual(typeof multiple, 'function', 'the stable VS Code 1.90 multi-range API must be implemented');
        var edits = await multiple(ranges.document, validRanges, formatOptions, token());
        assert.strictEqual(batchCalls, 1, 'multiple ranges must enter one transaction');
        assert.strictEqual(edits.length, 2);
        var invalidRanges = [validRanges[0], new h.Range(new h.Position(2, 0), new h.Position(2, 8))];
        var rejected = await multiple(ranges.document, invalidRanges, formatOptions, token());
        assert.deepStrictEqual(rejected, [], 'a rejected selection must prevent all provider edits');
        assert.strictEqual(ranges.editor.editCalls, 0, 'providers only return edits');
        assert.strictEqual(ranges.document.text, 'select a,b from t;\n\nselect c,d from u;');
        assert.deepStrictEqual(await multiple(ranges.document, [validRanges[0], validRanges[0]], formatOptions, token()), [],
            'overlapping ranges must fail closed');
        assert.deepStrictEqual(await multiple(ranges.document, [], formatOptions, token()), [],
            'an empty range batch must return no edit');
        edits = await multiple(ranges.document, validRanges, formatOptions, token());
        await apply(ranges, edits);
        assert.ok(ranges.document.text.includes('SELECT\n'));
        assert.strictEqual((ranges.document.text.match(/SELECT/g) || []).length, 2);

        var normal = setup();
        edits = await provider(normal);
        assert.deepStrictEqual(latest(normal), [], 'output diagnostics must not be published on the input document');
        normal.host.changeDocument(normal.document, []);
        assert.deepStrictEqual(latest(normal), [], 'a dirty-state event must not consume pending output');
        await apply(normal, edits);
        assertWarning(normal, 'the applied provider edit must retain its warning');
        var writesAfterApply = normal.host.diagnosticValues.length;
        normal.host.changeDocument(normal.document, []);
        assert.strictEqual(normal.host.diagnosticValues.length, writesAfterApply,
            'saving without text changes must not remove valid diagnostics');
        replaceDocument(normal, normal.document.text + '\n-- user edit');
        assert.deepStrictEqual(latest(normal), [], 'a later text edit must invalidate diagnostics');

        for (var order of ['cancel-before-apply', 'cancel-after-apply', 'cancel-without-apply']) {
            var cancelled = setup();
            var cancellation = token();
            edits = await provider(cancelled, cancellation);
            assert.strictEqual(cancellation.listenerCount(), 0,
                'completed provider requests must not retain cancellation subscriptions');
            if (order !== 'cancel-after-apply') {
                cancellation.cancel();
            }
            if (order !== 'cancel-without-apply') {
                await apply(cancelled, edits);
                cancellation.cancel();
                assertWarning(cancelled, 'actual matching output remains authoritative after provider handoff');
            } else {
                cancelled.host.changeDocument(cancelled.document, []);
                assert.deepStrictEqual(latest(cancelled), [], 'cancelled edits that were never applied must not publish');
                replaceDocument(cancelled, 'select unrelated;');
                assert.deepStrictEqual(latest(cancelled), []);
            }
        }

        var minimal = setup();
        edits = await provider(minimal);
        var expectedOutput = edits[0].newText;
        minimal.document.text = expectedOutput;
        minimal.document.version += 7;
        minimal.host.changeDocument(minimal.document, [
            { rangeOffset: 0, rangeLength: 6, text: 'SELECT' },
            { rangeOffset: 6, rangeLength: 12, text: expectedOutput.slice(6, expectedOutput.indexOf('CREATE')) }
        ]);
        assertWarning(minimal, 'host-minimized edit shape and non-contiguous version increments must be supported');
        replaceDocument(minimal, source);
        assert.deepStrictEqual(latest(minimal), [], 'undo must clear diagnostics for the previous output');
        replaceDocument(minimal, expectedOutput);
        assert.deepStrictEqual(latest(minimal), [], 'redo alone must not revive a consumed pending result');

        var mismatch = setup();
        edits = await provider(mismatch);
        var staleOutput = edits[0].newText;
        replaceDocument(mismatch, 'select other;');
        replaceDocument(mismatch, staleOutput);
        assert.deepStrictEqual(latest(mismatch), [], 'a mismatched first change must permanently discard pending diagnostics');

        var reopened = setup();
        edits = await provider(reopened);
        reopened.host.closeDocument(reopened.document);
        var originalDocument = reopened.document;
        reopened.document = new h.Document(source);
        reopened.editor.document = reopened.document;
        edits = await provider(reopened);
        reopened.host.closeDocument(originalDocument);
        await apply(reopened, edits);
        assertWarning(reopened, 'a late close from an old document identity must not invalidate the reopened resource');

        var replacedRequest = setup();
        var oldEdits = await provider(replacedRequest);
        replacedRequest.host.setConfiguration('unsupportedSyntaxPolicy', 'preserve');
        var newEdits = await provider(replacedRequest);
        assert.strictEqual(newEdits[0].newText, oldEdits[0].newText);
        await apply(replacedRequest, oldEdits);
        assert.deepStrictEqual(latest(replacedRequest), [], 'the newest request policy must control matching output diagnostics');

        var command = setup();
        var result = await command.host.commands['sqlBeautify.formatSql']();
        assert.strictEqual(result.status, 'ready');
        assertWarning(command, 'commands must publish once their own edit has committed');
        var warningWrites = command.host.diagnosticValues.filter(function(entry) { return entry.values.length > 0; });
        assert.strictEqual(warningWrites.length, 1, 'command change and promise completion must not publish twice');

        var delayedEvent = setup();
        var notifyChange = delayedEvent.editor.onChange;
        delayedEvent.editor.onChange = null;
        result = await delayedEvent.host.commands['sqlBeautify.formatSql']();
        assert.strictEqual(result.status, 'ready');
        assertWarning(delayedEvent, 'a resolved edit may confirm output before the host change event arrives');
        var beforeLateEvent = delayedEvent.host.diagnosticValues.length;
        notifyChange(delayedEvent.document, [{ rangeOffset: 0, rangeLength: source.length, text: delayedEvent.document.text }]);
        assert.strictEqual(delayedEvent.host.diagnosticValues.length, beforeLateEvent,
            'a late event for already-confirmed output must be idempotent');

        var failedEdit = setup();
        failedEdit.editor.edit = async function() { return false; };
        result = await failedEdit.host.commands['sqlBeautify.formatSql']();
        assert.strictEqual(result.status, 'rejected');
        assert.strictEqual(failedEdit.document.text, source);
        assert.deepStrictEqual(latest(failedEdit).map(function(item) { return item.code; }), ['ADAPTER_EDIT_REJECTED']);
        replaceDocument(failedEdit, runtime.formatSql(source).text);
        assert.deepStrictEqual(latest(failedEdit), [], 'a rejected host commit must discard its pending output');

        var deferredResolve;
        var notifyCommitted;
        var committed = new Promise(function(resolve) { notifyCommitted = resolve; });
        var deferredRuntime = Object.assign({}, runtime, {
            runHostTransaction: async function(request, executor, commit) {
                var transaction = await runtime.runHostTransaction(request, executor, commit);
                return await new Promise(function(resolve) {
                    deferredResolve = function() { resolve(transaction); };
                    notifyCommitted();
                });
            }
        });
        var concurrent = setup(undefined, deferredRuntime);
        var pendingCommand = concurrent.host.commands['sqlBeautify.formatSql']();
        await committed;
        assert.strictEqual(typeof deferredResolve, 'function', 'the command must reach its post-commit completion boundary');
        concurrent.host.setConfiguration('unsupportedSyntaxPolicy', 'preserve');
        assert.deepStrictEqual(await provider(concurrent), []);
        var newerWrites = concurrent.host.diagnosticValues.length;
        deferredResolve();
        await pendingCommand;
        assert.strictEqual(concurrent.host.diagnosticValues.length, newerWrites,
            'an older command completion must not recreate a generation or overwrite a newer provider result');
        assert.deepStrictEqual(latest(concurrent), []);

        var finishNewProvider;
        var delayedProviderRuntime = Object.assign({}, runtime, {
            prepareFormatTransaction: function(request, executor) {
                return new Promise(function(resolve) {
                    finishNewProvider = async function() {
                        resolve(await runtime.prepareFormatTransaction(request, executor));
                    };
                });
            }
        });
        var lateEvent = setup(undefined, delayedProviderRuntime);
        lateEvent.document.text = runtime.formatSql(source).text;
        lateEvent.document.version += 1;
        var newProvider = provider(lateEvent);
        lateEvent.host.changeDocument(lateEvent.document, [
            { rangeOffset: 0, rangeLength: source.length, text: lateEvent.document.text }
        ]);
        await finishNewProvider();
        await newProvider;
        assertWarning(lateEvent, 'a late event describing a newer request snapshot must not invalidate that request');

        var disposed = setup();
        edits = await provider(disposed);
        await disposed.session.dispose();
        var disposedWrites = disposed.host.diagnosticValues.length;
        await apply(disposed, edits);
        assert.strictEqual(disposed.host.diagnosticValues.length, disposedWrites,
            'disposed diagnostic ownership must never be revived by a later edit');
    } finally {
        for (var session of sessions) {
            await session.dispose();
        }
    }
};
