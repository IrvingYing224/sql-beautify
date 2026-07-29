#!/usr/bin/env node
'use strict';

var assert = require('assert');
var fs = require('fs');
var path = require('path');

var RUNTIME_FILES = Object.freeze([
    'dist/extension.cjs',
    'dist/runtime.cjs',
    'dist/sql-formatter.cjs',
    'dist/hive-ddl.cjs',
    'dist/formatter-worker.cjs'
]);
var STATIC_FILES = Object.freeze([
    'images/icon.png',
    'README.md',
    'CHANGELOG.md',
    'LICENSE.txt'
]);
var PACKAGE_FILES = Object.freeze(RUNTIME_FILES.concat(STATIC_FILES));
var OBSOLETE_RUNTIME_FILES = Object.freeze([
    'dist/v2-core.cjs',
    'dist/v2-ddl.cjs',
    'dist/v2-worker.cjs',
    'dist/v2-format-bridge.cjs'
]);

function normalized(value) {
    return value.slice().sort();
}

function loadPackageManifest(root) {
    var packageJson = JSON.parse(fs.readFileSync(
        path.join(root, 'package.json'),
        'utf8'
    ));
    assert.deepStrictEqual(
        packageJson.files,
        PACKAGE_FILES,
        'package.json files must match the shared production allowlist'
    );
    assert.strictEqual(packageJson.main, './dist/extension.cjs');
    assert.deepStrictEqual(packageJson.exports, {
        './formatter': './dist/sql-formatter.cjs',
        './experimental/ddl': './dist/hive-ddl.cjs',
        './package.json': './package.json'
    });
    var imageFiles = STATIC_FILES.filter(function(fileName) {
        return fileName.indexOf('images/') === 0;
    });
    assert.deepStrictEqual(
        fs.readdirSync(path.join(root, 'images')).sort(),
        imageFiles.map(function(fileName) {
            return path.basename(fileName);
        }).sort(),
        'images must contain only shared-manifest production assets'
    );
    var npmFiles = normalized(PACKAGE_FILES.concat(['package.json']));
    var vsixEntries = normalized([
        '[Content_Types].xml',
        'extension.vsixmanifest',
        'extension/package.json'
    ].concat(PACKAGE_FILES.map(function(fileName) {
        var normalizedName = fileName === 'README.md'
            ? 'README.md'
            : fileName === 'CHANGELOG.md'
                ? 'CHANGELOG.md'
                : fileName;
        return 'extension/' + normalizedName;
    })));
    return Object.freeze({
        packageJson: packageJson,
        packageFiles: PACKAGE_FILES,
        npmFiles: Object.freeze(npmFiles),
        runtimeFiles: RUNTIME_FILES,
        runtimeFileNames: Object.freeze(RUNTIME_FILES.map(function(fileName) {
            return path.basename(fileName);
        })),
        imageFiles: Object.freeze(imageFiles),
        staticFiles: STATIC_FILES,
        obsoleteRuntimeFiles: OBSOLETE_RUNTIME_FILES,
        vsixEntries: Object.freeze(vsixEntries)
    });
}

module.exports = Object.freeze({
    loadPackageManifest: loadPackageManifest
});
