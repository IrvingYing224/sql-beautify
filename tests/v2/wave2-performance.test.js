'use strict';

var assert = require('assert');
var childProcess = require('child_process');
var path = require('path');

var root = path.join(__dirname, '..', '..');
var currentCoreRoot = path.join(root, '.tmp', 'v2-core');
var parser = require(path.join(currentCoreRoot, 'core', 'syntax', 'parser.js'));
var parserContext = require(path.join(
    currentCoreRoot,
    'core',
    'syntax',
    'parser-context.js'
));
var analysis = require(path.join(currentCoreRoot, 'core', 'analysis', 'index.js'));
var invariants = require(path.join(currentCoreRoot, 'core', 'syntax', 'invariants.js'));
var tokenTable = require(path.join(currentCoreRoot, 'core', 'syntax', 'token-table.js'));
var gates = require('./helpers/performance-gates');
var baselineApi = require('./helpers/release-baseline');
var workloads = require('./helpers/perf-workloads');

var ALIAS_SAMPLE_COUNT = 5;
var SCALE_SAMPLE_COUNT = 9;
var SCALE_WARMUP_ROUNDS = 3;
var SCALE_COUNTS = Object.freeze([100, 800, 1200]);
var SCALE_RATIO_GATE = 12;
var ALIAS_RATIO_400_GATE = 8;
var ALIAS_RATIO_800_GATE = 12;
var ANALYSIS_SCALE_RATIO_GATE = 12;
var ANALYSIS_CLOSURE_GATE_MS = gates.manifest.gates.disaster.analysisCaseMs;
var PARSER_PROOF_GATE_MS = gates.manifest.gates.disaster.parserProofTotalMs;

// Isolate each scale so large requests cannot bias smaller medians through a
// shared heap. Worker startup and source transfer remain outside timed samples.
var SCALE_WORKER_SOURCE = [
    "'use strict';",
    "var fs = require('fs');",
    "var path = require('path');",
    "var mode = process.argv[1];",
    "var statementCount = Number(process.argv[2]);",
    "var warmupRounds = Number(process.argv[3]);",
    "var sampleCount = Number(process.argv[4]);",
    "var coreRoot = process.argv[5];",
    "var source = fs.readFileSync(0, 'utf8');",
    "var parser = mode === 'parser'",
    "    ? require(path.join(coreRoot, 'core', 'syntax', 'parser.js'))",
    "    : null;",
    "var analysis = mode === 'analysis'",
    "    ? require(path.join(coreRoot, 'core', 'analysis', 'index.js'))",
    "    : null;",
    "function execute() {",
    "    return mode === 'parser'",
    "        ? parser.parseSql(source, { dialect: 'hive', mode: 'document' })",
    "        : analysis.analyzeSql(source, { dialect: 'hive', mode: 'document' });",
    "}",
    "function assertResult(result) {",
    "    var statements = mode === 'parser'",
    "        ? result.root.children",
    "        : result.index && result.index.statements();",
    "    if ((mode === 'analysis' && result.status !== 'analyzed') ||",
    "        !statements || statements.length !== statementCount ||",
    "        !statements.every(function(statement) { return statement.statementKind === 'query'; })) {",
    "        throw new Error(mode + ' scale worker returned an invalid result');",
    "    }",
    "    if (result.leaves.map(function(leaf) { return leaf.raw; }).join('') !== source) {",
    "        throw new Error(mode + ' scale worker lost source');",
    "    }",
    "}",
    "for (var warm = 0; warm < warmupRounds; warm++) { assertResult(execute()); }",
    "var samplesMs = [];",
    "for (var sample = 0; sample < sampleCount; sample++) {",
    "    var started = process.hrtime.bigint();",
    "    var result = execute();",
    "    samplesMs.push(Number(process.hrtime.bigint() - started) / 1e6);",
    "    assertResult(result);",
    "}",
    "samplesMs.sort(function(left, right) { return left - right; });",
    "process.stdout.write(JSON.stringify({",
    "    statementCount: statementCount,",
    "    sourceBytes: Buffer.byteLength(source, 'utf8'),",
    "    medianMs: samplesMs[Math.floor(samplesMs.length / 2)],",
    "    samplesMs: samplesMs,",
    "    processPeakRssKb: process.resourceUsage().maxRSS",
    "}));"
].join('\n');

function makeSource(statementCount) {
    return workloads.parserSource(statementCount);
}

function median(values) {
    var sorted = values.slice().sort(function(a, b) { return a - b; });
    return sorted[Math.floor(sorted.length / 2)];
}

function makeAliasColumnListSource(relationCount) {
    var source = 'SELECT * FROM t0 qualify(c0)';
    for (var index = 1; index < relationCount; index++) {
        source += (index % 2 === 0 ? ', ' : ' CROSS JOIN ') +
            't' + index + ' qualify(c' + index + ')';
    }
    return source;
}

function measureAliasColumnLists(relationCount) {
    var source = makeAliasColumnListSource(relationCount);
    var warm = parser.parseSql(source, { dialect: 'postgresql', mode: 'document' });
    assert.deepStrictEqual(warm.root.children.map(function(statement) {
        return statement.statementKind;
    }), ['query'], relationCount + ' relation alias-list warm parse');
    warm = null;

    var timings = [];
    var result = null;
    for (var sample = 0; sample < ALIAS_SAMPLE_COUNT; sample++) {
        // Do not retain the previous immutable parse graph while constructing
        // the next sample; the scale gate measures one request at a time.
        result = null;
        var started = process.hrtime.bigint();
        result = parser.parseSql(source, {
            dialect: 'postgresql',
            mode: 'document'
        });
        timings.push(Number(process.hrtime.bigint() - started) / 1e6);
        assert.deepStrictEqual(result.root.children.map(function(statement) {
            return statement.statementKind;
        }), ['query'], relationCount + ' relation alias-list measured parse');
        assert.strictEqual(result.leaves.map(function(leaf) {
            return leaf.raw;
        }).join(''), source, relationCount + ' relation alias-list source conservation');
        assert.strictEqual(result.diagnostics.some(function(diagnostic) {
            return diagnostic.recovery === 'preserve-statement' ||
                diagnostic.recovery === 'preserve-target' ||
                /proof budget/i.test(diagnostic.message);
        }), false, relationCount + ' legal alias lists must not widen recovery');
    }
    return Object.freeze({
        relationCount: relationCount,
        medianMs: median(timings),
        samplesMs: Object.freeze(timings)
    });
}

function makeAddChain(termCount) {
    var terms = ['x'];
    for (var index = 1; index < termCount; index++) {
        terms.push(String(index));
    }
    return terms.join(' + ');
}

function assertDeepResult(source, result, expectedStatementKind, label) {
    assert.deepStrictEqual(result.root.children.map(function(statement) {
        return statement.statementKind;
    }), [expectedStatementKind], label + ' statement kind');
    assert.strictEqual(result.leaves.map(function(leaf) {
        return leaf.raw;
    }).join(''), source, label + ' source conservation');
    assert.strictEqual(result.diagnostics.some(function(diagnostic) {
        return diagnostic.code === 'SYN_INTERNAL_INVARIANT' ||
            diagnostic.recovery === 'preserve-target' ||
            /Maximum call stack/i.test(diagnostic.message);
    }), false, label + ' must not hit internal fallback');
    var checked = invariants.validateSyntaxInvariants({
        root: result.root,
        leaves: result.leaves,
        source: source,
        dialect: 'hive',
        tokenTable: tokenTable.buildStructuralTokenTable(result.leaves, source)
    });
    assert.strictEqual(
        checked.ok,
        true,
        label + ' invariant failures: ' + JSON.stringify(checked.failures)
    );
}

function measureDeepBinaryChains() {
    var wide = makeAddChain(3000);
    var qualify = makeAddChain(1500);
    var cases = [
        {
            label: 'wide SELECT expression',
            source: 'SELECT ' + wide,
            expected: 'query'
        },
        {
            label: 'wide WHERE expression',
            source: 'SELECT * FROM t WHERE ' + wide + ' > 0',
            expected: 'query'
        },
        {
            label: 'wide real QUALIFY expression',
            source: 'SELECT * FROM t q QUALIFY ' + qualify + ' > 0',
            expected: 'opaque',
            requireQualify: true
        },
        {
            label: 'wide QUALIFY after alias column list',
            source: 'SELECT * FROM t q(c) QUALIFY ' + qualify + ' > 0',
            expected: 'opaque',
            requireQualify: true
        },
        {
            label: 'wide table function with alias column list',
            source: 'SELECT * FROM fn(' + qualify + ') q(c) QUALIFY flag',
            expected: 'opaque',
            requireQualify: true
        },
        {
            label: 'wide JOIN table-function continuation',
            source: 'SELECT * FROM t qualify JOIN fn(' + qualify + ') u ON true',
            expected: 'query'
        }
    ];
    var started = process.hrtime.bigint();
    cases.forEach(function(testCase) {
        var result = parser.parseSql(testCase.source, {
            dialect: 'hive',
            mode: 'document'
        });
        assertDeepResult(testCase.source, result, testCase.expected, testCase.label);
        if (testCase.requireQualify) {
            assert.ok(result.diagnostics.some(function(diagnostic) {
                return diagnostic.recovery === 'preserve-statement' &&
                    diagnostic.capabilityId === 'qualify';
            }), testCase.label + ' must retain QUALIFY capability identity');
        } else {
            assert.deepStrictEqual(result.diagnostics, [], testCase.label + ' diagnostics');
        }
    });
    return Number(process.hrtime.bigint() - started) / 1e6;
}

function measureNestedUnsupportedProofWork() {
    var originalBeginParserTrial = parserContext.beginParserTrial;
    var current = null;
    var reports = [];
    parserContext.beginParserTrial = function(context, key) {
        current.calls += 1;
        try {
            var claim = originalBeginParserTrial(context, key);
            if (claim.kind === 'execute') {
                current.chargedRangeWork += Math.max(1, key.range.end - key.range.start);
            }
            return claim;
        } catch (error) {
            current.rejectedRangeWork += Math.max(1, key.range.end - key.range.start);
            throw error;
        }
    };
    try {
        [8, 10, 14, 18, 22].forEach(function(depth) {
            var source = 'SELECT 1';
            for (var index = 0; index < depth; index++) {
                source = 'SELECT * FROM (' + source + ') q QUALIFY flag';
            }
            current = {
                calls: 0,
                chargedRangeWork: 0,
                rejectedRangeWork: 0
            };
            var started = process.hrtime.bigint();
            var result = parser.parseSql(source, {
                dialect: 'hive',
                mode: 'document'
            });
            var elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
            var syntaxLeafCount = result.leaves.filter(function(leaf) {
                return leaf.channel === 'code' || leaf.channel === 'protected';
            }).length;
            var workBudget = Math.max(64, syntaxLeafCount * 8);
            assert.ok(current.chargedRangeWork <= workBudget,
                'trial range work must stay inside the linear request budget at depth ' +
                    depth + ': ' + current.chargedRangeWork + ' > ' + workBudget);
            assert.ok(current.calls <= result.leaves.length,
                'trial call count must stay linear at depth ' + depth + ': ' +
                    current.calls + ' > ' + result.leaves.length);
            assert.strictEqual(result.diagnostics.some(function(diagnostic) {
                return diagnostic.code === 'SYN_INTERNAL_INVARIANT';
            }), false, 'depth ' + depth + ' must not reach the internal fallback');
            if (depth >= 10) {
                assert.ok(result.diagnostics.some(function(diagnostic) {
                    return diagnostic.code === 'SYN_PROOF_BUDGET' &&
                        diagnostic.capabilityId === 'qualify';
                }), 'depth ' + depth + ' must retain bounded QUALIFY recovery');
            }
            reports.push({
                depth: depth,
                sourceChars: source.length,
                syntaxLeaves: syntaxLeafCount,
                calls: current.calls,
                chargedRangeWork: current.chargedRangeWork,
                rejectedRangeWork: current.rejectedRangeWork,
                workBudget: workBudget,
                elapsedMs: elapsedMs
            });
        });
    } finally {
        parserContext.beginParserTrial = originalBeginParserTrial;
    }
    assert.ok(reports.reduce(function(total, report) {
        return total + report.elapsedMs;
    }, 0) < PARSER_PROOF_GATE_MS,
    'nested proof catastrophe gate exceeded ' + PARSER_PROOF_GATE_MS + 'ms');
    return reports;
}

function measureScaleInChild(
    mode,
    statementCount,
    coreRoot,
    warmupRounds,
    sampleCount
) {
    var source = makeSource(statementCount);
    var child = childProcess.spawnSync(
        process.execPath,
        [
            '-e',
            SCALE_WORKER_SOURCE,
            mode,
            String(statementCount),
            String(warmupRounds),
            String(sampleCount),
            coreRoot
        ],
        {
            cwd: root,
            encoding: 'utf8',
            input: source,
            maxBuffer: 1024 * 1024
        }
    );
    assert.strictEqual(
        child.status,
        0,
        mode + ' ' + statementCount + ' scale worker failed:\n' +
            String(child.stderr || child.stdout)
    );
    var measured = JSON.parse(child.stdout);
    return Object.freeze({
        statementCount: measured.statementCount,
        sourceBytes: measured.sourceBytes,
        medianMs: measured.medianMs,
        samplesMs: Object.freeze(measured.samplesMs),
        processPeakRssKb: measured.processPeakRssKb
    });
}

function measureScales(mode, coreRoot) {
    return Object.freeze(SCALE_COUNTS.map(function(statementCount) {
        return measureScaleInChild(
            mode,
            statementCount,
            coreRoot,
            SCALE_WARMUP_ROUNDS,
            SCALE_SAMPLE_COUNT
        );
    }));
}

function summarizeScaleRuns(runs) {
    assert.ok(runs.length > 0, 'scale summary requires at least one run');
    var first = runs[0];
    return Object.freeze({
        statementCount: first.statementCount,
        sourceBytes: first.sourceBytes,
        medianMs: median(runs.map(function(run) { return run.medianMs; })),
        samplesMs: Object.freeze([].concat.apply([], runs.map(function(run) {
            return run.samplesMs;
        }))),
        processMediansMs: Object.freeze(runs.map(function(run) { return run.medianMs; })),
        processPeakRssKb: Math.max.apply(null, runs.map(function(run) {
            return run.processPeakRssKb;
        }))
    });
}

function measureRelativeParserScales(baselineCoreRoot) {
    var workload = gates.manifest.workloads.parser;
    var workerPath = path.join(root, gates.manifest.workers.parser.path);
    function runRelative(coreRoot, testCase) {
        var source = makeSource(testCase.statementCount);
        assert.strictEqual(source.length, testCase.sourceCodeUnits,
            'relative parser source length must match the manifest');
        var child = childProcess.spawnSync(process.execPath, [workerPath], {
            cwd: root,
            encoding: 'utf8',
            input: source,
            maxBuffer: 2 * 1024 * 1024,
            timeout: 120000,
            env: Object.assign({}, process.env, {
                SQL_BEAUTIFY_PERF_CORE_ROOT: coreRoot,
                SQL_BEAUTIFY_PERF_COUNT: String(testCase.statementCount),
                SQL_BEAUTIFY_PERF_WARMUPS: String(workload.warmupRounds),
                SQL_BEAUTIFY_PERF_SAMPLES: String(workload.sampleRounds)
            })
        });
        assert.strictEqual(child.status, 0,
            'relative parser worker failed:\n' +
                String(child.stderr || child.stdout) + '\nerror=' +
                String(child.error || 'none'));
        var measured = JSON.parse(child.stdout);
        assert.strictEqual(measured.statementCount, testCase.statementCount);
        assert.strictEqual(measured.sourceCodeUnits, testCase.sourceCodeUnits);
        return Object.freeze({
            statementCount: measured.statementCount,
            sourceBytes: measured.sourceBytes,
            medianMs: measured.medianMs,
            samplesMs: Object.freeze(measured.samplesMs),
            processPeakRssKb: measured.processPeakRssKb
        });
    }
    return Object.freeze(workload.cases.map(function(testCase, scaleIndex) {
        var baselineRuns = [];
        var currentRuns = [];
        for (var round = 0; round < workload.processRounds; round++) {
            var runBaseline = function() {
                baselineRuns.push(runRelative(baselineCoreRoot, testCase));
            };
            var runCurrent = function() {
                currentRuns.push(runRelative(currentCoreRoot, testCase));
            };
            // Alternate order to reduce thermal/scheduler bias while keeping
            // each implementation in an independent fresh process.
            if ((scaleIndex + round) % 2 === 0) {
                runBaseline();
                runCurrent();
            } else {
                runCurrent();
                runBaseline();
            }
        }
        var baseline = summarizeScaleRuns(baselineRuns);
        var current = summarizeScaleRuns(currentRuns);
        return Object.freeze({
            statementCount: testCase.statementCount,
            baseline: baseline,
            current: current,
            currentToBaseline: current.medianMs / baseline.medianMs
        });
    }));
}

function measureAnalysisClosureCases() {
    var nestedCte = 'SELECT 1 AS v';
    for (var cteDepth = 0; cteDepth < 64; cteDepth++) {
        nestedCte = 'WITH c' + cteDepth + ' AS (' + nestedCte +
            ') SELECT v FROM c' + cteDepth;
    }
    var nestedExpression = 'SELECT ' + '('.repeat(120) + '1' + ')'.repeat(120);
    var longComment = 'SELECT 1 /*' + 'x'.repeat(250000) + '*/;';
    var cases = [
        { label: '64-level nested CTE', source: nestedCte },
        { label: '120-level nested expression', source: nestedExpression },
        { label: 'single 250k block comment', source: longComment, commentCount: 1 }
    ];
    var timings = [];
    cases.forEach(function(testCase) {
        var started = process.hrtime.bigint();
        var result = analysis.analyzeSql(testCase.source, {
            dialect: 'hive',
            mode: 'document'
        });
        var elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
        assert.strictEqual(result.status, 'analyzed', testCase.label + ' status');
        assert.strictEqual(result.leaves.map(function(leaf) { return leaf.raw; }).join(''),
            testCase.source, testCase.label + ' source conservation');
        assert.ok(result.index.nodes().length > 0, testCase.label + ' indexed nodes');
        assert.deepStrictEqual(result.index.offsetToLeaf(testCase.source.length), {
            leafId: result.leaves[result.leaves.length - 1].id,
            relativeOffset: result.leaves[result.leaves.length - 1].raw.length,
            atEnd: true
        }, testCase.label + ' EOF lookup');
        if (testCase.commentCount !== undefined) {
            assert.strictEqual(result.index.commentBindings().length,
                testCase.commentCount, testCase.label + ' comment ownership');
        }
        assert.ok(elapsedMs < ANALYSIS_CLOSURE_GATE_MS,
            testCase.label + ' exceeded ' + ANALYSIS_CLOSURE_GATE_MS + 'ms: ' + elapsedMs);
        timings.push(Object.freeze({ label: testCase.label, elapsedMs: elapsedMs }));
    });
    return Object.freeze(timings);
}

var releaseBaseline = gates.strictRelativeEnabled()
    ? baselineApi.prepareReleaseBaseline()
    : null;
var relativeParserScales = releaseBaseline === null
    ? Object.freeze([])
    : measureRelativeParserScales(releaseBaseline.coreRoot);
var parserScales = measureScales('parser', currentCoreRoot);
var current100 = parserScales[0];
var current800 = parserScales[1];
var current1200 = parserScales[2];
var ratio800 = current800.medianMs / current100.medianMs;
var ratio1200 = current1200.medianMs / current100.medianMs;
var aliases100 = measureAliasColumnLists(100);
var aliases400 = measureAliasColumnLists(400);
var aliases800 = measureAliasColumnLists(800);
var aliasRatio400 = aliases400.medianMs / aliases100.medianMs;
var aliasRatio800 = aliases800.medianMs / aliases100.medianMs;
var deepBinaryChainsMs = measureDeepBinaryChains();
var nestedUnsupportedProofs = measureNestedUnsupportedProofWork();
var analysisScales = measureScales('analysis', currentCoreRoot);
var analysis100 = analysisScales[0];
var analysis800 = analysisScales[1];
var analysis1200 = analysisScales[2];
var analysisRatio800 = analysis800.medianMs / analysis100.medianMs;
var analysisRatio1200 = analysis1200.medianMs / analysis100.medianMs;
var analysisClosureCases = measureAnalysisClosureCases();
var parentMaxRss = process.resourceUsage().maxRSS;
var maxRss = Math.max.apply(null, [parentMaxRss].concat(
    parserScales.map(function(item) { return item.processPeakRssKb; }),
    relativeParserScales.map(function(item) {
        return item.baseline.processPeakRssKb;
    }),
    analysisScales.map(function(item) { return item.processPeakRssKb; })
));

var performanceReport = {
    samples: [current100, current800, current1200].map(function(item) {
        return {
            statements: item.statementCount,
            sourceBytes: item.sourceBytes,
            medianMs: Number(item.medianMs.toFixed(2)),
            samplesMs: item.samplesMs,
            processPeakRssKb: item.processPeakRssKb
        };
    }),
    ratio800To100: Number(ratio800.toFixed(2)),
    ratio1200To100: Number(ratio1200.toFixed(2)),
    releaseRelativeBaseline: {
        enabled: gates.strictRelativeEnabled(),
        release: gates.manifest.release,
        currentToBaselineGate: gates.manifest.gates.relativeRatio,
        minimumBaselineMedianMs: gates.manifest.gates.minimumBaselineMedianMs,
        processRounds: gates.manifest.workloads.parser.processRounds,
        workerWarmupRounds: gates.manifest.workloads.parser.warmupRounds,
        workerSampleRounds: gates.manifest.workloads.parser.sampleRounds,
        compilerStrategy: gates.manifest.compiler.strategy,
        cacheHit: releaseBaseline === null ? null : releaseBaseline.cacheHit,
        isolation: 'same-node-fresh-process-pairs',
        samples: relativeParserScales.map(function(item) {
            return {
                statements: item.statementCount,
                baselineMedianMs: Number(item.baseline.medianMs.toFixed(2)),
                currentMedianMs: Number(item.current.medianMs.toFixed(2)),
                currentToBaseline: Number(item.currentToBaseline.toFixed(3)),
                baselineProcessMediansMs: item.baseline.processMediansMs,
                currentProcessMediansMs: item.current.processMediansMs
            };
        })
    },
    aliasListSamples: [aliases100, aliases400, aliases800].map(function(item) {
        return {
            relations: item.relationCount,
            medianMs: Number(item.medianMs.toFixed(2))
        };
    }),
    aliasListRatio400To100: Number(aliasRatio400.toFixed(2)),
    aliasListRatio800To100: Number(aliasRatio800.toFixed(2)),
    deepBinaryChainsMs: Number(deepBinaryChainsMs.toFixed(2)),
    nestedUnsupportedProofs: nestedUnsupportedProofs.map(function(item) {
        return {
            depth: item.depth,
            sourceChars: item.sourceChars,
            syntaxLeaves: item.syntaxLeaves,
            calls: item.calls,
            chargedRangeWork: item.chargedRangeWork,
            rejectedRangeWork: item.rejectedRangeWork,
            workBudget: item.workBudget,
            elapsedMs: Number(item.elapsedMs.toFixed(2))
        };
    }),
    analysisSamples: [analysis100, analysis800, analysis1200].map(function(item) {
        return {
            statements: item.statementCount,
            sourceBytes: item.sourceBytes,
            medianMs: Number(item.medianMs.toFixed(2)),
            samplesMs: item.samplesMs,
            processPeakRssKb: item.processPeakRssKb
        };
    }),
    analysisRatio800To100: Number(analysisRatio800.toFixed(2)),
    analysisRatio1200To100: Number(analysisRatio1200.toFixed(2)),
    analysisClosureCases: analysisClosureCases.map(function(item) {
        return {
            label: item.label,
            elapsedMs: Number(item.elapsedMs.toFixed(2))
        };
    }),
    maxRSS: maxRss,
    parentMaxRSS: parentMaxRss,
    analysisScaleWarmupRounds: SCALE_WARMUP_ROUNDS,
    analysisScaleSampleRounds: SCALE_SAMPLE_COUNT,
    scaleIsolation: 'fresh-process-per-implementation-and-scale',
    scaleRatioGate: SCALE_RATIO_GATE,
    aliasListRatio400Gate: ALIAS_RATIO_400_GATE,
    aliasListRatio800Gate: ALIAS_RATIO_800_GATE,
    analysisScaleRatioGate: ANALYSIS_SCALE_RATIO_GATE,
    analysisClosureGateMs: ANALYSIS_CLOSURE_GATE_MS
};

console.log('v2 Wave 2 parser performance baseline ' + JSON.stringify(performanceReport));

assert.ok(Number.isFinite(ratio800) && ratio800 <= SCALE_RATIO_GATE,
    '800/100 parser scale ratio exceeded ' + SCALE_RATIO_GATE + 'x: ' + ratio800);
assert.ok(Number.isFinite(ratio1200) && ratio1200 <= SCALE_RATIO_GATE,
    '1200/100 parser scale ratio exceeded ' + SCALE_RATIO_GATE + 'x: ' + ratio1200);
relativeParserScales.forEach(function(item) {
    assert.ok(
        gates.relativeGate(item.baseline.medianMs, item.current.medianMs),
        item.statementCount + ' parser regression versus manifest release baseline exceeded ' +
            gates.manifest.gates.relativeRatio + 'x or baseline workload was <' +
            gates.manifest.gates.minimumBaselineMedianMs + 'ms: ' +
            item.currentToBaseline +
            ' (baseline=' + item.baseline.medianMs + 'ms, current=' +
            item.current.medianMs + 'ms)'
    );
});
assert.strictEqual(
    gates.relativeGate(100, 200),
    false,
    'relative baseline gate must reject a synthetic 2x slowdown'
);
assert.strictEqual(gates.relativeGate(30, 1), false,
    'low baselines must require a larger workload instead of an absolute delta');
assert.strictEqual(gates.relativeGate(100, 120), true,
    'normal baselines must retain the exact 1.2x gate');
assert.strictEqual(gates.relativeGate(100, 120.01), false,
    'normal baselines must reject values above the exact 1.2x gate');
[NaN, 0, -1, Infinity].forEach(function(value) {
    assert.strictEqual(gates.relativeGate(value, 100), false);
    assert.strictEqual(gates.relativeGate(100, value), false);
});
assert.ok(Number.isFinite(aliasRatio400) && aliasRatio400 <= ALIAS_RATIO_400_GATE,
    '400/100 alias-list scale ratio exceeded ' + ALIAS_RATIO_400_GATE + 'x: ' +
        aliasRatio400);
assert.ok(Number.isFinite(aliasRatio800) && aliasRatio800 <= ALIAS_RATIO_800_GATE,
    '800/100 alias-list scale ratio exceeded ' + ALIAS_RATIO_800_GATE + 'x: ' +
        aliasRatio800);
assert.ok(Number.isFinite(deepBinaryChainsMs) &&
    deepBinaryChainsMs < ANALYSIS_CLOSURE_GATE_MS,
    'deep binary-chain probes exceeded ' + ANALYSIS_CLOSURE_GATE_MS +
        'ms: ' + deepBinaryChainsMs);
assert.ok(Number.isFinite(analysisRatio800) &&
    analysisRatio800 <= ANALYSIS_SCALE_RATIO_GATE,
    '800/100 analysis scale ratio exceeded ' + ANALYSIS_SCALE_RATIO_GATE + 'x: ' +
        analysisRatio800);
assert.ok(Number.isFinite(analysisRatio1200) &&
    analysisRatio1200 <= ANALYSIS_SCALE_RATIO_GATE,
    '1200/100 analysis scale ratio exceeded ' + ANALYSIS_SCALE_RATIO_GATE + 'x: ' +
        analysisRatio1200 + ' (100=' + analysis100.medianMs + 'ms, 1200=' +
        analysis1200.medianMs + 'ms)');
