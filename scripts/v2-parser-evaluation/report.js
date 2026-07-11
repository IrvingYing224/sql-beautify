function percent(value) {
    return (value * 100).toFixed(2) + '%';
}

function bool(value) {
    return value ? 'pass' : 'fail';
}

function environment(value) {
    return value.node + ' / ' + value.platform + '-' + value.arch + ' / ' + value.cpu;
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
        '- Evaluation uses a dev-only esbuild CommonJS (CJS) interoperability bundle; the minified and gzip bundle byte measurements remain recorded against their thresholds.',
        '- Cold start measures loading that bundle, constructing `HiveSQL`, and validating `SELECT 1`.',
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

function render_report(report) {
    return [
        '# SQL Formatter v2 Parser Evaluation Report',
        '',
        '- Candidate: ' + report.candidate.name + '@' + report.candidate.version,
        '- Candidate license: ' + report.candidate.license,
        '- Decision: ' + report.decision.role,
        '- Can own lossless leaf stream: ' + String(report.decision.canOwnLeafStream),
        '',
        '## Correctness',
        '',
        '| Metric | Actual | Gate |',
        '| --- | ---: | ---: |',
        '| Required parse rate | ' + percent(report.summary.requiredParseRate) + ' | 100.00% |',
        '| Invalid reject rate | ' + percent(report.summary.invalidRejectRate) + ' | 100.00% |',
        '| Source round-trip rate | ' + percent(report.summary.roundTripRate) + ' | 100.00% |',
        '| Required case node-range rate | ' + percent(report.summary.requiredNodeSpanRate) + ' | 100.00% |',
        '| Atomic lexeme rate | ' + percent(report.summary.atomicLexemeRate) + ' | informational |',
        '',
        '## Packaging and Performance',
        '',
        '| Metric | Actual | Gate |',
        '| --- | ---: | ---: |',
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
        '',
        '## Case Outcomes',
        '',
        '| Case | Expected | Accepted | Errors | Round trip | Node ranges | Nodes | Atomic passed/total |',
        '| --- | --- | --- | --- | --- | --- | ---: | ---: |',
    ]).concat(report.outcomes.map(function(item) {
        return '| ' + markdown_cell(item.id) + ' | ' + markdown_cell(item.expectation) + ' | '
            + String(item.accepted) + ' | ' + errors_cell(item.errors) + ' | '
            + String(item.roundTrip) + ' | ' + String(item.nodeSpansValid) + ' | '
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
    return [
        '# ADR 0001: SQL Formatter v2 Parser Backend',
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
        'A project-owned lossless lexer remains mandatory in every outcome. External parser tokens cannot own protected source units unless atomic-lexeme and source-partition gates both pass.',
        '',
        '## Evidence',
        '',
        '- Required parse rate: ' + percent(report.summary.requiredParseRate),
        '- Source round-trip rate: ' + percent(report.summary.roundTripRate),
        '- Required case node-range rate: ' + percent(report.summary.requiredNodeSpanRate),
        '- Atomic lexeme rate: ' + percent(report.summary.atomicLexemeRate),
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
        '- No candidate package is imported by the shipping 1.x entrypoint.',
        '- Wave 1 can implement the lossless lexer without reopening the backend role unless committed evidence changes.',
        '',
    ]).join('\n');
}

exports.render_report = render_report;
exports.render_adr = render_adr;
