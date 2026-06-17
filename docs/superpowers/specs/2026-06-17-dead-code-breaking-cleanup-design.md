# Dead Code Breaking Cleanup Design

## Objective

Remove obsolete formatter compatibility burden that now reduces maintainability more than it protects users.

This is an intentional breaking cleanup. The old `sql-clause-splitter` module name no longer describes live behavior, and keeping it as a compatibility path encourages future work to depend on a dead clause-splitting pipeline. The cleanup should make the live architecture more honest: opaque unsupported syntax protection remains, legacy clause splitting disappears.

## Context

The current formatter path imports `lib/core/sql-clause-splitter.js` only for:

- `protect_opaque_segments()`
- `restore_opaque_segments()`

The same file still exports `split_clauses()`, but repository search shows no live caller in `lib/`, `tests/`, `extension.js`, or `vkbeautify.js`. The dead function carries its own clause registry matching, query-parenthesis metadata, spacing helpers, unary operator handling, and source-newline-sensitive subquery layout logic. Those responsibilities now belong to the structured formatter, scope model, layout formatter, renderer, and shared clause context.

`lib/core/sql-shield.js` also contains an obsolete restore fallback that fabricates `SQLSHIELDX{i}X` placeholders. `protect()` now creates nonce placeholders like `{SQLBEAUTIFYSHIELD0MARK_0}` and records exact `items`; the fallback cannot restore placeholders produced by the current protector.

The working tree currently has a user-owned untracked report at `docs/technical/engineering-review-2026-06-16.md`. This cleanup must not stage, modify, delete, or depend on that file.

## Scope

In scope:

- Rename the live opaque protection responsibility from `sql-clause-splitter` to `lib/core/sql-opaque-protector.js`.
- Move only the active opaque protection behavior:
  - tokenizer-based `MATCH_RECOGNIZE(...)` range detection through `sql-clause-context`
  - unsupported segment recording through `sql-unsupported-policy`
  - context-backed opaque storage and restore
- Update `lib/core/sql-formatter.js` to depend on the new opaque protector module.
- Delete `lib/core/sql-clause-splitter.js`.
- Delete the root compatibility shim `lib/sql-clause-splitter.js`.
- Update architecture and boundary tests so the deleted module name is not treated as a required live component.
- Remove the dead `SQLSHIELDX{i}X` fallback branch in `lib/core/sql-shield.js`.
- Add or adjust focused tests proving the new boundary and restore behavior.

Out of scope:

- Changing formatter output for normal SQL, Hive SQL, or `MATCH_RECOGNIZE(...)`.
- Reworking unsupported syntax policy semantics.
- Changing adapters, VS Code command IDs, package/release metadata, README, DDL modules, `.vsix` artifacts, or root shims unrelated to the deleted splitter.
- Keeping any compatibility wrapper for `lib/sql-clause-splitter.js` or `lib/core/sql-clause-splitter.js`.
- Reviving old clause splitting, source-newline-driven subquery layout, marker cleanup, or legacy string pipeline behavior.

## Design

### Opaque Protector Module

Create `lib/core/sql-opaque-protector.js` as the single owner for opaque unsupported SQL segment protection.

Its public surface should be narrow:

- `protect_opaque_segments(text, dialect, context, options)`
- `restore_opaque_segments(text, context)`

The implementation should preserve the current behavior of complete `MATCH_RECOGNIZE(...)` ranges:

- tokenize input
- detect `MATCH_RECOGNIZE` ranges with `sql-clause-context.match_recognize_range`
- record unsupported metadata unless `options.recordUnsupported === false`
- replace complete ranges through `context.store('opaque_clause', range.text)`
- leave incomplete ranges in place while recording a detector-style unsupported segment when recording is enabled
- restore through `context.restore('opaque_clause', text)`

Do not copy any dead `split_clauses()` helper into the new file. If a helper only served the old splitter, it should be deleted with the old module.

### Formatter Integration

Update `lib/core/sql-formatter.js` to require the new opaque protector:

```js
var sqlOpaqueProtector = require('./sql-opaque-protector');
```

The structured formatter's protect and restore phases should call the new module. No adapter or root shim should import the new module directly unless an existing test already requires that public surface.

### Legacy Module Removal

Delete both old module paths:

- `lib/core/sql-clause-splitter.js`
- `lib/sql-clause-splitter.js`

This is intentional. External consumers that require those private/legacy paths will fail fast instead of silently depending on an obsolete name.

The module-boundary tests should assert the opposite of the current legacy assumption:

- `lib/core/sql-opaque-protector.js` exists and imports `./sql-clause-context`
- `lib/core/sql-clause-splitter.js` does not exist
- `lib/sql-clause-splitter.js` does not exist
- live formatter source graph does not contain `split_clauses`

### Shield Fallback Cleanup

In `lib/core/sql-shield.js`, remove the branch that synthesizes `SQLSHIELDX{i}X` placeholders when no `items` are present.

`restore(text, protected_tokens, items)` should restore from:

- explicit `items`
- `protected_tokens.items`

If neither exists, it should return the input unchanged. That is equivalent to the current effective behavior for current placeholders and avoids implying support for an impossible legacy placeholder format.

### Documentation Updates

Update `docs/technical/sql-formatter-architecture.md` so it no longer describes `sql-clause-splitter.js` as a live core owner. The architecture should name `sql-opaque-protector.js` as the owner for opaque unsupported segment protection.

Do not update `README.md`; this is maintainer-facing architecture cleanup, not an end-user feature.

## Risks

- Removing `lib/sql-clause-splitter.js` is a breaking change for consumers requiring private package paths. This is accepted because long-term maintainability and honest module boundaries are the priority.
- `MATCH_RECOGNIZE(...)` protection could regress if the new module omits unsupported metadata fields or incomplete-range behavior. Focused unsupported tests must cover this.
- Boundary tests may still encode assumptions from the old structured clause safety work. They should be updated to protect the new owner, not weakened.
- Removing the shield fallback could expose tests or ad hoc callers that pass only a raw protected-token array. That is acceptable if those callers are not using the current `protect()` contract, but tests should make the current contract explicit.

## Tests

Targeted validation:

- `node tests/module-boundary.test.js`
- `node tests/unsupported-safety.test.js`
- `node tests/diagnostics-explainability.test.js`
- `node tests/safe-diagnostic-report.test.js`
- `node tests/pipeline-idempotency.test.js`
- `node tests/token-boundary.test.js`

Add or update tests to confirm:

- the new opaque protector module exports only the intended functions
- old `sql-clause-splitter` files are absent
- the live formatter dependency graph uses `sql-opaque-protector`
- `MATCH_RECOGNIZE(...)` remains protected under preserve/warn/bail-out expectations
- `sqlShield.restore(shielded.text, shielded.tokens)` still restores current protected output
- a placeholder-shaped user token such as `SQLSHIELDX0X` remains ordinary SQL text and is not treated as a shield placeholder

Full validation:

```bash
npm run test:verify
npm run package:vsix
git diff --check
```

Local validation commands do not use proxy.

## Success Criteria

- No live source file imports `sql-clause-splitter`.
- `lib/core/sql-clause-splitter.js` and `lib/sql-clause-splitter.js` are gone.
- Opaque `MATCH_RECOGNIZE(...)` protection and unsupported diagnostics behavior remain unchanged.
- `sql-shield` no longer advertises an impossible restore fallback.
- Architecture documentation and module-boundary tests describe the new module boundary.
- `npm run test:verify` passes.
- `npm run package:vsix` passes because deleting root/core modules changes packaged runtime contents.
