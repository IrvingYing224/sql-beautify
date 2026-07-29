'use strict';

var assert = require('assert');
var childProcess = require('child_process');
var crypto = require('crypto');
var fs = require('fs');
var path = require('path');
var buildUtils = require('../../../scripts/build-v2-utils');
var gates = require('./performance-gates');

var root = path.join(__dirname, '..', '..', '..');

function runGit(args, encoding, label) {
    var result = childProcess.spawnSync('git', args, {
        cwd: root,
        encoding: encoding === null ? null : 'utf8',
        maxBuffer: 32 * 1024 * 1024,
        timeout: 30000
    });
    if (result.error || result.status !== 0) {
        throw new Error(label + ' failed; relative performance requires full git history' +
            (result.stderr ? ':\n' + String(result.stderr) : ''));
    }
    return result.stdout;
}

function validateRelease() {
    var release = gates.manifest.release;
    runGit(['cat-file', '-e', release.commit + '^{commit}'], 'utf8',
        'release baseline lookup');
    runGit(['merge-base', '--is-ancestor', release.commit, 'HEAD'], 'utf8',
        'release baseline ancestry check');
    var packageJson = JSON.parse(runGit(
        ['show', release.commit + ':package.json'],
        'utf8',
        'release baseline package metadata'
    ));
    assert.strictEqual(packageJson.version, release.version,
        'performance manifest version must match its git commit');
}

function cacheIdentity() {
    return crypto.createHash('sha256').update(JSON.stringify({
        schemaVersion: gates.manifest.compiler.cacheSchemaVersion,
        release: gates.manifest.release,
        typescript: require('typescript/package.json').version,
        vscodeTypes: require('@types/vscode/package.json').version,
        compilerContractSha256: crypto.createHash('sha256')
            .update(fs.readFileSync(__filename))
            .digest('hex')
    })).digest('hex');
}

function materializeRelease(targetRoot) {
    var commit = gates.manifest.release.commit;
    var names = runGit([
        'ls-tree', '-r', '-z', '--name-only', commit
    ], null, 'release baseline source listing').toString('utf8')
        .split('\0')
        .filter(function(relativePath) {
            return relativePath.indexOf('src/') === 0 ||
                relativePath === 'tsconfig.v2.json' ||
                relativePath === 'tsconfig.v2.build.json';
        });
    assert.ok(names.indexOf('src/core/api/format.ts') >= 0,
        'release baseline must contain the format kernel');
    names.forEach(function(relativePath) {
        var destination = path.join(targetRoot, relativePath);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, runGit(
            ['show', commit + ':' + relativePath],
            null,
            'release baseline file ' + relativePath
        ));
    });
}

function compileRelease(sourceRoot, outputRoot) {
    var result = childProcess.spawnSync(process.execPath, [
        require.resolve('typescript/bin/tsc'),
        '-p', path.join(sourceRoot, 'tsconfig.v2.build.json'),
        '--outDir', outputRoot,
        '--typeRoots', path.join(root, 'node_modules', '@types')
    ], {
        cwd: sourceRoot,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
        timeout: 120000,
        env: process.env
    });
    assert.strictEqual(result.status, 0,
        'isolated release baseline compile failed:\n' +
            String(result.stdout || '') + '\n' + String(result.stderr || '') +
            '\nerror=' + String(result.error || 'none'));
}

function isComplete(cacheDir, identity) {
    var stamp = buildUtils.readJson(path.join(cacheDir, '.baseline-stamp.json'));
    return stamp !== null &&
        stamp.schemaVersion === 1 &&
        stamp.cacheIdentity === identity &&
        fs.existsSync(path.join(cacheDir, 'v2-core', 'core', 'api', 'format.js')) &&
        fs.existsSync(path.join(cacheDir, 'v2-core', 'core', 'syntax', 'parser.js'));
}

function prepareReleaseBaseline(options) {
    validateRelease();
    var settings = options || {};
    var identity = cacheIdentity();
    var cacheRoot = settings.cacheRoot ||
        process.env.SQL_BEAUTIFY_PERF_BASELINE_CACHE ||
        path.join(root, '.tmp', 'perf-baselines');
    var cacheDir = path.join(cacheRoot, identity);
    var previousDir = cacheDir + '.previous';
    var lock = buildUtils.acquireProjectLock(
        path.join(cacheRoot, 'locks', identity + '.lock'),
        'release performance baseline build'
    );
    var staging = path.join(cacheRoot, 'staging-' + buildUtils.token());
    try {
        buildUtils.recoverDirectorySwap(cacheDir, previousDir);
        if (isComplete(cacheDir, identity)) {
            return Object.freeze({
                cacheHit: true,
                cacheIdentity: identity,
                cacheDir: cacheDir,
                coreRoot: path.join(cacheDir, 'v2-core')
            });
        }
        var sourceRoot = path.join(staging, 'source');
        var outputRoot = path.join(staging, 'published', 'v2-core');
        fs.mkdirSync(sourceRoot, { recursive: true });
        materializeRelease(sourceRoot);
        compileRelease(sourceRoot, outputRoot);
        buildUtils.writeJsonAtomic(
            path.join(staging, 'published', '.baseline-stamp.json'),
            {
                schemaVersion: 1,
                cacheIdentity: identity,
                release: gates.manifest.release,
                typescriptVersion: require('typescript/package.json').version
            }
        );
        fs.rmSync(sourceRoot, { recursive: true, force: true });
        buildUtils.publishDirectory(
            path.join(staging, 'published'),
            cacheDir,
            previousDir
        );
        return Object.freeze({
            cacheHit: false,
            cacheIdentity: identity,
            cacheDir: cacheDir,
            coreRoot: path.join(cacheDir, 'v2-core')
        });
    } finally {
        fs.rmSync(staging, { recursive: true, force: true });
        lock.release();
    }
}

module.exports = Object.freeze({
    prepareReleaseBaseline: prepareReleaseBaseline
});
