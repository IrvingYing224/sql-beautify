#!/usr/bin/env node
'use strict';

// P1 one-off (deleted with the old tests in P2): for every DDL input the formatter models, compares
// the leaves run.js lets change case with the leaves the formatter actually re-cases, i.e. those
// that differ between its keywordCase upper and lower outputs. Needs a fresh .tmp/v2-core.

var path = require('path');

var root = path.join(__dirname, '..', '..', '..');
var runner = require(path.join(__dirname, '..', 'run.js'));
var hiveDdl = require(path.join(root, '.tmp', 'v2-core', 'experimental', 'ddl', 'hive-ddl.js'));

var seen = new Set();
var inputs = 0;
var missing = [];
var extra = [];
var misaligned = [];
runner.loadRuns().forEach(function(run) {
    var env = runner.resolveEnvironment(run.spec, run.source);
    var key = JSON.stringify([run.source, env.options]);
    if (env.op !== 'formatHiveDdl' || seen.has(key)) {
        return;
    }
    seen.add(key);
    // An invalid keywordCase would become valid under the override below.
    if (env.options && env.options.keywordCase !== undefined &&
        ['upper', 'lower'].indexOf(env.options.keywordCase) < 0) {
        return;
    }
    var a = runner.codeLeaves(run.source, 'hive');
    var allowed = runner.ddlCaseAuthorized(run.source, env, a);
    var cased = ['upper', 'lower'].map(function(keywordCase) {
        var options = Object.assign({}, env.options, { keywordCase: keywordCase });
        return hiveDdl.executeFormatHiveDdl(run.source, options, false, env.tabSize, env.startColumn);
    });
    if (cased[0].status !== 'formatted' && cased[0].status !== 'unchanged') {
        if (allowed.size > 0) {
            extra.push(run.key + ': authorizes a non-modeled input');
        }
        return;
    }
    var upper = runner.codeLeaves(cased[0].text, 'hive');
    var lower = runner.codeLeaves(cased[1].text, 'hive');
    // A token-changing output (K29 joins `> >` into `>>`) has no leaf-by-leaf comparison.
    if (upper.length !== a.length || lower.length !== a.length) {
        misaligned.push(run.key);
        return;
    }
    inputs += 1;
    a.forEach(function(leaf, index) {
        var recased = upper[index].raw !== lower[index].raw;
        if (recased && !allowed.has(index)) {
            missing.push(run.key + ': ' + leaf.raw);
        }
        if (!recased && allowed.has(index)) {
            extra.push(run.key + ': ' + leaf.raw);
        }
    });
});
console.log(inputs + ' modeled DDL inputs; skipped as token-changing: ' + JSON.stringify(misaligned));
console.log('re-cased but not authorized: ' + missing.length + ' ' + JSON.stringify(missing.slice(0, 10)));
console.log('authorized but never re-cased: ' + extra.length + ' ' + JSON.stringify(extra.slice(0, 10)));
process.exitCode = missing.length === 0 && extra.length === 0 ? 0 : 1;
