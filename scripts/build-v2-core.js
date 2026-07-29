#!/usr/bin/env node
'use strict';

var childProcess = require('child_process');
var fs = require('fs');
var path = require('path');
var utils = require('./build-v2-utils');

var root = path.join(__dirname, '..');
var temporaryRoot = path.join(root, '.tmp');
var outDir = path.join(temporaryRoot, 'v2-core');
var previousDir = path.join(temporaryRoot, 'v2-core.previous');
var lockPath = path.join(temporaryRoot, 'locks', 'build-v2-core.lock');
var tsconfigPath = path.join(root, 'tsconfig.v2.build.json');
var stampName = '.build-stamp.json';
var expectedOutput = path.join('core', 'api', 'format.js');

function sourceHash() {
    return utils.contentHash(root, [
        'src',
        'tsconfig.v2.json',
        'tsconfig.v2.build.json',
        'scripts/build-v2-core.js',
        'scripts/build-v2-utils.js'
    ], {
        schemaVersion: 1,
        typescript: require('typescript/package.json').version,
        vscodeTypes: require('@types/vscode/package.json').version
    });
}

function isReusable(hash) {
    var stamp = utils.readJson(path.join(outDir, stampName));
    return process.env.SQL_BEAUTIFY_BUILD_FORCE !== '1' &&
        stamp !== null &&
        stamp.schemaVersion === 1 &&
        stamp.sourceHash === hash &&
        fs.existsSync(path.join(outDir, expectedOutput));
}

function compile(stagingDir) {
    var tscPath = require.resolve('typescript/bin/tsc');
    var result = childProcess.spawnSync(
        process.execPath,
        [tscPath, '-p', tsconfigPath, '--outDir', stagingDir],
        {
            cwd: root,
            stdio: 'inherit',
            env: process.env
        }
    );
    if (result.error) {
        throw result.error;
    }
    if (result.status !== 0) {
        throw new Error('TypeScript compiler exited with status ' + String(result.status));
    }
}

function main() {
    var lock = utils.acquireProjectLock(lockPath, 'build:v2-core');
    var stagingDir = path.join(temporaryRoot, 'v2-core.staging-' + utils.token());
    try {
        utils.recoverDirectorySwap(outDir, previousDir);
        utils.testHoldMilliseconds('SQL_BEAUTIFY_BUILD_TEST_HOLD_MS');
        var hash = sourceHash();
        if (isReusable(hash)) {
            console.log('Reused cached v2 core build ' + hash.slice(0, 12));
            return;
        }
        fs.mkdirSync(stagingDir, { recursive: true });
        if (process.env.SQL_BEAUTIFY_BUILD_TEST_FAIL === 'core-before-compile') {
            throw new Error('Injected core build failure before compile');
        }
        compile(stagingDir);
        if (!fs.existsSync(path.join(stagingDir, expectedOutput))) {
            throw new Error('TypeScript build did not produce ' + expectedOutput);
        }
        utils.writeJsonAtomic(path.join(stagingDir, stampName), {
            schemaVersion: 1,
            sourceHash: hash,
            typescriptVersion: require('typescript/package.json').version
        });
        if (process.env.SQL_BEAUTIFY_BUILD_TEST_FAIL === 'core-before-publish') {
            throw new Error('Injected core build failure before publish');
        }
        utils.publishDirectory(stagingDir, outDir, previousDir);
        console.log('Built v2 core atomically ' + hash.slice(0, 12));
    } catch (error) {
        var state = fs.existsSync(path.join(outDir, expectedOutput))
            ? 'previous .tmp/v2-core was preserved'
            : 'no previous .tmp/v2-core was available';
        console.error('build:v2-core failed; ' + state);
        throw error;
    } finally {
        fs.rmSync(stagingDir, { recursive: true, force: true });
        lock.release();
    }
}

try {
    main();
} catch (error) {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
}
