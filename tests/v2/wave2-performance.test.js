'use strict';

var assert = require('assert');
var childProcess = require('child_process');
var fs = require('fs');
var os = require('os');
var path = require('path');

var root = path.join(__dirname, '..', '..');
var currentCoreRoot = path.join(root, '.tmp', 'v2-core');
var parser = require(path.join(currentCoreRoot, 'core', 'syntax', 'parser.js'));
var analysis = require(path.join(currentCoreRoot, 'core', 'analysis', 'index.js'));
var invariants = require(path.join(currentCoreRoot, 'core', 'syntax', 'invariants.js'));
var tokenTable = require(path.join(currentCoreRoot, 'core', 'syntax', 'token-table.js'));

var ALIAS_SAMPLE_COUNT = 5;
var SCALE_SAMPLE_COUNT = 9;
var SCALE_WARMUP_ROUNDS = 3;
var SCALE_COUNTS = Object.freeze([100, 800, 1200]);
var SCALE_RATIO_GATE = 12;
var WAVE2B_BASELINE_COMMIT = '67de251db4e66c167d2988ff4b971a24bb56aaec';
var WAVE2B_RELATIVE_GATE = 1.2;
var RELATIVE_PROCESS_ROUNDS = 3;
var RELATIVE_WORKER_SAMPLE_COUNT = 5;
var RELATIVE_WORKER_WARMUP_ROUNDS = 2;
var ALIAS_RATIO_400_GATE = 8;
var ALIAS_RATIO_800_GATE = 12;
var ANALYSIS_SCALE_RATIO_GATE = 12;
var ANALYSIS_CLOSURE_GATE_MS = 2500;

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
    var statements = [];
    for (var i = 0; i < statementCount; i++) {
        // Keep every statement byte-equivalent so a statement-count ratio is
        // also a source-size ratio; variable-width ids bias the 1,200 case.
        var suffix = String(i).padStart(4, '0');
        statements.push([
            'WITH source_' + suffix + ' AS (',
            'SELECT id, ROW_NUMBER() OVER (PARTITION BY id ORDER BY ts DESC) AS rn',
            'FROM fact_' + suffix + " WHERE ds = '2026-07-13'",
            ') SELECT s.id, d.name FROM source_' + suffix + ' s',
            'LEFT OUTER JOIN dim_' + suffix + ' d ON s.id = d.id',
            'WHERE s.rn = 1 DISTRIBUTE BY s.id SORT BY d.name DESC LIMIT 100;'
        ].join('\n'));
    }
    return statements.join('\n');
}

function median(values) {
    var sorted = values.slice().sort(function(a, b) { return a - b; });
    return sorted[Math.floor(sorted.length / 2)];
}

function passesWave2bRelativeGate(currentMedianMs, baselineMedianMs) {
    var ratio = currentMedianMs / baselineMedianMs;
    return (
        baselineMedianMs > 0 &&
        Number.isFinite(ratio) &&
        ratio <= WAVE2B_RELATIVE_GATE
    );
}

function runRequired(command, args, options, label) {
    var result = childProcess.spawnSync(command, args, options);
    if (result.error || result.status !== 0) {
        throw new Error(
            label + ' failed' +
            (result.error ? ': ' + result.error.message : ':\n' + String(result.stderr || result.stdout))
        );
    }
    return result;
}

function prepareWave2bBaseline() {
    runRequired(
        'git',
        ['cat-file', '-e', WAVE2B_BASELINE_COMMIT + '^{commit}'],
        { cwd: root, encoding: 'utf8' },
        'Wave 2B baseline lookup (checkout must retain full git history)'
    );
    runRequired(
        'git',
        ['merge-base', '--is-ancestor', WAVE2B_BASELINE_COMMIT, 'HEAD'],
        { cwd: root, encoding: 'utf8' },
        'Wave 2B baseline ancestry check'
    );

    var checkoutRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sql-beautify-wave2b-'));
    try {
        var listed = runRequired(
            'git',
            [
                'ls-tree',
                '-r',
                '-z',
                '--name-only',
                WAVE2B_BASELINE_COMMIT,
                '--',
                'src'
            ],
            { cwd: root, encoding: null },
            'Wave 2B baseline source listing'
        );
        var sourcePaths = listed.stdout.toString('utf8').split('\0').filter(Boolean);
        sourcePaths.push('tsconfig.v2.json', 'tsconfig.v2.build.json');
        sourcePaths.forEach(function(relativePath) {
            var file = runRequired(
                'git',
                ['show', WAVE2B_BASELINE_COMMIT + ':' + relativePath],
                { cwd: root, encoding: null },
                'Wave 2B baseline file ' + relativePath
            );
            var destination = path.join(checkoutRoot, relativePath);
            fs.mkdirSync(path.dirname(destination), { recursive: true });
            fs.writeFileSync(destination, file.stdout);
        });
        runRequired(
            process.execPath,
            [
                require.resolve('typescript/bin/tsc'),
                '-p',
                path.join(checkoutRoot, 'tsconfig.v2.build.json')
            ],
            { cwd: checkoutRoot, encoding: 'utf8', env: process.env },
            'Wave 2B baseline build'
        );
        var coreRoot = path.join(checkoutRoot, '.tmp', 'v2-core');
        assert.ok(
            fs.existsSync(path.join(coreRoot, 'core', 'syntax', 'parser.js')),
            'Wave 2B baseline build must produce the parser'
        );
        return Object.freeze({
            checkoutRoot: checkoutRoot,
            coreRoot: coreRoot
        });
    } catch (error) {
        fs.rmSync(checkoutRoot, { recursive: true, force: true });
        throw error;
    }
}

function removeWave2bBaseline(baseline) {
    fs.rmSync(baseline.checkoutRoot, { recursive: true, force: true });
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
    return Object.freeze(SCALE_COUNTS.map(function(statementCount, scaleIndex) {
        var baselineRuns = [];
        var currentRuns = [];
        for (var round = 0; round < RELATIVE_PROCESS_ROUNDS; round++) {
            var runBaseline = function() {
                baselineRuns.push(measureScaleInChild(
                    'parser',
                    statementCount,
                    baselineCoreRoot,
                    RELATIVE_WORKER_WARMUP_ROUNDS,
                    RELATIVE_WORKER_SAMPLE_COUNT
                ));
            };
            var runCurrent = function() {
                currentRuns.push(measureScaleInChild(
                    'parser',
                    statementCount,
                    currentCoreRoot,
                    RELATIVE_WORKER_WARMUP_ROUNDS,
                    RELATIVE_WORKER_SAMPLE_COUNT
                ));
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
            statementCount: statementCount,
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

var wave2bBaseline = prepareWave2bBaseline();
var relativeParserScales;
try {
    relativeParserScales = measureRelativeParserScales(wave2bBaseline.coreRoot);
} finally {
    removeWave2bBaseline(wave2bBaseline);
}
var parserScales = Object.freeze(relativeParserScales.map(function(item) {
    return item.current;
}));
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
    wave2bRelativeBaseline: {
        commit: WAVE2B_BASELINE_COMMIT,
        currentToBaselineGate: WAVE2B_RELATIVE_GATE,
        processRounds: RELATIVE_PROCESS_ROUNDS,
        workerWarmupRounds: RELATIVE_WORKER_WARMUP_ROUNDS,
        workerSampleRounds: RELATIVE_WORKER_SAMPLE_COUNT,
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
        passesWave2bRelativeGate(item.current.medianMs, item.baseline.medianMs),
        item.statementCount + ' parser regression versus committed Wave 2B baseline exceeded ' +
            WAVE2B_RELATIVE_GATE + 'x: ' + item.currentToBaseline +
            ' (baseline=' + item.baseline.medianMs + 'ms, current=' +
            item.current.medianMs + 'ms)'
    );
});
assert.strictEqual(
    passesWave2bRelativeGate(200, 100),
    false,
    'relative baseline gate must reject a synthetic 2x slowdown'
);
assert.ok(Number.isFinite(aliasRatio400) && aliasRatio400 <= ALIAS_RATIO_400_GATE,
    '400/100 alias-list scale ratio exceeded ' + ALIAS_RATIO_400_GATE + 'x: ' +
        aliasRatio400);
assert.ok(Number.isFinite(aliasRatio800) && aliasRatio800 <= ALIAS_RATIO_800_GATE,
    '800/100 alias-list scale ratio exceeded ' + ALIAS_RATIO_800_GATE + 'x: ' +
        aliasRatio800);
assert.ok(Number.isFinite(deepBinaryChainsMs) && deepBinaryChainsMs < 2500,
    'deep binary-chain probes exceeded 2500ms: ' + deepBinaryChainsMs);
assert.ok(Number.isFinite(analysisRatio800) &&
    analysisRatio800 <= ANALYSIS_SCALE_RATIO_GATE,
    '800/100 analysis scale ratio exceeded ' + ANALYSIS_SCALE_RATIO_GATE + 'x: ' +
        analysisRatio800);
assert.ok(Number.isFinite(analysisRatio1200) &&
    analysisRatio1200 <= ANALYSIS_SCALE_RATIO_GATE,
    '1200/100 analysis scale ratio exceeded ' + ANALYSIS_SCALE_RATIO_GATE + 'x: ' +
        analysisRatio1200 + ' (100=' + analysis100.medianMs + 'ms, 1200=' +
        analysis1200.medianMs + 'ms)');
