#!/usr/bin/env node
'use strict';

// P1 one-off (deleted with the old tests in P2): re-applies the old tests' property-only alignment
// assertions to the golden outputs of the `called/` and `recapture/` groups. Needs a fresh
// .tmp/v2-core and an up-to-date snapshot.

var fs = require('fs');
var path = require('path');

var root = path.join(__dirname, '..', '..', '..');
var casesDir = path.join(__dirname, '..', 'cases');
var displayWidth = require(path.join(root, '.tmp', 'v2-core', 'core', 'renderer', 'display-width.js'));

var HEADER = '-- golden: ';
var runs = [];
var failures = 0;

function walk(dir) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach(function(entry) {
        var file = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            walk(file);
            return;
        }
        if (!entry.name.endsWith('.in.txt')) {
            return;
        }
        var text = fs.readFileSync(file, 'utf8');
        var header = {};
        var source = text;
        if (text.startsWith(HEADER)) {
            header = JSON.parse(text.slice(HEADER.length, text.indexOf('\n')));
            source = text.slice(text.indexOf('\n') + 1);
        }
        var base = file.slice(0, -'.in.txt'.length);
        var variants = header.variants;
        delete header.variants;
        (variants ? Object.keys(variants) : [null]).forEach(function(name) {
            var out = base + (name === null ? '' : '.' + name) + '.out.txt';
            runs.push({
                key: path.relative(casesDir, base) + (name === null ? '' : '#' + name),
                spec: Object.assign({}, header, name === null ? {} : variants[name]),
                source: source,
                text: fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : source,
            });
        });
    });
}

// The one run of `source` under exactly this op, options and environment.
function find(source, op, options, tabSize, startColumn) {
    var found = runs.filter(function(run) {
        return run.source === source && (run.spec.op || 'formatSql') === op &&
            JSON.stringify(run.spec.options || null) === JSON.stringify(options) &&
            (run.spec.tabSize || 4) === tabSize && (run.spec.startColumn || 0) === startColumn &&
            run.spec.mode === undefined && run.spec.newline === undefined;
    });
    if (found.length !== 1) {
        throw new Error(found.length + ' runs for ' + JSON.stringify([op, options, tabSize, startColumn, source]));
    }
    return found[0];
}

// Display columns of `marker` on the lines carrying it. Golden text is the normalized
// replacement: continuation lines already carry the external prefix, only the first line does not.
function columns(run, marker, tabSize, startColumn) {
    return run.text.split('\n').map(function(line, index) {
        return (index === 0 ? ' '.repeat(startColumn) : '') + line;
    }).filter(function(line) {
        return line.indexOf(marker) >= 0;
    }).map(function(line) {
        return displayWidth.displayWidth(line.slice(0, line.lastIndexOf(marker.trim())), 0, tabSize);
    });
}

function check(name, ok, run) {
    console.log((ok ? 'ok   ' : 'FAIL ') + name + (run ? ' (' + run.key + ')' : ''));
    failures += ok ? 0 : 1;
}

function aligned(name, run, marker, tabSize, startColumn, count) {
    var found = columns(run, marker, tabSize, startColumn);
    check(name + ' ' + JSON.stringify(found), found.length === count && new Set(found).size === 1, run);
}

walk(casesDir);

// wave3b-format-kernel:431-455; its `{ dialect: 'hive' }` is the default, dropped on import.
var kernel = 'select `a\tb` as x,\n       `abcdef` as y\nfrom t';
var byTab = {};
[2, 4, 8].forEach(function(tabSize) {
    byTab[tabSize] = find(kernel, 'formatSql', null, tabSize, 0);
    check('format-kernel tabSize ' + tabSize + ' formats', byTab[tabSize].text !== kernel, byTab[tabSize]);
});
check('format-kernel tabSize 2 differs from 4', byTab[2].text !== byTab[4].text);
check('format-kernel tabSize 8 differs from 4', byTab[8].text !== byTab[4].text);

// wave4d-ddl:121-157 and wave4d-transaction:452-487
var ddl = 'CREATE TABLE t (`a\tb` STRING, ascii STRING, `中` STRING)';
[2, 4, 8].forEach(function(tabSize) {
    aligned('DDL indentStyle tab, tabSize ' + tabSize,
        find(ddl, 'formatHiveDdl', { indentStyle: 'tab' }, tabSize, 0), ' STRING', tabSize, 0, 3);
});
aligned('DDL unicode matrix', find('CREATE TABLE t (`🙂` STRING, `é` STRING, `a\tb` STRING, ascii STRING)',
    'formatHiveDdl', null, 4, 0), ' STRING', 4, 0, 4);
aligned('DDL transaction target at column 2, tabSize 8',
    find(ddl, 'formatHiveDdl', { indentStyle: 'space' }, 8, 2), ' STRING', 8, 2, 3);

// wave4d-extract-ddl:201-259
var extract = 'SELECT `a\tb`, ascii, `中` FROM t';
[[2, 0], [4, 0], [8, 0], [8, 2]].forEach(function(environment) {
    aligned('Extract tabSize ' + environment[0] + ', startColumn ' + environment[1],
        find(extract, 'extractDdl', null, environment[0], environment[1]),
        '__TYPE_REQUIRED__', environment[0], environment[1], 3);
});
aligned('Extract unicode matrix', find('SELECT `🙂`, `é`, `a\tb`, ascii FROM t', 'extractDdl', null, 4, 0),
    '__TYPE_REQUIRED__', 4, 0, 4);

console.log(failures === 0 ? 'all property assertions hold' : failures + ' failures');
process.exitCode = failures === 0 ? 0 : 1;
