# List Layout And CASE Layout Strategy Design

## Objective

Evolve the structured SQL formatter so clause list layout and CASE expression layout can grow without accumulating one-off behavior in SELECT-specific modules.

The immediate feature goals are:

- format top-level `ORDER BY` like `GROUP BY`, with aligned leading commas
- add an explicit CASE layout strategy so short safe CASE expressions can stay on one line

The architectural goal is more important than landing both features at once. The current formatter is usable, so this work can proceed in iterations that first improve ownership boundaries and then add visible behavior.

## Current State

Confirmed from the current code:

- `lib/core/sql-list-nodes.js` identifies `selectList` and `groupByList` spans and assigns separator ownership.
- `lib/core/sql-select-mutations.js` applies structured list layout for SELECT and GROUP BY, plus SELECT-specific behavior such as `AS` alignment and CASE item coordination.
- Top-level `ORDER BY` is not modeled as the same kind of structured list. Its comma spacing is normalized, but it does not get GROUP BY-style multiline layout.
- Window `ORDER BY` has existing protected spacing behavior and tests. In particular, the current double-space contract before the first window order expression must not change unless a separate plan approves it.
- `lib/core/sql-case-mutations.js` owns structured CASE layout. The public configuration has `caseWhenThenWrapLength`, but no CASE layout mode.
- Core canonical options currently include `keywordCase`, `commaStyle`, `indentStyle`, `maxAlignWidth`, `caseWhenThenWrapLength`, `dialect`, and `unsupportedSyntaxPolicy`.

The main design pressure is that `sql-select-mutations.js` is no longer only SELECT-specific. It is already a mixed list layout owner for SELECT and GROUP BY. Adding ORDER BY directly to that file would work short term, but it would make future list behavior harder to audit.

## Proposed Direction

Use three iterations:

1. Make list layout a first-class structured concept while preserving output.
2. Add top-level `ORDER BY` to that list layout model.
3. Add CASE layout strategy as an explicit configuration surface.

This is not a full parser rewrite. The formatter should continue using the current tokenizer, scope model, node extraction, mutation plan, and structured renderer. The improvement is to make the existing structured model more general where it already has a clear pattern.

## Iteration 1: First-Class List Layout

### Goal

Separate generic list layout from SELECT-specific mutation behavior without intentionally changing formatted SQL output.

### Design

Keep `sql-list-nodes.js` responsible for identifying list spans and assigning comma separator ownership. Its role should stay structural:

- where a list starts and ends
- what kind of list it is
- which commas belong to that list
- which commas belong to nested function calls, `IN` lists, window specs, or parenthesized lists instead

Introduce or evolve a focused module for generic list layout, for example:

```text
lib/core/sql-list-mutations.js
```

Expected responsibilities:

- apply list item line breaks
- apply leading or trailing comma placement for supported structured lists
- compute first-item prefix text such as `SELECT  ` or `GROUP BY  `
- compute continuation indent for subsequent items
- avoid changing separators owned by function calls, `IN` lists, window specs, or parenthesized lists

`sql-select-mutations.js` should remain responsible for SELECT-specific behavior:

- `AS` alignment
- SELECT item CASE coordination
- SELECT hint and standalone comment handling
- multiline top-level function SELECT items
- field trailing comment alignment interactions that depend on SELECT item width

GROUP BY behavior can move to the generic list module only where it is truly generic. GROUP BY extensions such as `WITH CUBE`, `WITH ROLLUP`, and `WITH GROUPING SETS` can stay in SELECT-adjacent code until their ownership is worth splitting.

### Behavior Contract

Iteration 1 should be behavior-preserving. Existing outputs for these areas should not change:

- SELECT leading comma layout
- GROUP BY leading comma layout
- function argument commas
- `IN (...)` commas
- window `ORDER BY` spacing
- SELECT `AS` alignment
- CASE branch layout
- trailing field comment alignment
- Hive GROUP BY extensions

## Iteration 2: Top-Level ORDER BY List Layout

### Goal

Add `orderByList` as a structured top-level list and format it like GROUP BY, while explicitly excluding window `ORDER BY`.

### Design

Extend list span extraction so it can produce:

```text
orderByList
```

An `orderByList` starts at a recognized top-level `ORDER BY` clause and ends before the next top-level clause or query boundary, such as:

- `LIMIT`
- `UNION`
- `QUALIFY`
- dialect-specific known clause boundaries
- the end of the current query scope

The extractor must not create `orderByList` inside a `windowSpec` scope. Window `ORDER BY` should keep using the existing spacing path and tests.

The expected leading-comma style is:

```sql
ORDER BY  dt DESC
         ,event_time DESC
         ,id
```

The first item keeps the clause prefix. Continuation items align under the first ordered expression and carry the leading comma when `commaStyle` is `leading`.

For trailing comma style, use the same structured list policy as SELECT/GROUP BY if the project already supports it there. Do not invent ORDER BY-only trailing comma behavior.

### Non-Goals

- Do not change window `ORDER BY` layout.
- Do not split `ORDER BY` expressions inside function calls.
- Do not split commas inside `IN (...)`.
- Do not parse sort directions as separate layout items.
- Do not add an ORDER BY-specific VS Code setting in this iteration.

## Iteration 3: CASE Layout Strategy

### Goal

Add an explicit CASE layout strategy so users can opt into compact single-line CASE formatting for short safe expressions without changing the default behavior.

### Configuration

Add a canonical core option and VS Code setting:

```json
"sqlBeautify.caseLayout": "expanded" | "compactShort"
```

Default:

```json
"expanded"
```

`expanded` preserves current behavior.

`compactShort` allows the formatter to keep or render a CASE expression on one line only when it is safe and short.

### Compact Eligibility

A CASE expression is eligible for compact layout only when all of these are true:

- it is not nested inside another CASE
- it has no line comments or block comments inside the CASE expression
- its WHEN, THEN, ELSE, and END tokens can render on one physical line within a configured width threshold
- it has no multiline `IN` list, multiline function call, or multiline parenthesized list inside the CASE
- it does not contain a nested CASE branch value
- it does not require branch value wrapping under `caseWhenThenWrapLength`
- compact rendering does not break SELECT `AS` alignment or trailing field comment alignment

The compact output should look like:

```sql
CASE WHEN status = 1 THEN 'Y' ELSE 'N' END AS is_active
```

If any eligibility check fails, `compactShort` falls back to the current expanded CASE layout.

### Width Policy

Use a focused width option only if existing options are insufficient. The first implementation can reuse `caseWhenThenWrapLength` as the compact CASE guard if that produces clear behavior. If that becomes confusing, introduce a separate option such as:

```json
"sqlBeautify.caseCompactMaxWidth": 80
```

Do not add this second option until the implementation proves it is needed. The public option surface should stay small.

## Architecture Boundaries

The target ownership after these iterations:

- `sql-list-nodes.js`: structured list spans and separator ownership for SELECT, GROUP BY, and top-level ORDER BY.
- `sql-list-mutations.js`: generic structured list layout.
- `sql-select-mutations.js`: SELECT-specific layout, width, `AS`, comment, CASE item, and top-level function behavior.
- `sql-case-mutations.js`: CASE layout strategies.
- `sql-render-token-spacing.js`: token adjacency spacing policy.
- `sql-token-renderer.js`: mutation-facing token rendering facade.

Root `lib/*.js` shims must remain compatibility re-exports only. Adapters should only map public `sqlBeautify.*` settings to canonical core options. Experimental DDL should not be involved.

## Testing Strategy

### Iteration 1

Because Iteration 1 is intended to preserve behavior, run focused and broad regression checks:

```bash
node tests/select-alignment.test.js
node tests/window-function-spacing.test.js
node tests/token-spacing-policy.test.js
node tests/module-boundary.test.js
node tests/pipeline-idempotency.test.js
npm run test:verify
git diff --check
```

Add module-boundary coverage so generic list logic does not move into root shims, adapters, renderer spacing policy, or CASE modules.

### Iteration 2

Add targeted ORDER BY regression tests:

- top-level ORDER BY with two or more sort keys becomes multiline
- window `ORDER BY` remains unchanged
- function argument commas in ORDER BY expressions remain inline
- `IN (...)` commas remain inline
- SELECT leading comma behavior remains unchanged
- trailing field comments and `AS` alignment remain stable around queries that also have ORDER BY
- idempotency holds after formatting an already formatted ORDER BY list

Run:

```bash
node tests/select-alignment.test.js
node tests/window-function-spacing.test.js
node tests/token-spacing-policy.test.js
node tests/pipeline-idempotency.test.js
npm run test:verify
git diff --check
```

### Iteration 3

Add targeted CASE layout tests:

- default `expanded` output remains current output
- `compactShort` compacts a short simple CASE
- `compactShort` does not compact CASE with comments
- `compactShort` does not compact nested CASE
- `compactShort` does not compact multiline `IN` lists or multiline function calls
- `compactShort` preserves SELECT `AS` alignment
- `compactShort` preserves trailing field comment alignment
- idempotency holds for compact and expanded CASE outputs

Run:

```bash
node tests/case-when.test.js
node tests/select-alignment.test.js
node tests/comment-alignment.test.js
node tests/config-options.test.js
node tests/pipeline-idempotency.test.js
npm run test:verify
git diff --check
```

If package metadata or runtime file lists change, also run:

```bash
npm run package:vsix
```

Local verification commands do not use proxy.

## Risks And Tradeoffs

The main risk is not correctness of one new feature, but ownership drift. If ORDER BY is added by extending SELECT-specific logic directly, the formatter will work but become harder to extend. The design accepts more iteration work now to keep list behavior auditable later.

The second risk is over-generalizing list layout. Avoid a broad abstraction that tries to model every possible SQL list. Start with SELECT, GROUP BY, and top-level ORDER BY because they already share visible layout behavior. Defer window partition/order lists and function argument multiline formatting until there is a real feature need.

The third risk is compact CASE changing readability in surprising places. Make compact layout opt-in and conservative. If the formatter cannot prove a CASE is short and safe, keep the expanded form.

## Success Criteria

- Generic list layout has a clear owner separate from SELECT-specific behavior.
- Existing SELECT and GROUP BY output stays stable after the first iteration.
- Top-level ORDER BY can use GROUP BY-style aligned leading commas without affecting window ORDER BY.
- CASE compact layout is opt-in and falls back safely for complex CASE expressions.
- Public configuration remains small and uses only `sqlBeautify.*`.
- Tests lock behavior around function arguments, `IN`, window ORDER BY, SELECT leading commas, and trailing comment alignment.
