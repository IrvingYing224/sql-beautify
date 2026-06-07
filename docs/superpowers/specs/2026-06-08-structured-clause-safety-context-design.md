# Structured Clause Safety Context Design

## Objective

Improve production SQL safety and long-term formatter extensibility by centralizing token-aware clause and low-confidence syntax boundary checks.

This is an architecture and stability cleanup. The goal is not to add a full SQL parser or change formatted output intentionally. The target state is that the live formatter makes one shared decision about whether a keyword-shaped token is a real structural clause or an identifier, alias, function name, or expression operand.

The shared decision layer should cover the high-risk constructs already called out by the architecture contract:

- `QUALIFY`
- `PIVOT`
- `UNPIVOT`
- `MERGE`
- `MATCH_RECOGNIZE(...)`

The most important outcome is consistency between:

- clause splitting
- unsupported syntax detection
- structured clause line-break mutations

## Current State

The formatter already has context-aware safety logic, but it is duplicated in multiple live modules:

- `lib/core/sql-clause-splitter.js`
  - owns local token navigation helpers
  - owns local query clause context state
  - owns local `QUALIFY` precondition checks
  - owns local paren matching for opaque `MATCH_RECOGNIZE(...)`
- `lib/core/sql-syntax-risk-detector.js`
  - owns another token navigation helper set
  - owns another query clause context state
  - owns another `QUALIFY` / `PIVOT` / `MERGE` / `MATCH_RECOGNIZE` recognition implementation
- `lib/core/sql-clause-formatter.js`
  - owns another `QUALIFY` clause guard for structured line-break mutations

These implementations are similar but not identical. That makes future dialect support risky because a new construct can be fixed in one path while still being misclassified in another.

Existing tests already guard several important cases:

- `SELECT qualify AS c` must remain a SELECT item, not a `QUALIFY` clause.
- `WHERE qualify = 1` and `WHERE x = qualify(y)` must not trigger unsupported diagnostics.
- real `QUALIFY` clauses must still be detected under the relevant dialect policy.
- `PIVOT` function-shaped expressions must not be rejected as table constructs.
- real `MATCH_RECOGNIZE(...)` content must remain opaque.

The next step should strengthen the shared architecture behind those behaviors.

## Design

Create a focused core module:

```text
lib/core/sql-clause-context.js
```

Role: shared token-aware boundary logic for clause and low-confidence syntax decisions.

The module should operate on raw tokenizer records. It must not require `FormatDocument`, adapters, experimental DDL modules, renderer modules, mutation modules, or root compatibility shims.

Expected exports:

```js
previous_code_token(tokens, index)
next_code_token(tokens, index)
next_code_index(tokens, index)
find_matching_paren(tokens, openIndex)
create_query_context()
update_query_clause_context(context, clauseOrName)
can_precede_qualify_clause(token)
can_follow_qualify_clause(token)
is_real_qualify_clause(tokens, index, context)
is_merge_statement(tokens, index, depth)
is_pivot_construct(tokens, index, context)
match_recognize_range(source, tokens, index)
```

The implementation should keep this export list fixed unless a review checkpoint finds a concrete incompatibility. Any export change must be reflected in module-boundary tests and remain limited to the responsibilities above.

### Token Navigation

`previous_code_token`, `next_code_token`, and `next_code_index` should ignore whitespace, newlines, line comments, and block comments when used by safety detection.

Callers that already work on active code-token arrays can still use the same helpers safely because there will simply be fewer ignorable tokens.

### Query Context

`create_query_context()` should return the shared state used to identify clause position:

```js
{
    inSelect: false,
    seenFrom: false,
    lastClause: ''
}
```

`update_query_clause_context(context, clauseOrName)` should accept either a clause registry entry or a string clause name. It owns the shared interpretation of:

- `SELECT`
- `FROM`
- join variants
- `WHERE`
- `GROUP BY`
- `ORDER BY`
- `HAVING`
- `QUALIFY`
- `LIMIT`
- set operators
- `ON`

This keeps splitter, detector, and structured clause formatter aligned when the clause registry evolves.

### `QUALIFY`

`is_real_qualify_clause(tokens, index, context)` should return true only when all of these are true:

- current token is `QUALIFY`
- query context is inside a `SELECT` and has seen `FROM`
- previous code token can legally precede a condition-like clause
- next code token can begin an expression
- the token is not acting as an alias, SELECT item, function name, or ordinary operand

The function should remain conservative about ambiguous token shapes. A word `qualify` in expression position must not be treated as a real clause.

### `PIVOT` / `UNPIVOT`

`is_pivot_construct(tokens, index, context)` should return true only for table-construct context:

- query context is inside a `SELECT` and has seen `FROM`
- `lastClause` indicates `FROM` or `JOIN`
- previous code token looks like a table/subquery/reference, not a clause keyword or operator
- next code token is `(`

Function-shaped expressions such as `pivot(y)` in `WHERE` must not be treated as unsupported table constructs.

### `MERGE`

`is_merge_statement(tokens, index, depth)` should return true only when:

- depth is 0
- previous code token is absent or a statement terminator
- next code token is `INTO`

This avoids treating SELECT-list aliases or expression identifiers named `merge` as unmodeled statements.

### `MATCH_RECOGNIZE(...)`

`match_recognize_range(source, tokens, index)` should support both token forms:

- `MATCH_RECOGNIZE`
- `MATCH RECOGNIZE`

It should return a range object with enough information for callers to preserve or report the original text:

```js
{
    startIndex: index,
    endIndex: closeParenIndex,
    start: tokens[index].start,
    end: tokens[closeParenIndex].end,
    text: source.slice(start, end)
}
```

When the parenthesized body is malformed, it should still return a small diagnostic snippet range instead of crashing. The splitter and risk detector must keep their existing behavior of preserving well-formed `MATCH_RECOGNIZE(...)` content.

## Migration Plan Scope

Migrate these modules to consume `sql-clause-context.js`:

- `lib/core/sql-clause-splitter.js`
- `lib/core/sql-syntax-risk-detector.js`
- `lib/core/sql-clause-formatter.js`

The migration should remove duplicated local helper implementations where they overlap with the new module:

- raw token previous/next code helpers
- paren matching used for opaque syntax
- query clause context state updates
- `QUALIFY` precondition checks
- `PIVOT` / `UNPIVOT` table construct checks
- `MERGE INTO` statement-start checks
- `MATCH_RECOGNIZE` range detection

Do not migrate these in this plan:

- `lib/core/sql-layout-formatter.js`
  - its close-paren boundary check is layout-specific and should stay local for now
- `lib/core/sql-group-by-extension.js`
  - `WITH CUBE` / `WITH ROLLUP` / `WITH GROUPING SETS` is a GROUP BY extension special case
- structured node, mutation, renderer, adapter, experimental DDL, root shim, README, and release workflow modules

## Data Flow

### Clause Splitter

Before:

```text
tokenize protected text
local query context
local QUALIFY guard
local opaque MATCH_RECOGNIZE paren scan
emit split text
```

After:

```text
tokenize protected text
sql-clause-context provides query context and structural guards
splitter emits split text only
```

### Syntax Risk Detector

Before:

```text
tokenize source
local query context
local construct-specific checks
emit unsupported segments
```

After:

```text
tokenize source
sql-clause-context provides query context and construct checks
detector maps recognized constructs to unsupported segment records
```

### Clause Formatter

Before:

```text
active FormatDocument tokens
local query context before token
local QUALIFY guard
add line-break mutations
```

After:

```text
active FormatDocument tokens
clause formatter computes document-scope-specific query context
sql-clause-context validates whether QUALIFY is a real clause
add line-break mutations
```

`sql-clause-context.js` should not know about `FormatDocument` scopes. `sql-clause-formatter.js` can keep the document-specific scan that filters tokens to the owning query scope, but it should use the shared query context shape and `QUALIFY` guard.

## Compatibility Contract

This design must preserve:

- existing formatter output for the current regression corpus
- existing public package behavior
- `unsupportedSyntaxPolicy` semantics:
  - `preserve` continues formatting around protected syntax
  - `warn` emits diagnostics for detected low-confidence syntax
  - `bail_out` rejects detected low-confidence syntax
- byte-for-byte preservation of opaque `MATCH_RECOGNIZE(...)` bodies
- safe treatment of keyword-shaped identifiers, aliases, operands, and function names
- core dependency direction
- root `lib/*.js` shim behavior

The new module is internal core infrastructure. It should not be exported through root compatibility shims.

## Non-Goals

Do not implement a complete SQL parser.

Do not add broad new dialect support.

Do not intentionally change formatting layout.

Do not change VS Code configuration, command registration, adapter behavior, packaging metadata, README, or release workflow.

Do not modify experimental DDL behavior.

Do not pursue wall-clock performance improvements. Performance smoke remains a regression guard only.

## Testing Strategy

Add focused tests before the migration where practical.

### New Context Unit Coverage

Create or extend a targeted test around `sql-clause-context.js`:

- `QUALIFY` after `FROM` with an expression is real
- `qualify` in SELECT-list alias position is not real
- `qualify` in WHERE operand position is not real
- `qualify(y)` in expression function position is not real
- `PIVOT(...)` after a table reference is a table construct
- `pivot(y)` in WHERE expression position is not a table construct
- `UNPIVOT(...)` follows the same table-construct rules
- `MERGE INTO` at statement start is a merge statement
- `merge` as SELECT item or alias is not a merge statement
- `MATCH_RECOGNIZE(...)` and `MATCH RECOGNIZE(...)` return stable ranges

### Existing Behavior Guards

Extend `tests/unsupported-safety.test.js` and/or `tests/dialect-boundary.test.js` with production-shaped fixtures:

- CTE containing a SELECT-list alias named `qualify`
- nested subquery with a real `QUALIFY` clause
- query containing both a `pivot` function call and a real `PIVOT(...)` table construct
- `MERGE` used as an identifier in SELECT/WHERE plus real `MERGE INTO`
- `MATCH RECOGNIZE(...)` spaced form remains opaque

### Module Boundary Guards

Extend `tests/module-boundary.test.js`:

- `sql-clause-context.js` exists and exports only the expected helper surface
- `sql-clause-splitter.js`, `sql-syntax-risk-detector.js`, and `sql-clause-formatter.js` import the shared context module
- duplicated local implementations of the migrated helpers do not reappear in those modules
- the live formatter graph still avoids adapter and experimental dependencies

### Verification Commands

Minimum targeted checks:

```bash
node tests/unsupported-safety.test.js
node tests/dialect-boundary.test.js
node tests/module-boundary.test.js
node tests/clause-registry.test.js
node tests/structured-differential.test.js
node tests/pipeline-idempotency.test.js
```

Final verification:

```bash
npm run test:verify
```

Packaging is not required unless implementation changes VSIX packaging, extension metadata, or package contents in a way that needs artifact inspection.

## Risks And Mitigations

Risk: clause splitting or structured clause mutations start treating identifiers as clauses.

Mitigation: add red tests for identifier, alias, operand, and function-name forms before moving logic.

Risk: `warn` / `bail_out` diagnostics diverge from splitter behavior.

Mitigation: both paths must use `sql-clause-context.js` for construct recognition, and tests should cover `preserve`, `warn`, and `bail_out` for representative syntax.

Risk: document-scope-aware logic in `sql-clause-formatter.js` does not map perfectly to raw token helpers.

Mitigation: keep document-specific scope filtering inside `sql-clause-formatter.js`; only share context state and token-level clause validity checks.

Risk: `MATCH_RECOGNIZE` malformed input changes behavior unexpectedly.

Mitigation: preserve current behavior for well-formed input and use a small diagnostic snippet for malformed ranges instead of broad rewrites.

## Acceptance Criteria

- `lib/core/sql-clause-context.js` centralizes shared clause/risk context decisions.
- `sql-clause-splitter.js`, `sql-syntax-risk-detector.js`, and `sql-clause-formatter.js` no longer carry their own duplicated `QUALIFY` boundary logic.
- Existing formatter output is preserved for the regression suite.
- Low-confidence syntax detection remains context-aware and does not reject keyword-shaped identifiers.
- Real unsupported constructs continue to trigger `warn` and `bail_out`.
- Module-boundary tests prevent reintroducing the duplicated helper implementations.
- `npm run test:verify` passes.
