# Structured Renderer Split Design

## Goal

Reduce the maintenance cost of the structured renderer by splitting its internal responsibilities into focused core modules while preserving the existing formatter behavior and public rendering boundary.

The structured pipeline should still call one public renderer entry point:

```js
sqlStructuredRenderer.render(document, nodes, mutations, options)
```

Internally, the renderer should no longer keep mutation move-state construction, scope indentation derivation, token spacing rules, line assembly, comment alignment, and final whitespace normalization in one large file.

## Current Problem

`lib/core/sql-structured-renderer.js` is the single rendering boundary for the structured pipeline, but the file currently mixes several distinct responsibilities:

- mutation-derived render state for moved separators, omitted tokens, and moved comments
- effective scope and line indentation derivation
- SQL token spacing predicates and token append rules
- single-line rendering from token records
- line-level transforms such as prefixes, joins, and comment alignment
- final output whitespace normalization

This is behaviorally guarded by the existing regression suite, but it is hard to modify safely because unrelated render decisions are colocated. A small spacing fix requires reading indentation, moved comment, and final output code in the same file.

## Proposed Design

### 1. Keep `sql-structured-renderer.js` as the public orchestrator

Keep `lib/core/sql-structured-renderer.js` as the only module consumed by `lib/core/sql-formatter.js`. It should continue to export `render()` and preserve the structured pipeline contract documented in `docs/technical/sql-formatter-architecture.md`.

After the split, this file should primarily:

- create or accept a mutation plan
- build render-time move state
- build close/body indent lookups
- iterate physical document lines
- apply line rendering and line-level transforms in the existing order
- return normalized output

It should not contain SQL token spacing predicates or low-level scope indentation math after the split.

### 2. Add `sql-render-move-state.js`

Create `lib/core/sql-render-move-state.js` for render-time mutation state.

Expected responsibility:

- build the separator lookup from `nodes.separators`
- convert separator moves into `removedTokenIds` and `prefixesByLine`
- convert token omissions into `removedTokenIds`
- convert line comment moves into `movedCommentsByLine` and `movedCommentSourceLines`

Expected public API:

```js
exports.build_move_state = build_move_state;
```

This module depends on mutation records and format nodes only. It should not render text or apply indentation.

### 3. Add `sql-render-indent.js`

Create `lib/core/sql-render-indent.js` for indentation derivation and indentation transforms.

Expected responsibility:

- compute line prefix indentation from move state
- compute effective token indentation after line-break mutations
- compute effective scope start/body/close indentation
- build `closeIndentByLine`
- build `bodyIndentByLine`
- apply scope close indent to close-paren lines
- apply scope body indent to body lines
- apply explicit line indent mutations
- apply moved separator line prefixes

Expected public API:

```js
exports.build_close_indent_by_line = build_close_indent_by_line;
exports.build_body_indent_by_line = build_body_indent_by_line;
exports.apply_scope_close_indent = apply_scope_close_indent;
exports.apply_scope_body_indent = apply_scope_body_indent;
exports.apply_indent = apply_indent;
exports.apply_line_prefix = apply_line_prefix;
```

This module may depend on `sql-format-mutations` and `sql-format-navigation`. It should not know token spacing rules.

### 4. Add `sql-render-token-spacing.js`

Create `lib/core/sql-render-token-spacing.js` for visible token rendering and spacing.

Expected responsibility:

- derive rendered token values from token replacement mutations
- handle operator spacing using `sql-operator-registry`
- preserve special spacing contracts for:
  - inline query openings
  - `SELECT  *` spacing
  - window `ORDER BY`
  - `GROUP BY`
  - `GROUPING SETS`
  - compact CASE function-plus expressions
  - Hive `LATERAL VIEW ... AS a, b`
  - comma gaps in IN-lists, condition blocks, and CASE function values
- expose the token append operation used by line rendering

Expected public API:

```js
exports.token_value = token_value;
exports.append_visible_token = append_visible_token;
```

Private predicates can stay private in this module unless tests or other render modules need them. This keeps the noisy SQL spacing rules out of the renderer orchestrator.

### 5. Add `sql-render-line.js`

Create `lib/core/sql-render-line.js` for line assembly and output-level line transforms.

Expected responsibility:

- render one physical line from document tokens
- skip omitted or moved tokens
- apply token line-break and spacing-before mutations
- remove moved trailing comments from their original line
- append moved comments to their target line
- apply comment alignment
- append joined lines
- normalize final output whitespace

Expected public API:

```js
exports.render_line_from_tokens = render_line_from_tokens;
exports.apply_comment_alignment = apply_comment_alignment;
exports.append_joined_line = append_joined_line;
exports.normalize_output_whitespace = normalize_output_whitespace;
```

This module may depend on `sql-format-mutations`, `sql-line-model`, and `sql-render-token-spacing`. It should not build move state or scope indentation lookups.

## Data Flow

The render flow should remain deterministic and equivalent to the current implementation:

```mermaid
flowchart LR
    A["document + nodes + mutations"] --> B["build_move_state"]
    B --> C["build indent lookups"]
    C --> D["render each physical line"]
    D --> E["apply body/close/explicit indent"]
    E --> F["apply prefixes/comment alignment/line joins"]
    F --> G["normalize output whitespace"]
```

The order of line transforms must remain unchanged unless a regression test explicitly justifies a behavior change.

## Non-Goals

- Do not intentionally change SQL formatting output.
- Do not split `sql-case-formatter.js`, `sql-select-formatter.js`, or `sql-comment-formatter.js` in this pass.
- Do not remove legacy compatibility exports.
- Do not add new root `lib/*.js` shims.
- Do not move render logic into adapters or experimental DDL modules.
- Do not add global regex parsing over comments, strings, block comments, or quoted identifiers.

## Validation

Because this is a behavior-preserving refactor, validation should focus on equivalence and boundary safety.

Run targeted checks while implementing:

```bash
node tests/module-boundary.test.js
node tests/structured-pipeline-regression.test.js
node tests/pipeline-idempotency.test.js
node tests/window-function-spacing.test.js
```

Then run the full regression command:

```bash
npm run test:verify
```

If any formatter output changes, treat it as a regression unless the implementation plan explicitly adds a failing fixture first and the changed output is accepted as a behavior fix.

## Risks And Mitigations

- **Risk: transform-order regression.** Mitigate by keeping `render()` orchestration order nearly identical and moving helper bodies before changing call order.
- **Risk: spacing predicates become accidental public API.** Mitigate by exporting only `token_value` and `append_visible_token` from the spacing module unless another renderer module genuinely needs more.
- **Risk: circular dependencies between render modules.** Mitigate with one-way dependencies: orchestrator imports helpers; line rendering imports spacing; indent and move-state do not import line rendering.
- **Risk: module-boundary tests miss new files.** Mitigate by extending source-boundary checks to include the new `sql-render-*.js` modules where relevant.
- **Risk: split hides unrelated cleanup.** Mitigate by keeping the implementation mechanical and deferring legacy export isolation or large formatter-file splits to separate passes.

## Success Criteria

- `sql-structured-renderer.js` remains the sole public structured renderer consumed by `sql-formatter.js`.
- Renderer helper responsibilities are split into focused `lib/core/sql-render-*.js` modules.
- No root shim, adapter, or experimental DDL boundary is changed.
- Existing formatter output remains unchanged under `npm run test:verify`.
- The renderer orchestration file becomes small enough to audit quickly, with token spacing and indentation logic isolated behind clear internal APIs.
