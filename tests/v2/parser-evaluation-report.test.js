var fs = require('fs');
var path = require('path');
var assert = require('assert');
var renderer = require('../../scripts/v2-parser-evaluation/report');
var cases = require('../fixtures/v2-parser-evaluation-cases');
var reportPath = path.join(__dirname, '..', '..', 'docs', 'technical', 'v2-parser-evaluation-report.md');
var adrPath = path.join(__dirname, '..', '..', 'docs', 'technical', 'adr', '0001-v2-parser-backend.md');
var report = fs.readFileSync(reportPath, 'utf8');
var adr = fs.readFileSync(adrPath, 'utf8');
var packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
assert.strictEqual(
    packageJson.scripts['verify:v2:parser-evidence'],
    'node scripts/v2-parser-evaluation/run.js --verify',
    'verify-only evidence command must be explicit and non-writing'
);
assert.strictEqual(
    packageJson.scripts['evaluate:v2:parser'],
    'node scripts/v2-parser-evaluation/run.js --write',
    'report generation must be separate from verification'
);
var sharedMethodEvidence = [
    'Packaging measures a tree-shaken ESM named `HiveSQL` entry emitted as CommonJS for Node/VS Code cold start.',
    'Candidate evaluation loads a separate ESM named-import entry containing only Hive, generic, PostgreSQL, and MySQL constructors.',
    'Source reconstruction includes explicit synthetic fallback leaves; it proves containment and preservation, not native candidate token ownership.',
    'Native partition, non-trivia coverage, and atomic metrics count candidate-origin evidence only.',
    'Candidate leaf ownership requires the source reconstruction gate plus native partition, non-trivia coverage, and atomic-lexeme gates; it does not inherit unrelated grammar gates.',
    'Cold start requires the built CommonJS artifact, constructs `HiveSQL`, and verifies that `SELECT 1` has no syntax diagnostics.',
    '`maxRssKb` is the evaluation process upper watermark, not isolated parser heap.',
];
var fixtureDirectLoadEvidence = 'On the recorded Node environment, directly loading pinned '
    + '`dt-sql-parser@4.5.0` failed with stable error code `ERR_FIXTURE_DIRECT_LOAD`.';
var committedDirectLoadMatch = report.match(/^- (On the recorded Node environment, directly loading pinned `dt-sql-parser@4\.5\.0` (?:succeeded|failed with stable error code `[A-Z][A-Z0-9_]*`)\.)$/m);
assert.ok(committedDirectLoadMatch, 'committed direct-load evidence is environment-aware and structured');
var committedDirectLoadEvidence = committedDirectLoadMatch[1];
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
            status: 'syntax-rejected',
            accepted: false,
            errors: [
                'unexpected | token\nsecond <line>',
                'path\\tail & detail',
            ],
            analysisFailure: null,
            rejectionEvidence: true,
            nodeCount: 0,
            nodeSpansValid: false,
            roundTrip: true,
            nativePartitionValid: true,
            nativeCoverageComplete: false,
            invalidTokenCount: 0,
            overlapTokenCount: 0,
            nonTriviaGapCount: 1,
            atomicPassed: 1,
            atomicTotal: 2,
        },
    ],
    summary: {
        totalCases: 1,
        requiredParseRate: 0.5,
        invalidRejectRate: 1,
        sourceRoundTripRate: 1,
        requiredNodeSpanRate: 0.25,
        nativeTokenPartitionRate: 1,
        nativeTokenCoverageRate: 0,
        nativeAtomicLexemeRate: 0.5,
    },
    probe: {
        bundleEntry: 'esm-named-hive',
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
        tokenOwnershipPass: false,
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
    renderedReport.indexOf('| Case | Expected | Status | Syntax diagnostics | Analysis failure | Source reconstruction | Native partition | Native coverage | Node ranges | Nodes | Native atomic passed/total |') >= 0,
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
    renderedReport.indexOf('| fixture-invalid | invalid | syntax-rejected | unexpected &#124; token<br>second &lt;line&gt;<br>path&#92;tail &amp; detail | none | true | true | false | false | 0 | 1/2 |') >= 0,
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
assert.ok(report.indexOf('Native token partition rate') >= 0, 'committed native partition evidence');
assert.ok(report.indexOf('Native non-trivia coverage rate') >= 0, 'committed native coverage evidence');
assert.ok(report.indexOf('Native atomic lexeme rate') >= 0, 'committed native atomic evidence');
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
    assert.strictEqual(cells.length, 11, 'committed per-case evidence fields for ' + testCase.id);
    assert.ok(/^\d+\/\d+$/.test(cells[10]), 'committed atomic passed/total for ' + testCase.id);
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
var licenseGate = report.match(/^- License: (pass|fail)$/m);
assert.ok(grammarGate, 'committed report grammar gate');
assert.ok(packagingGate, 'committed report packaging gate');
assert.ok(licenseGate, 'committed report license gate');
if (reportRole[1] == 'rejected') {
    assert.ok(grammarGate[1] == 'fail' || licenseGate[1] == 'fail', 'rejected role has a failed MUST gate');
}
var embeddedReport = renderer.extract_evidence(report);
var embeddedAdr = renderer.extract_evidence(adr);
assert.deepStrictEqual(embeddedAdr, embeddedReport, 'committed report and ADR embed identical evidence');
assert.strictEqual(renderer.render_report(embeddedReport), report, 'committed report renders from embedded evidence');
assert.strictEqual(renderer.render_adr(embeddedReport), adr, 'committed ADR renders from embedded evidence');
assert.ok(adr.indexOf('Status: Accepted') >= 0, 'accepted ADR');
assert.ok(adr.indexOf('project-owned lossless lexer') >= 0, 'owned lexer decision');

console.log('v2 parser evaluation report tests passed');
