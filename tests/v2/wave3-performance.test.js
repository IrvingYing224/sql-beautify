'use strict';

var assert = require('assert');
var childProcess = require('child_process');
var os = require('os');

function statementSource(statementCount) {
    var statements = [];
    for (var index = 0; index < statementCount; index++) {
        statements.push('SELECT ' + index + ';');
    }
    return statements.join('\n');
}

function formattedListSource(itemCount) {
    var items = [];
    for (var index = 0; index < itemCount; index++) {
        items.push(String(index));
    }
    return 'select  ' + items.join(',  ');
}

function median(values) {
    var ordered = values.slice().sort(function(left, right) {
        return left - right;
    });
    return ordered[Math.floor(ordered.length / 2)];
}

function worker(caseKind, itemCount) {
    var formatApi = require('../../.tmp/v2-core/core/api/format.js');
    var source = caseKind === 'statements'
        ? statementSource(itemCount)
        : formattedListSource(itemCount);
    var samples = [];
    var latest;
    for (var warmup = 0; warmup < 2; warmup++) {
        latest = formatApi.formatSqlWithStatistics(source, { dialect: 'hive' });
    }
    for (var sample = 0; sample < 7; sample++) {
        var started = process.hrtime.bigint();
        latest = formatApi.formatSqlWithStatistics(source, { dialect: 'hive' });
        samples.push(Number(process.hrtime.bigint() - started) / 1e6);
    }
    var cpu = os.cpus()[0];
    process.stdout.write(JSON.stringify({
        caseKind: caseKind,
        itemCount: itemCount,
        medianMs: median(samples),
        samplesMs: samples,
        sourceCodeUnits: source.length,
        outputCodeUnits: latest.result.text.length,
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

function runIsolated(caseKind, itemCount) {
    var result = childProcess.spawnSync(
        process.execPath,
        [__filename, '--worker', caseKind, String(itemCount)],
        {
            cwd: process.cwd(),
            encoding: 'utf8',
            maxBuffer: 1024 * 1024,
            timeout: 30000
        }
    );
    assert.strictEqual(
        result.status,
        0,
        'isolated Wave 3 benchmark failed:\n' +
            result.stdout + '\n' + result.stderr +
            '\nerror=' + String(result.error || 'none') +
            '\nsignal=' + String(result.signal || 'none')
    );
    return JSON.parse(result.stdout);
}

if (process.argv[2] === '--worker') {
    var kind = process.argv[3];
    var count = Number(process.argv[4]);
    if ((kind !== 'statements' && kind !== 'formatted-list') ||
        !Number.isSafeInteger(count) || count <= 0) {
        throw new Error('invalid performance case');
    }
    worker(kind, count);
} else {
    var statementReports = [100, 800, 1200].map(function(count) {
        return runIsolated('statements', count);
    });
    var formattedReports = [100, 800, 1200].map(function(count) {
        return runIsolated('formatted-list', count);
    });
    var reports = statementReports.concat(formattedReports);

    reports.forEach(function(report) {
        assert.strictEqual(
            report.status,
            report.caseKind === 'statements' ? 'unchanged' : 'formatted'
        );
        if (report.caseKind === 'statements') {
            assert.strictEqual(report.sourceCodeUnits, report.outputCodeUnits);
        } else {
            assert.strictEqual(report.sourceCodeUnits - report.outputCodeUnits, 1,
                'formatted list changes only the redundant SELECT-head space');
            assert.ok(report.statistics.docNodeCount <=
                report.statistics.leafCount + 2,
            'formatted per-leaf document count must stay linear');
        }
        assert.strictEqual(report.statistics.sourceCodeUnits, report.sourceCodeUnits);
        assert.strictEqual(report.statistics.outputCodeUnits, report.outputCodeUnits);
        assert.ok(report.medianMs < 2000,
            report.caseKind + '/' + report.itemCount + ' exceeded the disaster gate');
        assert.ok(report.statistics.planActionCount <= report.statistics.maxPlanActions);
        assert.ok(report.statistics.leafVisitCount <=
            report.statistics.leafCount * 4 + 32,
        'leaf visits must stay linear for ' + report.caseKind + '/' + report.itemCount);
        assert.ok(report.statistics.leafEmissionCount <=
            report.statistics.leafCount + 1,
        'leaf emissions must stay linear for ' + report.caseKind + '/' + report.itemCount);
        assert.ok(report.statistics.directLookupCount <=
            report.statistics.leafCount * 4 + 8,
        'direct lookups must stay linear for ' + report.caseKind + '/' + report.itemCount);
        assert.ok(report.maxRssKb > 0 && report.maxRssKb < 2 * 1024 * 1024,
            'isolated maxRssKb must stay below the 2 GiB disaster gate');
    });

    function scaleRatios(caseReports) {
        var byCount = new Map(caseReports.map(function(report) {
            return [report.itemCount, report];
        }));
        var ratio800 = byCount.get(800).medianMs / byCount.get(100).medianMs;
        var ratio1200 = byCount.get(1200).medianMs / byCount.get(100).medianMs;
        assert.ok((ratio800 / 8) <= 1.5,
            caseReports[0].caseKind + ' 800 normalized ratio must be <=1.5, got ' +
                (ratio800 / 8).toFixed(3));
        assert.ok((ratio1200 / 12) <= 1.5,
            caseReports[0].caseKind + ' 1200 normalized ratio must be <=1.5, got ' +
                (ratio1200 / 12).toFixed(3));
        return {
            items800Over100: ratio800,
            items1200Over100: ratio1200
        };
    }

    var statementRatios = scaleRatios(statementReports);
    var formattedRatios = scaleRatios(formattedReports);

    console.log('v2 Wave 3 performance baseline ' + JSON.stringify({
        reports: reports,
        ratios: {
            statements: statementRatios,
            formattedList: formattedRatios
        }
    }));
}
