# List Layout And CASE Layout Strategy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn structured SQL list layout into a reusable formatter concept, use it for top-level `ORDER BY`, and add an opt-in compact CASE layout strategy.

**Architecture:** Keep the existing tokenizer, scope model, `FormatNodes`, mutation plan, and structured renderer. First split generic list layout out of `sql-select-mutations.js` without changing output; then add `orderByList` ownership and layout; finally add `caseLayout` as a canonical option handled inside `sql-case-mutations.js`.

**Tech Stack:** CommonJS JavaScript, Node.js `assert` tests, existing structured formatter core under `lib/core/`, VS Code config metadata in `package.json`, local verification with `npm run test:verify`.

---

## File Structure

- Read: `docs/superpowers/specs/2026-06-10-list-layout-and-case-layout-strategy-design.md`
  - Approved design for this plan.
- Create: `lib/core/sql-list-mutations.js`
  - Generic structured list layout for `selectList`, `groupByList`, and later `orderByList`.
  - Exports only `apply_list_layout_mutations`, `structured_list_indent`, and `item_indent` if SELECT-specific code needs the indent helpers.
- Modify: `lib/core/sql-select-mutations.js`
  - Delegates generic list comma movement, item indentation, and between-item comment indentation to `sql-list-mutations.js`.
  - Keeps SELECT-specific `AS` alignment, SELECT hint handling, CASE item coordination, multiline top-level function item handling, and GROUP BY extension handling.
- Modify: `lib/core/sql-list-nodes.js`
  - Adds `orderByList` spans and separator ownership in Task 2.
  - Must not create `orderByList` inside `windowSpec`.
- Modify: `lib/core/sql-select-item-nodes.js`
  - Continues extracting list items from spans. This plan expects no code changes in this file because `orderByList.startTokenIndex` is chosen so existing extraction starts at the first sort key.
- Modify: `tests/module-boundary.test.js`
  - Guards new list-layout module boundaries and prevents generic list layout from living in SELECT-specific code again.
- Modify: `tests/select-alignment.test.js`
  - Adds/updates top-level `ORDER BY` expected output after Task 2.
- Modify: `tests/window-function-spacing.test.js`
  - Adds explicit guard that window `ORDER BY` does not become an `orderByList`.
- Modify: `tests/token-spacing-policy.test.js`
  - Updates top-level `ORDER BY` formatter expectation and keeps window expectation unchanged.
- Modify: `tests/case-when.test.js`
  - Adds default expanded behavior and opt-in compact CASE tests.
- Modify: `tests/comment-alignment.test.js`
  - Adds compact CASE trailing comment alignment guard in Task 3.
- Modify: `tests/config-options.test.js`
  - Adds `sqlBeautify.caseLayout` configuration surface and canonical normalization coverage.
- Modify: `lib/core/sql-canonical-options.js`
  - Adds `caseLayout` normalization.
- Modify: `lib/adapters/sql-render-options.js`
  - Maps canonical and VS Code adapter inputs for `caseLayout`.
- Modify: `lib/adapters/vscode-config.js`
  - Reads `sqlBeautify.caseLayout` and explicit configuration metadata.
- Modify: `package.json`
  - Adds contributed setting `sqlBeautify.caseLayout`.
- Modify: `docs/technical/sql-formatter-architecture.md`
  - Documents generic list layout ownership and CASE layout strategy ownership after implementation.

Do not modify root `lib/*.js` shims. Do not modify `lib/experimental/ddl/`. Do not commit `.vsix` artifacts. Local commands in this plan do not use proxy.

---

### Task 1: Extract Generic List Layout Without Output Changes

**Files:**
- Create: `lib/core/sql-list-mutations.js`
- Modify: `lib/core/sql-select-mutations.js`
- Modify: `tests/module-boundary.test.js`

- [ ] **Step 1: Confirm the approved spec and baseline**

Run:

```bash
sed -n '1,340p' docs/superpowers/specs/2026-06-10-list-layout-and-case-layout-strategy-design.md
git status --short
node tests/select-alignment.test.js
node tests/window-function-spacing.test.js
node tests/token-spacing-policy.test.js
node tests/module-boundary.test.js
node tests/pipeline-idempotency.test.js
```

Expected: spec describes the three iterations; `git status --short` has no tracked changes; all tests pass before edits. If baseline tests fail, stop and report the exact failure.

- [ ] **Step 2: Add failing boundary tests for `sql-list-mutations.js`**

Modify `tests/module-boundary.test.js`:

Add this require near the other core module requires:

```js
var sqlListMutations = require('../lib/core/sql-list-mutations');
```

Add this API assertion near the structured mutation module assertions:

```js
assert.strictEqual(typeof sqlListMutations.apply_list_layout_mutations, 'function', 'structured list mutations must export apply_list_layout_mutations');
assert.strictEqual(typeof sqlListMutations.structured_list_indent, 'function', 'structured list mutations must export structured_list_indent');
assert.strictEqual(typeof sqlListMutations.item_indent, 'function', 'structured list mutations must export item_indent');
```

Add this export surface assertion near the other `assert.deepStrictEqual(Object.keys(...).sort())` checks:

```js
assert.deepStrictEqual(
	Object.keys(sqlListMutations).sort(),
	['apply_list_layout_mutations', 'item_indent', 'structured_list_indent'],
	'structured list mutations must expose only generic list layout entry points and indent helpers'
);
```

Add this file existence check near other core module existence checks:

```js
assert.ok(
	fs.existsSync(path.join(__dirname, '..', 'lib/core/sql-list-mutations.js')),
	'structured list mutation module must exist'
);
```

Add `lib/core/sql-list-mutations.js` to existing module-boundary arrays that reject local navigation helper definitions such as `token_by_index`, `previous_code_token`, `next_code_token`, `active_tokens`, and local `scope_by_id(document, ...)` helpers.

Add these source assertions near the current structured path source assertions:

```js
var selectMutationsSource = read_source('lib/core/sql-select-mutations.js');
var listMutationsSource = read_source('lib/core/sql-list-mutations.js');

assert.ok(
	selectMutationsSource.indexOf("require('./sql-list-mutations')") >= 0,
	'sql-select-mutations must delegate generic list layout to sql-list-mutations'
);
assert.ok(
	/sqlListMutations\.apply_list_layout_mutations\s*\(/.test(selectMutationsSource),
	'sql-select-mutations must call the generic list layout mutation pass'
);
assert.ok(
	listMutationsSource.indexOf("require('./sql-format-mutations')") >= 0,
	'sql-list-mutations must write list layout through MutationPlan helpers'
);
assert.ok(
	listMutationsSource.indexOf("require('./sql-scope-model')") >= 0,
	'sql-list-mutations must use scope model ownership for list indentation'
);
```

- [ ] **Step 3: Run boundary test and confirm it fails for the missing module**

Run:

```bash
node tests/module-boundary.test.js
```

Expected: FAIL with `Cannot find module '../lib/core/sql-list-mutations'` or equivalent missing export failure.

- [ ] **Step 4: Create `lib/core/sql-list-mutations.js` with generic list layout helpers**

Create `lib/core/sql-list-mutations.js` with this complete file:

```js
var sqlFormatMutations = require('./sql-format-mutations');
var sqlScopeModel = require('./sql-scope-model');

function find_separator_node(nodes, separatorId) {
	for (var i = 0; i < (nodes.separators || []).length; i++) {
		if (nodes.separators[i].id == separatorId) {
			return nodes.separators[i];
		}
	}
	return null;
}

function find_list_span(nodes, ownerScopeId) {
	for (var i = 0; i < (nodes.selectSpans || []).length; i++) {
		if (nodes.selectSpans[i].id == ownerScopeId) {
			return nodes.selectSpans[i];
		}
	}
	return null;
}

function is_structured_list_separator(separator) {
	return separator
		&& (separator.ownerKind == 'selectList' || separator.ownerKind == 'groupByList');
}

function list_base_indent(document, nodes, ownerScopeId) {
	var span = find_list_span(nodes, ownerScopeId);
	var line = span ? document.lines[span.startLine] : null;
	var baseIndent = line ? String(line.raw || '').match(/^\s*/)[0] : '';
	var queryScope = span
		? sqlScopeModel.find_owner_scope(document.scopes || [], {
			line: span.startLine,
			tokenIndex: span.startTokenIndex
		}, 'query')
		: null;
	if (queryScope && queryScope.id != 0 && typeof queryScope.bodyIndent == 'string') {
		baseIndent = queryScope.bodyIndent;
	}
	return baseIndent;
}

function structured_list_indent(document, nodes, ownerScopeId, ownerKind) {
	return list_base_indent(document, nodes, ownerScopeId)
		+ (ownerKind == 'groupByList' ? '         ' : '       ');
}

function item_indent(document, nodes, item) {
	var baseIndent = list_base_indent(document, nodes, item.ownerScopeId);
	return item.id == 'selectItem:0'
		? baseIndent + (item.ownerKind == 'groupByList' ? 'GROUP BY  ' : 'SELECT  ')
		: structured_list_indent(document, nodes, item.ownerScopeId, item.ownerKind) + ',';
}

function line_starts_with_leading_separator(document, item) {
	var line = document && item ? document.lines[item.startLine] : null;
	return line && /^\s*,/.test(String(line.codeText || ''));
}

function apply_between_item_comment_indents(document, nodes, mutations, item, nextItem) {
	if (!nextItem || item.ownerScopeId != nextItem.ownerScopeId) {
		return;
	}
	if (nextItem.startLine <= item.endLine + 1) {
		return;
	}
	var indent = structured_list_indent(document, nodes, item.ownerScopeId, item.ownerKind);
	for (var lineIndex = item.endLine + 1; lineIndex < nextItem.startLine; lineIndex++) {
		var line = document.lines[lineIndex];
		if (line && line.isStandaloneComment) {
			sqlFormatMutations.add_line_indent(mutations, lineIndex, indent);
		}
	}
}

function move_leading_comma_separator(document, nodes, mutations, item, nextItem) {
	if (!item.separatorId) {
		return;
	}

	var separator = find_separator_node(nodes, item.separatorId);
	if (!is_structured_list_separator(separator)
		|| !nextItem
		|| nextItem.ownerScopeId != item.ownerScopeId) {
		return;
	}

	if (separator.line == nextItem.startLine) {
		var sameLine = document.lines[separator.line];
		var beforeSeparator = sameLine ? sameLine.raw.slice(0, separator.column).replace(/^\s+|\s+$/g, '') : '';
		if (beforeSeparator == '') {
			return;
		}
		sqlFormatMutations.add_separator_move(mutations, separator.id, {
			placement: 'removed'
		});
		sqlFormatMutations.add_line_break_before_token(
			mutations,
			nextItem.tokens[0].id,
			structured_list_indent(document, nodes, item.ownerScopeId, separator.ownerKind),
			','
		);
		return;
	}

	var separatorLine = document.lines[separator.line];
	if (!separatorLine || !/,\s*$/.test(separatorLine.codeText)) {
		return;
	}

	sqlFormatMutations.add_separator_move(mutations, separator.id, {
		lineIndex: nextItem.startLine,
		placement: 'linePrefix',
		text: ',',
		indentText: structured_list_indent(document, nodes, item.ownerScopeId, separator.ownerKind)
	});
}

function apply_list_layout_mutations(document, nodes, mutations, config) {
	if (!document || !nodes || !mutations || !config || config.commaStyle != 'leading') {
		return;
	}

	for (var i = 0; i < (nodes.selectItems || []).length; i++) {
		var item = nodes.selectItems[i];
		var nextItem = nodes.selectItems[i + 1];
		if (line_starts_with_leading_separator(document, item)) {
			sqlFormatMutations.add_line_indent(
				mutations,
				item.startLine,
				structured_list_indent(document, nodes, item.ownerScopeId, item.ownerKind)
			);
		}
		apply_between_item_comment_indents(document, nodes, mutations, item, nextItem);
		move_leading_comma_separator(document, nodes, mutations, item, nextItem);
	}
}

exports.apply_list_layout_mutations = apply_list_layout_mutations;
exports.structured_list_indent = structured_list_indent;
exports.item_indent = item_indent;
```

This file must not contain SELECT hint logic, SELECT header join logic, multiline function item logic, `AS` alignment, CASE-specific logic, or GROUP BY extension logic.

- [ ] **Step 5: Delegate from `sql-select-mutations.js`**

Modify `lib/core/sql-select-mutations.js`:

Add:

```js
var sqlListMutations = require('./sql-list-mutations');
```

Remove local definitions that moved to `sql-list-mutations.js`:

```text
find_separator_node
is_structured_list_separator
find_select_span
structured_list_indent
item_indent
apply_between_item_comment_indents
line_starts_with_leading_separator
```

Replace internal calls:

```js
structured_list_indent(document, nodes, ownerScopeId, ownerKind)
```

with:

```js
sqlListMutations.structured_list_indent(document, nodes, ownerScopeId, ownerKind)
```

Replace:

```js
item_indent(document, nodes, item)
```

with:

```js
sqlListMutations.item_indent(document, nodes, item)
```

Where SELECT-specific code needs the span lookup formerly named `find_select_span`, add a private SELECT-specific helper:

```js
function select_span_by_id(nodes, ownerScopeId) {
	var spans = nodes && nodes.selectSpans ? nodes.selectSpans : [];
	for (var i = 0; i < spans.length; i++) {
		if (spans[i].id == ownerScopeId) {
			return spans[i];
		}
	}
	return null;
}
```

At the start of `apply_select_list_mutations()` after the null/config guard, call:

```js
sqlListMutations.apply_list_layout_mutations(document, nodes, mutations, config);
```

Then remove the generic comma movement block from `apply_select_list_mutations()`. Keep these SELECT-specific operations in the loop:

- `should_join_select_header_first_item()`
- `has_select_hint_line()`
- `has_select_header_comment_line()`
- `apply_multiline_function_item_mutations()`

Keep after the loop:

```js
apply_group_by_extension_mutations(document, nodes, mutations);
apply_select_as_alignment_mutations(document, nodes, mutations, config);
```

- [ ] **Step 6: Run targeted behavior-preserving checks**

Run:

```bash
node tests/select-alignment.test.js
node tests/window-function-spacing.test.js
node tests/token-spacing-policy.test.js
node tests/module-boundary.test.js
node tests/pipeline-idempotency.test.js
```

Expected: all pass. Formatter output must not change in this task.

- [ ] **Step 7: Run broad verification**

Run:

```bash
npm run test:verify
git diff --check
```

Expected: all pass.

- [ ] **Step 8: Review checkpoint**

Review the diff manually:

```bash
git diff -- lib/core/sql-list-mutations.js lib/core/sql-select-mutations.js tests/module-boundary.test.js
```

Confirm:

- `sql-list-mutations.js` owns only generic list layout.
- `sql-select-mutations.js` still owns SELECT-specific `AS`, CASE item, hint, header comment, function item, and GROUP BY extension behavior.
- No root shim, adapter, experimental DDL, renderer spacing, or CASE file changed.
- Existing output expectations did not change.

- [ ] **Step 9: Commit Task 1**

Run:

```bash
git add lib/core/sql-list-mutations.js lib/core/sql-select-mutations.js tests/module-boundary.test.js
git commit -m "refactor: extract structured list layout"
```

Expected: commit succeeds.

---

### Task 2: Add Top-Level ORDER BY List Layout

**Files:**
- Modify: `lib/core/sql-list-nodes.js`
- Modify: `lib/core/sql-list-mutations.js`
- Modify: `tests/select-alignment.test.js`
- Modify: `tests/window-function-spacing.test.js`
- Modify: `tests/token-spacing-policy.test.js`

- [ ] **Step 1: Re-run Task 1 focused baseline**

Run:

```bash
git status --short
node tests/select-alignment.test.js
node tests/window-function-spacing.test.js
node tests/token-spacing-policy.test.js
node tests/module-boundary.test.js
node tests/pipeline-idempotency.test.js
```

Expected: no tracked changes; all tests pass.

- [ ] **Step 2: Add failing top-level ORDER BY expectations**

Modify the existing `comma spacing normalizes function arguments and order keys` case in `tests/select-alignment.test.js`.

Change expected output from:

```js
[
	"SELECT  coalesce(phone, email, 'unknown') AS contact_info",
	'FROM users',
	'ORDER BY dt DESC, event_time DESC'
].join('\n')
```

to:

```js
[
	"SELECT  coalesce(phone, email, 'unknown') AS contact_info",
	'FROM users',
	'ORDER BY  dt DESC',
	'         ,event_time DESC'
].join('\n')
```

Add this new case after it:

```js
run_case(
	'top-level order by keeps function args and in-list commas inline while splitting sort keys',
	"select id from users order by coalesce(last_login,created_at) desc,case when status in ('active','trial') then 0 else 1 end asc,id",
	[
		'SELECT  id',
		'FROM users',
		'ORDER BY  coalesce(last_login, created_at) DESC',
		"         ,CASE",
		"              WHEN status IN ('active', 'trial') THEN 0",
		'              ELSE 1',
		'          END ASC',
		'         ,id'
	].join('\n')
);
```

- [ ] **Step 3: Add failing window ORDER BY guard**

Modify `tests/window-function-spacing.test.js` by adding this case before the final `console.log`:

```js
var topLevelAndWindow = format(
	'select row_number() over(partition by ds order by pay_time desc,created_at desc) as rn from orders order by ds desc,pay_time desc'
);

assert.ok(
	topLevelAndWindow.indexOf('ROW_NUMBER() OVER(PARTITION BY ds ORDER BY  pay_time DESC, created_at DESC) AS rn') >= 0,
	'window ORDER BY must remain inline with existing double-space contract\n--- actual ---\n' + topLevelAndWindow
);
assert.ok(
	topLevelAndWindow.indexOf('ORDER BY  ds DESC\n         ,pay_time DESC') >= 0,
	'top-level ORDER BY should split while window ORDER BY stays inline\n--- actual ---\n' + topLevelAndWindow
);
assert.ok(
	topLevelAndWindow.indexOf('OVER(PARTITION BY ds ORDER BY  pay_time DESC\n') < 0,
	'window ORDER BY must not be split as orderByList\n--- actual ---\n' + topLevelAndWindow
);
```

- [ ] **Step 4: Update token spacing policy expectation**

Modify the first case in `tests/token-spacing-policy.test.js`.

Change expected top-level `ORDER BY` line from:

```js
'ORDER BY dt DESC, event_time DESC'
```

to:

```js
'ORDER BY  dt DESC',
'         ,event_time DESC'
```

Keep the window `ORDER BY` assertion unchanged.

- [ ] **Step 5: Run tests and confirm they fail for missing ORDER BY layout**

Run:

```bash
node tests/select-alignment.test.js
node tests/window-function-spacing.test.js
node tests/token-spacing-policy.test.js
```

Expected: FAIL because top-level `ORDER BY` still renders inline. Window assertions should show the desired unchanged fragment.

- [ ] **Step 6: Add `orderByList` spans in `sql-list-nodes.js`**

Modify `lib/core/sql-list-nodes.js`:

Add a helper:

```js
function is_window_scope_token(document, token) {
	return scopeModel.find_owner_scope(document.scopes || [], token, 'windowSpec') != null;
}
```

Add a helper:

```js
function is_order_by_start(tokens, index) {
	return is_word(tokens[index], 'ORDER')
		&& tokens[index + 1]
		&& is_word(tokens[index + 1], 'BY');
}
```

In `is_list_boundary_token(tokens, index, kind)`, add:

```js
if (kind == 'orderByList') {
	return is_word(token, 'LIMIT')
		|| is_word(token, 'UNION')
		|| is_word(token, 'QUALIFY')
		|| is_word(token, 'INTERSECT')
		|| is_word(token, 'EXCEPT');
}
```

In `create_list_spans(document)`, when the active token is a top-level `ORDER BY`, push:

```js
if (is_order_by_start(tokens, i) && !is_window_scope_token(document, token)) {
	activeSpans.push({
		id: 'orderByList:' + nextSpanId++,
		kind: 'orderByList',
		startTokenIndex: tokens[i + 1].index,
		endTokenIndex: tokens[i + 1].index,
		startLine: token.line,
		endLine: token.line,
		parenDepth: parenDepth,
		caseDepth: caseDepth
	});
}
```

Use `tokens[i + 1].index` as `startTokenIndex` so existing item extraction begins after `BY`, matching how SELECT begins after `SELECT` and GROUP BY begins after `GROUP BY` when `startTokenIndex + 1` is used.

Ensure the span is not created when `ORDER BY` is inside `windowSpec`.

- [ ] **Step 7: Extend generic list layout to `orderByList`**

Modify `lib/core/sql-list-mutations.js`:

Update `is_structured_list_separator(separator)`:

```js
return separator
	&& (separator.ownerKind == 'selectList'
		|| separator.ownerKind == 'groupByList'
		|| separator.ownerKind == 'orderByList');
```

Add a prefix helper:

```js
function first_item_prefix(ownerKind) {
	if (ownerKind == 'groupByList') {
		return 'GROUP BY  ';
	}
	if (ownerKind == 'orderByList') {
		return 'ORDER BY  ';
	}
	return 'SELECT  ';
}
```

Add a continuation width helper:

```js
function continuation_width(ownerKind) {
	if (ownerKind == 'groupByList' || ownerKind == 'orderByList') {
		return 9;
	}
	return 7;
}
```

Update `structured_list_indent()`:

```js
return baseIndent + repeat_space(continuation_width(ownerKind));
```

If `sql-list-mutations.js` does not yet require `sql-format-utils`, add:

```js
var sqlFormatUtils = require('./sql-format-utils');
var repeat_space = sqlFormatUtils.repeat_space;
```

Update `item_indent()` to use `first_item_prefix(item.ownerKind)`.

- [ ] **Step 8: Ensure item extraction treats ORDER BY items as list items**

Run:

```bash
node - <<'NODE'
var sqlFormatDocument = require('./lib/core/sql-format-document');
var sqlScopeModel = require('./lib/core/sql-scope-model');
var sqlFormatNavigation = require('./lib/core/sql-format-navigation');
var sqlFormatNodes = require('./lib/core/sql-format-nodes');
var config = { dialect: 'generic', commaStyle: 'leading', indentStyle: 'space' };
var document = sqlFormatDocument.from_text('select a from t order by x desc,y desc', config);
document.scopes = sqlScopeModel.build(document, config);
sqlFormatNavigation.attach_scope_index(document);
var nodes = sqlFormatNodes.extract(document, config);
console.log(nodes.selectSpans.map(function(span) { return span.kind + ':' + span.startTokenIndex + '-' + span.endTokenIndex; }).join('\n'));
console.log(nodes.selectItems.map(function(item) { return item.ownerKind + ':' + item.tokens.map(function(token) { return token.value; }).join(' '); }).join('\n'));
NODE
```

Expected output includes:

```text
orderByList
orderByList:x desc
orderByList:y desc
```

The first ORDER BY item must not include `BY`. If the probe prints `orderByList:BY x desc`, fix `orderByList.startTokenIndex` in `sql-list-nodes.js`; do not change `sql-select-item-nodes.js`.

- [ ] **Step 9: Run targeted ORDER BY checks**

Run:

```bash
node tests/select-alignment.test.js
node tests/window-function-spacing.test.js
node tests/token-spacing-policy.test.js
node tests/pipeline-idempotency.test.js
```

Expected: all pass. Confirm window `ORDER BY` remains inline.

- [ ] **Step 10: Run broader verification**

Run:

```bash
npm run test:verify
git diff --check
```

Expected: all pass. If production corpus snapshots fail because top-level ORDER BY output intentionally changed, inspect the diff carefully. Update committed snapshots only when the changed output is a top-level ORDER BY list and window ORDER BY remains unchanged.

- [ ] **Step 11: Review checkpoint**

Review the diff:

```bash
git diff -- lib/core/sql-list-nodes.js lib/core/sql-list-mutations.js tests/select-alignment.test.js tests/window-function-spacing.test.js tests/token-spacing-policy.test.js
```

Confirm:

- `orderByList` is created only outside `windowSpec`.
- Function argument commas and `IN (...)` commas remain owned by nested scopes.
- No ORDER BY-specific public setting was added.
- Window `ORDER BY` test expectations are unchanged except for the new guard.

- [ ] **Step 12: Commit Task 2**

Run:

```bash
git add lib/core/sql-list-nodes.js lib/core/sql-list-mutations.js tests/select-alignment.test.js tests/window-function-spacing.test.js tests/token-spacing-policy.test.js tests/fixtures/production-corpus/snapshots
git commit -m "feat: format top-level order by lists"
```

Expected: commit succeeds. If no production snapshots changed, the `tests/fixtures/...` path will add nothing.

---

### Task 3: Add Opt-In Compact CASE Layout Strategy

**Files:**
- Modify: `package.json`
- Modify: `lib/core/sql-canonical-options.js`
- Modify: `lib/adapters/sql-render-options.js`
- Modify: `lib/adapters/vscode-config.js`
- Modify: `lib/core/sql-case-mutations.js`
- Modify: `tests/config-options.test.js`
- Modify: `tests/case-when.test.js`
- Modify: `tests/comment-alignment.test.js`
- Modify: `docs/technical/sql-formatter-architecture.md`

- [ ] **Step 1: Re-run Task 2 baseline**

Run:

```bash
git status --short
node tests/case-when.test.js
node tests/select-alignment.test.js
node tests/comment-alignment.test.js
node tests/config-options.test.js
node tests/pipeline-idempotency.test.js
```

Expected: no tracked changes; all tests pass.

- [ ] **Step 2: Add failing configuration tests**

Modify `tests/config-options.test.js`:

Add `sqlBeautify.caseLayout` to the required public settings list:

```js
'sqlBeautify.caseLayout',
```

Add assertions:

```js
assert.strictEqual(
	sqlRenderOptions.normalize({}, {}).caseLayout,
	'expanded',
	'caseLayout defaults to expanded'
);

assert.strictEqual(
	sqlRenderOptions.normalize({
		caseLayout: 'compactShort'
	}, {
		caseLayout: true
	}).caseLayout,
	'compactShort',
	'explicit sqlBeautify.caseLayout compactShort should flow into canonical options'
);

assert.strictEqual(
	sqlRenderOptions.normalize({
		caseLayout: 'unknown'
	}, {
		caseLayout: true
	}).caseLayout,
	'expanded',
	'invalid caseLayout values fall back to expanded'
);
```

Update the existing `deepStrictEqual` canonical adapter input test:

Add input:

```js
caseLayout: 'compactShort',
```

Add explicit flag:

```js
caseLayout: true,
```

Add expected output:

```js
caseLayout: 'compactShort',
```

Add source assertion:

```js
assert_source_contains(
	'caseLayout must be read from sqlBeautify config',
	/has_configured_value\(scopedConfig, 'caseLayout'\)/
);
```

- [ ] **Step 3: Add failing compact CASE behavior tests**

Modify `tests/case-when.test.js`.

Add a new formatter helper:

```js
var sqlFormatter = require('../lib/sql-formatter');

function format_with_options(sql, options) {
	return sqlFormatter.format_sql(sql, Object.assign({
		keywordCase: 'upper',
		commaStyle: 'leading',
		indentStyle: 'space',
		maxAlignWidth: 150,
		caseWhenThenWrapLength: 80,
		dialect: 'generic',
		unsupportedSyntaxPolicy: 'preserve'
	}, options || {})).trim();
}
```

Add this helper near `run_case`:

```js
function run_option_case(name, input, options, expected) {
	var actual = format_with_options(input, options);
	assert.strictEqual(actual, expected.trim(), name + '\n--- actual ---\n' + actual + '\n--- expected ---\n' + expected.trim());
}
```

Add tests before `console.log`:

```js
run_option_case(
	'default expanded case layout remains unchanged',
	"select case when status=1 then 'Y' else 'N' end as is_active from users",
	{},
	[
		'SELECT',
		'       CASE',
		"           WHEN status = 1 THEN 'Y'",
		"           ELSE 'N'",
		'       END                          AS is_active',
		'FROM users'
	].join('\n')
);

run_option_case(
	'compactShort keeps short safe case on one line',
	"select case when status=1 then 'Y' else 'N' end as is_active from users",
	{ caseLayout: 'compactShort' },
	[
		"SELECT  CASE WHEN status = 1 THEN 'Y' ELSE 'N' END AS is_active",
		'FROM users'
	].join('\n')
);

run_option_case(
	'compactShort does not compact case with comments',
	[
		"select case when status=1 then 'Y' -- active",
		"else 'N' end as is_active from users"
	].join('\n'),
	{ caseLayout: 'compactShort' },
	[
		'SELECT',
		'       CASE',
		"           WHEN status = 1 THEN 'Y' -- active",
		"           ELSE 'N'",
		'       END                          AS is_active',
		'FROM users'
	].join('\n')
);

run_option_case(
	'compactShort does not compact nested case',
	[
		'select case when a=1 then case when b=2 then x else y end else z end as flag from t'
	].join('\n'),
	{ caseLayout: 'compactShort' },
	[
		'SELECT',
		'       CASE',
		'           WHEN a = 1 THEN CASE WHEN b = 2 THEN x ELSE y END',
		'           ELSE z',
		'       END                                                   AS flag',
		'FROM t'
	].join('\n')
);

run_option_case(
	'compactShort does not compact multiline in-list case',
	[
		'select case when city in (',
		"'NY',",
		"'LA'",
		") then 'coast' else 'other' end as city_group from users"
	].join('\n'),
	{ caseLayout: 'compactShort' },
	[
		'SELECT',
		'       CASE',
		'           WHEN city IN (',
		"                   'NY',",
		"                   'LA'",
		"               ) THEN 'coast'",
		'           ELSE',
		"               'other'",
		'       END                    AS city_group',
		'FROM users'
	].join('\n')
);
```

- [ ] **Step 4: Run tests and confirm they fail before implementation**

Run:

```bash
node tests/config-options.test.js
node tests/case-when.test.js
```

Expected: FAIL because `caseLayout` is not configured and compact CASE is not implemented.

- [ ] **Step 5: Add `caseLayout` canonical normalization**

Modify `lib/core/sql-canonical-options.js`:

Add:

```js
function normalize_case_layout(value) {
	return value === 'compactShort' ? 'compactShort' : 'expanded';
}
```

In `normalize(options)`, add:

```js
caseLayout: normalize_case_layout(raw.caseLayout),
```

Export:

```js
exports.normalize_case_layout = normalize_case_layout;
```

- [ ] **Step 6: Add adapter mapping and VS Code config reading**

Modify `lib/adapters/sql-render-options.js`:

Add:

```js
function normalize_case_layout(raw, explicit) {
	if (is_canonical_input(raw, explicit) && (raw.caseLayout === 'expanded' || raw.caseLayout === 'compactShort')) {
		return raw.caseLayout;
	}
	return raw.caseLayout === 'compactShort' ? 'compactShort' : 'expanded';
}
```

Pass into `sqlCanonicalOptions.normalize()`:

```js
caseLayout: normalize_case_layout(raw, explicit),
```

Modify `lib/adapters/vscode-config.js`:

Add to `raw`:

```js
caseLayout: scopedConfig.get('caseLayout'),
```

Add to `explicit`:

```js
caseLayout: has_configured_value(scopedConfig, 'caseLayout'),
```

- [ ] **Step 7: Add package setting**

Modify `package.json` under `contributes.configuration.properties`:

Add after `sqlBeautify.caseWhenThenWrapLength`:

```json
"sqlBeautify.caseLayout": {
	"scope": "resource",
	"type": "string",
	"enum": [
		"expanded",
		"compactShort"
	],
	"default": "expanded",
	"description": "CASE expression layout strategy. /CASE 表达式布局策略"
},
```

Keep JSON valid.

- [ ] **Step 8: Add compact CASE trailing comment alignment guard**

Modify `tests/comment-alignment.test.js`.

Add this require after the existing `vkbeautify` require:

```js
var sqlFormatter = require('../lib/sql-formatter');
```

Add these helpers after `run_case`:

```js
function format_with_options(sql, options) {
	return sqlFormatter.format_sql(sql, Object.assign({
		keywordCase: 'upper',
		commaStyle: 'leading',
		indentStyle: 'space',
		maxAlignWidth: 150,
		caseWhenThenWrapLength: 80,
		dialect: 'generic',
		unsupportedSyntaxPolicy: 'preserve'
	}, options || {})).trim();
}

function comment_column(line) {
	return line.indexOf('--');
}
```

Add this test before `console.log`:

```js
var compactCaseCommentAlignment = format_with_options(
	[
		"select id as id -- 用户ID",
		",case when status=1 then 'Y' else 'N' end as is_active -- 是否活跃",
		",created_at as created_at -- 创建时间",
		"from users"
	].join('\n'),
	{ caseLayout: 'compactShort' }
);
var compactCaseCommentLines = compactCaseCommentAlignment.split('\n').filter(function(line) {
	return line.indexOf('--') >= 0;
});
assert.strictEqual(
	compactCaseCommentLines.length,
	3,
	'compact CASE comment alignment test must keep three trailing comments\n--- actual ---\n' + compactCaseCommentAlignment
);
assert.strictEqual(
	comment_column(compactCaseCommentLines[0]),
	comment_column(compactCaseCommentLines[1]),
	'compact CASE trailing comment must align with preceding select item\n--- actual ---\n' + compactCaseCommentAlignment
);
assert.strictEqual(
	comment_column(compactCaseCommentLines[1]),
	comment_column(compactCaseCommentLines[2]),
	'compact CASE trailing comment must align with following select item\n--- actual ---\n' + compactCaseCommentAlignment
);
assert.ok(
	compactCaseCommentAlignment.indexOf("CASE WHEN status = 1 THEN 'Y' ELSE 'N' END AS is_active") >= 0,
	'compact CASE should stay on one line in comment alignment path\n--- actual ---\n' + compactCaseCommentAlignment
);
```

- [ ] **Step 9: Run tests and confirm compact CASE behavior still fails**

Run:

```bash
node tests/comment-alignment.test.js
```

Expected: FAIL because `caseLayout` is not implemented and the CASE does not stay on one line.

- [ ] **Step 10: Implement conservative compact CASE eligibility**

Modify `lib/core/sql-case-mutations.js`.

Add helpers near existing CASE rendering helpers:

```js
function case_layout(config) {
	return config && config.caseLayout == 'compactShort' ? 'compactShort' : 'expanded';
}

function case_has_comments(document, caseNode) {
	for (var i = caseNode.startTokenIndex; i <= caseNode.endTokenIndex; i++) {
		var token = document.tokens[i];
		if (token && (token.type == 'line_comment' || token.type == 'block_comment')) {
			return true;
		}
	}
	return false;
}

function case_has_multiline_child_scope(document, caseNode) {
	var scopes = document.scopes || [];
	for (var i = 0; i < scopes.length; i++) {
		var scope = scopes[i];
		if (scope.parentScopeId != caseNode.scopeId) {
			continue;
		}
		if ((scope.kind == 'inList' || scope.kind == 'functionCall' || scope.kind == 'parenList')
			&& scope.openLine != scope.closeLine) {
			return true;
		}
		if (scope.kind == 'caseExpr') {
			return true;
		}
	}
	return false;
}

function compact_case_tokens(caseNode) {
	var tokens = [];
	if (caseNode.caseKeywordToken) {
		tokens.push(caseNode.caseKeywordToken);
	}
	for (var b = 0; b < (caseNode.branches || []).length; b++) {
		var branch = caseNode.branches[b];
		tokens.push(branch.whenKeywordToken);
		tokens = tokens.concat(branch.whenTokens || []);
		if (branch.thenKeywordToken) {
			tokens.push(branch.thenKeywordToken);
		}
		tokens = tokens.concat(branch.thenTokens || []);
	}
	if (caseNode.elseKeywordToken) {
		tokens.push(caseNode.elseKeywordToken);
		tokens = tokens.concat(caseNode.elseTokens || []);
	}
	if (caseNode.endKeywordToken) {
		tokens.push(caseNode.endKeywordToken);
	}
	return tokens;
}

function compact_case_text(document, caseNode, config) {
	return render_token_values(document, compact_case_tokens(caseNode), null);
}

function can_compact_case(document, nodes, caseNode, config, wrapValues) {
	if (case_layout(config) != 'compactShort') {
		return false;
	}
	if (is_nested_case_node(document, caseNode) || case_has_comments(document, caseNode) || case_has_multiline_child_scope(document, caseNode) || wrapValues) {
		return false;
	}
	if (!caseNode.branches || caseNode.branches.length == 0 || !caseNode.endKeywordToken) {
		return false;
	}
	var text = compact_case_text(document, caseNode, config);
	var limit = config && config.caseWhenThenWrapLength ? parseInt(config.caseWhenThenWrapLength, 10) : 80;
	if (!limit || limit < 1) {
		limit = 80;
	}
	return text.length <= limit;
}
```

At the beginning of each non-nested case in `apply_case_mutations()` after computing `wrapValues`, add:

```js
if (can_compact_case(document, nodes, caseNode, config, wrapValues)) {
	var compactText = compact_case_text(document, caseNode, config);
	sqlFormatMutations.add_token_replacement(mutations, caseNode.caseKeywordToken.id, compactText);
	for (var compactIndex = caseNode.caseKeywordToken.index + 1; compactIndex <= caseNode.endKeywordToken.index; compactIndex++) {
		if (document.tokens[compactIndex] && document.tokens[compactIndex].isCode) {
			sqlFormatMutations.add_token_omission(mutations, document.tokens[compactIndex].id);
		}
	}
	for (var compactLine = caseNode.startLine + 1; compactLine <= caseNode.endLine; compactLine++) {
		sqlFormatMutations.add_line_omission(mutations, compactLine);
	}
	continue;
}
```

Important: this compact path must run before normal CASE keyword line-break mutations. If the compact CASE is inside a SELECT item, SELECT `AS` alignment must still see the compact replacement through existing mutation width logic. If width planning misses token replacements, adjust SELECT width helpers in `sql-select-mutations.js` narrowly to use token replacement text for the first token of a CASE item.

- [ ] **Step 11: Run compact CASE tests**

Run:

```bash
node tests/config-options.test.js
node tests/case-when.test.js
node tests/select-alignment.test.js
node tests/comment-alignment.test.js
node tests/pipeline-idempotency.test.js
```

Expected: all pass. If compact CASE `AS` or comment alignment fails, inspect planned width in `sql-select-mutations.js` and update the narrow width calculation rather than changing renderer spacing.

- [ ] **Step 12: Update architecture documentation**

Modify `docs/technical/sql-formatter-architecture.md`:

In "Core Rules", update the canonical option list to include `caseLayout`:

```text
Core accepts canonical option names only: `keywordCase`, `commaStyle`, `indentStyle`, `maxAlignWidth`, `caseWhenThenWrapLength`, `caseLayout`, `dialect`, and `unsupportedSyntaxPolicy`.
```

In the structured mutation implementation list, add or update:

```text
- `sql-list-mutations.js`: generic SELECT/GROUP BY/top-level ORDER BY list layout and comma placement mutations
- `sql-select-mutations.js`: SELECT-specific item layout, AS alignment, CASE item coordination, and SELECT comment/hint behavior
- `sql-case-mutations.js`: CASE branch layout mutations and explicit CASE layout strategies
```

In the structured format model section, update the `sql-list-nodes.js` bullet to mention top-level ORDER BY:

```text
- `sql-list-nodes.js`: SELECT/GROUP BY/top-level ORDER BY list spans and separator ownership
```

- [ ] **Step 13: Run final verification**

Run:

```bash
node tests/case-when.test.js
node tests/select-alignment.test.js
node tests/comment-alignment.test.js
node tests/config-options.test.js
node tests/module-boundary.test.js
node tests/pipeline-idempotency.test.js
npm run test:verify
git diff --check
npm run package:vsix
```

Expected: all pass. Do not stage or commit the generated `.vsix`.

- [ ] **Step 14: Review checkpoint**

Review:

```bash
git diff -- package.json lib/core/sql-canonical-options.js lib/adapters/sql-render-options.js lib/adapters/vscode-config.js lib/core/sql-case-mutations.js tests/config-options.test.js tests/case-when.test.js docs/technical/sql-formatter-architecture.md
git status --short --ignored
git ls-files '*.vsix'
```

Confirm:

- `caseLayout` defaults to `expanded`.
- `compactShort` is opt-in only.
- CASE with comments, nested CASE, and multiline child scopes stays expanded.
- No `.vsix` artifact is tracked.
- Root shims and experimental DDL are unchanged.

- [ ] **Step 15: Commit Task 3**

Run:

```bash
git add package.json lib/core/sql-canonical-options.js lib/adapters/sql-render-options.js lib/adapters/vscode-config.js lib/core/sql-case-mutations.js tests/config-options.test.js tests/case-when.test.js tests/comment-alignment.test.js docs/technical/sql-formatter-architecture.md
git commit -m "feat: add compact case layout strategy"
```

Expected: commit succeeds. If `tests/comment-alignment.test.js` did not change, `git add` will ignore that path.

---

## Final Verification And Summary

After Task 3 is committed, run:

```bash
node tests/select-alignment.test.js
node tests/window-function-spacing.test.js
node tests/token-spacing-policy.test.js
node tests/case-when.test.js
node tests/comment-alignment.test.js
node tests/config-options.test.js
node tests/module-boundary.test.js
node tests/pipeline-idempotency.test.js
npm run test:verify
git diff --check
npm run package:vsix
git status --short --ignored
git log --oneline -6
git ls-files '*.vsix'
```

Expected:

- all tests and packaging pass
- `git diff --check` has no output
- `git status --short --ignored` has no tracked/staged changes; ignored `.vsix` artifacts may appear
- `git ls-files '*.vsix'` has no output
- recent commits include the three implementation commits from this plan

Final response should summarize:

- commits created
- visible behavior changes: top-level ORDER BY list layout and opt-in compact CASE
- preserved behavior: window ORDER BY, function args, `IN`, SELECT leading comma, trailing comment alignment
- verification commands and results
- final git status and `.vsix` tracking check
