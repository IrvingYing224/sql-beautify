'use strict';

var assert = require('assert');
var crypto = require('crypto');
var fs = require('fs');
var path = require('path');

var root = path.join(__dirname, '..', '..');
var gates = require('./helpers/performance-gates');
var workloads = require('./helpers/perf-workloads');
var baselineApi = require('./helpers/release-baseline');
var lexer = require('../../.tmp/v2-core/core/lexer/lossless-lexer.js');
var formatter = require('../../.tmp/v2-core/core/api/format.js');

function digest(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function fileDigest(filePath) {
    return digest(fs.readFileSync(filePath));
}

function tokenFingerprint(text) {
    var values = lexer.lexSql(text, { dialect: 'hive' }).leaves
        .filter(function(leaf) { return leaf.channel !== 'trivia'; })
        .map(function(leaf) {
            return [leaf.kind, leaf.raw.toLowerCase()];
        });
    return digest(JSON.stringify(values));
}

Object.keys(gates.manifest.workers).forEach(function(name) {
    var worker = gates.manifest.workers[name];
    assert.strictEqual(
        fileDigest(path.join(root, worker.path)),
        worker.sha256,
        name + ' relative worker bytes must match the baseline manifest'
    );
    assert.match(worker.schema, /^[a-z0-9]+(?:-[a-z0-9]+)*-v\d+$/);
});

gates.manifest.workloads.format.cases.forEach(function(testCase) {
    var source = testCase.kind === 'statements'
        ? workloads.statementSource(testCase.count)
        : workloads.formattedListSource(testCase.count);
    assert.strictEqual(source.length, testCase.sourceCodeUnits,
        testCase.kind + ' workload source length');
    assert.strictEqual(digest(source), testCase.sourceSha256,
        testCase.kind + ' workload digest');
});
gates.manifest.workloads.parser.cases.forEach(function(testCase) {
    var source = workloads.parserSource(testCase.statementCount);
    assert.strictEqual(source.length, testCase.sourceCodeUnits,
        'parser workload source length');
    assert.strictEqual(digest(source), testCase.sourceSha256,
        'parser workload digest');
});

(function testBehaviorFingerprintIsIndependentFromLayoutBytes() {
    var source = 'select  a,  b  from  t';
    var formatted = formatter.formatSql(source, { dialect: 'hive' });
    assert.strictEqual(formatted.status, 'formatted');
    var intentionalAlternativeLayout = 'SELECT a, b\nFROM t';
    assert.notStrictEqual(digest(formatted.text), digest(intentionalAlternativeLayout),
        'fixture must contain an intentional byte-level layout change');
    assert.strictEqual(
        tokenFingerprint(formatted.text),
        '2eaa736305b16b95ac7dac445ba75e984afc6459af8ee63ec2061f9d0658a86d',
        'candidate behavior fingerprint must remain versioned and explicit'
    );
    assert.strictEqual(tokenFingerprint(intentionalAlternativeLayout),
        tokenFingerprint(formatted.text),
        'token behavior must be tested independently from layout bytes');
})();

(function testReleaseBaselineCompilesAtMostOnce() {
    var currentArtifact = path.join(
        root,
        '.tmp',
        'v2-core',
        'core',
        'api',
        'format.js'
    );
    var currentDigest = fileDigest(currentArtifact);
    var first = baselineApi.prepareReleaseBaseline();
    assert.strictEqual(typeof first.cacheHit, 'boolean');
    var second = baselineApi.prepareReleaseBaseline();
    assert.strictEqual(second.cacheHit, true,
        'identical release/toolchain input must hit the shared baseline cache');
    assert.strictEqual(second.cacheIdentity, first.cacheIdentity);
    assert.strictEqual(second.coreRoot, first.coreRoot);
    assert.ok(fs.existsSync(path.join(
        second.coreRoot,
        'core',
        'syntax',
        'parser.js'
    )));
    assert.strictEqual(fileDigest(currentArtifact), currentDigest,
        'baseline compilation must not rebuild or replace canonical current core');
})();

console.log('v2 performance baseline manifest, behavior, and cache tests passed');
