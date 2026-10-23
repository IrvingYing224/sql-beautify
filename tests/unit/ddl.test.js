'use strict';

// computeEdits for Format Hive DDL and Extract DDL (plan §5.4, §5.5): target rules, batch atomicity,
// replacement text and limits. Expected values were measured on 2.2.1; P4b changes name their K number.

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var test = require('node:test');
var src = require('./helpers/src');
var m = src({ compute: 'edits/compute', literal: 'ddl/string-literal' });

function run(compute, op, source, targets, extra) {
    return compute.computeEdits(Object.assign({
        op: op,
        source: source,
        targets: targets || [{ id: 'document', start: 0, end: source.length, mode: 'document' }],
        selections: [],
        options: undefined,
        newline: '\n',
        tabSize: 4,
        debug: false
    }, extra));
}

function ddl(source, targets, extra) {
    return run(m.compute, 'hive-ddl', source, targets, extra);
}

function extract(source, targets, extra) {
    return run(m.compute, 'extract', source, targets, extra);
}

function target(id, start, end) {
    return { id: id, start: start, end: end, mode: 'fragment' };
}

function diagnostics(result) {
    return result.diagnostics.map(function(item) {
        return [item.code, item.severity, item.span.start, item.span.end, item.targetId];
    });
}

function edits(result) {
    return result.edits.map(function(edit) { return [edit.targetId, edit.start, edit.end, edit.text]; });
}

function applied(source, result) {
    return result.edits.slice().reverse().reduce(function(text, edit) {
        return text.slice(0, edit.start) + edit.text + text.slice(edit.end);
    }, source);
}

var TWO = 'CREATE TABLE a (x INT);\nCREATE TABLE b (y INT);';

test('X1 X2: one edit per target; an already formatted target is unchanged', function() {
    var result = ddl('create table t (a int);');
    // K21: the output ends with a line break only when the target does.
    assert.deepStrictEqual(edits(result), [['document', 0, 23, 'CREATE TABLE t\n(\n     a INT\n);']]);
    assert.deepStrictEqual(edits(ddl('create table t (a int);\n')), [['document', 0, 24, 'CREATE TABLE t\n(\n     a INT\n);\n']]);
    var formatted = 'CREATE TABLE t\n(\n     a INT\n)\n';
    assert.deepStrictEqual(ddl(formatted), { status: 'unchanged', edits: [], selections: [], diagnostics: [], debugEvents: [] });
    // K35: an already formatted target is unchanged in any layout, with or without the final line break.
    var indented = '    CREATE TABLE t\n    (\n         a INT\n    )\n';
    var tab = '\tCREATE TABLE t\n\t(\n\t     a INT\n\t)';
    [
        ddl(formatted, [target('t', 0, 29)]),
        ddl(formatted.replace(/\n/g, '\r\n'), undefined, { newline: '\r\n' }),
        ddl(indented, [target('t', 4, indented.length)]),
        ddl(tab, [target('t', 1, tab.length)], { tabSize: 2 })
    ].forEach(function(value) {
        assert.deepStrictEqual([value.status, value.edits], ['unchanged', []]);
    });
});

test('X3: a result that cannot be applied rejects with the op diagnostic and ADAPTER_DDL_RESULT', function() {
    assert.deepStrictEqual(diagnostics(ddl('CREATE TABLE t (a STRING) STORED AS JSONFILE')), [
        ['ADAPTER_DDL_RESULT', 'error', 0, 44, 'document'], ['DDL_STORAGE_FORMAT', 'warning', 36, 44, 'document']
    ]);
    assert.deepStrictEqual(diagnostics(extract('SELECT * FROM t')), [
        ['ADAPTER_DDL_RESULT', 'error', 0, 15, 'document'], ['EXTRACT_WILDCARD', 'warning', 0, 15, 'document']
    ]);
    assert.deepStrictEqual(diagnostics(extract('CREATE TABLE t (a STRING)')), [
        ['ADAPTER_DDL_RESULT', 'error', 0, 25, 'document'], ['EXTRACT_UNSUPPORTED_STATEMENT', 'warning', 0, 25, 'document']
    ]);
    // These targets are rejected before the op runs.
    assert.deepStrictEqual(diagnostics(extract('')), [['ADAPTER_DDL_RANGE', 'error', 0, 0, 'document']]);
    assert.deepStrictEqual(diagnostics(extract("SELECT 'unterminated")), [['ADAPTER_DDL_RANGE', 'error', 0, 20, 'document']]);
});

test('X8 X9 X10 X11: batches are atomic, in source order, and must not overlap', function() {
    var result = ddl(TWO, [target('second', 24, 47), target('first', 0, 23)]);
    assert.deepStrictEqual(edits(result), [
        ['first', 0, 23, 'CREATE TABLE a\n(\n     x INT\n);'],
        ['second', 24, 47, 'CREATE TABLE b\n(\n     y INT\n);']
    ]);
    assert.strictEqual(applied(TWO, result), 'CREATE TABLE a\n(\n     x INT\n);\nCREATE TABLE b\n(\n     y INT\n);');

    result = ddl('CREATE TABLE a (x INT);\nCREATE TABLE b (y STRING) STORED AS JSONFILE;', [target('first', 0, 23), target('second', 24, 69)]);
    assert.deepStrictEqual([result.status, result.edits], ['rejected', []]);
    assert.deepStrictEqual(diagnostics(result), [
        ['ADAPTER_DDL_RESULT', 'error', 24, 69, 'second'], ['DDL_STORAGE_FORMAT', 'warning', 60, 68, 'second']
    ]);

    var formatted = 'CREATE TABLE a\n(\n     x INT\n);\n\nCREATE TABLE b\n(\n     y INT\n);\n';
    assert.strictEqual(ddl(formatted, [target('a', 0, 31), target('b', 32, 63)]).status, 'unchanged');
    assert.strictEqual(ddl(formatted, [target('a', 0, 30), target('b', 32, 63)]).status, 'unchanged');

    assert.deepStrictEqual(diagnostics(ddl(TWO, [target('left', 0, 23), target('right', 22, 47)])),
        [['ADAPTER_DDL_TARGET', 'error', 0, 47, null]]);
});

test('X12: a target covers whole lines of code and splits no literal, comment or line break', function() {
    var crlf = 'CREATE TABLE t (a INT);\r\nSELECT 1';
    [
        ["SELECT 'create table t (a int);' AS payload", 8, 31],
        ['prefix CREATE TABLE t (a INT); suffix', 7, 30],
        [crlf, 0, 24],
        [crlf, 24, 33],
        ['create table t (a int); -- note', 0, 23],
        ['/* a */ create table t (a int);', 0, 7],
        ['   ', 0, 3]
    ].forEach(function(value) {
        var result = ddl(value[0], [target('x', value[1], value[2])]);
        assert.deepStrictEqual(diagnostics(result), [['ADAPTER_DDL_RANGE', 'error', value[1], value[2], 'x']], JSON.stringify(value));
    });
    assert.deepStrictEqual(edits(ddl(crlf, [target('x', 0, 23)], { newline: '\r\n' })),
        [['x', 0, 23, 'CREATE TABLE t\r\n(\r\n     a INT\r\n);']]);
    // K18: a target may end at column 0 of the next line, whatever that line holds.
    assert.deepStrictEqual(edits(ddl(crlf, [target('x', 0, 25)], { newline: '\r\n' })),
        [['x', 0, 25, 'CREATE TABLE t\r\n(\r\n     a INT\r\n);\r\n']]);
    for (var next of ['select 1;', '  select 1;']) {
        assert.deepStrictEqual(edits(ddl('create table t (a int);\n' + next, [target('x', 0, 24)])),
            [['x', 0, 24, 'CREATE TABLE t\n(\n     a INT\n);\n']]);
    }
    assert.deepStrictEqual(edits(extract('select a from t;\nselect 1;', [target('x', 0, 17)])),
        [['x', 0, 17, '     a __TYPE_REQUIRED__\n']]);
    // Plan §6 P4a acceptance cases; the selection maps through the edit.
    var result = ddl('  create table t (a int);', [target('x', 2, 25)], { selections: [{ targetId: 'x', anchor: 2, active: 25 }] });
    assert.deepStrictEqual(edits(result), [['x', 2, 25, 'CREATE TABLE t\n  (\n       a INT\n  );']]);
    assert.deepStrictEqual(result.selections, [{ anchor: 2, active: 38 }]);
});

test('X13 X14: the edit is the target (K21); later lines repeat the indentation', function() {
    // The blanks after a target that ends inside its line stay.
    var source = 'SELECT 1;\n    create table t (a int);   \nSELECT 2;';
    var result = ddl(source, [target('x', 14, 37)]);
    assert.deepStrictEqual(edits(result), [['x', 14, 37, 'CREATE TABLE t\n    (\n         a INT\n    );']]);
    assert.strictEqual(applied(source, result), 'SELECT 1;\n    CREATE TABLE t\n    (\n         a INT\n    );   \nSELECT 2;');

    source = 'SELECT 1;\r\n\tcreate table t (a int);\t \r\nSELECT 2;';
    result = ddl(source, [target('x', 12, 37)], { newline: '\r\n' });
    assert.deepStrictEqual(edits(result), [['x', 12, 37, 'CREATE TABLE t\r\n\t(\r\n\t     a INT\r\n\t);']]);
    assert.strictEqual(applied(source, result), 'SELECT 1;\r\n\tCREATE TABLE t\r\n\t(\r\n\t     a INT\r\n\t);\r\nSELECT 2;');

    assert.deepStrictEqual(edits(ddl('create table t (a int);   \n', [target('x', 0, 23)])),
        [['x', 0, 23, 'CREATE TABLE t\n(\n     a INT\n);']]);
    assert.deepStrictEqual(edits(ddl('create table t (a int);   \n', [target('x', 0, 27)])),
        [['x', 0, 27, 'CREATE TABLE t\n(\n     a INT\n);\n']]);

    source = '  CREATE TABLE a (x INT)\n\tCREATE TABLE b (y INT)';
    for (var tabSize of [4, 8]) {
        assert.deepStrictEqual(edits(ddl(source, [target('spaces', 2, 24), target('tab', 26, 48)], { tabSize: tabSize })), [
            ['spaces', 2, 24, 'CREATE TABLE a\n  (\n       x INT\n  )'],
            ['tab', 26, 48, 'CREATE TABLE b\n\t(\n\t     y INT\n\t)']
        ]);
    }
    assert.deepStrictEqual(edits(ddl('  \tCREATE TABLE a (x INT)', [target('x', 3, 25)])),
        [['x', 3, 25, 'CREATE TABLE a\n  \t(\n  \t     x INT\n  \t)']]);
});

test('X16 X17: line breaks inside literals and quoted identifiers are kept as written', function() {
    assert.deepStrictEqual(edits(ddl("CREATE TABLE t (a STRING COMMENT 'x\ny')", undefined, { newline: '\r\n' })),
        [['document', 0, 39, "CREATE TABLE t\r\n(\r\n     a STRING COMMENT 'x\ny'\r\n)"]]);
    assert.deepStrictEqual(edits(ddl("    CREATE TABLE t (a STRING COMMENT 'x\ny')", [target('x', 4, 43)])),
        [['x', 4, 43, "CREATE TABLE t\n    (\n         a STRING COMMENT 'x\ny'\n    )"]]);
    assert.deepStrictEqual(edits(ddl('create table t (`a\nb` int)', undefined, { newline: '\r\n' })),
        [['document', 0, 26, 'CREATE TABLE t\r\n(\r\n     `a\nb` INT\r\n)']]);
});

test('U-DDL1: the editor tabSize sets the alignment after a tab', function() {
    var source = 'CREATE TABLE t (`a\tb` STRING, ascii STRING, `中` STRING)';
    var options = { indentStyle: 'tab' };
    assert.deepStrictEqual(edits(ddl(source, undefined, { options: options, tabSize: 4 })),
        [['document', 0, 55, 'CREATE TABLE t\n(\n\t `a\tb` STRING\n\t,ascii STRING\n\t,`中`  STRING\n)']]);
    assert.deepStrictEqual(edits(ddl(source, undefined, { options: options, tabSize: 8 })),
        [['document', 0, 55, 'CREATE TABLE t\n(\n\t `a\tb` STRING\n\t,ascii     STRING\n\t,`中`      STRING\n)']]);
    source = '  SELECT `a\tb`, ascii, `中` FROM t';
    assert.deepStrictEqual(edits(extract(source, [target('x', 2, 33)], { tabSize: 4 })), [['x', 2, 33,
        '     `a\tb` __TYPE_REQUIRED__\n      ,ascii   __TYPE_REQUIRED__\n      ,`中`    __TYPE_REQUIRED__']]);
    assert.deepStrictEqual(edits(extract(source, [target('x', 2, 33)], { tabSize: 8 })), [['x', 2, 33,
        '     `a\tb` __TYPE_REQUIRED__\n      ,ascii       __TYPE_REQUIRED__\n      ,`中`        __TYPE_REQUIRED__']]);
});

test('U-DDL3: an exception inside the op fails with a message that holds no SQL', async function() {
    // Bundle a parser whose parseSqlArtifact throws with the SQL as its message, for this test only.
    var root = path.join(__dirname, '..', '..');
    var outfile = path.join(root, '.tmp', 'tests', 'unit-throwing-parser.cjs');
    await require('esbuild').build(src.options({
        stdin: { contents: 'export * from "./edits/compute";', resolveDir: path.join(root, 'src'), loader: 'ts' },
        outfile: outfile,
        plugins: [{ name: 'throwing-parser', setup: function(build) {
            build.onLoad({ filter: /[\\/]core[\\/]syntax[\\/]parser\.ts$/ }, function(args) {
                var contents = fs.readFileSync(args.path, 'utf8').replace('export function parseSqlArtifact(',
                    'export function parseSqlArtifact(source: string): never { throw new Error(source); }\nfunction unused(');
                return { contents: contents, loader: 'ts' };
            });
        } }]
    }));
    var throwing = require(outfile);
    var result = run(throwing, 'hive-ddl', 'CREATE TABLE secret (a INT)');
    assert.deepStrictEqual(diagnostics(result), [
        ['ADAPTER_DDL_RESULT', 'error', 0, 27, 'document'], ['DDL_INTERNAL', 'error', 0, 27, 'document']
    ]);
    assert.strictEqual(result.diagnostics[1].message, 'Hive DDL formatting failed safely');
    result = run(throwing, 'extract', 'SELECT secret FROM t');
    assert.deepStrictEqual(diagnostics(result), [
        ['ADAPTER_DDL_RESULT', 'error', 0, 20, 'document'], ['EXTRACT_ANALYSIS_FAILED', 'error', 0, 20, 'document']
    ]);
    assert.strictEqual(result.diagnostics[1].message, 'DDL extraction analysis failed safely');
    assert.ok(result.diagnostics.every(function(item) { return item.message.indexOf('secret') < 0; }));
});

test('U-RES1: alignment falls back to one space when a column name is too wide', function() {
    var wide = '`' + 'x'.repeat(10000) + '`';
    var columns = Array.from({ length: 1000 }, function(_, index) { return 'c' + index; });
    var source = 'CREATE TABLE t (' + [wide + ' STRING'].concat(columns.map(function(name) { return name + ' STRING'; })).join(',') + ')';
    assert.strictEqual(source.length, 21916);
    var result = ddl(source);
    assert.strictEqual(result.edits.length, 1);
    assert.deepStrictEqual(result.edits[0].text.split('\n'), ['CREATE TABLE t', '(', '     ' + wide + ' STRING']
        .concat(columns.map(function(name) { return '    ,' + name + ' STRING'; }), [')']));

    source = 'SELECT ' + [wide].concat(columns).join(',') + ' FROM t';
    assert.strictEqual(source.length, 14906);
    result = extract(source);
    assert.deepStrictEqual(result.edits[0].text.split('\n'), ['     ' + wide + ' __TYPE_REQUIRED__']
        .concat(columns.map(function(name) { return '    ,' + name + ' __TYPE_REQUIRED__'; })));
});

test('U-RES2 X15: 524,288 code units are accepted, one more is rejected before the op', function() {
    var source = 'CREATE TABLE t (a INT)'.padEnd(524288, ' ');
    assert.deepStrictEqual(edits(ddl(source)), [['document', 0, 524288, 'CREATE TABLE t\n(\n     a INT\n)']]);
    assert.deepStrictEqual(diagnostics(ddl(source + ' ')), [['ADAPTER_DDL_INPUT_LIMIT', 'warning', 0, 524289, null]]);
    source = 'SELECT a FROM t'.padEnd(524288, ' ');
    assert.deepStrictEqual(edits(extract(source)), [['document', 0, 524288, '     a __TYPE_REQUIRED__']]);
    assert.deepStrictEqual(diagnostics(extract(source + ' ')), [['ADAPTER_DDL_INPUT_LIMIT', 'warning', 0, 524289, null]]);
});

test('U-STR: Extract writes Hive string literals that decode to the comment', function() {
    function decode(literal) {
        assert.ok(literal[0] === "'" && literal[literal.length - 1] === "'");
        var body = literal.slice(1, -1);
        var short = { '0': '\0', b: '\b', n: '\n', r: '\r', t: '\t', Z: '\u001a' };
        var output = '';
        for (var index = 0; index < body.length; index++) {
            if (body[index] !== '\\') {
                output += body[index];
                continue;
            }
            var rest = body.slice(index + 1);
            if (/^u[0-9a-fA-F]{4}/.test(rest)) {
                output += String.fromCharCode(parseInt(rest.slice(1, 5), 16));
                index += 5;
            } else if (/^[01][0-7]{2}/.test(rest)) {
                output += String.fromCharCode(parseInt(rest.slice(0, 3), 8));
                index += 3;
            } else {
                output += Object.prototype.hasOwnProperty.call(short, rest[0]) ? short[rest[0]] : rest[0];
                index += 1;
            }
        }
        return output;
    }
    [
        ["owner's column", "'owner\\'s column'"],
        ["a\\'b", "'a\\\\\\'b'"],
        ['a\\nb', "'a\\\\nb'"],
        ['a\0b', "'a\\u0000b'"],
        ['a\x0012b', "'a\\u000012b'"],
        ['a\x0077b', "'a\\u000077b'"],
        ["a\0'b", "'a\\u0000\\'b'"],
        ['a\bb', "'a\\bb'"],
        ['a\tb', "'a\\tb'"],
        ['a\nb', "'a\\nb'"],
        ['a\r\nb', "'a\\r\\nb'"],
        ['a\u001ab', "'a\\Zb'"],
        ['a\u0001b', "'a\\u0001b'"],
        ['中文 "note"', "'中文 \"note\"'"]
    ].forEach(function(pair) {
        assert.strictEqual(m.literal.hiveStringLiteral(pair[0]), pair[1]);
        assert.strictEqual(decode(pair[1]), pair[0]);
    });
});
