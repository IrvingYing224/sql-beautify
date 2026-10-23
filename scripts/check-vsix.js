#!/usr/bin/env node
'use strict';

// Checks that the VSIX holds exactly the files the extension needs, as `vsce ls` lists them.

var assert = require('assert');
var childProcess = require('child_process');
var fs = require('fs');
var path = require('path');

var EXPECTED = [
    'CHANGELOG.md',
    'LICENSE.txt',
    'README.md',
    'dist/extension.cjs',
    'dist/worker.cjs',
    'images/icon.png',
    'package.json'
];

var root = path.join(__dirname, '..');
var vsceDir = path.join(root, 'node_modules', '@vscode', 'vsce');
var vsce = path.join(vsceDir, JSON.parse(fs.readFileSync(path.join(vsceDir, 'package.json'), 'utf8')).bin.vsce);
var listed = childProcess.execFileSync(process.execPath, [vsce, 'ls', '--no-dependencies'], {
    cwd: root,
    encoding: 'utf8'
}).split('\n').map(function(line) { return line.trim(); }).filter(Boolean).sort();
assert.deepStrictEqual(listed, EXPECTED, 'VSIX file list');
console.log('VSIX file list ok (' + listed.length + ' files)');
