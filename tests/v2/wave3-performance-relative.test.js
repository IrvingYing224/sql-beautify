'use strict';

var assert = require('assert');
var childProcess = require('child_process');
var crypto = require('crypto');
var fs = require('fs');
var os = require('os');
var path = require('path');

var root = path.join(__dirname, '..', '..');
var ANCHOR_SHA = 'b206e9b1f0df5e038169590b01e386d12146a47b';
var RATIO_LIMIT = 1.20;
var FLOOR_MS = 5;
var LOW_BASELINE_NOISE_MS = 2;
var RSS_RATIO_LIMIT = 1.50;
var RSS_FLOOR_KB = 128 * 1024;
var PROCESS_ROUNDS = 4;
var ANCHOR_WORKER_SHA256 =
    'b68a22753dba020d0138850cc7d06798216c021c74eb459af80bd8b3441c0e6e';
var WORKLOAD_CONTRACTS = Object.freeze({
    'statements/100': Object.freeze({
        sourceCodeUnits: 1089,
        sourceDigest: '9cc7d8dd13c51126a42cac3171c90789bb6763834b857b3c5742680eb646ae95'
    }),
    'statements/800': Object.freeze({
        sourceCodeUnits: 9489,
        sourceDigest: '8811bf53d3f6521b8c8eeb0cfecf475aee9c8cc02b48011e81238909897593ad'
    }),
    'statements/1200': Object.freeze({
        sourceCodeUnits: 14489,
        sourceDigest: '1c662bfccd110aae60b371ab79516f684f768be786a7a3e9e31692144f70d558'
    }),
    'formatted-list/100': Object.freeze({
        sourceCodeUnits: 495,
        sourceDigest: '8a093cf5060e3a56cd61e7e3f8980c822b14942875aa59820b4459cd2c4723c3'
    }),
    'formatted-list/800': Object.freeze({
        sourceCodeUnits: 4695,
        sourceDigest: '180582f61f7eef8c0c6efd15f4ea4f4203c73c0ef369edc0b53f3b7fdc8adcac'
    }),
    'formatted-list/1200': Object.freeze({
        sourceCodeUnits: 7295,
        sourceDigest: '6d889a340103e908999cf6aad31b9e00091c460f27d0f34d7c3c75f69b1ad96b'
    })
});

var BENCHMARK_SCRIPT = String.raw`
'use strict';
var os = require('os');
var crypto = require('crypto');
var formatApi = require(process.env.WAVE3_BENCH_ROOT +
    '/.tmp/v2-core/core/api/format.js');
function statementSource(count) {
    var values = [];
    for (var index = 0; index < count; index++) {
        values.push('SELECT ' + index + ';');
    }
    return values.join('\n');
}
function formattedListSource(count) {
    var values = [];
    for (var index = 0; index < count; index++) {
        values.push(String(index));
    }
    return 'select  ' + values.join(',  ');
}
function median(values) {
    var ordered = values.slice().sort(function(left, right) {
        return left - right;
    });
    var middle = Math.floor(ordered.length / 2);
    return ordered.length % 2 === 0
        ? (ordered[middle - 1] + ordered[middle]) / 2
        : ordered[middle];
}
function digest(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}
var kind = process.env.WAVE3_BENCH_KIND;
var count = Number(process.env.WAVE3_BENCH_COUNT);
if ((kind !== 'statements' && kind !== 'formatted-list') ||
    !Number.isSafeInteger(count) || count <= 0) {
    throw new Error('invalid Wave 3 relative benchmark input');
}
var source = kind === 'statements'
    ? statementSource(count)
    : formattedListSource(count);
var latest;
for (var warmup = 0; warmup < 5; warmup++) {
    latest = formatApi.formatSqlWithStatistics(source, { dialect: 'hive' });
}
var samples = [];
for (var sample = 0; sample < 15; sample++) {
    var started = process.hrtime.bigint();
    latest = formatApi.formatSqlWithStatistics(source, { dialect: 'hive' });
    samples.push(Number(process.hrtime.bigint() - started) / 1e6);
}
var cpu = os.cpus()[0];
process.stdout.write(JSON.stringify({
    kind: kind,
    count: count,
    medianMs: median(samples),
    samplesMs: samples,
    sourceCodeUnits: source.length,
    outputCodeUnits: latest.result.text.length,
    sourceDigest: digest(source),
    outputDigest: digest(latest.result.text),
    status: latest.result.status,
    statistics: latest.statistics,
    maxRssKb: process.resourceUsage().maxRSS,
    environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        cpu: cpu ? cpu.model : 'unknown'
    }
}));
`;

function spawnGit(args, encoding) {
    var result = childProcess.spawnSync('git', args, {
        cwd: root,
        encoding: encoding === 'buffer' ? null : encoding,
        maxBuffer: 16 * 1024 * 1024,
        timeout: 30000
    });
    assert.strictEqual(
        result.status,
        0,
        'git ' + args.join(' ') + ' failed:\n' +
            String(result.stdout || '') + '\n' + String(result.stderr || '')
    );
    return result.stdout;
}

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function writeFile(targetRoot, relativePath, bytes) {
    var target = path.join(targetRoot, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
}

function materializeAnchor(targetRoot) {
    var names = String(spawnGit(
        ['ls-tree', '-r', '-z', '--name-only', ANCHOR_SHA],
        'buffer'
    )).split('\0').filter(Boolean).filter(function(relativePath) {
        return relativePath.indexOf('src/') === 0 ||
            relativePath === 'tsconfig.v2.json' ||
            relativePath === 'tsconfig.v2.build.json';
    });
    assert.ok(names.some(function(value) {
        return value === 'src/core/api/format.ts';
    }), 'anchor must contain the Wave 3B format kernel');
    names.forEach(function(relativePath) {
        writeFile(
            targetRoot,
            relativePath,
            spawnGit(['show', ANCHOR_SHA + ':' + relativePath], 'buffer')
        );
    });
}

function copyTree(sourceRoot, targetRoot) {
    var work = [''];
    while (work.length > 0) {
        var relative = work.pop();
        var directory = path.join(sourceRoot, relative);
        fs.readdirSync(directory, { withFileTypes: true }).forEach(function(entry) {
            var childRelative = path.join(relative, entry.name);
            if (entry.isDirectory()) {
                work.push(childRelative);
            } else if (entry.isFile()) {
                writeFile(
                    targetRoot,
                    path.join('src', childRelative),
                    fs.readFileSync(path.join(sourceRoot, childRelative))
                );
            }
        });
    }
}

function materializeCurrent(targetRoot) {
    copyTree(path.join(root, 'src'), targetRoot);
    ['tsconfig.v2.json', 'tsconfig.v2.build.json'].forEach(function(fileName) {
        writeFile(targetRoot, fileName, fs.readFileSync(path.join(root, fileName)));
    });
}

function compileTree(targetRoot) {
    var tscPath = require.resolve('typescript/bin/tsc');
    var typeRoots = path.join(root, 'node_modules', '@types');
    var result = childProcess.spawnSync(
        process.execPath,
        [
            tscPath,
            '-p',
            path.join(targetRoot, 'tsconfig.v2.build.json'),
            '--typeRoots',
            typeRoots
        ],
        {
            cwd: targetRoot,
            encoding: 'utf8',
            maxBuffer: 16 * 1024 * 1024,
            timeout: 120000
        }
    );
    assert.strictEqual(
        result.status,
        0,
        'isolated TypeScript compile failed for ' + targetRoot + ':\n' +
            result.stdout + '\n' + result.stderr +
            '\nerror=' + String(result.error || 'none')
    );
}

function runWorker(treeRoot, kind, count) {
    var result = childProcess.spawnSync(
        process.execPath,
        ['-e', BENCHMARK_SCRIPT],
        {
            cwd: treeRoot,
            encoding: 'utf8',
            maxBuffer: 4 * 1024 * 1024,
            timeout: 60000,
            env: Object.assign({}, process.env, {
                WAVE3_BENCH_ROOT: treeRoot,
                WAVE3_BENCH_KIND: kind,
                WAVE3_BENCH_COUNT: String(count)
            })
        }
    );
    assert.strictEqual(
        result.status,
        0,
        'isolated relative worker failed for ' + kind + '/' + count + ':\n' +
            result.stdout + '\n' + result.stderr +
            '\nerror=' + String(result.error || 'none') +
            '\nsignal=' + String(result.signal || 'none')
    );
    return JSON.parse(result.stdout);
}

function median(values) {
    var ordered = values.slice().sort(function(left, right) {
        return left - right;
    });
    var middle = Math.floor(ordered.length / 2);
    return ordered.length % 2 === 0
        ? (ordered[middle - 1] + ordered[middle]) / 2
        : ordered[middle];
}

function performanceGate(baselineMs, currentMs) {
    if (
        !Number.isFinite(baselineMs) ||
        !Number.isFinite(currentMs) ||
        baselineMs <= 0 ||
        currentMs <= 0
    ) {
        return false;
    }
    return currentMs / Math.max(baselineMs, FLOOR_MS) <= RATIO_LIMIT &&
        (baselineMs >= FLOOR_MS ||
            currentMs - baselineMs <= LOW_BASELINE_NOISE_MS);
}

function resourceGate(baselineKb, currentKb) {
    return Number.isFinite(baselineKb) &&
        Number.isFinite(currentKb) &&
        baselineKb > 0 &&
        currentKb > 0 &&
        currentKb / Math.max(baselineKb, RSS_FLOOR_KB) <= RSS_RATIO_LIMIT;
}

function assertWorkerReport(report, side, kind, count, contract) {
    assert.strictEqual(report.kind, kind, side + ' worker kind');
    assert.strictEqual(report.count, count, side + ' worker count');
    assert.strictEqual(report.sourceCodeUnits, contract.sourceCodeUnits,
        side + ' source length must match the anchored workload');
    assert.strictEqual(report.sourceDigest, contract.sourceDigest,
        side + ' source digest must match the anchored workload');
    assert.strictEqual(
        report.status,
        kind === 'statements' ? 'unchanged' : 'formatted',
        side + ' worker must complete the intended successful behavior'
    );
    assert.ok(Array.isArray(report.samplesMs));
    assert.strictEqual(report.samplesMs.length, 15);
    report.samplesMs.forEach(function(value) {
        assert.ok(Number.isFinite(value) && value > 0,
            side + ' samples must be finite and positive');
    });
    assert.strictEqual(report.medianMs, median(report.samplesMs));
    assert.ok(Number.isFinite(report.maxRssKb) && report.maxRssKb > 0,
        side + ' maxRSS must be finite and positive');
    assert.ok(report.statistics && typeof report.statistics === 'object');
    assert.strictEqual(
        report.statistics.sourceCodeUnits,
        report.sourceCodeUnits
    );
    assert.strictEqual(
        report.statistics.outputCodeUnits,
        report.outputCodeUnits
    );
    ['leafCount', 'syntaxNodeCount', 'planActionCount', 'leafVisitCount',
        'leafEmissionCount', 'directLookupCount', 'docNodeCount'].forEach(
        function(key) {
            assert.ok(Number.isFinite(report.statistics[key]) &&
                report.statistics[key] >= 0,
            side + ' statistics.' + key + ' must be finite and non-negative');
        }
    );
    assert.ok(/^[0-9a-f]{64}$/.test(report.outputDigest),
        side + ' output digest must be present');
    if (side === 'current') {
        [
            'metricsDocVisitCount',
            'metricsSummaryLookupCount',
            'renderDocVisitCount',
            'renderMetricsLookupCount',
            'equivalenceInputCodeUnits',
            'equivalenceDiagnosticVisitCount',
            'equivalenceSourceLeafVisitCount',
            'equivalenceOutputLeafVisitCount',
            'equivalenceComparisonCount',
            'equivalenceDirectLookupCount'
        ].forEach(function(key) {
            assert.ok(Number.isFinite(report.statistics[key]) &&
                report.statistics[key] >= 0,
            'current statistics.' + key + ' must be finite and non-negative');
        });
        assert.ok(report.statistics.planActionCount > 0,
            'current ' + kind + ' must register layout actions');
        assert.ok(report.statistics.policyNodeVisitCount > 0 &&
            report.statistics.policyLeafVisitCount > 0 &&
            report.statistics.policyDirectLookupCount > 0,
        'current ' + kind + ' must report query-policy work');
        assert.ok(report.statistics.metricsDocVisitCount > 0 &&
            report.statistics.metricsSummaryLookupCount > 0 &&
            report.statistics.renderDocVisitCount > 0,
        'current ' + kind + ' must report metrics and renderer work');
        assert.strictEqual(
            report.statistics.equivalenceInputCodeUnits,
            report.outputCodeUnits,
            'current ' + kind + ' must account for output re-lexing'
        );
        assert.ok(report.statistics.equivalenceSourceLeafVisitCount > 0 &&
            report.statistics.equivalenceOutputLeafVisitCount > 0 &&
            report.statistics.equivalenceComparisonCount > 0 &&
            report.statistics.equivalenceDirectLookupCount > 0,
        'current ' + kind + ' must report token-equivalence work');
    }
    if (kind === 'statements') {
        assert.strictEqual(report.outputCodeUnits, report.sourceCodeUnits);
        assert.strictEqual(report.outputDigest, report.sourceDigest);
    } else if (side === 'current') {
        assert.ok(report.outputCodeUnits > report.sourceCodeUnits,
            'current formatted-list must execute multiline layout');
        assert.ok(report.statistics.scopeActionCount > 0,
            'current formatted-list must register layout scopes');
    }
}

(function testGateBoundaries() {
    assert.strictEqual(median([1, 2, 100, 200]), 51,
        'even process rounds must use the conventional two-middle median');
    assert.strictEqual(performanceGate(10, 12), true);
    assert.strictEqual(performanceGate(10, 12.01), false);
    assert.strictEqual(performanceGate(4, 6), true);
    assert.strictEqual(performanceGate(4, 6.01), false);
    assert.strictEqual(performanceGate(1, 3), true);
    assert.strictEqual(performanceGate(1, 3.01), false);
    assert.strictEqual(performanceGate(10, 8), true);
    [NaN, 0, -1, Infinity].forEach(function(value) {
        assert.strictEqual(performanceGate(value, 1), false);
        assert.strictEqual(performanceGate(1, value), false);
    });
})();

(function testResourceGateBoundaries() {
    assert.strictEqual(resourceGate(128 * 1024, 192 * 1024), true);
    assert.strictEqual(resourceGate(128 * 1024, 192 * 1024 + 1), false);
    assert.strictEqual(resourceGate(64 * 1024, 192 * 1024), true);
    assert.strictEqual(resourceGate(64 * 1024, 192 * 1024 + 1), false);
    assert.strictEqual(resourceGate(256 * 1024, 128 * 1024), true);
    [NaN, 0, -1, Infinity].forEach(function(value) {
        assert.strictEqual(resourceGate(value, 1), false);
        assert.strictEqual(resourceGate(1, value), false);
    });
})();

(function testWave3CurrentAgainstCommittedWave3bAnchor() {
    spawnGit(['cat-file', '-e', ANCHOR_SHA + '^{commit}'], 'utf8');
    spawnGit(['merge-base', '--is-ancestor', ANCHOR_SHA, 'HEAD'], 'utf8');
    assert.strictEqual(
        sha256(spawnGit([
            'show',
            ANCHOR_SHA + ':tests/v2/wave3-performance.test.js'
        ], 'buffer')),
        ANCHOR_WORKER_SHA256,
        'Wave 3B benchmark worker must remain pinned to the committed anchor'
    );
    var currentLock = fs.readFileSync(path.join(root, 'package-lock.json'));
    var anchorLock = spawnGit(['show', ANCHOR_SHA + ':package-lock.json'], 'buffer');
    assert.strictEqual(
        sha256(currentLock),
        sha256(anchorLock),
        'relative benchmark requires identical package-lock bytes'
    );

    var temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sql-beautify-wave3-relative-'));
    var baselineRoot = path.join(temporary, 'baseline');
    var currentRoot = path.join(temporary, 'current');
    var reports = [];
    try {
        materializeAnchor(baselineRoot);
        materializeCurrent(currentRoot);
        compileTree(baselineRoot);
        compileTree(currentRoot);

        ['statements', 'formatted-list'].forEach(function(kind) {
            [100, 800, 1200].forEach(function(count) {
                var processReports = { baseline: [], current: [] };
                for (var round = 0; round < PROCESS_ROUNDS; round++) {
                    var order = round % 2 === 0
                        ? ['baseline', 'current']
                        : ['current', 'baseline'];
                    order.forEach(function(side) {
                        processReports[side].push(runWorker(
                            side === 'baseline' ? baselineRoot : currentRoot,
                            kind,
                            count
                        ));
                    });
                }
                var contract = WORKLOAD_CONTRACTS[kind + '/' + count];
                assert.ok(contract, 'missing anchored workload contract');
                ['baseline', 'current'].forEach(function(side) {
                    processReports[side].forEach(function(value) {
                        assertWorkerReport(value, side, kind, count, contract);
                    });
                    assert.strictEqual(
                        new Set(processReports[side].map(function(value) {
                            return value.outputDigest;
                        })).size,
                        1,
                        side + ' output must be deterministic across fresh processes'
                    );
                });
                if (kind === 'formatted-list') {
                    assert.notStrictEqual(
                        processReports.baseline[0].outputDigest,
                        processReports.current[0].outputDigest,
                        'current formatted-list must execute Wave 3C layout, not the 3B path'
                    );
                }
                var baselineMs = median(processReports.baseline.map(function(value) {
                    return value.medianMs;
                }));
                var currentMs = median(processReports.current.map(function(value) {
                    return value.medianMs;
                }));
                var baselineMaxRssKb = median(
                    processReports.baseline.map(function(value) {
                        return value.maxRssKb;
                    })
                );
                var currentMaxRssKb = median(
                    processReports.current.map(function(value) {
                        return value.maxRssKb;
                    })
                );
                var effectiveDenominator = Math.max(baselineMs, FLOOR_MS);
                var effectiveRssDenominatorKb = Math.max(
                    baselineMaxRssKb,
                    RSS_FLOOR_KB
                );
                var report = {
                    kind: kind,
                    count: count,
                    baselineMs: baselineMs,
                    currentMs: currentMs,
                    effectiveDenominatorMs: effectiveDenominator,
                    ratio: currentMs / effectiveDenominator,
                    deltaMs: currentMs - baselineMs,
                    baselineMaxRssKb: baselineMaxRssKb,
                    currentMaxRssKb: currentMaxRssKb,
                    effectiveRssDenominatorKb: effectiveRssDenominatorKb,
                    rssRatio: currentMaxRssKb / effectiveRssDenominatorKb,
                    baselineProcesses: processReports.baseline,
                    currentProcesses: processReports.current
                };
                reports.push(report);
                assert.strictEqual(
                    performanceGate(baselineMs, currentMs),
                    true,
                    'Wave 3C relative gate failed: ' + JSON.stringify(report)
                );
                assert.strictEqual(
                    resourceGate(baselineMaxRssKb, currentMaxRssKb),
                    true,
                    'Wave 3C relative maxRSS gate failed: ' +
                        JSON.stringify(report)
                );
            });
        });
        console.log('v2 Wave 3 relative performance ' + JSON.stringify({
            anchorSha: ANCHOR_SHA,
            packageLockSha256: sha256(currentLock),
            thresholds: {
                ratioLimit: RATIO_LIMIT,
                floorMs: FLOOR_MS,
                lowBaselineNoiseMs: LOW_BASELINE_NOISE_MS,
                rssRatioLimit: RSS_RATIO_LIMIT,
                rssFloorKb: RSS_FLOOR_KB,
                processRounds: PROCESS_ROUNDS
            },
            typescript: require('typescript').version,
            reports: reports
        }));
    } finally {
        fs.rmSync(temporary, { recursive: true, force: true });
    }
})();
