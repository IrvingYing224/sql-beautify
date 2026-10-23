#!/usr/bin/env node
'use strict';

// `npm test`: the golden runner, the unit tests, then the old tests in tests/v2 until P4a deletes them.
// The old tests load tsc output from .tmp/v2-core: several inject faults by assigning module
// exports, which esbuild's getter-only exports reject. Expects dist/ from `npm run build`.

var childProcess = require('child_process');
var fs = require('fs');
var path = require('path');

var root = path.join(__dirname, '..');
var started = Date.now();
var failed = [];

function step(label, args, showOutput) {
    var begin = Date.now();
    var result = childProcess.spawnSync(process.execPath, args, {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 1 << 28
    });
    var ok = result.status === 0;
    if (showOutput || !ok) {
        process.stdout.write(result.stdout + result.stderr);
    }
    console.log((ok ? 'ok   ' : 'FAIL ') + String(Date.now() - begin).padStart(6) + ' ms  ' + label);
    if (!ok) {
        failed.push(label);
    }
    return ok;
}

step('tests/golden/run.js', ['tests/golden/run.js'], true);
fs.readdirSync(path.join(root, 'tests', 'unit')).filter(function(name) {
    return name.endsWith('.test.js');
}).sort().forEach(function(name) {
    step('tests/unit/' + name, [path.join('tests', 'unit', name)]);
});
fs.rmSync(path.join(root, '.tmp', 'v2-core'), { recursive: true, force: true });
if (step('tsc -> .tmp/v2-core', [require.resolve('typescript/bin/tsc'), '-p', 'tests/v2/tsconfig.core.json'])) {
    fs.readdirSync(path.join(root, 'tests', 'v2')).filter(function(name) {
        return name.endsWith('.test.js');
    }).sort().forEach(function(name) {
        step('tests/v2/' + name, [path.join('tests', 'v2', name)]);
    });
}
console.log((failed.length === 0 ? 'all passed' : failed.length + ' failed: ' + failed.join(', ')) +
    ' (' + ((Date.now() - started) / 1000).toFixed(1) + ' s)');
process.exitCode = failed.length === 0 ? 0 : 1;
