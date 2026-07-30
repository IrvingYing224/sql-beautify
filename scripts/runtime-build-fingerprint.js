#!/usr/bin/env node
'use strict';

var path = require('path');
var utils = require('./build-v2-utils');

function esbuildVersion() {
    return require('esbuild/package.json').version;
}

function runtimeSourceHash(root, debugSourceMaps) {
    if (typeof root !== 'string' || !path.isAbsolute(root) ||
        typeof debugSourceMaps !== 'boolean') {
        throw new TypeError('Runtime build fingerprint inputs are invalid');
    }
    return utils.contentHash(root, [
        'src',
        'scripts/build-v2-runtime.js',
        'scripts/build-v2-utils.js',
        'scripts/package-manifest.js',
        'scripts/runtime-build-fingerprint.js',
        'package.json'
    ], {
        schemaVersion: 2,
        esbuild: esbuildVersion(),
        debugSourceMaps: debugSourceMaps
    });
}

module.exports = Object.freeze({
    esbuildVersion: esbuildVersion,
    runtimeSourceHash: runtimeSourceHash
});
