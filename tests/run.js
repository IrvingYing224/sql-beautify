#!/usr/bin/env node
'use strict';

// `npm test`: the golden runner, then each unit test. Expects dist/ from `npm run build`.

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
console.log((failed.length === 0 ? 'all passed' : failed.length + ' failed: ' + failed.join(', ')) +
    ' (' + ((Date.now() - started) / 1000).toFixed(1) + ' s)');
process.exitCode = failed.length === 0 ? 0 : 1;
