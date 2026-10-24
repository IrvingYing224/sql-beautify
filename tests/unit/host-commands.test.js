'use strict';

// Host commands and providers: activation, configuration, explicit options, rejection messages, the
// re-check after computing, ranges, selections and the DDL commands. Expected values are those of 2.2.1.

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var test = require('node:test');
var fake = require('./helpers/fake-vscode');

var SQL = 'select a,b from t;';
var SQL_OUT = 'SELECT\n      a\n    , b\nFROM t;';
var TAB_SOURCE = 'select `a\tb` as x,\n       `abcdef` as y\nfrom t';
var TAB_OUT = {
    4: 'SELECT\n      `a\tb` AS x\n    , `abcdef` AS y\nFROM t',
    8: 'SELECT\n      `a\tb` AS x\n    , `abcdef`     AS y\nFROM t'
};
var MESSAGES = {
    activeSqlEditor: 'SQL Beautify requires an active SQL editor.',
    optionsInvalid: 'SQL Beautify command options are invalid.',
    changed: 'SQL Beautify did not apply edits because the document changed. Run formatting again.',
    range: 'SQL Beautify did not modify the selection. Select complete SQL lines, clauses, or contiguous statements.',
    worker: 'SQL Beautify could not complete formatting in the worker. Run the command again.',
    cancelled: 'SQL Beautify formatting was cancelled.',
    ddl: 'SQL Beautify did not modify the document because the selected DDL is outside the supported experimental subset.'
};

function host(options, body) {
    return fake.withHost(body === undefined ? {} : options, body === undefined ? options : body);
}

function selections(editor) {
    return editor.selections.map(function(value) {
        return [editor.document.offsetAt(value.anchor), editor.document.offsetAt(value.active)];
    });
}

function codes(result) {
    return result.diagnostics.map(function(item) { return item.code; }).sort();
}

function published(h, document) {
    return (h.diagnostics.get(document.uri.toString()) || []).map(function(item) {
        return [item.code, item.severity, document.offsetAt(item.range.start), document.offsetAt(item.range.end), item.message];
    });
}

function large(statements) {
    return Array.from({ length: statements }, function(_, index) {
        return 'select col_' + index + ',other from table_' + index + ';';
    }).join('\n');
}

/** Changes the document text the way a user would, without a change event yet. */
function mutate(document) {
    document.text += ' ';
    document.version += 1;
}

test('H1: activation registers commands, both range APIs and the collection; the context owns them', function() {
    return host(async function(h) {
        assert.deepStrictEqual(h.selectors, [['sql', 'hive-sql'], ['sql', 'hive-sql']]);
        assert.strictEqual(typeof h.rangeProvider.provideDocumentRangeFormattingEdits, 'function');
        assert.strictEqual(typeof h.rangeProvider.provideDocumentRangesFormattingEdits, 'function');
        assert.deepStrictEqual(h.collectionNames, ['sqlBeautify']);
        var editor = h.open('select a from t;\nCREATE TABLE t (x INT);');
        await h.run('formatSql');
        assert.notDeepStrictEqual(h.diagnosticCodes(editor.document), []);
        h.subscriptions.forEach(function(value) { value.dispose(); });
        assert.deepStrictEqual(Object.keys(h.commands), []);
        assert.strictEqual(h.documentProvider, null);
        assert.strictEqual(h.rangeProvider, null);
        assert.deepStrictEqual([h.changeListeners.length, h.closeListeners.length], [0, 0]);
        assert.strictEqual(h.diagnostics.size, 0, 'the collection is disposed with the context');
    });
});

test('H1 W9: deactivate stops the worker; a pending command settles as cancelled', function() {
    return host(async function(h) {
        var source = large(1000);
        var editor = h.open(source);
        var pending = h.run('formatSql');
        await new Promise(function(resolve) { setImmediate(resolve); });
        h.extension.deactivate();
        var result = await pending;
        assert.strictEqual(result.status, 'cancelled');
        assert.strictEqual(editor.document.text, source);
    });
});

test('H2: a line break in the text decides the newline, then document.eol; provider tabSize defaults to 4', function() {
    return host(async function(h) {
        var editor = h.open('select a,\nb from t', { eol: 2 });
        assert.strictEqual((await h.formatDocument(editor.document))[0].newText, 'SELECT\n      a\n    , b\nFROM t');
        editor = h.open('select a,b from t', { eol: 2 });
        assert.strictEqual((await h.formatDocument(editor.document))[0].newText, 'SELECT\r\n      a\r\n    , b\r\nFROM t');
        editor = h.open('select a,b from t', { eol: 1 });
        assert.strictEqual((await h.formatDocument(editor.document))[0].newText, 'SELECT\n      a\n    , b\nFROM t');
        editor = h.open(TAB_SOURCE);
        assert.strictEqual((await h.formatDocument(editor.document, {}))[0].newText, TAB_OUT[4]);
        assert.strictEqual((await h.formatDocument(editor.document, { tabSize: 8 }))[0].newText, TAB_OUT[8]);
    });
});

test('H3: settings are read at the document scope; an invalid value stops the provider and every command', function() {
    return host(async function(h) {
        var editor = h.open(SQL, { languageId: 'hive-sql', uri: 'untitled:wave5.sql' });
        await h.formatDocument(editor.document);
        assert.deepStrictEqual(h.configurationScopes[0], ['sqlBeautify', 'hive-sql', 'untitled:wave5.sql']);
        for (var invalid of [['keywordCase', 'bogus'], ['maxAlignWidth', -3]]) {
            h.configuration = {};
            h.configuration['sqlBeautify.' + invalid[0]] = invalid[1];
            editor = h.open(SQL);
            assert.deepStrictEqual(await h.formatDocument(editor.document), []);
            assert.deepStrictEqual(published(h, editor.document),
                [['CFG_OPTION_VALUE', 0, 0, 0, 'Invalid formatter option value for ' + invalid[0]]]);
        }
        h.configuration = { 'sqlBeautify.keywordCase': 'bogus' };
        for (var command of ['formatSql', 'formatHiveDdl', 'extractHiveDdl']) {
            assert.strictEqual(await h.run(command), null);
            assert.deepStrictEqual(h.lastMessage(),
                { kind: 'error', text: 'SQL Beautify configuration is invalid for sqlBeautify.keywordCase.' });
        }
        assert.strictEqual(editor.document.text, SQL);
    });
});

test('H4: explicit formatSql options merge over the settings; anything but an options object is refused', function() {
    return host(async function(h) {
        var cases = [
            [{ keywordCase: 'lower', commaStyle: 'trailing' }, 'select\n    a,\n    b\nfrom t;'],
            [{}, SQL_OUT],
            [undefined, SQL_OUT]
        ];
        for (var value of cases) {
            var editor = h.open(SQL);
            await h.run('formatSql', value[0]);
            assert.strictEqual(editor.document.text, value[1]);
        }
        for (var invalid of [{ foo: 1 }, null, [], 'x']) {
            editor = h.open(SQL);
            assert.strictEqual(await h.run('formatSql', invalid), null);
            assert.deepStrictEqual(h.lastMessage(), { kind: 'error', text: MESSAGES.optionsInvalid });
            assert.strictEqual(editor.document.text, SQL);
        }
        assert.strictEqual(await h.run('formatSql', { keywordCase: 'nope' }), null);
        assert.deepStrictEqual(h.lastMessage(), { kind: 'error', text: 'SQL Beautify command option keywordCase is invalid.' });
    });
});

test('H6: a document change before the commit, a partial range and a worker crash each get their message', function() {
    var dist = path.join(__dirname, '..', '..', 'dist');
    var crashDir = path.join(__dirname, '..', '..', '.tmp', 'tests', 'crash-host');
    fs.mkdirSync(crashDir, { recursive: true });
    fs.copyFileSync(path.join(dist, 'extension.cjs'), path.join(crashDir, 'extension.cjs'));
    fs.writeFileSync(path.join(crashDir, 'worker.cjs'), 'process.exit(3);\n');
    return host(async function(h) {
        var editor = h.open(SQL);
        var pending = h.run('formatSql');
        mutate(editor.document);
        var result = await pending;
        assert.deepStrictEqual([result.status, codes(result)], ['rejected', ['ADAPTER_STALE_DOCUMENT']]);
        assert.strictEqual(editor.editCalls, 0);
        assert.deepStrictEqual(h.lastMessage(), { kind: 'info', text: MESSAGES.changed });

        // A different document in the same editor is a change too.
        editor = h.open(SQL);
        pending = h.run('formatSql');
        editor.document = h.open('select other;').document;
        assert.deepStrictEqual(codes(await pending), ['ADAPTER_STALE_DOCUMENT']);

        editor = h.open('select a;\nselect b;', {}, [[18, 10]]);
        result = await h.run('formatSql');
        assert.deepStrictEqual(codes(result), ['ADAPTER_RANGE_LINE']);
        assert.deepStrictEqual(published(h, editor.document),
            [['ADAPTER_RANGE_LINE', 2, 10, 18, 'The selected range must cover complete safe lines']]);
        assert.deepStrictEqual(h.lastMessage(), { kind: 'warning', text: MESSAGES.range });

        editor = h.open(SQL);
        editor.editResult = false;
        await h.run('formatSql');
        assert.deepStrictEqual(published(h, editor.document),
            [['ADAPTER_EDIT_REJECTED', 0, 0, 0, 'The editor rejected the formatting edits']]);
    }).then(function() {
        return host({ entry: path.join(crashDir, 'extension.cjs') }, async function(h) {
            var source = large(1000);
            var editor = h.open(source);
            var result = await h.run('formatSql');
            assert.deepStrictEqual([result.status, codes(result)], ['rejected', ['ADAPTER_WORKER_CRASH']]);
            assert.deepStrictEqual(h.lastMessage(), { kind: 'warning', text: MESSAGES.worker });
            assert.deepStrictEqual(await h.formatDocument(editor.document), []);
            assert.deepStrictEqual(published(h, editor.document),
                [['ADAPTER_WORKER_CRASH', 0, 0, source.length, 'The formatter worker stopped unexpectedly']]);
            editor = h.open(SQL);
            assert.strictEqual((await h.run('formatSql')).status, 'ready', 'small documents format on the host');
        });
    });
});

test('D5: each result is summarized at debug level and its internal errors at error level', function() {
    var dist = path.join(__dirname, '..', '..', 'dist');
    var failDir = path.join(__dirname, '..', '..', '.tmp', 'tests', 'failing-host');
    fs.mkdirSync(failDir, { recursive: true });
    fs.copyFileSync(path.join(dist, 'extension.cjs'), path.join(failDir, 'extension.cjs'));
    // A worker whose computeEdits failed internally.
    fs.writeFileSync(path.join(failDir, 'worker.cjs'), [
        "var port = require('node:worker_threads').parentPort;",
        "port.on('message', function(message) {",
        "    port.postMessage({ id: message.id, result: { status: 'rejected', edits: [], selections: [],",
        "        diagnostics: [{ code: 'ADAPTER_EXECUTOR_FAILED', severity: 'error', message: 'The formatter failed safely',",
        "            capabilityId: null, span: { start: 0, end: 0 }, recovery: 'preserve-target', targetId: null }],",
        "        debugEvents: [{ phase: 'executor', code: 'ADAPTER_EXECUTOR_FAILED', errorName: 'TypeError', message: 'boom',",
        "            frames: ['at f (<path>/compute.ts:1:2)'] }] } });",
        "});"
    ].join('\n') + '\n');
    return host(async function(h) {
        assert.deepStrictEqual(h.logName, ['SQL Beautify', { log: true }]);
        h.open(SQL);
        await h.run('formatSql');
        assert.deepStrictEqual(h.logs, [{ level: 'debug', text: 'command-format sql v1: ready' }]);
    }).then(function() {
        return host({ entry: path.join(failDir, 'extension.cjs') }, async function(h) {
            var editor = h.open(large(1000));
            await h.formatDocument(editor.document);
            assert.deepStrictEqual(h.logs, [
                { level: 'debug', text: 'document-format sql v1: rejected' },
                { level: 'error', text: 'document-format: ADAPTER_EXECUTOR_FAILED (executor) TypeError: boom\n    at f (<path>/compute.ts:1:2)' }
            ]);
        });
    });
});

test('H7: a change or cancellation during computation drops the result', function() {
    return host(async function(h) {
        var editor = h.open(SQL);
        var pending = h.formatDocument(editor.document);
        mutate(editor.document);
        assert.deepStrictEqual(await pending, []);
        assert.deepStrictEqual(h.diagnosticCodes(editor.document), []);

        editor = h.open(SQL);
        var token = fake.token();
        pending = h.formatDocument(editor.document, undefined, token);
        token.isCancellationRequested = true;
        assert.deepStrictEqual(await pending, []);

        for (var command of ['formatSql', 'formatHiveDdl']) {
            editor = h.open('create table t (a int);\n');
            token = fake.token();
            h.progressToken = token;
            pending = h.run(command);
            token.isCancellationRequested = true;
            var result = await pending;
            assert.strictEqual(result.status, 'cancelled');
            assert.strictEqual(editor.document.text, 'create table t (a int);\n');
            assert.deepStrictEqual(h.lastMessage(), { kind: 'info', text: MESSAGES.cancelled });
        }
    });
});

test('H8: the single-range API and overlapping ranges', function() {
    var source = 'select a,b from t;\n\nselect c,d from u;';
    return host(async function(h) {
        var editor = h.open(source);
        var document = editor.document;
        var edits = await h.rangeProvider.provideDocumentRangeFormattingEdits(document,
            new h.vscode.Range(document.positionAt(20), document.positionAt(38)), { tabSize: 4, insertSpaces: true }, fake.token());
        assert.deepStrictEqual(edits.map(function(edit) {
            return [document.offsetAt(edit.range.start), document.offsetAt(edit.range.end), edit.newText];
        }), [[20, 38, 'SELECT\n      c\n    , d\nFROM u;']]);
        await h.formatRanges(document, [[0, 18], [20, 28]]);
        assert.deepStrictEqual(published(h, document),
            [['ADAPTER_RANGE_LINE', 2, 20, 28, 'The selected range must cover complete safe lines']]);
        await h.formatRanges(document, [[0, 18], [0, 18]]);
        assert.deepStrictEqual(published(h, document),
            [['ADAPTER_TRANSACTION_TARGET', 0, 0, 38, 'Formatting targets overlap']]);
        assert.strictEqual(editor.editCalls, 0);
    });
});

test('H9: one edit restores every selection in order and direction', function() {
    return host(async function(h) {
        var editor = h.open('select a,b from t;\nselect c,d from u;', {}, [[37, 19], [8], [0, 18]]);
        var result = await h.run('formatSql');
        assert.strictEqual(result.status, 'ready');
        assert.strictEqual(editor.editCalls, 1);
        assert.strictEqual(editor.document.text, SQL_OUT + '\nSELECT\n      c\n    , d\nFROM u;');
        assert.deepStrictEqual(selections(editor), [[61, 31], [14, 14], [0, 30]]);

        editor = h.open('select a,b from t;\nselect c from u;', {}, [[2], [12]]);
        await h.run('formatSql');
        assert.strictEqual(editor.document.text, SQL_OUT + '\nSELECT\n      c\nFROM u;');
        assert.deepStrictEqual(selections(editor), [[2, 2], [24, 24]]);
    });
});

test('H10: DDL and Extract use the settings, the editor tabSize and the document newline', function() {
    var tabDdl = 'CREATE TABLE t (`a\tb` STRING, ascii STRING, `中` STRING)';
    var tabExtract = '  SELECT `a\tb`, ascii, `中` FROM t';
    return host(async function(h) {
        var editor = h.open('create table t(a int, bb string);', {}, [[33, 0]]);
        assert.strictEqual((await h.run('formatHiveDdl')).status, 'ready');
        assert.strictEqual(editor.document.text, 'CREATE TABLE t\n(\n     a  INT\n    ,bb STRING\n);');
        assert.deepStrictEqual(selections(editor), [[46, 0]]);

        h.configuration = { 'sqlBeautify.keywordCase': 'lower', 'sqlBeautify.commaStyle': 'trailing',
            'sqlBeautify.indentStyle': 'tab', 'sqlBeautify.maxAlignWidth': 177 };
        editor = h.open('create table t(a int, bb string);');
        await h.run('formatHiveDdl');
        assert.strictEqual(editor.document.text, 'create table t\n(\n\ta  int,\n\tbb string\n);');

        h.configuration = { 'sqlBeautify.indentStyle': 'tab' };
        var expected = {
            2: 'CREATE TABLE t\n(\n\t `a\tb` STRING\n\t,ascii STRING\n\t,`中`  STRING\n)',
            8: 'CREATE TABLE t\n(\n\t `a\tb` STRING\n\t,ascii     STRING\n\t,`中`      STRING\n)'
        };
        var extracted = {
            2: '       `a\tb` __TYPE_REQUIRED__\n      ,ascii __TYPE_REQUIRED__\n      ,`中`  __TYPE_REQUIRED__',
            8: '       `a\tb` __TYPE_REQUIRED__\n      ,ascii       __TYPE_REQUIRED__\n      ,`中`        __TYPE_REQUIRED__'
        };
        for (var tabSize of [2, 8]) {
            editor = h.open(tabDdl);
            editor.options.tabSize = tabSize;
            await h.run('formatHiveDdl');
            assert.strictEqual(editor.document.text, expected[tabSize]);
            h.configuration = {};
            editor = h.open(tabExtract, {}, [[2, tabExtract.length]]);
            editor.options.tabSize = tabSize;
            await h.run('extractHiveDdl');
            assert.strictEqual(editor.document.text, extracted[tabSize]);
            h.configuration = { 'sqlBeautify.indentStyle': 'tab' };
        }
        h.configuration = {};
        // An editor tabSize outside 1-256 means 4.
        for (var invalid of [0, 257, 'auto']) {
            editor = h.open(tabExtract, {}, [[2, tabExtract.length]]);
            editor.options.tabSize = invalid;
            await h.run('extractHiveDdl');
            assert.strictEqual(editor.document.text,
                '       `a\tb` __TYPE_REQUIRED__\n      ,ascii   __TYPE_REQUIRED__\n      ,`中`    __TYPE_REQUIRED__');
        }

        var query = 'select a, b as bb, cast(c as int) as c from t';
        editor = h.open(query, {}, [[query.length, 0]]);
        await h.run('extractHiveDdl');
        assert.strictEqual(editor.document.text, '     a  __TYPE_REQUIRED__\n    ,bb __TYPE_REQUIRED__\n    ,c  __TYPE_REQUIRED__');
        assert.deepStrictEqual(selections(editor), [[77, 0]]);

        var crlf = 'CREATE TABLE t\r\n(\r\n     a  INT\r\n    ,bb STRING\r\n);\r\n';
        editor = h.open('create table t(a int, bb string);\r\n');
        await h.run('formatHiveDdl');
        assert.strictEqual(editor.document.text, crlf);
        editor = h.open('create table t(a int, bb string);', { eol: 2 });
        await h.run('formatHiveDdl');
        assert.strictEqual(editor.document.text, crlf.slice(0, -2));
    });
});

test('H10: rejected, stale and two-target DDL commands', function() {
    return host(async function(h) {
        var rejected = [
            ['formatHiveDdl', 'select 1;', ['ADAPTER_DDL_RESULT', 'DDL_UNSUPPORTED_STATEMENT']],
            ['extractHiveDdl', 'select 1;', ['ADAPTER_DDL_RESULT', 'EXTRACT_VALUE_SHAPE']],
            ['extractHiveDdl', 'create table t (a int);', ['ADAPTER_DDL_RESULT', 'EXTRACT_UNSUPPORTED_STATEMENT']]
        ];
        for (var value of rejected) {
            var editor = h.open(value[1]);
            var result = await h.run(value[0]);
            assert.deepStrictEqual([result.status, codes(result)], ['rejected', value[2]]);
            assert.deepStrictEqual(h.lastMessage(), { kind: 'warning', text: MESSAGES.ddl });
            assert.strictEqual(editor.document.text, value[1]);
        }

        editor = h.open('create table t (a int);\n');
        var pending = h.run('formatHiveDdl');
        mutate(editor.document);
        assert.deepStrictEqual(codes(await pending), ['ADAPTER_STALE_DOCUMENT']);
        assert.deepStrictEqual(h.lastMessage(), { kind: 'info', text: MESSAGES.changed });

        var source = 'create table a (x int);\ncreate table b (y int);\nselect 1;';
        editor = h.open(source, {}, [[0, 23], [24, 47]]);
        assert.strictEqual((await h.run('formatHiveDdl')).status, 'ready');
        assert.strictEqual(editor.editCalls, 1);
        assert.strictEqual(editor.document.text,
            'CREATE TABLE a\n(\n     x INT\n);\nCREATE TABLE b\n(\n     y INT\n);\nselect 1;');
        // Each selection is its target, so it maps to the whole replacement (K21).
        assert.deepStrictEqual(selections(editor), [[0, 30], [31, 61]]);

        editor = h.open(source, {}, [[0, 23], [48, 57]]);
        assert.strictEqual((await h.run('formatHiveDdl')).status, 'rejected');
        assert.strictEqual(editor.editCalls, 0);
        assert.strictEqual(editor.document.text, source);
    });
});

test('H12: zh-cn messages for zh-cn, zh-CN and zh_cn; English otherwise', async function() {
    for (var value of [['zh-cn', true], ['zh-CN', true], ['zh_cn', true], ['zh-tw', false], ['en-US', false]]) {
        await host({ language: value[0] }, async function(h) {
            await h.run('formatSql');
            assert.strictEqual(h.lastMessage().text,
                value[1] ? 'SQL Beautify 需要一个当前已打开的 SQL 编辑器。' : MESSAGES.activeSqlEditor);
        });
    }
});

test('H13 H14: no editor, unsupported documents, empty and formatted documents change nothing', function() {
    return host(async function(h) {
        for (var command of ['formatSql', 'formatHiveDdl', 'extractHiveDdl']) {
            assert.strictEqual(await h.run(command), null);
            assert.deepStrictEqual(h.lastMessage(), { kind: 'warning', text: MESSAGES.activeSqlEditor });
        }
        var editor = h.open(SQL, { languageId: 'plaintext' });
        var writes = h.diagnosticWrites;
        assert.deepStrictEqual(await h.formatDocument(editor.document), []);
        assert.strictEqual(h.diagnosticWrites, writes);

        for (var text of ['', SQL_OUT]) {
            h.messages = [];
            editor = h.open(text);
            assert.deepStrictEqual(await h.formatDocument(editor.document), []);
            assert.strictEqual((await h.run('formatSql')).status, 'unchanged');
            assert.strictEqual(editor.editCalls, 0);
            assert.deepStrictEqual(h.messages, []);
            assert.deepStrictEqual(h.diagnosticCodes(editor.document), []);
        }
    });
});
