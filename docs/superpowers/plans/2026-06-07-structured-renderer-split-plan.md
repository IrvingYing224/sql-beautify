# Structured Renderer Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the structured SQL renderer into focused internal core modules while preserving the existing `sqlStructuredRenderer.render(document, nodes, mutations, options)` public boundary and formatter output.

**Architecture:** Keep `lib/core/sql-structured-renderer.js` as a thin orchestrator and move render-time state, indentation, token spacing, and line assembly into `lib/core/sql-render-*.js` modules. The dependency direction should be one-way: orchestrator imports helpers; line rendering imports token spacing; indentation and move-state do not import line rendering.

**Tech Stack:** CommonJS JavaScript, Node.js assertion-based tests, existing SQL formatter regression suite.

---

## File Structure

- Create: `lib/core/sql-render-move-state.js`
  - Owns mutation-derived render state: moved separators, omitted tokens, moved line comments, removed token ids, prefixes by line.
- Create: `lib/core/sql-render-indent.js`
  - Owns effective token/scope indentation derivation and indentation transforms.
- Create: `lib/core/sql-render-token-spacing.js`
  - Owns visible token values and SQL token append/spacing rules.
- Create: `lib/core/sql-render-line.js`
  - Owns rendering one physical line, moved comment placement, comment alignment, line joins, and final whitespace normalization.
- Modify: `lib/core/sql-structured-renderer.js`
  - Keep only orchestration and `exports.render = render`.
- Modify: `tests/module-boundary.test.js`
  - Teach the boundary test about new renderer helper modules and assert the orchestrator no longer defines moved helper functions.

Do not modify root `lib/*.js` shims. Do not modify `lib/adapters/`. Do not modify `lib/experimental/ddl/`.

---

### Task 1: Establish Baseline

**Files:**
- Read: `lib/core/sql-structured-renderer.js`
- Read: `docs/superpowers/specs/2026-06-07-structured-renderer-split-design.md`
- Read: `docs/technical/sql-formatter-architecture.md`

- [ ] **Step 1: Confirm the worktree is clean**

Run:

```bash
git status --short
```

Expected: no output. If there are unrelated changes, do not revert them; stop and inspect before continuing.

- [ ] **Step 2: Run targeted baseline tests**

Run:

```bash
node tests/module-boundary.test.js
node tests/structured-pipeline-regression.test.js
node tests/pipeline-idempotency.test.js
node tests/window-function-spacing.test.js
```

Expected: all commands pass. If a baseline test fails before edits, investigate that failure first and do not start the split.

- [ ] **Step 3: Record the current renderer function map**

Run:

```bash
rg -n "^function |^exports\\." lib/core/sql-structured-renderer.js
```

Expected: output includes these function definitions before the split:

```text
build_move_state
build_close_indent_by_line
append_visible_token
render_line_from_tokens
normalize_output_whitespace
render
exports.render = render
```

This is a sanity check for the line ranges used in later tasks.

---

### Task 2: Extract Render Move State

**Files:**
- Create: `lib/core/sql-render-move-state.js`
- Modify: `lib/core/sql-structured-renderer.js`

- [ ] **Step 1: Create the move-state module**

Create `lib/core/sql-render-move-state.js` by moving these functions verbatim from `lib/core/sql-structured-renderer.js`:

```text
build_separator_lookup
build_move_state
```

The new file must contain the actual existing function bodies, not stubs. After moving the functions, the bottom of the file should be:

```js
exports.build_move_state = build_move_state;
```

Do not add dependencies. This module should consume only `nodes` and `mutations`.

- [ ] **Step 2: Wire the orchestrator to the new module**

In `lib/core/sql-structured-renderer.js`, add:

```js
var sqlRenderMoveState = require('./sql-render-move-state');
```

Remove the local `build_separator_lookup` and `build_move_state` function definitions.

Change the render function from:

```js
var moveState = build_move_state(nodes || {}, plan);
```

to:

```js
var moveState = sqlRenderMoveState.build_move_state(nodes || {}, plan);
```

- [ ] **Step 3: Run targeted tests**

Run:

```bash
node tests/structured-pipeline-regression.test.js
node tests/pipeline-idempotency.test.js
```

Expected: both pass. Any output change after this task is suspicious because move-state code should be a mechanical relocation.

- [ ] **Step 4: Commit the move-state extraction**

Run:

```bash
git add lib/core/sql-render-move-state.js lib/core/sql-structured-renderer.js
git commit -m "refactor: extract structured render move state"
```

Expected: commit succeeds.

---

### Task 3: Extract Render Indentation

**Files:**
- Create: `lib/core/sql-render-indent.js`
- Modify: `lib/core/sql-structured-renderer.js`

- [ ] **Step 1: Create the indentation module**

Create `lib/core/sql-render-indent.js` with these imports:

```js
var sqlFormatMutations = require('./sql-format-mutations');
var sqlFormatNavigation = require('./sql-format-navigation');
```

Move these functions verbatim from `lib/core/sql-structured-renderer.js`:

```text
line_prefix_indent
effective_token_indent
suffix_after_prefix
effective_scope_start_indent
effective_scope_body_indent
effective_scope_close_indent
build_close_indent_by_line
build_body_indent_by_line
apply_scope_close_indent
apply_scope_body_indent
apply_indent
apply_line_prefix
```

Export only the functions used by the orchestrator:

```js
exports.build_close_indent_by_line = build_close_indent_by_line;
exports.build_body_indent_by_line = build_body_indent_by_line;
exports.apply_scope_close_indent = apply_scope_close_indent;
exports.apply_scope_body_indent = apply_scope_body_indent;
exports.apply_indent = apply_indent;
exports.apply_line_prefix = apply_line_prefix;
```

- [ ] **Step 2: Wire the orchestrator to the indentation module**

In `lib/core/sql-structured-renderer.js`, add:

```js
var sqlRenderIndent = require('./sql-render-indent');
```

Remove the moved local indentation functions.

Change these calls:

```js
var closeIndentByLine = build_close_indent_by_line(document, plan, moveState);
var bodyIndentByLine = build_body_indent_by_line(document, plan, moveState);
rendered = apply_scope_body_indent(rendered, bodyIndentByLine[String(i)]);
rendered = apply_scope_close_indent(rendered, closeIndentByLine[String(i)]);
rendered = apply_indent(rendered, lineMutations.indent);
rendered = apply_line_prefix(rendered, moveState.prefixesByLine[String(i)]);
```

to:

```js
var closeIndentByLine = sqlRenderIndent.build_close_indent_by_line(document, plan, moveState);
var bodyIndentByLine = sqlRenderIndent.build_body_indent_by_line(document, plan, moveState);
rendered = sqlRenderIndent.apply_scope_body_indent(rendered, bodyIndentByLine[String(i)]);
rendered = sqlRenderIndent.apply_scope_close_indent(rendered, closeIndentByLine[String(i)]);
rendered = sqlRenderIndent.apply_indent(rendered, lineMutations.indent);
rendered = sqlRenderIndent.apply_line_prefix(rendered, moveState.prefixesByLine[String(i)]);
```

- [ ] **Step 3: Run indentation-sensitive tests**

Run:

```bash
node tests/structured-pipeline-regression.test.js
node tests/condition-alignment.test.js
node tests/hive-regression.test.js
node tests/pipeline-idempotency.test.js
```

Expected: all pass. Failures involving close parens, IN-lists, nested queries, or condition blocks belong to this task.

- [ ] **Step 4: Commit the indentation extraction**

Run:

```bash
git add lib/core/sql-render-indent.js lib/core/sql-structured-renderer.js
git commit -m "refactor: extract structured render indentation"
```

Expected: commit succeeds.

---

### Task 4: Extract Token Spacing

**Files:**
- Create: `lib/core/sql-render-token-spacing.js`
- Modify: `lib/core/sql-structured-renderer.js`

- [ ] **Step 1: Create the token spacing module**

Create `lib/core/sql-render-token-spacing.js` with these imports:

```js
var sqlFormatNavigation = require('./sql-format-navigation');
var sqlOperatorRegistry = require('./sql-operator-registry');
```

Move these functions verbatim from `lib/core/sql-structured-renderer.js`:

```text
token_value
is_comparison_with_unary_sign
is_arithmetic_with_unary_sign
is_unary_sign_token
is_word_token
operator_spacing
previous_operator_has_no_spacing
trim_trailing_space
original_gap_between
normalized_original_space
token_inside_scope_kind
token_inside_inline_query
token_opens_inline_query
owner_function_scope
token_inside_function_named
token_inside_grouping_sets
follows_grouping_sets_keyword
should_preserve_grouping_sets_gap
follows_window_order_by
follows_group_by
token_in_token_list
token_in_case_value
is_originally_compact_case_function_plus
follows_originally_compact_case_function_plus
should_keep_original_comma_gap
follows_lateral_view_alias_comma
should_compact_open_bracket
should_add_comma_gap
append_visible_token
```

Export only:

```js
exports.token_value = token_value;
exports.append_visible_token = append_visible_token;
```

Keep every other predicate private.

- [ ] **Step 2: Leave temporary local line helpers in the orchestrator**

At this stage, keep these functions in `lib/core/sql-structured-renderer.js` because `render_line_from_tokens()` still lives there:

```text
dialect_name
first_visible_token
line_starts_with_group_by
trim_trailing_space
```

If `trim_trailing_space` was moved to the spacing module, keep a local copy in the renderer for line rendering and `append_joined_line()` until Task 5. The local copy must be exactly:

```js
function trim_trailing_space(text) {
	return String(text || '').replace(/[ \t]+$/g, '');
}
```

- [ ] **Step 3: Wire token rendering calls to the spacing module**

In `lib/core/sql-structured-renderer.js`, add:

```js
var sqlRenderTokenSpacing = require('./sql-render-token-spacing');
```

Change the `render_line_from_tokens()` append call from:

```js
output = append_visible_token(
	output,
	document,
	token,
	token_value(token, tokenMutation),
	previousToken,
	dialect,
	groupByLine
);
```

to:

```js
output = sqlRenderTokenSpacing.append_visible_token(
	output,
	document,
	token,
	sqlRenderTokenSpacing.token_value(token, tokenMutation),
	previousToken,
	dialect,
	groupByLine
);
```

Remove the moved token spacing function definitions from the orchestrator.

- [ ] **Step 4: Run spacing-sensitive tests**

Run:

```bash
node tests/window-function-spacing.test.js
node tests/operator-matrix.test.js
node tests/structured-pipeline-regression.test.js
node tests/case-when.test.js
node tests/hive-regression.test.js
node tests/pipeline-idempotency.test.js
```

Expected: all pass. Failures involving operators, `GROUP BY`, window `ORDER BY`, `GROUPING SETS`, CASE function values, or Hive `LATERAL VIEW` belong to this task.

- [ ] **Step 5: Commit the token spacing extraction**

Run:

```bash
git add lib/core/sql-render-token-spacing.js lib/core/sql-structured-renderer.js
git commit -m "refactor: extract structured render token spacing"
```

Expected: commit succeeds.

---

### Task 5: Extract Line Rendering

**Files:**
- Create: `lib/core/sql-render-line.js`
- Modify: `lib/core/sql-structured-renderer.js`

- [ ] **Step 1: Create the line rendering module**

Create `lib/core/sql-render-line.js` with these imports:

```js
var sqlFormatMutations = require('./sql-format-mutations');
var sqlLineModel = require('./sql-line-model');
var sqlRenderTokenSpacing = require('./sql-render-token-spacing');
```

Move these functions from `lib/core/sql-structured-renderer.js`:

```text
dialect_name
first_visible_token
line_starts_with_group_by
render_line_from_tokens
apply_comment_alignment_to_single_line
apply_comment_alignment
normalize_output_whitespace
append_joined_line
```

Also add these private helpers to `sql-render-line.js` if they are no longer local after Task 4:

```js
function trim_trailing_space(text) {
	return String(text || '').replace(/[ \t]+$/g, '');
}

function is_word_token(token, value) {
	if (!token || token.type != 'word') {
		return false;
	}
	if (typeof value == 'undefined') {
		return true;
	}
	return token.value.toUpperCase() == value;
}
```

Inside `render_line_from_tokens()`, use the spacing module:

```js
output = sqlRenderTokenSpacing.append_visible_token(
	output,
	document,
	token,
	sqlRenderTokenSpacing.token_value(token, tokenMutation),
	previousToken,
	dialect,
	groupByLine
);
```

Export only:

```js
exports.render_line_from_tokens = render_line_from_tokens;
exports.apply_comment_alignment = apply_comment_alignment;
exports.append_joined_line = append_joined_line;
exports.normalize_output_whitespace = normalize_output_whitespace;
```

- [ ] **Step 2: Wire the orchestrator to line rendering**

In `lib/core/sql-structured-renderer.js`, add:

```js
var sqlRenderLine = require('./sql-render-line');
```

Remove the moved line rendering, comment alignment, join, and whitespace functions from the orchestrator.

Change these calls:

```js
var rendered = render_line_from_tokens(document, line, plan, moveState, options);
rendered = apply_comment_alignment(rendered, lineMutations.commentAlignment);
append_joined_line(lines, rendered, lineMutations.lineJoin);
return normalize_output_whitespace(lines.join('\n'));
```

to:

```js
var rendered = sqlRenderLine.render_line_from_tokens(document, line, plan, moveState, options);
rendered = sqlRenderLine.apply_comment_alignment(rendered, lineMutations.commentAlignment);
sqlRenderLine.append_joined_line(lines, rendered, lineMutations.lineJoin);
return sqlRenderLine.normalize_output_whitespace(lines.join('\n'));
```

- [ ] **Step 3: Run line/comment-sensitive tests**

Run:

```bash
node tests/comment-alignment.test.js
node tests/structured-pipeline-regression.test.js
node tests/pipeline-idempotency.test.js
node tests/layout-marker-leakage.test.js
```

Expected: all pass. Failures involving moved comments, trailing comments, line joins, blank lines, or final newline belong to this task.

- [ ] **Step 4: Commit the line rendering extraction**

Run:

```bash
git add lib/core/sql-render-line.js lib/core/sql-structured-renderer.js
git commit -m "refactor: extract structured render line assembly"
```

Expected: commit succeeds.

---

### Task 6: Harden Module Boundaries And Thin Orchestrator

**Files:**
- Modify: `lib/core/sql-structured-renderer.js`
- Modify: `tests/module-boundary.test.js`

- [ ] **Step 1: Confirm the orchestrator only imports helper modules and exports render**

After Tasks 2-5, `lib/core/sql-structured-renderer.js` should have this dependency shape:

```js
var sqlFormatMutations = require('./sql-format-mutations');
var sqlRenderMoveState = require('./sql-render-move-state');
var sqlRenderIndent = require('./sql-render-indent');
var sqlRenderLine = require('./sql-render-line');
```

The file should still end with:

```js
exports.render = render;
```

Do not import `sql-line-model`, `sql-operator-registry`, or `sql-format-navigation` directly from the orchestrator after the split.

- [ ] **Step 2: Add boundary coverage for new renderer modules**

In `tests/module-boundary.test.js`, after the existing assertion that `lib/core/sql-format-navigation.js` exists, add:

```js
[
	'lib/core/sql-render-move-state.js',
	'lib/core/sql-render-indent.js',
	'lib/core/sql-render-token-spacing.js',
	'lib/core/sql-render-line.js'
].forEach(function(relativePath) {
	assert.ok(
		fs.existsSync(path.join(__dirname, '..', relativePath)),
		'structured renderer split module must exist: ' + relativePath
	);
});
```

Extend the existing navigation-helper check array from:

```js
[
	'lib/core/sql-structured-renderer.js',
	'lib/core/sql-layout-formatter.js',
	'lib/core/sql-case-formatter.js',
	'lib/core/sql-condition-formatter.js',
	'lib/core/sql-format-nodes.js'
].forEach(function(relativePath) {
```

to:

```js
[
	'lib/core/sql-structured-renderer.js',
	'lib/core/sql-render-indent.js',
	'lib/core/sql-render-token-spacing.js',
	'lib/core/sql-layout-formatter.js',
	'lib/core/sql-case-formatter.js',
	'lib/core/sql-condition-formatter.js',
	'lib/core/sql-format-nodes.js'
].forEach(function(relativePath) {
```

Extend the existing `scope_by_id` check array from:

```js
[
	'lib/core/sql-structured-renderer.js',
	'lib/core/sql-case-formatter.js',
	'lib/core/sql-condition-formatter.js',
	'lib/core/sql-format-nodes.js'
].forEach(function(relativePath) {
```

to:

```js
[
	'lib/core/sql-structured-renderer.js',
	'lib/core/sql-render-indent.js',
	'lib/core/sql-render-token-spacing.js',
	'lib/core/sql-case-formatter.js',
	'lib/core/sql-condition-formatter.js',
	'lib/core/sql-format-nodes.js'
].forEach(function(relativePath) {
```

- [ ] **Step 3: Add an explicit thin-orchestrator assertion**

In `tests/module-boundary.test.js`, near the other structured renderer assertions, add:

```js
var structuredRendererSource = read_source('lib/core/sql-structured-renderer.js');
[
	'build_move_state',
	'build_close_indent_by_line',
	'build_body_indent_by_line',
	'append_visible_token',
	'render_line_from_tokens',
	'apply_comment_alignment',
	'normalize_output_whitespace'
].forEach(function(functionName) {
	assert.strictEqual(
		new RegExp('function\\s+' + functionName + '\\s*\\(').test(structuredRendererSource),
		false,
		'sql-structured-renderer.js must delegate helper implementation: ' + functionName
	);
});
```

- [ ] **Step 4: Run module boundary tests**

Run:

```bash
node tests/module-boundary.test.js
```

Expected: pass. If it fails because one of the new modules defines local `token_by_index`, `previous_code_token`, `next_code_token`, `active_tokens`, or `scope_by_id`, replace that local helper with `sql-format-navigation`.

- [ ] **Step 5: Commit boundary hardening**

Run:

```bash
git add lib/core/sql-structured-renderer.js tests/module-boundary.test.js
git commit -m "test: guard structured renderer split boundaries"
```

Expected: commit succeeds.

---

### Task 7: Full Verification

**Files:**
- Verify: formatter source and tests only

- [ ] **Step 1: Run the full verification suite**

Run:

```bash
npm run test:verify
```

Expected: all tests pass, including performance smoke under the existing threshold.

- [ ] **Step 2: Inspect the final renderer shape**

Run:

```bash
wc -l lib/core/sql-structured-renderer.js lib/core/sql-render-move-state.js lib/core/sql-render-indent.js lib/core/sql-render-token-spacing.js lib/core/sql-render-line.js
rg -n "^function |^exports\\." lib/core/sql-structured-renderer.js lib/core/sql-render-*.js
git diff --stat HEAD~5..HEAD
```

Expected:

```text
lib/core/sql-structured-renderer.js contains render and exports.render only, plus imports.
lib/core/sql-render-move-state.js exports build_move_state.
lib/core/sql-render-indent.js exports indentation lookup and transform functions.
lib/core/sql-render-token-spacing.js exports token_value and append_visible_token.
lib/core/sql-render-line.js exports line rendering, comment alignment, line join, and final whitespace functions.
```

- [ ] **Step 3: Confirm no generated artifacts were added**

Run:

```bash
git status --short
rg -n "\\.vsix$|vscode-sql-beautify-v.*\\.vsix" .
```

Expected: no uncommitted generated `.vsix` artifact is present. If `rg` finds only documentation references, no action is needed.

- [ ] **Step 4: Commit any verification-only cleanup**

If Task 7 produced only passing verification and no file changes, do not create a commit.

If you made small cleanup changes after verification, run:

```bash
npm run test:verify
git add lib/core tests
git commit -m "refactor: finalize structured renderer split"
```

Expected: commit succeeds only if there were actual cleanup changes.

---

## Implementation Notes

- Treat every output difference as a regression until proven otherwise.
- Move helper bodies mechanically first; do naming cleanup only after the moved tests pass.
- Keep new modules inside `lib/core/`.
- Keep CommonJS `var` style, 4-space tab-equivalent indentation, and semicolons consistent with the existing project.
- Do not introduce a shared render utility module unless a real circular dependency appears. A private one-line `trim_trailing_space()` duplicate in line rendering is acceptable for this split.
- Do not run `npm run package:vsix`; packaging is not part of this refactor.

## Completion Criteria

- Four new focused renderer helper modules exist under `lib/core/`.
- `sql-structured-renderer.js` remains the only renderer module imported by `sql-formatter.js`.
- `tests/module-boundary.test.js` guards the new renderer split.
- `npm run test:verify` passes.
- Each implementation task is committed separately with focused commit messages.
