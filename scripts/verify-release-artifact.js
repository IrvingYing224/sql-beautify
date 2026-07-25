#!/usr/bin/env node
'use strict';

var assert = require('assert');
var childProcess = require('child_process');
var fs = require('fs');
var path = require('path');

var runtimeFiles = [
    'dist/extension.cjs',
    'dist/formatter-worker.cjs',
    'dist/hive-ddl.cjs',
    'dist/runtime.cjs',
    'dist/sql-formatter.cjs'
];

function argumentValue(args, name) {
    var index = args.indexOf(name);
    if (index < 0 || index + 1 >= args.length) {
        throw new Error('Missing required argument: ' + name);
    }
    return args[index + 1];
}

function hasArgument(args, name) {
    return args.indexOf(name) >= 0;
}

function unzipText(artifactPath, entry) {
    return childProcess.execFileSync('unzip', ['-p', artifactPath, entry], {
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024
    });
}

function unzipBuffer(artifactPath, entry) {
    return childProcess.execFileSync('unzip', ['-p', artifactPath, entry], {
        encoding: null,
        maxBuffer: 16 * 1024 * 1024
    });
}

function listEntries(artifactPath) {
    return childProcess.execFileSync('unzip', ['-Z1', artifactPath], {
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024
    }).trim().split('\n').filter(Boolean);
}

function verifyArtifact(artifactPath, options) {
    var settings = options || {};
    var root = settings.root || path.join(__dirname, '..');
    var compareBuild = settings.compareBuild === true;
    var packageJson = require(path.join(root, 'package.json'));
    var packageLock = require(path.join(root, 'package-lock.json'));
    var expectedName = 'vscode-sql-beautify-v' + packageJson.version + '.vsix';
    assert.strictEqual(path.basename(artifactPath), expectedName,
        'VSIX filename must match package version');
    assert.strictEqual(packageLock.version, packageJson.version,
        'package lock version must match package version');
    assert.strictEqual(packageLock.packages[''].version, packageJson.version,
        'package lock root version must match package version');
    assert.ok(fs.statSync(artifactPath).isFile(), 'VSIX artifact must be a regular file');

    var entries = listEntries(artifactPath);
    var entrySet = new Set(entries);
    var imageEntries = fs.readdirSync(path.join(root, 'images')).sort().map(function(fileName) {
        return 'extension/images/' + fileName;
    });
    var expectedEntries = [
        '[Content_Types].xml',
        'extension.vsixmanifest',
        'extension/CHANGELOG.md',
        'extension/LICENSE.txt',
        'extension/README.md',
        'extension/package.json'
    ].concat(runtimeFiles.map(function(fileName) {
        return 'extension/' + fileName;
    }), imageEntries).sort();
    var normalizedEntries = entries.map(function(entry) {
        if (entry === 'extension/changelog.md') {
            return 'extension/CHANGELOG.md';
        }
        if (entry === 'extension/readme.md') {
            return 'extension/README.md';
        }
        return entry;
    }).sort();
    assert.deepStrictEqual(normalizedEntries, expectedEntries,
        'VSIX must contain the exact production allowlist');
    runtimeFiles.forEach(function(fileName) {
        assert.ok(entrySet.has('extension/' + fileName),
            'VSIX is missing runtime artifact: ' + fileName);
        if (compareBuild) {
            assert.ok(
                unzipBuffer(artifactPath, 'extension/' + fileName).equals(
                    fs.readFileSync(path.join(root, fileName))
                ),
                'VSIX runtime artifact differs from the current build: ' + fileName
            );
        }
    });
    entries.forEach(function(entry) {
        assert.ok(!/^extension\/(?:src|tests|scripts|docs|lib|node_modules|\.tmp|\.superpowers)(?:\/|$)/.test(entry),
            'VSIX contains forbidden development path: ' + entry);
        assert.notStrictEqual(entry, 'extension/extension.js');
        assert.notStrictEqual(entry, 'extension/vkbeautify.js');
    });

    var packedManifest = JSON.parse(unzipText(
        artifactPath,
        'extension/package.json'
    ));
    assert.strictEqual(packedManifest.version, packageJson.version,
        'packed package version must match source package');
    assert.strictEqual(packedManifest.main, packageJson.main,
        'packed extension entry must match source package');
    assert.deepStrictEqual(packedManifest.exports, packageJson.exports,
        'packed public exports must match source package');
    var migrationVersion = packageJson.version.split('.').slice(0, 2).join('.');
    assert.match(
        unzipText(artifactPath, 'extension/readme.md'),
        new RegExp('/blob/v' + packageJson.version.replace(/\./g, '\\.') +
            '/docs/migration-to-' + migrationVersion.replace(/\./g, '\\.') + '\\.md'),
        'packed README migration link must be pinned to the package version'
    );

    var vsixManifest = unzipText(artifactPath, 'extension.vsixmanifest');
    var identity = /<Identity\b[^>]*\bVersion="([^"]+)"[^>]*\/>/.exec(vsixManifest);
    assert.ok(identity, 'VSIX manifest must contain an Identity version');
    assert.strictEqual(identity[1], packageJson.version,
        'VSIX manifest version must match package version');

    return Object.freeze({
        artifact: path.resolve(artifactPath),
        entryCount: entries.length,
        version: packageJson.version
    });
}

function run(args) {
    var artifact = argumentValue(args, '--artifact');
    var result = verifyArtifact(path.resolve(process.cwd(), artifact), {
        compareBuild: hasArgument(args, '--compare-build')
    });
    console.log('Verified release artifact ' + path.basename(result.artifact) +
        ' (' + result.entryCount + ' entries, version ' + result.version + ')');
}

if (require.main === module) {
    try {
        run(process.argv.slice(2));
    } catch (error) {
        console.error(error && error.stack ? error.stack : error);
        process.exitCode = 1;
    }
}

module.exports = Object.freeze({ verifyArtifact: verifyArtifact });
