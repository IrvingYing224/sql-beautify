# Tokenizer and Query Layout Correctness Design

## Objective

Fix the highest-risk correctness issues identified in `docs/technical/engineering-review-2026-06-16.md` without mixing in cleanup-only refactors.

This design covers two behavior classes:

- Tokenizer hardening for SQL literals and Hive variable substitutions that are currently split into unsafe token sequences.
- Query layout idempotency for compact CTE and subquery inputs whose second formatting pass changes the first formatted output.

This design intentionally excludes `sql-clause-splitter.js` dead-code cleanup, `sql-shield.js` fallback cleanup, and broad performance work. Those are useful follow-ups, but they do not need to share a change set with semantic correctness fixes.

## Confirmed Problems

The following inputs are confirmed to produce semantically unsafe or unstable output in the current repository:

```sql
select 6.022e23 from t
select 1.5e-3 from t
select 0xFF, x'1F' from t
select .5, x from t
select a from ${db}.tbl where dt=${hivevar:day}
with c as (select a from t) select * from c
select * from t where x in (select id from u)
```

The tokenizer problem is concentrated in `lib/core/sql-tokenizer.js`:

- Decimal numbers only consume `[0-9.]`, so exponent notation is split.
- Hex numbers are split after the leading `0`.
- Typed string and binary literals such as `x'1F'` are split into a word plus a string.
- Leading-dot decimals are tokenized as punctuation plus number, and the renderer later joins them to the preceding keyword in unsafe ways.
- Hive substitutions such as `${db}` are tokenized as `$` plus `{db}`, which allows renderer spacing to corrupt them.

The query-layout problem is in the structured formatting path. Compact CTE subqueries are expanded on the first pass, but the inner query may remain single-line until the second pass. `IN (select ...)` is currently treated as an inline exemption and can also render with asymmetric spacing.

## Scope

In scope:

- Extend `lib/core/sql-tokenizer.js` with focused readers for:
  - decimal and exponent numeric literals
  - leading-dot decimal literals
  - hexadecimal numeric literals
  - typed quoted literals with a word prefix immediately followed by a quote
  - Hive-style `${...}` substitutions
- Preserve existing string, comment, block comment, quoted identifier, PostgreSQL dollar string, and `{...}` placeholder behavior.
- Treat Hive substitutions as opaque code tokens that preserve their exact bytes and do not become structural SQL.
- Adjust query layout so the first formatting pass reaches a stable representation for compact CTE and parenthesized query scopes.
- Normalize `IN (select ...)` spacing so it is internally consistent and idempotent.
- Add focused regression tests before implementation.

Out of scope:

- Replacing the tokenizer with a full SQL lexer.
- Supporting every dialect-specific literal form beyond the cases above.
- Renaming or deleting `sql-clause-splitter.js`.
- Removing the `sql-shield.js` fallback branch.
- Changing VS Code settings, adapters, packaging metadata, README, or DDL behavior.

## Design

### Tokenizer

Add small reader functions to `lib/core/sql-tokenizer.js` rather than adding renderer exceptions. The tokenizer is the correct ownership boundary because every later formatting stage depends on token types and token spans.

Proposed token behavior:

- `6.022e23`, `1e10`, `1.5e-3`, `1E+3` become single `number` tokens.
- `.5` and `.5e2` become single `number` tokens when `.` is followed by a digit.
- `0xFF` and `0X1a` become single `number` tokens when `0x` or `0X` is followed by at least one hex digit.
- `x'1F'`, `X'1F'`, `b'0101'`, and `B'0101'` become single `string_literal` tokens by consuming the prefix and the following quoted string as one token.
- `${db}`, `${hivevar:day}`, and `${hiveconf:warehouse}` become single `placeholder` tokens, including the leading `$`.
- Existing `{name}` placeholder behavior remains unchanged for non-dollar placeholders.

The tokenizer should be conservative. If a prefix is incomplete, such as `0x` with no hex digit or `$` not followed by `{...}`, fall back to existing tokenization instead of guessing.

### Structured Query Layout

The current layout pipeline already has query scopes in `lib/core/sql-scope-model.js` and scope layout mutations in `lib/core/sql-layout-formatter.js`. The fix should stay inside that structure.

The stable target is:

- A non-root parenthesized query scope should render as an expanded query block unless it is explicitly treated as an inline query expression.
- `WITH c AS (select a from t) select * from c` should reach the same output after one pass and two passes.
- `FROM (select ...)` and `WITH ... AS (select ...)` should remain expanded.
- `IN (select ...)` should be idempotent and use balanced paren spacing. The first fix may keep it inline if the existing product behavior requires that, but the output must not have one-sided spacing such as `( SELECT id FROM u)`.

The implementation plan should first write tests that document the chosen exact output. If a targeted test reveals that expanded `IN` subqueries are safer than inline rendering, prefer the smaller stable behavior change that aligns with existing scope layout rules.

### Tests

Add targeted regression coverage in existing test files:

- `tests/token-boundary.test.js`
  - direct tokenizer and formatter guards for numeric and typed literal boundaries
  - idempotency for the new literal cases
- `tests/hive-regression.test.js`
  - Hive variable substitution in table names and predicates
  - preservation of `${hivevar:...}` and `${hiveconf:...}` bytes
- `tests/pipeline-idempotency.test.js`
  - compact CTE query scope idempotency
  - `IN (select ...)` idempotency and balanced spacing
- `tests/sql-token-renderer.test.js` only if the chosen query spacing behavior needs snippet-level guards

Run targeted tests after each behavior class, then run the full regression suite.

## Risks

- Numeric literal changes can affect operator spacing around unary plus and minus. Tests must include exponent signs and normal arithmetic expressions to confirm the tokenizer does not over-consume operators.
- Typed literal recognition must not consume ordinary aliases followed by independent strings when there is whitespace between them. Only adjacent prefix-plus-quote forms are in scope.
- Dollar placeholder recognition must not break PostgreSQL dollar-quoted strings. PostgreSQL dollar strings are recognized before Hive substitutions when the configured tokenizer options enable them.
- Query layout changes can alter formatted output for nested subqueries. Tests should target compact CTE, `FROM (select ...)`, and `IN (select ...)` separately so any behavior change is explicit.

## Validation

Minimum local validation:

```bash
node tests/token-boundary.test.js
node tests/hive-regression.test.js
node tests/pipeline-idempotency.test.js
npm run test:verify
git diff --check
```

If implementation unexpectedly changes module structure or packaged runtime files, also run:

```bash
npm run package:vsix
```

Local validation commands do not use proxy.

## Success Criteria

- The confirmed tokenizer inputs no longer produce semantically corrupted output.
- Formatting the targeted compact CTE and `IN` subquery examples twice yields exactly the same text as formatting once.
- Existing protection for comments, strings, block comments, quoted identifiers, PostgreSQL dollar strings, and root `lib/*.js` shims remains intact.
- `npm run test:verify` passes.
