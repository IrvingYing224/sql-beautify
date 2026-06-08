# Production Regression And Diagnostics Design

## Objective

Build a production-oriented regression layer for the structured SQL formatter.

The formatter already has a structured pipeline, boundary tests, invariants, differential tests, and tokenizer profile smoke coverage. The next high-value step is not another broad internal split. The next step is a durable production signal:

- public anonymized SQL corpus committed to the repository
- optional local private SQL corpus runner for real-world samples that must not be committed
- strict golden snapshots for public formatted output
- p95-style performance reporting with wide CI regression gates
- more explainable unsupported-syntax diagnostics for users and maintainers

This design keeps the formatter's current behavior stable. It adds observability, regression assets, and diagnostic clarity around the existing core.

## Current State

Confirmed repository state:

- `npm run test:verify` already covers comment alignment, CASE, SELECT alignment, Hive regression, token boundaries, dialect boundaries, module boundaries, formatter invariants, structured differential tests, idempotency, DDL safety, support matrix generation, unsupported safety, performance smoke, and tokenizer profile.
- `tests/performance-smoke.test.js` uses a generated mixed corpus and enforces a wide total-time guard.
- `tests/tokenizer-profile.test.js` reports tokenizer calls, total tokenized characters, character ratio, and hotspot call sites.
- `format_sql_detailed()` returns `{ text, diagnostics }`, but unsupported warnings currently collapse into one generic `unsupported_syntax` diagnostic.
- `context.unsupportedSegments` currently stores `kind` and `text` only.
- VS Code diagnostics currently show simple warning/error messages and include richer data only in debug payloads.
- `.vscodeignore` excludes `docs/**` and `tests/**`, so new corpus, snapshots, and test helpers will not ship in the VSIX.

Main gaps:

- No committed production-shaped corpus with stable golden output snapshots.
- No supported private corpus entry point for local real SQL.
- Performance checks are useful smoke tests but not corpus-level p50/p95/max reports.
- Unsupported diagnostics do not give users a precise reason, fragment kind, suggested action, or stable structured metadata.

## Scope

### In Scope

1. Add public anonymized production corpus fixtures.
2. Add a public golden snapshot runner that strictly locks formatted output.
3. Add an optional private corpus runner controlled by environment variables.
4. Add corpus performance reporting with p50, p95, max, total elapsed, input size, and normalized throughput.
5. Add structured unsupported diagnostics while keeping `format_sql()` and `format_sql_detailed()` compatible.
6. Add VS Code-facing warning/error wording that explains what happened and what the user can do.
7. Add maintainer documentation for corpus, snapshot updates, private corpus, and performance interpretation.
8. Add package scripts and `test:verify` entries for public corpus checks.

### Out Of Scope

- Do not introduce a full SQL parser.
- Do not claim full SQL dialect support.
- Do not commit private or proprietary SQL.
- Do not intentionally change formatted output except for generated golden snapshots that record the current formatter behavior.
- Do not rewrite formatter mutation logic as part of this phase.
- Do not package tests, private corpus, docs, or generated reports into the VSIX.
- Do not make strict microbenchmark thresholds that are likely to fail on normal CI variance.

## Design Decisions

### Corpus Source Strategy

Use a hybrid strategy:

- Public corpus: committed, anonymized, CI-safe, deterministic.
- Private corpus: optional local directory specified by `SQL_BEAUTIFY_CORPUS_DIR`.

Public corpus provides repeatable CI protection. Private corpus gives maintainers a place to run real production samples without risking accidental commits.

### Snapshot Strategy

Use strict output snapshots for public corpus formatted output.

Rules:

- Public corpus formatted output must match committed snapshots exactly.
- Snapshot changes require an explicit update command:

```bash
SQL_BEAUTIFY_UPDATE_SNAPSHOTS=1 node tests/production-corpus-golden.test.js
```

- The update command should only affect public snapshot files.
- Private corpus output is never snapshotted by default.
- Diagnostic and performance tests should use structured assertions and summary fields rather than brittle full prose snapshots.

### Performance Budget Strategy

Use two layers:

- CI gate: wide disaster-prevention thresholds.
- Local/reporting mode: detailed p50, p95, max, total elapsed, input size, and ms-per-10k-chars output for trend review.

This avoids pretending that timing is perfectly reproducible across machines while still catching severe regressions.

### Diagnostics Strategy

Keep the public API shape:

```js
format_sql_detailed(sql, options) -> {
    text: string,
    diagnostics: array
}
```

Improve the diagnostic payload shape:

```js
{
    level: 'warning',
    code: 'unsupported_syntax',
    message: '...',
    action: '...',
    unsupportedSegments: [
        {
            kind: 'opaque_clause',
            code: 'unsupported_opaque_clause',
            label: 'MATCH_RECOGNIZE',
            text: 'match_recognize (...)',
            snippet: 'match_recognize (...)',
            range: { start: 16, end: 140 },
            source: 'opaque_protection',
            confidence: 'known_low_confidence',
            action: 'Review the preserved fragment, or set sqlBeautify.unsupportedSyntaxPolicy to bail_out to reject it.'
        }
    ]
}
```

The exact message text may evolve, but `level`, `code`, `kind`, `label`, `text`, `snippet`, `range`, `source`, `confidence`, and `action` should be stable enough for tests.

`unsupportedSegments` remains present for compatibility, but its items become richer objects.

For `unsupportedSyntaxPolicy=bail_out`, the thrown error should keep the existing recognizable prefix:

```text
Unsupported SQL fragment detected under bail_out policy
```

It may append the first segment label and suggested action after that prefix.

## File Structure

Create:

- `tests/fixtures/production-corpus/public/*.sql`
  - anonymized committed SQL cases
- `tests/fixtures/production-corpus/public/*.options.json`
  - per-case formatter options where defaults are not enough
- `tests/fixtures/production-corpus/snapshots/*.formatted.sql`
  - strict public formatted-output snapshots
- `tests/helpers/production-corpus.js`
  - corpus discovery, option loading, formatting helpers, snapshot path helpers
- `tests/helpers/performance-report.js`
  - p50/p95/max and normalized throughput helpers
- `tests/production-corpus-golden.test.js`
  - public corpus formatted-output snapshot test
- `tests/production-corpus-private.test.js`
  - optional private corpus smoke runner
- `tests/production-performance-budget.test.js`
  - public corpus performance report and wide CI gates
- `tests/diagnostics-explainability.test.js`
  - structured diagnostic behavior and user-facing message assertions
- `lib/core/sql-diagnostics.js`
  - diagnostic segment normalization, summary message, and action helpers

Modify:

- `lib/core/sql-unsupported-policy.js`
  - normalize unsupported segment payloads and improve bail-out error detail
- `lib/core/sql-syntax-risk-detector.js`
  - include structured range/snippet/label/source metadata when reporting known low-confidence syntax
- `lib/core/sql-clause-splitter.js`
  - include structured range/snippet/label/source metadata when protecting opaque syntax
- `lib/core/sql-format-context.js`
  - keep `unsupportedSegments`, but allow richer segment objects
- `lib/core/sql-formatter.js`
  - use structured diagnostic summaries in `collect_runtime_diagnostics`
- `lib/adapters/formatter-diagnostics.js`
  - show clearer warnings/errors while preserving debug payloads
- `tests/unsupported-safety.test.js`
  - keep existing safety assertions and add stable diagnostic-shape assertions if needed
- `tests/extension-contribution.test.js`
  - verify VS Code warning text is actionable
- `tests/module-boundary.test.js`
  - enforce the new diagnostics helper boundary
- `package.json`
  - add public corpus, private corpus, performance budget, diagnostics explainability scripts
- `docs/technical/sql-formatter-architecture.md`
  - document production corpus and structured diagnostics contracts

Do not modify:

- `README.md`, unless a later release explicitly wants user-facing docs.
- root `lib/*.js` compatibility shims.
- `lib/experimental/ddl/`.
- `.github/workflows/*`.

## Public Corpus Case Set

Start with a small but production-shaped public corpus:

1. `hive-cte-window-comments.sql`
   - CTE
   - window function
   - CASE
   - JOIN
   - comments inside condition/list contexts
2. `hive-template-variables.sql`
   - common scheduler placeholders and Hive partition filters
   - comments near placeholders
   - string literals that look like SQL
3. `postgres-json-dollar.sql`
   - dollar strings
   - JSON operators
   - quoted strings containing SQL-looking content
4. `unsupported-match-recognize.sql`
   - `MATCH_RECOGNIZE(...)` opaque protection
   - `unsupportedSyntaxPolicy=warn`
5. `unsupported-pivot-qualify-safety.sql`
   - real `PIVOT` table construct under warn policy
   - `qualify` and `pivot` words in safe identifier/function positions

The public set should stay small enough to keep CI cheap. More cases can be added later when production bugs are found.

## Private Corpus

Private corpus runner behavior:

- If `SQL_BEAUTIFY_CORPUS_DIR` is unset, print a skip message and exit 0.
- If set, load `*.sql` files recursively from that directory.
- Optionally load sibling `*.options.json` files.
- Format each file with `format_sql_detailed()`.
- Assert:
  - no formatter exception
  - output is idempotent
  - output preserves a trailing newline
  - diagnostics are valid structured objects
- Do not write snapshots by default.
- Do not include private corpus in `npm run test:verify`.

This runner is for maintainers and release-prep checks, not normal CI.

## Golden Snapshot Flow

Public snapshot test behavior:

1. Load each public case.
2. Format with case options.
3. If snapshot is missing and `SQL_BEAUTIFY_UPDATE_SNAPSHOTS=1`, write it.
4. If snapshot is missing without update mode, fail with a message explaining the update command.
5. If snapshot exists but differs, fail with the case name and update command.
6. In all modes, verify idempotency by formatting the snapshot output again.

Snapshot files use `.formatted.sql` so reviewers can read diffs directly.

## Performance Flow

Performance budget test behavior:

1. Load public corpus cases.
2. Warm each case once.
3. Time each case once or a small fixed number of iterations.
4. Emit a summary:
   - case count
   - total input chars
   - total elapsed ms
   - p50 ms
   - p95 ms
   - max ms
   - max ms per 10k chars
5. Enforce wide gates:
   - total elapsed under a generous cap
   - max single-case elapsed under a generous cap
   - p95 normalized throughput under a generous cap

The exact caps should be documented in the test and treated as disaster guards, not performance promises.

## Diagnostics Flow

Detection and protection should create structured unsupported segment records:

```text
sql-syntax-risk-detector / sql-clause-splitter
    -> sqlUnsupportedPolicy.note_unsupported(context, kind, segment)
    -> sql-diagnostics normalizes segment
    -> format_sql_detailed() returns aggregate runtime diagnostic when policy=warn
    -> adapter shows actionable warning
```

Segment records should include enough information to answer:

- What construct was detected?
- Was it protected as opaque or only reported as low-confidence?
- Which approximate source range or snippet was involved?
- What should the user do if they require strict behavior?

## Error Handling

- Snapshot update failures should report the exact file path that could not be written.
- Invalid `*.options.json` should fail with the case path and JSON parse error.
- Private corpus unreadable files should fail the private runner, because that is a local environment problem.
- `bail_out` should throw a clear error and must not replace source text in VS Code.
- VS Code diagnostics should keep debug payloads behind `sqlBeautify.debugDiagnostics`.

## Testing And Validation

Targeted checks:

```bash
node tests/production-corpus-golden.test.js
node tests/production-performance-budget.test.js
node tests/diagnostics-explainability.test.js
node tests/unsupported-safety.test.js
node tests/extension-contribution.test.js
node tests/module-boundary.test.js
```

Private corpus check:

```bash
SQL_BEAUTIFY_CORPUS_DIR=/path/to/private/sql node tests/production-corpus-private.test.js
```

Full verification:

```bash
npm run test:verify
```

Packaging smoke:

```bash
ALL_PROXY=socks5://127.0.0.1:7897 npm run package:vsix
```

VSIX content should still exclude `tests/**` and `docs/**` through `.vscodeignore`.

## Risks And Mitigations

- **Risk: golden snapshots lock existing imperfect formatting.** Mitigation: this phase locks current behavior intentionally. If a snapshot exposes an obvious bug, fix it in a separate behavior-change task with explicit before/after review.
- **Risk: performance tests become flaky.** Mitigation: use wide disaster gates and report trends instead of narrow microbenchmark claims.
- **Risk: private corpus leaks.** Mitigation: private corpus path is env-driven, not committed; `.gitignore` can include local corpus/report directories if new local defaults are introduced.
- **Risk: diagnostics become too noisy in VS Code.** Mitigation: return one aggregate warning per format operation, with structured segment details in payload/debug data.
- **Risk: diagnostic prose tests become brittle.** Mitigation: lock structure and key phrases, not complete paragraphs.
- **Risk: corpus helper grows into a second formatter harness.** Mitigation: helpers only load cases, options, snapshots, and reports; formatter behavior stays in `lib/core/`.

## Success Criteria

- Public production corpus cases exist and are covered by strict golden output snapshots.
- Snapshot updates require explicit opt-in through `SQL_BEAUTIFY_UPDATE_SNAPSHOTS=1`.
- Optional private corpus runner exists and skips cleanly when `SQL_BEAUTIFY_CORPUS_DIR` is unset.
- Corpus performance report prints p50, p95, max, total elapsed, input size, and normalized throughput with wide CI gates.
- Unsupported diagnostics include stable structured segment metadata and actionable user-facing warning/error text.
- Existing `format_sql()` behavior remains text-only and compatible.
- `format_sql_detailed()` still returns `{ text, diagnostics }`.
- `npm run test:verify` includes public corpus, performance budget, and diagnostics explainability checks.
- `npm run package:vsix` passes and generated `.vsix` artifacts remain untracked.
