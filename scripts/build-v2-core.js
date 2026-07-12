#!/usr/bin/env node
'use strict';

var fs = require('fs');
var path = require('path');
var childProcess = require('child_process');

var root = path.join(__dirname, '..');
var outDir = path.join(root, '.tmp', 'v2-core');
var tsconfigPath = path.join(root, 'tsconfig.v2.build.json');

fs.rmSync(outDir, { recursive: true, force: true });

var tscPath = require.resolve('typescript/bin/tsc');
var result = childProcess.spawnSync(
    process.execPath,
    [tscPath, '-p', tsconfigPath],
    {
        cwd: root,
        stdio: 'inherit',
        env: process.env
    }
);

if (result.error) {
    console.error(result.error);
    process.exit(1);
}

process.exit(result.status === null ? 1 : result.status);
