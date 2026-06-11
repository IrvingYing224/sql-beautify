# Layout Policy Boundary Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move structured list layout facts into a pure policy module so SELECT, CASE, and list mutation code stop duplicating list indentation rules while preserving current formatter output.

**Architecture:** Add `lib/core/sql-list-layout-policy.js` as the single owner of structured list prefixes, continuation widths, base indentation, item indentation, and CASE-in-list indentation. Keep `sql-list-mutations.js` as the generic mutation pass, keep `sql-select-mutations.js` SELECT-specific, keep `sql-case-mutations.js` CASE-specific, and leave `sql-token-renderer.js` as a thin facade over `sql-render-token-spacing.js`.

**Tech Stack:** CommonJS JavaScript, existing structured formatter core under `lib/core/`, Node.js `assert` tests, local validation with `npm run test:verify` and `npm run package:vsix`.

---

## File Structure

- Read: `docs/superpowers/specs/2026-06-11-layout-policy-boundary-cleanup-design.md`
  - Approved design for this plan.
- Create: `lib/core/sql-list-layout-policy.js`
  - Pure internal policy module for structured list layout facts.
  - Exports only `case_item_indent`, `continuation_width`, `first_item_prefix`, `is_first_item_in_owner`, `item_indent`, `list_base_indent`, and `structured_list_indent`.
- Modify: `lib/core/sql-list-mutations.js`
  - Use `sql-list-layout-policy.js` for list indentation facts.
  - Export only `apply_list_layout_mutations`.
- Modify: `lib/core/sql-select-mutations.js`
  - Continue to call `sql-list-mutations.js` for the generic list mutation pass.
  - Use `sql-list-layout-policy.js` for width and indent calculations.
- Modify: `lib/core/sql-case-mutations.js`
  - Use `sql-list-layout-policy.js` for CASE-in-list indentation and function CASE prefixes.
  - Remove literal list indentation width strings from CASE code.
- Modify: `tests/module-boundary.test.js`
  - Add policy module boundary assertions.
  - Tighten `sql-list-mutations.js` export surface.
  - Guard token renderer facade behavior.
- Modify: `tests/format-invariants.test.js`
  - Add invariant checks for list policy outputs and window ORDER BY exclusion.
- Modify: `docs/technical/sql-formatter-architecture.md`
  - Document `sql-list-layout-policy.js` ownership.

Do not modify root `lib/*.js` shims. Do not modify `lib/experimental/ddl/`. Do not commit `.vsix` artifacts. Local commands in this plan do not use proxy.

---

### Task 1: Add Failing Boundary And Policy Invariant Tests

**Files:**
- Modify: `tests/module-boundary.test.js`
- Modify: `tests/format-invariants.test.js`

- [ ] **Step 1: Confirm baseline and current branch state**

Run:

```bash
git status --short
node tests/module-boundary.test.js
node tests/format-invariants.test.js
```

Expected:

- `git status --short` has no tracked changes.
- Both tests pass before edits.

If either test fails before edits, stop and report the exact failure.

- [ ] **Step 2: Add failing policy module assertions to `tests/module-boundary.test.js`**

Add this require with the other core module requires near the top:

```js
var sqlListLayoutPolicy = require('../lib/core/sql-list-layout-policy');
```

Add these API assertions near the existing structured mutation assertions:

```js
assert.strictEqual(typeof sqlListLayoutPolicy.first_item_prefix, 'function', 'list layout policy must export first_item_prefix');
assert.strictEqual(typeof sqlListLayoutPolicy.continuation_width, 'function', 'list layout policy must export continuation_width');
assert.strictEqual(typeof sqlListLayoutPolicy.list_base_indent, 'function', 'list layout policy must export list_base_indent');
assert.strictEqual(typeof sqlListLayoutPolicy.structured_list_indent, 'function', 'list layout policy must export structured_list_indent');
assert.strictEqual(typeof sqlListLayoutPolicy.item_indent, 'function', 'list layout policy must export item_indent');
assert.strictEqual(typeof sqlListLayoutPolicy.case_item_indent, 'function', 'list layout policy must export case_item_indent');
assert.strictEqual(typeof sqlListLayoutPolicy.is_first_item_in_owner, 'function', 'list layout policy must export is_first_item_in_owner');
```

Replace the current `Object.keys(sqlListMutations).sort()` expectation with:

```js
assert.deepStrictEqual(
	Object.keys(sqlListMutations).sort(),
	['apply_list_layout_mutations'],
	'structured list mutations must expose only the generic list layout mutation pass'
);
```

Add this export surface assertion near the other module export surface checks:

```js
assert.deepStrictEqual(
	Object.keys(sqlListLayoutPolicy).sort(),
	[
		'case_item_indent',
		'continuation_width',
		'first_item_prefix',
		'is_first_item_in_owner',
		'item_indent',
		'list_base_indent',
		'structured_list_indent'
	],
	'list layout policy must expose only pure list layout helpers'
);
```

Add this file existence check near the other core module existence checks:

```js
assert.ok(
	fs.existsSync(path.join(__dirname, '..', 'lib/core/sql-list-layout-policy.js')),
	'structured list layout policy module must exist'
);
```

Add `lib/core/sql-list-layout-policy.js` to the existing module-boundary arrays that reject local navigation helper definitions such as `token_by_index`, `previous_code_token`, `next_code_token`, `active_tokens`, and local `scope_by_id` helpers.

Add these source assertions near the current structured mutation source assertions:

```js
var listLayoutPolicySource = read_source('lib/core/sql-list-layout-policy.js');

assert.ok(
	listMutationsSource.indexOf("require('./sql-list-layout-policy')") >= 0,
	'sql-list-mutations must read list indentation facts from sql-list-layout-policy'
);
assert.ok(
	listLayoutPolicySource.indexOf("require('./sql-scope-model')") >= 0,
	'list layout policy must use scope model ownership for base indentation'
);
assert.strictEqual(
	listLayoutPolicySource.indexOf("require('./sql-format-mutations')"),
	-1,
	'list layout policy must not write mutations'
);
```

- [ ] **Step 3: Add failing policy invariant checks to `tests/format-invariants.test.js`**

Add this require near the other core requires:

```js
var listLayoutPolicy = require('../lib/core/sql-list-layout-policy');
```

Add this helper near `extract_structured_nodes`:

```js
function build_structured_document(sql, config) {
	config = Object.assign({ dialect: 'generic' }, config || {});
	var doc = formatDocument.from_text(sql, config);
	doc.scopes = scopeModel.build(doc, config);
	formatNavigation.attach_scope_index(doc);
	doc.nodes = nodes.extract(doc, config);
	return doc;
}

function first_item_for_owner(extractedNodes, ownerKind) {
	for (var i = 0; i < (extractedNodes.selectItems || []).length; i++) {
		if (extractedNodes.selectItems[i].ownerKind == ownerKind) {
			return extractedNodes.selectItems[i];
		}
	}
	return null;
}
```

Add these invariant assertions near the existing GROUP BY and ORDER BY owner assertions:

```js
assert.strictEqual(listLayoutPolicy.first_item_prefix('selectList'), 'SELECT  ', 'SELECT list first item prefix is stable');
assert.strictEqual(listLayoutPolicy.first_item_prefix('groupByList'), 'GROUP BY  ', 'GROUP BY list first item prefix is stable');
assert.strictEqual(listLayoutPolicy.first_item_prefix('orderByList'), 'ORDER BY  ', 'ORDER BY list first item prefix is stable');
assert.strictEqual(listLayoutPolicy.continuation_width('selectList'), 7, 'SELECT continuation width is stable');
assert.strictEqual(listLayoutPolicy.continuation_width('groupByList'), 9, 'GROUP BY continuation width is stable');
assert.strictEqual(listLayoutPolicy.continuation_width('orderByList'), 9, 'ORDER BY continuation width is stable');

var selectPolicyDoc = build_structured_document([
	'select a,',
	'b',
	'from t'
].join('\n'));
var selectPolicyItem = first_item_for_owner(selectPolicyDoc.nodes, 'selectList');
assert.strictEqual(
	listLayoutPolicy.item_indent(selectPolicyDoc, selectPolicyDoc.nodes, selectPolicyItem),
	'SELECT  ',
	'SELECT first item indentation is policy-owned'
);
assert.strictEqual(
	listLayoutPolicy.case_item_indent(selectPolicyDoc, selectPolicyDoc.nodes, selectPolicyItem),
	'       ',
	'SELECT first CASE item indentation is policy-owned'
);

var groupPolicyItem = first_item_for_owner(groupNodes, 'groupByList');
assert.strictEqual(
	listLayoutPolicy.structured_list_indent(groupDoc, groupNodes, groupPolicyItem.ownerScopeId, groupPolicyItem.ownerKind),
	'         ',
	'GROUP BY continuation indentation is policy-owned'
);
assert.strictEqual(
	listLayoutPolicy.case_item_indent(groupDoc, groupNodes, groupPolicyItem),
	'         ',
	'GROUP BY CASE item indentation is policy-owned'
);

var orderPolicyItem = first_item_for_owner(orderNodes, 'orderByList');
assert.strictEqual(
	listLayoutPolicy.structured_list_indent(orderDoc, orderNodes, orderPolicyItem.ownerScopeId, orderPolicyItem.ownerKind),
	'         ',
	'ORDER BY continuation indentation is policy-owned'
);
assert.strictEqual(
	listLayoutPolicy.case_item_indent(orderDoc, orderNodes, orderPolicyItem),
	'          ',
	'ORDER BY CASE item indentation is policy-owned'
);

var windowOnlyDoc = build_structured_document(
	'select row_number() over(partition by ds order by pay_time desc, created_at desc) as rn from orders'
);
assert.strictEqual(
	windowOnlyDoc.nodes.selectSpans.some(function(span) { return span.kind == 'orderByList'; }),
	false,
	'window ORDER BY must remain outside top-level orderByList extraction'
);
```

- [ ] **Step 4: Run the targeted tests and confirm they fail for missing policy module**

Run:

```bash
node tests/module-boundary.test.js
```

Expected: FAIL with `Cannot find module '../lib/core/sql-list-layout-policy'` or an equivalent missing module failure.

Run:

```bash
node tests/format-invariants.test.js
```

Expected: FAIL with `Cannot find module '../lib/core/sql-list-layout-policy'` or an equivalent missing module failure.

Do not commit this failing state.

---

### Task 2: Create Policy Module And Move List Mutation Helper Ownership

**Files:**
- Create: `lib/core/sql-list-layout-policy.js`
- Modify: `lib/core/sql-list-mutations.js`
- Modify: `tests/module-boundary.test.js`
- Modify: `tests/format-invariants.test.js`

- [ ] **Step 1: Create `lib/core/sql-list-layout-policy.js`**

Create this complete file:

```js
var sqlFormatUtils = require('./sql-format-utils');
var sqlScopeModel = require('./sql-scope-model');

var repeat_space = sqlFormatUtils.repeat_space;

function find_list_span(nodes, ownerScopeId) {
	for (var i = 0; i < (nodes.selectSpans || []).length; i++) {
		if (nodes.selectSpans[i].id == ownerScopeId) {
			return nodes.selectSpans[i];
		}
	}
	return null;
}

function first_item_prefix(ownerKind) {
	if (ownerKind == 'groupByList') {
		return 'GROUP BY  ';
	}
	if (ownerKind == 'orderByList') {
		return 'ORDER BY  ';
	}
	return 'SELECT  ';
}

function continuation_width(ownerKind) {
	if (ownerKind == 'groupByList' || ownerKind == 'orderByList') {
		return 9;
	}
	return 7;
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
	return list_base_indent(document, nodes, ownerScopeId) + repeat_space(continuation_width(ownerKind));
}

function is_first_item_in_owner(nodes, item) {
	var items = nodes && nodes.selectItems ? nodes.selectItems : [];
	for (var i = 0; i < items.length; i++) {
		if (items[i].ownerScopeId != item.ownerScopeId) {
			continue;
		}
		return items[i].id == item.id;
	}
	return false;
}

function item_indent(document, nodes, item) {
	var baseIndent = list_base_indent(document, nodes, item.ownerScopeId);
	return item.id == 'selectItem:0'
		? baseIndent + first_item_prefix(item.ownerKind)
		: structured_list_indent(document, nodes, item.ownerScopeId, item.ownerKind) + ',';
}

function case_item_indent(document, nodes, item) {
	var baseIndent = list_base_indent(document, nodes, item.ownerScopeId);
	if (item.ownerKind == 'orderByList') {
		return baseIndent + repeat_space(10);
	}
	if (item.ownerKind == 'groupByList') {
		return baseIndent + repeat_space(9);
	}
	return item.id == 'selectItem:0'
		? baseIndent + repeat_space(7)
		: baseIndent + repeat_space(8);
}

exports.first_item_prefix = first_item_prefix;
exports.continuation_width = continuation_width;
exports.list_base_indent = list_base_indent;
exports.structured_list_indent = structured_list_indent;
exports.item_indent = item_indent;
exports.case_item_indent = case_item_indent;
exports.is_first_item_in_owner = is_first_item_in_owner;
```

- [ ] **Step 2: Update `lib/core/sql-list-mutations.js` imports**

Replace:

```js
var sqlFormatMutations = require('./sql-format-mutations');
var sqlFormatUtils = require('./sql-format-utils');
var sqlScopeModel = require('./sql-scope-model');

var repeat_space = sqlFormatUtils.repeat_space;
```

with:

```js
var sqlFormatMutations = require('./sql-format-mutations');
var sqlListLayoutPolicy = require('./sql-list-layout-policy');
```

- [ ] **Step 3: Remove moved helper implementations from `lib/core/sql-list-mutations.js`**

Delete the local definitions of these functions from `sql-list-mutations.js`; each definition is now owned by `sql-list-layout-policy.js`:

- `find_list_span`
- `first_item_prefix`
- `continuation_width`
- `list_base_indent`
- `structured_list_indent`
- `item_indent`
- `is_first_item_in_owner`

Then replace internal calls as follows:

```js
is_first_item_in_owner(nodes, item)
```

becomes:

```js
sqlListLayoutPolicy.is_first_item_in_owner(nodes, item)
```

Every call shaped like:

```js
structured_list_indent(document, nodes, ownerScopeId, ownerKind)
```

becomes:

```js
sqlListLayoutPolicy.structured_list_indent(document, nodes, ownerScopeId, ownerKind)
```

- [ ] **Step 4: Tighten `lib/core/sql-list-mutations.js` exports**

Replace the export block:

```js
exports.apply_list_layout_mutations = apply_list_layout_mutations;
exports.structured_list_indent = structured_list_indent;
exports.item_indent = item_indent;
```

with:

```js
exports.apply_list_layout_mutations = apply_list_layout_mutations;
```

- [ ] **Step 5: Run boundary and invariant tests**

Run:

```bash
node tests/module-boundary.test.js
node tests/format-invariants.test.js
```

Expected:

- `tests/format-invariants.test.js` passes.
- `tests/module-boundary.test.js` passes.

- [ ] **Step 6: Run list-specific regression**

Run:

```bash
node tests/select-alignment.test.js
node tests/window-function-spacing.test.js
node tests/token-spacing-policy.test.js
```

Expected: all pass. If any output changes, fix `sql-list-mutations.js` to use the same policy values as the previous helper implementation.

- [ ] **Step 7: Commit Task 2**

Run:

```bash
git add lib/core/sql-list-layout-policy.js lib/core/sql-list-mutations.js tests/module-boundary.test.js tests/format-invariants.test.js
git commit -m "refactor: extract list layout policy"
```

Expected: commit succeeds. Do not include `.vsix` files.

---

### Task 3: Migrate SELECT Mutations To Policy Helpers

**Files:**
- Modify: `lib/core/sql-select-mutations.js`
- Modify: `tests/module-boundary.test.js`

- [ ] **Step 1: Add policy import to `lib/core/sql-select-mutations.js`**

First add this source assertion near the existing list mutation source assertions in `tests/module-boundary.test.js`:

```js
assert.ok(
	selectMutationsSource.indexOf("require('./sql-list-layout-policy')") >= 0,
	'sql-select-mutations must read list indentation facts from sql-list-layout-policy'
);
```

Run:

```bash
node tests/module-boundary.test.js
```

Expected: FAIL with the message `sql-select-mutations must read list indentation facts from sql-list-layout-policy`.

Then update `lib/core/sql-select-mutations.js`.

At the top, keep the existing list mutation import and add:

```js
var sqlListLayoutPolicy = require('./sql-list-layout-policy');
```

The top imports should include both:

```js
var sqlListMutations = require('./sql-list-mutations');
var sqlListLayoutPolicy = require('./sql-list-layout-policy');
```

- [ ] **Step 2: Replace SELECT width and indentation helper calls**

In `lib/core/sql-select-mutations.js`, replace these calls:

```js
sqlListMutations.item_indent(document, nodes, item)
```

with:

```js
sqlListLayoutPolicy.item_indent(document, nodes, item)
```

Replace these calls:

```js
sqlListMutations.structured_list_indent(document, nodes, item.ownerScopeId, item.ownerKind)
```

with:

```js
sqlListLayoutPolicy.structured_list_indent(document, nodes, item.ownerScopeId, item.ownerKind)
```

Replace this call:

```js
sqlListMutations.structured_list_indent(document, nodes, span.id, span.kind)
```

with:

```js
sqlListLayoutPolicy.structured_list_indent(document, nodes, span.id, span.kind)
```

Leave this call unchanged because it invokes the mutation pass:

```js
sqlListMutations.apply_list_layout_mutations(document, nodes, mutations, config);
```

- [ ] **Step 3: Confirm no SELECT code consumes indentation from the mutation module**

Run:

```bash
rg -n "sqlListMutations\\.(item_indent|structured_list_indent)" lib/core/sql-select-mutations.js
```

Expected: no output.

Run:

```bash
rg -n "sqlListMutations\\.apply_list_layout_mutations" lib/core/sql-select-mutations.js
```

Expected: one match.

- [ ] **Step 4: Run SELECT-focused tests**

Run:

```bash
node tests/select-alignment.test.js
node tests/comment-alignment.test.js
node tests/window-function-spacing.test.js
node tests/token-spacing-policy.test.js
node tests/pipeline-idempotency.test.js
```

Expected: all pass.

- [ ] **Step 5: Run boundary test**

Run:

```bash
node tests/module-boundary.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit Task 3**

Run:

```bash
git add lib/core/sql-select-mutations.js tests/module-boundary.test.js
git commit -m "refactor: route select layout widths through policy"
```

Expected: commit succeeds. Do not include `.vsix` files.

---

### Task 4: Migrate CASE Mutations To Policy Helpers

**Files:**
- Modify: `lib/core/sql-case-mutations.js`
- Modify: `tests/module-boundary.test.js`
- Modify: `tests/format-invariants.test.js`

- [ ] **Step 1: Add policy import to `lib/core/sql-case-mutations.js`**

First add these source assertions near the existing structured mutation source assertions in `tests/module-boundary.test.js`:

```js
var caseMutationsSource = read_source('lib/core/sql-case-mutations.js');

assert.ok(
	caseMutationsSource.indexOf("require('./sql-list-layout-policy')") >= 0,
	'sql-case-mutations must read list indentation facts from sql-list-layout-policy'
);
assert.ok(
	/sqlListLayoutPolicy\.case_item_indent\s*\(/.test(caseMutationsSource),
	'sql-case-mutations must use policy-owned CASE-in-list indentation'
);
[
	"baseIndent + '          '",
	"baseIndent + '         '",
	"baseIndent + '       '",
	"baseIndent + '        '"
].forEach(function(fragment) {
	assert.strictEqual(
		caseMutationsSource.indexOf(fragment),
		-1,
		'sql-case-mutations must not hard-code list indentation fragment: ' + fragment
	);
});
```

Run:

```bash
node tests/module-boundary.test.js
```

Expected: FAIL with the message `sql-case-mutations must read list indentation facts from sql-list-layout-policy`.

Then update `lib/core/sql-case-mutations.js`.

Add this import with the other core imports:

```js
var sqlListLayoutPolicy = require('./sql-list-layout-policy');
```

- [ ] **Step 2: Replace CASE base indentation logic**

In `case_base_indent(document, nodes, caseNode)`, replace the current list item block:

```js
	var item = select_item_for_case_node(nodes, caseNode);
	if (item) {
		var selectSpan = select_span_for_item(nodes, item);
		var baseIndent = select_base_indent(document, selectSpan);
		if (item.ownerKind == 'orderByList') {
			return baseIndent + '          ';
		}
		if (item.ownerKind == 'groupByList') {
			return baseIndent + '         ';
		}
		return item.id == 'selectItem:0'
			? baseIndent + '       '
			: baseIndent + '        ';
	}
```

with:

```js
	var item = select_item_for_case_node(nodes, caseNode);
	if (item) {
		return sqlListLayoutPolicy.case_item_indent(document, nodes, item);
	}
```

- [ ] **Step 3: Replace CASE function-prefix list indentation literals**

In `select_item_prefix_before_case(document, nodes, caseNode)`, replace:

```js
	var selectSpan = select_span_for_item(nodes, item);
	var baseIndent = select_base_indent(document, selectSpan);
	var listPrefix = item.ownerKind == 'groupByList'
		? baseIndent + '         '
		: item.id == 'selectItem:0'
			? baseIndent + 'SELECT  '
			: baseIndent + '       ,';
```

with this behavior-preserving policy-backed code:

```js
	var baseIndent = sqlListLayoutPolicy.list_base_indent(document, nodes, item.ownerScopeId);
	var listPrefix = item.ownerKind == 'groupByList'
		? sqlListLayoutPolicy.structured_list_indent(document, nodes, item.ownerScopeId, item.ownerKind)
		: item.id == 'selectItem:0'
			? baseIndent + sqlListLayoutPolicy.first_item_prefix(item.ownerKind)
			: baseIndent + sqlListLayoutPolicy.structured_list_indent(document, nodes, item.ownerScopeId, 'selectList').slice(baseIndent.length) + ',';
```

This preserves the previous non-GROUP fallback width without embedding literal spacing in CASE code.

- [ ] **Step 4: Remove unused CASE-local list span helpers**

After the replacements, remove the local definitions of these functions from `sql-case-mutations.js`:

- `select_span_for_item`
- `select_base_indent`

Run:

```bash
rg -n "select_span_for_item|select_base_indent" lib/core/sql-case-mutations.js
```

Expected: no output.

- [ ] **Step 5: Confirm CASE code no longer embeds list indentation literals**

Run:

```bash
rg -n "baseIndent \\+ ' {7,10}'|baseIndent \\+ '       '|baseIndent \\+ '        '|baseIndent \\+ '         '|baseIndent \\+ '          '" lib/core/sql-case-mutations.js
```

Expected: no output.

Run:

```bash
rg -n "sqlListLayoutPolicy\\.(case_item_indent|list_base_indent|structured_list_indent|first_item_prefix)" lib/core/sql-case-mutations.js
```

Expected: matches for `case_item_indent`, `list_base_indent`, `structured_list_indent`, and `first_item_prefix`.

- [ ] **Step 6: Run CASE and alignment tests**

Run:

```bash
node tests/case-when.test.js
node tests/select-alignment.test.js
node tests/comment-alignment.test.js
node tests/window-function-spacing.test.js
node tests/pipeline-idempotency.test.js
node tests/module-boundary.test.js
node tests/format-invariants.test.js
```

Expected: all pass.

If a formatter output changes, inspect only the changed SQL case. Preserve the previous output unless the change is required to satisfy an explicit assertion from this plan.

- [ ] **Step 7: Commit Task 4**

Run:

```bash
git add lib/core/sql-case-mutations.js tests/module-boundary.test.js tests/format-invariants.test.js
git commit -m "refactor: route case list indentation through policy"
```

Expected: commit succeeds. Do not include `.vsix` files.

---

### Task 5: Update Technical Documentation And Run Full Verification

**Files:**
- Modify: `docs/technical/sql-formatter-architecture.md`

- [ ] **Step 1: Update architecture boundary documentation**

In `docs/technical/sql-formatter-architecture.md`, add this bullet near the existing core structured module bullets:

```markdown
- `lib/core/sql-list-layout-policy.js`: pure structured list layout facts for SELECT, GROUP BY, and top-level ORDER BY prefixes, continuation indentation, item indentation, and CASE-in-list indentation. Mutation modules consume this policy instead of duplicating list-kind spacing widths.
```

Update the structured mutation bullet for `sql-list-mutations.js` to say:

```markdown
- `sql-list-mutations.js`: generic SELECT/GROUP BY/top-level ORDER BY list layout and comma placement mutations; list indentation facts come from `sql-list-layout-policy.js`
```

Update the renderer paragraph so it continues to say:

```markdown
Token-adjacency spacing policy lives in `sql-render-token-spacing.js`; final line rendering, planned-width calculation, and snippet rendering must share that policy. `sql-token-renderer.js` is the mutation-facing facade and must not carry private comma, parenthesis, operator, or window spacing rules.
```

- [ ] **Step 2: Run targeted verification**

Run:

```bash
node tests/module-boundary.test.js
node tests/format-invariants.test.js
node tests/select-alignment.test.js
node tests/case-when.test.js
node tests/comment-alignment.test.js
node tests/window-function-spacing.test.js
node tests/token-spacing-policy.test.js
node tests/pipeline-idempotency.test.js
```

Expected: all pass.

- [ ] **Step 3: Run full local verification**

Run:

```bash
npm run test:verify
npm run package:vsix
git diff --check
```

Expected:

- `npm run test:verify` passes.
- `npm run package:vsix` succeeds and may create an ignored local `.vsix` file.
- `git diff --check` has no output.

Do not use `ALL_PROXY` for these local commands.

- [ ] **Step 4: Confirm no VSIX artifact is tracked**

Run:

```bash
git ls-files '*.vsix'
git status --short
```

Expected:

- `git ls-files '*.vsix'` prints no tracked VSIX paths.
- `git status --short` shows only intended tracked source, test, and docs changes before the final commit.

- [ ] **Step 5: Commit Task 5**

Run:

```bash
git add docs/technical/sql-formatter-architecture.md
git commit -m "docs: document list layout policy boundary"
```

Expected: commit succeeds. Do not include `.vsix` files.

---

## Final Review Checklist

Run this after Task 5:

```bash
git log --oneline --decorate -6
git status --short --branch
```

Expected:

- Recent commits include:
  - `refactor: extract list layout policy`
  - `refactor: route select layout widths through policy`
  - `refactor: route case list indentation through policy`
  - `docs: document list layout policy boundary`
- Working tree has no tracked changes.
- Ignored local `.vsix` files may exist but are not tracked.

Before reporting completion, summarize:

- commits created
- targeted verification commands and results
- `npm run test:verify` result
- `npm run package:vsix` result
- `git diff --check` result
- `git status --short --branch` result
