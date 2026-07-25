#!/usr/bin/env node
'use strict';

var assert = require('assert');
var childProcess = require('child_process');
var fs = require('fs');
var os = require('os');
var path = require('path');

var root = path.join(__dirname, '..');
var excludedNames = new Set(['.git', '.tmp', 'dist', 'node_modules']);

function copySource(sourceRoot, targetRoot) {
    fs.cpSync(sourceRoot, targetRoot, {
        recursive: true,
        filter: function(source) {
            var relative = path.relative(sourceRoot, source);
            if (relative === '') {
                return true;
            }
            var segments = relative.split(path.sep);
            if (segments.some(function(segment) { return excludedNames.has(segment); })) {
                return false;
            }
            return !/\.vsix$|\.tgz$/.test(relative);
        }
    });
}

function run(command, args, options) {
    return childProcess.execFileSync(command, args, Object.assign({
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024
    }, options || {}));
}

function expectedPackageFiles(sourceRoot) {
    var imageFiles = fs.readdirSync(path.join(sourceRoot, 'images')).sort().map(function(fileName) {
        return 'images/' + fileName;
    });
    return [
        'CHANGELOG.md',
        'LICENSE.txt',
        'README.md',
        'dist/extension.cjs',
        'dist/formatter-worker.cjs',
        'dist/hive-ddl.cjs',
        'dist/runtime.cjs',
        'dist/sql-formatter.cjs'
    ].concat(imageFiles, ['package.json']).sort();
}

function verifyInstalledConsumer(consumerRoot) {
    var probe = [
        "const formatter = require('vscode-sql-beautify/formatter');",
        "const ddl = require('vscode-sql-beautify/experimental/ddl');",
        "if (Object.keys(formatter).sort().join(',') !== 'formatSql,lexSql') throw new Error('formatter exports');",
        "if (Object.keys(ddl).sort().join(',') !== 'extractDdl,formatHiveDdl') throw new Error('ddl exports');",
        "const result = formatter.formatSql('select a from t', { dialect: 'hive' });",
        "if (result.status !== 'formatted' && result.status !== 'unchanged') throw new Error('formatter smoke');",
        "const ddlResult = ddl.formatHiveDdl('CREATE TABLE t (id INT)');",
        "if (ddlResult.status !== 'formatted' && ddlResult.status !== 'unchanged') throw new Error('ddl smoke');"
    ].join('\n');
    run(process.execPath, ['-e', probe], { cwd: consumerRoot });
    var installedManifest = require.resolve('vscode-sql-beautify/package.json', {
        paths: [consumerRoot]
    });
    var installedVersion = require(installedManifest).version;
    var migrationVersion = installedVersion.split('.').slice(0, 2).join('.');
    var installedReadme = fs.readFileSync(
        path.join(path.dirname(installedManifest), 'README.md'),
        'utf8'
    );
    assert.ok(
        installedReadme.indexOf('/blob/v' + installedVersion +
            '/docs/migration-to-' + migrationVersion + '.md') >= 0,
        'installed README migration link must be pinned to the package version'
    );
}

function verifyCleanPackage() {
    var temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sql-beautify-clean-package-'));
    var sourceRoot = path.join(temporaryRoot, 'source');
    var packageOutput = path.join(temporaryRoot, 'package-output');
    var consumerRoot = path.join(temporaryRoot, 'consumer');
    try {
        copySource(root, sourceRoot);
        fs.symlinkSync(path.join(root, 'node_modules'), path.join(sourceRoot, 'node_modules'), 'dir');
        fs.mkdirSync(packageOutput, { recursive: true });
        assert.strictEqual(fs.existsSync(path.join(sourceRoot, 'dist')), false,
            'clean package probe must begin without dist artifacts');

        var packOutput = run('npm', [
            'pack',
            '--json',
            '--silent',
            '--pack-destination',
            packageOutput
        ], { cwd: sourceRoot });
        var jsonStart = packOutput.indexOf('[\n');
        assert.ok(jsonStart >= 0, 'npm pack must emit a JSON result array');
        var packResult = JSON.parse(packOutput.slice(jsonStart))[0];
        var packedFiles = packResult.files.map(function(file) { return file.path; }).sort();
        assert.deepStrictEqual(packedFiles, expectedPackageFiles(sourceRoot),
            'npm package must contain the exact production allowlist');

        var sourcePackage = require(path.join(sourceRoot, 'package.json'));
        var sourceLock = require(path.join(sourceRoot, 'package-lock.json'));
        assert.strictEqual(packResult.version, sourcePackage.version);
        assert.strictEqual(sourceLock.version, sourcePackage.version);
        assert.strictEqual(sourceLock.packages[''].version, sourcePackage.version);

        var tarball = path.join(packageOutput, packResult.filename);
        fs.mkdirSync(consumerRoot, { recursive: true });
        fs.writeFileSync(path.join(consumerRoot, 'package.json'), JSON.stringify({
            private: true
        }), 'utf8');
        run('npm', [
            'install',
            '--ignore-scripts',
            '--no-audit',
            '--no-fund',
            tarball
        ], { cwd: consumerRoot });
        verifyInstalledConsumer(consumerRoot);
        console.log('Clean npm package verified: ' + packResult.filename +
            ' (' + packedFiles.length + ' files)');
    } finally {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
}

if (require.main === module) {
    try {
        verifyCleanPackage();
    } catch (error) {
        console.error(error && error.stack ? error.stack : error);
        process.exitCode = 1;
    }
}

module.exports = Object.freeze({ verifyCleanPackage: verifyCleanPackage });
