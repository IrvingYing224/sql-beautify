'use strict';

// Host diagnostics: the unsupportedSyntaxPolicy, containing-span dedup, and the lifecycle of output
// diagnostics (published once the document text equals the output). Expected values are those of 2.2.1.

var assert = require('assert');
var test = require('node:test');
var fake = require('./helpers/fake-vscode');

// A FROM-first multi-insert is not modeled and its warning carries no capability.
var FROM_FIRST = 'from t select a;\nselect a from t qualify row_number() over (order by a) = 1;';
var S = 'select a,b from t;\n\nCREATE TABLE t (x INT);';
var O = 'SELECT\n      a\n    , b\nFROM t;\n\nCREATE TABLE t (x INT);';
var MODELED_WARNING = [['SYN_UNSUPPORTED_STATEMENT', 1, 30, 55]];

function host(options, body) {
    return fake.withHost(body === undefined ? {} : options, body === undefined ? options : body);
}

function published(h, document) {
    return (h.diagnostics.get(document.uri.toString()) || []).map(function(item) {
        assert.strictEqual(item.source, 'SQL Beautify');
        return [item.code, item.severity, document.offsetAt(item.range.start), document.offsetAt(item.range.end)];
    });
}

test('H5: warn shows every innermost diagnostic; preserve hides capability warnings; bail_out rejects', function() {
    var warn = [['SYN_UNSUPPORTED_STATEMENT', 1, 0, 16], ['SYN_UNMODELED_CONSTRUCT', 1, 33, 75]];
    return host(async function(h) {
        var editor = h.open(FROM_FIRST);
        assert.deepStrictEqual(await h.formatDocument(editor.document), []);
        assert.deepStrictEqual(published(h, editor.document), warn, 'the containing qualify span is dropped');

        var result = await h.run('formatSql', { unsupportedSyntaxPolicy: 'bail_out' });
        assert.strictEqual(result.status, 'rejected');
        assert.deepStrictEqual(published(h, editor.document), [['SYN_UNSUPPORTED_STATEMENT', 1, 0, 16],
            ['FMT_UNSUPPORTED_BAIL_OUT', 1, 0, 76], ['SYN_UNMODELED_CONSTRUCT', 1, 33, 75]]);
        assert.deepStrictEqual(h.lastMessage(), { kind: 'warning',
            text: 'SQL Beautify did not modify the document because formatting was not safe.' });

        h.messages = [];
        editor = h.open('CREATE TABLE t (x INT);');
        assert.strictEqual((await h.run('formatSql')).status, 'unchanged');
        assert.deepStrictEqual(published(h, editor.document), [['SYN_UNSUPPORTED_STATEMENT', 1, 0, 23]]);
        assert.deepStrictEqual(h.messages, []);

        // Explicit preserve in the command arguments behaves like the setting.
        editor = h.open(FROM_FIRST);
        result = await h.run('formatSql', { unsupportedSyntaxPolicy: 'preserve' });
        assert.strictEqual(result.status, 'unchanged');
        assert.deepStrictEqual(published(h, editor.document), [['SYN_UNSUPPORTED_STATEMENT', 1, 0, 16]]);
    }).then(function() {
        return host({ configuration: { 'sqlBeautify.unsupportedSyntaxPolicy': 'preserve' } }, async function(h) {
            var editor = h.open(FROM_FIRST);
            assert.deepStrictEqual(await h.formatDocument(editor.document), []);
            assert.deepStrictEqual(published(h, editor.document), [['SYN_UNSUPPORTED_STATEMENT', 1, 0, 16]]);
            assert.deepStrictEqual(h.messages, [], 'providers show no popup');
            var result = await h.run('formatSql');
            assert.strictEqual(result.status, 'unchanged');
            assert.deepStrictEqual(published(h, editor.document), [['SYN_UNSUPPORTED_STATEMENT', 1, 0, 16]]);
            assert.deepStrictEqual(h.lastMessage(), { kind: 'info',
                text: 'SQL Beautify made no changes because 1 SQL region(s) are not modeled.' });
        });
    });
});

test('H11b: the provider token after return does not matter; edits never applied publish nothing', function() {
    return host(async function(h) {
        for (var cancelFirst of [true, false]) {
            var editor = h.open(S);
            var token = fake.token();
            var edits = await h.formatDocument(editor.document, undefined, token);
            assert.strictEqual(token.listeners(), 0);
            if (cancelFirst) {
                token.cancel();
            }
            h.applyEdits(editor.document, edits);
            token.cancel();
            assert.deepStrictEqual(published(h, editor.document), MODELED_WARNING);
        }
        editor = h.open(S, { uri: 'untitled:never-applied.sql' });
        token = fake.token();
        await h.formatDocument(editor.document, undefined, token);
        token.cancel();
        assert.deepStrictEqual(published(h, editor.document), []);
        h.replace(editor.document, [{ start: 0, end: S.length, text: 'select unrelated;' }]);
        assert.deepStrictEqual(published(h, editor.document), []);
    });
});

test('H11c: output is matched by text, not by the shape of the change or the version step', function() {
    return host(async function(h) {
        var editor = h.open(S);
        await h.formatDocument(editor.document);
        editor.document.text = O;
        editor.document.version += 7;
        h.fireChange(editor.document, [
            { rangeOffset: 0, rangeLength: 6, text: 'SELECT' },
            { rangeOffset: 6, rangeLength: 12, text: O.slice(6, O.indexOf('CREATE')) }
        ]);
        assert.deepStrictEqual(published(h, editor.document), MODELED_WARNING);
        h.replace(editor.document, [{ start: 0, end: O.length, text: S }]);
        assert.deepStrictEqual(published(h, editor.document), []);
        h.replace(editor.document, [{ start: 0, end: S.length, text: O }]);
        assert.deepStrictEqual(published(h, editor.document), [], 'no revival');

        editor = h.open(S);
        await h.formatDocument(editor.document);
        h.replace(editor.document, [{ start: 0, end: S.length, text: 'select other;' }]);
        h.replace(editor.document, [{ start: 0, end: 13, text: O }]);
        assert.deepStrictEqual(published(h, editor.document), []);
    });
});

test('H11d: a command publishes once whether its change event comes before or after editor.edit resolves', function() {
    return host(async function(h) {
        var editor = h.open(S);
        var document = editor.document;
        var withheld = null;
        editor.edit = function(callback) {
            var changes = [];
            callback({ replace: function(range, text) {
                changes.push({ start: document.offsetAt(range.start), end: document.offsetAt(range.end), text: text });
            } });
            editor.editCalls += 1;
            changes.slice().sort(function(a, b) { return b.start - a.start; }).forEach(function(item) {
                document.text = document.text.slice(0, item.start) + item.text + document.text.slice(item.end);
            });
            document.version += 1;
            withheld = changes;
            return Promise.resolve(true);
        };
        var result = await h.run('formatSql');
        assert.strictEqual(result.status, 'ready');
        assert.deepStrictEqual(published(h, document), MODELED_WARNING);
        var writes = h.diagnosticWrites;
        h.fireChange(document, withheld.map(function(item) {
            return { rangeOffset: item.start, rangeLength: item.end - item.start, text: item.text };
        }));
        assert.deepStrictEqual(published(h, document), MODELED_WARNING, 'the late change event keeps them');
        assert.strictEqual(h.diagnosticWrites, writes);
        h.replace(document, [{ start: 0, end: 0, text: '-- edit\n' }]);
        assert.deepStrictEqual(published(h, document), []);
    });
});

test('R1: the 512 Ki input limit at the host, through the worker', function() {
    return host(async function(h) {
        var over = 'select ' + 'a'.repeat(524282);
        var editor = h.open(over);
        assert.deepStrictEqual(await h.formatDocument(editor.document), []);
        assert.deepStrictEqual(published(h, editor.document), [['ADAPTER_INPUT_LIMIT', 0, 0, 524289]]);
        var result = await h.run('formatSql');
        assert.deepStrictEqual(result.diagnostics.map(function(item) { return item.code; }), ['ADAPTER_INPUT_LIMIT']);
        assert.deepStrictEqual(h.lastMessage(), { kind: 'warning',
            text: 'SQL Beautify did not modify the document because the selected SQL exceeds the 512 Ki code-unit limit.' });

        h.messages = [];
        editor = h.open(over.slice(0, -1));
        assert.strictEqual((await h.run('formatSql')).status, 'ready');
        assert.deepStrictEqual(h.messages, []);
    });
});
