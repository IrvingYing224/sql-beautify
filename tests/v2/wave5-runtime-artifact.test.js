var assert = require('assert');
var crypto = require('crypto');
var fs = require('fs');
var Module = require('module');
var path = require('path');

var root = path.join(__dirname, '..', '..');
var dist = path.join(root, 'dist');
var runtimePath = path.join(dist, 'runtime.cjs');
var formatterPath = path.join(dist, 'sql-formatter.cjs');
var ddlPath = path.join(dist, 'hive-ddl.cjs');
var workerPath = path.join(dist, 'formatter-worker.cjs');
var extensionPath = path.join(dist, 'extension.cjs');
var legacyBridgePath = path.join(dist, 'v2-format-bridge.cjs');
var runtimeSourcePath = path.join(root, 'src', 'runtime', 'internal.ts');

assert.ok(fs.existsSync(runtimePath), 'Wave 5 runtime artifact must be built');
assert.ok(fs.existsSync(formatterPath), 'Wave 5 public formatter facade must be built');
assert.ok(fs.existsSync(ddlPath), 'Wave 5 public DDL facade must be built');
assert.ok(fs.existsSync(workerPath), 'Wave 5 worker artifact must be built');
assert.ok(fs.existsSync(extensionPath), 'Wave 5 extension artifact must be built');
['sql-formatter.d.cts', 'hive-ddl.d.cts'].forEach(function(fileName) {
    assert.deepStrictEqual(fs.readFileSync(path.join(dist, fileName)),
        fs.readFileSync(path.join(root, 'src', 'runtime', fileName)),
        'public declaration artifact must match source: ' + fileName);
});
assert.strictEqual(fs.existsSync(legacyBridgePath), false,
    'Wave 5 build must delete the legacy format bridge artifact');

var runtime = require(runtimePath);
var formatter = require(formatterPath);
var ddl = require(ddlPath);

assert.deepStrictEqual(Object.keys(formatter).sort(), ['formatSql', 'lexSql'],
    'public formatter facade must expose only approved values');
assert.deepStrictEqual(Object.keys(ddl).sort(), ['extractDdl', 'formatHiveDdl'],
    'public DDL facade must expose only approved values');
[
    'formatSql', 'formatSqlTarget', 'executeFormatSql',
    'validateAndFormatTargets', 'lexSql', 'executeExtractDdl', 'executeFormatHiveDdl',
    'formatHiveDdl', 'extractDdl',
    'prepareFormatTransaction', 'resolveFormatOptions', 'runHostTransaction',
    'runExperimentalDdlTransaction', 'createProductionFormatterExecutor'
].forEach(function(name) {
    assert.strictEqual(typeof runtime[name], 'function',
        'internal runtime must expose host-neutral capability ' + name);
});
assert.strictEqual(formatter.formatSql, runtime.formatSql,
    'public formatter facade must delegate to shared runtime artifact');
assert.strictEqual(formatter.lexSql, runtime.lexSql,
    'public lexer facade must delegate to shared runtime artifact');
assert.strictEqual(ddl.formatHiveDdl, runtime.formatHiveDdl,
    'public DDL facade must delegate to shared runtime artifact');
assert.strictEqual(ddl.extractDdl, runtime.extractDdl,
    'public DDL facade must delegate to shared runtime artifact');
assert.ok(fs.statSync(formatterPath).size < fs.statSync(runtimePath).size / 4,
    'public formatter facade must not bundle a second formatter core');
assert.ok(fs.statSync(ddlPath).size < fs.statSync(runtimePath).size / 4,
    'public DDL facade must not bundle a second formatter core');
assert.ok(fs.statSync(extensionPath).size < fs.statSync(runtimePath).size / 4,
    'extension host wiring must not bundle a second formatter core');
assert.ok(fs.readFileSync(extensionPath, 'utf8').indexOf('runtime.cjs') >= 0,
    'extension host wiring must load the shared runtime artifact');
assert.ok(fs.readFileSync(runtimePath, 'utf8').indexOf('require("vscode")') < 0,
    'shared runtime must remain independent from the VS Code host module');
var runtimeSource = fs.readFileSync(runtimeSourcePath, 'utf8');
assert.ok(runtimeSource.indexOf('readFileSync(workerPath)') < 0,
    'worker artifact probing must not read the complete bundle into memory');
assert.ok(runtimeSource.indexOf('statSync(workerPath).isFile()') >= 0 &&
    runtimeSource.indexOf('accessSync(workerPath, constants.R_OK)') >= 0,
    'worker artifact probing must verify a readable regular file');

var directModule = require('../../.tmp/v2-core/adapters/executor/direct');
var runtimeDigest = crypto.createHash('sha256')
    .update(fs.readFileSync(runtimePath)).digest('hex');
assert.strictEqual(runtime.runtimeDigest, undefined,
    'runtime implementation must not expose mutable global digest state');
assert.strictEqual(runtimeDigest.length, 64);

function vscodeActivationStub() {
    var registrations = [];
    var disposedDiagnostics = 0;
    function registration(kind, value) {
        var disposable = {
            dispose: function() {
                disposable.disposed = true;
            },
            disposed: false,
            kind: kind,
            value: value
        };
        registrations.push(disposable);
        return disposable;
    }
    var diagnostics = {
        clear: function() {},
        delete: function() {},
        dispose: function() { disposedDiagnostics += 1; },
        set: function() {}
    };
    return {
        api: {
            commands: {
                registerCommand: function(id, handler) {
                    return registration('command', { id: id, handler: handler });
                }
            },
            languages: {
                createDiagnosticCollection: function(name) {
                    assert.strictEqual(name, 'sqlBeautify');
                    return diagnostics;
                },
                registerDocumentFormattingEditProvider: function(selector, provider) {
                    return registration('document-provider', { selector: selector, provider: provider });
                },
                registerDocumentRangeFormattingEditProvider: function(selector, provider) {
                    return registration('range-provider', { selector: selector, provider: provider });
                }
            },
            workspace: {
                getConfiguration: function() {
                    return { get: function() { return undefined; } };
                },
                onDidChangeTextDocument: function(handler) {
                    return registration('change-listener', handler);
                },
                onDidCloseTextDocument: function(handler) {
                    return registration('close-listener', handler);
                }
            },
            window: {
                activeTextEditor: null,
                showErrorMessage: async function() {},
                showInformationMessage: async function() {},
                showWarningMessage: async function() {},
                withProgress: async function(_options, operation) {
                    return await operation({}, { isCancellationRequested: false });
                }
            },
            env: {
                language: 'en',
                clipboard: { writeText: async function() {} }
            },
            DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2 },
            EndOfLine: { LF: 1, CRLF: 2 },
            ProgressLocation: { Notification: 15 },
            Position: function Position(line, character) {
                this.line = line;
                this.character = character;
            },
            Range: function Range(start, end) {
                this.start = start;
                this.end = end;
            },
            Selection: function Selection(anchor, active) {
                this.anchor = anchor;
                this.active = active;
            },
            TextEdit: {
                replace: function(range, text) { return { range: range, newText: text }; }
            },
            Diagnostic: function Diagnostic(range, message, severity) {
                this.range = range;
                this.message = message;
                this.severity = severity;
            }
        },
        registrations: registrations,
        disposedDiagnostics: function() { return disposedDiagnostics; }
    };
}

async function smokeExtensionActivation() {
    var stub = vscodeActivationStub();
    var originalLoad = Module._load;
    delete require.cache[extensionPath];
    Module._load = function(request, parent, isMain) {
        if (request === 'vscode') {
            return stub.api;
        }
        return originalLoad.call(this, request, parent, isMain);
    };
    var extension;
    try {
        extension = require(extensionPath);
    } finally {
        Module._load = originalLoad;
    }
    assert.deepStrictEqual(Object.keys(extension).sort(), ['activate', 'deactivate']);
    var context = {
        extension: { packageJSON: { version: require('../../package.json').version } },
        subscriptions: []
    };
    await extension.activate(context);
    assert.strictEqual(stub.registrations.length, 8,
        'extension activation must register two listeners, two providers, and four commands');
    assert.strictEqual(context.subscriptions.length, 9,
        'extension context must own diagnostics and every registration');
    await extension.activate(context);
    assert.strictEqual(stub.registrations.length, 8,
        'repeated activation must remain idempotent');
    await extension.deactivate();
    assert.strictEqual(stub.disposedDiagnostics(), 1,
        'deactivation must dispose the diagnostic collection');
    context.subscriptions.forEach(function(disposable) {
        if (disposable !== undefined && typeof disposable.dispose === 'function') {
            disposable.dispose();
        }
    });
}

async function main() {
    await smokeExtensionActivation();
    var calls = 0;
    var injected = new directModule.DirectFormatterExecutor(function(source) {
        calls += 1;
        return {
            status: 'unchanged', text: source, diagnostics: [],
            sourceMap: { entries: [] }
        };
    });
    var injectedResult = await injected.format({
        source: '', options: { dialect: 'hive' }, mode: 'document',
        documentVersion: 1, targetId: 'test'
    });
    assert.strictEqual(calls, 1, 'direct executor must call the injected target');
    assert.strictEqual(injectedResult.status, 'unchanged');

    var direct = runtime.createProductionFormatterExecutor({
        runtimePath: runtimePath,
        workerPath: workerPath,
        thresholds: { sourceCodeUnits: 1000000, leafCount: 1000000 }
    });
    var worker = runtime.createProductionFormatterExecutor({
        runtimePath: runtimePath,
        workerPath: workerPath,
        thresholds: { sourceCodeUnits: 1, leafCount: 1 }
    });
    assert.strictEqual(direct.runtimeDigest, runtimeDigest);
    assert.strictEqual(worker.runtimeDigest, runtimeDigest);
    var request = {
        source: 'select a from t', options: { dialect: 'hive' }, mode: 'document',
        documentVersion: 2, targetId: 'parity'
    };
    var directResult = await direct.format(request);
    var workerResult = await worker.format(request);
    assert.strictEqual(direct.lastRoute(), 'direct');
    assert.strictEqual(worker.lastRoute(), 'worker');
    assert.deepStrictEqual(workerResult, directResult,
        'direct and worker must execute the same runtime artifact bytes');
    assert.throws(function() {
        runtime.createProductionFormatterExecutor({
            runtimePath: formatterPath,
            workerPath: workerPath
        });
    }, /runtime/i, 'production executor factory must reject a different runtime artifact');

    await Promise.all([injected.dispose(), direct.dispose(), worker.dispose()]);
    console.log('v2 Wave 5 runtime artifact tests passed');
}

main().catch(function(error) {
    console.error(error);
    process.exitCode = 1;
});
