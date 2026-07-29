'use strict';

var assert = require('assert');
var childProcess = require('child_process');
var crypto = require('crypto');
var fs = require('fs');
var os = require('os');
var path = require('path');

var root = path.join(__dirname, '..', '..');
var coreArtifact = path.join(root, '.tmp', 'v2-core', 'core', 'api', 'format.js');
var coreStamp = path.join(root, '.tmp', 'v2-core', '.build-stamp.json');
var coreLock = path.join(root, '.tmp', 'locks', 'build-v2-core.lock');
var runtimeFiles = require(path.join(root, 'scripts', 'package-manifest.js'))
    .loadPackageManifest(root).runtimeFiles;

function digest(filePath) {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function runBuild(script, environment) {
    return childProcess.spawnSync(process.execPath, [script], {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
        env: Object.assign({}, process.env, environment || {})
    });
}

function waitForFile(filePath, timeoutMs) {
    var deadline = Date.now() + timeoutMs;
    while (!fs.existsSync(filePath) && Date.now() < deadline) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
    assert.ok(fs.existsSync(filePath), 'timed out waiting for ' + filePath);
}

function childCompletion(child, stdout, stderr) {
    return new Promise(function(resolve, reject) {
        child.stdout.on('data', function(chunk) { stdout.push(chunk); });
        child.stderr.on('data', function(chunk) { stderr.push(chunk); });
        child.on('error', reject);
        child.on('close', function(status, signal) {
            resolve({
                status: status,
                signal: signal,
                stdout: Buffer.concat(stdout).toString('utf8'),
                stderr: Buffer.concat(stderr).toString('utf8')
            });
        });
    });
}

function assertNoStaging(prefix) {
    var temporaryRoot = path.join(root, '.tmp');
    var leftovers = fs.readdirSync(temporaryRoot).filter(function(fileName) {
        return fileName.indexOf(prefix) === 0;
    });
    assert.deepStrictEqual(leftovers, [], prefix + ' staging directories must be cleaned');
}

async function main() {
    var packageJson = require(path.join(root, 'package.json'));
    Object.keys(packageJson.scripts).filter(function(name) {
        return name === 'test:verify' || name.indexOf('test:v2:') === 0;
    }).forEach(function(name) {
        assert.strictEqual(packageJson.scripts[name].indexOf('&&'), -1,
            name + ' must delegate to the declarative runner, not a shell chain');
        assert.match(packageJson.scripts[name], /scripts\/run-v2-suite\.js/,
            name + ' must delegate to the declarative runner');
    });
    var runtimeBuildSource = fs.readFileSync(
        path.join(root, 'scripts', 'build-v2-runtime.js'),
        'utf8'
    );
    assert.match(runtimeBuildSource, /SQL_BEAUTIFY_DEBUG_SOURCEMAP/);
    assert.match(runtimeBuildSource, /sourcemap: debugSourceMaps \? 'external' : false/);

    var coreBefore = digest(coreArtifact);
    var stampBefore = digest(coreStamp);
    var coreCached = runBuild('scripts/build-v2-core.js');
    assert.strictEqual(coreCached.status, 0, coreCached.stderr);
    assert.match(coreCached.stdout, /Reused cached v2 core build/);

    var coreFailure = runBuild('scripts/build-v2-core.js', {
        SQL_BEAUTIFY_BUILD_FORCE: '1',
        SQL_BEAUTIFY_BUILD_TEST_FAIL: 'core-before-compile'
    });
    assert.notStrictEqual(coreFailure.status, 0,
        'injected core failure must fail closed');
    assert.match(coreFailure.stderr, /previous \.tmp\/v2-core was preserved/);
    assert.strictEqual(digest(coreArtifact), coreBefore);
    assert.strictEqual(digest(coreStamp), stampBefore);
    assertNoStaging('v2-core.staging-');

    var heldStdout = [];
    var heldStderr = [];
    var held = childProcess.spawn(process.execPath, ['scripts/build-v2-core.js'], {
        cwd: root,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: Object.assign({}, process.env, {
            SQL_BEAUTIFY_BUILD_TEST_HOLD_MS: '2000'
        })
    });
    var heldDone = childCompletion(held, heldStdout, heldStderr);
    waitForFile(coreLock, 3000);
    var contendedStarted = process.hrtime.bigint();
    var contended = runBuild('scripts/build-v2-core.js');
    var contendedMs = Number(process.hrtime.bigint() - contendedStarted) / 1e6;
    assert.notStrictEqual(contended.status, 0,
        'concurrent build must not delete or wait on another build');
    assert.match(contended.stderr, /already running/);
    assert.ok(contendedMs < 1000,
        'concurrent build rejection must be prompt: ' + contendedMs + 'ms');
    var heldResult = await heldDone;
    assert.strictEqual(heldResult.status, 0, heldResult.stderr);
    assert.strictEqual(digest(coreArtifact), coreBefore);

    var runtimeBefore = new Map(runtimeFiles.map(function(fileName) {
        return [fileName, digest(path.join(root, fileName))];
    }));
    var runtimeCached = runBuild('scripts/build-v2-runtime.js');
    assert.strictEqual(runtimeCached.status, 0, runtimeCached.stderr);
    assert.match(runtimeCached.stdout, /Reused cached v2 runtime build/);
    var runtimeFailure = runBuild('scripts/build-v2-runtime.js', {
        SQL_BEAUTIFY_BUILD_FORCE: '1',
        SQL_BEAUTIFY_BUILD_TEST_FAIL: 'runtime-before-build'
    });
    assert.notStrictEqual(runtimeFailure.status, 0,
        'injected runtime failure must fail closed');
    assert.match(runtimeFailure.stderr, /previous dist was preserved/);
    runtimeFiles.forEach(function(fileName) {
        assert.strictEqual(digest(path.join(root, fileName)), runtimeBefore.get(fileName));
    });
    assertNoStaging('v2-runtime.staging-');

    var plan = JSON.parse(childProcess.execFileSync(process.execPath, [
        'scripts/run-v2-suite.js', 'verify', '--plan', '--json'
    ], { cwd: root, encoding: 'utf8' }));
    assert.deepStrictEqual(
        { typecheck: plan.counts.typecheck, core: plan.counts.core, runtime: plan.counts.runtime },
        { typecheck: 1, core: 1, runtime: 1 },
        'test:verify must schedule each canonical prerequisite exactly once'
    );
    assert.strictEqual(new Set(plan.steps.map(function(step) {
        return step.command + '\0' + step.args.join('\0');
    })).size, plan.steps.length, 'flattened verify plan must not duplicate test steps');

    var temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sql-beautify-manifest-'));
    try {
        fs.mkdirSync(path.join(temporaryRoot, 'images'));
        fs.writeFileSync(path.join(temporaryRoot, 'images', 'icon.png'), 'fixture');
        packageJson = JSON.parse(fs.readFileSync(
            path.join(root, 'package.json'),
            'utf8'
        ));
        fs.writeFileSync(path.join(temporaryRoot, 'package.json'),
            JSON.stringify(packageJson), 'utf8');
        var manifestApi = require(path.join(root, 'scripts', 'package-manifest.js'));
        assert.doesNotThrow(function() {
            manifestApi.loadPackageManifest(temporaryRoot);
        });
        packageJson.files = packageJson.files.concat(['src/private.ts']);
        fs.writeFileSync(path.join(temporaryRoot, 'package.json'),
            JSON.stringify(packageJson), 'utf8');
        assert.throws(function() {
            manifestApi.loadPackageManifest(temporaryRoot);
        }, /shared production allowlist/,
        'shared manifest must reject an accidental package allowlist expansion');
    } finally {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }

    console.log('v2 build, suite, and package-manifest infrastructure tests passed');
}

main().catch(function(error) {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
});
