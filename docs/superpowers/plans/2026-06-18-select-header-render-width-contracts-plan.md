# Select Header and Render Width Contracts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make SELECT header modifiers structural span-owned facts and make comment alignment width planning reuse renderer-owned pre-alignment line facts.

**Architecture:** Keep the existing `FormatDocument -> ScopeModel -> FormatNodes -> MutationPlan -> StructuredRenderer` pipeline. Add SELECT header metadata to `selectList` spans, owner-local ordering to list items, and a renderer facts facade that computes comment-alignment widths from the same render helper path used by `sql-structured-renderer.js`.

**Tech Stack:** CommonJS JavaScript, existing core modules under `lib/core/`, Node.js `assert` tests, local validation with targeted `node tests/*.test.js`, `npm run test:verify`, and `git diff --check`.

---

## File Structure

- Read: `docs/superpowers/specs/2026-06-18-select-header-render-width-design.md`
  - Approved design for this plan.
- Read: `docs/technical/sql-formatter-architecture.md`
  - Core pipeline and module-boundary constraints.
- Modify: `lib/core/sql-list-nodes.js`
  - Add SELECT header modifier detection and `itemsStartTokenIndex` on `selectList` spans.
- Modify: `lib/core/sql-select-item-nodes.js`
  - Start SELECT item extraction from `span.itemsStartTokenIndex` and assign `ordinalInOwner`.
- Modify: `lib/core/sql-list-layout-policy.js`
  - Use `ordinalInOwner` for first-item decisions and add a header-modifier-aware first item indent.
- Modify: `lib/core/sql-list-mutations.js`
  - Use owner-local first-item helpers; no SELECT modifier special cases.
- Modify: `lib/core/sql-select-mutations.js`
  - Remove modifier-as-item repair logic, add header modifier line-break/spacing mutations, and switch first-item checks to `ordinalInOwner`.
- Create: `lib/core/sql-render-line-facts.js`
  - Renderer-owned pre-comment line facts for width planning.
- Modify: `lib/core/sql-render-width.js`
  - Keep `create_width_context` as the public facade but delegate core line render facts to `sql-render-line-facts.js`.
- Modify: `lib/core/sql-format-invariants.js`
  - Add SELECT header ownership invariants and comment alignment planned-vs-rendered width invariants.
- Modify: `lib/core/sql-format-mutations.js`
  - Store optional renderer-width facts on comment alignment mutations.
- Modify: `lib/core/sql-formatter.js`
  - Pass config into mutation-plan invariant checks.
- Modify: `tests/format-invariants.test.js`
  - Add SELECT header shape, owner-local ordinal, and invariant rejection tests.
- Modify: `tests/select-alignment.test.js`
  - Update expected SELECT DISTINCT/ALL behavior and add compact/nested modifier cases.
- Modify: `tests/comment-alignment.test.js`
  - Add/keep one-pass production-style comment alignment guards.
- Modify: `tests/render-width.test.js`
  - Add facade/facts equivalence tests for indent, moved comma prefix, line join, and token spacing.
- Modify: `tests/module-boundary.test.js`
  - Add renderer facts module boundary checks and forbid old SELECT modifier workaround helpers.

Do not modify root `lib/*.js` shims. Do not modify `lib/adapters/`, `lib/experimental/ddl/`, `package.json`, `README.md`, or `.vsix` artifacts. Local validation commands in this plan do not use proxy.

---

### Task 1: Add Failing SELECT Header Contract Tests

**Files:**
- Modify: `tests/format-invariants.test.js`
- Modify: `tests/select-alignment.test.js`
- Modify: `tests/module-boundary.test.js`

- [ ] **Step 1: Confirm baseline state**

Run:

```bash
git status --short
node tests/format-invariants.test.js
node tests/select-alignment.test.js
node tests/module-boundary.test.js
```

Expected:

- `git status --short` may show unrelated untracked files, but no tracked implementation files should be modified.
- All three tests pass before edits.

If any test fails before edits, stop and inspect the exact failure before continuing.

- [ ] **Step 2: Add SELECT header node-shape helpers to `tests/format-invariants.test.js`**

Add these helpers after `token_values`:

```js
function token_values_for_owner(extractedNodes, ownerScopeId) {
	return (extractedNodes.selectItems || []).filter(function(item) {
		return item.ownerScopeId == ownerScopeId;
	}).map(function(item) {
		return token_values(item.tokens);
	});
}

function select_span_starting_on(extractedNodes, lineIndex) {
	for (var i = 0; i < (extractedNodes.selectSpans || []).length; i++) {
		if (extractedNodes.selectSpans[i].kind == 'selectList'
			&& extractedNodes.selectSpans[i].startLine == lineIndex) {
			return extractedNodes.selectSpans[i];
		}
	}
	return null;
}
```

- [ ] **Step 3: Add failing SELECT modifier span assertions to `tests/format-invariants.test.js`**

Add this block after the existing `nodeShape` SELECT item assertions:

```js
var distinctShape = extract_structured_nodes('select distinct a, b from t');
var distinctSpan = select_span_starting_on(distinctShape, 0);

assert.ok(distinctSpan, 'SELECT DISTINCT span must be extracted');
assert.deepStrictEqual(
	{
		kind: distinctSpan.kind,
		modifierKind: distinctSpan.header && distinctSpan.header.modifier
			? distinctSpan.header.modifier.kind
			: null,
		itemsStartTokenIndex: distinctSpan.itemsStartTokenIndex
	},
	{
		kind: 'selectList',
		modifierKind: 'DISTINCT',
		itemsStartTokenIndex: 2
	},
	'SELECT DISTINCT must model DISTINCT as a span header modifier'
);
assert.deepStrictEqual(
	token_values_for_owner(distinctShape, distinctSpan.id),
	[
		['a'],
		['b']
	],
	'SELECT DISTINCT items must contain only real fields'
);
assert.deepStrictEqual(
	distinctShape.selectItems.filter(function(item) {
		return item.ownerScopeId == distinctSpan.id;
	}).map(function(item) {
		return item.ordinalInOwner;
	}),
	[0, 1],
	'SELECT DISTINCT items must have owner-local ordinals'
);
assert.ok(
	!distinctShape.selectItems.some(function(item) {
		return token_values(item.tokens).indexOf('distinct') >= 0;
	}),
	'DISTINCT must not be extracted as a select item token'
);

var allShape = extract_structured_nodes('select all a, b from t');
var allSpan = select_span_starting_on(allShape, 0);
assert.strictEqual(
	allSpan.header && allSpan.header.modifier && allSpan.header.modifier.kind,
	'ALL',
	'SELECT ALL must model ALL as a span header modifier'
);
assert.deepStrictEqual(
	token_values_for_owner(allShape, allSpan.id),
	[
		['a'],
		['b']
	],
	'SELECT ALL items must contain only real fields'
);

var countDistinctShape = extract_structured_nodes('select count(distinct a) as c from t');
var countDistinctSpan = select_span_starting_on(countDistinctShape, 0);
assert.strictEqual(
	countDistinctSpan.header && countDistinctSpan.header.modifier,
	null,
	'COUNT(DISTINCT ...) must not become a SELECT header modifier'
);
assert.deepStrictEqual(
	token_values_for_owner(countDistinctShape, countDistinctSpan.id),
	[
		['count', '(', 'distinct', 'a', ')', 'as', 'c']
	],
	'COUNT(DISTINCT ...) must remain inside the real select item'
);
```

Expected failure before implementation: `distinctSpan.header` is undefined or `itemsStartTokenIndex` is undefined.

- [ ] **Step 4: Add compact SELECT modifier output tests to `tests/select-alignment.test.js`**

Replace the current `distinct_header_select_actual` and `all_header_select_actual` assertion blocks with these stricter cases:

```js
run_case(
	'compact SELECT DISTINCT renders modifier as header and aligns fields',
	'SELECT DISTINCT a, b FROM t',
	[
		'SELECT DISTINCT',
		'        a',
		'       ,b',
		'FROM t'
	].join('\n')
);

run_case(
	'multiline SELECT DISTINCT keeps modifier header and aligned fields',
	[
		'SELECT DISTINCT',
		'  t.idx_id AS idx_cd,  -- 指标资产代码',
		'  t.idx_nm AS idx_nm,  -- 指标名称',
		'  t.orgnumber AS orig_org_cd  -- 原组织代码',
		'FROM t'
	].join('\n'),
	[
		'SELECT DISTINCT',
		'        t.idx_id    AS idx_cd       -- 指标资产代码',
		'       ,t.idx_nm    AS idx_nm       -- 指标名称',
		'       ,t.orgnumber AS orig_org_cd  -- 原组织代码',
		'FROM t'
	].join('\n')
);

run_case(
	'compact SELECT ALL renders modifier as header and aligns fields',
	'SELECT ALL a, b FROM t',
	[
		'SELECT ALL',
		'        a',
		'       ,b',
		'FROM t'
	].join('\n')
);

var nestedModifierActual = format([
	'select distinct a, b',
	'from (select all c, d from src) s'
].join('\n'));
assert.strictEqual(
	format(nestedModifierActual),
	nestedModifierActual,
	'nested SELECT DISTINCT/ALL modifier formatting must be idempotent\n--- actual ---\n' + nestedModifierActual
);
assert.ok(
	nestedModifierActual.indexOf('SELECT DISTINCT\n        a\n       ,b') >= 0,
	'outer SELECT DISTINCT fields must align below header\n--- actual ---\n' + nestedModifierActual
);
assert.ok(
	nestedModifierActual.indexOf('SELECT ALL\n            c\n           ,d') >= 0,
	'inner SELECT ALL fields must align below header\n--- actual ---\n' + nestedModifierActual
);
```

Expected failure before implementation: compact `SELECT DISTINCT a, b` still renders `SELECT  DISTINCT a`.

- [ ] **Step 5: Add boundary checks for old workaround names to `tests/module-boundary.test.js`**

Add these assertions after `var selectMutationsSource = read_source('lib/core/sql-select-mutations.js');` and the existing source variable declarations:

```js
var selectItemNodesSource = read_source('lib/core/sql-select-item-nodes.js');

[
	'is_select_modifier_item',
	'has_select_modifier_header_line'
].forEach(function(functionName) {
	assert.strictEqual(
		new RegExp('function\\s+' + functionName + '\\s*\\(').test(selectItemNodesSource + selectMutationsSource),
		false,
		'SELECT modifier handling must be modeled on select spans, not workaround helper ' + functionName
	);
});
```

Expected failure before implementation: both helper function names still exist.

- [ ] **Step 6: Run the failing tests**

Run:

```bash
node tests/format-invariants.test.js
node tests/select-alignment.test.js
node tests/module-boundary.test.js
```

Expected: failures from the new SELECT header contract assertions. Keep the failure output for implementation reference.

- [ ] **Step 7: Commit failing SELECT header tests**

Run:

```bash
git add tests/format-invariants.test.js tests/select-alignment.test.js tests/module-boundary.test.js
git commit -m "test: specify select header modifier contracts"
```

Expected: commit succeeds with only test files.

---

### Task 2: Model SELECT Header Modifiers On List Spans

**Files:**
- Modify: `lib/core/sql-list-nodes.js`
- Modify: `lib/core/sql-select-item-nodes.js`
- Modify: `lib/core/sql-format-invariants.js`

- [ ] **Step 1: Add span header helpers to `lib/core/sql-list-nodes.js`**

Add this require near the existing requires:

```js
var sqlFormatNavigation = require('./sql-format-navigation');
```

If `sqlFormatNavigation` is already required, do not duplicate it.

Add these helpers after `is_order_by_start`:

```js
function next_active_token(document, token) {
	return sqlFormatNavigation.next_code_token(document, token);
}

function select_header_for_token(document, token) {
	var modifier = null;
	var firstItemToken = next_active_token(document, token);

	if (firstItemToken
		&& firstItemToken.line >= token.line
		&& firstItemToken.type == 'word'
		&& /^(DISTINCT|ALL)$/i.exec(firstItemToken.value)) {
		modifier = {
			kind: firstItemToken.value.toUpperCase(),
			tokenId: firstItemToken.id,
			tokenIndex: firstItemToken.index,
			line: firstItemToken.line
		};
		firstItemToken = next_active_token(document, firstItemToken);
	}

	return {
		selectTokenId: token.id,
		selectTokenIndex: token.index,
		modifier: modifier,
		itemsStartTokenIndex: firstItemToken ? firstItemToken.index : null
	};
}
```

This helper records the next active token during span opening. After each span is closed, Task 2 Step 2 must normalize `itemsStartTokenIndex` to `null` if it is greater than the final `span.endTokenIndex`; this prevents malformed or incomplete SELECT spans from claiming a token outside their own list.

- [ ] **Step 2: Attach header facts when opening a `selectList` span**

In `create_list_spans`, change the object pushed for `is_word(token, 'SELECT')` from:

```js
activeSpans.push({
	id: 'selectList:' + nextSpanId++,
	kind: 'selectList',
	startTokenIndex: token.index,
	endTokenIndex: token.index,
	startLine: token.line,
	endLine: token.line,
	parenDepth: parenDepth,
	caseDepth: caseDepth
});
```

to:

```js
var selectHeader = select_header_for_token(document, token);
activeSpans.push({
	id: 'selectList:' + nextSpanId++,
	kind: 'selectList',
	startTokenIndex: token.index,
	endTokenIndex: token.index,
	startLine: token.line,
	endLine: token.line,
	header: {
		selectTokenId: selectHeader.selectTokenId,
		selectTokenIndex: selectHeader.selectTokenIndex,
		modifier: selectHeader.modifier
	},
	itemsStartTokenIndex: selectHeader.itemsStartTokenIndex,
	parenDepth: parenDepth,
	caseDepth: caseDepth
});
```

Do not add header fields to `groupByList` or `orderByList` spans.

Before returning `spans` from `create_list_spans`, add this cleanup inside the existing cleanup loop, after deleting depth fields:

```js
if (spans[cleanup].kind == 'selectList'
	&& typeof spans[cleanup].itemsStartTokenIndex == 'number'
	&& spans[cleanup].itemsStartTokenIndex > spans[cleanup].endTokenIndex) {
	spans[cleanup].itemsStartTokenIndex = null;
}
```

- [ ] **Step 3: Update item extraction start in `lib/core/sql-select-item-nodes.js`**

Remove the whole `is_select_modifier_item` function.

In `push_item`, remove this block:

```js
if (is_select_modifier_item(span, itemTokens)) {
	return;
}
```

Change the item object to include owner-local ordinal:

```js
var ordinal = owner_item_count(items, span.id);
items.push({
	id: 'selectItem:' + items.length,
	ownerScopeId: span.id,
	ownerKind: span.kind,
	ordinalInOwner: ordinal,
	startTokenIndex: itemTokens[0].index,
	endTokenIndex: itemTokens[itemTokens.length - 1].index,
	startLine: itemTokens[0].line,
	endLine: itemTokens[itemTokens.length - 1].line,
	tokens: itemTokens,
	separatorId: separatorId
});
```

Add this helper above `find_select_items`:

```js
function owner_item_count(items, ownerScopeId) {
	var count = 0;
	for (var i = 0; i < items.length; i++) {
		if (items[i].ownerScopeId == ownerScopeId) {
			count += 1;
		}
	}
	return count;
}
```

Change the per-span `start` assignment from:

```js
var start = span.startTokenIndex + 1;
```

to:

```js
var start = typeof span.itemsStartTokenIndex == 'number'
	? span.itemsStartTokenIndex
	: span.startTokenIndex + 1;
```

After computing `trailingTokens`, keep the existing `push_line_split_items(span, trailingTokens, null);`.

- [ ] **Step 4: Add SELECT header invariants to `lib/core/sql-format-invariants.js`**

Add these helpers after `assert_separator_ownership`:

```js
function item_tokens_contain_token_id(item, tokenId) {
	for (var i = 0; i < (item.tokens || []).length; i++) {
		if (item.tokens[i].id == tokenId) {
			return true;
		}
	}
	return false;
}

function assert_select_header_ownership(nodes) {
	var extracted = nodes || {};
	var spans = extracted.selectSpans || [];
	var items = extracted.selectItems || [];
	var ordinalByOwner = {};

	for (var i = 0; i < spans.length; i++) {
		var span = spans[i];
		if (span.kind == 'selectList') {
			if (!span.header || typeof span.header.selectTokenId == 'undefined') {
				throw new Error(span.id + ' must expose SELECT header metadata');
			}
			if (span.header.modifier) {
				if (span.header.modifier.tokenIndex < span.startTokenIndex
					|| span.header.modifier.tokenIndex > span.endTokenIndex) {
					throw new Error(span.id + ' modifier token must stay inside select span');
				}
				if (typeof span.itemsStartTokenIndex == 'number'
					&& span.itemsStartTokenIndex <= span.header.modifier.tokenIndex) {
					throw new Error(span.id + ' itemsStartTokenIndex must follow modifier token');
				}
				for (var j = 0; j < items.length; j++) {
					if (items[j].ownerScopeId == span.id
						&& item_tokens_contain_token_id(items[j], span.header.modifier.tokenId)) {
						throw new Error(span.id + ' modifier token must not appear in select item ' + items[j].id);
					}
				}
			}
		}
	}

	for (i = 0; i < items.length; i++) {
		var key = String(items[i].ownerScopeId);
		if (typeof ordinalByOwner[key] == 'undefined') {
			ordinalByOwner[key] = 0;
		}
		if (items[i].ordinalInOwner !== ordinalByOwner[key]) {
			throw new Error(items[i].id + ' ordinalInOwner must be contiguous inside owner ' + key);
		}
		ordinalByOwner[key] += 1;
	}
}
```

Update `assert_document_safe` from:

```js
assert_separator_ownership(document, nodes);
```

to:

```js
assert_separator_ownership(document, nodes);
assert_select_header_ownership(nodes);
```

Export the helper for direct tests:

```js
exports.assert_select_header_ownership = assert_select_header_ownership;
```

Update `tests/module-boundary.test.js` export expectation for `sql-format-invariants.js` only if that file currently asserts exact exports. If there is no exact export assertion, no change is needed.

- [ ] **Step 5: Run SELECT header contract tests**

Run:

```bash
node tests/format-invariants.test.js
node tests/module-boundary.test.js
```

Expected:

- `tests/format-invariants.test.js` passes the new node-shape assertions.
- `tests/module-boundary.test.js` still fails only if old `has_select_modifier_header_line` remains in `sql-select-mutations.js`.

- [ ] **Step 6: Commit SELECT header modeling**

Run:

```bash
git add lib/core/sql-list-nodes.js lib/core/sql-select-item-nodes.js lib/core/sql-format-invariants.js tests/module-boundary.test.js
git commit -m "refactor: model select header modifiers on spans"
```

Expected: commit succeeds.

---

### Task 3: Render SELECT Modifiers As Header Lines

**Files:**
- Modify: `lib/core/sql-list-layout-policy.js`
- Modify: `lib/core/sql-list-mutations.js`
- Modify: `lib/core/sql-select-mutations.js`
- Modify: `lib/core/sql-render-token-spacing.js` only if compact SELECT modifier spacing still emits `SELECT  DISTINCT` after line-break mutations

- [ ] **Step 1: Update owner-local first-item helpers in `lib/core/sql-list-layout-policy.js`**

Replace `is_first_item_in_owner` with:

```js
function is_first_item_in_owner(nodes, item) {
	if (!item) {
		return false;
	}
	if (typeof item.ordinalInOwner == 'number') {
		return item.ordinalInOwner == 0;
	}
	var items = nodes && nodes.selectItems ? nodes.selectItems : [];
	for (var i = 0; i < items.length; i++) {
		if (items[i].ownerScopeId != item.ownerScopeId) {
			continue;
		}
		return items[i].id == item.id;
	}
	return false;
}
```

Add:

```js
function span_has_header_modifier(nodes, ownerScopeId) {
	var span = find_list_span(nodes, ownerScopeId);
	return !!(span && span.kind == 'selectList' && span.header && span.header.modifier);
}

function first_item_body_indent(document, nodes, item) {
	var baseIndent = list_base_indent(document, nodes, item.ownerScopeId);
	if (item.ownerKind == 'selectList' && span_has_header_modifier(nodes, item.ownerScopeId)) {
		return baseIndent + repeat_space(8);
	}
	return baseIndent + first_item_prefix(item.ownerKind);
}
```

Change `item_indent` from:

```js
return item.id == 'selectItem:0'
	? baseIndent + first_item_prefix(item.ownerKind)
	: structured_list_indent(document, nodes, item.ownerScopeId, item.ownerKind) + ',';
```

to:

```js
return is_first_item_in_owner(nodes, item)
	? first_item_body_indent(document, nodes, item)
	: structured_list_indent(document, nodes, item.ownerScopeId, item.ownerKind) + ',';
```

Change `case_item_indent` first-item check from `item.id == 'selectItem:0'` to `is_first_item_in_owner(nodes, item)`. Keep the current CASE indent widths unless a failing test proves they need the `span_has_header_modifier` branch.

Do not export `span_has_header_modifier` or `first_item_body_indent`.

- [ ] **Step 2: Update first-item checks in `lib/core/sql-list-mutations.js`**

In `apply_first_item_spacing`, it already calls `sqlListLayoutPolicy.is_first_item_in_owner(nodes, item)`. No code change should be needed after Task 3 Step 1. Confirm there is no local `item.id == 'selectItem:0'` in this file:

```bash
rg -n "selectItem:0|id == 'selectItem:0'|id != 'selectItem:0'" lib/core/sql-list-mutations.js
```

Expected: no output.

- [ ] **Step 3: Remove local first-item and modifier header workarounds in `lib/core/sql-select-mutations.js`**

Delete the local `is_first_item_in_owner` function.

Replace calls to:

```js
is_first_item_in_owner(nodes, item)
```

with:

```js
sqlListLayoutPolicy.is_first_item_in_owner(nodes, item)
```

Delete the whole `has_select_modifier_header_line` function.

Delete this block in `apply_select_list_mutations`:

```js
if (has_select_modifier_header_line(document, nodes, item)) {
	sqlFormatMutations.add_line_indent(
		mutations,
		item.startLine,
		sqlListLayoutPolicy.structured_list_indent(document, nodes, item.ownerScopeId, item.ownerKind) + ' '
	);
}
```

- [ ] **Step 4: Add SELECT header modifier layout mutation helpers in `lib/core/sql-select-mutations.js`**

Add these helpers near `select_span_by_id`:

```js
function token_by_id(document, tokenId) {
	for (var i = 0; i < (document.tokens || []).length; i++) {
		if (document.tokens[i].id == tokenId) {
			return document.tokens[i];
		}
	}
	return null;
}

function first_item_for_span(nodes, span) {
	var items = nodes && nodes.selectItems ? nodes.selectItems : [];
	for (var i = 0; i < items.length; i++) {
		if (items[i].ownerScopeId == span.id
			&& sqlListLayoutPolicy.is_first_item_in_owner(nodes, items[i])) {
			return items[i];
		}
	}
	return null;
}

function line_has_trailing_comment(document, lineIndex) {
	var line = document && document.lines ? document.lines[lineIndex] : null;
	return !!(line && line.hasTrailingComment);
}

function apply_select_header_modifier_mutations(document, nodes, mutations) {
	var spans = nodes && nodes.selectSpans ? nodes.selectSpans : [];

	for (var i = 0; i < spans.length; i++) {
		var span = spans[i];
		if (span.kind != 'selectList' || !span.header || !span.header.modifier) {
			continue;
		}

		var firstItem = first_item_for_span(nodes, span);
		if (!firstItem || !firstItem.tokens || firstItem.tokens.length == 0) {
			continue;
		}

		var firstToken = firstItem.tokens[0];
		var headerLine = document.lines[span.startLine];
		var modifierToken = token_by_id(document, span.header.modifier.tokenId);

		if (modifierToken && modifierToken.line == span.startLine) {
			sqlFormatMutations.add_spacing_before_token(mutations, modifierToken.id, ' ');
		}

		if (firstToken.line == span.startLine && !line_has_trailing_comment(document, span.startLine)) {
			sqlFormatMutations.add_line_break_before_token(
				mutations,
				firstToken.id,
				sqlListLayoutPolicy.item_indent(document, nodes, firstItem),
				''
			);
			continue;
		}

		if (firstToken.line > span.startLine
			&& headerLine
			&& !headerLine.hasTrailingComment) {
			sqlFormatMutations.add_line_indent(
				mutations,
				firstToken.line,
				sqlListLayoutPolicy.item_indent(document, nodes, firstItem)
			);
		}
	}
}
```

Call this helper immediately after `sqlListMutations.apply_list_layout_mutations(document, nodes, mutations, config);` inside `apply_select_list_mutations`:

```js
apply_select_header_modifier_mutations(document, nodes, mutations);
```

- [ ] **Step 5: Keep Hive hint behavior intact**

Do not remove `has_select_hint_line` or `has_select_header_comment_line`. They cover comment-owned SELECT header lines, not code-token modifiers.

Run:

```bash
node - <<'NODE'
var vkbeautify = require('./vkbeautify');
function format(sql) { return vkbeautify.sql(sql, true, false, true, 150, 80).trim(); }
console.log(format('sElEcT   --+ MAPJOIN(tmp_user)\ntmp_user.id, tmp_user.name from tmp_user'));
NODE
```

Expected output starts with:

```text
SELECT --+ MAPJOIN(tmp_user)
        tmp_user.id
```

- [ ] **Step 6: Run SELECT alignment tests**

Run:

```bash
node tests/select-alignment.test.js
node tests/format-invariants.test.js
node tests/module-boundary.test.js
```

Expected: all three pass.

If compact `SELECT DISTINCT a, b FROM t` still renders `SELECT  DISTINCT`, inspect whether `sqlFormatMutations.add_spacing_before_token` is overridden by token spacing. Only if needed, update `lib/core/sql-render-token-spacing.js` so a token with explicit `spacingBefore` after `SELECT` uses the explicit spacing and does not add the default double-space rule.

- [ ] **Step 7: Commit SELECT modifier layout behavior**

Run:

```bash
git add lib/core/sql-list-layout-policy.js lib/core/sql-select-mutations.js lib/core/sql-render-token-spacing.js tests/select-alignment.test.js
git commit -m "fix: render select modifiers as header lines"
```

Expected: commit succeeds. If `lib/core/sql-render-token-spacing.js` was not changed, omit it from `git add`.

---

### Task 4: Add Failing Renderer Facts Contract Tests

**Files:**
- Modify: `tests/render-width.test.js`
- Modify: `tests/module-boundary.test.js`

- [ ] **Step 1: Add renderer facts module require and export expectations to `tests/module-boundary.test.js`**

Add this require near the other renderer requires:

```js
var sqlRenderLineFacts = require('../lib/core/sql-render-line-facts');
```

Add this exact export assertion after the `sqlRenderWidth` export assertion:

```js
assert.deepStrictEqual(
	Object.keys(sqlRenderLineFacts).sort(),
	['create_line_facts_context'],
	'render line facts helper must expose only create_line_facts_context'
);
```

Add `lib/core/sql-render-line-facts.js` to the structured renderer split module existence list:

```js
'lib/core/sql-render-line-facts.js',
```

Add `lib/core/sql-render-line-facts.js` to the arrays that reject local navigation helper functions.

Add source assertions near the existing `structuredRendererSource` block:

```js
var renderWidthSource = read_source('lib/core/sql-render-width.js');
var renderLineFactsSource = read_source('lib/core/sql-render-line-facts.js');

assert.ok(
	renderWidthSource.indexOf("require('./sql-render-line-facts')") >= 0,
	'sql-render-width must delegate rendered line facts to sql-render-line-facts'
);
[
	'render_line_from_tokens',
	'apply_scope_body_indent',
	'apply_scope_close_indent',
	'apply_indent',
	'apply_line_prefix',
	'append_joined_line'
].forEach(function(functionName) {
	assert.strictEqual(
		new RegExp('function\\s+' + functionName + '\\s*\\(').test(renderWidthSource),
		false,
		'sql-render-width.js must not carry renderer helper implementation: ' + functionName
	);
});
assert.ok(
	renderLineFactsSource.indexOf("require('./sql-render-line')") >= 0,
	'sql-render-line-facts must use sql-render-line helpers'
);
assert.ok(
	renderLineFactsSource.indexOf("require('./sql-render-indent')") >= 0,
	'sql-render-line-facts must use sql-render-indent helpers'
);
assert.ok(
	renderLineFactsSource.indexOf("require('./sql-render-move-state')") >= 0,
	'sql-render-line-facts must use sql-render-move-state helpers'
);
```

Expected failure before implementation: `Cannot find module '../lib/core/sql-render-line-facts'`.

- [ ] **Step 2: Add facts equivalence tests to `tests/render-width.test.js`**

Add this require near the top:

```js
var renderLineFacts = require('../lib/core/sql-render-line-facts');
```

Add this helper after `build_context`:

```js
function compare_width_and_facts(label, context, lineIndex) {
	var width = renderWidth.create_width_context(context.document, context.nodes, context.mutations, context.config);
	var facts = renderLineFacts.create_line_facts_context(context.document, context.nodes, context.mutations, context.config);
	assert.strictEqual(
		width.planned_code_width(context.document.lines[lineIndex]),
		facts.code_width_before_comment(lineIndex),
		label + ': planned code width must match renderer facts'
	);
	assert.strictEqual(
		width.planned_code_segment(context.document.lines[lineIndex]),
		facts.code_segment_before_comment(lineIndex),
		label + ': planned code segment must match renderer facts'
	);
	assert.strictEqual(
		width.planned_join_prefix_width(context.document.lines[lineIndex]),
		facts.join_prefix_width(lineIndex),
		label + ': planned join prefix width must match renderer facts'
	);
}
```

Add these assertions before `console.log('render width tests passed');`:

```js
compare_width_and_facts('plain line', base, 0);
compare_width_and_facts('inline comma spacing', comma, 0);
compare_width_and_facts('indented line', base, 0);
compare_width_and_facts('joined line', joined, 1);

var movedComma = build_context('select a as a,\nb as b -- second\nfrom t\n');
var firstSeparator = movedComma.nodes.separators.filter(function(separator) {
	return separator.ownerKind == 'selectList';
})[0];
mutations.add_separator_move(movedComma.mutations, firstSeparator.id, {
	lineIndex: 1,
	placement: 'linePrefix',
	text: ',',
	indentText: '       '
});
compare_width_and_facts('moved comma prefix', movedComma, 1);
```

Expected failure before implementation: `Cannot find module '../lib/core/sql-render-line-facts'`.

- [ ] **Step 3: Run failing renderer facts tests**

Run:

```bash
node tests/render-width.test.js
node tests/module-boundary.test.js
```

Expected: both fail because `sql-render-line-facts.js` does not exist.

- [ ] **Step 4: Commit failing renderer facts tests**

Run:

```bash
git add tests/render-width.test.js tests/module-boundary.test.js
git commit -m "test: specify renderer width facts contract"
```

Expected: commit succeeds with only test files.

---

### Task 5: Implement Renderer-Owned Line Facts

**Files:**
- Create: `lib/core/sql-render-line-facts.js`
- Modify: `lib/core/sql-render-width.js`

- [ ] **Step 1: Create `lib/core/sql-render-line-facts.js`**

Create the file with this implementation:

```js
var sqlCaseUtils = require('./sql-case-utils');
var sqlFormatMutations = require('./sql-format-mutations');
var sqlFormatUtils = require('./sql-format-utils');
var sqlLineModel = require('./sql-line-model');
var sqlRenderIndent = require('./sql-render-indent');
var sqlRenderLine = require('./sql-render-line');
var sqlRenderMoveState = require('./sql-render-move-state');

var expand_tabs_for_width = sqlFormatUtils.expand_tabs_for_width;
var get_alignment_width_for_code = sqlCaseUtils.get_alignment_width_for_code;

function create_line_facts_context(document, nodes, mutations, config) {
	var plan = mutations || sqlFormatMutations.create();
	var moveState = sqlRenderMoveState.build_move_state(nodes || {}, plan);
	var closeIndentByLine = sqlRenderIndent.build_close_indent_by_line(document, plan, moveState);
	var bodyIndentByLine = sqlRenderIndent.build_body_indent_by_line(document, plan, moveState);
	var cache = {};
	var alignmentWidthCache = {};

	function tokenizer_options_key(options) {
		var source = options || {};
		var keys = Object.keys(source).sort();
		var copy = {};
		for (var i = 0; i < keys.length; i++) {
			if (typeof source[keys[i]] != 'function') {
				copy[keys[i]] = source[keys[i]];
			}
		}
		return JSON.stringify(copy);
	}

	function cached_alignment_width_for_code(code) {
		var key = tokenizer_options_key(document && document.tokenizerOptions) + '\0' + String(code || '');
		if (Object.prototype.hasOwnProperty.call(alignmentWidthCache, key)) {
			return alignmentWidthCache[key];
		}
		var width = get_alignment_width_for_code(code, document.tokenizerOptions).width;
		alignmentWidthCache[key] = width;
		return width;
	}

	function render_line_before_alignment(lineIndex) {
		var key = String(lineIndex);
		if (Object.prototype.hasOwnProperty.call(cache, key)) {
			return cache[key];
		}

		var line = document.lines[lineIndex];
		if (!line) {
			cache[key] = {
				lineText: '',
				codeSegment: '',
				codeWidth: 0,
				alignmentWidth: 0,
				unjoinedCodeWidth: 0,
				joinPrefixWidth: 0
			};
			return cache[key];
		}

		var lineMutations = sqlFormatMutations.get_for_line(plan, lineIndex);
		var rendered = sqlRenderLine.render_line_from_tokens(document, line, plan, moveState, config);

		if (!lineMutations.indent) {
			rendered = sqlRenderIndent.apply_scope_body_indent(rendered, bodyIndentByLine[key]);
		}
		rendered = sqlRenderIndent.apply_scope_close_indent(rendered, closeIndentByLine[key]);
		rendered = sqlRenderIndent.apply_indent(rendered, lineMutations.indent);
		rendered = sqlRenderIndent.apply_line_prefix(rendered, moveState.prefixesByLine[key]);

		var currentParts = last_code_comment_parts(rendered);
		var unjoinedCodeWidth = expand_tabs_for_width(currentParts.code).length;
		var codeSegment = currentParts.code;
		var codeWidth = unjoinedCodeWidth;
		var joinPrefixWidth = 0;

		if (lineMutations.lineJoin && lineIndex > 0) {
			var previousFact = render_line_before_alignment(previous_rendered_line_index(lineIndex));
			var joinSeparator = typeof lineMutations.lineJoin.separatorText == 'string'
				? lineMutations.lineJoin.separatorText
				: ' ';
			joinPrefixWidth = previousFact.codeWidth + String(joinSeparator || '').length;
			codeSegment = previousFact.codeSegment.replace(/[ \t]+$/g, '')
				+ joinSeparator
				+ currentParts.code.replace(/^\s+/g, '');
			codeWidth = expand_tabs_for_width(codeSegment).length;
		}

		cache[key] = {
			lineText: rendered,
			codeSegment: codeSegment,
			codeWidth: codeWidth,
			alignmentWidth: cached_alignment_width_for_code(codeSegment),
			unjoinedCodeWidth: unjoinedCodeWidth,
			joinPrefixWidth: joinPrefixWidth
		};
		return cache[key];
	}

	function previous_rendered_line_index(lineIndex) {
		for (var i = lineIndex - 1; i >= 0; i--) {
			if (!plan.lineOmissions[String(i)]) {
				return i;
			}
		}
		return -1;
	}

	function last_code_comment_parts(rendered) {
		var segments = String(rendered || '').split('\n');
		var last = segments.length > 0 ? segments[segments.length - 1] : '';
		var parts = sqlLineModel.split_code_and_comment(last, document.tokenizerOptions);
		return {
			code: String(parts.code || '').replace(/[ \t]+$/g, ''),
			comment: parts.comment
		};
	}

	function code_width_before_comment(lineIndex) {
		return render_line_before_alignment(lineIndex).codeWidth;
	}

	function unjoined_code_width_before_comment(lineIndex) {
		return render_line_before_alignment(lineIndex).unjoinedCodeWidth;
	}

	function join_prefix_width(lineIndex) {
		return render_line_before_alignment(lineIndex).joinPrefixWidth;
	}

	function code_segment_before_comment(lineIndex) {
		return render_line_before_alignment(lineIndex).codeSegment;
	}

	function alignment_width_before_comment(lineIndex) {
		return render_line_before_alignment(lineIndex).alignmentWidth;
	}

	return {
		code_width_before_comment: code_width_before_comment,
		unjoined_code_width_before_comment: unjoined_code_width_before_comment,
		join_prefix_width: join_prefix_width,
		code_segment_before_comment: code_segment_before_comment,
		alignment_width_before_comment: alignment_width_before_comment
	};
}

exports.create_line_facts_context = create_line_facts_context;
```

This implementation intentionally uses existing render helpers. If a test reveals a mismatch, adjust this module by reusing more existing helper behavior; do not copy token spacing logic into this file.

- [ ] **Step 2: Refactor `lib/core/sql-render-width.js` to delegate line rendering facts**

At the top, add:

```js
var sqlRenderLineFacts = require('./sql-render-line-facts');
```

Inside `create_width_context`, after `var alignmentWidthCache = {};`, add:

```js
var lineFacts = sqlRenderLineFacts.create_line_facts_context(document, nodes, mutations, config);
```

Change `planned_code_width` to:

```js
function planned_code_width(line) {
	return lineFacts.code_width_before_comment(line.index);
}
```

Change `planned_join_prefix_width` to:

```js
function planned_join_prefix_width(line) {
	return lineFacts.join_prefix_width(line.index);
}
```

Change `planned_code_segment` to:

```js
function planned_code_segment(line) {
	return lineFacts.code_segment_before_comment(line.index);
}
```

Change `planned_alignment_width` to:

```js
function planned_alignment_width(line) {
	return lineFacts.alignment_width_before_comment(line.index);
}
```

After these changes, remove now-unused private helper functions and variables from `sql-render-width.js`:

```text
movedSeparatorsByLine
removedTokenIds
alignmentWidthCache
tokenizer_options_key
cached_alignment_width_for_code
planned_line_prefix
apply_planned_line_prefix
apply_planned_line_prefix_to_segments
original_gap_between
is_word_token
line_starts_with_group_by
dialect_name
line_has_width_mutation
line_has_inline_comma_spacing_change
should_use_original_code_text
rendered_code_text_for_width
planned_unjoined_code_width
line_has_line_break_mutation
line_inside_case_expr
max_segment_width
max_segment_alignment_width
```

Keep `planned_prefix_width`, but replace its body with this facts-backed implementation:

```js
function planned_prefix_width(lineIndex) {
	var line = document.lines[lineIndex];
	if (!line) {
		return 0;
	}
	return lineFacts.code_width_before_comment(lineIndex)
		- lineFacts.unjoined_code_width_before_comment(lineIndex);
}
```

Keep the CASE helper functions at the bottom in `sql-render-width.js`; they remain outside `sql-render-line-facts.js` in this plan:

```text
token_after_case_end_on_same_line
is_case_end_alias_comment_line
is_case_branch_value_comment_line
```

Keep the public return object unchanged:

```js
return {
	planned_prefix_width: planned_prefix_width,
	planned_code_width: planned_code_width,
	planned_join_prefix_width: planned_join_prefix_width,
	planned_code_segment: planned_code_segment,
	planned_alignment_width: planned_alignment_width,
	is_case_end_alias_comment_line: is_case_end_alias_comment_line,
	is_case_branch_value_comment_line: is_case_branch_value_comment_line
};
```

- [ ] **Step 3: Run renderer facts tests**

Run:

```bash
node tests/render-width.test.js
node tests/module-boundary.test.js
```

Expected: both pass.

If `tests/render-width.test.js` fails because expected historical width values no longer match rendered facts, inspect the actual rendered line with `sql-structured-renderer` before changing expectations. The facts should reflect renderer output before comment alignment, not the old simulation.

- [ ] **Step 4: Run comment alignment smoke**

Run:

```bash
node tests/comment-alignment.test.js
```

Expected: pass. If it fails, do not reintroduce duplicated width logic. Fix `sql-render-line-facts.js` to mirror the renderer helper sequence more accurately.

- [ ] **Step 5: Commit renderer facts implementation**

Run:

```bash
git add lib/core/sql-render-line-facts.js lib/core/sql-render-width.js tests/render-width.test.js tests/module-boundary.test.js
git commit -m "refactor: derive render widths from renderer facts"
```

Expected: commit succeeds.

---

### Task 6: Add Planned-Vs-Rendered Comment Alignment Invariants

**Files:**
- Modify: `lib/core/sql-format-mutations.js`
- Modify: `lib/core/sql-comment-mutations.js`
- Modify: `lib/core/sql-format-invariants.js`
- Modify: `lib/core/sql-formatter.js`
- Modify: `tests/format-invariants.test.js`

- [ ] **Step 1: Extend comment alignment mutations with optional planned facts**

In `lib/core/sql-format-mutations.js`, change `add_comment_alignment` from:

```js
function add_comment_alignment(plan, lineIndex, column) {
	plan.commentAlignments[String(lineIndex)] = {
		lineIndex: lineIndex,
		column: column
	};
}
```

to:

```js
function add_comment_alignment(plan, lineIndex, column, facts) {
	var mutation = {
		lineIndex: lineIndex,
		column: column
	};
	var source = facts || {};
	if (typeof source.codeWidth == 'number') {
		mutation.plannedCodeWidth = source.codeWidth;
	}
	if (typeof source.alignmentWidth == 'number') {
		mutation.plannedAlignmentWidth = source.alignmentWidth;
	}
	if (typeof source.joinPrefixWidth == 'number') {
		mutation.plannedJoinPrefixWidth = source.joinPrefixWidth;
	}
	plan.commentAlignments[String(lineIndex)] = mutation;
}
```

This is backward-compatible with existing call sites that pass only three arguments.

- [ ] **Step 2: Store planned width facts from `lib/core/sql-comment-mutations.js`**

In `flush_group`, change:

```js
sqlFormatMutations.add_comment_alignment(mutations, group[i].index, target - group[i].joinPrefixWidth);
```

to:

```js
sqlFormatMutations.add_comment_alignment(
	mutations,
	group[i].index,
	target - group[i].joinPrefixWidth,
	{
		codeWidth: group[i].codeWidth,
		alignmentWidth: group[i].alignmentWidth,
		joinPrefixWidth: group[i].joinPrefixWidth
	}
);
```

Do not change the target-column algorithm in this task. The goal is to record the width facts already used by comment planning, not to redesign grouping.

- [ ] **Step 3: Add render width require to `lib/core/sql-format-invariants.js`**

Add:

```js
var sqlRenderWidth = require('./sql-render-width');
```

near the existing requires.

- [ ] **Step 4: Add comment alignment width fact invariant helper**

Add this helper before `assert_mutation_plan_safe`:

```js
function assert_comment_alignment_widths_match_renderer(document, nodes, plan, config) {
	var widthContext = sqlRenderWidth.create_width_context(document, nodes, plan, config || {});
	var key;

	for (key in (plan.commentAlignments || {})) {
		if (!Object.prototype.hasOwnProperty.call(plan.commentAlignments, key)) {
			continue;
		}
		var mutation = plan.commentAlignments[key];
		var line = document.lines && document.lines[mutation.lineIndex];
		if (!line) {
			continue;
		}
		if (typeof mutation.plannedCodeWidth == 'number'
			&& mutation.plannedCodeWidth != widthContext.planned_code_width(line)) {
			throw new Error(
				'comment alignment planned code width for line ' + mutation.lineIndex
				+ ' must match renderer facts'
			);
		}
		if (typeof mutation.plannedAlignmentWidth == 'number'
			&& mutation.plannedAlignmentWidth != widthContext.planned_alignment_width(line)) {
			throw new Error(
				'comment alignment planned alignment width for line ' + mutation.lineIndex
				+ ' must match renderer facts'
			);
		}
		if (typeof mutation.plannedJoinPrefixWidth == 'number'
			&& mutation.plannedJoinPrefixWidth != widthContext.planned_join_prefix_width(line)) {
			throw new Error(
				'comment alignment planned join prefix width for line ' + mutation.lineIndex
				+ ' must match renderer facts'
			);
		}
	}
}
```

- [ ] **Step 5: Thread config through mutation invariant checks**

Change the function signature from:

```js
function assert_mutation_plan_safe(document, nodes, mutations) {
```

to:

```js
function assert_mutation_plan_safe(document, nodes, mutations, config) {
```

Before the closing brace of `assert_mutation_plan_safe`, after all individual mutation checks, add:

```js
assert_comment_alignment_widths_match_renderer(document, extractedNodes, plan, config);
```

Update the export list only if needed. The exported function name stays the same.

- [ ] **Step 6: Update formatter invariant call in `lib/core/sql-formatter.js`**

Change:

```js
sqlFormatInvariants.assert_mutation_plan_safe(document, nodes, plan);
```

to:

```js
sqlFormatInvariants.assert_mutation_plan_safe(document, nodes, plan, config);
```

- [ ] **Step 7: Add direct invariant rejection test to `tests/format-invariants.test.js`**

Add this block near the existing unsafe mutation plan tests:

```js
var unsafeCommentAlignmentDoc = build_structured_document('select a as a -- a\n,b as b -- b\nfrom t');
var unsafeCommentAlignmentPlan = mutations.create();
mutations.add_comment_alignment(unsafeCommentAlignmentPlan, 0, 999, {
	codeWidth: 999,
	alignmentWidth: 999,
	joinPrefixWidth: 0
});

assert.throws(
	function() {
		invariants.assert_mutation_plan_safe(
			unsafeCommentAlignmentDoc,
			unsafeCommentAlignmentDoc.nodes,
			unsafeCommentAlignmentPlan,
			{
				keywordCase: 'upper',
				commaStyle: 'leading',
				indentStyle: 'space',
				maxAlignWidth: 150,
				caseWhenThenWrapLength: 80,
				dialect: 'generic',
				unsupportedSyntaxPolicy: 'preserve'
			}
		);
	},
	/comment alignment planned code width/,
	'mutation invariants must reject comment alignment planned widths that drift from renderer facts'
);
```

- [ ] **Step 8: Run invariant and formatter regression tests**

Run:

```bash
node tests/format-invariants.test.js
node tests/comment-alignment.test.js
node tests/select-alignment.test.js
node tests/render-width.test.js
```

Expected: all pass.

- [ ] **Step 9: Commit comment alignment invariants**

Run:

```bash
git add lib/core/sql-format-mutations.js lib/core/sql-comment-mutations.js lib/core/sql-format-invariants.js lib/core/sql-formatter.js tests/format-invariants.test.js
git commit -m "test: guard comment alignment against renderer width drift"
```

Expected: commit succeeds.

---

### Task 7: Full Regression And Architecture Documentation Check

**Files:**
- Modify: `docs/technical/sql-formatter-architecture.md` only if implementation adds `sql-render-line-facts.js`

- [ ] **Step 1: Update architecture documentation if `sql-render-line-facts.js` was added**

In `docs/technical/sql-formatter-architecture.md`, update the renderer helper sentence:

Current text includes:

```text
Its implementation delegates focused helper work to `sql-render-move-state.js`, `sql-render-indent.js`, `sql-render-token-spacing.js`, `sql-render-line.js`, `sql-render-width.js`, and `sql-token-renderer.js`.
```

Change it to:

```text
Its implementation delegates focused helper work to `sql-render-move-state.js`, `sql-render-indent.js`, `sql-render-token-spacing.js`, `sql-render-line.js`, `sql-render-line-facts.js`, `sql-render-width.js`, and `sql-token-renderer.js`.
```

Add this sentence after it:

```text
Pre-alignment comment width planning must consume renderer-owned line facts rather than duplicating token rendering, indentation, separator-prefix, or line-join logic in `sql-render-width.js`.
```

- [ ] **Step 2: Run targeted validation**

Run:

```bash
node tests/format-invariants.test.js
node tests/select-alignment.test.js
node tests/comment-alignment.test.js
node tests/render-width.test.js
node tests/module-boundary.test.js
node tests/token-boundary.test.js
node tests/pipeline-idempotency.test.js
```

Expected: all pass.

- [ ] **Step 3: Run full local regression**

Run:

```bash
npm run test:verify
git diff --check
```

Expected:

- `npm run test:verify` passes.
- `git diff --check` prints no whitespace errors.

- [ ] **Step 4: Run packaging smoke if module structure changed**

Because this plan creates `lib/core/sql-render-line-facts.js`, run:

```bash
npm run package:vsix
```

Expected: VSIX package builds successfully and includes `lib/core/sql-render-line-facts.js`.

If a `.vsix` file appears in the repository root, do not commit it.

- [ ] **Step 5: Inspect final diff**

Run:

```bash
git status --short
git diff --stat
git diff -- docs/technical/sql-formatter-architecture.md lib/core tests
```

Expected:

- Only files from this plan are modified.
- No root shim files changed.
- No `.vsix` artifact is staged.

- [ ] **Step 6: Commit final documentation and cleanup**

If `docs/technical/sql-formatter-architecture.md` changed, run:

```bash
git add docs/technical/sql-formatter-architecture.md
git commit -m "docs: document renderer line facts contract"
```

If no documentation changed and all prior task commits are already clean, do not create an empty commit.

---

## Execution Notes

- Prefer small commits exactly at task boundaries. If a task uncovers a pre-existing failing baseline, stop and report before editing.
- Do not use proxy for local validation commands in this plan.
- Do not change formatter behavior outside SELECT header modifiers and comment alignment width planning.
- Do not implement a full SQL AST or broad parser rewrite.
- Do not preserve old helper names (`is_select_modifier_item`, `has_select_modifier_header_line`) as compatibility aliases; tests intentionally reject them.
