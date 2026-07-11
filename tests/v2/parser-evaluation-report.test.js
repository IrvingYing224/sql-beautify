var fs = require('fs');
var path = require('path');
var assert = require('assert');
var renderer = require('../../scripts/v2-parser-evaluation/report');
var cases = require('../fixtures/v2-parser-evaluation-cases');
var reportPath = path.join(__dirname, '..', '..', 'docs', 'technical', 'v2-parser-evaluation-report.md');
var adrPath = path.join(__dirname, '..', '..', 'docs', 'technical', 'adr', '0001-v2-parser-backend.md');
var report = fs.readFileSync(reportPath, 'utf8');
var adr = fs.readFileSync(adrPath, 'utf8');
var sharedMethodEvidence = [
    'Evaluation uses a dev-only esbuild CommonJS (CJS) interoperability bundle; the minified and gzip bundle byte measurements remain recorded against their thresholds.',
    'Cold start measures loading that bundle, constructing `HiveSQL`, and validating `SELECT 1`.',
    '`maxRssKb` is the evaluation process upper watermark, not isolated parser heap.',
];
var fixtureDirectLoadEvidence = 'On the recorded Node environment, directly loading pinned '
    + '`dt-sql-parser@4.5.0` failed with stable error code `ERR_FIXTURE_DIRECT_LOAD`.';
var committedDirectLoadEvidence = 'On the recorded Node environment, directly loading pinned '
    + '`dt-sql-parser@4.5.0` failed with stable error code `ERR_UNSUPPORTED_DIR_IMPORT`.';
var fixture = {
    candidate: {
        name: 'dt-sql-parser',
        version: '4.5.0',
        license: 'MIT',
    },
    gates: {
        maxBundleBytes: 1024,
        maxGzipBytes: 512,
        maxColdStartMedianMs: 50,
        maxScaleRatio: 9,
    },
    outcomes: [
        {
            id: 'fixture-invalid',
            expectation: 'invalid',
            accepted: false,
            errors: [
                'unexpected | token\nsecond <line>',
                'path\\tail & detail',
            ],
            nodeCount: 0,
            nodeSpansValid: false,
            roundTrip: true,
            atomicPassed: 1,
            atomicTotal: 2,
        },
    ],
    summary: {
        totalCases: 1,
        requiredParseRate: 0.5,
        invalidRejectRate: 1,
        roundTripRate: 1,
        requiredNodeSpanRate: 0.25,
        atomicLexemeRate: 0.5,
    },
    probe: {
        bundleBytes: 123,
        gzipBytes: 45,
        coldStartMedianMs: 12.345,
        parse100MedianMs: 2.345,
        parse800MedianMs: 15.678,
        parse1200MedianMs: 24.567,
        scaleRatio: 6.789,
        maxRssKb: 67890,
        environment: {
            node: 'v20.11.1',
            platform: 'linux',
            arch: 'x64',
            cpu: 'Fixture CPU',
        },
        directLoad: {
            success: false,
            errorCode: 'ERR_FIXTURE_DIRECT_LOAD',
        },
        bundledPackages: [
            { name: 'fixture-package', version: '1.0.0', license: 'MIT' },
        ],
    },
    decision: {
        role: 'development-oracle',
        canOwnLeafStream: false,
        grammarPass: true,
        licensePass: true,
        packagingPass: false,
        performancePass: true,
    },
};
var renderedReport = renderer.render_report(fixture);
var renderedAdr = renderer.render_adr(fixture);

assert.ok(renderedReport.indexOf('- Decision: development-oracle') >= 0, 'fixture report exact role');
assert.ok(renderedAdr.indexOf('- Decision role: development-oracle') >= 0, 'fixture ADR exact role');
assert.ok(
    renderedAdr.indexOf('Keep dt-sql-parser as a development-only differential oracle; implement the production grammar backend in-project.') >= 0,
    'fixture ADR exact role consequence'
);
assert.ok(renderedReport.indexOf('| Required parse rate | 50.00% | 100.00% |') >= 0, 'fixture correctness gate');
assert.ok(renderedReport.indexOf('| Minified bundle bytes | 123 | <= 1024 |') >= 0, 'fixture bundle gate');
assert.ok(renderedReport.indexOf('| Gzip bundle bytes | 45 | <= 512 |') >= 0, 'fixture gzip gate');
assert.ok(renderedReport.indexOf('| Cold start median ms | 12.35 | <= 50 |') >= 0, 'fixture cold-start gate');
assert.ok(renderedReport.indexOf('| 8x scale ratio | 6.79 | <= 9 |') >= 0, 'fixture scale gate');
assert.ok(renderedReport.indexOf('- Grammar: pass') >= 0, 'fixture grammar gate result');
assert.ok(renderedReport.indexOf('- License: pass') >= 0, 'fixture license gate result');
assert.ok(renderedReport.indexOf('- Packaging: fail') >= 0, 'fixture packaging gate result');
assert.ok(renderedReport.indexOf('- Performance: pass') >= 0, 'fixture performance gate result');
assert.ok(
    renderedReport.indexOf('| Case | Expected | Accepted | Errors | Round trip | Node ranges | Nodes | Atomic passed/total |') >= 0,
    'fixture report per-case evidence columns'
);
sharedMethodEvidence.concat([fixtureDirectLoadEvidence]).forEach(function(fragment) {
    assert.ok(renderedReport.indexOf(fragment) >= 0, 'fixture report method evidence: ' + fragment);
    assert.ok(renderedAdr.indexOf(fragment) >= 0, 'fixture ADR method evidence: ' + fragment);
});
assert.strictEqual(
    renderedReport.indexOf('ERR_UNSUPPORTED_DIR_IMPORT'),
    -1,
    'fixture report must not hardcode the committed direct-load error'
);
var successfulDirectLoadFixture = Object.assign({}, fixture, {
    probe: Object.assign({}, fixture.probe, {
        directLoad: { success: true, errorCode: null },
    }),
});
var successfulDirectLoadReport = renderer.render_report(successfulDirectLoadFixture);
var successfulDirectLoadAdr = renderer.render_adr(successfulDirectLoadFixture);
var successfulDirectLoadEvidence = 'On the recorded Node environment, directly loading pinned '
    + '`dt-sql-parser@4.5.0` succeeded.';
assert.ok(successfulDirectLoadReport.indexOf(successfulDirectLoadEvidence) >= 0, 'fixture report direct-load success');
assert.ok(successfulDirectLoadAdr.indexOf(successfulDirectLoadEvidence) >= 0, 'fixture ADR direct-load success');
assert.ok(
    renderedReport.indexOf('| fixture-invalid | invalid | false | unexpected &#124; token<br>second &lt;line&gt;<br>path&#92;tail &amp; detail | true | false | 0 | 1/2 |') >= 0,
    'fixture report renders safe errors and atomic counts'
);
assert.ok(
    renderedReport.indexOf('| Environment | v20.11.1 / linux-x64 / Fixture CPU | recorded |') >= 0,
    'fixture report renders complete environment'
);
assert.ok(
    renderedAdr.indexOf('- Environment: v20.11.1 / linux-x64 / Fixture CPU') >= 0,
    'fixture ADR renders complete environment'
);

assert.ok(report.indexOf('dt-sql-parser@4.5.0') >= 0, 'committed exact candidate version');
assert.ok(report.indexOf('Required parse rate') >= 0, 'committed correctness evidence');
assert.ok(report.indexOf('Required case node-range rate') >= 0, 'committed source-range evidence');
assert.ok(report.indexOf('8x scale ratio') >= 0, 'committed scaling evidence');
assert.ok(report.indexOf('Maximum RSS KiB') >= 0, 'committed memory evidence');
assert.ok(report.indexOf('## Evaluation Method and Limitations') >= 0, 'committed report method section');
assert.ok(adr.indexOf('## Evaluation Method and Limitations') >= 0, 'committed ADR method section');
sharedMethodEvidence.concat([committedDirectLoadEvidence]).forEach(function(fragment) {
    assert.ok(report.indexOf(fragment) >= 0, 'committed report method evidence: ' + fragment);
    assert.ok(adr.indexOf(fragment) >= 0, 'committed ADR method evidence: ' + fragment);
});
assert.strictEqual(cases.length, 16, 'evaluation corpus size');
cases.forEach(function(testCase) {
    var line = report.split('\n').filter(function(value) {
        return value.indexOf('| ' + testCase.id + ' |') == 0;
    })[0];
    assert.ok(line, 'committed per-case evidence for ' + testCase.id);
    var cells = line.slice(2, -2).split(' | ');
    assert.strictEqual(cells.length, 8, 'committed per-case evidence fields for ' + testCase.id);
    assert.ok(/^\d+\/\d+$/.test(cells[7]), 'committed atomic passed/total for ' + testCase.id);
});
[
    '- antlr4-c3@3.3.7 — MIT',
    '- antlr4ng@2.0.11 — BSD-3-Clause',
    '- dt-sql-parser@4.5.0 — MIT',
].forEach(function(packageEvidence) {
    assert.ok(report.indexOf(packageEvidence) >= 0, 'committed bundled package: ' + packageEvidence);
});
var reportEnvironment = report.match(/^\| Environment \| (.+) \| recorded \|$/m);
assert.ok(reportEnvironment, 'committed report complete environment row');
assert.ok(
    /^v\d+\.\d+\.\d+ \/ [^ /]+-[^ /]+ \/ .+$/.test(reportEnvironment[1]),
    'committed report records Node, platform, architecture, and CPU'
);
assert.ok(
    adr.indexOf('- Environment: ' + reportEnvironment[1]) >= 0,
    'committed ADR records the same complete environment'
);
var reportRole = report.match(/^- Decision: (runtime-grammar-backend|development-oracle|rejected)$/m);
var adrRole = adr.match(/^- Decision role: (runtime-grammar-backend|development-oracle|rejected)$/m);
assert.ok(reportRole, 'committed report closed decision role');
assert.ok(adrRole, 'committed ADR closed decision role');
assert.strictEqual(adrRole[1], reportRole[1], 'committed documents agree on decision role');
var grammarGate = report.match(/^- Grammar: (pass|fail)$/m);
var packagingGate = report.match(/^- Packaging: (pass|fail)$/m);
assert.ok(grammarGate, 'committed report grammar gate');
assert.ok(packagingGate, 'committed report packaging gate');
assert.deepStrictEqual(
    [reportRole[1], grammarGate[1], packagingGate[1]],
    ['rejected', 'fail', 'fail'],
    'committed measured role and failed grammar/package gates'
);
assert.ok(adr.indexOf('Status: Accepted') >= 0, 'accepted ADR');
assert.ok(adr.indexOf('project-owned lossless lexer') >= 0, 'owned lexer decision');

console.log('v2 parser evaluation report tests passed');
