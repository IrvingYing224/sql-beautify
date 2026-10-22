#!/usr/bin/env node
'use strict';

// P1 one-off (deleted with the old tests in P2): for formatSql and formatHiveDdl inputs the
// formatter accepts, compares the leaves run.js lets change case with the leaves the formatter
// actually re-cases, i.e. those that differ between its keywordCase upper and lower outputs.
// Inputs are the golden runs, a few targeted formatSql inputs and a generated DDL grid of type
// shapes, column names, suffixes and headers. Needs a fresh .tmp/v2-core.

var path = require('path');

var root = path.join(__dirname, '..', '..', '..');
var runner = require(path.join(__dirname, '..', 'run.js'));
var format = require(path.join(root, '.tmp', 'v2-core', 'core', 'api', 'format.js'));
var hiveDdl = require(path.join(root, '.tmp', 'v2-core', 'experimental', 'ddl', 'hive-ddl.js'));

var SQL = [
    ['select a::int, cast(b as varchar(10)), c::numeric(10, 2) from t', { dialect: 'postgresql' }],
    ['select cast(a as int), cast(b as decimal(10,2)), a rlike b, a regexp b from t', undefined],
    ['select int, string, date from t where date > 1', undefined],
    ['add jar /tmp/Current.jar;\nset hive.Exec.mode=Strict;\nselect 1', undefined],
    ['show role grant user string;\nuse Db;\nselect x from t', undefined],
    ['select ${v}and, ${w} from t where ds=${hiveconf:Run_Date}', undefined],
    ['select a from t lateral view explode(b) e as v where a in (select c from u)', undefined],
];

var TYPES = [
    'int', 'string', 'date', 'timestamp', 'binary', 'boolean', 'varchar(10)', 'char(1)',
    'decimal(10,2)', 'decimal(int)', 'varchar(comment)', 'custom_type(string)', 'comment', 'orc',
    'string_x', 'array<comment>', 'map<string,comment>', 'map<string,array<int>>',
    'array<struct<a:int,b:string>>', 'struct<date:string,comment:int,string:decimal(int)>',
    'array<map<string,decimal(10,2)>>', 'uniontype<int,string>',
];
var NAMES = ['a', 'date', 'comment', 'orc', 'string', '`Q`'];
var SUFFIXES = ['', ' partitioned by (ds string)', ' stored as orc',
    ' partitioned by (date date, comment comment) stored as textfile'];
var HEADERS = ['create table t', 'create external table if not exists db.orc', 'CREATE TABLE `T`'];

function generated() {
    var sources = [];
    HEADERS.forEach(function(header) {
        NAMES.forEach(function(name) {
            TYPES.forEach(function(type) {
                SUFFIXES.forEach(function(suffix) {
                    ['', " comment 'KeepCase'"].forEach(function(comment) {
                        sources.push(header + ' (' + name + ' ' + type + comment + ', b int)' + suffix);
                    });
                });
            });
        });
    });
    return sources.map(function(source, index) {
        return { key: 'generated/' + index, source: source, spec: { op: 'formatHiveDdl' } };
    });
}

function targeted() {
    return SQL.map(function(entry, index) {
        return { key: 'targeted/' + index, source: entry[0], spec: { options: entry[1] } };
    });
}

function cased(env, source, keywordCase) {
    var options = Object.assign({}, env.options, { keywordCase: keywordCase });
    return env.op === 'formatSql'
        ? format.executeFormatSql(source, options, env.mode, env.newline, false, env.tabSize).result
        : hiveDdl.executeFormatHiveDdl(source, options, false, env.tabSize, env.startColumn);
}

function compare(runs) {
    var seen = new Set();
    var outcome = { formatSql: 0, formatHiveDdl: 0, missing: [], extra: [], misaligned: [] };
    runs.forEach(function(run) {
        var env = runner.resolveEnvironment(run.spec, run.source);
        var key = JSON.stringify([env.op, run.source, env.options, env.mode]);
        if (env.op === 'extractDdl' || seen.has(key)) {
            return;
        }
        seen.add(key);
        // An invalid keywordCase would become valid under the override below.
        if (env.options && env.options.keywordCase !== undefined &&
            ['upper', 'lower'].indexOf(env.options.keywordCase) < 0) {
            return;
        }
        var results = [cased(env, run.source, 'upper'), cased(env, run.source, 'lower')];
        var accepted = results[0].status === 'formatted' || results[0].status === 'unchanged';
        if (!accepted && env.op === 'formatSql') {
            return;
        }
        // An accepted formatSql call has a valid dialect; DDL is always Hive.
        var dialect = env.options && env.options.dialect !== undefined ? env.options.dialect : 'hive';
        var a = runner.codeLeaves(run.source, dialect);
        var allowed = env.op === 'formatSql'
            ? runner.sqlCaseAuthorized(run.source, env.options, dialect, env.mode, a)
            : runner.ddlCaseAuthorized(run.source, env, a);
        if (!accepted) {
            if (allowed.size > 0) {
                outcome.extra.push(run.key + ': authorizes a non-modeled input');
            }
            return;
        }
        var upper = runner.codeLeaves(results[0].text, dialect);
        var lower = runner.codeLeaves(results[1].text, dialect);
        // A token-changing output (K29 joins `> >` into `>>`) has no leaf-by-leaf comparison.
        if (upper.length !== a.length || lower.length !== a.length) {
            outcome.misaligned.push(run.key);
            return;
        }
        outcome[env.op] = (outcome[env.op] || 0) + 1;
        a.forEach(function(leaf, index) {
            var recased = upper[index].raw !== lower[index].raw;
            if (recased && !allowed.has(index)) {
                outcome.missing.push(run.key + ': ' + leaf.raw + ' in ' + run.source);
            }
            if (!recased && allowed.has(index)) {
                outcome.extra.push(run.key + ': ' + leaf.raw + ' in ' + run.source);
            }
        });
    });
    return outcome;
}

var failures = 0;
[['golden', runner.loadRuns()], ['targeted', targeted()], ['generated', generated()]].forEach(function(entry) {
    var outcome = compare(entry[1]);
    console.log(entry[0] + ': ' + outcome.formatSql + ' formatSql and ' + outcome.formatHiveDdl +
        ' DDL inputs compared; skipped as token-changing: ' + JSON.stringify(outcome.misaligned));
    console.log('  re-cased but not authorized: ' + outcome.missing.length + ' ' +
        JSON.stringify(outcome.missing.slice(0, 5)));
    console.log('  authorized but never re-cased: ' + outcome.extra.length + ' ' +
        JSON.stringify(outcome.extra.slice(0, 5)));
    failures += outcome.missing.length + outcome.extra.length;
});
process.exitCode = failures === 0 ? 0 : 1;
