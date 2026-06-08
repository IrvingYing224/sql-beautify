var assert = require('assert');
var safeReport = require('../lib/core/sql-safe-diagnostic-report');

var sensitiveSql = [
    'with private_cte as (',
    "    select customer_id, `secret-column`, 'https://internal.example/path?id=42' as url_value",
    '    from prod_schema.secret_orders -- customer comment must not leak',
    "    where customer_name = 'Alice Internal'",
    ')',
    'select customer_id',
    'from private_cte',
    'where exists (select 1 from sensitive_table where sensitive_table.customer_id = private_cte.customer_id)'
].join('\n');

var unsupportedDiagnostic = {
    level: 'warning',
    code: 'unsupported_syntax',
    message: 'Unsupported SQL fragments were preserved without reformatting.',
    unsupportedSegments: [
        {
            kind: 'opaque_clause',
            code: 'unsupported_opaque_clause',
            label: 'MATCH_RECOGNIZE',
            source: 'opaque_protection',
            confidence: 'known_low_confidence',
            range: { start: 20, end: 80 },
            text: 'match_recognize (partition by private_cte.customer_id)',
            snippet: 'match_recognize (partition by private_cte.customer_id)'
        }
    ]
};

var report = safeReport.create_report({
    text: sensitiveSql,
    phase: 'command_format',
    options: {
        dialect: 'hive',
        unsupportedSyntaxPolicy: 'warn'
    },
    result: {
        diagnostics: [unsupportedDiagnostic],
        telemetry: {
            totalMs: 12,
            phases: [
                { name: 'syntax_risk_detection', ms: 1, status: 'ok' },
                { name: 'protect_input', ms: 1, status: 'ok' },
                { name: 'format_document', ms: 2, status: 'ok' },
                { name: 'scope_model', ms: 1, status: 'ok' },
                { name: 'format_nodes', ms: 2, status: 'ok' },
                { name: 'mutation_plan', ms: 2, status: 'ok' },
                { name: 'render', ms: 2, status: 'ok' },
                { name: 'restore', ms: 1, status: 'ok' }
            ]
        }
    },
    extensionVersion: '1.0.6'
});

assert.strictEqual(report.reportVersion, 1, 'report version must be stable');
assert.strictEqual(report.extensionVersion, '1.0.6', 'report must include extension version');
assert.strictEqual(report.phase, 'command_format', 'report must include phase');
assert.strictEqual(report.classification, 'unsupported_syntax', 'unsupported diagnostics must classify report');
assert.strictEqual(report.dialect, 'hive', 'report must include dialect');
assert.strictEqual(report.unsupportedSyntaxPolicy, 'warn', 'report must include unsupported policy');
assert.ok(report.input.chars > 0, 'report must include char count');
assert.ok(report.input.lines >= 8, 'report must include line count');
assert.ok(report.input.tokens > 0, 'report must include token count');
assert.ok(report.input.codeTokens > 0, 'report must include code token count');
assert.ok(report.input.commentTokens > 0, 'report must include comment token count');
assert.ok(report.input.stringLiterals > 0, 'report must include string literal count');
assert.ok(report.input.quotedIdentifiers > 0, 'report must include quoted identifier count');
assert.ok(report.structure.SELECT >= 2, 'report must count SELECT structures');
assert.ok(report.structure.CTE >= 1, 'report must count CTE structures');
assert.ok(report.diagnostics.length == 1, 'report must include normalized diagnostics');
assert.deepStrictEqual(report.diagnostics[0], {
    code: 'unsupported_syntax',
    labels: ['MATCH_RECOGNIZE'],
    sources: ['opaque_protection'],
    count: 1
}, 'diagnostics must keep only safe metadata');

var markdown = safeReport.render_markdown(report);
assert.ok(/# SQL Beautify Safe Diagnostic Report/.test(markdown), 'markdown must have a title');
assert.ok(/classification: unsupported_syntax/.test(markdown), 'markdown must render classification');
assert.ok(/MATCH_RECOGNIZE/.test(markdown), 'markdown may render safe unsupported label');
assert.ok(/syntax_risk_detection/.test(markdown), 'markdown must render telemetry phases');
assert.ok(/reproductionHints/.test(markdown), 'markdown must render reproduction hints');

safeReport.assert_report_safe(markdown, [
    sensitiveSql,
    'private_cte',
    'customer_id',
    'secret-column',
    'prod_schema',
    'secret_orders',
    'customer comment',
    'customer_name',
    'Alice Internal',
    'sensitive_table',
    'https://internal.example/path?id=42',
    'match_recognize (partition by private_cte.customer_id)',
    'SQLBEAUTIFY_'
]);

assert.strictEqual(
    safeReport.classify_result({
        diagnostics: [unsupportedDiagnostic]
    }),
    'unsupported_syntax',
    'unsupported diagnostics must classify as unsupported_syntax'
);
assert.strictEqual(
    safeReport.classify_result({
        failureType: 'unsafe_range'
    }),
    'unsafe_range',
    'unsafe range failure type must classify directly'
);
assert.strictEqual(
    safeReport.classify_result({
        error: new Error('Mutation plan invariant failed')
    }),
    'invariant_violation',
    'invariant-looking errors must classify as invariant_violation'
);
assert.strictEqual(
    safeReport.classify_result({
        error: new Error('Unsupported SQL fragment detected under bail_out policy.')
    }),
    'unsupported_syntax',
    'bail_out unsupported errors must classify as unsupported_syntax'
);
assert.strictEqual(
    safeReport.classify_result({
        result: {
            telemetry: {
                totalMs: 6001,
                phases: []
            }
        },
        slowThresholdMs: 5000
    }),
    'slow_format',
    'slow telemetry must classify as slow_format'
);
assert.strictEqual(
    safeReport.classify_result({
        result: {
            diagnostics: [],
            telemetry: {
                totalMs: 3,
                phases: []
            }
        }
    }),
    'ok',
    'successful result without warnings must classify as ok'
);

console.log('safe diagnostic report tests passed');
