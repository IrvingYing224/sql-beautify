'use strict';

var assert = require('assert');
var adapter = require('../../.tmp/v2-core/adapters/vscode/extension');
var cancellation = require('../../.tmp/v2-core/adapters/vscode/cancellation');
var report = require('../../.tmp/v2-core/adapters/vscode/safe-report');

function Position(line, character) {
    this.line = line;
    this.character = character;
}

function Range(start, end) {
    this.start = start;
    this.end = end;
}

function Selection(anchor, active) {
    Range.call(this,
        anchor.character <= active.character ? anchor : active,
        anchor.character <= active.character ? active : anchor);
    this.anchor = anchor;
    this.active = active;
    this.isEmpty = anchor.line === active.line && anchor.character === active.character;
}

function TextEdit(range, text) {
    this.range = range;
    this.newText = text;
}

function Diagnostic(range, message, severity) {
    this.range = range;
    this.message = message;
    this.severity = severity;
}

function Document(text, eol) {
    this.text = text;
    this.version = 1;
    this.languageId = 'hive-sql';
    this.eol = eol === undefined ? 1 : eol;
    this.uri = { toString: function() { return 'untitled:wave5.sql'; } };
}

Document.prototype.getText = function(range) {
    if (!range) {
        return this.text;
    }
    return this.text.slice(this.offsetAt(range.start), this.offsetAt(range.end));
};

Document.prototype.positionAt = function(offset) {
    var value = Math.max(0, Math.min(offset, this.text.length));
    var line = 0;
    var lineStart = 0;
    for (var index = 0; index < value; index++) {
        if (this.text[index] === '\n') {
            line += 1;
            lineStart = index + 1;
        }
    }
    return new Position(line, value - lineStart);
};

Document.prototype.offsetAt = function(position) {
    var line = 0;
    var offset = 0;
    while (line < position.line && offset < this.text.length) {
        if (this.text[offset] === '\n') {
            line += 1;
        }
        offset += 1;
    }
    return Math.max(0, Math.min(offset + position.character, this.text.length));
};

function Editor(document, selections) {
    this.document = document;
    this.selections = selections;
    this.editCalls = 0;
    this.onChange = null;
}

Editor.prototype.edit = function(callback) {
    var document = this.document;
    var replacements = [];
    callback({
        replace: function(range, text) {
            replacements.push({
                start: document.offsetAt(range.start),
                end: document.offsetAt(range.end),
                text: text
            });
        }
    });
    this.editCalls += 1;
    replacements.sort(function(left, right) { return right.start - left.start; });
    replacements.forEach(function(replacement) {
        document.text = document.text.slice(0, replacement.start) + replacement.text +
            document.text.slice(replacement.end);
    });
    document.version += 1;
    if (this.onChange !== null) {
        this.onChange(document);
    }
    return Promise.resolve(true);
};

function createVscode(document, editor) {
    var commandHandlers = Object.create(null);
    var providers = [];
    var diagnosticValues = [];
    var documentChangeListeners = [];
    var disposedRegistrations = 0;
    var configurationValues = {
        dialect: 'hive',
        keywordCase: 'upper',
        commaStyle: 'leading',
        indentStyle: 'space',
        maxAlignWidth: 150,
        caseWhenThenWrapLength: 50,
        caseLayout: 'expanded',
        unsupportedSyntaxPolicy: 'warn',
        debugDiagnostics: false
    };
    var configuration = {
        get: function(key) {
            return configurationValues[key];
        }
    };
    var vscode = {
        Position: Position,
        Range: Range,
        Selection: Selection,
        TextEdit: {
            replace: function(range, text) { return new TextEdit(range, text); }
        },
        Diagnostic: Diagnostic,
        DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2 },
        EndOfLine: { LF: 1, CRLF: 2 },
        workspace: {
            getConfiguration: function() { return configuration; },
            onDidChangeTextDocument: function(listener) {
                documentChangeListeners.push(listener);
                return { dispose: function() {
                    var index = documentChangeListeners.indexOf(listener);
                    if (index >= 0) {
                        documentChangeListeners.splice(index, 1);
                    }
                    disposedRegistrations += 1;
                } };
            }
        },
        window: {
            activeTextEditor: editor,
            warnings: [],
            errors: [],
            infos: [],
            showWarningMessage: function(value) { this.warnings.push(value); return Promise.resolve(value); },
            showErrorMessage: function(value) { this.errors.push(value); return Promise.resolve(value); },
            showInformationMessage: function(value) { this.infos.push(value); return Promise.resolve(value); }
        },
        languages: {
            createDiagnosticCollection: function() {
                return {
                    set: function(uri, values) { diagnosticValues.push({ uri: uri, values: values }); },
                    delete: function(uri) { diagnosticValues.push({ uri: uri, values: [] }); },
                    dispose: function() {}
                };
            },
            registerDocumentFormattingEditProvider: function(selector, provider) {
                providers.push({ kind: 'document', selector: selector, provider: provider });
                return { dispose: function() { disposedRegistrations += 1; } };
            },
            registerDocumentRangeFormattingEditProvider: function(selector, provider) {
                providers.push({ kind: 'range', selector: selector, provider: provider });
                return { dispose: function() { disposedRegistrations += 1; } };
            }
        },
        commands: {
            registerCommand: function(id, handler) {
                if (this.throwOn === id) {
                    throw new Error('registration failed');
                }
                commandHandlers[id] = handler;
                return { dispose: function() {
                    delete commandHandlers[id];
                    disposedRegistrations += 1;
                } };
            }
        },
        env: {
            clipboard: {
                value: '',
                writeText: function(value) { this.value = value; return Promise.resolve(); }
            }
        },
        ProgressLocation: { Notification: 15 }
    };
    vscode.window.withProgress = function(_options, task) {
        return task({}, {
            isCancellationRequested: false,
            onCancellationRequested: function() { return { dispose: function() {} }; }
        });
    };
    editor.onChange = function(changedDocument) {
        documentChangeListeners.forEach(function(listener) {
            listener({ document: changedDocument });
        });
    };
    return { vscode: vscode, commands: commandHandlers, providers: providers,
        diagnosticValues: diagnosticValues,
        setConfiguration: function(key, value) { configurationValues[key] = value; },
        disposedRegistrations: function() { return disposedRegistrations; } };
}

async function main() {
    var cancellationDisposals = 0;
    var source = { isCancellationRequested: false };
    source.onCancellationRequested = function() {
        return { dispose: function() { cancellationDisposals += 1; } };
    };
    var wrapped = cancellation.wrapVscodeCancellationToken(source);
    var unsubscribe = wrapped.onCancellationRequested(function() {});
    unsubscribe();
    unsubscribe();
    assert.strictEqual(cancellationDisposals, 1,
        'VS Code cancellation Disposable must become an idempotent unsubscribe function');

    var document = new Document('select a;\nselect b;');
    var editor = new Editor(document, [
        new Selection(document.positionAt(18), document.positionAt(10))
    ]);
    var host = createVscode(document, editor);
    var calls = { prepare: 0, host: 0, ddl: 0, prepareNewlines: [], hostNewlines: [] };
    var runtime = {
        resolveFormatOptions: function(input) { return { ok: true, options: input }; },
        prepareFormatTransaction: async function(request) {
            calls.prepare += 1;
            calls.prepareNewlines.push(request.newline);
            return {
                status: 'ready', documentVersion: request.documentVersion,
                edits: [{ targetId: request.targets[0].id, start: request.targets[0].start,
                    end: request.targets[0].end, text: request.source.toUpperCase(),
                    sourceMap: { entries: [{ source: { start: 0, end: request.source.length },
                        output: { start: 0, end: request.source.length } }] } }],
                selections: [],
                diagnostics: []
            };
        },
        runHostTransaction: async function(request, executor, commit) {
            calls.host += 1;
            calls.hostNewlines.push(request.newline);
            assert.strictEqual(request.options.keywordCase, 'lower',
                'explicit command options must override scoped settings');
            assert.ok(request.cancellation,
                'command progress cancellation must reach host transaction');
            var target = request.targets[0];
            var result = {
                status: 'ready', documentVersion: request.document.version,
                edits: [{ targetId: target.id, start: target.start, end: target.end,
                    text: request.document.source.slice(target.start, target.end).toUpperCase(),
                    sourceMap: { entries: [] } }],
                selections: request.selections.map(function(selection) {
                    return { selectionId: selection.id,
                        selectionAnchor: selection.anchor,
                        selectionActive: selection.active };
                }),
                diagnostics: []
            };
            assert.strictEqual(await commit.apply(result, request.document), true,
                'host command must commit through the captured editor once');
            return result;
        },
        runExperimentalDdlTransaction: async function(request, operation, commit) {
            calls.ddl += 1;
            assert.strictEqual(request.targets.length, 1);
            assert.ok(request.cancellation,
                'DDL progress cancellation must reach DDL transaction');
            return {
                status: 'unchanged', documentVersion: request.document.version,
                edits: [], diagnostics: []
            };
        },
        formatHiveDdl: function(value) { return { status: 'unchanged', source: value, text: value, diagnostics: [] }; },
        extractDdl: function(value) { return { status: 'empty', source: value, text: value, diagnostics: [{
            code: 'DDL_EMPTY', severity: 'warning', message: 'hidden', capabilityId: null,
            span: { start: 0, end: value.length }, recovery: 'preserve-target'
        }] }; }
    };
    var stablePrepare = runtime.prepareFormatTransaction;
    var executor = { format: async function() { throw new Error('mock runtime owns formatting'); }, dispose: async function() {} };
    var session = adapter.createVscodeExtension(host.vscode, runtime, executor,
        { extensionVersion: '2.0.0' });
    var context = { subscriptions: [], extension: { packageJSON: { version: '2.0.0' } } };
    session.activate(context);
    assert.deepStrictEqual(Object.keys(host.commands).sort(), [
        'sqlBeautify.copySafeDiagnosticReport',
        'sqlBeautify.extractHiveDdl',
        'sqlBeautify.formatHiveDdl',
        'sqlBeautify.formatSql'
    ], 'adapter must register only canonical command ids');
    assert.deepStrictEqual(host.providers.map(function(value) { return value.selector; }), [
        ['sql', 'hive-sql'], ['sql', 'hive-sql']
    ]);

    var providerEdits = await host.providers[0].provider.provideDocumentFormattingEdits(
        document, {}, { isCancellationRequested: false, onCancellationRequested: function() {
            return { dispose: function() {} };
        } }
    );
    assert.strictEqual(calls.prepare, 1, 'provider must call prepare transaction');
    assert.strictEqual(calls.host, 0, 'provider must never call host commit transaction');
    assert.strictEqual(providerEdits.length, 1);
    assert.strictEqual(calls.prepareNewlines[0], '\n',
        'physical LF must determine the provider render environment');

    var crlfFallbackDocument = new Document('select a,b from t', 2);
    var crlfFallbackEdits = await host.providers[0].provider.provideDocumentFormattingEdits(
        crlfFallbackDocument, {}, {
            isCancellationRequested: false,
            onCancellationRequested: function() { return { dispose: function() {} }; }
        }
    );
    assert.strictEqual(crlfFallbackEdits.length, 1);
    assert.strictEqual(calls.prepareNewlines[calls.prepareNewlines.length - 1], '\r\n',
        'VS Code document.eol must supply CRLF when source has no physical newline');

    function policyDiagnosticResult(request) {
        return { status: 'rejected', documentVersion: request.documentVersion,
            diagnostics: [
                { code: 'CAPABILITY_WARNING', severity: 'warning', message: 'safe',
                    capabilityId: 'qualify', span: { start: 0, end: 0 },
                    recovery: 'verbatim-node', targetId: null },
                { code: 'STRUCTURAL_WARNING', severity: 'warning', message: 'safe',
                    capabilityId: null, span: { start: 0, end: 0 },
                    recovery: 'preserve-target', targetId: null }
            ] };
    }
    var lastPolicyNewline = null;
    runtime.prepareFormatTransaction = async function(request) {
        lastPolicyNewline = request.newline;
        return policyDiagnosticResult(request);
    };
    await host.providers[0].provider.provideDocumentFormattingEdits(
        document, {}, { isCancellationRequested: false, onCancellationRequested: function() {
            return { dispose: function() {} };
        } }
    );
    assert.deepStrictEqual(
        host.diagnosticValues[host.diagnosticValues.length - 1].values.map(function(value) {
            return value.code;
        }),
        ['CAPABILITY_WARNING', 'STRUCTURAL_WARNING'],
        'warn policy must publish capability and non-capability warnings'
    );
    host.setConfiguration('unsupportedSyntaxPolicy', 'preserve');
    await host.providers[0].provider.provideDocumentFormattingEdits(
        document, {}, { isCancellationRequested: false, onCancellationRequested: function() {
            return { dispose: function() {} };
        } }
    );
    assert.deepStrictEqual(
        host.diagnosticValues[host.diagnosticValues.length - 1].values.map(function(value) {
            return value.code;
        }),
        ['STRUCTURAL_WARNING'],
        'preserve policy must suppress only editor capability warnings'
    );
    await host.commands['sqlBeautify.copySafeDiagnosticReport']();
    assert.strictEqual(lastPolicyNewline, '\n',
        'safe diagnostic preparation must pass the document render environment');
    assert.ok(host.vscode.env.clipboard.value.indexOf('CAPABILITY_WARNING:1') >= 0,
        'safe reports must retain capability evidence under preserve policy');
    host.setConfiguration('unsupportedSyntaxPolicy', 'warn');
    runtime.prepareFormatTransaction = stablePrepare;

    var releaseStale;
    runtime.prepareFormatTransaction = function(request) {
        return new Promise(function(resolve) {
            releaseStale = function() { resolve(stablePrepare(request)); };
        });
    };
    var staleProvider = host.providers[0].provider.provideDocumentFormattingEdits(
        document, {}, { isCancellationRequested: false, onCancellationRequested: function() {
            return { dispose: function() {} };
        } }
    );
    document.text = 'changed while formatting';
    document.version += 1;
    editor.onChange(document);
    releaseStale();
    assert.deepStrictEqual(await staleProvider, [],
        'provider must discard an edit computed for a stale document snapshot');

    document.text = 'select a;\nselect b;';
    document.version += 1;
    editor.onChange(document);
    var releaseCancelled;
    var providerToken = {
        isCancellationRequested: false,
        onCancellationRequested: function() { return { dispose: function() {} }; }
    };
    runtime.prepareFormatTransaction = function(request) {
        return new Promise(function(resolve) {
            releaseCancelled = function() { resolve(stablePrepare(request)); };
        });
    };
    var cancelledProvider = host.providers[0].provider.provideDocumentFormattingEdits(
        document, {}, providerToken
    );
    providerToken.isCancellationRequested = true;
    releaseCancelled();
    assert.deepStrictEqual(await cancelledProvider, [],
        'provider must discard output when cancellation arrives after prepare starts');

    var deferredProviders = [];
    runtime.prepareFormatTransaction = function(request) {
        return new Promise(function(resolve) {
            deferredProviders.push({ request: request, resolve: resolve });
        });
    };
    function diagnosticResult(request, code) {
        return { status: 'rejected', documentVersion: request.documentVersion,
            diagnostics: [{ code: code, severity: 'warning', message: 'safe',
                capabilityId: null, span: { start: 0, end: 0 },
                recovery: 'preserve-target', targetId: null }] };
    }
    var olderProvider = host.providers[0].provider.provideDocumentFormattingEdits(
        document, {}, { isCancellationRequested: false, onCancellationRequested: function() {
            return { dispose: function() {} };
        } }
    );
    var newerProvider = host.providers[0].provider.provideDocumentFormattingEdits(
        document, {}, { isCancellationRequested: false, onCancellationRequested: function() {
            return { dispose: function() {} };
        } }
    );
    deferredProviders[1].resolve(diagnosticResult(deferredProviders[1].request, 'NEW_RESULT'));
    await newerProvider;
    var diagnosticWritesAfterNewer = host.diagnosticValues.length;
    deferredProviders[0].resolve(diagnosticResult(deferredProviders[0].request, 'OLD_RESULT'));
    await olderProvider;
    assert.strictEqual(host.diagnosticValues.length, diagnosticWritesAfterNewer,
        'an older provider result must not overwrite newer diagnostics');
    assert.strictEqual(
        host.diagnosticValues[host.diagnosticValues.length - 1].values[0].code,
        'NEW_RESULT'
    );
    runtime.prepareFormatTransaction = stablePrepare;

    var stableRunHost = runtime.runHostTransaction;
    runtime.runHostTransaction = async function(request) {
        return policyDiagnosticResult({ documentVersion: request.document.version });
    };
    await host.commands['sqlBeautify.formatSql']({
        keywordCase: 'lower',
        unsupportedSyntaxPolicy: 'preserve'
    });
    assert.deepStrictEqual(
        host.diagnosticValues[host.diagnosticValues.length - 1].values.map(function(value) {
            return value.code;
        }),
        ['STRUCTURAL_WARNING'],
        'explicit command preserve policy must control editor diagnostics'
    );
    runtime.runHostTransaction = stableRunHost;

    editor.selections = [
        new Selection(document.positionAt(18), document.positionAt(10)),
        new Selection(document.positionAt(3), document.positionAt(3)),
        new Selection(document.positionAt(0), document.positionAt(9))
    ];

    await host.commands['sqlBeautify.formatSql']({ keywordCase: 'lower' });
    assert.strictEqual(calls.host, 1);
    assert.strictEqual(calls.hostNewlines[0], '\n',
        'query command must pass the document render environment');
    assert.strictEqual(editor.editCalls, 1, 'command must apply all edits in one editor.edit call');
    assert.strictEqual(document.offsetAt(editor.selections[0].anchor), 18,
        'command must preserve backward selection anchor');
    assert.strictEqual(document.offsetAt(editor.selections[0].active), 10,
        'command must preserve backward selection active endpoint');
    assert.strictEqual(editor.selections.length, 3,
        'mixed empty/non-empty selections must all survive the transaction');
    assert.strictEqual(document.offsetAt(editor.selections[1].anchor), 3,
        'empty cursor order must remain stable');
    assert.strictEqual(document.offsetAt(editor.selections[2].anchor), 0,
        'secondary selection order must remain stable');

    editor.selections = [
        new Selection(document.positionAt(2), document.positionAt(2)),
        new Selection(document.positionAt(12), document.positionAt(12))
    ];
    await host.commands['sqlBeautify.formatSql']({ keywordCase: 'lower' });
    assert.strictEqual(editor.selections.length, 2,
        'all-empty multi-cursor commands must preserve every cursor');
    assert.strictEqual(document.offsetAt(editor.selections[0].anchor), 2);
    assert.strictEqual(document.offsetAt(editor.selections[1].anchor), 12);

    await host.commands['sqlBeautify.formatHiveDdl']();
    assert.strictEqual(calls.ddl, 1);

    var defaultWithProgress = host.vscode.window.withProgress;
    var reportToken = {
        isCancellationRequested: false,
        onCancellationRequested: function() { return { dispose: function() {} }; }
    };
    host.vscode.window.withProgress = function(_options, task) {
        return task({}, reportToken);
    };
    var releaseCancelledReport;
    runtime.prepareFormatTransaction = function(request) {
        return new Promise(function(resolve) {
            releaseCancelledReport = function() { resolve(stablePrepare(request)); };
        });
    };
    host.vscode.env.clipboard.value = 'clipboard-before-cancellation';
    var cancelledReport = host.commands['sqlBeautify.copySafeDiagnosticReport']();
    reportToken.isCancellationRequested = true;
    releaseCancelledReport();
    assert.strictEqual(await cancelledReport, false,
        'safe report must fail closed when cancellation arrives during prepare');
    assert.strictEqual(host.vscode.env.clipboard.value, 'clipboard-before-cancellation',
        'cancelled safe report must not overwrite clipboard contents');

    reportToken.isCancellationRequested = false;
    var releaseStaleReport;
    runtime.prepareFormatTransaction = function(request) {
        return new Promise(function(resolve) {
            releaseStaleReport = function() { resolve(stablePrepare(request)); };
        });
    };
    host.vscode.env.clipboard.value = 'clipboard-before-stale-report';
    var staleReport = host.commands['sqlBeautify.copySafeDiagnosticReport']();
    var reportSource = document.text;
    document.text += ' -- changed during report';
    document.version += 1;
    editor.onChange(document);
    releaseStaleReport();
    assert.strictEqual(await staleReport, false,
        'safe report must fail closed when its document snapshot becomes stale');
    assert.strictEqual(host.vscode.env.clipboard.value, 'clipboard-before-stale-report',
        'stale safe report must not overwrite clipboard contents');
    document.text = reportSource;
    document.version += 1;
    editor.onChange(document);

    runtime.prepareFormatTransaction = stablePrepare;
    host.vscode.window.withProgress = defaultWithProgress;
    await host.commands['sqlBeautify.copySafeDiagnosticReport']();
    assert.ok(host.vscode.env.clipboard.value.indexOf('select') < 0,
        'safe report must not include SQL source text');
    assert.ok(host.vscode.env.clipboard.value.indexOf('Source code units:') >= 0);
    assert.ok(host.diagnosticValues.length >= 2);

    var selectionFailureDocument = new Document('select c;');
    var selectionFailureEditor = new Editor(selectionFailureDocument, []);
    var storedSelections = [new Selection(
        selectionFailureDocument.positionAt(2),
        selectionFailureDocument.positionAt(2)
    )];
    Object.defineProperty(selectionFailureEditor, 'selections', {
        configurable: true,
        get: function() { return storedSelections; },
        set: function() { throw new Error('selection setter failed'); }
    });
    host.vscode.window.activeTextEditor = selectionFailureEditor;
    var committedDespiteSelectionFailure = await host.commands['sqlBeautify.formatSql']({
        keywordCase: 'lower'
    });
    assert.strictEqual(committedDespiteSelectionFailure.status, 'ready',
        'selection restoration failure must not relabel a completed edit as rejected');
    assert.strictEqual(selectionFailureDocument.text, 'SELECT C;');
    assert.ok(host.vscode.window.warnings.some(function(value) {
        return /could not restore the selection/.test(value);
    }), 'selection restoration failure must be reported separately');

    var failingDocument = new Document('select 1;');
    var failingEditor = new Editor(failingDocument, [
        new Selection(failingDocument.positionAt(0), failingDocument.positionAt(0))
    ]);
    var failingHost = createVscode(failingDocument, failingEditor);
    failingHost.vscode.commands.throwOn = 'sqlBeautify.formatHiveDdl';
    var failingExecutorDisposals = 0;
    var failingSession = adapter.createVscodeExtension(
        failingHost.vscode,
        runtime,
        { format: async function() {}, dispose: async function() {
            failingExecutorDisposals += 1;
        } },
        { extensionVersion: '2.0.0' }
    );
    assert.throws(function() {
        failingSession.activate({ subscriptions: [], extension: {
            packageJSON: { version: '2.0.0' }
        } });
    }, /registration failed/);
    assert.ok(failingHost.disposedRegistrations() >= 4,
        'activation failure must roll back every prior registration');
    assert.deepStrictEqual(Object.keys(failingHost.commands), [],
        'activation rollback must remove partially registered commands');
    await failingSession.dispose();
    assert.strictEqual(failingExecutorDisposals, 1);

    await session.dispose();
    console.log('v2 Wave 5 VS Code adapter tests passed');
}

main().catch(function(error) {
    console.error(error);
    process.exitCode = 1;
});
