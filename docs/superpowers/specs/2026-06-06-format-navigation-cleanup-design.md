# Format Navigation Cleanup Design

## Goal

Reduce formatter maintenance and lookup overhead by centralizing structured document navigation. The current structured formatter is functionally guarded, but several core files still keep local copies of token and scope lookup helpers. This cleanup should make `FormatDocument` the shared indexed model and make formatter passes consume one navigation API instead of repeating linear scans.

## Current Problem

The structured formatter default path is already clear, but the implementation still has duplicate helper families across large files:

- `token_by_index(document, tokenIndex)`
- `scope_by_id(document, scopeId)`
- `previous_code_token(document, token)`
- `next_code_token(document, token)`
- `active_tokens(document)`

These helpers appear in `sql-structured-renderer.js`, `sql-layout-formatter.js`, `sql-case-formatter.js`, `sql-condition-formatter.js`, `sql-format-nodes.js`, and `sql-scope-model.js`. The duplication increases maintenance cost and keeps repeated O(n) scans in hot formatting paths.

## Proposed Design

### 1. Add FormatDocument indexes

Extend `lib/core/sql-format-document.js` so `from_text()` returns a document with reusable indexes:

- `tokenById`: token id to token record
- `tokenByIndex`: tokenizer index to token record
- `codeTokens`: active code token records in source order
- `codeTokenPositionByIndex`: token index to position in `codeTokens`
- `lineByIndex`: physical line index to line record

These indexes are data only. They must not encode formatter-specific decisions beyond the existing `isCode`, `isComment`, and `isStructural` token classification.

### 2. Add a navigation module

Create `lib/core/sql-format-navigation.js` for `FormatDocument` consumers. It should expose:

- `token_by_id(document, tokenId)`
- `token_by_index(document, tokenIndex)`
- `line_by_index(document, lineIndex)`
- `active_tokens(document)`
- `previous_code_token(document, token)`
- `next_code_token(document, token)`
- `attach_scope_index(document)`
- `scope_by_id(document, scopeId)`

`attach_scope_index(document)` should be called after `document.scopes = sqlScopeModel.build(...)`. This avoids a circular dependency between document construction and scope building.

### 3. Replace duplicate helpers across structured path

Replace local lookup helpers in these modules:

- `lib/core/sql-structured-renderer.js`
- `lib/core/sql-layout-formatter.js`
- `lib/core/sql-case-formatter.js`
- `lib/core/sql-condition-formatter.js`
- `lib/core/sql-format-nodes.js`
- `lib/core/sql-scope-model.js`

The replacement should be behavior-preserving. Formatter passes may keep local semantic helpers, but low-level navigation should route through `sql-format-navigation.js`.

### 4. Keep raw token-array modules separate

Do not force non-`FormatDocument` modules into the document navigation API. Modules such as `sql-clause-splitter.js`, `sql-syntax-risk-detector.js`, and `sql-clause-formatter.js` operate on raw token arrays before a `FormatDocument` exists or outside the structured render path.

For those modules, either leave existing token-array helpers in place for this pass or add a separate minimal token-array navigation helper only if the implementation remains clearly scoped and behavior-neutral.

## Non-Goals

- Do not split `sql-case-formatter.js`, `sql-select-formatter.js`, or `sql-comment-formatter.js` by business responsibility in this pass.
- Do not remove old compatibility exports such as `format_case_blocks`, `align_as_in_select_blocks`, or `order_comment` in this pass.
- Do not change formatting output intentionally.
- Do not move logic into root `lib/*.js` shims.
- Do not add regex-based structural parsing of comments, strings, block comments, or quoted identifiers.

## Validation

Add focused coverage for the new indexed document and navigation helpers:

- token lookup by id and index
- active code token order
- previous / next code token behavior across whitespace and comments
- scope lookup after `attach_scope_index(document)`

Then run:

```bash
node tests/format-document-model.test.js
node tests/format-scope-model.test.js
node tests/format-invariants.test.js
node tests/module-boundary.test.js
node tests/performance-smoke.test.js
npm run test:verify
```

Because this is a behavior-preserving cleanup, any formatter output change must be treated as suspicious unless a test proves the previous output was wrong and the change is explicitly accepted.

## Risks And Mitigations

- **Risk: stale scope indexes after scopes are reassigned.** Mitigate by requiring `attach_scope_index(document)` immediately after scope build and keeping scope indexing out of `from_text()`.
- **Risk: accidentally changing token classification.** Mitigate by making indexes reuse existing token records without rewriting `isCode`, `isComment`, or `isStructural`.
- **Risk: broad refactor hides behavior regressions.** Mitigate by replacing lookup helpers module by module and running targeted tests before full verification.
- **Risk: raw token-array modules get forced into the wrong abstraction.** Mitigate by keeping document navigation and token-array navigation separate.

## Success Criteria

- Structured formatter modules share one `sql-format-navigation.js` API for document token and scope lookup.
- `FormatDocument` exposes stable indexes used by navigation helpers.
- Repeated local document lookup helpers are removed from the structured path modules listed above.
- Existing formatter behavior remains unchanged under `npm run test:verify`.
- Performance smoke remains under the existing 5000ms threshold and does not regress materially from the current baseline.
