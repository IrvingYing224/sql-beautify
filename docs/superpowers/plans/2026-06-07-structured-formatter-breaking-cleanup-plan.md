# Structured Formatter Breaking Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove obsolete string-level formatter facades and make the default structured SQL formatter depend directly on focused mutation modules.

**Architecture:** The live formatter path will import `sql-select-mutations`, `sql-case-mutations`, `sql-condition-mutations`, and `sql-comment-mutations` directly. Condition mutation logic and live comment spacing will move into focused modules, then the obsolete formatter facade files and their root shims will be deleted. Tests will change from preserving compatibility exports to enforcing that the old APIs are gone.

**Tech Stack:** CommonJS JavaScript, Node.js built-in `assert`, existing SQL formatter core under `lib/core/`, existing CLI regression tests under `tests/`, local `@vscode/vsce` packaging via `npm run package:vsix`.

---

## File Structure

Create:

- `lib/core/sql-condition-mutations.js`: structured condition mutation pass only; exports `apply_condition_mutations`.
- `lib/core/sql-comment-spacing.js`: live post-render line-comment spacing normalization only; exports `normalize_line_comment_spacing`.

Modify:

- `lib/core/sql-formatter.js`: import focused mutation modules and comment spacing directly; stop importing obsolete formatter facades.
- `tests/module-boundary.test.js`: remove compatibility-export assertions; add direct mutation module assertions, deleted-file assertions, and live graph guards.
- `tests/structured-pipeline-regression.test.js`: require focused mutation modules instead of obsolete formatter facades.

Delete:

- `lib/core/sql-select-formatter.js`
- `lib/core/sql-case-formatter.js`
- `lib/core/sql-comment-formatter.js`
- `lib/core/sql-condition-formatter.js`
- `lib/sql-select-formatter.js`
- `lib/sql-case-formatter.js`
- `lib/sql-comment-formatter.js`
- `lib/sql-condition-formatter.js`

Do not modify:

- `lib/adapters/`
- `lib/experimental/ddl/`
- root shims other than the four obsolete formatter shims listed above
- `.vsix` files, except that `npm run package:vsix` may create an ignored local artifact for inspection

## Task 1: Baseline Current Behavior

**Files:**
- Read: `docs/superpowers/specs/2026-06-07-structured-formatter-breaking-cleanup-design.md`
- Read: `lib/core/sql-formatter.js`
- Read: `lib/core/sql-condition-formatter.js`
- Read: `lib/core/sql-comment-formatter.js`
- Test: existing regression tests

- [ ] **Step 1: Confirm worktree and current branch**

Run:

```bash
git status --short --branch
```

Expected: current branch is `codex/structured-formatter-pipeline-plan`; no unstaged or untracked implementation files except work intentionally created by this plan.

- [ ] **Step 2: Read the approved spec**

Run:

```bash
sed -n '1,260p' docs/superpowers/specs/2026-06-07-structured-formatter-breaking-cleanup-design.md
```

Expected: the spec says this is a breaking cleanup, deletes obsolete formatter facades/root shims, and keeps active entry points such as `lib/sql-formatter.js`.

- [ ] **Step 3: Run baseline targeted tests**

Run:

```bash
node tests/module-boundary.test.js
node tests/structured-pipeline-regression.test.js
node tests/comment-alignment.test.js
node tests/case-when.test.js
node tests/select-alignment.test.js
node tests/condition-alignment.test.js
```

Expected: all commands pass before any implementation edit. If any command fails, stop and investigate the existing failure before editing.

- [ ] **Step 4: Commit baseline status only if local changes already exist**

Run:

```bash
git status --short
```

Expected: no new commit is needed for a clean baseline. If unrelated user changes exist, do not revert them; note them before continuing.

## Task 2: Update Boundary Tests To Express The Breaking Cleanup

**Files:**
- Modify: `tests/module-boundary.test.js`
- Modify: `tests/structured-pipeline-regression.test.js`
- Test: `tests/module-boundary.test.js`
- Test: `tests/structured-pipeline-regression.test.js`

- [ ] **Step 1: Change structured pipeline export checks to focused mutation modules**

In `tests/structured-pipeline-regression.test.js`, replace the four obsolete formatter facade imports:

```js
var sqlSelectFormatter = require('../lib/core/sql-select-formatter');
var sqlCaseFormatter = require('../lib/core/sql-case-formatter');
var sqlConditionFormatter = require('../lib/core/sql-condition-formatter');
var sqlCommentFormatter = require('../lib/core/sql-comment-formatter');
```

with:

```js
var sqlSelectMutations = require('../lib/core/sql-select-mutations');
var sqlCaseMutations = require('../lib/core/sql-case-mutations');
var sqlConditionMutations = require('../lib/core/sql-condition-mutations');
var sqlCommentMutations = require('../lib/core/sql-comment-mutations');
```

Replace the export assertions:

```js
assert.strictEqual(
	typeof sqlSelectFormatter.apply_select_list_mutations,
	'function',
	'structured SELECT pass must expose apply_select_list_mutations'
);
assert.strictEqual(
	typeof sqlCaseFormatter.apply_case_mutations,
	'function',
	'structured CASE pass must expose apply_case_mutations'
);
assert.strictEqual(
	typeof sqlCaseFormatter.render_case_node,
	'function',
	'structured CASE pass must expose render_case_node'
);
assert.strictEqual(
	typeof sqlConditionFormatter.apply_condition_mutations,
	'function',
	'structured condition pass must expose apply_condition_mutations'
);
assert.strictEqual(
	typeof sqlCommentFormatter.apply_comment_alignment_mutations,
	'function',
	'structured comment pass must expose apply_comment_alignment_mutations'
);
```

with:

```js
assert.strictEqual(
	typeof sqlSelectMutations.apply_select_list_mutations,
	'function',
	'structured SELECT mutation module must expose apply_select_list_mutations'
);
assert.strictEqual(
	typeof sqlCaseMutations.apply_case_mutations,
	'function',
	'structured CASE mutation module must expose apply_case_mutations'
);
assert.strictEqual(
	typeof sqlConditionMutations.apply_condition_mutations,
	'function',
	'structured condition mutation module must expose apply_condition_mutations'
);
assert.strictEqual(
	typeof sqlCommentMutations.apply_comment_alignment_mutations,
	'function',
	'structured comment mutation module must expose apply_comment_alignment_mutations'
);
```

- [ ] **Step 2: Change module-boundary imports to focused modules**

In `tests/module-boundary.test.js`, remove these imports:

```js
var sqlCommentFormatter = require('../lib/sql-comment-formatter');
var sqlCaseFormatter = require('../lib/sql-case-formatter');
var sqlSelectFormatter = require('../lib/sql-select-formatter');
var sqlConditionFormatter = require('../lib/sql-condition-formatter');
```

Keep existing mutation imports and add condition/comment spacing imports:

```js
var sqlSelectMutations = require('../lib/core/sql-select-mutations');
var sqlCaseMutations = require('../lib/core/sql-case-mutations');
var sqlCommentMutations = require('../lib/core/sql-comment-mutations');
var sqlConditionMutations = require('../lib/core/sql-condition-mutations');
var sqlCommentSpacing = require('../lib/core/sql-comment-spacing');
```

- [ ] **Step 3: Replace compatibility export assertions with exact live exports**

In `tests/module-boundary.test.js`, remove assertions for obsolete formatter exports:

```js
assert.strictEqual(typeof sqlCommentFormatter.normalize_line_comment_spacing, 'function', 'comment formatter must export normalize_line_comment_spacing');
assert.strictEqual(typeof sqlCommentFormatter.apply_comment_alignment_mutations, 'function', 'comment formatter must export apply_comment_alignment_mutations');
assert.strictEqual(typeof sqlCaseFormatter.format_case_blocks, 'function', 'case formatter must export format_case_blocks');
assert.strictEqual(typeof sqlCaseFormatter.apply_case_mutations, 'function', 'case formatter must export apply_case_mutations');
assert.strictEqual(typeof sqlCaseFormatter.render_case_node, 'function', 'case formatter must export render_case_node');
assert.strictEqual(typeof sqlSelectFormatter.format_select_clause_lists, 'function', 'select formatter must export format_select_clause_lists');
assert.strictEqual(typeof sqlSelectFormatter.align_as_in_select_blocks, 'function', 'select formatter must export align_as_in_select_blocks');
assert.strictEqual(typeof sqlConditionFormatter.wrap_condition_clauses, 'function', 'condition formatter must export wrap_condition_clauses');
assert.strictEqual(typeof sqlConditionFormatter.align_condition_clauses, 'function', 'condition formatter must export align_condition_clauses');
```

Add these assertions after the existing `format_sql` assertion:

```js
assert.strictEqual(typeof sqlSelectMutations.apply_select_list_mutations, 'function', 'structured select mutations must export apply_select_list_mutations');
assert.strictEqual(typeof sqlCaseMutations.apply_case_mutations, 'function', 'structured case mutations must export apply_case_mutations');
assert.strictEqual(typeof sqlCommentMutations.apply_comment_alignment_mutations, 'function', 'structured comment mutations must export apply_comment_alignment_mutations');
assert.strictEqual(typeof sqlConditionMutations.apply_condition_mutations, 'function', 'structured condition mutations must export apply_condition_mutations');
assert.strictEqual(typeof sqlCommentSpacing.normalize_line_comment_spacing, 'function', 'comment spacing module must export normalize_line_comment_spacing');
```

Add exact export-surface assertions:

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
assert.deepStrictEqual(
	Object.keys(sqlConditionMutations).sort(),
	['apply_condition_mutations'],
	'structured condition mutations must expose only apply_condition_mutations'
);
assert.deepStrictEqual(
	Object.keys(sqlCommentSpacing).sort(),
	['normalize_line_comment_spacing'],
	'comment spacing module must expose only normalize_line_comment_spacing'
);
```

- [ ] **Step 4: Add deleted-file boundary assertions**

In `tests/module-boundary.test.js`, after the renderer/mutation existence assertions, add:

```js
[
	'lib/core/sql-select-formatter.js',
	'lib/core/sql-case-formatter.js',
	'lib/core/sql-comment-formatter.js',
	'lib/core/sql-condition-formatter.js',
	'lib/sql-select-formatter.js',
	'lib/sql-case-formatter.js',
	'lib/sql-comment-formatter.js',
	'lib/sql-condition-formatter.js'
].forEach(function(relativePath) {
	assert.strictEqual(
		fs.existsSync(path.join(__dirname, '..', relativePath)),
		false,
		'obsolete formatter facade must not exist: ' + relativePath
	);
});
```

Also add existence checks for new modules:

```js
assert.ok(
	fs.existsSync(path.join(__dirname, '..', 'lib/core/sql-condition-mutations.js')),
	'structured condition mutation module must exist'
);
assert.ok(
	fs.existsSync(path.join(__dirname, '..', 'lib/core/sql-comment-spacing.js')),
	'comment spacing module must exist'
);
```

- [ ] **Step 5: Update navigation-helper guard file lists**

In `tests/module-boundary.test.js`, replace `lib/core/sql-case-formatter.js` and `lib/core/sql-condition-formatter.js` in both helper-ban arrays with `lib/core/sql-condition-mutations.js`.

For the token/navigation helper ban array, use:

```js
[
	'lib/core/sql-structured-renderer.js',
	'lib/core/sql-render-indent.js',
	'lib/core/sql-render-token-spacing.js',
	'lib/core/sql-select-mutations.js',
	'lib/core/sql-case-mutations.js',
	'lib/core/sql-layout-formatter.js',
	'lib/core/sql-condition-mutations.js',
	'lib/core/sql-format-nodes.js'
].forEach(function(relativePath) {
	var source = read_source(relativePath);
	[
		'token_by_index',
		'previous_code_token',
		'next_code_token',
		'active_tokens'
	].forEach(function(helperName) {
		assert.strictEqual(
			new RegExp('function\\s+' + helperName + '\\s*\\(').test(source),
			false,
			relativePath + ' must use sql-format-navigation for ' + helperName
		);
	});
});
```

For the `scope_by_id` local helper ban array, use:

```js
[
	'lib/core/sql-structured-renderer.js',
	'lib/core/sql-render-indent.js',
	'lib/core/sql-render-token-spacing.js',
	'lib/core/sql-select-mutations.js',
	'lib/core/sql-case-mutations.js',
	'lib/core/sql-condition-mutations.js',
	'lib/core/sql-format-nodes.js'
].forEach(function(relativePath) {
	var source = read_source(relativePath);
	assert.strictEqual(
		/function\s+scope_by_id\s*\(\s*document\s*,/.test(source),
		false,
		relativePath + ' must use sql-format-navigation for document scope lookup'
	);
});
```

- [ ] **Step 6: Replace live graph facade checks with direct import checks**

In `tests/module-boundary.test.js`, remove:

```js
var selectFormatterFacadeSource = read_source('lib/core/sql-select-formatter.js');
var caseFormatterFacadeSource = read_source('lib/core/sql-case-formatter.js');
var commentFormatterFacadeSource = read_source('lib/core/sql-comment-formatter.js');
var conditionFormatterSource = liveFormatterSources['lib/core/sql-condition-formatter.js'] || liveFormatterSources['lib/sql-condition-formatter.js'];
```

Add:

```js
var obsoleteFormatterFiles = [
	'lib/core/sql-select-formatter.js',
	'lib/core/sql-case-formatter.js',
	'lib/core/sql-comment-formatter.js',
	'lib/core/sql-condition-formatter.js',
	'lib/sql-select-formatter.js',
	'lib/sql-case-formatter.js',
	'lib/sql-comment-formatter.js',
	'lib/sql-condition-formatter.js'
];
```

Remove the old `assert.ok(conditionFormatterSource, ...)` and facade delegation assertions. Add:

```js
[
	"require('./sql-select-mutations')",
	"require('./sql-case-mutations')",
	"require('./sql-comment-mutations')",
	"require('./sql-condition-mutations')",
	"require('./sql-comment-spacing')"
].forEach(function(requireText) {
	assert.ok(
		formatterSource.indexOf(requireText) >= 0,
		'sql-formatter must directly import focused live module: ' + requireText
	);
});

obsoleteFormatterFiles.forEach(function(relativePath) {
	assert.strictEqual(
		Object.prototype.hasOwnProperty.call(liveFormatterSources, relativePath),
		false,
		'live formatter dependency graph must not include obsolete formatter facade: ' + relativePath
	);
});
```

Replace the condition formatter source check:

```js
assert.strictEqual(
	/\bfunction\s+condition_wrap\b|\bcondition_wrap\s*[:=]|exports\.condition_wrap\b/.test(conditionFormatterSource),
	false,
	'condition formatter must not retain the legacy condition_wrap state machine on the live module'
);
```

with:

```js
assert.strictEqual(
	/\bfunction\s+condition_wrap\b|\bcondition_wrap\s*[:=]|exports\.condition_wrap\b/.test(combinedLiveFormatterSource),
	false,
	'live formatter dependency graph must not retain the legacy condition_wrap state machine'
);
```

- [ ] **Step 7: Add obsolete API export bans**

In `tests/module-boundary.test.js`, after `combinedLiveFormatterSource` is built, add:

```js
[
	'format_case_blocks',
	'render_case_node',
	'align_as_in_select_blocks',
	'format_select_clause_lists',
	'split_same_line_select_separators',
	'wrap_condition_clauses',
	'align_condition_clauses',
	'order_comment',
	'protect_standalone_comments',
	'protect_inline_comments',
	'restore_comments',
	'repair_orphan_leading_commas',
	'apply_trailing_comma_style'
].forEach(function(functionName) {
	assert.strictEqual(
		new RegExp('exports\\.' + functionName + '\\b').test(combinedLiveFormatterSource),
		false,
		'live formatter dependency graph must not export obsolete formatter API ' + functionName
	);
});
```

Keep the existing `formatterSource` direct-call ban for legacy structure functions.

- [ ] **Step 8: Run tests and confirm the intended red state**

Run:

```bash
node tests/structured-pipeline-regression.test.js
```

Expected: FAIL with `Cannot find module '../lib/core/sql-condition-mutations'`.

Run:

```bash
node tests/module-boundary.test.js
```

Expected: FAIL because `lib/core/sql-condition-mutations.js` and `lib/core/sql-comment-spacing.js` do not exist yet, and because obsolete formatter facade files still exist.

- [ ] **Step 9: Commit red boundary tests**

Run:

```bash
git add tests/module-boundary.test.js tests/structured-pipeline-regression.test.js
git commit -m "test: require structured formatter breaking cleanup"
```

Expected: commit succeeds. The committed tests are expected to fail until later implementation tasks complete.

## Task 3: Extract Structured Condition Mutations

**Files:**
- Create: `lib/core/sql-condition-mutations.js`
- Modify: `lib/core/sql-condition-formatter.js`
- Test: `tests/condition-alignment.test.js`
- Test: `tests/structured-pipeline-regression.test.js`

- [ ] **Step 1: Create `sql-condition-mutations.js` with focused imports**

Create `lib/core/sql-condition-mutations.js` with this header:

```js
var sqlFormatUtils = require('./sql-format-utils');
var sqlFormatMutations = require('./sql-format-mutations');
var sqlFormatNavigation = require('./sql-format-navigation');
var expand_tabs_for_width = sqlFormatUtils.expand_tabs_for_width;
var repeat_space = sqlFormatUtils.repeat_space;
```

- [ ] **Step 2: Move structured condition helpers unchanged**

Move these functions from `lib/core/sql-condition-formatter.js` into `lib/core/sql-condition-mutations.js`:

```text
suffix_after_prefix
line_indent_with_mutation
condition_target_keyword_end
condition_base_indent
condition_clause_indent
condition_connector_indent
condition_bare_indent
condition_close_indent
line_has_code_comma
line_has_code_after_token
should_join_hash_comment_inlist_first_value
apply_condition_inlist_joins
apply_condition_mutations
```

Keep each function body behavior-equivalent. The one allowed readability cleanup is fixing the extra indentation currently around the `for (var s = 0; s < (block.segments || []).length; s++)` loop inside `apply_condition_mutations()`.

- [ ] **Step 3: Add the condition mutation export**

At the bottom of `lib/core/sql-condition-mutations.js`, add:

```js
exports.apply_condition_mutations = apply_condition_mutations;
```

- [ ] **Step 4: Temporarily delegate from the old condition formatter**

In `lib/core/sql-condition-formatter.js`, add near the existing requires:

```js
var sqlConditionMutations = require('./sql-condition-mutations');
```

Replace the old `apply_condition_mutations()` body with:

```js
function apply_condition_mutations(document, nodes, mutations, config) {
	return sqlConditionMutations.apply_condition_mutations(document, nodes, mutations, config);
}
```

Keep `exports.apply_condition_mutations = apply_condition_mutations;` for this task only. The whole old formatter facade is deleted in a later task.

- [ ] **Step 5: Run syntax checks**

Run:

```bash
node -c lib/core/sql-condition-mutations.js
node -c lib/core/sql-condition-formatter.js
```

Expected: both commands exit 0.

- [ ] **Step 6: Run condition-focused regression**

Run:

```bash
node tests/condition-alignment.test.js
node tests/structured-pipeline-regression.test.js
```

Expected: both commands pass.

- [ ] **Step 7: Commit condition mutation extraction**

Run:

```bash
git add lib/core/sql-condition-mutations.js lib/core/sql-condition-formatter.js
git commit -m "refactor: extract structured condition mutations"
```

Expected: commit succeeds.

## Task 4: Extract Live Comment Spacing And Direct Pipeline Imports

**Files:**
- Create: `lib/core/sql-comment-spacing.js`
- Modify: `lib/core/sql-comment-formatter.js`
- Modify: `lib/core/sql-formatter.js`
- Test: `tests/comment-alignment.test.js`
- Test: `tests/structured-pipeline-regression.test.js`

- [ ] **Step 1: Create `sql-comment-spacing.js`**

Move these functions from `lib/core/sql-comment-formatter.js` into `lib/core/sql-comment-spacing.js`:

```text
is_mysql_hash_comment_enabled
normalize_line_comment_spacing
```

Use this module shape:

```js
var sqlTokenizer = require('./sql-tokenizer');

function is_mysql_hash_comment_enabled(tokenizer_options) {
	return tokenizer_options && tokenizer_options.dialect == 'mysql';
}

function normalize_line_comment_spacing(str, tokenizer_options) {
	var tokens = sqlTokenizer.tokenize(String(str || ''), tokenizer_options);
	var result = '';

	for (var i = 0; i < tokens.length; i++) {
		var token = tokens[i];
		if (token.type == 'line_comment') {
			if (/^--\+/.test(token.value) || /^---+/.test(token.value)) {
				result += token.value;
			} else if (/^#/.test(token.value) && is_mysql_hash_comment_enabled(tokenizer_options)) {
				result += token.value;
			} else {
				result += token.value.replace(/^(--|#)\s*/g, '$1 ');
			}
		} else {
			result += token.value;
		}
	}

	return result;
}

exports.normalize_line_comment_spacing = normalize_line_comment_spacing;
```

If the existing function body differs from this snippet, preserve the existing body exactly and only change its module ownership.

- [ ] **Step 2: Temporarily delegate from the old comment formatter**

In `lib/core/sql-comment-formatter.js`, add:

```js
var sqlCommentSpacing = require('./sql-comment-spacing');
```

Replace `normalize_line_comment_spacing()` with:

```js
function normalize_line_comment_spacing(str, tokenizer_options) {
	return sqlCommentSpacing.normalize_line_comment_spacing(str, tokenizer_options);
}
```

Keep the export for this task only. The facade is deleted later.

- [ ] **Step 3: Update `sql-formatter.js` imports**

In `lib/core/sql-formatter.js`, replace:

```js
var sqlLayoutFormatter = require('./sql-layout-formatter');
var sqlCommentFormatter = require('./sql-comment-formatter');
var sqlCaseFormatter = require('./sql-case-formatter');
var sqlSelectFormatter = require('./sql-select-formatter');
var sqlConditionFormatter = require('./sql-condition-formatter');
```

with:

```js
var sqlLayoutFormatter = require('./sql-layout-formatter');
var sqlCommentSpacing = require('./sql-comment-spacing');
var sqlCommentMutations = require('./sql-comment-mutations');
var sqlCaseMutations = require('./sql-case-mutations');
var sqlSelectMutations = require('./sql-select-mutations');
var sqlConditionMutations = require('./sql-condition-mutations');
```

- [ ] **Step 4: Update mutation calls in `sql-formatter.js`**

Replace `add_initial_structured_mutations()` with:

```js
function add_initial_structured_mutations(document, nodes, mutations, config) {
	sqlCaseMutations.apply_case_mutations(document, nodes, mutations, config);
	sqlSelectMutations.apply_select_list_mutations(document, nodes, mutations, config);
	sqlClauseFormatter.apply_clause_line_break_mutations(document, nodes, mutations, config);
	sqlConditionMutations.apply_condition_mutations(document, nodes, mutations, config);
	sqlLayoutFormatter.apply_scope_layout_mutations(document, nodes, mutations, config);
	sqlKeywords.apply_keyword_case_mutations(document, mutations, config.keywordCase !== 'lower', document.tokenizerOptions);
	sqlCommentMutations.apply_comment_alignment_mutations(document, nodes, mutations, config);
}
```

Replace the post-render comment spacing call:

```js
rendered = sqlCommentFormatter.normalize_line_comment_spacing(rendered, dialect);
```

with:

```js
rendered = sqlCommentSpacing.normalize_line_comment_spacing(rendered, dialect);
```

- [ ] **Step 5: Run syntax checks**

Run:

```bash
node -c lib/core/sql-comment-spacing.js
node -c lib/core/sql-comment-formatter.js
node -c lib/core/sql-formatter.js
```

Expected: all commands exit 0.

- [ ] **Step 6: Run targeted live pipeline checks**

Run:

```bash
node tests/comment-alignment.test.js
node tests/structured-pipeline-regression.test.js
node tests/condition-alignment.test.js
```

Expected: all commands pass except `tests/module-boundary.test.js`, which still fails until obsolete files are deleted.

- [ ] **Step 7: Commit direct live pipeline imports**

Run:

```bash
git add lib/core/sql-comment-spacing.js lib/core/sql-comment-formatter.js lib/core/sql-formatter.js
git commit -m "refactor: route structured formatter through focused modules"
```

Expected: commit succeeds.

## Task 5: Delete Obsolete Formatter Facades And Root Shims

**Files:**
- Delete: `lib/core/sql-select-formatter.js`
- Delete: `lib/core/sql-case-formatter.js`
- Delete: `lib/core/sql-comment-formatter.js`
- Delete: `lib/core/sql-condition-formatter.js`
- Delete: `lib/sql-select-formatter.js`
- Delete: `lib/sql-case-formatter.js`
- Delete: `lib/sql-comment-formatter.js`
- Delete: `lib/sql-condition-formatter.js`
- Modify: tests if import references remain
- Test: `tests/module-boundary.test.js`

- [ ] **Step 1: Search for remaining facade imports before deleting**

Run:

```bash
rg -n "sql-(select|case|comment|condition)-formatter" lib tests docs/technical README.md CHANGELOG.md package.json
```

Expected before deletion: references remain only in files intentionally changed by this task or historical docs/specs/plans. Runtime code and active tests should not need these modules after Tasks 2-4.

- [ ] **Step 2: Delete obsolete core formatter facades**

Use `apply_patch` to delete these files:

```text
*** Begin Patch
*** Delete File: lib/core/sql-select-formatter.js
*** Delete File: lib/core/sql-case-formatter.js
*** Delete File: lib/core/sql-comment-formatter.js
*** Delete File: lib/core/sql-condition-formatter.js
*** End Patch
```

Expected: files are removed. Do not delete `lib/core/sql-clause-formatter.js`, `lib/core/sql-layout-formatter.js`, or `lib/core/sql-format-pipeline.js`.

- [ ] **Step 3: Delete obsolete root formatter shims**

Use `apply_patch` to delete these files:

```text
*** Begin Patch
*** Delete File: lib/sql-select-formatter.js
*** Delete File: lib/sql-case-formatter.js
*** Delete File: lib/sql-comment-formatter.js
*** Delete File: lib/sql-condition-formatter.js
*** End Patch
```

Expected: files are removed. Do not delete `lib/sql-formatter.js`, `lib/sql-ddl-formatter.js`, tokenizer, registry, canonical, adapter, or DDL shims.

- [ ] **Step 4: Verify no active runtime/test imports remain**

Run:

```bash
rg -n "require\\(['\"]\\.\\.?/.*sql-(select|case|comment|condition)-formatter['\"]\\)|require\\(['\"]\\.\\.?/core/sql-(select|case|comment|condition)-formatter['\"]\\)" lib tests
```

Expected: no matches.

- [ ] **Step 5: Verify obsolete APIs are not exported from live modules**

Run:

```bash
rg -n "exports\\.(format_case_blocks|render_case_node|align_as_in_select_blocks|format_select_clause_lists|split_same_line_select_separators|wrap_condition_clauses|align_condition_clauses|order_comment|protect_standalone_comments|protect_inline_comments|restore_comments|repair_orphan_leading_commas|apply_trailing_comma_style)" lib/core lib
```

Expected: no matches.

- [ ] **Step 6: Run module boundary test**

Run:

```bash
node tests/module-boundary.test.js
```

Expected: pass. If it fails because historical docs mention old function names, narrow the test to source graph and exports; do not delete historical plan/spec references.

- [ ] **Step 7: Run targeted formatter regression**

Run:

```bash
node tests/structured-pipeline-regression.test.js
node tests/comment-alignment.test.js
node tests/case-when.test.js
node tests/select-alignment.test.js
node tests/condition-alignment.test.js
node tests/canonical-core-boundary.test.js
node tests/pipeline-idempotency.test.js
node tests/token-boundary.test.js
```

Expected: all commands pass.

- [ ] **Step 8: Commit obsolete facade deletion**

Run:

```bash
git add -A lib tests
git commit -m "refactor: remove obsolete formatter facades"
```

Expected: commit succeeds and includes deletions plus test updates.

## Task 6: Final Verification And Package Smoke

**Files:**
- Test: all project regression tests
- Package inspection: generated `.vsix` artifact

- [ ] **Step 1: Run full verification**

Run:

```bash
npm run test:verify
```

Expected: all tests pass. Performance smoke must remain under the existing threshold.

- [ ] **Step 2: Run packaging smoke**

Run:

```bash
npm run package:vsix
```

Expected: command exits 0 and creates an ignored `.vsix` artifact for the current package version.

- [ ] **Step 3: Inspect packaged contents for deleted files**

Find the generated artifact:

```bash
ls -1 vscode-sql-beautify-v*.vsix | tail -1
```

Inspect it:

```bash
VSIX="$(ls -1 vscode-sql-beautify-v*.vsix | tail -1)"
unzip -l "$VSIX" | rg "extension/lib/(core/)?sql-(select|case|comment|condition)-formatter\\.js"
```

Expected: `rg` exits with no matches. This confirms the obsolete formatter facade files are not packaged.

- [ ] **Step 4: Confirm generated artifact is not tracked**

Run:

```bash
git status --short --ignored | rg "\\.vsix"
```

Expected: `.vsix` files appear as ignored (`!!`) or no tracked changes. Do not add `.vsix` files.

- [ ] **Step 5: Check final source references**

Run:

```bash
rg -n "sql-(select|case|comment|condition)-formatter" lib tests docs/technical README.md CHANGELOG.md package.json
```

Expected: no matches in `lib`, `tests`, `docs/technical`, `README.md`, `CHANGELOG.md`, or `package.json`. Historical references under `docs/superpowers/` may remain and should not block this task.

- [ ] **Step 6: Check final worktree**

Run:

```bash
git status --short
```

Expected: no tracked changes except any final documentation/test result note intentionally added. Ignored `.vsix` files may exist and must remain untracked.

## Task 7: Review Checklist Before Handoff

**Files:**
- Read: `git show --stat --oneline --no-renames HEAD`
- Read: `git status --short --ignored`

- [ ] **Step 1: Verify design success criteria**

Run:

```bash
node - <<'NODE'
var fs = require('fs');
var path = require('path');
var root = process.cwd();
var absent = [
	'lib/core/sql-select-formatter.js',
	'lib/core/sql-case-formatter.js',
	'lib/core/sql-comment-formatter.js',
	'lib/core/sql-condition-formatter.js',
	'lib/sql-select-formatter.js',
	'lib/sql-case-formatter.js',
	'lib/sql-comment-formatter.js',
	'lib/sql-condition-formatter.js'
];
absent.forEach(function(relativePath) {
	if (fs.existsSync(path.join(root, relativePath))) {
		throw new Error('obsolete file still exists: ' + relativePath);
	}
});
[
	['lib/core/sql-select-mutations.js', ['apply_select_list_mutations']],
	['lib/core/sql-case-mutations.js', ['apply_case_mutations']],
	['lib/core/sql-comment-mutations.js', ['apply_comment_alignment_mutations']],
	['lib/core/sql-condition-mutations.js', ['apply_condition_mutations']],
	['lib/core/sql-comment-spacing.js', ['normalize_line_comment_spacing']]
].forEach(function(entry) {
	var mod = require(path.join(root, entry[0]));
	var keys = Object.keys(mod).sort();
	var expected = entry[1].slice().sort();
	if (JSON.stringify(keys) !== JSON.stringify(expected)) {
		throw new Error(entry[0] + ' exports ' + JSON.stringify(keys) + ', expected ' + JSON.stringify(expected));
	}
});
console.log('structured formatter cleanup boundary check passed');
NODE
```

Expected: `structured formatter cleanup boundary check passed`.

- [ ] **Step 2: Summarize verification evidence**

Prepare a final note with:

```text
Implemented structured formatter breaking cleanup.
Verification:
- npm run test:verify
- npm run package:vsix
- VSIX content check confirmed deleted formatter facades are absent
Notes:
- Generated .vsix artifacts remain ignored and untracked
- No formatter output changes were intentionally introduced
```

- [ ] **Step 3: Confirm clean tracked worktree**

Run:

```bash
git status --short --branch
```

Expected: no tracked changes. If ignored `.vsix` artifacts exist, mention them in the handoff and do not commit them.
