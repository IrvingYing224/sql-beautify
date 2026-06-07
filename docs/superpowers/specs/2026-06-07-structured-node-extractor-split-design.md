# Structured Node Extractor Split Design

## Objective

Improve the structured SQL formatter's long-term maintainability and extensibility by splitting `lib/core/sql-format-nodes.js` into focused node extractor modules.

This is a maintainability and architecture cleanup, not a formatter behavior change. The structured pipeline must keep the same public node object shape and the same formatted output:

```text
FormatDocument -> ScopeModel -> FormatNodes -> MutationPlan -> StructuredRenderer
```

The target state is:

- `sql-format-nodes.js` becomes a thin orchestrator for node extraction
- each node family has a focused module with a clear responsibility
- mutation modules continue consuming the same `nodes` object without call-site changes
- node extraction contracts are guarded by tests and module-boundary checks

## Current State

`lib/core/sql-format-nodes.js` currently owns several independent responsibilities in one file:

- list span detection for SELECT and GROUP BY lists
- separator detection and separator owner attribution
- SELECT item extraction
- CASE expression extraction, including branch token ownership and comments
- condition block extraction
- shared token helpers such as word checks and token range filtering

The file is around 659 lines and is now one of the largest core formatter files. This increases the cost of extending structured formatting because new SQL support has to thread through a single multi-purpose extractor.

Downstream consumers currently depend on the returned `nodes` object:

- `nodes.selectItems`
- `nodes.caseExpressions`
- `nodes.conditionBlocks`
- `nodes.separators`
- `nodes.selectSpans`

Those field names, item shapes, ID formats, token references, line references, and ownership fields must remain compatible.

## Design

Keep `lib/core/sql-format-nodes.js` as the public extraction boundary and split the internal implementation into focused modules:

```text
lib/core/sql-format-nodes.js
lib/core/sql-node-utils.js
lib/core/sql-list-nodes.js
lib/core/sql-select-item-nodes.js
lib/core/sql-case-nodes.js
lib/core/sql-condition-nodes.js
```

### `sql-format-nodes.js`

Role: thin orchestrator and compatibility boundary.

Responsibilities:

- ensure `document.scopes` exists
- call focused extractor modules in the required order
- assemble and assign the final `document.nodes`
- keep the existing public exports:
  - `extract`
  - `find_select_items`
  - `find_case_expressions`
  - `find_condition_blocks`
  - `find_separators`

It should not contain the concrete SELECT, CASE, separator, or condition extraction algorithms after the split.

### `sql-node-utils.js`

Role: shared node extraction helpers.

Allowed responsibilities:

- token type and keyword checks
- token range checks
- token range filtering through `sql-format-navigation.active_tokens(document)`
- small helpers shared by multiple extractor modules

Constraints:

- do not duplicate `sql-format-navigation` responsibilities
- do not create global caches
- do not import mutation, renderer, adapter, or experimental DDL modules

### `sql-list-nodes.js`

Role: list span and separator ownership extraction.

Responsibilities:

- create SELECT and GROUP BY list spans
- detect list boundaries
- attribute comma separators to function, IN-list, window, paren-list, SELECT-list, or GROUP BY-list owners
- preserve current separator ID and owner fields

Expected exports:

- `create_list_spans(document, options)`
- `find_separators(document, selectSpans)`

The implementation may keep local helpers for span boundary handling, but the module should not extract SELECT items or apply formatting mutations.

### `sql-select-item-nodes.js`

Role: SELECT and GROUP BY item extraction.

Responsibilities:

- consume list spans and separators
- emit `selectItem:*` nodes with the existing fields
- preserve current behavior for line-split items and nested owner handling

Expected exports:

- `find_select_items(document, selectSpans, separators)`

The module should not detect separators itself except through the passed separator list or the list-node module fallback required for compatibility.

### `sql-case-nodes.js`

Role: CASE expression node extraction.

Responsibilities:

- consume `caseExpr` scopes from `sql-scope-model`
- emit `caseExpr:*` nodes with existing fields
- preserve branch token attribution for WHEN, THEN, ELSE, END, suffix tokens, and nested CASE expressions
- preserve current CASE line comment attribution

Expected exports:

- `find_case_expressions(document)`

The module should not format CASE output or own CASE layout rules.

### `sql-condition-nodes.js`

Role: condition block node extraction.

Responsibilities:

- consume `conditionBlock` scopes
- skip inline nested query condition blocks the same way current code does
- emit condition segments, continuation lines, and close lines with existing fields
- preserve top-level connector handling, BETWEEN handling, nested owner handling, and close-paren handling

Expected exports:

- `find_condition_blocks(document)`

The module should not apply condition indentation or wrapping mutations.

## Data Flow

`extract(document, options)` should keep the current extraction order:

```text
selectSpans = listNodes.create_list_spans(document, options)
separators = listNodes.find_separators(document, selectSpans)
selectItems = selectItemNodes.find_select_items(document, selectSpans, separators)
caseExpressions = caseNodes.find_case_expressions(document)
conditionBlocks = conditionNodes.find_condition_blocks(document)
```

Then it returns and assigns:

```js
{
    selectItems: selectItems,
    caseExpressions: caseExpressions,
    conditionBlocks: conditionBlocks,
    separators: separators,
    selectSpans: selectSpans
}
```

## Compatibility Contract

This split must preserve:

- `require('../lib/core/sql-format-nodes').extract`
- existing named exports used by tests or local tooling
- all node field names and value types
- existing ID prefixes and numbering order:
  - `selectList:*`
  - `groupByList:*`
  - `separator:*`
  - `selectItem:*`
  - `caseExpr:*`
  - `conditionBlock:*`
- formatter output for existing regression and differential corpora
- core dependency direction: no adapter or experimental imports in live formatter core

The split should add module-boundary checks so `sql-format-nodes.js` remains a thin orchestrator and does not regain concrete extractor implementations.

## Non-Goals

Do not change formatter behavior.

Do not split mutation modules in this plan.

Do not change `sql-scope-model.js`, except for strictly necessary import compatibility if implementation reveals a mechanical issue.

Do not modify `lib/adapters/`, `lib/experimental/ddl/`, root `lib/*.js` shims, `README.md`, or publishing workflow files.

Do not pursue wall-clock speedups in this plan. Performance smoke remains a regression guard only.

Do not introduce new SQL grammar support as part of this split.

## Testing Strategy

Before implementation:

- run focused node and invariant checks to establish baseline behavior:
  - `node tests/format-invariants.test.js`
  - `node tests/structured-differential.test.js`
  - `node tests/pipeline-idempotency.test.js`
  - `node tests/module-boundary.test.js`

During implementation:

- move one node family at a time
- after each extraction, run the nearest targeted tests
- compare representative `nodes` snapshots before and after when moving high-risk logic

Final verification:

```bash
node tests/format-invariants.test.js
node tests/structured-differential.test.js
node tests/pipeline-idempotency.test.js
node tests/module-boundary.test.js
npm run test:verify
```

If implementation creates new core files, package content should also be checked:

```bash
ALL_PROXY=socks5://127.0.0.1:7897 npm run package:vsix
```

The VSIX check must verify that the new extractor modules are included and no obsolete formatter facade files are restored.

## Risks And Mitigations

### Risk: node shape changes silently

Mitigation: add targeted node snapshot or shape assertions for SELECT item, separator, CASE expression, and condition block nodes. Keep output differential tests as a second guard.

### Risk: extraction order changes IDs

Mitigation: keep the current extraction order and ID allocation local to each extractor. Do not sort nodes differently.

### Risk: helpers become a new dumping ground

Mitigation: keep `sql-node-utils.js` small and restrict it to token-oriented helpers. Module-boundary tests should prevent moving whole extraction algorithms into the utility module.

### Risk: thin orchestrator grows back

Mitigation: add `tests/module-boundary.test.js` checks for the new module files and forbid concrete helper implementations from reappearing in `sql-format-nodes.js`.

### Risk: mechanical extraction hides behavior changes

Mitigation: move code mechanically first, then run targeted tests before any cleanup. Cleanup is allowed only when tests prove behavior stayed stable.

## Acceptance Criteria

- `sql-format-nodes.js` is a thin orchestrator over focused extractor modules
- focused extractor modules exist and own their specific node families
- `extract(document, options)` returns the same object shape as before
- mutation modules do not need call-site changes
- module-boundary tests enforce the new extractor boundaries
- formatter regression, differential, idempotency, and invariant tests pass
- `npm run test:verify` passes
- generated VSIX includes new core extractor modules if packaging is run
