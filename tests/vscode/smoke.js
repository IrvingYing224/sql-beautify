'use strict';

var assert = require('assert');
var path = require('path');
var vscode = require('vscode');
// formatSql and the executor, bundled from src by scripts/run-vscode-smoke.js.
var helpers = require(process.env.SQL_BEAUTIFY_SMOKE_HELPERS);
var formatSql = helpers.format.formatSql;

async function eventually(predicate, message) {
    var deadline = Date.now() + 10000;
    while (!predicate()) {
        assert.ok(Date.now() < deadline, message);
        await new Promise(function(resolve) { setTimeout(resolve, 25); });
    }
}

async function open(name, source) {
    var uri = vscode.Uri.file(path.join(process.env.SQL_BEAUTIFY_SMOKE_WORKSPACE, name));
    await vscode.workspace.fs.writeFile(uri, Buffer.from(source));
    var document = await vscode.workspace.openTextDocument(uri);
    await vscode.languages.setTextDocumentLanguage(document, 'sql');
    var editor = await vscode.window.showTextDocument(document);
    editor.selection = new vscode.Selection(0, 0, 0, 0);
    return editor;
}

function warnings(document) {
    return vscode.languages.getDiagnostics(document.uri).filter(function(item) {
        return item.source === 'SQL Beautify';
    });
}

async function runSmoke() {
    var extension = vscode.extensions.getExtension('clarkyu.vscode-sql-beautify');
    assert.ok(extension, 'the development extension must be loaded');
    await extension.activate();

    var source = 'select a,b from t;';
    var editor = await open('document.sql', source);
    await vscode.commands.executeCommand('editor.action.formatDocument');
    var output = editor.document.getText();
    assert.strictEqual(output, formatSql(source, { keywordCase: 'lower' }).text,
        'language-level settings must override workspace settings');
    assert.ok(output.includes('\n      a'), 'SQL indentStyle must override insertSpaces');
    var version = editor.document.version;
    await vscode.commands.executeCommand('editor.action.formatDocument');
    assert.strictEqual(editor.document.version, version, 'reformatting must not add edits');
    await vscode.commands.executeCommand('undo');
    assert.strictEqual(editor.document.getText(), source, 'one undo must restore the whole format');

    var multiSource = source + '\n\nselect c,d from u;';
    editor = await open('multiple.sql', multiSource);
    editor.selections = [new vscode.Selection(0, 0, 0, 18), new vscode.Selection(2, 0, 2, 18)];
    await vscode.commands.executeCommand('editor.action.formatSelection');
    assert.strictEqual((editor.document.getText().match(/select\n/g) || []).length, 2);
    await vscode.commands.executeCommand('undo');
    assert.strictEqual(editor.document.getText(), multiSource, 'multi-range edits share one undo');
    editor.selections = [new vscode.Selection(0, 0, 0, 18), new vscode.Selection(2, 0, 2, 8)];
    version = editor.document.version;
    await vscode.commands.executeCommand('editor.action.formatSelection');
    assert.strictEqual(editor.document.version, version, 'one invalid range must reject every edit');
    assert.strictEqual(editor.document.getText(), multiSource);

    editor = await open('diagnostics.sql', source + '\n\nCREATE TABLE t (x INT);');
    await vscode.commands.executeCommand('editor.action.formatDocument');
    await eventually(function() { return warnings(editor.document).length > 0; }, 'output diagnostics missing');
    var diagnostic = warnings(editor.document)[0];
    assert.strictEqual(diagnostic.code, 'SYN_UNSUPPORTED_STATEMENT');
    assert.strictEqual(editor.document.getText(diagnostic.range).trim(), 'CREATE TABLE t (x INT);');
    await editor.document.save();
    assert.strictEqual(warnings(editor.document).length, 1, 'saving must retain output diagnostics');
    await editor.edit(function(builder) { builder.insert(new vscode.Position(0, 0), '-- edit\n'); });
    await eventually(function() { return warnings(editor.document).length === 0; }, 'stale diagnostics remain');

    editor = await open('crlf.sql', 'select a,\r\nb from t;\r\n');
    assert.strictEqual(editor.document.eol, vscode.EndOfLine.CRLF);
    await vscode.commands.executeCommand('editor.action.formatDocument');
    assert.ok(!/(^|[^\r])\n/.test(editor.document.getText()), 'formatting must preserve CRLF');

    // Large enough to run in the worker.
    var large = Array.from({ length: 1000 }, function(_, index) {
        return 'select col_' + index + ',other from table_' + index + ';';
    }).join('\n');
    assert.ok(large.length >= helpers.executor.WORKER_MIN_CODE_UNITS);
    editor = await open('worker.sql', large);
    await vscode.commands.executeCommand('editor.action.formatDocument');
    assert.strictEqual(editor.document.getText(), formatSql(large, { keywordCase: 'lower' }).text);

    editor = await open('command.sql', source);
    editor.selection = new vscode.Selection(0, 8, 0, 8);
    var result = await vscode.commands.executeCommand('sqlBeautify.formatSql');
    assert.strictEqual(result.status, 'ready');
    assert.strictEqual(editor.document.getText(), formatSql(source, { keywordCase: 'lower' }).text);
    assert.strictEqual(editor.document.offsetAt(editor.selection.active), 14, 'the cursor follows its token');

    // A DDL cursor inside the statement moves to its start (K20), so it no longer lands between CR and LF (K34).
    editor = await open('ddl.sql', 'create table t (a int)\r\n');
    editor.selection = new vscode.Selection(0, 15, 0, 15);
    result = await vscode.commands.executeCommand('sqlBeautify.formatHiveDdl');
    assert.strictEqual(result.status, 'ready');
    assert.strictEqual(editor.document.getText(), 'create table t\r\n(\r\n     a int\r\n)\r\n');
    assert.strictEqual(editor.document.offsetAt(editor.selection.active), 0);

    // A real host token against the production worker. The built-in
    // executeFormatDocumentProvider command takes no cancellation token.
    var executor = new helpers.executor.EditExecutor(
        helpers.executor.nodeWorkerFactory(path.resolve(__dirname, '../../dist/worker.cjs')));
    var cancellation = new vscode.CancellationTokenSource();
    try {
        var request = {
            op: 'format', source: large,
            targets: [{ id: 'document', start: 0, end: large.length, mode: 'document' }],
            selections: [], options: { dialect: 'hive' }, newline: '\n', tabSize: 2, debug: false
        };
        var pending = executor.run(request, cancellation.token);
        cancellation.cancel();
        var cancelled = await pending;
        assert.strictEqual(cancelled.status, 'cancelled');
        assert.deepStrictEqual(cancelled.edits, [], 'cancelled results carry no edits');
        var formatted = await executor.run(request, new vscode.CancellationTokenSource().token);
        assert.strictEqual(formatted.edits[0].text, formatSql(large).text, 'the worker restarts after a cancel');
    } finally {
        cancellation.dispose();
        executor.dispose();
    }
    console.log('VS Code ' + vscode.version + ' host smoke passed: formatting, multi-range atomicity, diagnostics, CRLF, worker, commands, worker cancellation');
}

module.exports = {
    run: async function() {
        var timeout;
        try {
            await Promise.race([runSmoke(), new Promise(function(_, reject) {
                timeout = setTimeout(function() { reject(new Error('VS Code smoke timed out')); }, 120000);
            })]);
        } finally {
            clearTimeout(timeout);
        }
    }
};
