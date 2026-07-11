var EVIDENCE_PREFIX = '<!-- v2-parser-evidence-base64: ';

function percent(value) {
    return (value * 100).toFixed(2) + '%';
}

function bool(value) {
    return value ? 'pass' : 'fail';
}

function environment(value) {
    return value.node + ' / ' + value.platform + '-' + value.arch + ' / ' + value.cpu;
}

function evidence_marker(report) {
    return EVIDENCE_PREFIX + Buffer.from(JSON.stringify(report), 'utf8').toString('base64') + ' -->';
}

function extract_evidence(document) {
    var line = document.split('\n').filter(function(value) {
        return value.indexOf(EVIDENCE_PREFIX) == 0;
    })[0];
    if (!line || line.slice(-4) != ' -->') {
        throw new Error('document is missing embedded v2 parser evidence');
    }
    var encoded = line.slice(EVIDENCE_PREFIX.length, -4);
    return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
}

function direct_load_evidence(report) {
    var prefix = '- On the recorded Node environment, directly loading pinned `'
        + report.candidate.name + '@' + report.candidate.version + '` ';
    return report.probe.directLoad.success
        ? prefix + 'succeeded.'
        : prefix + 'failed with stable error code `' + report.probe.directLoad.errorCode + '`.';
}

function evaluation_method_and_limitations(report) {
    return [
        '## Evaluation Method and Limitations',
        '',
        direct_load_evidence(report),
        '- Packaging measures a tree-shaken ESM named `HiveSQL` entry emitted as CommonJS for Node/VS Code cold start.',
        '- Candidate evaluation loads a separate ESM named-import entry containing only Hive, generic, PostgreSQL, and MySQL constructors.',
        '- Source reconstruction includes explicit synthetic fallback leaves; it proves containment and preservation, not native candidate token ownership.',
        '- Native partition, non-trivia coverage, and atomic metrics count candidate-origin evidence only.',
        '- Candidate leaf ownership requires the source reconstruction gate plus native partition, non-trivia coverage, and atomic-lexeme gates; it does not inherit unrelated grammar gates.',
        '- Cold start requires the built CommonJS artifact, constructs `HiveSQL`, and verifies that `SELECT 1` has no syntax diagnostics.',
        '- `maxRssKb` is the evaluation process upper watermark, not isolated parser heap.',
        '',
    ];
}

function markdown_cell(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/\\/g, '&#92;')
        .replace(/\|/g, '&#124;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\r\n|\r|\n/g, '<br>');
}

function errors_cell(errors) {
    if (!Array.isArray(errors) || errors.length == 0) {
        return 'none';
    }
    return errors.map(markdown_cell).join('<br>');
}

function analysis_failure_cell(failure) {
    return failure ? markdown_cell(failure.stage + ': ' + failure.message) : 'none';
}

function failed_must_gates(report) {
    var failures = [];
    if (report.summary.requiredParseRate < report.gates.requiredParseRate) {
        failures.push('required parse rate');
    }
    if (report.summary.invalidRejectRate < report.gates.invalidRejectRate) {
        failures.push('invalid reject rate');
    }
    if (report.summary.sourceRoundTripRate < report.gates.sourceRoundTripRate) {
        failures.push('source reconstruction rate');
    }
    if (report.summary.requiredNodeSpanRate < report.gates.requiredNodeSpanRate) {
        failures.push('required node-range rate');
    }
    if (!report.decision.licensePass) {
        failures.push('license allowlist');
    }
    return failures;
}

function render_report(report) {
    var rejectedBy = failed_must_gates(report);
    return [
        '# SQL Formatter v2 Parser Evaluation Report',
        '',
        evidence_marker(report),
        '',
        '- Candidate: ' + report.candidate.name + '@' + report.candidate.version,
        '- Candidate license: ' + report.candidate.license,
        '- Decision: ' + report.decision.role,
        '- Can own lossless leaf stream: ' + String(report.decision.canOwnLeafStream),
        '- Rejected MUST gates: ' + (rejectedBy.length > 0 ? rejectedBy.join(', ') : 'none'),
        '',
        '## Correctness and Native Token Evidence',
        '',
        '| Metric | Actual | Gate |',
        '| --- | ---: | ---: |',
        '| Required parse rate | ' + percent(report.summary.requiredParseRate) + ' | 100.00% |',
        '| Invalid reject rate | ' + percent(report.summary.invalidRejectRate) + ' | 100.00% |',
        '| Source reconstruction rate | ' + percent(report.summary.sourceRoundTripRate) + ' | 100.00% |',
        '| Required case node-range rate | ' + percent(report.summary.requiredNodeSpanRate) + ' | 100.00% |',
        '| Native token partition rate | ' + percent(report.summary.nativeTokenPartitionRate) + ' | 100.00% for leaf ownership |',
        '| Native non-trivia coverage rate | ' + percent(report.summary.nativeTokenCoverageRate) + ' | 100.00% for leaf ownership |',
        '| Native atomic lexeme rate | ' + percent(report.summary.nativeAtomicLexemeRate) + ' | 100.00% for leaf ownership |',
        '',
        '## Packaging and Performance',
        '',
        '| Metric | Actual | Gate |',
        '| --- | ---: | ---: |',
        '| Bundle entry | ' + report.probe.bundleEntry + ' | ESM named Hive |',
        '| Minified bundle bytes | ' + report.probe.bundleBytes + ' | <= ' + report.gates.maxBundleBytes + ' |',
        '| Gzip bundle bytes | ' + report.probe.gzipBytes + ' | <= ' + report.gates.maxGzipBytes + ' |',
        '| Cold start median ms | ' + report.probe.coldStartMedianMs.toFixed(2) + ' | <= ' + report.gates.maxColdStartMedianMs + ' |',
        '| 100 statement median ms | ' + report.probe.parse100MedianMs.toFixed(2) + ' | baseline |',
        '| 800 statement median ms | ' + report.probe.parse800MedianMs.toFixed(2) + ' | baseline |',
        '| 1200 statement median ms | ' + report.probe.parse1200MedianMs.toFixed(2) + ' | baseline |',
        '| 8x scale ratio | ' + report.probe.scaleRatio.toFixed(2) + ' | <= ' + report.gates.maxScaleRatio + ' |',
        '| Maximum RSS KiB | ' + report.probe.maxRssKb + ' | baseline |',
        '| Environment | ' + markdown_cell(environment(report.probe.environment)) + ' | recorded |',
        '',
    ].concat(evaluation_method_and_limitations(report), [
        '## Gate Results',
        '',
        '- Grammar: ' + bool(report.decision.grammarPass),
        '- License: ' + bool(report.decision.licensePass),
        '- Packaging: ' + bool(report.decision.packagingPass),
        '- Performance: ' + bool(report.decision.performancePass),
        '- Candidate token ownership: ' + bool(report.decision.tokenOwnershipPass),
        '',
        '## Case Outcomes',
        '',
        '| Case | Expected | Status | Syntax diagnostics | Analysis failure | Source reconstruction | Native partition | Native coverage | Node ranges | Nodes | Native atomic passed/total |',
        '| --- | --- | --- | --- | --- | --- | --- | --- | --- | ---: | ---: |',
    ]).concat(report.outcomes.map(function(item) {
        return '| ' + markdown_cell(item.id) + ' | ' + markdown_cell(item.expectation) + ' | '
            + item.status + ' | ' + errors_cell(item.errors) + ' | '
            + analysis_failure_cell(item.analysisFailure) + ' | '
            + String(item.roundTrip) + ' | ' + String(item.nativePartitionValid) + ' | '
            + String(item.nativeCoverageComplete) + ' | ' + String(item.nodeSpansValid) + ' | '
            + item.nodeCount + ' | ' + item.atomicPassed + '/' + item.atomicTotal + ' |';
    })).concat([
        '',
        '## Bundled Packages',
        '',
    ], report.probe.bundledPackages.map(function(item) {
        return '- ' + item.name + '@' + item.version + ' — ' + item.license;
    }), [
        '',
        'This report is Wave 0 evidence and does not change the active formatter.',
        '',
    ]).join('\n');
}

function render_adr(report) {
    var roleText = {
        'runtime-grammar-backend': 'Use dt-sql-parser behind the project-owned lossless adapter as the v2 runtime grammar backend.',
        'development-oracle': 'Keep dt-sql-parser as a development-only differential oracle; implement the production grammar backend in-project.',
        'rejected': 'Do not use dt-sql-parser as a v2 backend or oracle; implement and validate the production grammar backend in-project.',
    }[report.decision.role];
    var rejectedBy = failed_must_gates(report);
    return [
        '# ADR 0001: SQL Formatter v2 Parser Backend',
        '',
        evidence_marker(report),
        '',
        '- Status: Accepted',
        '- Candidate: ' + report.candidate.name + '@' + report.candidate.version,
        '- Decision role: ' + report.decision.role,
        '',
        '## Context',
        '',
        'The formatter requires Hive-first grammar coverage without surrendering exact source text, opaque fallback, package discipline, or near-linear scaling.',
        '',
        '## Decision',
        '',
        roleText,
        '',
        report.decision.role == 'rejected'
            ? 'The rejecting MUST gate evidence is: ' + rejectedBy.join(', ') + '.'
            : 'No rejecting MUST gate failed.',
        '',
        'A project-owned lossless lexer remains mandatory in every outcome. External parser tokens cannot own protected source units unless source reconstruction, native partition, non-trivia coverage, and atomic-lexeme gates all pass.',
        '',
        '## Evidence',
        '',
        '- Required parse rate: ' + percent(report.summary.requiredParseRate),
        '- Invalid reject rate: ' + percent(report.summary.invalidRejectRate),
        '- Source reconstruction rate: ' + percent(report.summary.sourceRoundTripRate),
        '- Required case node-range rate: ' + percent(report.summary.requiredNodeSpanRate),
        '- Native token partition rate: ' + percent(report.summary.nativeTokenPartitionRate),
        '- Native non-trivia coverage rate: ' + percent(report.summary.nativeTokenCoverageRate),
        '- Native atomic lexeme rate: ' + percent(report.summary.nativeAtomicLexemeRate),
        '- Minified/gzip bytes: ' + report.probe.bundleBytes + ' / ' + report.probe.gzipBytes,
        '- Cold start median ms: ' + report.probe.coldStartMedianMs.toFixed(2),
        '- 8x scale ratio: ' + report.probe.scaleRatio.toFixed(2),
        '- Maximum RSS KiB: ' + report.probe.maxRssKb,
        '- Environment: ' + markdown_cell(environment(report.probe.environment)),
        '',
    ].concat(evaluation_method_and_limitations(report), [
        'Full per-case evidence is recorded in `docs/technical/v2-parser-evaluation-report.md`.',
        '',
        '## Consequences',
        '',
        '- Canonical CST, diagnostic, layout, and result types remain independent of candidate parse-tree classes.',
        '- Synthetic source-preservation leaves never count as candidate-native ownership evidence.',
        '- No candidate package is imported by the shipping 1.x entrypoint.',
        '- Wave 1 can implement the lossless lexer without reopening the backend role unless committed evidence changes.',
        '',
    ]).join('\n');
}

exports.extract_evidence = extract_evidence;
exports.render_report = render_report;
exports.render_adr = render_adr;
