# Safe Diagnostic Report Design

## Objective

Improve production debugging in environments where real SQL cannot be copied out of the workspace.

The extension should be able to produce a safe diagnostic report that helps maintainers understand formatter failures, warnings, slow cases, and unsupported syntax without exposing SQL content. The report must not include original SQL, table names, column names, string literals, comments, paths, URLs, or copied fragments.

The goal is observability, not telemetry. Everything stays local unless the user explicitly copies the safe report.

## Current State

The formatter already exposes:

- `format_sql(text, options)` returning formatted text
- `format_sql_detailed(text, options)` returning `{ text, diagnostics }`
- structured unsupported diagnostics with segment fields such as `kind`, `code`, `label`, `source`, `confidence`, `range`, and `action`
- VS Code warning/error display through `lib/adapters/formatter-diagnostics.js`
- `sqlBeautify.debugDiagnostics=true` for debug console payloads
- range-safety rejection before unsafe range formatting
- public production corpus, private corpus runner, and performance budget tests

The missing piece is a safe, copyable diagnostic artifact for restricted environments. Current warning/error text can tell a user something went wrong, but it does not provide a structured, shareable, no-content report.

## Scope

### In Scope

1. Add a core safe report builder that computes non-content statistics and failure classification.
2. Add formatter phase telemetry for `format_sql_detailed()` without changing formatted output.
3. Add a VS Code command that copies a safe diagnostic report for the active document or selection.
4. Add adapter-level reports for unsafe range, formatter throw, overlapping selections, and rejected edits where possible.
5. Add tests that prove report output does not contain SQL identifiers, strings, comments, paths, URLs, or raw SQL fragments.
6. Document the report contract in the maintainer architecture doc.

### Out Of Scope

- Do not upload telemetry.
- Do not write reports to disk by default.
- Do not include SQL content or anonymized SQL.
- Do not add a full SQL parser.
- Do not change formatter output.
- Do not change DDL / Extract DDL behavior.
- Do not add root shim logic.
- Do not change public production corpus snapshots unless a test reveals an existing bug and that behavior change is separately approved.

## User Experience

Add a command:

```text
SQL Beautify: Copy Safe Diagnostic Report
```

Command id:

```text
sqlBeautify.copySafeDiagnosticReport
```

Behavior:

- If there is an active selection, build the report for selected text.
- If there is no active selection, build the report for the full document.
- Use current `sqlBeautify.*` config for the target document.
- Run a diagnostic-only formatting pass with telemetry enabled.
- Copy a Markdown report to the clipboard.
- Show an information message such as `SQL Beautify safe diagnostic report copied.`
- If formatting throws, still copy a report containing failure classification and safe structural stats collected before failure where available.

No legacy `extension.*` command alias is required for this new command. This keeps the public command surface modern and avoids reopening old compatibility naming.

## Safe Report Content

The copied report should be Markdown and include only safe fields:

```markdown
# SQL Beautify Safe Diagnostic Report

- extensionVersion: 1.0.6
- reportVersion: 1
- phase: command_format
- classification: unsupported_syntax
- dialect: hive
- unsupportedSyntaxPolicy: warn
- input:
  - chars: 12452
  - lines: 310
  - tokens: 2840
  - codeTokens: 1790
  - commentTokens: 36
  - stringLiterals: 18
  - quotedIdentifiers: 4
- structure:
  - SELECT: 7
  - JOIN: 12
  - CASE: 9
  - WINDOW: 3
  - CTE: 2
  - SUBQUERY: 4
- diagnostics:
  - code: unsupported_syntax
    labels: MATCH_RECOGNIZE
    sources: opaque_protection
- telemetry:
  - totalMs: 84
  - phases:
    - syntax_risk_detection: 2
    - protect_input: 4
    - format_document: 8
    - scope_model: 11
    - format_nodes: 9
    - mutation_plan: 23
    - render: 19
    - restore: 5
- reproductionHints:
  - Build an anonymized SQL with roughly 2 CTEs, 12 JOINs, 9 CASE expressions, and 3 window expressions.
```

Forbidden content:

- original SQL
- formatted SQL
- table names
- column names
- alias names
- string literal values
- comment text
- quoted identifier values
- file paths
- URLs
- snippets from unsupported segments

Diagnostic segment `text` and `snippet` must not be copied into the safe report.

## Core Architecture

Create a focused core helper:

```text
lib/core/sql-safe-diagnostic-report.js
```

Responsibilities:

- Build safe input stats from tokenizer output.
- Build safe structure counts from `FormatDocument`, scopes, and nodes.
- Normalize diagnostics into no-content summaries.
- Normalize telemetry into phase timing summaries.
- Classify failures.
- Render a Markdown report.

Expected exports:

```js
create_report(input)
render_markdown(report)
classify_result(input)
assert_report_safe(reportText, forbiddenValues)
```

`assert_report_safe` is intended for tests and should scan the rendered report for known forbidden values from test SQL.

The helper must not import VS Code adapter modules and must not write to disk.

## Formatter Telemetry

`format_sql_detailed(text, options)` should accept an internal option such as:

```js
{
    includeTelemetry: true
}
```

Canonical formatter options remain unchanged. The option is only consumed by `format_sql_detailed()` and should not become a public VS Code setting.

When enabled, detailed result includes:

```js
{
    text: '...',
    diagnostics: [],
    telemetry: {
        totalMs: 0,
        phases: [
            { name: 'syntax_risk_detection', ms: 0, status: 'ok' },
            { name: 'protect_input', ms: 0, status: 'ok' },
            { name: 'format_document', ms: 0, status: 'ok' },
            { name: 'scope_model', ms: 0, status: 'ok' },
            { name: 'format_nodes', ms: 0, status: 'ok' },
            { name: 'mutation_plan', ms: 0, status: 'ok' },
            { name: 'render', ms: 0, status: 'ok' },
            { name: 'restore', ms: 0, status: 'ok' }
        ]
    },
    safeReport: { ... }
}
```

When `includeTelemetry` is absent or false, existing callers should continue to receive `{ text, diagnostics }` without relying on telemetry.

Implementation should use `Date.now()` for consistency with existing performance tests.

## Failure Classification

Use stable classifications:

- `ok`
- `unsupported_syntax`
- `unsafe_range`
- `formatter_throw`
- `invariant_violation`
- `vscode_rejected_edit`
- `overlapping_selection`
- `slow_format`
- `unknown`

Mapping:

- unsupported diagnostics present: `unsupported_syntax`
- range policy rejection: `unsafe_range`
- thrown formatter error with invariant-looking message: `invariant_violation`
- other thrown formatter error: `formatter_throw`
- editor edit false: `vscode_rejected_edit`
- overlapping selections: `overlapping_selection`
- elapsed over a generous local threshold: `slow_format`
- successful format without warnings: `ok`

The classification should be included in both structured report and rendered Markdown.

## Adapter Architecture

Create an adapter helper:

```text
lib/adapters/safe-diagnostic-report.js
```

Responsibilities:

- Read active editor text or selection.
- Read `sqlBeautify.*` config scoped to the active document.
- Call `format_sql_detailed(text, configWithTelemetry)`.
- Pass result to `lib/core/sql-safe-diagnostic-report.js`.
- Copy rendered Markdown to `vscode.env.clipboard.writeText`.
- Show success/error messages through existing diagnostics style.

`lib/adapters/vscode-extension.js` should register only:

```text
sqlBeautify.copySafeDiagnosticReport
```

No legacy command id should be added.

## Data Flow

```text
VS Code command
    -> active document / selection text
    -> vscode-config canonical options
    -> format_sql_detailed(includeTelemetry=true)
    -> safe report builder
    -> markdown renderer
    -> vscode.env.clipboard.writeText(markdown)
    -> show information message
```

For range failures and editor-level failures:

```text
range policy / editor failure
    -> failure classification
    -> safe report builder with input stats and failure metadata
    -> copy command output
```

The first implementation should focus on generating a fresh report from the active editor when the user runs the copy command. It should not persist a "last report" payload from normal formatter commands; that would add statefulness and stale-report risk without being required for restricted-environment debugging.

## Testing

Add focused tests:

- `tests/safe-diagnostic-report.test.js`
  - report contains counts and classifications
  - report excludes known table names, column names, string literals, comments, URLs, and unsupported snippets
  - report includes no `SQLBEAUTIFY_` internal markers
- `tests/formatter-telemetry.test.js`
  - `format_sql_detailed(..., { includeTelemetry: true })` returns phase timings
  - normal `format_sql_detailed()` remains compatible
  - thrown errors can be classified safely
- `tests/extension-contribution.test.js`
  - package contributes the new command
  - activation registers the new command
  - command writes a safe report to mock clipboard
  - report does not include raw SQL identifiers from the document
- `tests/module-boundary.test.js`
  - core safe report helper exports are narrow
  - adapter helper does not get imported by core

Update `npm run test:verify` to include new tests.

## Documentation

Update `docs/technical/sql-formatter-architecture.md`:

- safe diagnostic report contract
- no-content guarantee
- telemetry is local and opt-in through internal detailed formatting
- report command is `sqlBeautify.copySafeDiagnosticReport`

README update is optional. Because this feature is user-facing, a short README note is acceptable if it remains end-user focused and does not include internal architecture detail.

## Risks And Mitigations

- **Risk: report leaks SQL content.** Mitigate with explicit forbidden-value tests and by never rendering token values, snippets, raw diagnostics `text`, formatted output, or document path.
- **Risk: telemetry changes formatter behavior.** Mitigate by keeping telemetry side-channel only and preserving `format_sql()` output tests.
- **Risk: command copies stale or failed data.** Mitigate by generating the report on demand from the active editor and including classification.
- **Risk: report becomes too noisy.** Mitigate by keeping a compact Markdown report with counts and labels only.
- **Risk: VS Code clipboard is unavailable in tests.** Mitigate with mock `vscode.env.clipboard.writeText`.

## Success Criteria

- A user can run `SQL Beautify: Copy Safe Diagnostic Report` from VS Code.
- The copied report contains useful structure, diagnostics, classification, and timing data.
- The copied report contains no raw SQL content from the tested document.
- `format_sql()` remains unchanged.
- `format_sql_detailed()` remains compatible and only adds telemetry/report fields when requested.
- New tests are included in `npm run test:verify`.
- `npm run package:vsix` includes runtime helper modules and excludes tests/docs as before.
