# Safe Diagnostic Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local-only, no-content safe diagnostic report that VS Code users can copy from restricted production environments without exposing SQL text.

**Architecture:** Add a focused core report builder in `lib/core/` that only emits counts, labels, classifications, and timings. Add opt-in internal phase telemetry to `format_sql_detailed()` without changing normal formatter output, then add a VS Code adapter command that generates a fresh report from the active document or selection and writes Markdown to the clipboard.

**Tech Stack:** CommonJS JavaScript, Node `assert` tests, existing SQL formatter core, VS Code adapter mock tests, `@vscode/vsce` packaging.

---

## Spec And Context

Read these before editing:

- `docs/superpowers/specs/2026-06-08-safe-diagnostic-report-design.md`
- `docs/technical/sql-formatter-architecture.md`
- `lib/core/sql-formatter.js`
- `lib/core/sql-format-document.js`
- `lib/core/sql-tokenizer.js`
- `lib/core/sql-diagnostics.js`
- `lib/adapters/vscode-extension.js`
- `tests/extension-contribution.test.js`
- `tests/module-boundary.test.js`

Non-negotiable constraints:

- Do not include raw SQL, formatted SQL, table names, column names, aliases, string literal values, comments, quoted identifier values, file paths, URLs, or unsupported segment `text` / `snippet` in the report.
- Do not add telemetry upload or disk writes.
- Do not add a public `sqlBeautify.*` setting for telemetry.
- Do not add a legacy `extension.*` alias for the new command.
- Do not change formatter output.
- Do not put new logic in root `lib/*.js` shims.
- Keep code style: CommonJS, `var`, semicolons, 4-space indentation.

## File Structure

- Create `lib/core/sql-safe-diagnostic-report.js`
  - Owns safe input stats, safe structure counts, diagnostic normalization, failure classification, Markdown rendering, and test-only safety assertion.
  - Imports core-only modules used by the report builder: `sql-format-document`, `sql-format-nodes`, and `sql-scope-model`.
  - Must not import `lib/adapters/`, VS Code, `fs`, or write files.

- Modify `lib/core/sql-formatter.js`
  - Adds internal telemetry timing helpers.
  - Keeps `format_sql()` text-only.
  - Keeps normal `format_sql_detailed()` compatible as `{ text, diagnostics }`.
  - Adds `telemetry` and `safeReport` only when `options.includeTelemetry === true`.
  - Attaches `error.sqlBeautifyTelemetry` and `error.sqlBeautifyClassification` before rethrowing formatter errors when telemetry is enabled.

- Create `tests/safe-diagnostic-report.test.js`
  - Locks the no-content report contract and report classification behavior.

- Create `tests/formatter-telemetry.test.js`
  - Locks telemetry phase names, compatibility, and safe failure metadata.

- Create `lib/adapters/safe-diagnostic-report.js`
  - Owns active editor / selection text extraction, config reading, report generation, clipboard write, and information/error messages.
  - Accepts injectable `sqlFormatter` and `safeReport` dependencies for tests.

- Modify `lib/adapters/vscode-extension.js`
  - Registers `sqlBeautify.copySafeDiagnosticReport`.
  - Wires the command to `lib/adapters/safe-diagnostic-report.js`.

- Modify `package.json`
  - Adds command contribution and activation event for `sqlBeautify.copySafeDiagnosticReport`.
  - Adds scripts `test:safe-report` and `test:telemetry`.
  - Adds both tests to `test:verify`.

- Modify `tests/extension-contribution.test.js`
  - Verifies command contribution, activation event, command registration, clipboard write, selection behavior, and no SQL-content leakage.

- Modify `tests/module-boundary.test.js`
  - Verifies new runtime modules exist, core does not import adapters, adapter does not get imported by core, new helper export surface is narrow, and `test:verify` includes new tests.

- Modify `docs/technical/sql-formatter-architecture.md`
  - Documents the safe diagnostic report contract and internal telemetry boundary.

- Modify `README.md`
  - Adds one concise end-user note for `SQL Beautify: Copy Safe Diagnostic Report`.
  - Must not include internal telemetry architecture, phase names, or classification implementation details.

---

### Task 1: Core Safe Diagnostic Report

**Files:**
- Create: `lib/core/sql-safe-diagnostic-report.js`
- Create: `tests/safe-diagnostic-report.test.js`

- [ ] **Step 1: Write the failing test for safe stats, diagnostics, and no-content rendering**

Create `tests/safe-diagnostic-report.test.js` with this content:

```js
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
```

- [ ] **Step 2: Run the safe report test to verify it fails**

Run:

```bash
node tests/safe-diagnostic-report.test.js
```

Expected: FAIL with a module-not-found error for `../lib/core/sql-safe-diagnostic-report`.

- [ ] **Step 3: Implement the core report helper**

Create `lib/core/sql-safe-diagnostic-report.js`:

```js
var sqlFormatDocument = require('./sql-format-document');
var sqlFormatNodes = require('./sql-format-nodes');
var sqlScopeModel = require('./sql-scope-model');

var REPORT_VERSION = 1;
var DEFAULT_SLOW_THRESHOLD_MS = 5000;
var CLASSIFICATIONS = {
    ok: true,
    unsupported_syntax: true,
    unsafe_range: true,
    formatter_throw: true,
    invariant_violation: true,
    vscode_rejected_edit: true,
    overlapping_selection: true,
    slow_format: true,
    unknown: true
};

function own_keys(object) {
    var keys = [];
    var source = object || {};
    var key;

    for (key in source) {
        if (Object.prototype.hasOwnProperty.call(source, key)) {
            keys.push(key);
        }
    }

    return keys;
}

function unique_sorted(values) {
    var seen = {};
    var output = [];
    var i;
    var value;

    for (i = 0; i < (values || []).length; i++) {
        value = String(values[i] || '');
        if (!value || seen[value]) {
            continue;
        }
        seen[value] = true;
        output.push(value);
    }

    output.sort();
    return output;
}

function count_lines(text) {
    var value = String(text || '');
    if (value.length == 0) {
        return 0;
    }
    return value.replace(/\r\n|\r/g, '\n').split('\n').length;
}

function is_code_token(token) {
    return token && token.isCode;
}

function count_word(tokens, word) {
    var total = 0;
    var target = String(word || '').toUpperCase();
    var i;

    for (i = 0; i < (tokens || []).length; i++) {
        if (tokens[i].type == 'word' && String(tokens[i].value || '').toUpperCase() == target) {
            total += 1;
        }
    }

    return total;
}

function count_word_pair(tokens, first, second) {
    var total = 0;
    var codeTokens = [];
    var i;

    for (i = 0; i < (tokens || []).length; i++) {
        if (is_code_token(tokens[i])) {
            codeTokens.push(tokens[i]);
        }
    }

    for (i = 0; i < codeTokens.length - 1; i++) {
        if (String(codeTokens[i].value || '').toUpperCase() == first
            && String(codeTokens[i + 1].value || '').toUpperCase() == second) {
            total += 1;
        }
    }

    return total;
}

function count_subquery(document) {
    var total = 0;
    var scopes = document && document.scopes ? document.scopes : [];
    var i;

    for (i = 0; i < scopes.length; i++) {
        if (scopes[i] && scopes[i].type == 'query') {
            total += 1;
        }
    }

    return total > 0 ? total - 1 : 0;
}

function input_stats(text, options) {
    var document = sqlFormatDocument.from_text(text, options || {});
    var tokens = document.tokens || [];
    var stats = {
        chars: String(text || '').length,
        lines: count_lines(text),
        tokens: tokens.length,
        codeTokens: 0,
        commentTokens: 0,
        stringLiterals: 0,
        quotedIdentifiers: 0
    };
    var i;

    for (i = 0; i < tokens.length; i++) {
        if (tokens[i].isCode) {
            stats.codeTokens += 1;
        }
        if (tokens[i].type == 'line_comment' || tokens[i].type == 'block_comment') {
            stats.commentTokens += 1;
        }
        if (tokens[i].type == 'string_literal') {
            stats.stringLiterals += 1;
        }
        if (tokens[i].type == 'quoted_identifier') {
            stats.quotedIdentifiers += 1;
        }
    }

    return {
        document: document,
        stats: stats
    };
}

function structure_counts(document, options) {
    var nodes;
    var structure = {
        SELECT: 0,
        JOIN: 0,
        CASE: 0,
        WINDOW: 0,
        CTE: 0,
        SUBQUERY: 0
    };

    try {
        if (!document.scopes) {
            document.scopes = sqlScopeModel.build(document, options || {});
        }
        nodes = sqlFormatNodes.extract(document, options || {});
        structure.CASE = nodes.caseExpressions.length;
        structure.SUBQUERY = count_subquery(document);
    } catch (error) {
        nodes = null;
    }

    structure.SELECT = count_word(document.tokens, 'SELECT');
    structure.JOIN = count_word(document.tokens, 'JOIN');
    structure.WINDOW = count_word(document.tokens, 'OVER');
    structure.CTE = count_word_pair(document.tokens, 'WITH', 'RECURSIVE') + count_word(document.tokens, 'WITH');

    return structure;
}

function normalize_phase(phase) {
    return {
        name: String(phase && phase.name || 'unknown'),
        ms: typeof (phase && phase.ms) == 'number' ? phase.ms : 0,
        status: String(phase && phase.status || 'unknown')
    };
}

function normalize_telemetry(telemetry) {
    var source = telemetry || {};
    var phases = [];
    var i;

    for (i = 0; i < (source.phases || []).length; i++) {
        phases.push(normalize_phase(source.phases[i]));
    }

    return {
        totalMs: typeof source.totalMs == 'number' ? source.totalMs : 0,
        phases: phases
    };
}

function normalize_diagnostics(diagnostics) {
    var output = [];
    var items = diagnostics || [];
    var i;
    var segments;
    var labels;
    var sources;

    for (i = 0; i < items.length; i++) {
        segments = items[i].unsupportedSegments || [];
        labels = unique_sorted(segments.map(function(segment) {
            return segment && segment.label;
        }));
        sources = unique_sorted(segments.map(function(segment) {
            return segment && segment.source;
        }));
        output.push({
            code: String(items[i].code || 'unknown'),
            labels: labels,
            sources: sources,
            count: segments.length
        });
    }

    return output;
}

function error_message(error) {
    return error && error.message ? String(error.message) : String(error || '');
}

function normalize_classification(value) {
    var normalized = String(value || 'unknown');
    return CLASSIFICATIONS[normalized] ? normalized : 'unknown';
}

function has_unsupported_diagnostic(diagnostics) {
    var i;

    for (i = 0; i < (diagnostics || []).length; i++) {
        if (diagnostics[i] && diagnostics[i].code == 'unsupported_syntax') {
            return true;
        }
    }

    return false;
}

function classify_result(input) {
    var source = input || {};
    var result = source.result || source;
    var diagnostics = result.diagnostics || [];
    var telemetry = result.telemetry || (source.result && source.result.telemetry);
    var threshold = typeof source.slowThresholdMs == 'number' ? source.slowThresholdMs : DEFAULT_SLOW_THRESHOLD_MS;
    var message;

    if (source.failureType) {
        return normalize_classification(source.failureType);
    }

    if (has_unsupported_diagnostic(diagnostics)) {
        return 'unsupported_syntax';
    }

    if (source.error || result.error) {
        message = error_message(source.error || result.error);
        if (/Unsupported SQL fragment/i.test(message)) {
            return 'unsupported_syntax';
        }
        if (/invariant|assert/i.test(message)) {
            return 'invariant_violation';
        }
        return 'formatter_throw';
    }

    if (telemetry && typeof telemetry.totalMs == 'number' && telemetry.totalMs > threshold) {
        return 'slow_format';
    }

    if (result && (result.text || result.diagnostics || result.telemetry)) {
        return 'ok';
    }

    return 'unknown';
}

function build_reproduction_hints(structure) {
    return [
        'Build an anonymized SQL with roughly '
            + (structure.CTE || 0) + ' CTEs, '
            + (structure.JOIN || 0) + ' JOINs, '
            + (structure.CASE || 0) + ' CASE expressions, and '
            + (structure.WINDOW || 0) + ' window expressions.'
    ];
}

function create_report(input) {
    var source = input || {};
    var options = source.options || {};
    var statsResult = input_stats(source.text || '', options);
    var result = source.result || {};
    var telemetry = normalize_telemetry(result.telemetry || source.telemetry);
    var report = {
        extensionVersion: String(source.extensionVersion || 'unknown'),
        reportVersion: REPORT_VERSION,
        phase: String(source.phase || 'unknown'),
        classification: classify_result(source),
        dialect: String(options.dialect || 'generic'),
        unsupportedSyntaxPolicy: String(options.unsupportedSyntaxPolicy || 'preserve'),
        input: statsResult.stats,
        structure: structure_counts(statsResult.document, options),
        diagnostics: normalize_diagnostics(result.diagnostics || source.diagnostics),
        telemetry: telemetry,
        reproductionHints: []
    };

    report.reproductionHints = build_reproduction_hints(report.structure);
    return report;
}

function render_object_lines(lines, prefix, object) {
    own_keys(object).forEach(function(key) {
        lines.push(prefix + '- ' + key + ': ' + object[key]);
    });
}

function render_markdown(report) {
    var lines = [
        '# SQL Beautify Safe Diagnostic Report',
        '',
        '- extensionVersion: ' + report.extensionVersion,
        '- reportVersion: ' + report.reportVersion,
        '- phase: ' + report.phase,
        '- classification: ' + report.classification,
        '- dialect: ' + report.dialect,
        '- unsupportedSyntaxPolicy: ' + report.unsupportedSyntaxPolicy,
        '- input:'
    ];

    render_object_lines(lines, '  ', report.input || {});
    lines.push('- structure:');
    render_object_lines(lines, '  ', report.structure || {});
    lines.push('- diagnostics:');
    (report.diagnostics || []).forEach(function(item) {
        lines.push('  - code: ' + item.code);
        lines.push('    labels: ' + item.labels.join(', '));
        lines.push('    sources: ' + item.sources.join(', '));
        lines.push('    count: ' + item.count);
    });
    if ((report.diagnostics || []).length == 0) {
        lines.push('  - none');
    }
    lines.push('- telemetry:');
    lines.push('  - totalMs: ' + ((report.telemetry && report.telemetry.totalMs) || 0));
    lines.push('  - phases:');
    (report.telemetry && report.telemetry.phases || []).forEach(function(phase) {
        lines.push('    - ' + phase.name + ': ' + phase.ms + ' (' + phase.status + ')');
    });
    if (!report.telemetry || report.telemetry.phases.length == 0) {
        lines.push('    - none');
    }
    lines.push('- reproductionHints:');
    (report.reproductionHints || []).forEach(function(hint) {
        lines.push('  - ' + hint);
    });

    return lines.join('\n') + '\n';
}

function assert_report_safe(reportText, forbiddenValues) {
    var text = String(reportText || '');
    var values = forbiddenValues || [];
    var i;
    var value;

    for (i = 0; i < values.length; i++) {
        value = String(values[i] || '');
        if (!value) {
            continue;
        }
        assert_absent(text, value);
    }
}

function assert_absent(text, value) {
    if (text.indexOf(value) >= 0) {
        throw new Error('safe diagnostic report leaked forbidden value: ' + value);
    }
}

exports.create_report = create_report;
exports.render_markdown = render_markdown;
exports.classify_result = classify_result;
exports.assert_report_safe = assert_report_safe;
```

- [ ] **Step 4: Run the safe report test to verify it passes**

Run:

```bash
node tests/safe-diagnostic-report.test.js
```

Expected: PASS and prints `safe diagnostic report tests passed`.

- [ ] **Step 5: Commit Task 1**

Run:

```bash
git add lib/core/sql-safe-diagnostic-report.js tests/safe-diagnostic-report.test.js
git commit -m "feat: add safe diagnostic report core"
```

---

### Task 2: Formatter Phase Telemetry

**Files:**
- Modify: `lib/core/sql-formatter.js`
- Create: `tests/formatter-telemetry.test.js`

- [ ] **Step 1: Write the failing telemetry compatibility test**

Create `tests/formatter-telemetry.test.js`:

```js
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
        'select * from t match_recognize (partition by a order by b measures match_number() as mn)',
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
}
assert.ok(threw, 'bail_out unsupported syntax must still throw');

var textOnly = sqlFormatter.format_sql('select a from t', default_options({
    includeTelemetry: true
}));
assert.strictEqual(typeof textOnly, 'string', 'format_sql must remain text-only even if includeTelemetry is passed');

console.log('formatter telemetry tests passed');
```

- [ ] **Step 2: Run the telemetry test to verify it fails**

Run:

```bash
node tests/formatter-telemetry.test.js
```

Expected: FAIL because `telemetry` and `safeReport` are not yet returned.

- [ ] **Step 3: Refactor `format_sql_structured_detailed()` into instrumentable phases**

Modify `lib/core/sql-formatter.js` near the existing requires and helper functions.

Add the require:

```js
var sqlSafeDiagnosticReport = require('./sql-safe-diagnostic-report');
```

Add this helper immediately after the existing `collect_runtime_diagnostics(context, config)` function:

```js
function collect_unsupported_diagnostics(context) {
    if (!sqlUnsupportedPolicy.has_unsupported(context)) {
        return [];
    }

    return [
        sqlDiagnostics.create_unsupported_runtime_diagnostic(context.unsupportedSegments || [])
    ];
}
```

Add telemetry helper functions before `format_sql_structured_detailed`:

```js
function create_telemetry(enabled) {
    return {
        enabled: !!enabled,
        startedAt: Date.now(),
        phases: []
    };
}

function record_phase(telemetry, name, startedAt, status) {
    if (!telemetry.enabled) {
        return;
    }
    telemetry.phases.push({
        name: name,
        ms: Date.now() - startedAt,
        status: status || 'ok'
    });
}

function finish_telemetry(telemetry) {
    if (!telemetry.enabled) {
        return null;
    }
    return {
        totalMs: Date.now() - telemetry.startedAt,
        phases: telemetry.phases
    };
}

function timed_phase(telemetry, name, fn) {
    var startedAt = Date.now();
    try {
        var result = fn();
        record_phase(telemetry, name, startedAt, 'ok');
        return result;
    } catch (error) {
        record_phase(telemetry, name, startedAt, 'error');
        throw error;
    }
}
```

Replace `format_sql_structured_detailed(originalText, protectedText, config, dialect, context)` with this shape. Preserve the existing body order and only wrap phase boundaries:

```js
function format_sql_structured_detailed(originalText, protectedText, config, dialect, context, telemetry) {
    var document = timed_phase(telemetry, 'format_document', function() {
        return sqlFormatDocument.from_text(protectedText, config);
    });
    timed_phase(telemetry, 'scope_model', function() {
        document.scopes = sqlScopeModel.build(document, config);
        sqlFormatNavigation.attach_scope_index(document);
    });
    var nodes = timed_phase(telemetry, 'format_nodes', function() {
        return sqlFormatNodes.extract(document, config);
    });
    document.nodes = nodes;
    sqlFormatInvariants.assert_document_safe(document, nodes);

    var mutations = timed_phase(telemetry, 'mutation_plan', function() {
        var plan = sqlFormatMutations.create();
        add_initial_structured_mutations(document, nodes, plan, config);
        return plan;
    });
    sqlFormatInvariants.assert_mutation_plan_safe(document, nodes, mutations);

    var rendered = timed_phase(telemetry, 'render', function() {
        return sqlStructuredRenderer.render(document, nodes, mutations, config);
    });
    rendered = restore_user_blank_lines(originalText, rendered, config.dialect);
    rendered = sqlCommentSpacing.normalize_line_comment_spacing(rendered, dialect);
    rendered = timed_phase(telemetry, 'restore', function() {
        return restore_structured_output(rendered, context);
    });

    return {
        text: normalize_output_whitespace(rendered),
        diagnostics: collect_runtime_diagnostics(context, config)
    };
}
```

- [ ] **Step 4: Add telemetry handling to `format_sql_detailed()`**

Replace `format_sql_detailed()` with this implementation. Keep canonical options unchanged; `includeTelemetry` is read before normalization and is not part of canonical formatter config:

```js
function format_sql_detailed(text, options) {
    var rawOptions = options || {};
    var includeTelemetry = rawOptions.includeTelemetry === true;
    var telemetry = create_telemetry(includeTelemetry);
    var config = sqlCanonicalOptions.normalize(rawOptions);
    var context = sqlFormatContext.create_context(text);
    var dialect = sqlDialect.get_capabilities(config.dialect);
    var result;
    var finalTelemetry;

    try {
        timed_phase(telemetry, 'syntax_risk_detection', function() {
            var riskSegments = sqlSyntaxRiskDetector.detect(text, dialect);
            for (var r = 0; r < riskSegments.length; r++) {
                sqlUnsupportedPolicy.note_unsupported(context, riskSegments[r].kind, riskSegments[r]);
            }
        });
        var protectedText = timed_phase(telemetry, 'protect_input', function() {
            return protect_structured_input(text, config, dialect, context);
        });
        sqlUnsupportedPolicy.enforce_policy(context, config.unsupportedSyntaxPolicy);

        result = format_sql_structured_detailed(text, protectedText, config, dialect, context, telemetry);
        finalTelemetry = finish_telemetry(telemetry);
        if (includeTelemetry) {
            result.telemetry = finalTelemetry;
            result.safeReport = sqlSafeDiagnosticReport.create_report({
                text: text,
                phase: rawOptions.phase || 'core_format',
                options: config,
                result: result
            });
        }
        return result;
    } catch (error) {
        finalTelemetry = finish_telemetry(telemetry);
        if (includeTelemetry) {
            error.sqlBeautifyDiagnostics = collect_unsupported_diagnostics(context);
            error.sqlBeautifyTelemetry = finalTelemetry;
            error.sqlBeautifyClassification = sqlSafeDiagnosticReport.classify_result({
                error: error,
                result: {
                    telemetry: finalTelemetry,
                    diagnostics: error.sqlBeautifyDiagnostics
                }
            });
        }
        throw error;
    }
}
```

- [ ] **Step 5: Run telemetry and existing API tests**

Run:

```bash
node tests/formatter-telemetry.test.js
node tests/formatter-api.test.js
node tests/diagnostics-explainability.test.js
```

Expected: all PASS.

- [ ] **Step 6: Commit Task 2**

Run:

```bash
git add lib/core/sql-formatter.js tests/formatter-telemetry.test.js
git commit -m "feat: add formatter phase telemetry"
```

---

### Task 3: VS Code Copy Safe Diagnostic Report Command

**Files:**
- Create: `lib/adapters/safe-diagnostic-report.js`
- Modify: `lib/adapters/vscode-extension.js`
- Modify: `package.json`
- Modify: `tests/extension-contribution.test.js`

- [ ] **Step 1: Add failing package and command mock assertions**

Modify `tests/extension-contribution.test.js`.

After the assertion for `sqlBeautify.extractHiveDdl`, add:

```js
assert_includes(
    'package.json contributes copy safe diagnostic report command',
    command_ids(),
    'sqlBeautify.copySafeDiagnosticReport'
);

assert.strictEqual(
    command_by_id('sqlBeautify.copySafeDiagnosticReport').title,
    'SQL Beautify: Copy Safe Diagnostic Report',
    'safe diagnostic report command title must be user-facing and precise'
);
```

In `create_vscode_mock()`, add `infos: []` and `clipboardWrites: []` to the mock root object:

```js
        infos: [],
        clipboardWrites: [],
```

Inside `window`, add:

```js
            showInformationMessage: function(message) {
                mock.infos.push(message);
            },
```

After `window`, add:

```js
        env: {
            clipboard: {
                writeText: function(text) {
                    mock.clipboardWrites.push(text);
                    return Promise.resolve();
                }
            }
        },
```

In `run_mock_tests()` after existing command registration assertions, add:

```js
    assert.strictEqual(
        typeof vscodeMock.commandsById['sqlBeautify.copySafeDiagnosticReport'],
        'function',
        'activate must register safe diagnostic report command'
    );
```

Add this command test while the `sqlFormatter.format_sql_detailed` wrapper that pushes to `sqlCalls` is still active. A good location is immediately after the `beautifySql command path must match provider hive dialect default` assertion and before the DDL command assertions:

```js
    var diagnosticEditor = create_editor([
        "select private_column, 'secret-value' as literal_value",
        'from private_table -- private comment'
    ].join('\n'), [
        new vscodeMock.Range(create_position(0), create_position(80))
    ], true);
    diagnosticEditor.document.languageId = 'hive-sql';
    diagnosticEditor.document.uri = { fsPath: '/workspace/private.sql' };
    vscodeMock.window.activeTextEditor = diagnosticEditor;
    await vscodeMock.commandsById['sqlBeautify.copySafeDiagnosticReport']();
    assert.strictEqual(vscodeMock.clipboardWrites.length, 1, 'safe diagnostic command must write clipboard once');
    assert.ok(
        /SQL Beautify Safe Diagnostic Report/.test(vscodeMock.clipboardWrites[0]),
        'safe diagnostic command must copy markdown report'
    );
    [
        'private_column',
        'secret-value',
        'literal_value',
        'private_table',
        'private comment',
        '/workspace/private.sql'
    ].forEach(function(forbidden) {
        assert.strictEqual(
            vscodeMock.clipboardWrites[0].indexOf(forbidden),
            -1,
            'safe diagnostic clipboard report must not leak ' + forbidden
        );
    });
    assert.ok(
        vscodeMock.infos.some(function(message) {
            return /safe diagnostic report copied/.test(message);
        }),
        'safe diagnostic command must show success information'
    );
    assert.ok(
        sqlCalls.some(function(call) {
            return call.options && call.options.includeTelemetry === true && call.options.phase == 'command_format';
        }),
        'safe diagnostic command must call detailed formatter with telemetry enabled'
    );
```

- [ ] **Step 2: Run extension contribution test to verify it fails**

Run:

```bash
node tests/extension-contribution.test.js
```

Expected: FAIL because `sqlBeautify.copySafeDiagnosticReport` is not contributed or registered.

- [ ] **Step 3: Implement the adapter helper**

Create `lib/adapters/safe-diagnostic-report.js`:

```js
var packageJson = require('../../package.json');
var defaultSqlFormatter = require('../core/sql-formatter');
var defaultSafeReport = require('../core/sql-safe-diagnostic-report');
var vscodeConfig = require('./vscode-config');

function get_selected_text(vscode, editor) {
    var selections = editor.selections || [];
    var parts = [];
    var i;

    for (i = 0; i < selections.length; i++) {
        if (!selections[i].start.isEqual(selections[i].end)) {
            parts.push(editor.document.getText(new vscode.Range(selections[i].start, selections[i].end)));
        }
    }

    if (parts.length > 0) {
        return parts.join('\n');
    }

    return editor.document.getText();
}

function create_copy_safe_diagnostic_report_command(vscode, dependencies) {
    var deps = dependencies || {};
    var sqlFormatter = deps.sqlFormatter || defaultSqlFormatter;
    var safeReport = deps.safeReport || defaultSafeReport;
    var extensionVersion = deps.extensionVersion || packageJson.version;

    return function copy_safe_diagnostic_report() {
        var editor = vscode.window.activeTextEditor;
        var text;
        var config;
        var detailed;
        var report;
        var markdown;

        if (!editor) {
            vscode.window.showErrorMessage('SQL Beautify failed: no active editor.');
            return Promise.resolve(false);
        }

        text = get_selected_text(vscode, editor);
        config = vscodeConfig.get_sql_formatter_config(vscode, editor.document);
        config.includeTelemetry = true;
        config.phase = 'command_format';

        try {
            detailed = sqlFormatter.format_sql_detailed(text, config);
            report = detailed.safeReport || safeReport.create_report({
                text: text,
                phase: 'command_format',
                options: config,
                result: detailed,
                extensionVersion: extensionVersion
            });
        } catch (error) {
            report = safeReport.create_report({
                text: text,
                phase: 'command_format',
                options: config,
                error: error,
                result: {
                    telemetry: error.sqlBeautifyTelemetry,
                    diagnostics: error.sqlBeautifyDiagnostics || []
                },
                extensionVersion: extensionVersion
            });
        }

        report.extensionVersion = extensionVersion;
        markdown = safeReport.render_markdown(report);
        return vscode.env.clipboard.writeText(markdown).then(function() {
            vscode.window.showInformationMessage('SQL Beautify safe diagnostic report copied.');
            return true;
        }, function(error) {
            vscode.window.showErrorMessage('SQL Beautify failed: could not copy safe diagnostic report. ' + (error && error.message ? error.message : String(error)));
            return false;
        });
    };
}

exports.create_copy_safe_diagnostic_report_command = create_copy_safe_diagnostic_report_command;
```

- [ ] **Step 4: Register the command in `lib/adapters/vscode-extension.js`**

Add the require near the adapter requires:

```js
var safeDiagnosticReport = require('./safe-diagnostic-report');
```

Inside `activate(context)`, after `run_extract_hive_ddl()`, add:

```js
        var run_copy_safe_diagnostic_report = safeDiagnosticReport.create_copy_safe_diagnostic_report_command(vscode, {
            sqlFormatter: activeSqlFormatter
        });
```

After `disposable3Alias`, register:

```js
        var disposableSafeReport = vscode.commands.registerCommand('sqlBeautify.copySafeDiagnosticReport', run_copy_safe_diagnostic_report);
```

Push it to subscriptions:

```js
        context.subscriptions.push(disposableSafeReport);
```

- [ ] **Step 5: Add command contribution and activation event to `package.json`**

In `activationEvents`, after `onCommand:sqlBeautify.extractHiveDdl`, add:

```json
		"onCommand:sqlBeautify.copySafeDiagnosticReport"
```

In `contributes.commands`, after `sqlBeautify.extractHiveDdl`, add:

```json
			{
				"command": "sqlBeautify.copySafeDiagnosticReport",
				"title": "SQL Beautify: Copy Safe Diagnostic Report"
			}
```

- [ ] **Step 6: Run extension contribution test**

Run:

```bash
node tests/extension-contribution.test.js
```

Expected: PASS and prints `extension contribution tests passed`.

- [ ] **Step 7: Commit Task 3**

Run:

```bash
git add lib/adapters/safe-diagnostic-report.js lib/adapters/vscode-extension.js package.json tests/extension-contribution.test.js
git commit -m "feat: add safe diagnostic report command"
```

---

### Task 4: Test Scripts, Module Boundaries, And Docs

**Files:**
- Modify: `package.json`
- Modify: `tests/module-boundary.test.js`
- Modify: `docs/technical/sql-formatter-architecture.md`
- Modify: `README.md`

- [ ] **Step 1: Add failing `test:verify` and boundary assertions**

Modify `tests/module-boundary.test.js`.

After the existing `sql-diagnostics.js` existence assertion, add:

```js
assert.ok(
    fs.existsSync(path.join(__dirname, '..', 'lib/core/sql-safe-diagnostic-report.js')),
    'safe diagnostic report core module must exist'
);
assert.ok(
    fs.existsSync(path.join(__dirname, '..', 'lib/adapters/safe-diagnostic-report.js')),
    'safe diagnostic report adapter module must exist'
);
```

After the helper delegation assertions and before behavioral formatter assertions, add:

```js
var safeReportCoreSource = read_source('lib/core/sql-safe-diagnostic-report.js');
assert.strictEqual(
    /require\(['"]\.\.\/adapters\//.test(safeReportCoreSource),
    false,
    'safe diagnostic report core must not import adapters'
);
assert.strictEqual(
    /require\(['"]vscode['"]\)/.test(safeReportCoreSource),
    false,
    'safe diagnostic report core must not import vscode'
);
assert.deepStrictEqual(
    Object.keys(require('../lib/core/sql-safe-diagnostic-report')).sort(),
    [
        'assert_report_safe',
        'classify_result',
        'create_report',
        'render_markdown'
    ],
    'safe diagnostic report core export surface must stay narrow'
);

var safeReportAdapterSource = read_source('lib/adapters/safe-diagnostic-report.js');
assert.ok(
    /require\(['"]\.\.\/core\/sql-safe-diagnostic-report['"]\)/.test(safeReportAdapterSource),
    'safe diagnostic report adapter must import the core report helper'
);
```

Near the existing `test:verify` assertions, add `tests/safe-diagnostic-report.test.js` and `tests/formatter-telemetry.test.js` to the required test file list. If the list is built as an array, add:

```js
    'tests/safe-diagnostic-report.test.js',
    'tests/formatter-telemetry.test.js',
```

- [ ] **Step 2: Run module boundary test to verify it fails on scripts**

Run:

```bash
node tests/module-boundary.test.js
```

Expected: FAIL because `test:verify` does not yet include the new tests.

- [ ] **Step 3: Add package test scripts**

Modify `package.json` scripts.

Add:

```json
		"test:safe-report": "node tests/safe-diagnostic-report.test.js",
		"test:telemetry": "node tests/formatter-telemetry.test.js",
```

Update `test:verify` by inserting these commands after `node tests/diagnostics-explainability.test.js` or near other diagnostics tests:

```text
 && node tests/safe-diagnostic-report.test.js && node tests/formatter-telemetry.test.js
```

Keep the JSON valid and do not remove existing test commands.

- [ ] **Step 4: Document the architecture contract**

Modify `docs/technical/sql-formatter-architecture.md`.

In the `Boundaries` section, add:

```markdown
- `lib/core/sql-safe-diagnostic-report.js`: local-only report builder for restricted production debugging. It emits counts, classifications, safe labels, and timings only; it must not render raw SQL, formatted SQL, token values, file paths, URLs, unsupported snippets, or adapter state.
- `lib/adapters/safe-diagnostic-report.js`: VS Code command adapter for copying a fresh safe diagnostic report from the active document or selection. It owns clipboard integration and user messages.
```

In the `Diagnostics Contract` section, replace:

```markdown
- `format_sql()` remains text-only. `format_sql_detailed()` remains `{ text, diagnostics }` and is the diagnostics-bearing API.
```

with:

```markdown
- `format_sql()` remains text-only. Normal `format_sql_detailed()` remains `{ text, diagnostics }` and is the diagnostics-bearing API.
- `format_sql_detailed(text, { includeTelemetry: true })` is an internal diagnostic mode. It may return `telemetry` and `safeReport`, and formatter errors may carry `error.sqlBeautifyTelemetry`; this flag is not a public VS Code setting and must not change formatted output.
- `SQL Beautify: Copy Safe Diagnostic Report` (`sqlBeautify.copySafeDiagnosticReport`) copies a local Markdown report only when the user explicitly runs the command. The report is for restricted-environment debugging and must not contain SQL content, formatted SQL, identifiers, literals, comments, paths, URLs, or unsupported segment snippets.
```

- [ ] **Step 5: Add the end-user README note**

Modify `README.md`.

In the `怎么用` command list, after `SQL Beautify: Format SQL`, add:

```markdown
- 执行命令 `SQL Beautify: Copy Safe Diagnostic Report`：复制一份不包含 SQL 内容的诊断报告，用于在不能外发真实 SQL 的环境里反馈 warning、error 或慢格式化问题
```

Do not add telemetry phase names, internal classification mapping, or implementation details to `README.md`.

- [ ] **Step 6: Run focused checks**

Run:

```bash
node tests/module-boundary.test.js
node tests/safe-diagnostic-report.test.js
node tests/formatter-telemetry.test.js
node tests/extension-contribution.test.js
```

Expected: all PASS.

- [ ] **Step 7: Commit Task 4**

Run:

```bash
git add package.json tests/module-boundary.test.js docs/technical/sql-formatter-architecture.md README.md
git commit -m "test: enforce safe diagnostic report boundaries"
```

---

### Task 5: Full Verification And VSIX Smoke

**Files:**
- Modify only if verification exposes a real issue in files touched by Tasks 1-4.

- [ ] **Step 1: Run full regression**

Run:

```bash
npm run test:verify
```

Expected: PASS.

- [ ] **Step 2: Run local package build**

Run:

```bash
npm run package:vsix
```

Expected: PASS and produces `vscode-sql-beautify-v1.0.6.vsix` unless the version was intentionally changed before execution.

- [ ] **Step 3: Smoke-check VSIX content**

Run:

```bash
node - <<'NODE'
var cp = require('child_process');
var fs = require('fs');
var packageJson = require('./package.json');
var vsix = 'vscode-sql-beautify-v' + packageJson.version + '.vsix';
if (!fs.existsSync(vsix)) {
    throw new Error('missing package: ' + vsix);
}
var listing = cp.execFileSync('npx', ['--no-install', 'vsce', 'ls', '--packagePath', vsix], {
    encoding: 'utf8'
});
[
    'extension/lib/core/sql-safe-diagnostic-report.js',
    'extension/lib/adapters/safe-diagnostic-report.js'
].forEach(function(expected) {
    if (listing.indexOf(expected) < 0) {
        throw new Error('VSIX missing runtime module: ' + expected);
    }
});
[
    'extension/tests/safe-diagnostic-report.test.js',
    'extension/tests/formatter-telemetry.test.js',
    'extension/docs/superpowers/',
    'extension/lib/core/sql-select-formatter.js',
    'extension/lib/core/sql-case-formatter.js',
    'extension/lib/core/sql-comment-formatter.js',
    'extension/lib/core/sql-condition-formatter.js'
].forEach(function(forbidden) {
    if (listing.indexOf(forbidden) >= 0) {
        throw new Error('VSIX included forbidden path: ' + forbidden);
    }
});
console.log('safe diagnostic report VSIX smoke passed');
NODE
```

Expected: PASS and prints `safe diagnostic report VSIX smoke passed`.

- [ ] **Step 4: Check diff hygiene and ignored artifacts**

Run:

```bash
git diff --check
git status --short --ignored
```

Expected:

- `git diff --check` prints no errors.
- `git status --short --ignored` has no tracked or staged changes.
- Ignored `.DS_Store`, `node_modules/`, and `.vsix` artifacts may appear and must not be committed.

- [ ] **Step 5: Commit only if verification required fixes**

If Step 1-4 exposed issues and you changed tracked files, run:

```bash
git add lib/core/sql-safe-diagnostic-report.js lib/core/sql-formatter.js lib/adapters/safe-diagnostic-report.js lib/adapters/vscode-extension.js package.json tests/safe-diagnostic-report.test.js tests/formatter-telemetry.test.js tests/extension-contribution.test.js tests/module-boundary.test.js docs/technical/sql-formatter-architecture.md README.md
git commit -m "fix: stabilize safe diagnostic report verification"
```

Expected: commit succeeds. If no tracked files changed, do not create an empty commit.

---

## Final Review Checklist

- [ ] `node tests/safe-diagnostic-report.test.js` passes.
- [ ] `node tests/formatter-telemetry.test.js` passes.
- [ ] `node tests/extension-contribution.test.js` passes.
- [ ] `node tests/module-boundary.test.js` passes.
- [ ] `npm run test:verify` passes.
- [ ] `npm run package:vsix` passes.
- [ ] VSIX smoke confirms runtime safe report modules are included and tests/docs/obsolete facades are excluded.
- [ ] `git status --short --ignored` has no tracked/staged changes.
- [ ] The final response lists commits, validation commands, VSIX artifact name, and any residual risk.

## Execution Notes

- If `tests/safe-diagnostic-report.test.js` fails because the report leaks a value from the forbidden list, fix the renderer or normalizer. Do not weaken the forbidden list unless the value is a safe generic label such as `MATCH_RECOGNIZE`.
- If telemetry changes existing formatted output, revert the behavior change and keep timing as a side channel only.
- If `format_sql_detailed()` starts returning telemetry without `includeTelemetry: true`, fix compatibility before continuing.
- If the VS Code command test leaks `document.uri.fsPath`, remove any path usage from the report input. The command may use `document.uri` only for scoped config reads.
- If packaging includes `docs/superpowers/` or `tests/`, inspect `.vscodeignore`; do not commit `.vsix`.
