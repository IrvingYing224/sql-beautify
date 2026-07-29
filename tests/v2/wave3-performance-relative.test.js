'use strict';

var assert = require('assert');
var childProcess = require('child_process');
var path = require('path');

var root = path.join(__dirname, '..', '..');
var currentCoreRoot = path.join(root, '.tmp', 'v2-core');
var gates = require('./helpers/performance-gates');
var baselineApi = require('./helpers/release-baseline');

function median(values) {
    var ordered = values.slice().sort(function(left, right) {
        return left - right;
    });
    return ordered[Math.floor(ordered.length / 2)];
}

function runWorker(coreRoot, testCase) {
    var workload = gates.manifest.workloads.format;
    var worker = gates.manifest.workers.format;
    var result = childProcess.spawnSync(
        process.execPath,
        [path.join(root, worker.path)],
        {
            cwd: root,
            encoding: 'utf8',
            maxBuffer: 8 * 1024 * 1024,
            timeout: 120000,
            env: Object.assign({}, process.env, {
                SQL_BEAUTIFY_PERF_CORE_ROOT: coreRoot,
                SQL_BEAUTIFY_PERF_KIND: testCase.kind,
                SQL_BEAUTIFY_PERF_COUNT: String(testCase.count),
                SQL_BEAUTIFY_PERF_WARMUPS: String(workload.warmupRounds),
                SQL_BEAUTIFY_PERF_SAMPLES: String(workload.sampleRounds)
            })
        }
    );
    assert.strictEqual(
        result.status,
        0,
        'isolated format relative worker failed for ' + testCase.kind + '/' +
            testCase.count + ':\n' + String(result.stdout || '') + '\n' +
            String(result.stderr || '') + '\nerror=' +
            String(result.error || 'none')
    );
    return JSON.parse(result.stdout);
}

function assertWorkerReport(report, side, testCase) {
    var sampleRounds = gates.manifest.workloads.format.sampleRounds;
    assert.strictEqual(report.kind, testCase.kind, side + ' worker kind');
    assert.strictEqual(report.count, testCase.count, side + ' worker count');
    assert.strictEqual(report.sourceCodeUnits, testCase.sourceCodeUnits,
        side + ' source length must match the manifest workload');
    assert.strictEqual(report.sourceDigest, testCase.sourceSha256,
        side + ' source digest must match the manifest workload');
    assert.strictEqual(
        report.status,
        testCase.kind === 'statements' ? 'unchanged' : 'formatted',
        side + ' worker must complete the intended successful behavior'
    );
    assert.ok(Array.isArray(report.samplesMs));
    assert.strictEqual(report.samplesMs.length, sampleRounds);
    report.samplesMs.forEach(function(value) {
        assert.ok(Number.isFinite(value) && value > 0,
            side + ' samples must be finite and positive');
    });
    assert.strictEqual(report.medianMs, median(report.samplesMs));
    assert.ok(Number.isFinite(report.maxRssKb) && report.maxRssKb > 0,
        side + ' maxRSS must be finite and positive');
    assert.ok(report.statistics && typeof report.statistics === 'object');
    assert.strictEqual(report.statistics.sourceCodeUnits, report.sourceCodeUnits);
    assert.strictEqual(report.statistics.outputCodeUnits, report.outputCodeUnits);
    [
        'leafCount',
        'syntaxNodeCount',
        'planActionCount',
        'leafVisitCount',
        'leafEmissionCount',
        'directLookupCount',
        'docNodeCount'
    ].forEach(function(key) {
        assert.ok(Number.isFinite(report.statistics[key]) &&
            report.statistics[key] >= 0,
        side + ' statistics.' + key + ' must be finite and non-negative');
    });
    if (side === 'current') {
        [
            'metricsDocVisitCount',
            'metricsSummaryLookupCount',
            'renderDocVisitCount',
            'renderMetricsLookupCount',
            'equivalenceComparisonCount',
            'equivalenceDirectLookupCount'
        ].forEach(function(key) {
            assert.ok(Number.isFinite(report.statistics[key]) &&
                report.statistics[key] >= 0,
            'current statistics.' + key + ' must be finite and non-negative');
        });
        assert.ok(report.statistics.planActionCount > 0);
        assert.ok(report.statistics.renderDocVisitCount > 0);
        assert.ok(report.statistics.equivalenceComparisonCount > 0);
    }
}

(function testCentralGateBoundaries() {
    var minimum = gates.manifest.gates.minimumBaselineMedianMs;
    var ratio = gates.manifest.gates.relativeRatio;
    assert.strictEqual(gates.relativeGate(minimum, minimum * ratio), true);
    assert.strictEqual(gates.relativeGate(minimum, minimum * ratio + 0.01), false);
    assert.strictEqual(gates.relativeGate(minimum - 0.01, 1), false,
        'workloads below 100ms must be enlarged, not rescued by an absolute delta');
    assert.strictEqual(gates.relativeGate(minimum * 2, minimum), true);
    [NaN, 0, -1, Infinity].forEach(function(value) {
        assert.strictEqual(gates.relativeGate(value, minimum), false);
        assert.strictEqual(gates.relativeGate(minimum, value), false);
    });
    assert.strictEqual(gates.resourceGate(100, 150), true);
    assert.strictEqual(gates.resourceGate(100, 150.01), false);
})();

if (!gates.strictRelativeEnabled()) {
    console.log('v2 Wave 3 strict release-relative wall-clock gate skipped; ' +
        'set SQL_BEAUTIFY_STRICT_RELATIVE_PERF=1 on main/manual/nightly');
} else {
    (function testCurrentAgainstManifestReleaseBaseline() {
        var baseline = baselineApi.prepareReleaseBaseline();
        var workload = gates.manifest.workloads.format;
        var reports = [];
        workload.cases.forEach(function(testCase, caseIndex) {
            var processReports = { baseline: [], current: [] };
            for (var round = 0; round < workload.processRounds; round++) {
                var order = (caseIndex + round) % 2 === 0
                    ? ['baseline', 'current']
                    : ['current', 'baseline'];
                order.forEach(function(side) {
                    processReports[side].push(runWorker(
                        side === 'baseline' ? baseline.coreRoot : currentCoreRoot,
                        testCase
                    ));
                });
            }
            ['baseline', 'current'].forEach(function(side) {
                processReports[side].forEach(function(report) {
                    assertWorkerReport(report, side, testCase);
                });
            });
            var baselineMs = median(processReports.baseline.map(function(report) {
                return report.medianMs;
            }));
            var currentMs = median(processReports.current.map(function(report) {
                return report.medianMs;
            }));
            var baselineMaxRssKb = median(processReports.baseline.map(function(report) {
                return report.maxRssKb;
            }));
            var currentMaxRssKb = median(processReports.current.map(function(report) {
                return report.maxRssKb;
            }));
            assert.ok(
                gates.relativeGate(baselineMs, currentMs),
                testCase.kind + '/' + testCase.count +
                    ' format regression exceeded ' +
                    gates.manifest.gates.relativeRatio + 'x or baseline workload was <' +
                    gates.manifest.gates.minimumBaselineMedianMs + 'ms: baseline=' +
                    baselineMs + 'ms, current=' + currentMs + 'ms'
            );
            assert.ok(
                gates.resourceGate(baselineMaxRssKb, currentMaxRssKb),
                testCase.kind + '/' + testCase.count +
                    ' maxRSS regression exceeded ' + gates.manifest.gates.rssRatio + 'x'
            );
            reports.push({
                kind: testCase.kind,
                count: testCase.count,
                baselineMs: baselineMs,
                currentMs: currentMs,
                ratio: currentMs / baselineMs,
                baselineMaxRssKb: baselineMaxRssKb,
                currentMaxRssKb: currentMaxRssKb,
                rssRatio: currentMaxRssKb / baselineMaxRssKb
            });
        });
        console.log('v2 Wave 3 release-relative performance ' + JSON.stringify({
            manifest: {
                release: gates.manifest.release,
                workerSchema: gates.manifest.workers.format.schema,
                workloadSchema: workload.schema,
                compilerStrategy: gates.manifest.compiler.strategy,
                baselineCacheHit: baseline.cacheHit
            },
            gates: gates.manifest.gates,
            reports: reports
        }));
    })();
}
