# Structured Select Mutations Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the structured SELECT mutation implementation into `lib/core/sql-select-mutations.js` while keeping `lib/core/sql-select-formatter.js` as the compatibility facade with unchanged public exports and unchanged formatter output.

**Architecture:** `sql-select-formatter.js` remains the module imported by the default formatter and by compatibility tests. It delegates `apply_select_list_mutations()` to a new focused `sql-select-mutations.js` module; legacy string-level SELECT list splitting, `AS` alignment, trailing-comma repair, and same-line separator compatibility functions stay in `sql-select-formatter.js`.

**Tech Stack:** CommonJS JavaScript, Node.js assertion-based tests, existing SQL formatter structured pipeline and regression suite.

---

## File Structure

- Create: `lib/core/sql-select-mutations.js`
  - Owns the structured SELECT mutation pass and its private helpers.
  - Exports only `apply_select_list_mutations`.
- Modify: `lib/core/sql-select-formatter.js`
  - Adds a `sql-select-mutations` import.
  - Keeps string-level compatibility helpers and existing public exports.
  - Delegates `apply_select_list_mutations` to the new module.
- Modify: `tests/module-boundary.test.js`
  - Requires the new module.
  - Checks the new module exists.
  - Extends navigation-helper boundary checks to cover `sql-select-mutations.js`.
  - Verifies the facade delegates the structured mutation export.

Do not modify root `lib/*.js` shims. Do not modify `lib/adapters/`. Do not modify `lib/experimental/ddl/`. Do not change formatter behavior intentionally.

---

### Task 1: Establish Baseline

**Files:**
- Read: `docs/superpowers/specs/2026-06-07-structured-select-mutations-split-design.md`
- Read: `docs/technical/sql-formatter-architecture.md`
- Read: `lib/core/sql-select-formatter.js`

- [ ] **Step 1: Confirm the worktree is clean**

Run:

```bash
git status --short
```

Expected: no output. If there are unrelated changes, inspect them first and do not revert user work.

- [ ] **Step 2: Run SELECT-focused baseline tests**

Run:

```bash
node tests/select-alignment.test.js
node tests/structured-pipeline-regression.test.js
node tests/window-function-spacing.test.js
node tests/hive-regression.test.js
node tests/module-boundary.test.js
```

Expected: all commands pass before edits. If any baseline test fails, stop and investigate the baseline failure first.

- [ ] **Step 3: Record the current structured SELECT function map**

Run:

```bash
rg -n "^function |^\\tfunction |^exports\\.|^var " lib/core/sql-select-formatter.js
```

Expected: output includes these structured-path functions before the split:

```text
find_separator_node
is_structured_list_separator
find_select_span
case_scope_for_item
case_node_for_item
tokens_between_same_line
token_inside_scope_kind
follows_window_order_by
token_scope_by_open_index
token_scope_by_close_index
render_node_tokens_with_options
render_node_tokens
structured_list_indent
item_indent
token_inside_nested_scope
find_as_token
effective_line_indent
effective_token_line_indent
rendered_item_width_before_as
max_rendered_item_width_before_as
rendered_item_width_without_as
existing_case_alias_target_width
apply_select_as_alignment_mutations
has_select_hint_line
has_select_header_comment_line
apply_between_item_comment_indents
token_inside_item
top_level_function_scope_for_item
first_word_after_scope_close
function_item_alias_spacing
apply_multiline_function_item_mutations
line_starts_with_leading_separator
select_span_by_id
is_first_item_in_owner
should_join_select_header_first_item
active_code_tokens
nearest_group_by_span_before_token
line_has_code_before_token_except
apply_group_by_extension_mutations
apply_select_list_mutations
```

Also note that `scope_by_id(document, scopeId)` is currently unused and should not be moved to the new module.

---

### Task 2: Add Boundary Tests For The New Module

**Files:**
- Modify: `tests/module-boundary.test.js`

- [ ] **Step 1: Add a require for the new module**

At the top of `tests/module-boundary.test.js`, after the existing formatter requires, add:

```js
var sqlSelectMutations = require('../lib/core/sql-select-mutations');
```

- [ ] **Step 2: Assert the new public API**

After the existing assertion:

```js
assert.strictEqual(typeof sqlSelectFormatter.align_as_in_select_blocks, 'function', 'select formatter must export align_as_in_select_blocks');
```

add:

```js
assert.strictEqual(typeof sqlSelectMutations.apply_select_list_mutations, 'function', 'structured select mutations must export apply_select_list_mutations');
```

- [ ] **Step 3: Assert the new file exists**

After the renderer split module existence check, add:

```js
assert.ok(
	fs.existsSync(path.join(__dirname, '..', 'lib/core/sql-select-mutations.js')),
	'structured SELECT mutation module must exist'
);
```

- [ ] **Step 4: Extend navigation-helper boundary checks**

Add `lib/core/sql-select-mutations.js` to the array that currently checks for local definitions of:

```text
token_by_index
previous_code_token
next_code_token
active_tokens
```

The resulting array should include:

```js
[
	'lib/core/sql-structured-renderer.js',
	'lib/core/sql-render-indent.js',
	'lib/core/sql-render-token-spacing.js',
	'lib/core/sql-select-mutations.js',
	'lib/core/sql-layout-formatter.js',
	'lib/core/sql-case-formatter.js',
	'lib/core/sql-condition-formatter.js',
	'lib/core/sql-format-nodes.js'
].forEach(function(relativePath) {
```

Also add `lib/core/sql-select-mutations.js` to the array that checks for local `scope_by_id(document, ...)` helpers:

```js
[
	'lib/core/sql-structured-renderer.js',
	'lib/core/sql-render-indent.js',
	'lib/core/sql-render-token-spacing.js',
	'lib/core/sql-select-mutations.js',
	'lib/core/sql-case-formatter.js',
	'lib/core/sql-condition-formatter.js',
	'lib/core/sql-format-nodes.js'
].forEach(function(relativePath) {
```

- [ ] **Step 5: Add a facade delegation assertion**

Near the existing structured path assertions, after `var formatterSource = ...` is available, add:

```js
var selectFormatterFacadeSource = read_source('lib/core/sql-select-formatter.js');
assert.ok(
	selectFormatterFacadeSource.indexOf("require('./sql-select-mutations')") >= 0,
	'sql-select-formatter facade must require structured select mutations'
);
assert.ok(
	/sqlSelectMutations\.apply_select_list_mutations\s*\(/.test(selectFormatterFacadeSource),
	'sql-select-formatter facade must delegate apply_select_list_mutations to sql-select-mutations'
);
```

- [ ] **Step 6: Run the boundary test and confirm it fails before implementation**

Run:

```bash
node tests/module-boundary.test.js
```

Expected: FAIL because `../lib/core/sql-select-mutations` does not exist yet, or because the facade does not delegate yet. Do not commit this failing state.

---

### Task 3: Extract Structured SELECT Mutations

**Files:**
- Create: `lib/core/sql-select-mutations.js`
- Modify: `lib/core/sql-select-formatter.js`
- Modify: `tests/module-boundary.test.js`

- [ ] **Step 1: Create `sql-select-mutations.js` imports**

Create `lib/core/sql-select-mutations.js` with:

```js
var sqlFormatUtils = require('./sql-format-utils');
var sqlFormatMutations = require('./sql-format-mutations');
var sqlFormatNavigation = require('./sql-format-navigation');
var sqlScopeModel = require('./sql-scope-model');
var sqlKeywords = require('./sql-keywords');
var sqlGroupByExtension = require('./sql-group-by-extension');
var repeat_space = sqlFormatUtils.repeat_space;
```

- [ ] **Step 2: Move structured helper functions into the new module**

Move these functions from `lib/core/sql-select-formatter.js` into `lib/core/sql-select-mutations.js` without changing their bodies unless a later step in this task explicitly says to change one:

```text
find_separator_node
is_structured_list_separator
find_select_span
case_scope_for_item
case_node_for_item
tokens_between_same_line
token_inside_scope_kind
follows_window_order_by
token_scope_by_open_index
token_scope_by_close_index
render_node_tokens_with_options
render_node_tokens
structured_list_indent
item_indent
token_inside_nested_scope
find_as_token
effective_line_indent
effective_token_line_indent
rendered_item_width_before_as
max_rendered_item_width_before_as
rendered_item_width_without_as
existing_case_alias_target_width
apply_select_as_alignment_mutations
has_select_hint_line
has_select_header_comment_line
apply_between_item_comment_indents
token_inside_item
top_level_function_scope_for_item
first_word_after_scope_close
function_item_alias_spacing
apply_multiline_function_item_mutations
line_starts_with_leading_separator
select_span_by_id
is_first_item_in_owner
should_join_select_header_first_item
nearest_group_by_span_before_token
line_has_code_before_token_except
apply_group_by_extension_mutations
apply_select_list_mutations
```

Do not move `scope_by_id(document, scopeId)`. It is unused and would violate the new boundary check.

Do not move `active_code_tokens(document)`. Step 3 replaces that local helper with the shared navigation API.

- [ ] **Step 3: Replace active code token collection with `sql-format-navigation`**

In the moved `apply_group_by_extension_mutations()` function, change:

```js
var tokens = active_code_tokens(document);
```

to:

```js
var tokens = sqlFormatNavigation.active_tokens(document);
```

Remove the old `active_code_tokens(document)` helper from `sql-select-formatter.js` and do not add it to `sql-select-mutations.js`.

- [ ] **Step 4: Export only the structured public API**

At the bottom of `lib/core/sql-select-mutations.js`, add:

```js
exports.apply_select_list_mutations = apply_select_list_mutations;
```

Do not export `apply_select_as_alignment_mutations`, `apply_multiline_function_item_mutations`, or `apply_group_by_extension_mutations`.

- [ ] **Step 5: Add the facade import**

In `lib/core/sql-select-formatter.js`, add this near the other imports:

```js
var sqlSelectMutations = require('./sql-select-mutations');
```

- [ ] **Step 6: Replace the local structured mutation implementation with a delegate**

In `lib/core/sql-select-formatter.js`, replace the moved `apply_select_list_mutations()` implementation with:

```js
function apply_select_list_mutations(document, nodes, mutations, config) {
	return sqlSelectMutations.apply_select_list_mutations(document, nodes, mutations, config);
}
```

Keep this export unchanged:

```js
exports.apply_select_list_mutations = apply_select_list_mutations;
```

- [ ] **Step 7: Remove structured-only imports from the facade**

In `lib/core/sql-select-formatter.js`, remove imports that are only needed by the moved structured mutation code:

```js
var sqlFormatMutations = require('./sql-format-mutations');
var sqlKeywords = require('./sql-keywords');
var sqlGroupByExtension = require('./sql-group-by-extension');
```

Keep these imports because the compatibility functions still use them:

```js
var sqlTokenizer = require('./sql-tokenizer');
var sqlStructure = require('./sql-structure');
var sqlTokenPrimitives = require('./sql-token-primitives');
var sqlCaseUtils = require('./sql-case-utils');
var sqlFormatUtils = require('./sql-format-utils');
var sqlClauseRegistry = require('./sql-clause-registry');
var sqlFormatDocument = require('./sql-format-document');
var sqlScopeModel = require('./sql-scope-model');
var sqlFormatNodes = require('./sql-format-nodes');
```

`repeat_space` must stay in the facade because `apply_as_alignment_on_items()` still uses it.

- [ ] **Step 8: Remove unused structured leftovers from the facade**

Remove these from `lib/core/sql-select-formatter.js` if they are still present after the move:

```text
scope_by_id
active_code_tokens
```

Do not remove `split_same_line_select_separators()`, `format_select_clause_lists()`, `align_as_in_select_blocks()`, `apply_trailing_comma_style()`, or `repair_orphan_leading_commas()`.

- [ ] **Step 9: Run syntax and targeted tests**

Run:

```bash
node -c lib/core/sql-select-formatter.js
node -c lib/core/sql-select-mutations.js
node tests/module-boundary.test.js
node tests/select-alignment.test.js
node tests/structured-pipeline-regression.test.js
node tests/window-function-spacing.test.js
node tests/hive-regression.test.js
```

Expected: all commands pass. Any formatter output difference is a regression unless it is separately approved.

- [ ] **Step 10: Inspect the split shape**

Run:

```bash
wc -l lib/core/sql-select-formatter.js lib/core/sql-select-mutations.js
rg -n "^function apply_select_list_mutations|^exports\\.|require\\('./sql-select-mutations'\\)" lib/core/sql-select-formatter.js lib/core/sql-select-mutations.js
rg -n "\\bscope_by_id\\b|\\bactive_code_tokens\\b" lib/core/sql-select-formatter.js lib/core/sql-select-mutations.js
```

Expected:

```text
sql-select-formatter.js requires './sql-select-mutations'.
sql-select-formatter.js still exports the same compatibility API.
sql-select-mutations.js exports only apply_select_list_mutations.
No scope_by_id or active_code_tokens helper remains in either file.
```

- [ ] **Step 11: Commit the structured SELECT mutation extraction**

Run:

```bash
git add lib/core/sql-select-formatter.js lib/core/sql-select-mutations.js tests/module-boundary.test.js
git commit -m "refactor: extract structured select mutations"
```

Expected: commit succeeds.

---

### Task 4: Verify Legacy SELECT Compatibility Surface

**Files:**
- Verify: `lib/core/sql-select-formatter.js`
- Verify: `tests/module-boundary.test.js`
- Verify: `tests/select-alignment.test.js`

- [ ] **Step 1: Confirm legacy exports still exist**

Run:

```bash
node - <<'NODE'
var assert = require('assert');
var selectFormatter = require('./lib/core/sql-select-formatter');
[
	'expand_tabs_for_width',
	'format_select_clause_lists',
	'apply_select_list_mutations',
	'split_same_line_select_separators',
	'align_as_in_select_blocks',
	'apply_trailing_comma_style',
	'repair_orphan_leading_commas'
].forEach(function(name) {
	assert.strictEqual(typeof selectFormatter[name], 'function', name + ' must remain exported');
});
console.log('select formatter compatibility exports passed');
NODE
```

Expected:

```text
select formatter compatibility exports passed
```

- [ ] **Step 2: Confirm the default formatter does not call legacy SELECT string functions**

Run:

```bash
node tests/module-boundary.test.js
```

Expected: pass. This test includes guards for `repair_orphan_leading_commas`, `align_as_in_select_blocks`, and `apply_trailing_comma_style` not being called by the default structured formatter path.

- [ ] **Step 3: Run SELECT compatibility regressions**

Run:

```bash
node tests/select-alignment.test.js
node tests/formatter-api.test.js
node tests/canonical-core-boundary.test.js
```

Expected: all pass. `formatter-api` and canonical boundary coverage help catch accidental public API drift.

- [ ] **Step 4: Commit only if verification required cleanup changes**

If Task 4 produced no file changes, do not create a commit.

If you made cleanup changes, run:

```bash
node tests/module-boundary.test.js
node tests/select-alignment.test.js
git add lib/core/sql-select-formatter.js tests/module-boundary.test.js
git commit -m "test: guard structured select mutation facade"
```

Expected: commit succeeds only if there were actual cleanup or test changes.

---

### Task 5: Full Verification

**Files:**
- Verify: formatter source and tests only

- [ ] **Step 1: Run the full verification suite**

Run:

```bash
npm run test:verify
```

Expected: all tests pass, including performance smoke under the existing threshold.

- [ ] **Step 2: Inspect final changed files**

Run:

```bash
git status --short
git diff --stat HEAD~1..HEAD
git diff --name-only HEAD~1..HEAD
```

Expected:

```text
Working tree is clean.
Changes are limited to lib/core/sql-select-formatter.js, lib/core/sql-select-mutations.js, and tests/module-boundary.test.js unless Task 4 required a small test cleanup.
```

- [ ] **Step 3: Confirm no generated artifacts were added**

Run:

```bash
fd '\\.vsix$' .
```

Expected: no output. Do not commit `.vsix` artifacts.

- [ ] **Step 4: Record final source shape**

Run:

```bash
wc -l lib/core/sql-select-formatter.js lib/core/sql-select-mutations.js
rg -n "^function |^\\tfunction |^exports\\." lib/core/sql-select-formatter.js lib/core/sql-select-mutations.js
```

Expected:

```text
sql-select-formatter.js is smaller and contains compatibility/string-level SELECT functions plus the facade delegate.
sql-select-mutations.js contains the structured mutation helper family and exports only apply_select_list_mutations.
```

---

## Implementation Notes

- This is a behavior-preserving refactor. Treat every output difference as a regression.
- Move function bodies mechanically first. Avoid renaming helpers or changing formatting logic during the extraction.
- Keep the new module inside `lib/core/`.
- Keep `sql-formatter.js` unchanged in this pass; it should continue to call the `sql-select-formatter.js` facade.
- Keep CommonJS `var` style, semicolons, and the project’s existing formatting style.
- Do not run `npm run package:vsix`; packaging is not part of this refactor.

## Completion Criteria

- `lib/core/sql-select-mutations.js` exists and exports `apply_select_list_mutations`.
- `lib/core/sql-select-formatter.js` still exports the existing compatibility API.
- `apply_select_list_mutations()` in the facade delegates to `sql-select-mutations.js`.
- `tests/module-boundary.test.js` guards the new module and facade boundary.
- `npm run test:verify` passes.
