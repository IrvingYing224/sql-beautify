'use strict';

var assert = require('assert');
var childProcess = require('child_process');
var inspector = require('inspector');
var path = require('path');
var v8 = require('v8');

function median(values) {
    var sorted = values.slice().sort(function(left, right) {
        return left - right;
    });
    return sorted[Math.floor(sorted.length / 2)];
}

function sourceFor(shape, size) {
    if (shape === 'list') {
        var items = [];
        for (var index = 0; index < size; index++) {
            items.push('column_' + index);
        }
        return 'select ' + items.join(', ') + ' from t';
    }
    if (shape === 'comment') {
        return '/*' + 'x'.repeat(size) + '*/\nselect 1 from t';
    }
    throw new Error('Unknown profile shape ' + shape);
}

function collectMemory() {
    assert.strictEqual(typeof global.gc, 'function',
        'profile worker requires --expose-gc');
    for (var index = 0; index < 3; index++) {
        global.gc();
    }
    var memory = process.memoryUsage();
    return {
        heapUsed: memory.heapUsed,
        heapTotal: memory.heapTotal,
        external: memory.external,
        arrayBuffers: memory.arrayBuffers,
        rss: memory.rss
    };
}

function post(session, method, params) {
    return new Promise(function(resolve, reject) {
        session.post(method, params || {}, function(error, result) {
            if (error) {
                reject(error);
                return;
            }
            resolve(result || {});
        });
    });
}

function summarizeAllocations(profile) {
    var rows = [];
    function visit(node, stack) {
        var frame = node.callFrame || {};
        var label = (frame.functionName || '(anonymous)') + ' @ ' +
            (frame.url || '(native)') + ':' + String(frame.lineNumber || 0);
        var nextStack = stack.concat(label);
        if (node.selfSize > 0) {
            rows.push({
                bytes: node.selfSize,
                site: label,
                stack: nextStack.slice(-5)
            });
        }
        (node.children || []).forEach(function(child) {
            visit(child, nextStack);
        });
    }
    visit(profile.head, []);
    rows.sort(function(left, right) { return right.bytes - left.bytes; });
    return {
        sampledBytes: rows.reduce(function(total, row) {
            return total + row.bytes;
        }, 0),
        topSites: rows.slice(0, 8)
    };
}

async function sampleStage(session, label, action) {
    await post(session, 'HeapProfiler.startSampling', {
        samplingInterval: 8192,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true
    });
    var started = process.hrtime.bigint();
    var value = action();
    var elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    var stopped = await post(session, 'HeapProfiler.stopSampling');
    return {
        label: label,
        value: value,
        elapsedMs: elapsedMs,
        allocations: summarizeAllocations(stopped.profile)
    };
}

function cloneTimings(value) {
    var samples = [];
    var cloned = structuredClone(value);
    for (var sample = 0; sample < 9; sample++) {
        var started = process.hrtime.bigint();
        cloned = structuredClone(value);
        samples.push(Number(process.hrtime.bigint() - started) / 1e6);
    }
    return {
        cloned: cloned,
        medianMs: median(samples),
        samplesMs: samples
    };
}

async function worker(shape, size) {
    var coreRoot = path.join(
        __dirname,
        '..',
        '.tmp',
        'v2-core',
        'core'
    );
    var analysisApi = require(path.join(coreRoot, 'analysis', 'index.js'));
    var compilerApi = require(path.join(coreRoot, 'layout', 'compiler.js'));
    var optionsApi = require(path.join(coreRoot, 'config', 'resolve-options.js'));
    var policyApi = require(path.join(coreRoot, 'layout', 'policy.js'));
    var rendererApi = require(path.join(coreRoot, 'renderer', 'render.js'));

    var source = sourceFor(shape, size);
    var resolved = optionsApi.resolveFormatOptions({
        dialect: 'hive',
        commaStyle: 'leading',
        keywordCase: 'upper'
    });
    assert.strictEqual(resolved.ok, true);

    var session = new inspector.Session();
    session.connect();
    await post(session, 'HeapProfiler.enable');
    var baseline = collectMemory();

    var analysisStage = await sampleStage(session, 'analysis', function() {
        return analysisApi.analyzeSql(source, {
            dialect: 'hive',
            mode: 'document'
        });
    });
    var analysis = analysisStage.value;
    assert.strictEqual(analysis.status, 'analyzed');
    var analysisMemory = collectMemory();
    var indexSnapshotBytes = v8.serialize(analysis.index.snapshot()).byteLength;
    var leafCount = analysis.leaves.length;
    var nodeCount = analysis.index.nodes().length;

    var layoutStage = await sampleStage(session, 'layout-compile', function() {
        var planned = policyApi.buildLayoutPlan(analysis, resolved.options);
        assert.strictEqual(planned.ok, true);
        var compiled = compilerApi.compileLayoutPlan(planned.plan);
        assert.strictEqual(compiled.ok, true);
        return { planned: planned, compiled: compiled };
    });
    var planned = layoutStage.value.planned;
    var compiled = layoutStage.value.compiled;
    var layoutMemory = collectMemory();

    var renderStage = await sampleStage(session, 'render', function() {
        return rendererApi.renderLayoutArtifact(compiled.artifact);
    });
    var rendered = renderStage.value;
    assert.strictEqual(rendered.ok, true);
    var renderMemory = collectMemory();
    var sourceMap = rendered.sourceMap;
    var outputText = rendered.text;
    var renderStatistics = rendered.statistics;
    var sourceMapSerializedBytes = v8.serialize(sourceMap).byteLength;

    analysisStage.value = null;
    layoutStage.value = null;
    renderStage.value = null;
    analysis = null;
    planned = null;
    compiled = null;
    rendered = null;
    var outputOnlyMemory = collectMemory();

    var beforeMapClone = collectMemory();
    var mapCloneStage = await sampleStage(session, 'source-map-clone', function() {
        return cloneTimings(sourceMap);
    });
    var mapCloneTiming = mapCloneStage.value;
    var sourceMapClone = mapCloneTiming.cloned;
    var mapCloneMemory = collectMemory();

    var formatResult = {
        status: 'formatted',
        text: outputText,
        diagnostics: [],
        sourceMap: sourceMap
    };
    var beforeResultClone = collectMemory();
    var resultCloneStage = await sampleStage(session, 'format-result-clone', function() {
        return cloneTimings(formatResult);
    });
    var resultCloneTiming = resultCloneStage.value;
    var resultClone = resultCloneTiming.cloned;
    var resultCloneMemory = collectMemory();

    assert.strictEqual(sourceMapClone.entries.length, sourceMap.entries.length);
    assert.strictEqual(resultClone.text, outputText);
    await post(session, 'HeapProfiler.disable');
    session.disconnect();

    var report = {
        shape: shape,
        size: size,
        sourceCodeUnits: source.length,
        outputCodeUnits: outputText.length,
        leafCount: leafCount,
        nodeCount: nodeCount,
        sourceMapEntryCount: sourceMap.entries.length,
        indexSnapshotBytes: indexSnapshotBytes,
        sourceMapSerializedBytes: sourceMapSerializedBytes,
        renderStatistics: renderStatistics,
        retained: {
            baseline: baseline,
            analysis: analysisMemory,
            layout: layoutMemory,
            render: renderMemory,
            outputOnly: outputOnlyMemory,
            analysisHeapDelta: analysisMemory.heapUsed - baseline.heapUsed,
            layoutHeapDelta: layoutMemory.heapUsed - analysisMemory.heapUsed,
            renderHeapDelta: renderMemory.heapUsed - layoutMemory.heapUsed,
            outputOnlyHeapDelta: outputOnlyMemory.heapUsed - baseline.heapUsed,
            releasedPipelineHeap:
                renderMemory.heapUsed - outputOnlyMemory.heapUsed
        },
        sourceMapClone: {
            medianMs: mapCloneTiming.medianMs,
            samplesMs: mapCloneTiming.samplesMs,
            heapDelta:
                mapCloneMemory.heapUsed - beforeMapClone.heapUsed,
            allocations: mapCloneStage.allocations
        },
        formatResultClone: {
            medianMs: resultCloneTiming.medianMs,
            samplesMs: resultCloneTiming.samplesMs,
            heapDelta:
                resultCloneMemory.heapUsed - beforeResultClone.heapUsed,
            allocations: resultCloneStage.allocations
        },
        stages: {
            analysis: {
                elapsedMs: analysisStage.elapsedMs,
                allocations: analysisStage.allocations
            },
            layoutCompile: {
                elapsedMs: layoutStage.elapsedMs,
                allocations: layoutStage.allocations
            },
            render: {
                elapsedMs: renderStage.elapsedMs,
                allocations: renderStage.allocations
            }
        },
        maxRssKiB: process.resourceUsage().maxRSS
    };
    process.stdout.write(JSON.stringify(report));
}

function runWorker(shape, size) {
    var result = childProcess.spawnSync(
        process.execPath,
        [
            '--expose-gc',
            __filename,
            '--worker',
            shape,
            String(size)
        ],
        {
            cwd: path.join(__dirname, '..'),
            encoding: 'utf8',
            timeout: 60000,
            maxBuffer: 8 * 1024 * 1024
        }
    );
    assert.strictEqual(result.status, 0,
        shape + '/' + size + ' profile worker failed:\n' +
        result.stdout + '\n' + result.stderr);
    return JSON.parse(result.stdout);
}

function main() {
    var cases = [
        ['list', 1000],
        ['list', 4000],
        ['comment', 50000]
    ];
    if (process.argv.indexOf('--extended') >= 0) {
        cases.push(['list', 8000]);
        cases.push(['comment', 200000]);
    }
    var reports = cases.map(function(value) {
        return runWorker(value[0], value[1]);
    });
    var listReports = reports.filter(function(report) {
        return report.shape === 'list';
    });
    reports.forEach(function(report) {
        assert.ok(report.sourceMapEntryCount > 0);
        assert.ok(report.sourceMapSerializedBytes > 0);
        assert.ok(report.maxRssKiB < 1.25 * 1024 * 1024);
    });
    listReports.forEach(function(report) {
        assert.ok(report.sourceMapClone.medianMs < 1000);
        assert.ok(report.formatResultClone.medianMs < 1000);
    });
    if (listReports.length >= 2) {
        var small = listReports[0];
        var large = listReports[1];
        var inputRatio = large.sourceCodeUnits / small.sourceCodeUnits;
        assert.ok(
            large.sourceMapEntryCount / small.sourceMapEntryCount <=
                inputRatio * 1.5,
            'source-map entry growth must remain linear'
        );
        assert.ok(
            large.sourceMapClone.medianMs /
                Math.max(small.sourceMapClone.medianMs, 0.1) <=
                inputRatio * 2,
            'source-map clone growth must remain bounded'
        );
    }
    var result = {
        environment: {
            node: process.version,
            platform: process.platform,
            arch: process.arch
        },
        reports: reports
    };
    if (process.argv.indexOf('--summary') >= 0) {
        result = {
            environment: result.environment,
            reports: reports.map(function(report) {
                return {
                    shape: report.shape,
                    size: report.size,
                    sourceCodeUnits: report.sourceCodeUnits,
                    leafCount: report.leafCount,
                    nodeCount: report.nodeCount,
                    sourceMapEntryCount: report.sourceMapEntryCount,
                    indexSnapshotBytes: report.indexSnapshotBytes,
                    sourceMapSerializedBytes: report.sourceMapSerializedBytes,
                    retained: {
                        analysisHeapDelta: report.retained.analysisHeapDelta,
                        layoutHeapDelta: report.retained.layoutHeapDelta,
                        renderHeapDelta: report.retained.renderHeapDelta,
                        outputOnlyHeapDelta: report.retained.outputOnlyHeapDelta,
                        releasedPipelineHeap: report.retained.releasedPipelineHeap
                    },
                    sourceMapClone: {
                        medianMs: report.sourceMapClone.medianMs,
                        heapDelta: report.sourceMapClone.heapDelta
                    },
                    formatResultClone: {
                        medianMs: report.formatResultClone.medianMs,
                        heapDelta: report.formatResultClone.heapDelta
                    },
                    maxRssKiB: report.maxRssKiB
                };
            })
        };
    }
    console.log(JSON.stringify(result, null, 2));
}

if (process.argv[2] === '--worker') {
    worker(process.argv[3], Number(process.argv[4])).catch(function(error) {
        console.error(error);
        process.exitCode = 1;
    });
} else {
    main();
}
