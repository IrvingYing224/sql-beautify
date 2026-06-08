var assert = require('assert');
var sqlFormatter = require('../lib/sql-formatter');

function default_options(extra) {
    return Object.assign({
        keywordCase: 'upper',
        commaStyle: 'leading',
        indentStyle: 'space',
        dialect: 'hive',
        unsupportedSyntaxPolicy: 'preserve'
    }, extra || {});
}

var normal = sqlFormatter.format_sql_detailed('select a from t', default_options());
assert.strictEqual(typeof normal.text, 'string', 'normal detailed formatter must return text');
assert.ok(Array.isArray(normal.diagnostics), 'normal detailed formatter must return diagnostics');
assert.strictEqual(
    Object.prototype.hasOwnProperty.call(normal, 'telemetry'),
    false,
    'normal detailed formatter must not expose telemetry'
);
assert.strictEqual(
    Object.prototype.hasOwnProperty.call(normal, 'safeReport'),
    false,
    'normal detailed formatter must not expose safeReport'
);

var detailed = sqlFormatter.format_sql_detailed('select case when a = 1 then b else c end as x from t', default_options({
    includeTelemetry: true
}));

assert.strictEqual(typeof detailed.text, 'string', 'telemetry detailed formatter must return text');
assert.ok(Array.isArray(detailed.diagnostics), 'telemetry detailed formatter must return diagnostics');
assert.ok(detailed.telemetry, 'telemetry detailed formatter must return telemetry');
assert.strictEqual(typeof detailed.telemetry.totalMs, 'number', 'telemetry totalMs must be numeric');
assert.ok(Array.isArray(detailed.telemetry.phases), 'telemetry phases must be an array');

[
    'syntax_risk_detection',
    'protect_input',
    'format_document',
    'scope_model',
    'format_nodes',
    'mutation_plan',
    'render',
    'restore'
].forEach(function(name) {
    var phase = detailed.telemetry.phases.filter(function(item) {
        return item.name == name;
    })[0];
    assert.ok(phase, 'telemetry must include phase ' + name);
    assert.strictEqual(typeof phase.ms, 'number', 'phase ms must be numeric for ' + name);
    assert.strictEqual(phase.status, 'ok', 'phase must be ok for ' + name);
});

assert.ok(detailed.safeReport, 'telemetry detailed formatter must return safeReport');
assert.strictEqual(detailed.safeReport.classification, 'ok', 'safeReport must classify successful formatting');
assert.strictEqual(detailed.safeReport.dialect, 'hive', 'safeReport must include dialect');

var warned = sqlFormatter.format_sql_detailed(
    'select * from t match_recognize (partition by a order by b measures match_number() as mn)',
    default_options({
        dialect: 'generic',
        unsupportedSyntaxPolicy: 'warn',
        includeTelemetry: true
    })
);
assert.strictEqual(warned.safeReport.classification, 'unsupported_syntax', 'unsupported warning must classify safeReport');
assert.ok(
    warned.safeReport.diagnostics[0].labels.indexOf('MATCH_RECOGNIZE') >= 0,
    'safeReport must include safe unsupported label'
);

var threw = false;
try {
    sqlFormatter.format_sql_detailed(
        'select * from t match_recognize (partition by a order by b measures \'secret-literal-987\' as mn)',
        default_options({
            dialect: 'generic',
            unsupportedSyntaxPolicy: 'bail_out',
            includeTelemetry: true
        })
    );
} catch (error) {
    threw = true;
    assert.ok(error.sqlBeautifyTelemetry, 'telemetry-enabled throw must attach telemetry');
    assert.strictEqual(typeof error.sqlBeautifyTelemetry.totalMs, 'number', 'error telemetry totalMs must be numeric');
    assert.ok(Array.isArray(error.sqlBeautifyTelemetry.phases), 'error telemetry phases must be an array');
    assert.strictEqual(error.sqlBeautifyClassification, 'unsupported_syntax', 'bail_out unsupported throw must classify as unsupported_syntax');
    assert.ok(Array.isArray(error.sqlBeautifyDiagnostics), 'telemetry-enabled throw must attach safe diagnostics');
    assert.ok(
        error.sqlBeautifyDiagnostics[0].unsupportedSegments[0].label == 'MATCH_RECOGNIZE',
        'telemetry-enabled throw must attach safe unsupported label'
    );
    var errorDiagnosticsMetadata = JSON.stringify(error.sqlBeautifyDiagnostics);
    assert.strictEqual(
        errorDiagnosticsMetadata.indexOf('secret-literal-987'),
        -1,
        'telemetry-enabled throw diagnostics must not leak secret literal'
    );
    assert.strictEqual(
        errorDiagnosticsMetadata.indexOf('match_recognize (partition by'),
        -1,
        'telemetry-enabled throw diagnostics must not leak unsupported SQL fragment'
    );
    assert.strictEqual(
        errorDiagnosticsMetadata.indexOf('snippet'),
        -1,
        'telemetry-enabled throw diagnostics must not expose snippet field'
    );
    assert.strictEqual(
        errorDiagnosticsMetadata.indexOf('text'),
        -1,
        'telemetry-enabled throw diagnostics must not expose text field'
    );
}
assert.ok(threw, 'bail_out unsupported syntax must still throw');

var textOnly = sqlFormatter.format_sql('select a from t', default_options({
    includeTelemetry: true
}));
assert.strictEqual(typeof textOnly, 'string', 'format_sql must remain text-only even if includeTelemetry is passed');

console.log('formatter telemetry tests passed');
