#!/usr/bin/env node
'use strict';

var childProcess = require('child_process');
var fs = require('fs');
var path = require('path');

function npmCliPath() {
    var nodeDirectory = path.dirname(fs.realpathSync(process.execPath));
    var candidates = [
        process.env.npm_execpath,
        path.join(nodeDirectory, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
        path.join(nodeDirectory, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
        path.join(nodeDirectory, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js')
    ];
    for (var index = 0; index < candidates.length; index++) {
        var candidate = candidates[index];
        if (typeof candidate === 'string' && path.basename(candidate) === 'npm-cli.js' &&
            fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
            return path.resolve(candidate);
        }
    }
    throw new Error('npm CLI was not found beside Node.js. Run this command through npm run, ' +
        'or install a Node.js distribution that includes npm.');
}

function vsceCliPath() {
    var packagePath = require.resolve('@vscode/vsce/package.json');
    var metadata = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    return path.resolve(path.dirname(packagePath), metadata.bin.vsce);
}

var checkedArchiveTools = new Set();

function requireArchiveTools(names) {
    names.forEach(function(name) {
        if (name !== 'zip' && name !== 'unzip') {
            throw new Error('Unsupported archive prerequisite');
        }
        if (checkedArchiveTools.has(name)) {
            return;
        }
        var result = childProcess.spawnSync(name, ['-v'], {
            encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024
        });
        if (result.error || result.status !== 0) {
            throw new Error('Required archive tool "' + name + '" is unavailable. ' +
                'Install an Info-ZIP compatible ' + name + ' executable on PATH before packaging ' +
                'or running release-boundary checks.');
        }
        checkedArchiveTools.add(name);
    });
}

module.exports = Object.freeze({
    npmCliPath: npmCliPath,
    vsceCliPath: vsceCliPath,
    requireArchiveTools: requireArchiveTools
});
