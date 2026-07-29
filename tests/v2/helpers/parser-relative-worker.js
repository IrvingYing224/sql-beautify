'use strict';

var fs = require('fs');
var path = require('path');

function median(values) {
    var ordered = values.slice().sort(function(left, right) {
        return left - right;
    });
    return ordered[Math.floor(ordered.length / 2)];
}

function main() {
    var coreRoot = process.env.SQL_BEAUTIFY_PERF_CORE_ROOT;
    var statementCount = Number(process.env.SQL_BEAUTIFY_PERF_COUNT);
    var warmupRounds = Number(process.env.SQL_BEAUTIFY_PERF_WARMUPS);
    var sampleRounds = Number(process.env.SQL_BEAUTIFY_PERF_SAMPLES);
    if (typeof coreRoot !== 'string' || coreRoot.length === 0 ||
        !Number.isSafeInteger(statementCount) || statementCount <= 0 ||
        !Number.isSafeInteger(warmupRounds) || warmupRounds < 0 ||
        !Number.isSafeInteger(sampleRounds) || sampleRounds < 3) {
        throw new Error('invalid parser relative benchmark input');
    }
    var parser = require(path.join(coreRoot, 'core', 'syntax', 'parser.js'));
    var source = fs.readFileSync(0, 'utf8');
    function execute() {
        return parser.parseSql(source, { dialect: 'hive', mode: 'document' });
    }
    function assertResult(result) {
        var statements = result.root.children;
        if (statements.length !== statementCount ||
            !statements.every(function(statement) {
                return statement.statementKind === 'query';
            }) ||
            result.leaves.map(function(leaf) { return leaf.raw; }).join('') !== source) {
            throw new Error('parser relative worker returned an invalid result');
        }
    }
    for (var warmup = 0; warmup < warmupRounds; warmup++) {
        assertResult(execute());
    }
    var samples = [];
    for (var sample = 0; sample < sampleRounds; sample++) {
        var started = process.hrtime.bigint();
        var result = execute();
        samples.push(Number(process.hrtime.bigint() - started) / 1e6);
        assertResult(result);
    }
    process.stdout.write(JSON.stringify({
        statementCount: statementCount,
        sourceCodeUnits: source.length,
        sourceBytes: Buffer.byteLength(source, 'utf8'),
        medianMs: median(samples),
        samplesMs: samples,
        processPeakRssKb: process.resourceUsage().maxRSS
    }));
}

try {
    main();
} catch (error) {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
}
