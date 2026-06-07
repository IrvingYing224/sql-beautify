# Structured Node Extractor Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `lib/core/sql-format-nodes.js` into focused node extractor modules while preserving the existing `nodes` object shape and formatter output.

**Architecture:** Keep `sql-format-nodes.js` as the public orchestrator and compatibility boundary. Move list/separator, SELECT item, CASE expression, and condition block extraction into focused core modules that share only small token helpers through `sql-node-utils.js`.

**Tech Stack:** CommonJS JavaScript, Node.js `assert` tests, existing SQL formatter core under `lib/core/`, existing regression suite via `npm run test:verify`.

---

## File Structure

- Create: `lib/core/sql-node-utils.js`
  - Shared token predicates and token range helpers for node extraction.
- Create: `lib/core/sql-list-nodes.js`
  - SELECT/GROUP BY list span extraction and comma separator ownership.
- Create: `lib/core/sql-select-item-nodes.js`
  - SELECT/GROUP BY item extraction from spans and separators.
- Create: `lib/core/sql-case-nodes.js`
  - CASE expression node extraction from `caseExpr` scopes.
- Create: `lib/core/sql-condition-nodes.js`
  - condition block node extraction from `conditionBlock` scopes.
- Modify: `lib/core/sql-format-nodes.js`
  - Keep public exports and orchestrate the new focused modules.
- Modify: `tests/format-invariants.test.js`
  - Add focused node shape assertions before moving implementation.
- Modify: `tests/module-boundary.test.js`
  - Enforce the new extractor files exist and `sql-format-nodes.js` stays thin.

Do not modify `lib/adapters/`, `lib/experimental/ddl/`, root `lib/*.js` shims, `README.md`, or publishing workflow files.

---

### Task 1: Baseline And Node Shape Guard

**Files:**
- Modify: `tests/format-invariants.test.js`

- [ ] **Step 1: Read the approved spec**

Run:

```bash
sed -n '1,280p' docs/superpowers/specs/2026-06-07-structured-node-extractor-split-design.md
```

Expected: the spec requires focused node extractor modules, no formatter behavior change, unchanged `nodes` object shape, module-boundary guards, and final `npm run test:verify`.

- [ ] **Step 2: Run baseline targeted checks**

Run:

```bash
node tests/format-invariants.test.js
node tests/structured-differential.test.js
node tests/pipeline-idempotency.test.js
node tests/module-boundary.test.js
```

Expected: all commands pass before edits. If any command fails on the untouched baseline, stop and report the failure before changing code.

- [ ] **Step 3: Add node shape fixture helpers**

In `tests/format-invariants.test.js`, immediately after the existing `require` lines at the top, add this code:

```js
var scopeModel = require('../lib/core/sql-scope-model');
var formatNavigation = require('../lib/core/sql-format-navigation');

function extract_structured_nodes(sql, config) {
	config = Object.assign({ dialect: 'generic' }, config || {});
	var doc = formatDocument.from_text(sql, config);
	doc.scopes = scopeModel.build(doc, config);
	formatNavigation.attach_scope_index(doc);
	return nodes.extract(doc, config);
}

function token_values(tokens) {
	return (tokens || []).map(function(token) {
		return token.value;
	});
}
```

Make sure the existing top of the file still starts with these compatible imports:

```js
var assert = require('assert');
var formatDocument = require('../lib/core/sql-format-document');
var nodes = require('../lib/core/sql-format-nodes');
var mutations = require('../lib/core/sql-format-mutations');
var invariants = require('../lib/core/sql-format-invariants');
var scopeModel = require('../lib/core/sql-scope-model');
var formatNavigation = require('../lib/core/sql-format-navigation');
```

- [ ] **Step 4: Add the node shape regression assertions**

In `tests/format-invariants.test.js`, after the helper functions from Step 3 and before the existing `var sql = [` fixture, add this test block:

```js
var nodeShapeSql = [
	'select',
	'case when city_id in (',
	'1001, -- city one',
	'1002 -- city two',
	") then concat_ws(',', name, city)",
	"else 'unknown'",
	'end as city_label,',
	'sum(amount) over(partition by user_id order by ds) as total_amount',
	'from fact_orders',
	"where ds = '2026-06-07'",
	'and status between 1 and 3',
	'group by city_label, user_id'
].join('\n');

var nodeShape = extract_structured_nodes(nodeShapeSql);

assert.deepStrictEqual(
	nodeShape.selectSpans.map(function(span) {
		return {
			id: span.id,
			kind: span.kind,
			startLine: span.startLine,
			endLine: span.endLine
		};
	}),
	[
		{
			id: 'selectList:0',
			kind: 'selectList',
			startLine: 0,
			endLine: 7
		},
		{
			id: 'groupByList:1',
			kind: 'groupByList',
			startLine: 11,
			endLine: 11
		}
	],
	'node extractor must preserve select and group-by list spans'
);

assert.deepStrictEqual(
	nodeShape.separators.map(function(separator) {
		return {
			id: separator.id,
			ownerScopeId: separator.ownerScopeId,
			ownerKind: separator.ownerKind,
			line: separator.line
		};
	}),
	[
		{
			id: 'separator:0',
			ownerScopeId: 2,
			ownerKind: 'inList',
			line: 2
		},
		{
			id: 'separator:1',
			ownerScopeId: 3,
			ownerKind: 'functionCall',
			line: 4
		},
		{
			id: 'separator:2',
			ownerScopeId: 3,
			ownerKind: 'functionCall',
			line: 4
		},
		{
			id: 'separator:3',
			ownerScopeId: 'selectList:0',
			ownerKind: 'selectList',
			line: 6
		},
		{
			id: 'separator:4',
			ownerScopeId: 'groupByList:1',
			ownerKind: 'groupByList',
			line: 11
		}
	],
	'node extractor must preserve separator ownership and ID order'
);

assert.deepStrictEqual(
	nodeShape.selectItems.map(function(item) {
		return {
			id: item.id,
			ownerScopeId: item.ownerScopeId,
			ownerKind: item.ownerKind,
			startLine: item.startLine,
			endLine: item.endLine,
			separatorId: item.separatorId,
			tokens: token_values(item.tokens)
		};
	}),
	[
		{
			id: 'selectItem:0',
			ownerScopeId: 'selectList:0',
			ownerKind: 'selectList',
			startLine: 1,
			endLine: 6,
			separatorId: 'separator:3',
			tokens: [
				'case',
				'when',
				'city_id',
				'in',
				'(',
				'1001',
				',',
				'1002',
				')',
				'then',
				'concat_ws',
				'(',
				"','",
				',',
				'name',
				',',
				'city',
				')',
				'else',
				"'unknown'",
				'end',
				'as',
				'city_label'
			]
		},
		{
			id: 'selectItem:1',
			ownerScopeId: 'selectList:0',
			ownerKind: 'selectList',
			startLine: 7,
			endLine: 7,
			separatorId: null,
			tokens: [
				'sum',
				'(',
				'amount',
				')',
				'over',
				'(',
				'partition',
				'by',
				'user_id',
				'order',
				'by',
				'ds',
				')',
				'as',
				'total_amount'
			]
		},
		{
			id: 'selectItem:2',
			ownerScopeId: 'groupByList:1',
			ownerKind: 'groupByList',
			startLine: 11,
			endLine: 11,
			separatorId: 'separator:4',
			tokens: [
				'by',
				'city_label'
			]
		},
		{
			id: 'selectItem:3',
			ownerScopeId: 'groupByList:1',
			ownerKind: 'groupByList',
			startLine: 11,
			endLine: 11,
			separatorId: null,
			tokens: [
				'user_id'
			]
		}
	],
	'node extractor must preserve select item shape and token attribution'
);

assert.strictEqual(nodeShape.caseExpressions.length, 1, 'node shape fixture must extract one CASE expression');
assert.deepStrictEqual(
	{
		id: nodeShape.caseExpressions[0].id,
		startLine: nodeShape.caseExpressions[0].startLine,
		endLine: nodeShape.caseExpressions[0].endLine,
		caseKeyword: nodeShape.caseExpressions[0].caseKeywordToken.value,
		endKeyword: nodeShape.caseExpressions[0].endKeywordToken.value,
		whenTokens: token_values(nodeShape.caseExpressions[0].branches[0].whenTokens),
		thenTokens: token_values(nodeShape.caseExpressions[0].branches[0].thenTokens),
		elseKeyword: nodeShape.caseExpressions[0].elseKeywordToken.value,
		elseTokens: token_values(nodeShape.caseExpressions[0].elseTokens)
	},
	{
		id: 'caseExpr:0',
		startLine: 1,
		endLine: 6,
		caseKeyword: 'case',
		endKeyword: 'end',
		whenTokens: [
			'city_id',
			'in',
			'(',
			'1001',
			',',
			'1002',
			')'
		],
		thenTokens: [
			'concat_ws',
			'(',
			"','",
			',',
			'name',
			',',
			'city',
			')'
		],
		elseKeyword: 'else',
		elseTokens: [
			"'unknown'"
		]
	},
	'node extractor must preserve CASE branch token ownership'
);

assert.deepStrictEqual(
	nodeShape.conditionBlocks.map(function(block) {
		return {
			id: block.id,
			keyword: block.keyword,
			startLine: block.startLine,
			endLine: block.endLine,
			segments: block.segments.map(function(segment) {
				return {
					lineIndex: segment.lineIndex,
					kind: segment.kind,
					connector: segment.connector,
					tokens: token_values(segment.tokens)
				};
			}),
			continuationLines: block.continuationLines,
			closeLines: block.closeLines
		};
	}),
	[
		{
			id: 'conditionBlock:0',
			keyword: 'WHERE',
			startLine: 9,
			endLine: 10,
			segments: [
				{
					lineIndex: 9,
					kind: 'clause',
					connector: 'WHERE',
					tokens: [
						'where',
						'ds',
						'=',
						"'2026-06-07'"
					]
				},
				{
					lineIndex: 10,
					kind: 'connector',
					connector: 'AND',
					tokens: [
						'and',
						'status',
						'between',
						'1',
						'and',
						'3'
					]
				}
			],
			continuationLines: [],
			closeLines: []
		}
	],
	'node extractor must preserve condition block segment shape'
);
```

- [ ] **Step 5: Run node guard test**

Run:

```bash
node tests/format-invariants.test.js
```

Expected: PASS. This confirms the new guard matches current behavior before any extraction.

- [ ] **Step 6: Commit the guard**

Run:

```bash
git add tests/format-invariants.test.js
git commit -m "test: guard structured node extraction shape"
```

Expected: commit succeeds.

---

### Task 2: Extract Shared Node Utilities

**Files:**
- Create: `lib/core/sql-node-utils.js`
- Modify: `lib/core/sql-format-nodes.js`
- Test: `tests/format-invariants.test.js`

- [ ] **Step 1: Create `sql-node-utils.js`**

Create `lib/core/sql-node-utils.js` with this complete content:

```js
var sqlFormatNavigation = require('./sql-format-navigation');

function is_code_token(token) {
	return token && token.isCode;
}

function is_word(token, value) {
	if (!token || token.type != 'word') {
		return false;
	}
	if (typeof value == 'undefined') {
		return true;
	}
	return token.value.toUpperCase() == value;
}

function token_in_range(token, startIndex, endIndex) {
	return token.index >= startIndex && token.index <= endIndex;
}

function tokens_in_range(document, startIndex, endIndex) {
	var tokens = sqlFormatNavigation.active_tokens(document);
	var result = [];
	for (var i = 0; i < tokens.length; i++) {
		if (token_in_range(tokens[i], startIndex, endIndex)) {
			result.push(tokens[i]);
		}
	}
	return result;
}

exports.is_code_token = is_code_token;
exports.is_word = is_word;
exports.token_in_range = token_in_range;
exports.tokens_in_range = tokens_in_range;
```

- [ ] **Step 2: Import node utilities in `sql-format-nodes.js`**

At the top of `lib/core/sql-format-nodes.js`, add:

```js
var sqlNodeUtils = require('./sql-node-utils');
```

Then replace the bodies of the existing helper functions with delegating wrappers:

```js
function is_code_token(token) {
	return sqlNodeUtils.is_code_token(token);
}

function is_word(token, value) {
	return sqlNodeUtils.is_word(token, value);
}

function token_in_range(token, startIndex, endIndex) {
	return sqlNodeUtils.token_in_range(token, startIndex, endIndex);
}

function tokens_in_range(document, startIndex, endIndex) {
	return sqlNodeUtils.tokens_in_range(document, startIndex, endIndex);
}
```

Do not change any callers yet.

- [ ] **Step 3: Run targeted node and differential checks**

Run:

```bash
node tests/format-invariants.test.js
node tests/structured-differential.test.js
```

Expected: both commands pass.

- [ ] **Step 4: Commit shared utilities**

Run:

```bash
git add lib/core/sql-node-utils.js lib/core/sql-format-nodes.js
git commit -m "refactor: extract structured node utilities"
```

Expected: commit succeeds.

---

### Task 3: Extract List Spans And Separators

**Files:**
- Create: `lib/core/sql-list-nodes.js`
- Modify: `lib/core/sql-format-nodes.js`
- Test: `tests/format-invariants.test.js`

- [ ] **Step 1: Create `sql-list-nodes.js`**

Create `lib/core/sql-list-nodes.js` by moving the current implementations of these functions from `lib/core/sql-format-nodes.js`:

```js
is_list_boundary_token
list_boundary_end_token
create_list_spans
span_contains_token
select_span_for_token
owner_scope_for_separator
find_separators
```

The new file must start with these imports:

```js
var scopeModel = require('./sql-scope-model');
var sqlGroupByExtension = require('./sql-group-by-extension');
var sqlFormatNavigation = require('./sql-format-navigation');
var sqlNodeUtils = require('./sql-node-utils');

var is_word = sqlNodeUtils.is_word;
```

The new file must end with these exports:

```js
exports.create_list_spans = create_list_spans;
exports.find_separators = find_separators;
```

When moving the code:

- keep function bodies mechanically identical except for using imported `is_word`
- keep `sqlFormatNavigation.active_tokens(document)` exactly where the current code uses it
- keep `sqlGroupByExtension.is_start(...)` logic unchanged
- do not export private helpers

- [ ] **Step 2: Update `sql-format-nodes.js` to delegate list extraction**

At the top of `lib/core/sql-format-nodes.js`, add:

```js
var sqlListNodes = require('./sql-list-nodes');
```

Replace the existing `create_list_spans` and `find_separators` implementations in `sql-format-nodes.js` with these wrappers:

```js
function create_list_spans(document, options) {
	return sqlListNodes.create_list_spans(document, options);
}

function find_separators(document, selectSpans) {
	return sqlListNodes.find_separators(document, selectSpans);
}
```

Remove the now-unused private list/separator helpers from `sql-format-nodes.js`:

```text
is_list_boundary_token
list_boundary_end_token
span_contains_token
select_span_for_token
owner_scope_for_separator
```

- [ ] **Step 3: Run list/separator checks**

Run:

```bash
node tests/format-invariants.test.js
node tests/structured-differential.test.js
```

Expected: both commands pass, including the new separator owner and list span assertions.

- [ ] **Step 4: Commit list extractor**

Run:

```bash
git add lib/core/sql-list-nodes.js lib/core/sql-format-nodes.js
git commit -m "refactor: extract structured list nodes"
```

Expected: commit succeeds.

---

### Task 4: Extract SELECT Item Nodes

**Files:**
- Create: `lib/core/sql-select-item-nodes.js`
- Modify: `lib/core/sql-format-nodes.js`
- Test: `tests/format-invariants.test.js`

- [ ] **Step 1: Create `sql-select-item-nodes.js`**

Create `lib/core/sql-select-item-nodes.js` by moving the current `find_select_items` implementation from `lib/core/sql-format-nodes.js`.

The new file must start with:

```js
var scopeModel = require('./sql-scope-model');
var sqlNodeUtils = require('./sql-node-utils');
var sqlListNodes = require('./sql-list-nodes');

var tokens_in_range = sqlNodeUtils.tokens_in_range;
```

Inside `find_select_items`, preserve the current fallback behavior by replacing:

```js
var spans = selectSpans || create_list_spans(document);
var separatorList = separators || find_separators(document, spans);
```

with:

```js
var spans = selectSpans || sqlListNodes.create_list_spans(document);
var separatorList = separators || sqlListNodes.find_separators(document, spans);
```

The new file must end with:

```js
exports.find_select_items = find_select_items;
```

Do not change item ID generation, nested owner checks, line-split behavior, or token arrays.

- [ ] **Step 2: Update `sql-format-nodes.js` to delegate SELECT items**

At the top of `lib/core/sql-format-nodes.js`, add:

```js
var sqlSelectItemNodes = require('./sql-select-item-nodes');
```

Replace the existing `find_select_items` implementation with:

```js
function find_select_items(document, selectSpans, separators) {
	return sqlSelectItemNodes.find_select_items(document, selectSpans, separators);
}
```

- [ ] **Step 3: Run SELECT item checks**

Run:

```bash
node tests/format-invariants.test.js
node tests/structured-differential.test.js
node tests/pipeline-idempotency.test.js
```

Expected: all commands pass, including the new SELECT item shape assertions.

- [ ] **Step 4: Commit SELECT item extractor**

Run:

```bash
git add lib/core/sql-select-item-nodes.js lib/core/sql-format-nodes.js
git commit -m "refactor: extract structured select item nodes"
```

Expected: commit succeeds.

---

### Task 5: Extract CASE Nodes

**Files:**
- Create: `lib/core/sql-case-nodes.js`
- Modify: `lib/core/sql-format-nodes.js`
- Test: `tests/format-invariants.test.js`

- [ ] **Step 1: Create `sql-case-nodes.js`**

Create `lib/core/sql-case-nodes.js` by moving the current implementations of these functions from `lib/core/sql-format-nodes.js`:

```js
line_has_word
apply_case_comments
find_case_expressions
```

The new file must start with:

```js
var scopeModel = require('./sql-scope-model');
var sqlNodeUtils = require('./sql-node-utils');

var is_word = sqlNodeUtils.is_word;
var tokens_in_range = sqlNodeUtils.tokens_in_range;
```

The new file must end with:

```js
exports.find_case_expressions = find_case_expressions;
```

Keep nested CASE handling, branch token attribution, line comment attribution, and suffix token handling mechanically unchanged.

- [ ] **Step 2: Update `sql-format-nodes.js` to delegate CASE extraction**

At the top of `lib/core/sql-format-nodes.js`, add:

```js
var sqlCaseNodes = require('./sql-case-nodes');
```

Replace the existing `find_case_expressions` implementation with:

```js
function find_case_expressions(document) {
	return sqlCaseNodes.find_case_expressions(document);
}
```

Remove `line_has_word` and `apply_case_comments` from `sql-format-nodes.js` after moving them.

- [ ] **Step 3: Run CASE checks**

Run:

```bash
node tests/format-invariants.test.js
node tests/case-when.test.js
node tests/structured-differential.test.js
node tests/pipeline-idempotency.test.js
```

Expected: all commands pass, including the new CASE branch token assertions.

- [ ] **Step 4: Commit CASE extractor**

Run:

```bash
git add lib/core/sql-case-nodes.js lib/core/sql-format-nodes.js
git commit -m "refactor: extract structured case nodes"
```

Expected: commit succeeds.

---

### Task 6: Extract Condition Nodes

**Files:**
- Create: `lib/core/sql-condition-nodes.js`
- Modify: `lib/core/sql-format-nodes.js`
- Test: `tests/format-invariants.test.js`

- [ ] **Step 1: Create `sql-condition-nodes.js`**

Create `lib/core/sql-condition-nodes.js` by moving the current implementations of these functions from `lib/core/sql-format-nodes.js`:

```js
is_clause_start_token
find_condition_blocks
```

The new file must start with:

```js
var scopeModel = require('./sql-scope-model');
var sqlFormatNavigation = require('./sql-format-navigation');
var sqlNodeUtils = require('./sql-node-utils');

var is_word = sqlNodeUtils.is_word;
```

Inside `find_condition_blocks`, keep the existing local `scope_by_id(scopeId)` helper:

```js
function scope_by_id(scopeId) {
	return sqlFormatNavigation.scope_by_id(document, scopeId);
}
```

The new file must end with:

```js
exports.find_condition_blocks = find_condition_blocks;
```

Keep inline nested query filtering, `BETWEEN` connector handling, nested owner handling, close-line handling, and segment object fields mechanically unchanged.

- [ ] **Step 2: Update `sql-format-nodes.js` to delegate condition extraction**

At the top of `lib/core/sql-format-nodes.js`, add:

```js
var sqlConditionNodes = require('./sql-condition-nodes');
```

Replace the existing `find_condition_blocks` implementation with:

```js
function find_condition_blocks(document) {
	return sqlConditionNodes.find_condition_blocks(document);
}
```

Remove `is_clause_start_token` from `sql-format-nodes.js` after moving it.

- [ ] **Step 3: Run condition checks**

Run:

```bash
node tests/format-invariants.test.js
node tests/condition-alignment.test.js
node tests/structured-differential.test.js
node tests/pipeline-idempotency.test.js
```

Expected: all commands pass, including the new condition block segment assertions.

- [ ] **Step 4: Commit condition extractor**

Run:

```bash
git add lib/core/sql-condition-nodes.js lib/core/sql-format-nodes.js
git commit -m "refactor: extract structured condition nodes"
```

Expected: commit succeeds.

---

### Task 7: Enforce Extractor Boundaries

**Files:**
- Modify: `tests/module-boundary.test.js`
- Test: `tests/module-boundary.test.js`

- [ ] **Step 1: Add existence checks for new extractor modules**

In `tests/module-boundary.test.js`, find the block that asserts these files exist:

```js
[
	'lib/core/sql-render-move-state.js',
	'lib/core/sql-render-indent.js',
	'lib/core/sql-render-token-spacing.js',
	'lib/core/sql-render-line.js'
].forEach(function(relativePath) {
```

Immediately after that block, add:

```js
[
	'lib/core/sql-node-utils.js',
	'lib/core/sql-list-nodes.js',
	'lib/core/sql-select-item-nodes.js',
	'lib/core/sql-case-nodes.js',
	'lib/core/sql-condition-nodes.js'
].forEach(function(relativePath) {
	assert.ok(
		fs.existsSync(path.join(__dirname, '..', relativePath)),
		'structured node extractor split module must exist: ' + relativePath
	);
});
```

- [ ] **Step 2: Add public export checks for new extractor modules**

Near the existing import declarations at the top of `tests/module-boundary.test.js`, add:

```js
var sqlNodeUtils = require('../lib/core/sql-node-utils');
var sqlListNodes = require('../lib/core/sql-list-nodes');
var sqlSelectItemNodes = require('../lib/core/sql-select-item-nodes');
var sqlCaseNodes = require('../lib/core/sql-case-nodes');
var sqlConditionNodes = require('../lib/core/sql-condition-nodes');
```

After the existing `Object.keys(sqlRenderWidth)` export assertion, add:

```js
assert.deepStrictEqual(
	Object.keys(sqlNodeUtils).sort(),
	['is_code_token', 'is_word', 'token_in_range', 'tokens_in_range'],
	'node utils must expose only shared token helpers'
);
assert.deepStrictEqual(
	Object.keys(sqlListNodes).sort(),
	['create_list_spans', 'find_separators'],
	'list node extractor must expose only list span and separator extraction'
);
assert.deepStrictEqual(
	Object.keys(sqlSelectItemNodes).sort(),
	['find_select_items'],
	'select item node extractor must expose only find_select_items'
);
assert.deepStrictEqual(
	Object.keys(sqlCaseNodes).sort(),
	['find_case_expressions'],
	'case node extractor must expose only find_case_expressions'
);
assert.deepStrictEqual(
	Object.keys(sqlConditionNodes).sort(),
	['find_condition_blocks'],
	'condition node extractor must expose only find_condition_blocks'
);
```

- [ ] **Step 3: Add thin orchestrator checks**

After the existing structured renderer helper delegation checks, add:

```js
var formatNodesSource = read_source('lib/core/sql-format-nodes.js');
[
	'is_list_boundary_token',
	'list_boundary_end_token',
	'span_contains_token',
	'select_span_for_token',
	'owner_scope_for_separator',
	'line_has_word',
	'apply_case_comments',
	'is_clause_start_token'
].forEach(function(functionName) {
	assert.strictEqual(
		new RegExp('function\\s+' + functionName + '\\s*\\(').test(formatNodesSource),
		false,
		'sql-format-nodes.js must delegate extractor helper implementation: ' + functionName
	);
});
[
	"require('./sql-list-nodes')",
	"require('./sql-select-item-nodes')",
	"require('./sql-case-nodes')",
	"require('./sql-condition-nodes')"
].forEach(function(requireText) {
	assert.ok(
		formatNodesSource.indexOf(requireText) >= 0,
		'sql-format-nodes.js must delegate to focused extractor module: ' + requireText
	);
});
```

- [ ] **Step 4: Add new core files to existing navigation-helper boundary checks**

Find both arrays in `tests/module-boundary.test.js` that currently include `lib/core/sql-format-nodes.js` for duplicated navigation helper checks. Add these files to the same arrays:

```js
'lib/core/sql-list-nodes.js',
'lib/core/sql-select-item-nodes.js',
'lib/core/sql-case-nodes.js',
'lib/core/sql-condition-nodes.js'
```

Do not add `lib/core/sql-node-utils.js` to these arrays because it intentionally owns tiny token range helpers.

- [ ] **Step 5: Run boundary checks**

Run:

```bash
node tests/module-boundary.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit boundary guards**

Run:

```bash
git add tests/module-boundary.test.js
git commit -m "test: enforce structured node extractor boundaries"
```

Expected: commit succeeds.

---

### Task 8: Final Verification And Package Smoke

**Files:**
- Verify only unless a previous task needs a tiny correction.

- [ ] **Step 1: Run focused final checks**

Run:

```bash
node tests/format-invariants.test.js
node tests/structured-differential.test.js
node tests/pipeline-idempotency.test.js
node tests/module-boundary.test.js
```

Expected: all commands pass.

- [ ] **Step 2: Run full verification**

Run:

```bash
npm run test:verify
```

Expected: PASS, including `tests/format-invariants.test.js`, `tests/module-boundary.test.js`, `tests/performance-smoke.test.js`, and `tests/tokenizer-profile.test.js`.

- [ ] **Step 3: Package VSIX because new core files were added**

Run:

```bash
ALL_PROXY=socks5://127.0.0.1:7897 npm run package:vsix
```

Expected: PASS and creates or updates an ignored `vscode-sql-beautify-v1.0.0.vsix` artifact.

- [ ] **Step 4: Check VSIX contains new extractor modules and no obsolete formatter facades**

Run:

```bash
node <<'NODE'
var cp = require('child_process');
var vsix = 'vscode-sql-beautify-v1.0.0.vsix';
var output = cp.execFileSync('unzip', ['-l', vsix], { encoding: 'utf8' });
[
	'extension/lib/core/sql-node-utils.js',
	'extension/lib/core/sql-list-nodes.js',
	'extension/lib/core/sql-select-item-nodes.js',
	'extension/lib/core/sql-case-nodes.js',
	'extension/lib/core/sql-condition-nodes.js'
].forEach(function(entry) {
	if (output.indexOf(entry) < 0) {
		throw new Error('missing VSIX entry: ' + entry);
	}
});
[
	'extension/lib/core/sql-select-formatter.js',
	'extension/lib/core/sql-case-formatter.js',
	'extension/lib/core/sql-comment-formatter.js',
	'extension/lib/core/sql-condition-formatter.js',
	'extension/lib/sql-select-formatter.js',
	'extension/lib/sql-case-formatter.js',
	'extension/lib/sql-comment-formatter.js',
	'extension/lib/sql-condition-formatter.js'
].forEach(function(entry) {
	if (output.indexOf(entry) >= 0) {
		throw new Error('obsolete formatter facade present in VSIX: ' + entry);
	}
});
console.log('VSIX structured node extractor content check passed');
NODE
```

Expected: prints `VSIX structured node extractor content check passed`.

- [ ] **Step 5: Inspect final diff and status**

Run:

```bash
git status --short --ignored
git log --oneline -8
```

Expected:

- `git status --short --ignored` shows only ignored artifacts such as `.DS_Store`, `node_modules/`, and `.vsix` files.
- recent commits include the Task 1 through Task 7 commits.

- [ ] **Step 6: Final response checklist**

In the final implementation response, report:

- the final commit SHAs and messages
- `npm run test:verify` result
- `ALL_PROXY=socks5://127.0.0.1:7897 npm run package:vsix` result
- VSIX content check result
- any ignored artifacts left uncommitted

Do not claim formatter performance improved. This plan is a maintainability and extensibility split with performance smoke as a regression guard only.
