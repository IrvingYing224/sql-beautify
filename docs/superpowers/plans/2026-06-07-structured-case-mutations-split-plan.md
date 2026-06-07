# Structured Case Mutations Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the structured CASE mutation implementation into `lib/core/sql-case-mutations.js` while keeping `lib/core/sql-case-formatter.js` as the compatibility facade with unchanged public exports and unchanged formatter output.

**Architecture:** `sql-case-formatter.js` remains the module imported by the default formatter and compatibility tests. It delegates `apply_case_mutations()` to a new focused `sql-case-mutations.js` module; string-level CASE formatting helpers and `render_case_node()` stay in `sql-case-formatter.js`.

**Tech Stack:** CommonJS JavaScript, Node.js assertion-based tests, existing SQL formatter structured pipeline and regression suite.

---

## File Structure

- Create: `lib/core/sql-case-mutations.js`
  - Owns the structured CASE mutation pass and its private helpers.
  - Exports only `apply_case_mutations`.
- Modify: `lib/core/sql-case-formatter.js`
  - Adds a `sql-case-mutations` import.
  - Keeps string-level CASE compatibility helpers and existing public exports.
  - Keeps `render_case_node()` in this facade module.
  - Delegates `apply_case_mutations()` to the new module.
- Modify: `tests/module-boundary.test.js`
  - Requires the new module.
  - Checks the new module exists.
  - Extends navigation-helper boundary checks to cover `sql-case-mutations.js`.
  - Verifies the facade delegates the structured mutation export.

Do not modify `lib/core/sql-formatter.js`. Do not modify root `lib/*.js` shims. Do not modify `lib/adapters/`. Do not modify `lib/experimental/ddl/`. Do not change formatter behavior intentionally.

---

### Task 1: Establish Baseline

**Files:**
- Read: `docs/superpowers/specs/2026-06-07-structured-case-mutations-split-design.md`
- Read: `docs/technical/sql-formatter-architecture.md`
- Read: `lib/core/sql-case-formatter.js`

- [ ] **Step 1: Confirm the worktree is clean**

Run:

```bash
git status --short
```

Expected: no output. If there are unrelated changes, inspect them first and do not revert user work.

- [ ] **Step 2: Run CASE-focused baseline tests**

Run:

```bash
node tests/case-when.test.js
node tests/structured-pipeline-regression.test.js
node tests/select-alignment.test.js
node tests/pipeline-idempotency.test.js
node tests/module-boundary.test.js
```

Expected: all commands pass before edits. If any baseline test fails, stop and investigate the baseline failure first.

- [ ] **Step 3: Record the current structured CASE function map**

Run:

```bash
rg -n "^function |^\\s+function |^exports\\.|^var " lib/core/sql-case-formatter.js
```

Expected: output includes these structured-path functions before the split:

```text
select_item_for_case_node
select_span_for_item
select_base_indent
case_base_indent
has_code_before_token_on_line
set_keyword_layout
first_word_after_token_on_same_line
is_nested_case_node
normalized_prefix_before_token
select_item_prefix_before_case
function_case_indent
nested_case_value_for_branch
apply_nested_case_value_joins
omit_blank_lines_inside_case
condition_segment_before_case
case_follows_condition_clause_keyword
render_tokens_between
condition_case_base_indent
case_start_indent
token_indexes
scope_is_inside_tokens
token_in_token_list
token_in_case_value
owner_function_scope
token_inside_function_named
is_originally_compact_case_function_plus
follows_originally_compact_case_function_plus
then_follows_when_close_paren
then_comment_has_following_value
can_join_then_line_to_when
can_join_else_value_line
case_has_multiline_when
tokens_are_single_function_call
case_should_wrap_values
token_value_text
original_gap_between
render_token_values
tokens_on_line
sorted_token_lines
direct_scope_for_case_when_line
tokens_between_same_line
add_case_width
case_alias_spacing
apply_case_when_scope_indents
apply_case_when_inlist_layout
case_when_then_spacing
apply_case_mutations
```

Do not move these compatibility/string-level functions:

```text
split_code_and_comment
split_case_code_and_comment
normalize_case_value_text
normalize_case_condition_text
get_first_comment_loc
get_paren_balance
strip_top_level_trailing_comma_before_comment
is_standalone_comment_marker_line
build_case_formatted_text
split_case_boundary_lines
normalize_case_multiline_condition_lines
format_case_multiline_when_item
format_case_expression_line
format_case_blocks
find_root_case_start_loc
render_tokens
render_case_node
```

`render_case_node()` must remain exported from `sql-case-formatter.js`.

---

### Task 2: Add Boundary Tests For The New Module

**Files:**
- Modify: `tests/module-boundary.test.js`

- [ ] **Step 1: Add a require for the new module**

At the top of `tests/module-boundary.test.js`, after the existing formatter requires, add:

```js
var sqlCaseMutations = require('../lib/core/sql-case-mutations');
```

- [ ] **Step 2: Assert the new public API**

After the existing assertion:

```js
assert.strictEqual(typeof sqlCaseFormatter.format_case_blocks, 'function', 'case formatter must export format_case_blocks');
```

add:

```js
assert.strictEqual(typeof sqlCaseFormatter.apply_case_mutations, 'function', 'case formatter must export apply_case_mutations');
assert.strictEqual(typeof sqlCaseFormatter.render_case_node, 'function', 'case formatter must export render_case_node');
assert.strictEqual(typeof sqlCaseMutations.apply_case_mutations, 'function', 'structured case mutations must export apply_case_mutations');
```

- [ ] **Step 3: Assert the new file exists**

After the existing structured SELECT mutation module existence check, add:

```js
assert.ok(
	fs.existsSync(path.join(__dirname, '..', 'lib/core/sql-case-mutations.js')),
	'structured CASE mutation module must exist'
);
```

- [ ] **Step 4: Extend navigation-helper boundary checks**

Add `lib/core/sql-case-mutations.js` to the array that currently checks for local definitions of:

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
	'lib/core/sql-case-mutations.js',
	'lib/core/sql-layout-formatter.js',
	'lib/core/sql-case-formatter.js',
	'lib/core/sql-condition-formatter.js',
	'lib/core/sql-format-nodes.js'
].forEach(function(relativePath) {
```

Also add `lib/core/sql-case-mutations.js` to the array that checks for local `scope_by_id(document, ...)` helpers:

```js
[
	'lib/core/sql-structured-renderer.js',
	'lib/core/sql-render-indent.js',
	'lib/core/sql-render-token-spacing.js',
	'lib/core/sql-select-mutations.js',
	'lib/core/sql-case-mutations.js',
	'lib/core/sql-case-formatter.js',
	'lib/core/sql-condition-formatter.js',
	'lib/core/sql-format-nodes.js'
].forEach(function(relativePath) {
```

- [ ] **Step 5: Add a facade delegation assertion**

Near the existing `selectFormatterFacadeSource` assertion block, after `var selectFormatterFacadeSource = ...`, add:

```js
var caseFormatterFacadeSource = read_source('lib/core/sql-case-formatter.js');
```

After the SELECT facade assertions, add:

```js
assert.ok(
	caseFormatterFacadeSource.indexOf("require('./sql-case-mutations')") >= 0,
	'sql-case-formatter facade must require structured case mutations'
);
assert.ok(
	/sqlCaseMutations\.apply_case_mutations\s*\(/.test(caseFormatterFacadeSource),
	'sql-case-formatter facade must delegate apply_case_mutations to sql-case-mutations'
);
assert.ok(
	/function\s+render_case_node\s*\(/.test(caseFormatterFacadeSource),
	'sql-case-formatter facade must keep render_case_node for compatibility'
);
```

- [ ] **Step 6: Run the boundary test and confirm it fails before implementation**

Run:

```bash
node tests/module-boundary.test.js
```

Expected: FAIL because `../lib/core/sql-case-mutations` does not exist yet, or because the facade does not delegate yet. Do not commit this failing state.

---

### Task 3: Extract Structured CASE Mutations

**Files:**
- Create: `lib/core/sql-case-mutations.js`
- Modify: `lib/core/sql-case-formatter.js`
- Modify: `tests/module-boundary.test.js`

- [ ] **Step 1: Create `sql-case-mutations.js` imports**

Create `lib/core/sql-case-mutations.js` with:

```js
var sqlFormatUtils = require('./sql-format-utils');
var sqlFormatMutations = require('./sql-format-mutations');
var sqlFormatNavigation = require('./sql-format-navigation');
var sqlScopeModel = require('./sql-scope-model');
var repeat_space = sqlFormatUtils.repeat_space;
var expand_tabs_for_width = sqlFormatUtils.expand_tabs_for_width;
```

- [ ] **Step 2: Move structured helper functions into the new module**

Move these functions from `lib/core/sql-case-formatter.js` into `lib/core/sql-case-mutations.js` without changing their bodies unless a later step in this task explicitly says to change one:

```text
select_item_for_case_node
select_span_for_item
select_base_indent
case_base_indent
has_code_before_token_on_line
set_keyword_layout
first_word_after_token_on_same_line
is_nested_case_node
normalized_prefix_before_token
select_item_prefix_before_case
function_case_indent
nested_case_value_for_branch
apply_nested_case_value_joins
omit_blank_lines_inside_case
condition_segment_before_case
case_follows_condition_clause_keyword
render_tokens_between
condition_case_base_indent
case_start_indent
token_indexes
scope_is_inside_tokens
token_in_token_list
token_in_case_value
owner_function_scope
token_inside_function_named
is_originally_compact_case_function_plus
follows_originally_compact_case_function_plus
then_follows_when_close_paren
then_comment_has_following_value
can_join_then_line_to_when
can_join_else_value_line
case_has_multiline_when
tokens_are_single_function_call
case_should_wrap_values
token_value_text
original_gap_between
render_token_values
tokens_on_line
sorted_token_lines
direct_scope_for_case_when_line
tokens_between_same_line
add_case_width
case_alias_spacing
apply_case_when_scope_indents
apply_case_when_inlist_layout
case_when_then_spacing
apply_case_mutations
```

Do not move `render_tokens()` or `render_case_node()`. They stay in `sql-case-formatter.js`.

- [ ] **Step 3: Export only the structured public API**

At the bottom of `lib/core/sql-case-mutations.js`, add:

```js
exports.apply_case_mutations = apply_case_mutations;
```

Do not export `case_alias_spacing`, `case_should_wrap_values`, `render_token_values`, or any other helper.

- [ ] **Step 4: Add the facade import**

In `lib/core/sql-case-formatter.js`, add this near the other imports:

```js
var sqlCaseMutations = require('./sql-case-mutations');
```

- [ ] **Step 5: Replace the local structured mutation implementation with a delegate**

In `lib/core/sql-case-formatter.js`, replace the moved `apply_case_mutations()` implementation with:

```js
function apply_case_mutations(document, nodes, mutations, config) {
	return sqlCaseMutations.apply_case_mutations(document, nodes, mutations, config);
}
```

Keep this export unchanged:

```js
exports.apply_case_mutations = apply_case_mutations;
```

- [ ] **Step 6: Remove structured-only imports from the facade**

In `lib/core/sql-case-formatter.js`, remove imports that are only needed by the moved structured mutation code:

```js
var sqlFormatMutations = require('./sql-format-mutations');
var sqlFormatNavigation = require('./sql-format-navigation');
var sqlScopeModel = require('./sql-scope-model');
var expand_tabs_for_width = sqlFormatUtils.expand_tabs_for_width;
```

Keep these imports because the compatibility functions still use them:

```js
var sqlTokenizer = require('./sql-tokenizer');
var sqlStructure = require('./sql-structure');
var sqlCaseUtils = require('./sql-case-utils');
var sqlFormatUtils = require('./sql-format-utils');
var repeat_space = sqlFormatUtils.repeat_space;
```

- [ ] **Step 7: Confirm compatibility exports remain unchanged**

At the bottom of `lib/core/sql-case-formatter.js`, the exports must still be:

```js
exports.get_case_tokens = get_case_tokens;
exports.get_case_balance_delta = get_case_balance_delta;
exports.find_top_level_as_loc = find_top_level_as_loc;
exports.get_outer_as_code_width = get_outer_as_code_width;
exports.get_alignment_width_for_code = get_alignment_width_for_code;
exports.format_case_expression_line = format_case_expression_line;
exports.format_case_blocks = format_case_blocks;
exports.apply_case_mutations = apply_case_mutations;
exports.render_case_node = render_case_node;
exports.find_root_case_start_loc = find_root_case_start_loc;
exports.is_case_branch_line = sqlCaseUtils.is_case_branch_line;
```

- [ ] **Step 8: Run syntax and targeted tests**

Run:

```bash
node -c lib/core/sql-case-formatter.js
node -c lib/core/sql-case-mutations.js
node tests/module-boundary.test.js
node tests/case-when.test.js
node tests/structured-pipeline-regression.test.js
node tests/select-alignment.test.js
node tests/pipeline-idempotency.test.js
```

Expected: all commands pass. Any formatter output difference is a regression unless it is separately approved.

- [ ] **Step 9: Inspect the split shape**

Run:

```bash
wc -l lib/core/sql-case-formatter.js lib/core/sql-case-mutations.js
rg -n "^function apply_case_mutations|^function render_case_node|^exports\\.|require\\('./sql-case-mutations'\\)" lib/core/sql-case-formatter.js lib/core/sql-case-mutations.js
rg -n "\\bsqlFormatMutations\\b|\\bsqlFormatNavigation\\b|\\bsqlScopeModel\\b|\\bexpand_tabs_for_width\\b" lib/core/sql-case-formatter.js
```

Expected:

```text
sql-case-formatter.js requires './sql-case-mutations'.
sql-case-formatter.js still contains and exports render_case_node.
sql-case-formatter.js still exports the same compatibility API.
sql-case-mutations.js exports only apply_case_mutations.
sqlFormatMutations, sqlFormatNavigation, sqlScopeModel, and expand_tabs_for_width are absent from sql-case-formatter.js.
```

- [ ] **Step 10: Commit the structured CASE mutation extraction**

Run:

```bash
git add lib/core/sql-case-formatter.js lib/core/sql-case-mutations.js tests/module-boundary.test.js
git commit -m "refactor: extract structured case mutations"
```

Expected: commit succeeds.

---

### Task 4: Verify CASE Compatibility Surface

**Files:**
- Verify: `lib/core/sql-case-formatter.js`
- Verify: `lib/core/sql-case-mutations.js`
- Verify: `tests/module-boundary.test.js`
- Verify: `tests/structured-pipeline-regression.test.js`

- [ ] **Step 1: Confirm legacy exports still exist**

Run:

```bash
node - <<'NODE'
var assert = require('assert');
var caseFormatter = require('./lib/core/sql-case-formatter');
[
	'get_case_tokens',
	'get_case_balance_delta',
	'find_top_level_as_loc',
	'get_outer_as_code_width',
	'get_alignment_width_for_code',
	'format_case_expression_line',
	'format_case_blocks',
	'apply_case_mutations',
	'render_case_node',
	'find_root_case_start_loc',
	'is_case_branch_line'
].forEach(function(name) {
	assert.strictEqual(typeof caseFormatter[name], 'function', name + ' must remain exported');
});
console.log('case formatter compatibility exports passed');
NODE
```

Expected:

```text
case formatter compatibility exports passed
```

- [ ] **Step 2: Confirm the new module has a narrow export surface**

Run:

```bash
node - <<'NODE'
var assert = require('assert');
var caseMutations = require('./lib/core/sql-case-mutations');
assert.deepStrictEqual(Object.keys(caseMutations).sort(), ['apply_case_mutations']);
console.log('case mutations export surface passed');
NODE
```

Expected:

```text
case mutations export surface passed
```

- [ ] **Step 3: Confirm the default formatter does not call legacy CASE string functions**

Run:

```bash
node tests/module-boundary.test.js
```

Expected: pass. This test includes guards for `format_case_blocks` not being called by the default structured formatter path.

- [ ] **Step 4: Run CASE compatibility regressions**

Run:

```bash
node tests/case-when.test.js
node tests/structured-pipeline-regression.test.js
node tests/formatter-api.test.js
node tests/canonical-core-boundary.test.js
```

Expected: all pass. `structured-pipeline-regression` protects `apply_case_mutations()` and `render_case_node()` compatibility; `formatter-api` and canonical boundary coverage help catch accidental public API drift.

- [ ] **Step 5: Commit only if verification required cleanup changes**

If Task 4 produced no file changes, do not create a commit.

If you made cleanup changes, run:

```bash
node tests/module-boundary.test.js
node tests/case-when.test.js
git add lib/core/sql-case-formatter.js lib/core/sql-case-mutations.js tests/module-boundary.test.js
git commit -m "test: guard structured case mutation facade"
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
Changes are limited to lib/core/sql-case-formatter.js, lib/core/sql-case-mutations.js, and tests/module-boundary.test.js unless Task 4 required a small test cleanup.
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
wc -l lib/core/sql-case-formatter.js lib/core/sql-case-mutations.js
rg -n "^function |^\\s+function |^exports\\." lib/core/sql-case-formatter.js lib/core/sql-case-mutations.js
```

Expected:

```text
sql-case-formatter.js is smaller and contains compatibility/string-level CASE functions plus render_case_node and the facade delegate.
sql-case-mutations.js contains the structured mutation helper family and exports only apply_case_mutations.
```

---

## Implementation Notes

- This is a behavior-preserving refactor. Treat every output difference as a regression.
- Move function bodies mechanically first. Avoid renaming helpers or changing formatting logic during the extraction.
- Keep the new module inside `lib/core/`.
- Keep `sql-formatter.js` unchanged in this pass; it should continue to call the `sql-case-formatter.js` facade.
- Keep `render_case_node()` in `sql-case-formatter.js`.
- Keep CommonJS `var` style, semicolons, and the project’s existing formatting style.
- Do not run `npm run package:vsix`; packaging is not part of this refactor.
- Do not mix in pure indentation cleanup for migrated code. Existing odd indentation can be handled in a separate no-behavior cleanup after this split is stable.

## Completion Criteria

- `lib/core/sql-case-mutations.js` exists and exports only `apply_case_mutations`.
- `lib/core/sql-case-formatter.js` still exports the existing compatibility API.
- `render_case_node()` remains in and is exported from `sql-case-formatter.js`.
- `apply_case_mutations()` in the facade delegates to `sql-case-mutations.js`.
- `tests/module-boundary.test.js` guards the new module and facade boundary.
- `npm run test:verify` passes.
