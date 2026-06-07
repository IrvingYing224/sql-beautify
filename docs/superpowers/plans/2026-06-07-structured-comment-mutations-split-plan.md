# Structured Comment Mutations Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the structured comment alignment mutation implementation into `lib/core/sql-comment-mutations.js` while keeping `lib/core/sql-comment-formatter.js` as the compatibility facade with unchanged public exports and unchanged formatter output.

**Architecture:** `sql-comment-formatter.js` remains the module imported by the default formatter and by compatibility tests. It delegates `apply_comment_alignment_mutations()` to a new focused `sql-comment-mutations.js` module; comment protection, restore, spacing normalization, and legacy `order_comment()` compatibility functions stay in `sql-comment-formatter.js`.

**Tech Stack:** CommonJS JavaScript, Node.js assertion-based tests, existing SQL formatter structured pipeline and regression suite.

---

## File Structure

- Create: `lib/core/sql-comment-mutations.js`
  - Owns the structured trailing-comment alignment mutation pass and its private helpers.
  - Exports only `apply_comment_alignment_mutations`.
- Modify: `lib/core/sql-comment-formatter.js`
  - Adds a `sql-comment-mutations` import.
  - Keeps legacy/string-level comment compatibility helpers and existing public exports.
  - Delegates `apply_comment_alignment_mutations()` to the new module.
- Modify: `tests/module-boundary.test.js`
  - Requires the new module.
  - Checks the new module exists.
  - Verifies the facade delegates the structured mutation export.
  - Adds precise export-surface assertions for SELECT, CASE, and comment mutation modules.

Do not modify `lib/core/sql-formatter.js`. Do not modify root `lib/*.js` shims. Do not modify `lib/adapters/`. Do not modify `lib/experimental/ddl/`. Do not change formatter behavior intentionally.

Do not add `lib/core/sql-comment-mutations.js` to the navigation-helper ban arrays in `tests/module-boundary.test.js` in this pass. The first split intentionally moves the local width-planning helpers mechanically; replacing those helpers belongs in a later cleanup.

---

### Task 1: Establish Baseline

**Files:**
- Read: `docs/superpowers/specs/2026-06-07-structured-comment-mutations-split-design.md`
- Read: `docs/technical/sql-formatter-architecture.md`
- Read: `lib/core/sql-comment-formatter.js`

- [ ] **Step 1: Confirm the worktree is clean**

Run:

```bash
git status --short
```

Expected: no output. If there are unrelated changes, inspect them first and do not revert user work.

- [ ] **Step 2: Run comment-focused baseline tests**

Run:

```bash
node tests/comment-alignment.test.js
node tests/structured-pipeline-regression.test.js
node tests/select-alignment.test.js
node tests/case-when.test.js
node tests/condition-alignment.test.js
node tests/module-boundary.test.js
```

Expected: all commands pass before edits. If any baseline test fails, stop and investigate the baseline failure first.

- [ ] **Step 3: Record the current structured comment function map**

Run:

```bash
rg -n "^function |^\\s+function |^exports\\.|^var " lib/core/sql-comment-formatter.js
```

Expected: output includes `apply_comment_alignment_mutations` and these structured-path local helpers inside it:

```text
separator_node_for_id
planned_prefix_width
normalized_token_value
original_gap_between
normalized_original_space
is_word_token
previous_code_token
token_inside_scope_kind
follows_window_order_by
rendered_code_text_for_width
planned_unjoined_code_width
planned_code_width
planned_join_prefix_width
line_has_line_break_mutation
line_inside_case_expr
planned_code_segment
planned_alignment_width
max_segment_width
max_segment_alignment_width
is_condition_keyword_only_comment_line
is_select_header_comment_line
is_close_only_comment_line
is_parenthesized_scope_body_line
is_query_function_open_comment_line
is_condition_bare_continuation_line
is_join_bridge_line
condition_segment_keyword
is_condition_segment_line
group_has_condition_comment
is_select_item_line
token_after_case_end_on_same_line
is_case_end_alias_comment_line
is_case_branch_value_comment_line
group_has_case_branch_value_comment
line_index_inside_case_expression
group_has_select_item_comment
current_group_is_select_only
group_can_bridge_clause_line
group_can_bridge_select_to_having
is_standalone_comment_between_select_items
select_item_for_line
select_owner_for_line
pending_select_group_matches
collapsed_select_item_for_line
is_collapsed_select_item_bridge_line
is_hive_hint_select_item_line
flush_group
```

Do not move these compatibility/string-level functions:

```text
split_code_and_comment
protect_standalone_comments
get_first_comment_loc
protect_inline_comments
restore_comments
normalize_line_comment_spacing
order_comment
```

---

### Task 2: Add Boundary Tests For The New Module

**Files:**
- Modify: `tests/module-boundary.test.js`

- [ ] **Step 1: Add a require for the new module**

At the top of `tests/module-boundary.test.js`, after the existing mutation module requires, add:

```js
var sqlCommentMutations = require('../lib/core/sql-comment-mutations');
```

- [ ] **Step 2: Assert the new public API**

After the existing assertion:

```js
assert.strictEqual(typeof sqlCommentFormatter.normalize_line_comment_spacing, 'function', 'comment formatter must export normalize_line_comment_spacing');
```

add:

```js
assert.strictEqual(typeof sqlCommentFormatter.apply_comment_alignment_mutations, 'function', 'comment formatter must export apply_comment_alignment_mutations');
assert.strictEqual(typeof sqlCommentMutations.apply_comment_alignment_mutations, 'function', 'structured comment mutations must export apply_comment_alignment_mutations');
```

- [ ] **Step 3: Add precise mutation module export assertions**

After the existing SELECT and CASE mutation API assertions, add:

```js
assert.deepStrictEqual(
	Object.keys(sqlSelectMutations).sort(),
	['apply_select_list_mutations'],
	'structured select mutations must expose only apply_select_list_mutations'
);
assert.deepStrictEqual(
	Object.keys(sqlCaseMutations).sort(),
	['apply_case_mutations'],
	'structured case mutations must expose only apply_case_mutations'
);
assert.deepStrictEqual(
	Object.keys(sqlCommentMutations).sort(),
	['apply_comment_alignment_mutations'],
	'structured comment mutations must expose only apply_comment_alignment_mutations'
);
```

- [ ] **Step 4: Assert the new file exists**

After the existing structured CASE mutation module existence check, add:

```js
assert.ok(
	fs.existsSync(path.join(__dirname, '..', 'lib/core/sql-comment-mutations.js')),
	'structured comment mutation module must exist'
);
```

- [ ] **Step 5: Keep navigation-helper boundary arrays unchanged**

Do not add `lib/core/sql-comment-mutations.js` to the arrays that check for local definitions of:

```text
token_by_index
previous_code_token
next_code_token
active_tokens
scope_by_id(document, ...)
```

This split intentionally keeps local comment width-planning helpers mechanical. Adding the new module to these arrays would fail on the existing local `previous_code_token()` helper and would turn this boundary split into a helper rewrite.

- [ ] **Step 6: Add facade source checks**

Near the existing `selectFormatterFacadeSource` and `caseFormatterFacadeSource` variables, add:

```js
var commentFormatterFacadeSource = read_source('lib/core/sql-comment-formatter.js');
```

After the CASE facade assertions, add:

```js
assert.ok(
	commentFormatterFacadeSource.indexOf("require('./sql-comment-mutations')") >= 0,
	'sql-comment-formatter facade must require structured comment mutations'
);
assert.ok(
	/sqlCommentMutations\.apply_comment_alignment_mutations\s*\(/.test(commentFormatterFacadeSource),
	'sql-comment-formatter facade must delegate apply_comment_alignment_mutations to sql-comment-mutations'
);
```

- [ ] **Step 7: Run the boundary test and confirm it fails before implementation**

Run:

```bash
node tests/module-boundary.test.js
```

Expected: FAIL because `../lib/core/sql-comment-mutations` does not exist yet, or because the facade does not delegate yet. Do not commit this failing state.

---

### Task 3: Extract Structured Comment Mutations

**Files:**
- Create: `lib/core/sql-comment-mutations.js`
- Modify: `lib/core/sql-comment-formatter.js`
- Modify: `tests/module-boundary.test.js`

- [ ] **Step 1: Create `sql-comment-mutations.js` imports**

Create `lib/core/sql-comment-mutations.js` with:

```js
var sqlFormatUtils = require('./sql-format-utils');
var sqlCaseUtils = require('./sql-case-utils');
var sqlFormatMutations = require('./sql-format-mutations');
var expand_tabs_for_width = sqlFormatUtils.expand_tabs_for_width;
var get_alignment_width_for_code = sqlCaseUtils.get_alignment_width_for_code;
```

Do not import `sql-tokenizer`, `sql-structure`, `sql-line-model`, `sql-format-context`, or `sql-format-model` into `sql-comment-mutations.js`; those belong to the compatibility facade path.

- [ ] **Step 2: Move the structured mutation function into the new module**

Move `apply_comment_alignment_mutations(document, nodes, mutations, config)` from `lib/core/sql-comment-formatter.js` into `lib/core/sql-comment-mutations.js` without changing its body.

The moved function includes these local helpers and they should remain local in the first split:

```text
separator_node_for_id
planned_prefix_width
normalized_token_value
original_gap_between
normalized_original_space
is_word_token
previous_code_token
token_inside_scope_kind
follows_window_order_by
rendered_code_text_for_width
planned_unjoined_code_width
planned_code_width
planned_join_prefix_width
line_has_line_break_mutation
line_inside_case_expr
planned_code_segment
planned_alignment_width
max_segment_width
max_segment_alignment_width
is_condition_keyword_only_comment_line
is_select_header_comment_line
is_close_only_comment_line
is_parenthesized_scope_body_line
is_query_function_open_comment_line
is_condition_bare_continuation_line
is_join_bridge_line
condition_segment_keyword
is_condition_segment_line
group_has_condition_comment
is_select_item_line
token_after_case_end_on_same_line
is_case_end_alias_comment_line
is_case_branch_value_comment_line
group_has_case_branch_value_comment
line_index_inside_case_expression
group_has_select_item_comment
current_group_is_select_only
group_can_bridge_clause_line
group_can_bridge_select_to_having
is_standalone_comment_between_select_items
select_item_for_line
select_owner_for_line
pending_select_group_matches
collapsed_select_item_for_line
is_collapsed_select_item_bridge_line
is_hive_hint_select_item_line
flush_group
```

- [ ] **Step 3: Export only the structured public API**

At the bottom of `lib/core/sql-comment-mutations.js`, add:

```js
exports.apply_comment_alignment_mutations = apply_comment_alignment_mutations;
```

Do not export any helper.

- [ ] **Step 4: Add the facade import**

In `lib/core/sql-comment-formatter.js`, add this near the other imports:

```js
var sqlCommentMutations = require('./sql-comment-mutations');
```

- [ ] **Step 5: Replace the local structured mutation implementation with a delegate**

In `lib/core/sql-comment-formatter.js`, replace the moved `apply_comment_alignment_mutations()` implementation with:

```js
function apply_comment_alignment_mutations(document, nodes, mutations, config) {
	return sqlCommentMutations.apply_comment_alignment_mutations(document, nodes, mutations, config);
}
```

Keep this export unchanged:

```js
exports.apply_comment_alignment_mutations = apply_comment_alignment_mutations;
```

- [ ] **Step 6: Remove structured-only imports from the facade**

In `lib/core/sql-comment-formatter.js`, remove the import that is only needed by the moved structured mutation code:

```js
var sqlFormatMutations = require('./sql-format-mutations');
```

Keep these imports because the compatibility functions still use them:

```js
var sqlTokenizer = require('./sql-tokenizer');
var sqlStructure = require('./sql-structure');
var sqlLineModel = require('./sql-line-model');
var sqlFormatContext = require('./sql-format-context');
var sqlFormatUtils = require('./sql-format-utils');
var sqlCaseUtils = require('./sql-case-utils');
var sqlFormatModel = require('./sql-format-model');
var expand_tabs_for_width = sqlFormatUtils.expand_tabs_for_width;
var repeat_space = sqlFormatUtils.repeat_space;
var find_top_level_as_loc = sqlCaseUtils.find_top_level_as_loc;
var get_alignment_width_for_code = sqlCaseUtils.get_alignment_width_for_code;
```

- [ ] **Step 7: Confirm compatibility exports remain unchanged**

At the bottom of `lib/core/sql-comment-formatter.js`, the exports must still be:

```js
exports.protect_standalone_comments = protect_standalone_comments;
exports.protect_inline_comments = protect_inline_comments;
exports.restore_comments = restore_comments;
exports.get_first_comment_loc = get_first_comment_loc;
exports.normalize_line_comment_spacing = normalize_line_comment_spacing;
exports.order_comment = order_comment;
exports.apply_comment_alignment_mutations = apply_comment_alignment_mutations;
exports.split_code_and_comment = split_code_and_comment;
```

- [ ] **Step 8: Verify the extraction was mechanical**

Run this before committing the extraction:

```bash
node - <<'NODE'
var assert = require('assert');
var fs = require('fs');
var child_process = require('child_process');
var oldSource = child_process.execFileSync('git', ['show', 'HEAD:lib/core/sql-comment-formatter.js'], { encoding: 'utf8' });
var newSource = fs.readFileSync('lib/core/sql-comment-mutations.js', 'utf8');

function extract(source, startNeedle, endNeedle) {
	var start = source.indexOf(startNeedle);
	var end = source.indexOf(endNeedle, start);
	assert.ok(start >= 0, 'start missing: ' + startNeedle);
	assert.ok(end > start, 'end missing: ' + endNeedle);
	return source.slice(start, end).replace(/\s+$/g, '');
}

var oldBlock = extract(oldSource, 'function apply_comment_alignment_mutations', '\nexports.protect_standalone_comments');
var newBlock = extract(newSource, 'function apply_comment_alignment_mutations', '\nexports.apply_comment_alignment_mutations');
assert.strictEqual(newBlock, oldBlock);
console.log('structured comment mutation body matches previous formatter block');
NODE
```

Expected:

```text
structured comment mutation body matches previous formatter block
```

If this fails, inspect the diff. Only import/export wiring and the facade delegate should differ from the old structured function body.

- [ ] **Step 9: Run syntax and targeted tests**

Run:

```bash
node -c lib/core/sql-comment-formatter.js
node -c lib/core/sql-comment-mutations.js
node tests/module-boundary.test.js
node tests/comment-alignment.test.js
node tests/structured-pipeline-regression.test.js
node tests/select-alignment.test.js
node tests/case-when.test.js
node tests/condition-alignment.test.js
```

Expected: all commands pass. Any formatter output difference is a regression unless it is separately approved.

- [ ] **Step 10: Inspect the split shape**

Run:

```bash
wc -l lib/core/sql-comment-formatter.js lib/core/sql-comment-mutations.js
rg -n "^function apply_comment_alignment_mutations|^exports\\.|require\\('./sql-comment-mutations'\\)" lib/core/sql-comment-formatter.js lib/core/sql-comment-mutations.js
rg -n "\\bsqlFormatMutations\\b" lib/core/sql-comment-formatter.js
rg -n "function\\s+previous_code_token\\s*\\(" lib/core/sql-comment-mutations.js
```

Expected:

```text
sql-comment-formatter.js requires './sql-comment-mutations'.
sql-comment-formatter.js still exports the same compatibility API.
sql-comment-mutations.js exports only apply_comment_alignment_mutations.
sqlFormatMutations is absent from sql-comment-formatter.js.
previous_code_token remains local to sql-comment-mutations.js for this mechanical split.
```

- [ ] **Step 11: Commit the structured comment mutation extraction**

Run:

```bash
git add lib/core/sql-comment-formatter.js lib/core/sql-comment-mutations.js tests/module-boundary.test.js
git commit -m "refactor: extract structured comment mutations"
```

Expected: commit succeeds.

---

### Task 4: Verify Comment Compatibility Surface

**Files:**
- Verify: `lib/core/sql-comment-formatter.js`
- Verify: `lib/core/sql-comment-mutations.js`
- Verify: `tests/module-boundary.test.js`
- Verify: `tests/comment-alignment.test.js`

- [ ] **Step 1: Confirm legacy exports still exist**

Run:

```bash
node - <<'NODE'
var assert = require('assert');
var commentFormatter = require('./lib/core/sql-comment-formatter');
[
	'protect_standalone_comments',
	'protect_inline_comments',
	'restore_comments',
	'get_first_comment_loc',
	'normalize_line_comment_spacing',
	'order_comment',
	'apply_comment_alignment_mutations',
	'split_code_and_comment'
].forEach(function(name) {
	assert.strictEqual(typeof commentFormatter[name], 'function', name + ' must remain exported');
});
console.log('comment formatter compatibility exports passed');
NODE
```

Expected:

```text
comment formatter compatibility exports passed
```

- [ ] **Step 2: Confirm focused mutation modules have narrow export surfaces**

Run:

```bash
node - <<'NODE'
var assert = require('assert');
var selectMutations = require('./lib/core/sql-select-mutations');
var caseMutations = require('./lib/core/sql-case-mutations');
var commentMutations = require('./lib/core/sql-comment-mutations');
assert.deepStrictEqual(Object.keys(selectMutations).sort(), ['apply_select_list_mutations']);
assert.deepStrictEqual(Object.keys(caseMutations).sort(), ['apply_case_mutations']);
assert.deepStrictEqual(Object.keys(commentMutations).sort(), ['apply_comment_alignment_mutations']);
console.log('mutation module export surfaces passed');
NODE
```

Expected:

```text
mutation module export surfaces passed
```

- [ ] **Step 3: Confirm the default formatter does not call legacy comment string functions**

Run:

```bash
node tests/module-boundary.test.js
```

Expected: pass. This test includes guards for `order_comment` not being called by the default structured formatter path.

- [ ] **Step 4: Run comment compatibility regressions**

Run:

```bash
node tests/comment-alignment.test.js
node tests/layout-marker-leakage.test.js
node tests/token-boundary.test.js
node tests/formatter-api.test.js
node tests/canonical-core-boundary.test.js
```

Expected: all pass. The comment alignment test protects the moved structured path; marker, token, formatter API, and canonical boundary tests catch accidental compatibility or protection regressions.

- [ ] **Step 5: Commit only if verification required cleanup changes**

If Task 4 produced no file changes, do not create a commit.

If you made cleanup changes, run:

```bash
node tests/module-boundary.test.js
node tests/comment-alignment.test.js
git add lib/core/sql-comment-formatter.js lib/core/sql-comment-mutations.js tests/module-boundary.test.js
git commit -m "test: guard structured comment mutation facade"
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
Changes are limited to lib/core/sql-comment-formatter.js, lib/core/sql-comment-mutations.js, and tests/module-boundary.test.js unless Task 4 required a small test cleanup.
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
wc -l lib/core/sql-comment-formatter.js lib/core/sql-comment-mutations.js
rg -n "^function |^\\s+function |^exports\\." lib/core/sql-comment-formatter.js lib/core/sql-comment-mutations.js
```

Expected:

```text
sql-comment-formatter.js is smaller and contains compatibility/string-level comment functions plus the facade delegate.
sql-comment-mutations.js contains the structured comment alignment mutation helper family and exports only apply_comment_alignment_mutations.
```

---

## Implementation Notes

- This is a behavior-preserving refactor. Treat every output difference as a regression.
- Move function bodies mechanically first. Avoid renaming helpers or changing comment alignment logic during the extraction.
- Keep the new module inside `lib/core/`.
- Keep `sql-formatter.js` unchanged in this pass; it should continue to call the `sql-comment-formatter.js` facade.
- Do not add `sql-comment-mutations.js` to navigation-helper ban arrays in this pass.
- Keep CommonJS `var` style, semicolons, and the project’s existing formatting style.
- Do not run `npm run package:vsix`; packaging is not part of this refactor.
- Do not mix in pure indentation cleanup for migrated code. Existing odd indentation can be handled in a separate no-behavior cleanup after this split is stable.

## Completion Criteria

- `lib/core/sql-comment-mutations.js` exists and exports only `apply_comment_alignment_mutations`.
- `lib/core/sql-comment-formatter.js` still exports the existing compatibility API.
- `apply_comment_alignment_mutations()` in the facade delegates to `sql-comment-mutations.js`.
- `tests/module-boundary.test.js` guards the new module, facade delegation, and exact mutation module export surfaces.
- `npm run test:verify` passes.
