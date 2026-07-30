#!/usr/bin/env node
'use strict';

var esbuild = require('esbuild');
var fs = require('fs');
var path = require('path');
var manifestApi = require('./package-manifest');
var utils = require('./build-v2-utils');

var root = path.join(__dirname, '..');
var temporaryRoot = path.join(root, '.tmp');
var outDir = path.join(root, 'dist');
var previousDir = path.join(temporaryRoot, 'v2-runtime.previous');
var lockPath = path.join(temporaryRoot, 'locks', 'build-v2-runtime.lock');
var stampPath = path.join(temporaryRoot, 'v2-runtime-build-stamp.json');
var entries = Object.freeze({
    'runtime.cjs': path.join(root, 'src', 'runtime', 'internal.ts'),
    'sql-formatter.cjs': path.join(root, 'src', 'runtime', 'index.ts'),
    'hive-ddl.cjs': path.join(root, 'src', 'runtime', 'experimental-ddl.ts'),
    'formatter-worker.cjs': path.join(root, 'src', 'adapters', 'executor', 'worker-entry.ts'),
    'extension.cjs': path.join(root, 'src', 'extension.ts')
});

function debugSourceMapsEnabled() {
    return process.env.SQL_BEAUTIFY_DEBUG_SOURCEMAP === '1';
}

function sourceHash(debugSourceMaps) {
    return utils.contentHash(root, [
        'src',
        'scripts/build-v2-runtime.js',
        'scripts/build-v2-utils.js',
        'scripts/package-manifest.js',
        'package.json'
    ], {
        schemaVersion: 2,
        esbuild: require('esbuild/package.json').version,
        debugSourceMaps: debugSourceMaps
    });
}

function expectedNames(debugSourceMaps) {
    var names = Object.keys(entries);
    return debugSourceMaps
        ? names.concat(names.map(function(fileName) { return fileName + '.map'; }))
        : names;
}

function validateGeneratedDirectory(directory, debugSourceMaps) {
    var allowed = new Set(expectedNames(debugSourceMaps));
    var actual = fs.readdirSync(directory).sort();
    actual.forEach(function(fileName) {
        if (!allowed.has(fileName)) {
            throw new Error('Runtime staging contains an unexpected file: ' + fileName);
        }
    });
    Object.keys(entries).forEach(function(fileName) {
        var artifact = path.join(directory, fileName);
        if (!fs.existsSync(artifact) || !fs.statSync(artifact).isFile()) {
            throw new Error('Runtime build did not produce ' + fileName);
        }
    });
}

function validateExistingDist(manifest) {
    if (!fs.existsSync(outDir)) {
        return;
    }
    var allowed = new Set(
        manifest.runtimeFileNames.concat(
            manifest.runtimeFileNames.map(function(fileName) {
                return fileName + '.map';
            }),
            manifest.obsoleteRuntimeFiles.map(function(fileName) {
                return path.basename(fileName);
            })
        )
    );
    fs.readdirSync(outDir).forEach(function(fileName) {
        if (!allowed.has(fileName)) {
            throw new Error(
                'Refusing to replace dist because it contains an unknown file: ' + fileName
            );
        }
    });
}

function sharedRuntimePlugin() {
    return {
        name: 'wave5-shared-runtime',
        setup: function(build) {
            build.onResolve({ filter: /^\.\/internal$/ }, function() {
                return { path: './runtime.cjs', external: true };
            });
        }
    };
}

async function build(entryPoint, outfile, extra, debugSourceMaps) {
    await esbuild.build(Object.assign({
        entryPoints: [entryPoint],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node20',
        outfile: outfile,
        sourcemap: debugSourceMaps ? 'external' : false,
        minify: false,
        legalComments: 'none',
        logLevel: 'warning'
    }, extra || {}));
}

function isReusable(hash, debugSourceMaps) {
    var stamp = utils.readJson(stampPath);
    if (process.env.SQL_BEAUTIFY_BUILD_FORCE === '1' ||
        stamp === null ||
        stamp.schemaVersion !== 2 ||
        stamp.sourceHash !== hash ||
        stamp.debugSourceMaps !== debugSourceMaps ||
        !fs.existsSync(outDir)) {
        return false;
    }
    try {
        validateGeneratedDirectory(outDir, debugSourceMaps);
        return utils.validateOutputManifest(outDir, stamp.outputManifest);
    } catch {
        return false;
    }
}

async function main() {
    var manifest = manifestApi.loadPackageManifest(root);
    var lock = utils.acquireProjectLock(lockPath, 'build:v2-runtime');
    var stagingRoot = path.join(temporaryRoot, 'v2-runtime.staging-' + utils.token());
    var stagingDist = path.join(stagingRoot, 'dist');
    var debugSourceMaps = debugSourceMapsEnabled();
    try {
        utils.recoverDirectorySwap(outDir, previousDir);
        utils.testHoldMilliseconds('SQL_BEAUTIFY_RUNTIME_BUILD_TEST_HOLD_MS');
        var hash = sourceHash(debugSourceMaps);
        if (isReusable(hash, debugSourceMaps)) {
            console.log('Reused cached v2 runtime build ' + hash.slice(0, 12));
            return;
        }
        validateExistingDist(manifest);
        fs.mkdirSync(stagingDist, { recursive: true });
        if (process.env.SQL_BEAUTIFY_BUILD_TEST_FAIL === 'runtime-before-build') {
            throw new Error('Injected runtime build failure before bundle build');
        }
        await build(entries['runtime.cjs'], path.join(stagingDist, 'runtime.cjs'), null,
            debugSourceMaps);
        await build(entries['sql-formatter.cjs'], path.join(stagingDist, 'sql-formatter.cjs'), {
            plugins: [sharedRuntimePlugin()]
        }, debugSourceMaps);
        await build(entries['hive-ddl.cjs'], path.join(stagingDist, 'hive-ddl.cjs'), {
            plugins: [sharedRuntimePlugin()]
        }, debugSourceMaps);
        await build(entries['formatter-worker.cjs'], path.join(stagingDist, 'formatter-worker.cjs'),
            null, debugSourceMaps);
        await build(entries['extension.cjs'], path.join(stagingDist, 'extension.cjs'), {
            external: ['vscode']
        }, debugSourceMaps);
        validateGeneratedDirectory(stagingDist, debugSourceMaps);
        var outputManifest = utils.outputManifest(stagingDist);
        if (process.env.SQL_BEAUTIFY_BUILD_TEST_FAIL === 'runtime-before-publish') {
            throw new Error('Injected runtime build failure before publish');
        }
        if (process.env.SQL_BEAUTIFY_BUILD_TEST_FAIL === 'runtime-before-stamp') {
            throw new Error('Injected runtime build failure before trusted stamp');
        }
        utils.writeJsonAtomic(stampPath, {
            schemaVersion: 2,
            sourceHash: hash,
            esbuildVersion: require('esbuild/package.json').version,
            debugSourceMaps: debugSourceMaps,
            outputManifest: outputManifest
        });
        utils.publishDirectory(stagingDist, outDir, previousDir);
        console.log('Built v2 runtime artifacts atomically' +
            (debugSourceMaps ? ' with external debug source maps' : '') + ': ' +
            manifest.runtimeFiles.join(', '));
    } catch (error) {
        var state = fs.existsSync(outDir)
            ? 'previous dist was preserved'
            : 'no previous dist was available';
        console.error('build:v2-runtime failed; ' + state);
        throw error;
    } finally {
        fs.rmSync(stagingRoot, { recursive: true, force: true });
        lock.release();
    }
}

main().catch(function(error) {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
});
