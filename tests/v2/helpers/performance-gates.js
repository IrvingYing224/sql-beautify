'use strict';

var assert = require('assert');
var path = require('path');

var baseline = require(path.join('..', 'perf-baseline.json'));

function validateManifest() {
    assert.strictEqual(baseline.schemaVersion, 1);
    assert.match(baseline.release.version, /^\d+\.\d+\.\d+$/);
    assert.match(baseline.release.commit, /^[0-9a-f]{40}$/);
    assert.strictEqual(baseline.compiler.strategy,
        'current-project-local-typescript');
    assert.ok(Number.isFinite(baseline.gates.minimumBaselineMedianMs) &&
        baseline.gates.minimumBaselineMedianMs >= 100);
    assert.ok(Number.isFinite(baseline.gates.relativeRatio) &&
        baseline.gates.relativeRatio > 1);
    assert.ok(Number.isFinite(baseline.gates.rssRatio) &&
        baseline.gates.rssRatio > 1);
    return baseline;
}

function relativeGate(baselineMs, currentMs) {
    return Number.isFinite(baselineMs) &&
        Number.isFinite(currentMs) &&
        baselineMs >= baseline.gates.minimumBaselineMedianMs &&
        currentMs > 0 &&
        currentMs / baselineMs <= baseline.gates.relativeRatio;
}

function resourceGate(baselineKb, currentKb) {
    return Number.isFinite(baselineKb) &&
        Number.isFinite(currentKb) &&
        baselineKb > 0 &&
        currentKb > 0 &&
        currentKb / baselineKb <= baseline.gates.rssRatio;
}

function strictRelativeEnabled() {
    return process.env.SQL_BEAUTIFY_STRICT_RELATIVE_PERF === '1';
}

module.exports = Object.freeze({
    manifest: validateManifest(),
    relativeGate: relativeGate,
    resourceGate: resourceGate,
    strictRelativeEnabled: strictRelativeEnabled
});
