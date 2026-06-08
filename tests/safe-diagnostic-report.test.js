var assert = require('assert');
var safeReport = require('../lib/core/sql-safe-diagnostic-report');

function assert_does_not_throw(fn, message) {
    try {
        fn();
    } catch (error) {
        assert.fail(message + ': ' + error.message);
    }
}

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

var leakingCodeReport = safeReport.create_report({
    text: sensitiveSql,
    phase: 'command_format',
    options: {
        dialect: 'hive',
        unsupportedSyntaxPolicy: 'warn'
    },
    result: {
        diagnostics: [
            {
                level: 'warning',
                code: 'private_cte.customer_id',
                unsupportedSegments: [
                    {
                        label: 'MATCH_RECOGNIZE',
                        source: 'opaque_protection'
                    }
                ]
            }
        ],
        telemetry: {
            totalMs: 1,
            phases: []
        }
    },
    extensionVersion: '1.0.6'
});
var leakingCodeMarkdown = safeReport.render_markdown(leakingCodeReport);
assert.strictEqual(leakingCodeReport.diagnostics[0].code, 'unknown', 'unsafe diagnostic code must be normalized');
safeReport.assert_report_safe(leakingCodeMarkdown, [
    'private_cte',
    'customer_id',
    'private_cte_customer_id',
    'private_cte.customer_id'
]);

var emptyReport = safeReport.create_report({
    text: sensitiveSql,
    phase: 'command_format',
    options: {
        dialect: 'hive',
        unsupportedSyntaxPolicy: 'warn'
    },
    result: {
        diagnostics: [],
        telemetry: {
            totalMs: 3,
            phases: []
        }
    },
    extensionVersion: '1.0.6'
});
var emptyMarkdown = safeReport.render_markdown(emptyReport);
assert.ok(/- diagnostics:\n  - none/.test(emptyMarkdown), 'markdown must render none for empty diagnostics');
assert.ok(/- phases:\n    - none/.test(emptyMarkdown), 'markdown must render none for empty telemetry phases');
safeReport.assert_report_safe(emptyMarkdown, [
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
    'SQLBEAUTIFY_'
]);

var untrustedMetadataReport = safeReport.create_report({
    text: sensitiveSql,
    phase: 'private_cte.customer_id',
    options: {
        dialect: 'https://internal.example/path?id=42',
        unsupportedSyntaxPolicy: 'customer_name'
    },
    result: {
        diagnostics: [],
        telemetry: {
            totalMs: 4,
            phases: [
                { name: 'private_cte.customer_id', ms: 1, status: 'Alice Internal' }
            ]
        }
    },
    extensionVersion: 'https://internal.example/ext/sql-beautify-1.0.6.vsix'
});
var untrustedMetadataMarkdown = safeReport.render_markdown(untrustedMetadataReport);
assert.strictEqual(untrustedMetadataReport.phase, 'unknown', 'unsafe report phase must be normalized');
assert.strictEqual(untrustedMetadataReport.dialect, 'unknown', 'unsafe dialect must be normalized');
assert.strictEqual(untrustedMetadataReport.unsupportedSyntaxPolicy, 'unknown', 'unsafe unsupported policy must be normalized');
assert.strictEqual(untrustedMetadataReport.extensionVersion, 'unknown', 'unsafe extension version must be normalized');
assert.strictEqual(untrustedMetadataReport.telemetry.phases[0].name, 'unknown', 'unsafe telemetry phase name must be normalized');
assert.strictEqual(untrustedMetadataReport.telemetry.phases[0].status, 'unknown', 'unsafe telemetry phase status must be normalized');
safeReport.assert_report_safe(untrustedMetadataMarkdown, [
    'private_cte.customer_id',
    'private_cte_customer_id',
    'https://internal.example/path?id=42',
    'https_internal_example_path_id_42',
    'https:_internal_example_path_id_42',
    'customer_name',
    'Alice Internal',
    'Alice_Internal',
    'https://internal.example/ext/sql-beautify-1.0.6.vsix',
    'sql-beautify-1.0.6.vsix'
]);

var unsafeExtensionVersionReport = safeReport.create_report({
    text: sensitiveSql,
    phase: 'command_format',
    options: {
        dialect: 'hive',
        unsupportedSyntaxPolicy: 'warn'
    },
    result: {
        diagnostics: [],
        telemetry: {
            totalMs: 1,
            phases: []
        }
    },
    extensionVersion: '1.0.0-secret-orders'
});
assert.strictEqual(
    unsafeExtensionVersionReport.extensionVersion,
    'unknown',
    'extension version must not preserve semver metadata'
);

var unsafeRawReportMarkdown = safeReport.render_markdown({
    extensionVersion: '1.0.0-secret-orders',
    reportVersion: 1,
    phase: 'private_cte.customer_id',
    classification: 'customer_name',
    dialect: 'prod_schema.secret_orders',
    unsupportedSyntaxPolicy: 'Alice Internal',
    input: {
        chars: 1,
        lines: 1,
        tokens: 1,
        codeTokens: 1,
        commentTokens: 0,
        stringLiterals: 0,
        quotedIdentifiers: 0
    },
    structure: {
        SELECT: 1,
        JOIN: 0,
        CASE: 0,
        WINDOW: 0,
        CTE: 0,
        SUBQUERY: 0
    },
    diagnostics: [
        {
            code: 'private_cte.customer_id',
            labels: ['secret_orders'],
            sources: ['prod_schema'],
            count: 1
        }
    ],
    telemetry: {
        totalMs: 1,
        phases: [
            { name: 'private_cte.customer_id', ms: 1, status: 'Alice Internal' }
        ]
    },
    reproductionHints: ['private_cte customer_id secret_orders']
});
assert.ok(/extensionVersion: unknown/.test(unsafeRawReportMarkdown), 'renderer must normalize unsafe extension version');
assert.ok(/phase: unknown/.test(unsafeRawReportMarkdown), 'renderer must normalize unsafe phase');
assert.ok(/classification: unknown/.test(unsafeRawReportMarkdown), 'renderer must normalize unsafe classification');
assert.ok(/dialect: unknown/.test(unsafeRawReportMarkdown), 'renderer must normalize unsafe dialect');
assert.ok(/unsupportedSyntaxPolicy: unknown/.test(unsafeRawReportMarkdown), 'renderer must normalize unsafe unsupported policy');
assert.ok(/code: unknown/.test(unsafeRawReportMarkdown), 'renderer must normalize unsafe diagnostic code');
assert.ok(/unknown: 1 \(unknown\)/.test(unsafeRawReportMarkdown), 'renderer must normalize unsafe telemetry phase');
safeReport.assert_report_safe(unsafeRawReportMarkdown, [
    '1.0.0-secret-orders',
    'private_cte.customer_id',
    'private_cte_customer_id',
    'customer_name',
    'prod_schema.secret_orders',
    'secret_orders',
    'prod_schema',
    'Alice Internal',
    'Alice_Internal',
    'private_cte customer_id secret_orders'
]);

var malformedSummaryMarkdown;
assert_does_not_throw(function() {
    malformedSummaryMarkdown = safeReport.render_markdown({
        extensionVersion: '1.0.6',
        reportVersion: 1,
        phase: 'command_format',
        classification: 'ok',
        dialect: 'hive',
        unsupportedSyntaxPolicy: 'warn',
        input: {},
        structure: {},
        diagnostics: [
            {
                code: 'private_cte.customer_id',
                labels: 'secret_orders',
                sources: 'prod_schema',
                count: 'not-a-number'
            }
        ],
        telemetry: {
            totalMs: 1,
            phases: [
                { name: 'private_cte.customer_id', ms: 1, status: 'Alice Internal' }
            ]
        },
        reproductionHints: ['private_cte customer_id secret_orders']
    });
}, 'malformed diagnostic summary must not throw');
assert.ok(/code: unknown/.test(malformedSummaryMarkdown), 'malformed diagnostic code must normalize safely');
assert.ok(/labels: $/m.test(malformedSummaryMarkdown), 'malformed labels must render empty');
assert.ok(/sources: $/m.test(malformedSummaryMarkdown), 'malformed sources must render empty');
assert.ok(/count: 0/.test(malformedSummaryMarkdown), 'malformed count must normalize to 0');
safeReport.assert_report_safe(malformedSummaryMarkdown, [
    'private_cte',
    'customer_id',
    'private_cte_customer_id',
    'secret_orders',
    'prod_schema',
    'Alice Internal',
    'Alice_Internal',
    'private_cte customer_id secret_orders'
]);

var stringDiagnosticsMarkdown;
assert_does_not_throw(function() {
    stringDiagnosticsMarkdown = safeReport.render_markdown({
        extensionVersion: '1.0.6',
        reportVersion: 1,
        phase: 'command_format',
        classification: 'ok',
        dialect: 'hive',
        unsupportedSyntaxPolicy: 'warn',
        input: {},
        structure: {},
        diagnostics: 'private_cte.customer_id',
        telemetry: {
            totalMs: 1,
            phases: 'private_cte.customer_id'
        },
        reproductionHints: ['private_cte customer_id secret_orders']
    });
}, 'string diagnostics and telemetry phases must not throw');
assert.ok(/- diagnostics:\n  - none/.test(stringDiagnosticsMarkdown), 'string diagnostics must render as empty diagnostics');
assert.ok(/- phases:\n    - none/.test(stringDiagnosticsMarkdown), 'string telemetry phases must render as empty phases');
safeReport.assert_report_safe(stringDiagnosticsMarkdown, [
    'private_cte',
    'customer_id',
    'private_cte_customer_id',
    'private_cte.customer_id',
    'private_cte customer_id secret_orders'
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
