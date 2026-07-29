'use strict';

var crypto = require('crypto');
var os = require('os');
var path = require('path');
var workloads = require('./perf-workloads');

function median(values) {
    var ordered = values.slice().sort(function(left, right) {
        return left - right;
    });
    return ordered[Math.floor(ordered.length / 2)];
}

function digest(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function main() {
    var coreRoot = process.env.SQL_BEAUTIFY_PERF_CORE_ROOT;
    var kind = process.env.SQL_BEAUTIFY_PERF_KIND;
    var count = Number(process.env.SQL_BEAUTIFY_PERF_COUNT);
    var warmupRounds = Number(process.env.SQL_BEAUTIFY_PERF_WARMUPS);
    var sampleRounds = Number(process.env.SQL_BEAUTIFY_PERF_SAMPLES);
    if (typeof coreRoot !== 'string' || coreRoot.length === 0 ||
        (kind !== 'statements' && kind !== 'formatted-list') ||
        !Number.isSafeInteger(count) || count <= 0 ||
        !Number.isSafeInteger(warmupRounds) || warmupRounds < 0 ||
        !Number.isSafeInteger(sampleRounds) || sampleRounds < 3) {
        throw new Error('invalid format relative benchmark input');
    }
    var formatApi = require(path.join(coreRoot, 'core', 'api', 'format.js'));
    var source = kind === 'statements'
        ? workloads.statementSource(count)
        : workloads.formattedListSource(count);
    var latest;
    for (var warmup = 0; warmup < warmupRounds; warmup++) {
        latest = formatApi.formatSqlWithStatistics(source, { dialect: 'hive' });
    }
    var samples = [];
    for (var sample = 0; sample < sampleRounds; sample++) {
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
}

try {
    main();
} catch (error) {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
}
