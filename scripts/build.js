#!/usr/bin/env node
'use strict';

// Bundles the extension host entry, the formatter runtime it loads and the worker into dist/.

var esbuild = require('esbuild');
var fs = require('fs');
var path = require('path');

var root = path.join(__dirname, '..');
var dist = path.join(root, 'dist');
var entries = {
    'extension.cjs': 'src/extension.ts',
    'runtime.cjs': 'src/runtime/internal.ts',
    'formatter-worker.cjs': 'src/adapters/executor/worker-entry.ts'
};

fs.rmSync(dist, { recursive: true, force: true });
Object.keys(entries).forEach(function(name) {
    esbuild.buildSync({
        entryPoints: [path.join(root, entries[name])],
        outfile: path.join(dist, name),
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node20',
        external: ['vscode'],
        legalComments: 'none',
        logLevel: 'warning'
    });
});
console.log('built dist/' + Object.keys(entries).join(', dist/'));
