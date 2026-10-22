#!/usr/bin/env node
'use strict';

// P1 one-off (deleted with the old tests in P2): reruns every old test file of the `verify` plan
// with recapture-hook.js preloaded and writes the calls, with their execution environment, to
// tests/golden/seeds: the verbatim-asserted ones to recapture-2026-10.json, and the remaining
// calls whose output the tests check only by property (alignment columns, tab sizes, ...) to
// called-2026-10.json. Needs fresh .tmp/v2-core and dist.

var childProcess = require('child_process');
var fs = require('fs');
var os = require('os');
var path = require('path');

var root = path.join(__dirname, '..', '..', '..');
var hook = path.join(__dirname, 'recapture-hook.js');
var output = path.join(__dirname, '..', 'seeds', 'recapture-2026-10.json');
var calledOutput = path.join(__dirname, '..', 'seeds', 'called-2026-10.json');
var plan = require(path.join(root, 'scripts', 'v2-suite-manifest.js')).buildPlan('verify');
var scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'golden-recapture-'));
var ENV_FIELDS = ['mode', 'newline', 'tabSize', 'startColumn'];
// Not migrated as called cases; the filter is by test name and status, so the labels are approximate:
// - performance tests: size inputs plus a few small generated and no-throw cases;
// - `unchanged`: mostly second passes (idempotence property), plus hand-formatted inputs such as
//   the wave4d-transaction no-edit case (P4a unit);
// - `failed`: invalid options or environment, and injected parser / analyzer failures (unit tests).
// recapture-hook.js also skips sources over 4,000 code units, so wide-column and input-limit cases
// stay with the resource unit tests (plan appendix D.3).
var UNMIGRATED_TESTS = /performance|perf-baseline/;
var UNMIGRATED_STATUS = { failed: true, unchanged: true };

var cases = [];
var seen = new Set();
var called = [];

function toSeed(entry, name) {
    // The adapter only ever passes tab sizes 1..256; out-of-range values are API misuse tests.
    if (entry.tabSize !== undefined && !(entry.tabSize >= 1 && entry.tabSize <= 256)) {
        return null;
    }
    var seed = { origin: 'recapture:' + name, op: entry.op };
    if (entry.options !== undefined) {
        seed.options = entry.options;
    }
    ENV_FIELDS.forEach(function(field) {
        if (entry[field] !== undefined) {
            seed[field] = entry[field];
        }
    });
    seed.source = entry.source;
    return seed;
}

function seedKey(seed) {
    return JSON.stringify([seed.op, seed.options, seed.mode, seed.newline, seed.tabSize,
        seed.startColumn, seed.source]);
}
plan.steps.filter(function(step) {
    return /^tests\/v2\/.*\.test\.js$/.test(step.args[0] || '');
}).forEach(function(step) {
    var name = path.basename(step.args[0], '.test.js');
    var file = path.join(scratch, name + '.json');
    var result = childProcess.spawnSync(process.execPath, ['-r', hook].concat(step.args), {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 1 << 28,
        env: Object.assign({}, process.env, step.environment, { GOLDEN_RECAPTURE_OUT: file }),
    });
    // Wall-clock gates may fail under instrumentation; their asserted calls are still recorded.
    console.log((result.status === 0 ? 'pass ' : 'fail ') + name);
    if (!fs.existsSync(file)) {
        return;
    }
    var recorded = JSON.parse(fs.readFileSync(file, 'utf8'));
    recorded.asserted.forEach(function(entry) {
        var seed = toSeed(entry, name);
        if (seed !== null && !seen.has(seedKey(seed))) {
            seen.add(seedKey(seed));
            cases.push(seed);
        }
    });
    if (UNMIGRATED_TESTS.test(name)) {
        return;
    }
    recorded.called.forEach(function(entry) {
        var seed = UNMIGRATED_STATUS[entry.status] ? null : toSeed(entry, name);
        if (seed !== null) {
            called.push(seed);
        }
    });
});
var calledSeen = new Set();
called = called.filter(function(seed) {
    var key = seedKey(seed);
    if (seen.has(key) || calledSeen.has(key)) {
        return false;
    }
    calledSeen.add(key);
    return true;
});
fs.rmSync(scratch, { recursive: true, force: true });
fs.writeFileSync(output, JSON.stringify({
    description: 'Asserted formatter and DDL calls of the old tests, with explicitly passed execution ' +
        'environment (an omitted field means the adapter default or inference). Input-only.',
    count: cases.length,
    cases: cases,
}, null, 1) + '\n');
fs.writeFileSync(calledOutput, JSON.stringify({
    description: 'Formatter and DDL calls of the old tests that are not asserted verbatim (their ' +
        'output is checked by property), with explicitly passed execution environment. Input-only.',
    count: called.length,
    cases: called,
}, null, 1) + '\n');
console.log(cases.length + ' cases -> ' + path.relative(root, output));
console.log(called.length + ' cases -> ' + path.relative(root, calledOutput));
