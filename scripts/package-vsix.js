#!/usr/bin/env node
'use strict';

var childProcess = require('child_process');
var path = require('path');
var manifestApi = require('./package-manifest');
var packageTools = require('./package-tools');

var root = path.join(__dirname, '..');

function packagePlan() {
    var manifest = manifestApi.loadPackageManifest(root);
    var artifact = path.join(root, 'vscode-sql-beautify-v' + manifest.packageJson.version + '.vsix');
    return [
        [path.join(__dirname, 'build-v2-runtime.js')],
        [packageTools.vsceCliPath(), 'package', '--no-dependencies', '--out', artifact],
        [path.join(__dirname, 'verify-release-artifact.js'), '--artifact', artifact, '--compare-build']
    ];
}

function packageVsix() {
    packageTools.requireArchiveTools(['unzip']);
    packagePlan().forEach(function(args) {
        childProcess.execFileSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
    });
}

if (require.main === module) {
    try {
        packageVsix();
    } catch (error) {
        console.error(error && error.stack ? error.stack : error);
        process.exitCode = 1;
    }
}

module.exports = Object.freeze({ packagePlan: packagePlan, packageVsix: packageVsix });
