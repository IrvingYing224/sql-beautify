# Token Spacing Policy Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `lib/core/sql-render-token-spacing.js` the single source of truth for token-adjacency spacing used by final rendering, planned-width calculation, and snippet token rendering.

**Architecture:** Add a sequence-level `render_visible_tokens()` helper to `sql-render-token-spacing.js`, then reduce `sql-token-renderer.js` to a thin mutation-facing facade over that helper. Preserve formatter output while adding automated guards for function args, `IN`, `ORDER BY`, window `ORDER BY`, leading commas, comment alignment width, and module boundaries.

**Tech Stack:** CommonJS JavaScript, Node.js `assert` tests, existing structured formatter core under `lib/core/`, local verification with `npm run test:verify`.

---

## File Structure

- Create: `tests/token-spacing-policy.test.js`
  - Formatter-level behavior guard for the spacing cases that previously drifted.
- Modify: `tests/sql-token-renderer.test.js`
  - Snippet-level tests that assert `sql-token-renderer` and `sql-render-token-spacing.render_visible_tokens()` produce the same output after migration.
- Modify: `tests/module-boundary.test.js`
  - Assert the `sql-render-token-spacing.js` export surface and prevent private spacing helpers from returning to `sql-token-renderer.js`.
- Modify: `package.json`
  - Add `test:token-spacing-policy` and include it in `test:verify`.
- Modify: `lib/core/sql-render-token-spacing.js`
  - Add sequence-level rendering and option handling.
- Modify: `lib/core/sql-token-renderer.js`
  - Replace local spacing implementation with a facade.
- Modify: `docs/technical/sql-formatter-architecture.md`
  - Document the spacing policy boundary.

Do not modify `lib/adapters/`, `lib/experimental/ddl/`, root `lib/*.js` shims, publishing workflows, or `.vsix` artifacts.

---

### Task 1: Add Formatter-Level Spacing Regression Guard

**Files:**
- Create: `tests/token-spacing-policy.test.js`
- Modify: `package.json`

- [ ] **Step 1: Read the approved design**

Run:

```bash
sed -n '1,260p' docs/superpowers/specs/2026-06-09-token-spacing-policy-design.md
```

Expected: the design requires shared spacing policy in `sql-render-token-spacing.js`, a thin `sql-token-renderer.js` facade, no intentional formatter output changes, and local commands without proxy.

- [ ] **Step 2: Run baseline targeted checks**

Run:

```bash
node tests/sql-token-renderer.test.js
node tests/render-width.test.js
node tests/module-boundary.test.js
node tests/select-alignment.test.js
node tests/window-function-spacing.test.js
node tests/pipeline-idempotency.test.js
```

Expected: all commands pass before edits. If any baseline command fails, stop and report the exact failure before changing code.

- [ ] **Step 3: Create formatter-level token spacing tests**

Create `tests/token-spacing-policy.test.js` with this complete file:

```js
var assert = require('assert');
var sqlFormatter = require('../lib/sql-formatter');

function format(sql) {
	return sqlFormatter.format_sql(sql, {
		keywordCase: 'upper',
		commaStyle: 'leading',
		indentStyle: 'space',
		maxAlignWidth: 150,
		caseWhenThenWrapLength: 80,
		dialect: 'generic',
		unsupportedSyntaxPolicy: 'preserve'
	}).trim();
}

function run_case(name, input, expected) {
	var actual = format(input);
	assert.strictEqual(
		actual,
		expected.trim(),
		name + '\n--- actual ---\n' + actual + '\n--- expected ---\n' + expected.trim()
	);
}

function assert_contains(name, input, expectedFragment) {
	var actual = format(input);
	assert.ok(
		actual.indexOf(expectedFragment) >= 0,
		name + '\n--- missing fragment ---\n' + expectedFragment + '\n--- actual ---\n' + actual
	);
	return actual;
}

run_case(
	'inline comma spacing is consistent across function args, in lists, and order keys',
	"select coalesce(phone,email,'unknown') as contact_info from users where channel in ('app','web') order by dt desc,event_time desc",
	[
		"SELECT  coalesce(phone, email, 'unknown') AS contact_info",
		'FROM users',
		"WHERE channel IN ('app', 'web')",
		'ORDER BY dt DESC, event_time DESC'
	].join('\n')
);

assert_contains(
	'window order by keeps existing first-expression double-space and normal comma spacing',
	'select row_number() over(partition by ds order by pay_time desc,created_at desc) as rn from orders',
	'ROW_NUMBER() OVER(PARTITION BY ds ORDER BY  pay_time DESC, created_at DESC) AS rn'
);

run_case(
	'leading select comma style remains compact after comma',
	'select a,b,c from t',
	[
		'SELECT  a',
		'       ,b',
		'       ,c',
		'FROM t'
	].join('\n')
);

run_case(
	'comment alignment uses final rendered widths after comma normalization',
	[
		'SELECT  base.user_id',
		'       ,bAsE.user_type',
		'       ,CAST(bAsE.total_score AS InTeGeR)                AS score        -- 测试点1：基础类型转换 CAST 的空格清理',
		"       ,CoAlEsCe(base.phone,bAsE.email,'unknown')        AS contact_info -- 测试点2：多参数函数的逗号与空格清洗",
		'       ,CASE',
		"            WHEN base.age < 18              THEN 'minor'",
		"            WHEN base.age BETWEEN 18 AND 60 THEN 'adult'",
		"            ELSE 'senior'",
		'        END                                              AS age_group -- 测试点3：横向极度拥挤、完全不换行的 CASE WHEN',
		'       ,dAtE_sUb(CAST(base.login_date AS DATE),7)        AS wEeK_aGo  -- 测试点4：函数套函数（DATE_SUB 嵌套 CAST）',
		'FROM a'
	].join('\n'),
	[
		'SELECT  base.user_id',
		'       ,bAsE.user_type',
		'       ,CAST(bAsE.total_score AS InTeGeR)                AS score        -- 测试点1：基础类型转换 CAST 的空格清理',
		"       ,CoAlEsCe(base.phone, bAsE.email, 'unknown')      AS contact_info -- 测试点2：多参数函数的逗号与空格清洗",
		'       ,CASE',
		"            WHEN base.age < 18              THEN 'minor'",
		"            WHEN base.age BETWEEN 18 AND 60 THEN 'adult'",
		"            ELSE 'senior'",
		'        END                                              AS age_group    -- 测试点3：横向极度拥挤、完全不换行的 CASE WHEN',
		'       ,dAtE_sUb(CAST(base.login_date AS DATE), 7)       AS wEeK_aGo     -- 测试点4：函数套函数（DATE_SUB 嵌套 CAST）',
		'FROM a'
	].join('\n')
);

console.log('token spacing policy tests passed');
```

- [ ] **Step 4: Run the new formatter-level test**

Run:

```bash
node tests/token-spacing-policy.test.js
```

Expected: PASS on the current baseline. This locks current formatter behavior before refactoring.

- [ ] **Step 5: Add the test script**

Modify `package.json` scripts:

Add:

```json
"test:token-spacing-policy": "node tests/token-spacing-policy.test.js",
```

Insert `node tests/token-spacing-policy.test.js` into `test:verify` after `node tests/window-function-spacing.test.js` and before `node tests/condition-alignment.test.js`.

- [ ] **Step 6: Validate package JSON and focused test**

Run:

```bash
node -e "JSON.parse(require('fs').readFileSync('package.json','utf8')); console.log('package json ok')"
node tests/token-spacing-policy.test.js
```

Expected: prints `package json ok` and `token spacing policy tests passed`.

- [ ] **Step 7: Commit the green regression guard**

Run:

```bash
git add tests/token-spacing-policy.test.js package.json
git commit -m "test: add token spacing policy regression"
```

Expected: commit succeeds.

---

### Task 2: Consolidate Snippet Rendering Into Shared Spacing Policy

**Files:**
- Modify: `tests/sql-token-renderer.test.js`
- Modify: `tests/module-boundary.test.js`
- Modify: `lib/core/sql-render-token-spacing.js`
- Modify: `lib/core/sql-token-renderer.js`

- [ ] **Step 1: Replace `tests/sql-token-renderer.test.js` with shared-helper coverage**

Replace `tests/sql-token-renderer.test.js` with this complete file:

```js
var assert = require('assert');
var formatDocument = require('../lib/core/sql-format-document');
var scopeModel = require('../lib/core/sql-scope-model');
var navigation = require('../lib/core/sql-format-navigation');
var tokenRenderer = require('../lib/core/sql-token-renderer');
var tokenSpacing = require('../lib/core/sql-render-token-spacing');

function document_for(sql, options) {
	var config = Object.assign({ dialect: 'generic' }, options || {});
	var doc = formatDocument.from_text(sql, config);
	doc.scopes = scopeModel.build(doc, config);
	navigation.attach_scope_index(doc);
	return doc;
}

function code_tokens(doc) {
	return doc.codeTokens || [];
}

function tokens_between(tokens, startWord, endWord) {
	var start = -1;
	var end = tokens.length;
	for (var i = 0; i < tokens.length; i++) {
		if (tokens[i].type == 'word' && tokens[i].value.toUpperCase() == startWord && start < 0) {
			start = i;
		} else if (tokens[i].type == 'word' && tokens[i].value.toUpperCase() == endWord && start >= 0) {
			end = i;
			break;
		}
	}
	return tokens.slice(start, end);
}

function tokens_from_word(tokens, startWord) {
	for (var i = 0; i < tokens.length; i++) {
		if (tokens[i].type == 'word' && tokens[i].value.toUpperCase() == startWord) {
			return tokens.slice(i);
		}
	}
	return [];
}

function assert_render(name, document, tokens, options, expected) {
	var actual = tokenRenderer.render_tokens(document, tokens, options || {});
	assert.strictEqual(
		actual,
		expected,
		name + '\n--- actual ---\n' + actual + '\n--- expected ---\n' + expected
	);
	assert.strictEqual(
		tokenSpacing.render_visible_tokens(document, tokens, options || {}),
		actual,
		name + ' must match shared token spacing helper'
	);
}

var selectDoc = document_for('select row_number() over(partition by a order by b desc,c desc) as rn from t');
var selectTokens = tokens_between(code_tokens(selectDoc), 'ROW_NUMBER', 'AS');
assert_render(
	'token renderer preserves existing window ORDER BY spacing when requested',
	selectDoc,
	selectTokens,
	{
		applyKeywordCase: true,
		keywordCase: 'upper',
		unaryNumberMode: 'select',
		windowOrderBySpacing: true
	},
	'ROW_NUMBER() OVER(PARTITION BY a ORDER BY  b DESC, c DESC)'
);

assert_render(
	'token renderer keeps snippet window ORDER BY spacing opt-in',
	selectDoc,
	selectTokens,
	{},
	'row_number() over(partition by a order by b desc, c desc)'
);

assert_render(
	'token renderer skips null and undefined tokens',
	selectDoc,
	[null].concat(selectTokens.slice(0, 1)).concat([undefined]),
	{
		applyKeywordCase: true,
		keywordCase: 'lower'
	},
	'row_number'
);

assert_render(
	'token renderer handles null tokens before select binary plus',
	selectDoc,
	[selectTokens[0], null, {
		id: 'synthetic-plus',
		index: 1000,
		line: 0,
		type: 'operator',
		value: '+'
	}, {
		id: 'synthetic-one',
		index: 1001,
		line: 0,
		type: 'number',
		value: '1'
	}],
	{
		unaryNumberMode: 'select'
	},
	'row_number + 1'
);

var caseDoc = document_for('select case when x in (1, 2) then a +1 else coalesce(b, c) end as v from t');
var caseTokens = tokens_between(code_tokens(caseDoc), 'CASE', 'AS');
var preserveCommaGapTokenIndexes = {};
for (var i = 0; i < caseTokens.length; i++) {
	if (caseTokens[i].value == '2' || caseTokens[i].value == 'c') {
		preserveCommaGapTokenIndexes[String(caseTokens[i].index)] = true;
	}
}
assert_render(
	'token renderer preserves CASE-specific IN spacing, unary number, and function comma spacing',
	caseDoc,
	caseTokens,
	{
		spaceBeforeInParen: true,
		preserveCommaGapTokenIndexes: preserveCommaGapTokenIndexes,
		preserveCommaGapExceptFunctionName: 'COALESCE',
		unaryNumberMode: 'case'
	},
	'case when x in (1, 2) then a +1 else coalesce(b, c) end'
);

var commaDoc = document_for("select coalesce(phone,email,'unknown') as contact_info from users where channel in ('app','web') order by dt desc,event_time desc");
assert_render(
	'token renderer normalizes function argument comma spacing',
	commaDoc,
	tokens_between(code_tokens(commaDoc), 'COALESCE', 'AS'),
	{},
	"coalesce(phone, email, 'unknown')"
);
assert_render(
	'token renderer normalizes IN-list comma spacing',
	commaDoc,
	tokens_between(code_tokens(commaDoc), 'WHERE', 'ORDER'),
	{},
	"where channel in ('app', 'web')"
);
assert_render(
	'token renderer normalizes ORDER BY comma spacing',
	commaDoc,
	tokens_from_word(code_tokens(commaDoc), 'ORDER'),
	{},
	'order by dt desc, event_time desc'
);

var leadingCommaDoc = document_for('select a,b,c from t');
assert_render(
	'token renderer keeps leading comma prefix compact',
	leadingCommaDoc,
	code_tokens(leadingCommaDoc).slice(2, 4),
	{},
	',b'
);

var spacedScopeDoc = document_for('select fn(a,b) as c from t');
var fnTokens = tokens_between(code_tokens(spacedScopeDoc), 'FN', 'AS');
var spacedScopeId = null;
for (var s = 0; s < spacedScopeDoc.scopes.length; s++) {
	if (spacedScopeDoc.scopes[s].kind == 'functionCall') {
		spacedScopeId = spacedScopeDoc.scopes[s].id;
		break;
	}
}
assert_render(
	'token renderer supports caller-requested outer scope spacing',
	spacedScopeDoc,
	fnTokens,
	{
		spacedScopeId: spacedScopeId
	},
	'fn( a, b )'
);

console.log('sql token renderer tests passed');
```

- [ ] **Step 2: Add module-boundary red checks**

In `tests/module-boundary.test.js`, add this require near the existing top-level core requires:

```js
var sqlRenderTokenSpacing = require('../lib/core/sql-render-token-spacing');
```

After the `sqlRenderWidth` export assertion, add:

```js
assert.deepStrictEqual(
	Object.keys(sqlRenderTokenSpacing).sort(),
	['append_visible_token', 'render_visible_tokens', 'token_value'],
	'token spacing policy module must expose only token_value, append_visible_token, and render_visible_tokens'
);
```

After the existing assertion that `sql-case-mutations.js` and `sql-select-mutations.js` delegate `render_tokens`, add:

```js
var tokenRendererSource = read_source('lib/core/sql-token-renderer.js');
assert.ok(
	tokenRendererSource.indexOf("require('./sql-render-token-spacing')") >= 0,
	'sql-token-renderer.js must delegate spacing policy to sql-render-token-spacing'
);
[
	'trim_trailing_space',
	'output_is_leading_comma_prefix',
	'follows_window_order_by',
	'token_inside_scope_kind',
	'owner_function_scope',
	'should_preserve_comma_gap',
	'should_join_unary_number',
	'token_scope_by_open_index',
	'token_scope_by_close_index'
].forEach(function(functionName) {
	assert.strictEqual(
		new RegExp('function\\s+' + functionName + '\\s*\\(').test(tokenRendererSource),
		false,
		'sql-token-renderer.js must not carry private spacing helper implementation: ' + functionName
	);
});
```

- [ ] **Step 3: Run the red tests**

Run:

```bash
node tests/sql-token-renderer.test.js
node tests/module-boundary.test.js
```

Expected: `tests/sql-token-renderer.test.js` fails because `render_visible_tokens` is not exported, and `tests/module-boundary.test.js` fails because the export surface and facade boundary are not migrated yet.

- [ ] **Step 4: Add the shared sequence renderer helpers**

In `lib/core/sql-render-token-spacing.js`, add the keyword dependency at the top:

```js
var sqlKeywords = require('./sql-keywords');
```

Add this helper after `token_value()`:

```js
function rendered_token_value(token, options) {
	var value = token ? token.value : '';
	if (options && options.applyKeywordCase && token.type == 'word' && sqlKeywords.is_keyword(value)) {
		return options.keywordCase == 'lower' ? value.toLowerCase() : value.toUpperCase();
	}
	return value;
}
```

Add these helpers after `token_inside_scope_kind()`:

```js
function token_scope_by_open_index(document, token) {
	var scopes = document && document.scopes ? document.scopes : [];
	for (var i = 0; i < scopes.length; i++) {
		if (scopes[i].openTokenIndex == token.index) {
			return scopes[i];
		}
	}
	return null;
}

function token_scope_by_close_index(document, token) {
	var scopes = document && document.scopes ? document.scopes : [];
	for (var i = 0; i < scopes.length; i++) {
		if (scopes[i].closeTokenIndex == token.index) {
			return scopes[i];
		}
	}
	return null;
}
```

Add these helpers after `should_keep_original_comma_gap()`:

```js
function should_join_unary_number(tokens, index, mode) {
	var token = tokens[index];
	var previousToken = tokens[index - 1];
	if (!token
		|| token.type != 'number'
		|| !previousToken
		|| previousToken.type != 'operator'
		|| !/^[+-]$/.test(previousToken.value)) {
		return false;
	}

	if (mode == 'case') {
		return true;
	}

	if (mode != 'select') {
		return false;
	}

	var beforePreviousToken = tokens[index - 2];
	return index < 2
		|| (beforePreviousToken && beforePreviousToken.type == 'operator')
		|| (beforePreviousToken && beforePreviousToken.type == 'word' && /^(THEN|ELSE|WHEN|IN|AND|OR|NOT|SELECT)$/i.exec(beforePreviousToken.value))
		|| (beforePreviousToken && beforePreviousToken.type == 'punctuation' && /^(,|\(|\[)$/.test(beforePreviousToken.value));
}

function should_preserve_configured_comma_gap(document, previousToken, token, options) {
	if (!previousToken
		|| previousToken.type != 'punctuation'
		|| previousToken.value != ','
		|| !options
		|| !options.preserveCommaGapTokenIndexes
		|| !options.preserveCommaGapTokenIndexes[String(token.index)]) {
		return false;
	}
	if (options.preserveCommaGapExceptFunctionName
		&& token_inside_function_named(document, token, options.preserveCommaGapExceptFunctionName)) {
		return false;
	}
	return /[ \t]/.test(original_gap_between(document, previousToken, token));
}

function dialect_name(options, document) {
	if (options && options.dialect) {
		return options.dialect;
	}
	if (document && document.tokenizerOptions && document.tokenizerOptions.dialect) {
		return document.tokenizerOptions.dialect;
	}
	return 'generic';
}

function scope_open_suffix(document, token, options) {
	if (!options || options.spacedScopeId == null) {
		return '';
	}
	var openScope = token_scope_by_open_index(document, token);
	return openScope && openScope.id == options.spacedScopeId ? ' ' : '';
}

function scope_close_prefix(document, token, options) {
	if (!options || options.spacedScopeId == null) {
		return '';
	}
	var closeScope = token_scope_by_close_index(document, token);
	return closeScope && closeScope.id == options.spacedScopeId ? ' ' : '';
}
```

- [ ] **Step 5: Add optional behavior controls to `append_visible_token()`**

Change the `append_visible_token()` signature from:

```js
function append_visible_token(output, document, token, value, previousToken, dialect, groupByLine) {
```

to:

```js
function append_visible_token(output, document, token, value, previousToken, dialect, groupByLine, spacingOptions) {
	var behavior = spacingOptions || {};
```

In the two implicit unary-number branches inside `append_visible_token()`, add the `!behavior.disableImplicitUnaryNumberJoin` guard:

```js
	if (!behavior.disableImplicitUnaryNumberJoin
		&& (token.type == 'number' || token.type == 'word')
```

Do this for both branches that currently start with `if ((token.type == 'number' || token.type == 'word')`.

Change the window `ORDER BY` branch from:

```js
	if (follows_window_order_by(document, previousToken, token)) {
		return output + '  ' + value;
	}
```

to:

```js
	if (!behavior.disableWindowOrderBySpacing && follows_window_order_by(document, previousToken, token)) {
		return output + '  ' + value;
	}
```

Final renderer and width callers pass no eighth argument, so their current behavior remains unchanged.

- [ ] **Step 6: Add the sequence-level append wrapper and renderer**

Add this code before the export lines in `lib/core/sql-render-token-spacing.js`:

```js
function append_visible_token_with_options(output, document, tokens, index, value, previousToken, options) {
	var config = options || {};
	var token = tokens[index];
	var behavior = {
		disableWindowOrderBySpacing: !config.windowOrderBySpacing,
		disableImplicitUnaryNumberJoin: true
	};
	if (token.type == 'punctuation' && value == '(' && config.spacedScopeId != null) {
		var openSuffix = scope_open_suffix(document, token, config);
		if (config.spaceBeforeInParen && is_word_token(previousToken, 'IN')) {
			return trim_trailing_space(output) + ' ' + value + openSuffix;
		}
		if (openSuffix != '') {
			return append_visible_token(
				output,
				document,
				token,
				value,
				previousToken,
				config.dialect || dialect_name(config, document),
				config.groupByLine,
				behavior
			) + openSuffix;
		}
	}
	if (token.type == 'punctuation' && value == ')' && config.spacedScopeId != null) {
		var closePrefix = scope_close_prefix(document, token, config);
		if (closePrefix != '') {
			return trim_trailing_space(output) + closePrefix + value;
		}
	}
	if (token.type == 'punctuation'
		&& value == '('
		&& config.spaceBeforeInParen
		&& is_word_token(previousToken, 'IN')) {
		return trim_trailing_space(output) + ' ' + value;
	}
	if (config.compactOperatorToken && config.compactOperatorToken(document, token)) {
		return trim_trailing_space(output) + value;
	}
	if (config.followsCompactOperator && config.followsCompactOperator(document, previousToken, token)) {
		return output + value;
	}
	if (should_join_unary_number(tokens, index, config.unaryNumberMode)) {
		return output + value;
	}
	if (should_preserve_configured_comma_gap(document, previousToken, token, config)) {
		return trim_trailing_space(output) + ' ' + value;
	}
	var appended = append_visible_token(
		output,
		document,
		token,
		value,
		previousToken,
		config.dialect || dialect_name(config, document),
		config.groupByLine,
		behavior
	);
	if (token.type == 'operator') {
		return trim_trailing_space(appended);
	}
	return appended;
}

function render_visible_tokens(document, tokens, options) {
	var config = options || {};
	var output = '';
	var previousToken = null;

	for (var i = 0; i < (tokens || []).length; i++) {
		var token = tokens[i];
		if (!token) {
			continue;
		}

		output = append_visible_token_with_options(
			output,
			document,
			tokens,
			i,
			rendered_token_value(token, config),
			previousToken,
			config
		);
		previousToken = token;
	}

	return output;
}
```

Change the bottom exports to:

```js
exports.token_value = token_value;
exports.append_visible_token = append_visible_token;
exports.render_visible_tokens = render_visible_tokens;
```

- [ ] **Step 7: Replace `sql-token-renderer.js` with a facade**

Replace the entire contents of `lib/core/sql-token-renderer.js` with:

```js
var sqlRenderTokenSpacing = require('./sql-render-token-spacing');

function render_tokens(document, tokens, options) {
	return sqlRenderTokenSpacing.render_visible_tokens(document, tokens, options);
}

exports.render_tokens = render_tokens;
```

- [ ] **Step 8: Run focused syntax and behavior checks**

Run:

```bash
node -c lib/core/sql-render-token-spacing.js
node -c lib/core/sql-token-renderer.js
node tests/sql-token-renderer.test.js
node tests/module-boundary.test.js
node tests/token-spacing-policy.test.js
node tests/render-width.test.js
node tests/select-alignment.test.js
node tests/window-function-spacing.test.js
node tests/case-when.test.js
node tests/comment-alignment.test.js
node tests/pipeline-idempotency.test.js
```

Expected: all pass. If a snippet test fails, fix `sql-render-token-spacing.js`; do not put spacing logic back into `sql-token-renderer.js`.

- [ ] **Step 9: Inspect the facade**

Run:

```bash
wc -l lib/core/sql-token-renderer.js
sed -n '1,80p' lib/core/sql-token-renderer.js
```

Expected: `sql-token-renderer.js` is a small facade and contains no local spacing helper implementations.

- [ ] **Step 10: Commit the green consolidation**

Run:

```bash
git add tests/sql-token-renderer.test.js tests/module-boundary.test.js lib/core/sql-render-token-spacing.js lib/core/sql-token-renderer.js
git commit -m "refactor: consolidate token spacing policy"
```

Expected: commit succeeds.

---

### Task 3: Document Boundary And Run Full Verification

**Files:**
- Modify: `docs/technical/sql-formatter-architecture.md`

- [ ] **Step 1: Update architecture documentation**

In `docs/technical/sql-formatter-architecture.md`, replace this sentence:

```md
`lib/core/sql-structured-renderer.js` is the single rendering boundary for the structured pipeline. It applies mutations deterministically, renders comments from bound comment tokens, preserves protected token bytes, and enforces the final whitespace contract. Its implementation delegates focused helper work to `sql-render-move-state.js`, `sql-render-indent.js`, `sql-render-token-spacing.js`, `sql-render-line.js`, `sql-render-width.js`, and `sql-token-renderer.js`.
```

with:

```md
`lib/core/sql-structured-renderer.js` is the single rendering boundary for the structured pipeline. It applies mutations deterministically, renders comments from bound comment tokens, preserves protected token bytes, and enforces the final whitespace contract. Its implementation delegates focused helper work to `sql-render-move-state.js`, `sql-render-indent.js`, `sql-render-token-spacing.js`, `sql-render-line.js`, `sql-render-width.js`, and `sql-token-renderer.js`. Token-adjacency spacing policy lives in `sql-render-token-spacing.js`; final line rendering, planned-width calculation, and snippet rendering must share that policy. `sql-token-renderer.js` is the mutation-facing facade and must not carry private comma, parenthesis, operator, or window spacing rules.
```

- [ ] **Step 2: Run full local verification**

Run:

```bash
node tests/token-spacing-policy.test.js
node tests/sql-token-renderer.test.js
node tests/render-width.test.js
node tests/module-boundary.test.js
node tests/pipeline-idempotency.test.js
npm run test:verify
git diff --check
```

Expected: all pass. Do not use proxy for these local commands.

- [ ] **Step 3: Run package smoke**

Because `package.json` changed in Task 1, run:

```bash
npm run package:vsix
```

Expected: package command succeeds and generates an ignored `.vsix` artifact. Do not stage or commit the `.vsix`.

- [ ] **Step 4: Inspect VSIX contents**

Run:

```bash
node - <<'NODE'
var fs = require('fs');
var cp = require('child_process');
var vsix = fs.readdirSync('.').filter(function(file) {
	return /^vscode-sql-beautify-v.*\.vsix$/.test(file);
}).sort().pop();
if (!vsix) {
	throw new Error('no vsix found');
}
var out = cp.execFileSync('unzip', ['-l', vsix], { encoding: 'utf8' });
[
	'extension/lib/core/sql-render-token-spacing.js',
	'extension/lib/core/sql-token-renderer.js'
].forEach(function(path) {
	if (out.indexOf(path) < 0) {
		throw new Error('missing runtime file: ' + path);
	}
});
[
	'extension/tests/token-spacing-policy.test.js',
	'extension/docs/superpowers/specs/2026-06-09-token-spacing-policy-design.md',
	'extension/docs/superpowers/plans/2026-06-09-token-spacing-policy-plan.md',
	'extension/lib/core/sql-select-formatter.js',
	'extension/lib/core/sql-case-formatter.js',
	'extension/lib/core/sql-comment-formatter.js',
	'extension/lib/core/sql-condition-formatter.js'
].forEach(function(path) {
	if (out.indexOf(path) >= 0) {
		throw new Error('unexpected packaged file: ' + path);
	}
});
console.log('package smoke checked', vsix);
NODE
```

Expected: prints `package smoke checked <vsix name>`.

- [ ] **Step 5: Commit documentation**

Run:

```bash
git add docs/technical/sql-formatter-architecture.md
git commit -m "docs: document token spacing policy boundary"
```

Expected: commit succeeds.

- [ ] **Step 6: Final status check**

Run:

```bash
git status --short --ignored
```

Expected: no tracked or staged changes. Ignored entries may include `.DS_Store`, `node_modules/`, and generated `.vsix` artifacts.

---

## Final Review Checklist

- `sql-token-renderer.js` is a small facade over `sql-render-token-spacing.render_visible_tokens()`.
- `Object.keys(require('./lib/core/sql-render-token-spacing')).sort()` is exactly `['append_visible_token', 'render_visible_tokens', 'token_value']`.
- `tests/module-boundary.test.js` fails if private spacing helpers are added back to `sql-token-renderer.js`.
- Function args, `IN`, `ORDER BY`, window `ORDER BY`, leading select commas, and comment alignment are covered by automated tests.
- `npm run test:verify` passes without proxy.
- `npm run package:vsix` passes without proxy.
- Generated `.vsix` files remain ignored and uncommitted.
