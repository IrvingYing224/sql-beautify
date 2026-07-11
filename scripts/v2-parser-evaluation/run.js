var assert = require('assert');
var fs = require('fs');
var path = require('path');
var renderer = require('./report');

var mode = process.argv[2];
if (mode != '--write' && mode != '--verify') {
    throw new Error('usage: node scripts/v2-parser-evaluation/run.js --write|--verify');
}

var cases = require('../../tests/fixtures/v2-parser-evaluation-cases');
var evaluator = require('./evaluator');
var candidate = require('./candidates/dt-sql-parser');
var probe = require('./probe-dt-sql-parser').probe_dt_sql_parser(candidate);
var report = evaluator.evaluate_candidate(candidate, cases, probe);
var technicalRoot = path.join(process.cwd(), 'docs', 'technical');
var reportPath = path.join(technicalRoot, 'v2-parser-evaluation-report.md');
var adrPath = path.join(technicalRoot, 'adr', '0001-v2-parser-backend.md');

function is_positive_finite(value) {
    return typeof value == 'number' && Number.isFinite(value) && value > 0;
}

function validate_measured_evidence(value) {
    var rateFields = [
        'requiredParseRate',
        'invalidRejectRate',
        'sourceRoundTripRate',
        'requiredNodeSpanRate',
        'nativeTokenPartitionRate',
        'nativeTokenCoverageRate',
        'nativeAtomicLexemeRate',
    ];
    rateFields.forEach(function(field) {
        assert.ok(
            typeof value.summary[field] == 'number'
                && Number.isFinite(value.summary[field])
                && value.summary[field] >= 0
                && value.summary[field] <= 1,
            'evidence ' + field + ' must be a finite rate'
        );
    });
    ['coldStartMedianMs', 'parse100MedianMs', 'parse800MedianMs', 'parse1200MedianMs', 'scaleRatio'].forEach(function(field) {
        assert.ok(is_positive_finite(value.probe[field]), 'evidence ' + field + ' must be positive and finite');
    });
    assert.ok(Number.isInteger(value.probe.bundleBytes) && value.probe.bundleBytes > 0, 'evidence bundle bytes');
    assert.ok(Number.isInteger(value.probe.gzipBytes) && value.probe.gzipBytes > 0, 'evidence gzip bytes');
    assert.ok(Number.isInteger(value.probe.maxRssKb) && value.probe.maxRssKb > 0, 'evidence max RSS');
    assert.strictEqual(value.probe.bundleEntry, 'esm-named-hive', 'evidence bundle entry');
    ['node', 'platform', 'arch', 'cpu'].forEach(function(field) {
        assert.ok(
            typeof value.probe.environment[field] == 'string'
                && value.probe.environment[field].trim().length > 0,
            'evidence environment ' + field
        );
    });
    assert.ok(Array.isArray(value.probe.bundledPackages) && value.probe.bundledPackages.length > 0, 'evidence packages');
    var expectedScaleRatio = value.probe.parse800MedianMs / Math.max(0.001, value.probe.parse100MedianMs);
    var scaleTolerance = Math.max(1e-12, Math.abs(expectedScaleRatio) * 1e-12);
    assert.ok(
        Math.abs(value.probe.scaleRatio - expectedScaleRatio) <= scaleTolerance,
        'evidence scale ratio must match measured medians'
    );
    var grammarPass = value.summary.requiredParseRate >= value.gates.requiredParseRate
        && value.summary.invalidRejectRate >= value.gates.invalidRejectRate
        && value.summary.sourceRoundTripRate >= value.gates.sourceRoundTripRate
        && value.summary.requiredNodeSpanRate >= value.gates.requiredNodeSpanRate;
    var packagingPass = value.probe.bundleBytes <= value.gates.maxBundleBytes
        && value.probe.gzipBytes <= value.gates.maxGzipBytes;
    var performancePass = value.probe.coldStartMedianMs <= value.gates.maxColdStartMedianMs
        && value.probe.scaleRatio <= value.gates.maxScaleRatio;
    var tokenOwnershipPass = value.summary.sourceRoundTripRate >= value.gates.sourceRoundTripRate
        && value.summary.nativeTokenPartitionRate >= value.gates.nativeTokenPartitionRate
        && value.summary.nativeTokenCoverageRate >= value.gates.nativeTokenCoverageRate
        && value.summary.nativeAtomicLexemeRate >= value.gates.nativeAtomicLexemeRate;
    assert.strictEqual(value.decision.grammarPass, grammarPass, 'grammar gate matches evidence');
    assert.strictEqual(value.decision.packagingPass, packagingPass, 'packaging gate matches evidence');
    assert.strictEqual(value.decision.performancePass, performancePass, 'performance gate matches evidence');
    assert.strictEqual(value.decision.tokenOwnershipPass, tokenOwnershipPass, 'ownership gate matches evidence');
    assert.strictEqual(value.decision.canOwnLeafStream, tokenOwnershipPass, 'leaf ownership matches evidence');
    var expectedRole = 'rejected';
    if (grammarPass && value.decision.licensePass) {
        expectedRole = packagingPass && performancePass
            ? 'runtime-grammar-backend'
            : 'development-oracle';
    }
    assert.strictEqual(value.decision.role, expectedRole, 'role matches measured gates');
}

function deterministic_evidence(value) {
    return {
        candidate: value.candidate,
        gates: value.gates,
        outcomes: value.outcomes,
        summary: value.summary,
        probe: {
            bundleEntry: value.probe.bundleEntry,
            bundleBytes: value.probe.bundleBytes,
            gzipBytes: value.probe.gzipBytes,
            bundledPackages: value.probe.bundledPackages,
        },
        decision: {
            canOwnLeafStream: value.decision.canOwnLeafStream,
            tokenOwnershipPass: value.decision.tokenOwnershipPass,
            grammarPass: value.decision.grammarPass,
            licensePass: value.decision.licensePass,
            packagingPass: value.decision.packagingPass,
        },
    };
}

function public_summary(value) {
    return {
        candidate: value.candidate,
        decision: value.decision,
        summary: value.summary,
        probe: value.probe,
    };
}

validate_measured_evidence(report);
if (mode == '--write') {
    fs.mkdirSync(path.dirname(adrPath), { recursive: true });
    fs.writeFileSync(reportPath, renderer.render_report(report));
    fs.writeFileSync(adrPath, renderer.render_adr(report));
    console.log(JSON.stringify(public_summary(report), null, 2));
} else {
    var committedReportDocument = fs.readFileSync(reportPath, 'utf8');
    var committedAdrDocument = fs.readFileSync(adrPath, 'utf8');
    var committedReport = renderer.extract_evidence(committedReportDocument);
    var committedAdr = renderer.extract_evidence(committedAdrDocument);
    assert.deepStrictEqual(committedAdr, committedReport, 'report and ADR embedded evidence must match');
    validate_measured_evidence(committedReport);
    assert.strictEqual(
        committedReportDocument,
        renderer.render_report(committedReport),
        'committed report must be rendered from its embedded evidence'
    );
    assert.strictEqual(
        committedAdrDocument,
        renderer.render_adr(committedReport),
        'committed ADR must be rendered from its embedded evidence'
    );
    assert.deepStrictEqual(
        deterministic_evidence(report),
        deterministic_evidence(committedReport),
        'committed deterministic parser evidence is stale'
    );
    assert.strictEqual(
        report.decision.performancePass,
        committedReport.decision.performancePass,
        'current performance threshold conclusion differs from committed evidence'
    );
    assert.strictEqual(
        report.decision.role,
        committedReport.decision.role,
        'current measured role differs from committed evidence'
    );
    console.log('v2 parser evidence verification passed');
    console.log(JSON.stringify(public_summary(report), null, 2));
}
