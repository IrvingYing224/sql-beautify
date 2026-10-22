#!/usr/bin/env node
'use strict';

// P1 one-off (deleted with the old tests in P2): reruns every old test file of the `verify` plan
// with recapture-hook.js preloaded and writes the asserted calls, with their execution
// environment, to tests/golden/seeds/recapture-2026-10.json. Needs fresh .tmp/v2-core and dist.

var childProcess = require('child_process');
var fs = require('fs');
var os = require('os');
var path = require('path');

var root = path.join(__dirname, '..', '..', '..');
var hook = path.join(__dirname, 'recapture-hook.js');
var output = path.join(__dirname, '..', 'seeds', 'recapture-2026-10.json');
var plan = require(path.join(root, 'scripts', 'v2-suite-manifest.js')).buildPlan('verify');
var scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'golden-recapture-'));
var ENV_FIELDS = ['mode', 'newline', 'tabSize', 'startColumn'];

var cases = [];
var seen = new Set();
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
    JSON.parse(fs.readFileSync(file, 'utf8')).forEach(function(entry) {
        // The adapter only ever passes tab sizes 1..256; out-of-range values are API misuse tests.
        if (entry.tabSize !== undefined && !(entry.tabSize >= 1 && entry.tabSize <= 256)) {
            return;
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
        var key = JSON.stringify([seed.op, seed.options, seed.mode, seed.newline, seed.tabSize,
            seed.startColumn, seed.source]);
        if (!seen.has(key)) {
            seen.add(key);
            cases.push(seed);
        }
    });
});
fs.rmSync(scratch, { recursive: true, force: true });
fs.writeFileSync(output, JSON.stringify({
    description: 'Asserted formatter and DDL calls of the old tests, with explicitly passed execution ' +
        'environment (an omitted field means the adapter default or inference). Input-only.',
    count: cases.length,
    cases: cases,
}, null, 1) + '\n');
console.log(cases.length + ' cases -> ' + path.relative(root, output));
