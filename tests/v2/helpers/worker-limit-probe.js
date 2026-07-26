'use strict';

var path = require('path');
var performance = require('perf_hooks').performance;

var root = path.join(__dirname, '..', '..', '..');
var runtimePath = path.join(root, 'dist', 'runtime.cjs');
var workerPath = path.join(root, 'dist', 'formatter-worker.cjs');
var runtime = require(runtimePath);
var unit = 'select a, b, c from t where a = 1;\n';
var source = unit.repeat(Math.floor(524288 / unit.length));
source += new Array(524289 - source.length).join(' ');

async function run() {
    var executor = runtime.createProductionFormatterExecutor({
        runtimePath: runtimePath,
        workerPath: workerPath,
        thresholds: { sourceCodeUnits: 1, leafCount: 1 }
    });
    try {
        var started = performance.now();
        var result = await executor.format({
            source: source,
            options: { dialect: 'hive' },
            mode: 'document',
            documentVersion: 1,
            targetId: 'input-limit'
        });
        process.stdout.write(JSON.stringify({
            sourceCodeUnits: source.length,
            status: result.status,
            elapsedMs: performance.now() - started,
            maxRssKiB: process.resourceUsage().maxRSS,
            route: executor.lastRoute()
        }));
    } finally {
        await executor.dispose();
    }
}

run().catch(function(error) {
    console.error(error);
    process.exitCode = 1;
});
