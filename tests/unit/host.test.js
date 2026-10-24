'use strict';

// Host behavior through the shipped bundle: dist/extension.cjs driven by an in-memory VS Code.

var assert = require('assert');
var test = require('node:test');
var fake = require('./helpers/fake-vscode');
var core = require('./helpers/src')({ format: 'core/api/format' });

var SQL = 'select a,b from t;';
var SQL_OUT = 'SELECT\n      a\n    , b\nFROM t;';
var WITH_DDL = 'select a,b from t;\n\nCREATE TABLE t (x INT);';
var EXPECTED_WARNING = 'hive hive-ddl statement is preserved verbatim';
var MESSAGES = {
    activeSqlEditor: 'SQL Beautify requires an active SQL editor.',
    cancelled: 'SQL Beautify formatting was cancelled.',
    changed: 'SQL Beautify did not apply edits because the document changed. Run formatting again.',
    range: 'SQL Beautify did not modify the selection. Select complete SQL lines, clauses, or contiguous statements.',
    inputLimit: 'SQL Beautify did not modify the document because the selected SQL exceeds the 512 Ki code-unit limit.',
    notSafe: 'SQL Beautify did not modify the document because formatting was not safe.',
    ddl: 'SQL Beautify did not modify the document because the selected DDL is outside the supported experimental subset.',
    editRejected: 'SQL Beautify did not change the document because the editor did not accept the edits. It may be read-only, closed or hidden.',
    preservedDdl: 'SQL Beautify preserved Hive DDL. Use the dedicated Format Hive DDL command for the supported experimental subset.'
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

function messages(h) {
    return h.messages.map(function(item) { return item.kind + ': ' + item.text; });
}

function large(statements) {
    return Array.from({ length: statements }, function(_, index) {
        return 'select col_' + index + ',other from table_' + index + ';';
    }).join('\n');
}

function nextTurn() {
    return new Promise(function(resolve) { setImmediate(resolve); });
}

test('document provider returns one edit and publishes its diagnostics once the edit is applied', function() {
    return host(async function(h) {
        var editor = h.open(WITH_DDL);
        var edits = await h.formatDocument(editor.document);
        assert.strictEqual(edits.length, 1);
        assert.deepStrictEqual([editor.document.offsetAt(edits[0].range.start), editor.document.offsetAt(edits[0].range.end)],
            [0, WITH_DDL.length]);
        assert.strictEqual(edits[0].newText, SQL_OUT + '\n\nCREATE TABLE t (x INT);');
        assert.deepStrictEqual(h.diagnosticCodes(editor.document), [], 'output diagnostics wait for the edit');
        h.fireChange(editor.document, []);
        assert.deepStrictEqual(h.diagnosticCodes(editor.document), [], 'a dirty-state event does not consume them');
        h.applyEdits(editor.document, edits);
        var published = h.diagnostics.get(editor.document.uri.toString());
        assert.deepStrictEqual(published.map(function(item) {
            return [item.code, item.severity, item.message, item.source,
                editor.document.offsetAt(item.range.start), editor.document.offsetAt(item.range.end)];
        }), [['SYN_UNSUPPORTED_STATEMENT', 1, EXPECTED_WARNING, 'SQL Beautify', 30, 55]]);
        assert.strictEqual(editor.document.getText(published[0].range).trim(), 'CREATE TABLE t (x INT);');
        h.fireChange(editor.document, []);
        assert.deepStrictEqual(h.diagnosticCodes(editor.document), ['SYN_UNSUPPORTED_STATEMENT'], 'saving keeps them');
        h.replace(editor.document, [{ start: 0, end: 0, text: '-- edit\n' }]);
        assert.deepStrictEqual(h.diagnosticCodes(editor.document), [], 'an unrelated edit clears them');
    });
});

test('provider diagnostics: close clears, a mismatched change discards, undo and redo do not revive', function() {
    return host(async function(h) {
        var editor = h.open(WITH_DDL);
        var edits = await h.formatDocument(editor.document);
        h.applyEdits(editor.document, edits);
        h.close(editor.document);
        assert.deepStrictEqual(h.diagnosticCodes(editor.document), []);

        editor = h.open(WITH_DDL);
        edits = await h.formatDocument(editor.document);
        h.replace(editor.document, [{ start: 0, end: 0, text: 'x' }]);
        h.replace(editor.document, [{ start: 0, end: editor.document.text.length, text: edits[0].newText }]);
        assert.deepStrictEqual(h.diagnosticCodes(editor.document), [], 'a mismatched first change discards pending output');

        editor = h.open(WITH_DDL);
        edits = await h.formatDocument(editor.document);
        h.applyEdits(editor.document, edits);
        h.replace(editor.document, [{ start: 0, end: editor.document.text.length, text: WITH_DDL }]);
        assert.deepStrictEqual(h.diagnosticCodes(editor.document), [], 'undo clears');
        h.replace(editor.document, [{ start: 0, end: editor.document.text.length, text: edits[0].newText }]);
        assert.deepStrictEqual(h.diagnosticCodes(editor.document), [], 'redo does not revive consumed output');

        editor = h.open(WITH_DDL);
        edits = await h.formatDocument(editor.document);
        var newer = await h.formatDocument(editor.document);
        assert.strictEqual(newer[0].newText, edits[0].newText);
        h.applyEdits(editor.document, edits);
        assert.deepStrictEqual(h.diagnosticCodes(editor.document), ['SYN_UNSUPPORTED_STATEMENT'],
            'a newer request for the same snapshot still publishes on the matching output');
    });
});

test('provider uses the formatting tabSize, the command uses the editor tabSize', function() {
    var source = 'select `a\tb` as x, `abcdef` as y from t;';
    var expected = {
        2: 'SELECT\n      `a\tb`   AS x\n    , `abcdef` AS y\nFROM t;',
        8: 'SELECT\n      `a\tb` AS x\n    , `abcdef`     AS y\nFROM t;'
    };
    return host(async function(h) {
        for (var tabSize of [2, 8]) {
            var editor = h.open(source);
            var edits = await h.formatDocument(editor.document, { tabSize: tabSize, insertSpaces: true });
            assert.strictEqual(edits[0].newText, expected[tabSize]);
            editor.options.tabSize = tabSize;
            await h.run('formatSql');
            assert.strictEqual(editor.document.text, expected[tabSize]);
        }
    });
});

test('output newline follows the document text, then the document eol', function() {
    return host(async function(h) {
        var editor = h.open('select a,\r\nb from t;\r\n');
        var edits = await h.formatDocument(editor.document);
        assert.strictEqual(edits[0].newText, 'SELECT\r\n      a\r\n    , b\r\nFROM t;\r\n');
        editor = h.open(SQL, { eol: 2 });
        edits = await h.formatDocument(editor.document);
        assert.strictEqual(edits[0].newText, SQL_OUT.replace(/\n/g, '\r\n'));
    });
});

test('K23: the editor shows a core message as it is, cut to 200 characters', function() {
    return host(async function(h) {
        var editor = h.open("('" + 'x'.repeat(200000) + "' foo bar);");
        assert.deepStrictEqual(await h.formatDocument(editor.document), []);
        var shown = h.diagnostics.get('untitled:test.sql');
        assert.deepStrictEqual(shown.map(function(item) { return item.code; }), ['SYN_UNEXPECTED_TOKEN']);
        assert.strictEqual(shown[0].message, "Unsupported query-leading token '" + 'x'.repeat(166) + '…');
        // The cut never splits a surrogate pair.
        editor = h.open("('" + '😀'.repeat(300) + "' foo bar);");
        await h.formatDocument(editor.document);
        assert.strictEqual(h.diagnostics.get('untitled:test.sql')[0].message,
            "Unsupported query-leading token '" + '😀'.repeat(166) + '…');
    });
});

test('range provider formats complete lines; one partial range rejects every range', function() {
    var source = 'select a,b from t;\n\nselect c,d from u;';
    return host(async function(h) {
        var editor = h.open(source);
        var edits = await h.formatRanges(editor.document, [[0, 18], [20, 38]]);
        assert.deepStrictEqual(edits.map(function(edit) {
            return [editor.document.offsetAt(edit.range.start), editor.document.offsetAt(edit.range.end), edit.newText];
        }), [[0, 18, SQL_OUT], [20, 38, 'SELECT\n      c\n    , d\nFROM u;']]);
        edits = await h.formatRanges(editor.document, [[0, 18], [20, 28]]);
        assert.deepStrictEqual(edits, []);
        assert.deepStrictEqual(h.diagnosticCodes(editor.document), ['ADAPTER_RANGE_LINE']);
        // K26: half a statement, as formatOnPaste passes it, is shown as information.
        assert.strictEqual(h.diagnostics.get('untitled:test.sql')[0].severity, h.vscode.DiagnosticSeverity.Information);
        assert.deepStrictEqual(await h.formatRanges(editor.document, [[0, 18], [0, 18]]), [], 'overlapping ranges');
        assert.deepStrictEqual(await h.formatRanges(editor.document, []), []);
        assert.strictEqual(editor.editCalls, 0, 'providers only return edits');
        assert.strictEqual(editor.document.text, source);
    });
});

test('provider returns nothing when cancelled, stale, unsupported or misconfigured', function() {
    return host(async function(h) {
        var editor = h.open(SQL);
        var cancelled = fake.token();
        cancelled.cancel();
        assert.deepStrictEqual(await h.formatDocument(editor.document, undefined, cancelled), []);

        editor = h.open(large(1200));
        var pending = h.formatDocument(editor.document);
        await nextTurn();
        h.replace(editor.document, [{ start: 0, end: 0, text: '-- user\n' }]);
        assert.deepStrictEqual(await pending, [], 'a document change during computation drops the edits');

        editor = h.open(large(1200));
        var token = fake.token();
        pending = h.formatDocument(editor.document, undefined, token);
        await nextTurn();
        token.cancel();
        assert.deepStrictEqual(await pending, [], 'cancellation during worker computation');

        editor = h.open(SQL, { languageId: 'python' });
        assert.deepStrictEqual(await h.formatDocument(editor.document), []);

        var other = h.open(WITH_DDL, { uri: 'untitled:other.sql' });
        h.applyEdits(other.document, await h.formatDocument(other.document));
        assert.deepStrictEqual(h.diagnosticCodes(other.document), ['SYN_UNSUPPORTED_STATEMENT']);
        h.configuration['sqlBeautify.commaStyle'] = 'middle';
        editor = h.open(SQL);
        assert.deepStrictEqual(await h.formatDocument(editor.document), []);
        assert.deepStrictEqual(h.diagnosticCodes(editor.document), ['CFG_OPTION_VALUE']);

        // K25: the settings error follows a settings change without waiting for an edit; other
        // diagnostics stay until the next edit or format.
        h.changeConfiguration({ 'editor.tabSize': 2 });
        assert.deepStrictEqual(h.diagnosticCodes(editor.document), ['CFG_OPTION_VALUE']);
        h.changeConfiguration({ 'sqlBeautify.commaStyle': 'trailing', 'sqlBeautify.keywordCase': 'bogus' });
        assert.deepStrictEqual(h.diagnostics.get('untitled:test.sql').map(function(item) { return item.message; }),
            ['Invalid formatter option value for keywordCase']);
        h.changeConfiguration({ 'sqlBeautify.keywordCase': 'upper' });
        assert.deepStrictEqual(h.diagnosticCodes(editor.document), []);
        assert.deepStrictEqual(h.diagnosticCodes(other.document), ['SYN_UNSUPPORTED_STATEMENT']);
    });
});

test('formatSql formats the document and maps the cursor', function() {
    return host(async function(h) {
        var editor = h.open('select a,b from t;\nselect c from u;', {}, [[8], [26]]);
        var result = await h.run('formatSql');
        assert.strictEqual(result.status, 'ready');
        assert.strictEqual(editor.document.text, SQL_OUT + '\nSELECT\n      c\nFROM u;');
        // A cursor on generated whitespace snaps to the end of the previous token.
        assert.deepStrictEqual(selections(editor), [[14, 14], [37, 37]]);
        assert.strictEqual(editor.editCalls, 1);
        assert.deepStrictEqual(messages(h), []);
    });
});

test('formatSql formats every selection in one edit and restores the selections', function() {
    return host(async function(h) {
        var editor = h.open('select a,b from t;\n\nselect c,d from u;', {}, [[0, 18], [38, 20], [5]]);
        var result = await h.run('formatSql');
        assert.strictEqual(result.status, 'ready');
        assert.strictEqual(editor.document.text, SQL_OUT + '\n\nSELECT\n      c\n    , d\nFROM u;');
        assert.deepStrictEqual(selections(editor), [[0, 30], [62, 32], [5, 5]]);
        assert.strictEqual(editor.editCalls, 1);

        editor = h.open('select a,b from t;\n\nselect c,d from u;', {}, [[0, 18], [20, 28]]);
        result = await h.run('formatSql');
        assert.strictEqual(result.status, 'rejected');
        assert.deepStrictEqual(codes(result), ['ADAPTER_RANGE_LINE']);
        assert.strictEqual(editor.document.text, 'select a,b from t;\n\nselect c,d from u;');
        assert.strictEqual(editor.editCalls, 0);
        assert.deepStrictEqual(h.diagnosticCodes(editor.document), ['ADAPTER_RANGE_LINE']);
        assert.strictEqual(h.lastMessage().text, MESSAGES.range);
    });
});

test('explicit command options override settings; invalid options or settings stop the command', function() {
    return host(async function(h) {
        var editor = h.open(SQL);
        await h.run('formatSql', { keywordCase: 'lower' });
        assert.strictEqual(editor.document.text, 'select\n      a\n    , b\nfrom t;');

        editor = h.open(SQL);
        assert.strictEqual(await h.run('formatSql', { keywordCase: 'bogus' }), null);
        assert.deepStrictEqual(h.lastMessage(), { kind: 'error', text: 'SQL Beautify command option keywordCase is invalid.' });
        assert.strictEqual(await h.run('formatSql', { nope: 1 }), null);
        assert.deepStrictEqual(h.lastMessage(), { kind: 'error', text: 'SQL Beautify command options are invalid.' });
        h.configuration['sqlBeautify.commaStyle'] = 'middle';
        assert.strictEqual(await h.run('formatSql'), null);
        assert.deepStrictEqual(h.lastMessage(),
            { kind: 'error', text: 'SQL Beautify configuration is invalid for sqlBeautify.commaStyle.' });
        assert.strictEqual(editor.document.text, SQL);
    });
});

test('formatSql reports unchanged, bail_out and lexical failures without editing', function() {
    return host(async function(h) {
        var editor = h.open('SELECT\n      a\nFROM t;', {}, [[3]]);
        var result = await h.run('formatSql');
        assert.strictEqual(result.status, 'unchanged');
        assert.strictEqual(editor.editCalls, 0);
        assert.deepStrictEqual(messages(h), []);

        h.configuration['sqlBeautify.unsupportedSyntaxPolicy'] = 'bail_out';
        editor = h.open('select a from t;\nCREATE TABLE t (x INT);');
        result = await h.run('formatSql');
        assert.strictEqual(result.status, 'rejected');
        assert.deepStrictEqual(codes(result), ['FMT_UNSUPPORTED_BAIL_OUT', 'SYN_UNSUPPORTED_STATEMENT']);
        assert.strictEqual(h.lastMessage().text, MESSAGES.notSafe);
        h.configuration['sqlBeautify.unsupportedSyntaxPolicy'] = undefined;

        editor = h.open("select 'abc from t;");
        result = await h.run('formatSql');
        assert.strictEqual(result.status, 'rejected');
        assert.deepStrictEqual(codes(result), ['LEX_UNTERMINATED_STRING', 'SYN_UNEXPECTED_TOKEN']);
        assert.deepStrictEqual(h.diagnosticCodes(editor.document).sort(), ['LEX_UNTERMINATED_STRING', 'SYN_UNEXPECTED_TOKEN']);
        assert.strictEqual(editor.document.text, "select 'abc from t;");
    });
});

test('preserve policy hides capability warnings and explains the preserved region', function() {
    return host({ configuration: { 'sqlBeautify.unsupportedSyntaxPolicy': 'preserve' } }, async function(h) {
        var editor = h.open('CREATE TABLE t (x INT);');
        var result = await h.run('formatSql');
        assert.strictEqual(result.status, 'unchanged');
        assert.deepStrictEqual(h.diagnosticCodes(editor.document), []);
        assert.deepStrictEqual(h.lastMessage(), { kind: 'info', text: MESSAGES.preservedDdl });

        editor = h.open(WITH_DDL);
        result = await h.run('formatSql');
        assert.strictEqual(result.status, 'ready');
        assert.deepStrictEqual(h.diagnosticCodes(editor.document), []);
    });
});

test('a host that refuses or throws on editor.edit leaves the document unchanged', function() {
    return host(async function(h) {
        // K24: false for a hidden editor, a throw for a closed one, true without an edit when read-only.
        var refusals = [false, function() { return Promise.reject(new Error('closed')); }, function() { return Promise.resolve(true); }];
        for (var refusal of refusals) {
            var editor = h.open(SQL);
            editor.editResult = refusal;
            var result = await h.run('formatSql');
            assert.strictEqual(result.status, 'rejected');
            assert.strictEqual(editor.document.text, SQL);
            assert.deepStrictEqual(h.diagnosticCodes(editor.document), ['ADAPTER_EDIT_REJECTED']);
            assert.deepStrictEqual(h.lastMessage(), { kind: 'warning', text: MESSAGES.editRejected });
            h.replace(editor.document, [{ start: 0, end: SQL.length, text: SQL_OUT }]);
            assert.deepStrictEqual(h.diagnosticCodes(editor.document), [], 'the rejected output is not published later');
        }
        // false because the document changed meanwhile reports the change, not a refusal.
        editor = h.open(SQL);
        editor.editResult = function() {
            h.replace(editor.document, [{ start: 0, end: 0, text: '-- x\n' }]);
            return Promise.resolve(false);
        };
        result = await h.run('formatSql');
        assert.deepStrictEqual([result.status, codes(result)], ['rejected', ['ADAPTER_STALE_DOCUMENT']]);
        assert.deepStrictEqual(h.lastMessage(), { kind: 'info', text: MESSAGES.changed });
        assert.deepStrictEqual(h.diagnosticCodes(editor.document), []);
    });
});

test('cancellation before or during computation applies nothing', function() {
    return host(async function(h) {
        var editor = h.open(SQL);
        h.progressToken = fake.token();
        h.progressToken.cancel();
        var result = await h.run('formatSql');
        assert.strictEqual(result.status, 'cancelled');
        assert.strictEqual(editor.document.text, SQL);
        assert.deepStrictEqual(h.lastMessage(), { kind: 'info', text: MESSAGES.cancelled });

        var source = large(1200);
        editor = h.open(source);
        var token = fake.token();
        h.progressToken = token;
        var pending = h.run('formatSql');
        await nextTurn();
        token.cancel();
        result = await pending;
        assert.strictEqual(result.status, 'cancelled');
        assert.strictEqual(editor.document.text, source);
        assert.strictEqual(editor.editCalls, 0);
        assert.strictEqual(token.listeners(), 0, 'no cancellation listener outlives the command');
    });
});

test('a document change during computation applies nothing', function() {
    return host(async function(h) {
        var source = large(1200);
        var editor = h.open(source);
        var pending = h.run('formatSql');
        await nextTurn();
        h.replace(editor.document, [{ start: 0, end: 0, text: '-- user\n' }]);
        var result = await pending;
        assert.strictEqual(result.status, 'rejected');
        assert.deepStrictEqual(codes(result), ['ADAPTER_STALE_DOCUMENT']);
        assert.strictEqual(editor.document.text, '-- user\n' + source);
        assert.strictEqual(editor.editCalls, 0);
        assert.deepStrictEqual(h.lastMessage(), { kind: 'info', text: MESSAGES.changed });
    });
});

test('large documents format through the worker exactly like the core', function() {
    var source = large(1200);
    var expected = core.format.executeFormatSql(source, {}, 'document', '\n', false, 4).result.text;
    return host(async function(h) {
        var editor = h.open(source);
        var edits = await h.formatDocument(editor.document);
        assert.strictEqual(edits[0].newText, expected);
        await h.run('formatSql');
        assert.strictEqual(editor.document.text, expected);
        editor = h.open(source + '\n' + source, {}, [[0, source.length]]);
        await h.run('formatSql');
        assert.strictEqual(editor.document.text, expected + '\n' + source);
    });
});

test('input over 512 Ki code units is rejected without formatting', function() {
    var source = 'select 1;\n' + '-- ' + 'x'.repeat(524288) + '\n';
    return host(async function(h) {
        var editor = h.open(source);
        var result = await h.run('formatSql');
        assert.strictEqual(result.status, 'rejected');
        assert.deepStrictEqual(codes(result), ['ADAPTER_INPUT_LIMIT']);
        assert.deepStrictEqual(h.lastMessage(), { kind: 'warning', text: MESSAGES.inputLimit });
        assert.deepStrictEqual(await h.formatDocument(editor.document), []);
        assert.deepStrictEqual(h.diagnosticCodes(editor.document), ['ADAPTER_INPUT_LIMIT']);
        assert.strictEqual(editor.document.text, source);
    });
});

test('a command publishes its output diagnostics exactly once after the commit', function() {
    return host(async function(h) {
        var editor = h.open(WITH_DDL);
        var writes = h.diagnosticWrites;
        var result = await h.run('formatSql');
        assert.strictEqual(result.status, 'ready');
        assert.deepStrictEqual(h.diagnosticCodes(editor.document), ['SYN_UNSUPPORTED_STATEMENT']);
        assert.strictEqual(h.diagnosticWrites - writes, 1);
        var published = h.diagnostics.get(editor.document.uri.toString())[0];
        assert.strictEqual(editor.document.getText(published.range).trim(), 'CREATE TABLE t (x INT);');
    });
});

test('commands need an active SQL editor; messages follow the display language', function() {
    return host(async function(h) {
        assert.strictEqual(await h.run('formatSql'), null);
        assert.deepStrictEqual(h.lastMessage(), { kind: 'warning', text: MESSAGES.activeSqlEditor });
        h.open(SQL, { languageId: 'python' });
        for (var command of ['formatSql', 'formatHiveDdl', 'extractHiveDdl']) {
            assert.strictEqual(await h.run(command), null);
            assert.deepStrictEqual(h.lastMessage(), { kind: 'warning', text: MESSAGES.activeSqlEditor });
        }
        assert.deepStrictEqual(Object.keys(h.commands).sort(), [
            'sqlBeautify.extractHiveDdl', 'sqlBeautify.formatHiveDdl', 'sqlBeautify.formatSql'
        ]);
    }).then(function() {
        return host({ language: 'zh-cn' }, async function(h) {
            await h.run('formatSql');
            assert.deepStrictEqual(h.lastMessage(), { kind: 'warning', text: 'SQL Beautify 需要一个当前已打开的 SQL 编辑器。' });
        });
    });
});

test('formatHiveDdl: an indented selection up to the document end is formatted (P4a case 1)', function() {
    return host(async function(h) {
        var editor = h.open('  create table t (a int);', {}, [[2, 25]]);
        var result = await h.run('formatHiveDdl');
        assert.strictEqual(result.status, 'ready');
        assert.deepStrictEqual(result.edits.map(function(edit) { return [edit.start, edit.end, edit.text]; }),
            [[2, 25, 'CREATE TABLE t\n  (\n       a INT\n  );']]);
        assert.strictEqual(editor.document.text, '  CREATE TABLE t\n  (\n       a INT\n  );');
        assert.deepStrictEqual(selections(editor), [[2, 38]]);
    });
});

test('formatHiveDdl: a selection ending at column 0 of the next line is formatted (P4a case 2, K18)', function() {
    return host(async function(h) {
        var editor = h.open('create table t (a int);\nselect 1;', {}, [[0, 24]]);
        var result = await h.run('formatHiveDdl');
        assert.strictEqual(result.status, 'ready');
        assert.deepStrictEqual(result.edits.map(function(edit) { return [edit.start, edit.end, edit.text]; }),
            [[0, 24, 'CREATE TABLE t\n(\n     a INT\n);\n']]);
        assert.strictEqual(editor.document.text, 'CREATE TABLE t\n(\n     a INT\n);\nselect 1;');
        assert.deepStrictEqual(selections(editor), [[0, 31]]);
        assert.deepStrictEqual(h.messages, []);
    });
});

test('formatHiveDdl commits all selections in one edit, or none of them', function() {
    var source = 'create table t (a int);\nselect 1;\ncreate table u (b int, cc string);\n';
    return host(async function(h) {
        var editor = h.open(source, {}, [[0, 23], [34, 69]]);
        var result = await h.run('formatHiveDdl');
        assert.strictEqual(result.status, 'ready');
        assert.strictEqual(editor.document.text,
            'CREATE TABLE t\n(\n     a INT\n);\nselect 1;\nCREATE TABLE u\n(\n     b  INT\n    ,cc STRING\n);\n');
        assert.strictEqual(editor.editCalls, 1);
        // Each selection is its target, so it maps to the whole replacement.
        assert.deepStrictEqual(selections(editor), [[0, 30], [41, 88]]);

        editor = h.open(source, {}, [[0, 23], [24, 33]]);
        result = await h.run('formatHiveDdl');
        assert.strictEqual(result.status, 'rejected');
        assert.deepStrictEqual(codes(result), ['ADAPTER_DDL_RESULT', 'DDL_UNSUPPORTED_STATEMENT']);
        assert.strictEqual(editor.document.text, source);
        assert.strictEqual(editor.editCalls, 0);
    });
});

test('formatHiveDdl keeps external tab indentation and CRLF, and uses the editor tabSize', function() {
    return host(async function(h) {
        var editor = h.open('\tcreate table t (a int, bb string);\r\nselect 1;\r\n', {}, [[1, 35]]);
        editor.options.tabSize = 8;
        var result = await h.run('formatHiveDdl');
        assert.strictEqual(result.status, 'ready');
        assert.strictEqual(editor.document.text,
            '\tCREATE TABLE t\r\n\t(\r\n\t     a  INT\r\n\t    ,bb STRING\r\n\t);\r\nselect 1;\r\n');
        assert.deepStrictEqual(selections(editor), [[1, 55]]);
    });
});

test('formatHiveDdl: whole document, already formatted text, and unsupported DDL', function() {
    return host(async function(h) {
        // K20: a cursor inside the statement moves to its start; one at the end stays at the end.
        var editor = h.open('create table t (a int, bb string);\n', {}, [[9, 9], [35, 35]]);
        var result = await h.run('formatHiveDdl');
        assert.strictEqual(result.status, 'ready');
        assert.strictEqual(editor.document.text, 'CREATE TABLE t\n(\n     a  INT\n    ,bb STRING\n);\n');
        assert.deepStrictEqual(selections(editor), [[0, 0], [47, 47]]);

        editor = h.open('CREATE TABLE t\n(\n     a INT\n);\n');
        result = await h.run('formatHiveDdl');
        assert.strictEqual(result.status, 'unchanged');
        assert.strictEqual(editor.editCalls, 0);

        // K35: a selection without the final newline, or indented with CRLF, is unchanged too.
        for (var value of [['CREATE TABLE t\n(\n     a INT\n);\n', 0, 30], ['  CREATE TABLE t\r\n  (\r\n       a INT\r\n  );\r\n', 2, 42]]) {
            editor = h.open(value[0], {}, [[value[1], value[2]]]);
            result = await h.run('formatHiveDdl');
            assert.strictEqual(result.status, 'unchanged');
            assert.strictEqual(editor.editCalls, 0);
        }

        editor = h.open("create table t (a int) location 'x';\n");
        result = await h.run('formatHiveDdl');
        assert.strictEqual(result.status, 'rejected');
        assert.deepStrictEqual(result.diagnostics.map(function(item) { return [item.code, item.severity]; }).sort(),
            [['ADAPTER_DDL_RESULT', 'error'], ['DDL_UNMODELED_SUFFIX', 'warning']]);
        assert.deepStrictEqual(h.lastMessage(), { kind: 'warning', text: MESSAGES.ddl });
        assert.deepStrictEqual(h.diagnosticCodes(editor.document).sort(), ['ADAPTER_DDL_RESULT', 'DDL_UNMODELED_SUFFIX']);
    });
});

test('extractHiveDdl replaces a query with column definitions; a wildcard is rejected', function() {
    return host(async function(h) {
        var editor = h.open('select a, b as c from t;\n', {}, [[0, 24]]);
        var result = await h.run('extractHiveDdl');
        assert.strictEqual(result.status, 'ready');
        assert.strictEqual(editor.document.text, '     a __TYPE_REQUIRED__\n    ,c __TYPE_REQUIRED__\n');
        assert.deepStrictEqual(selections(editor), [[0, 49]]);

        editor = h.open('select * from t;\n');
        result = await h.run('extractHiveDdl');
        assert.strictEqual(result.status, 'rejected');
        assert.deepStrictEqual(result.diagnostics.map(function(item) { return [item.code, item.severity]; }).sort(),
            [['ADAPTER_DDL_RESULT', 'error'], ['EXTRACT_WILDCARD', 'warning']]);
        assert.strictEqual(editor.document.text, 'select * from t;\n');
    });
});

test('DDL commands: cancellation, stale document and refused edits apply nothing', function() {
    var source = 'create table t (a int);\n';
    return host(async function(h) {
        var editor = h.open(source);
        h.progressToken = fake.token();
        h.progressToken.cancel();
        var result = await h.run('formatHiveDdl');
        assert.strictEqual(result.status, 'cancelled');
        assert.deepStrictEqual(h.lastMessage(), { kind: 'info', text: MESSAGES.cancelled });

        editor = h.open(source);
        editor.editResult = false;
        result = await h.run('formatHiveDdl');
        assert.strictEqual(result.status, 'rejected');
        assert.deepStrictEqual(codes(result), ['ADAPTER_EDIT_REJECTED']);
        assert.deepStrictEqual(h.lastMessage(), { kind: 'warning', text: MESSAGES.editRejected });
        assert.strictEqual(editor.document.text, source);
    });
});
