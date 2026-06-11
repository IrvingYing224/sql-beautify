# Layout Policy Boundary Cleanup Design

## Objective

Consolidate structured list layout facts behind a small internal policy layer so future layout features can be added without spreading clause-specific spacing knowledge across CASE, SELECT, and renderer modules.

This is a behavior-preserving architecture cleanup. It should not add public settings or intentionally change formatted SQL output.

## Confirmed Current State

The current `main` branch already includes the `v1.0.8` list and CASE work:

- `lib/core/sql-list-nodes.js` extracts `selectList`, `groupByList`, and top-level `orderByList` spans.
- `lib/core/sql-list-mutations.js` applies generic leading-comma list layout for SELECT, GROUP BY, and top-level ORDER BY.
- `lib/core/sql-select-mutations.js` delegates generic list layout, but still consumes list indentation helpers for SELECT-specific width, alias, hint, comment, and function item behavior.
- `lib/core/sql-case-mutations.js` still hard-codes list-kind indentation facts for CASE expressions inside SELECT, GROUP BY, and ORDER BY list items.
- `lib/core/sql-token-renderer.js` is already a thin facade over `sql-render-token-spacing.js` and should stay that way.

The main design pressure is not feature capability. It is ownership drift: list layout facts are partly generic, partly mutation-specific, and partly duplicated by CASE logic.

## Scope

In scope:

- Introduce a pure list layout policy boundary for list prefixes, continuation widths, base indentation, first-item indentation, continuation indentation, and CASE-in-list indentation.
- Make `sql-list-mutations.js`, `sql-select-mutations.js`, and `sql-case-mutations.js` consume that policy instead of each owning list spacing details.
- Keep structured renderer and token spacing responsibilities unchanged.
- Add boundary and regression tests that protect the new ownership split and verify output stability.
- Update maintainer technical documentation if a new core module is added.

Out of scope:

- No new user-facing formatter setting.
- No CASE nesting-level layout switch.
- No ORDER BY / GROUP BY layout configuration.
- No broad split of `sql-case-mutations.js`.
- No intentional output changes to window ORDER BY, function argument commas, `IN (...)`, SELECT leading comma, `AS` alignment, compact CASE, or trailing field comments.

## Proposed Architecture

Add a focused pure module:

```text
lib/core/sql-list-layout-policy.js
```

Its responsibility is to answer layout facts for structured list items. It should not create mutations, inspect adapter configuration, render token strings, or modify output.

Public surface:

```js
exports.first_item_prefix
exports.continuation_width
exports.list_base_indent
exports.structured_list_indent
exports.item_indent
exports.case_item_indent
exports.is_first_item_in_owner
```

The implementation plan should use this export surface unless implementation evidence shows one helper is unnecessary. New helpers should not be added to this module without a specific consumer and a boundary test.

### Ownership After Cleanup

- `sql-list-layout-policy.js`: list layout facts and item indentation policy.
- `sql-list-mutations.js`: generic list mutation pass only. It uses policy helpers and should export only `apply_list_layout_mutations`.
- `sql-select-mutations.js`: SELECT-specific behavior such as `AS` alignment, SELECT hints, header comments, multiline function items, GROUP BY extensions, and trailing-comment coordination. It reads list indentation through the policy module, not through the mutation pass.
- `sql-case-mutations.js`: CASE layout strategy and CASE branch mutations. It reads CASE-in-list indentation through the policy module and should not hard-code `selectList`, `groupByList`, or `orderByList` spacing widths.
- `sql-render-token-spacing.js`: token adjacency spacing policy.
- `sql-token-renderer.js`: thin mutation-facing render facade only.

## Detailed Behavior Contract

The cleanup must preserve the current output for:

- SELECT leading-comma layout.
- GROUP BY leading-comma layout.
- Top-level ORDER BY leading-comma layout.
- Window ORDER BY inline spacing, including the existing double-space contract after `ORDER BY`.
- Function argument comma spacing.
- `IN (...)` comma spacing.
- SELECT `AS` alignment.
- SELECT hint and SELECT header comment handling.
- Field trailing comment alignment.
- CASE `expanded` layout.
- CASE `compactShort` eligibility and output.
- Hive GROUP BY extensions such as `WITH CUBE`, `WITH ROLLUP`, and `WITH GROUPING SETS`.

If an implementation changes output, treat it as a regression unless a separate design explicitly approves the behavior change.

## Data Flow

The structured pipeline remains the same:

1. Tokenizer and shielded document creation build `FormatDocument`.
2. Scope model and node extractors produce list spans, list items, CASE nodes, condition blocks, and separators.
3. Mutation passes ask the list layout policy for indentation facts.
4. Mutation passes write declarative mutations to `MutationPlan`.
5. `sql-structured-renderer.js` applies mutations and delegates token adjacency decisions to `sql-render-token-spacing.js`.

No structural pass should re-derive list layout from restored SQL text.

## Error Handling

This cleanup should not add user-visible errors or diagnostics.

If a list item cannot be matched to a span, policy helpers should fall back to the same conservative indentation behavior currently used by the calling module. The implementation should prefer preserving output over throwing from policy helpers.

## Testing Strategy

Add or update tests in these areas:

- `tests/module-boundary.test.js`
  - new policy module exists
  - policy module has a narrow export surface
  - `sql-list-mutations.js`, `sql-select-mutations.js`, and `sql-case-mutations.js` consume the policy module
  - `sql-list-mutations.js` exports only `apply_list_layout_mutations`
  - `sql-token-renderer.js` remains a thin facade
- `tests/format-invariants.test.js`
  - policy indentation facts are stable for SELECT, GROUP BY, and top-level ORDER BY
  - window ORDER BY remains excluded from `orderByList`
- Existing regression tests
  - SELECT alignment
  - CASE layout
  - comment alignment
  - window function spacing
  - token spacing policy
  - pipeline idempotency

Minimum verification for implementation:

```bash
node tests/module-boundary.test.js
node tests/format-invariants.test.js
node tests/select-alignment.test.js
node tests/case-when.test.js
node tests/comment-alignment.test.js
node tests/window-function-spacing.test.js
node tests/token-spacing-policy.test.js
node tests/pipeline-idempotency.test.js
npm run test:verify
npm run package:vsix
git diff --check
```

Local verification commands should run without proxy. Do not commit `.vsix` artifacts.

## Review Checkpoints

Implementation should proceed in small checkpoints:

1. Add the policy module and boundary tests, with no behavior changes.
2. Move `sql-list-mutations.js` helper ownership to the policy module.
3. Migrate `sql-select-mutations.js` to consume policy helpers.
4. Migrate `sql-case-mutations.js` to consume CASE-in-list indentation policy.
5. Run full regression and inspect diff for accidental behavior changes.

Each checkpoint should be independently reviewable and should keep the formatter runnable.

## Success Criteria

The work is successful when:

- list layout facts have one clear policy owner
- CASE and SELECT modules no longer duplicate list indentation widths
- token renderer remains a thin facade
- all existing formatter behavior is preserved
- boundary tests make future drift harder
- local verification passes
