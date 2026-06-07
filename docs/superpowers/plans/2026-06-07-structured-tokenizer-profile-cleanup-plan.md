# Structured Tokenizer Profile Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add tokenizer profiling, extract shared token rendering and comment-alignment width estimation from large structured mutation modules, and keep formatter output unchanged.

**Architecture:** The production formatter flow remains `FormatDocument -> ScopeModel -> FormatNodes -> MutationPlan -> StructuredRenderer`. A test-only profile helper wraps `sql-tokenizer.tokenize()` during local tests. Production helper modules `sql-token-renderer.js` and `sql-render-width.js` centralize repeated token rendering and planned-width logic, with any cache scoped to one helper context.

**Tech Stack:** CommonJS JavaScript, Node.js built-in `assert`, existing SQL formatter core under `lib/core/`, CLI regression tests under `tests/`, local packaging through `npm run package:vsix`.

---

## File Structure

Create:

- `tests/helpers/formatter-profile.js`: test-only tokenizer instrumentation helper.
- `tests/tokenizer-profile.test.js`: profile smoke that formats representative corpora and prints tokenizer count/ratio/hotspots.
- `tests/sql-token-renderer.test.js`: focused unit coverage for the new token renderer helper.
- `tests/render-width.test.js`: focused unit coverage for planned width estimation under a mutation plan.
- `lib/core/sql-token-renderer.js`: shared token-to-text renderer for mutation-planning helpers.
- `lib/core/sql-render-width.js`: planned line width and alignment width context for comment alignment.

Modify:

- `package.json`: add profile/helper test scripts and include them in `test:verify`.
- `tests/module-boundary.test.js`: assert new helpers exist, expose narrow export surfaces, and are included in `test:verify`.
- `lib/core/sql-select-mutations.js`: replace local token rendering rules with `sql-token-renderer`.
- `lib/core/sql-case-mutations.js`: replace local token rendering rules with `sql-token-renderer`.
- `lib/core/sql-comment-mutations.js`: replace nested planned-width engine with `sql-render-width`.
- `lib/core/sql-comment-spacing.js`: remove the unused private helper.

Do not modify:

- `lib/adapters/`
- `lib/experimental/ddl/`
- root `lib/*.js` shims
- `README.md`
- generated `.vsix` artifacts

## Task 1: Add Tokenizer Profile Instrumentation

**Files:**
- Create: `tests/tokenizer-profile.test.js`
- Create: `tests/helpers/formatter-profile.js`
- Modify: `package.json`
- Test: `tests/tokenizer-profile.test.js`

- [ ] **Step 1: Confirm branch and clean worktree**

Run:

```bash
git status --short --branch
```

Expected: branch is `codex/structured-formatter-pipeline-plan`; no tracked local changes.

- [ ] **Step 2: Read the approved spec**

Run:

```bash
sed -n '1,280p' docs/superpowers/specs/2026-06-07-structured-tokenizer-profile-cleanup-design.md
```

Expected: the spec requires profile-guided cleanup, zero formatter output changes, no global caches, and no adapter/experimental DDL changes.

- [ ] **Step 3: Write the failing tokenizer profile test**

Create `tests/tokenizer-profile.test.js` with this content:

```js
var assert = require('assert');
var sqlFormatter = require('../lib/sql-formatter');
var formatterProfile = require('./helpers/formatter-profile');

function default_options(options) {
	return Object.assign({
		keywordCase: 'upper',
		commaStyle: 'leading',
		indentStyle: 'space',
		maxAlignWidth: 150,
		caseWhenThenWrapLength: 80,
		dialect: 'generic',
		unsupportedSyntaxPolicy: 'preserve'
	}, options || {});
}

function performance_corpus() {
	var simpleUnit = 'select a as col_a, b as col_b from t where x=1 and y=2;\n';
	var commentHeavyCaseUnit = [
		'select',
		'case when city_id in (',
		'1001, -- city one',
		'1002 -- city two',
		") then concat_ws(',', name, city)",
		"else 'unknown'",
		'end as city_label',
		'from dim_user',
		"where ds='2026-05-17' and status=1;"
	].join('\n') + '\n';
	var nestedListUnit = [
		'select *',
		'from fact_orders',
		'where coalesce(',
		'buyer_id,',
		'payer_id',
		') in (',
		'1001, -- buyer one',
		'1002 -- buyer two',
		')',
		'and exists(select 1 from dim_user u where u.id=fact_orders.buyer_id);'
	].join('\n') + '\n';

	return new Array(1001).join(simpleUnit)
		+ new Array(101).join(commentHeavyCaseUnit)
		+ new Array(101).join(nestedListUnit);
}

var differentialCorpus = [
	{
		name: 'cte case join window comments',
		sql: [
			'with src as (',
			'select a.user_id,',
			'case when a.city_id in (',
			'1001, -- 北京',
			'1002 -- 上海',
			') then 1 else 0 end as city_flag,',
			'row_number() over(partition by a.user_id order by a.dt desc,a.ts desc) as rn',
			'from dwd_orders a',
			'left join dim_user u',
			'on -- join condition',
			'a.user_id = u.user_id',
			"and u.dt = '2026-05-17'",
			')',
			'select * from src where rn=1'
		].join('\n'),
		options: {}
	},
	{
		name: 'hive hint and hash comments',
		sql: [
			'select --+ MAPJOIN(dim)',
			'a.id,',
			'case when a.status = 1 then a.name else null end as user_name',
			'from fact a',
			'where a.ds = "2026-05-17"'
		].join('\n'),
		options: { dialect: 'hive' }
	},
	{
		name: 'postgres dollar string and json operators',
		sql: "select $$CASE WHEN -- keep$$ as s, payload->>'id' as id from t where payload ? 'id'",
		options: { dialect: 'postgres' }
	}
];

var inputs = [performance_corpus()];
for (var i = 0; i < differentialCorpus.length; i++) {
	inputs.push(differentialCorpus[i].sql);
}
var originalChars = inputs.join('\n').length;

var result = formatterProfile.with_tokenizer_profile(originalChars, function() {
	var perfOutput = sqlFormatter.format_sql(inputs[0], default_options());
	assert.ok(perfOutput.indexOf('-- city one') >= 0, 'profile corpus preserves CASE comments');
	assert.ok(perfOutput.indexOf('-- buyer one') >= 0, 'profile corpus preserves nested list comments');

	for (var i = 0; i < differentialCorpus.length; i++) {
		var item = differentialCorpus[i];
		var once = sqlFormatter.format_sql(item.sql, default_options(item.options)).trim();
		var twice = sqlFormatter.format_sql(once, default_options(item.options)).trim();
		assert.strictEqual(twice, once, item.name + ' remains idempotent during profile run');
	}
});

var profile = result.profile;
var topCallers = formatterProfile.top_callers(profile, 8);

assert.ok(profile.calls > 0, 'profile must count tokenizer calls');
assert.ok(profile.totalChars >= originalChars, 'profile must count tokenized characters');
assert.ok(profile.charRatio > 0, 'profile must expose tokenized/original character ratio');
assert.ok(profile.calls < 5000, 'tokenizer call count must stay below wide regression guard; actual=' + profile.calls);
assert.ok(profile.charRatio < 25, 'tokenized character ratio must stay below wide regression guard; actual=' + profile.charRatio);
assert.ok(topCallers.length > 0, 'profile must report tokenizer call sites');

console.log('tokenizer profile calls=' + profile.calls
	+ ' chars=' + profile.totalChars
	+ ' ratio=' + profile.charRatio.toFixed(2)
	+ ' top=' + topCallers.map(function(item) {
		return item.calls + 'x ' + item.source;
	}).join(' | '));
```

- [ ] **Step 4: Run the new test and verify it fails for the missing helper**

Run:

```bash
node tests/tokenizer-profile.test.js
```

Expected: FAIL with `Cannot find module './helpers/formatter-profile'`.

- [ ] **Step 5: Add the profile helper**

Create `tests/helpers/formatter-profile.js` with this content:

```js
var path = require('path');
var sqlTokenizer = require('../../lib/core/sql-tokenizer');

function normalize_source(line) {
	var cwd = process.cwd();
	var text = String(line || '').replace(/^\s*at\s+/, '');
	text = text.replace(cwd + path.sep, '');
	text = text.replace(/\(?([^()]+):[0-9]+:[0-9]+\)?$/g, '$1');
	return text;
}

function caller_source() {
	var stack = String(new Error().stack || '').split('\n');
	for (var i = 2; i < stack.length; i++) {
		var source = normalize_source(stack[i]);
		if (source.indexOf('tests/helpers/formatter-profile.js') >= 0) {
			continue;
		}
		if (source.indexOf('lib/core/sql-tokenizer.js') >= 0) {
			continue;
		}
		return source;
	}
	return 'unknown';
}

function snapshot(state) {
	var ratio = state.originalChars > 0
		? state.totalChars / state.originalChars
		: 0;

	return {
		calls: state.calls,
		totalChars: state.totalChars,
		originalChars: state.originalChars,
		charRatio: ratio,
		callers: Object.assign({}, state.callers)
	};
}

function with_tokenizer_profile(originalChars, fn) {
	var originalTokenize = sqlTokenizer.tokenize;
	var state = {
		calls: 0,
		totalChars: 0,
		originalChars: originalChars || 0,
		callers: {}
	};

	sqlTokenizer.tokenize = function profiled_tokenize(text, options) {
		var source = String(text || '');
		var caller = caller_source();
		state.calls += 1;
		state.totalChars += source.length;
		if (!state.callers[caller]) {
			state.callers[caller] = {
				calls: 0,
				chars: 0
			};
		}
		state.callers[caller].calls += 1;
		state.callers[caller].chars += source.length;
		return originalTokenize.call(sqlTokenizer, text, options);
	};

	try {
		var value = fn();
		return {
			value: value,
			profile: snapshot(state)
		};
	} finally {
		sqlTokenizer.tokenize = originalTokenize;
	}
}

function top_callers(profile, limit) {
	var callers = [];
	var source;

	for (source in (profile && profile.callers || {})) {
		if (Object.prototype.hasOwnProperty.call(profile.callers, source)) {
			callers.push({
				source: source,
				calls: profile.callers[source].calls,
				chars: profile.callers[source].chars
			});
		}
	}

	callers.sort(function(a, b) {
		if (b.calls != a.calls) {
			return b.calls - a.calls;
		}
		return b.chars - a.chars;
	});

	return callers.slice(0, limit || callers.length);
}

exports.with_tokenizer_profile = with_tokenizer_profile;
exports.top_callers = top_callers;
```

- [ ] **Step 6: Run the profile test and record the baseline output**

Run:

```bash
node tests/tokenizer-profile.test.js
```

Expected: PASS and prints one line starting with `tokenizer profile calls=`.

Copy the printed call count, character count, ratio, and top callers into the implementation notes for this branch. Do not hard-code those exact numbers into production code.

- [ ] **Step 7: Add package scripts**

Modify `package.json`:

Add this script near the other test scripts:

```json
"test:tokenizer-profile": "node tests/tokenizer-profile.test.js",
```

Add `node tests/tokenizer-profile.test.js` to `test:verify` immediately after `node tests/performance-smoke.test.js`.

- [ ] **Step 8: Run the targeted profile checks**

Run:

```bash
node tests/tokenizer-profile.test.js
npm run test:performance
```

Expected: both commands pass. The profile command prints tokenizer profile numbers; the performance command remains below the existing 5000ms threshold.

- [ ] **Step 9: Commit Task 1**

Run:

```bash
git add package.json tests/helpers/formatter-profile.js tests/tokenizer-profile.test.js
git commit -m "test: add structured tokenizer profile"
```

Expected: commit succeeds.

## Task 2: Extract Shared Token Rendering

**Files:**
- Create: `tests/sql-token-renderer.test.js`
- Create: `lib/core/sql-token-renderer.js`
- Modify: `lib/core/sql-select-mutations.js`
- Modify: `lib/core/sql-case-mutations.js`
- Modify: `package.json`
- Test: `tests/sql-token-renderer.test.js`
- Test: `tests/case-when.test.js`
- Test: `tests/select-alignment.test.js`
- Test: `tests/window-function-spacing.test.js`
- Test: `tests/structured-differential.test.js`
- Test: `tests/pipeline-idempotency.test.js`

- [ ] **Step 1: Write the failing token renderer unit test**

Create `tests/sql-token-renderer.test.js` with this content:

```js
var assert = require('assert');
var formatDocument = require('../lib/core/sql-format-document');
var scopeModel = require('../lib/core/sql-scope-model');
var navigation = require('../lib/core/sql-format-navigation');
var tokenRenderer = require('../lib/core/sql-token-renderer');

function document_for(sql, options) {
	var doc = formatDocument.from_text(sql, Object.assign({ dialect: 'generic' }, options || {}));
	doc.scopes = scopeModel.build(doc, Object.assign({ dialect: 'generic' }, options || {}));
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

var selectDoc = document_for('select row_number() over(partition by a order by b desc,c desc) as rn from t');
var selectTokens = tokens_between(code_tokens(selectDoc), 'ROW_NUMBER', 'AS');
assert.strictEqual(
	tokenRenderer.render_tokens(selectDoc, selectTokens, {
		applyKeywordCase: true,
		keywordCase: 'upper',
		unaryNumberMode: 'select',
		windowOrderBySpacing: true
	}),
	'ROW_NUMBER() OVER(PARTITION BY a ORDER BY  b DESC,c DESC)',
	'token renderer preserves existing window ORDER BY spacing'
);

var caseDoc = document_for('select case when x in (1, 2) then a +1 else coalesce(b, c) end as v from t');
var caseTokens = tokens_between(code_tokens(caseDoc), 'CASE', 'AS');
var preserveCommaGapTokenIndexes = {};
for (var i = 0; i < caseTokens.length; i++) {
	if (caseTokens[i].value == '2' || caseTokens[i].value == 'c') {
		preserveCommaGapTokenIndexes[String(caseTokens[i].index)] = true;
	}
}
assert.strictEqual(
	tokenRenderer.render_tokens(caseDoc, caseTokens, {
		spaceBeforeInParen: true,
		preserveCommaGapTokenIndexes: preserveCommaGapTokenIndexes,
		preserveCommaGapExceptFunctionName: 'COALESCE',
		unaryNumberMode: 'case'
	}),
	'case when x in (1, 2) then a +1 else coalesce(b,c) end',
	'token renderer preserves CASE-specific IN, unary number, and COALESCE comma behavior'
);

console.log('sql token renderer tests passed');
```

- [ ] **Step 2: Run the unit test and verify it fails for the missing module**

Run:

```bash
node tests/sql-token-renderer.test.js
```

Expected: FAIL with `Cannot find module '../lib/core/sql-token-renderer'`.

- [ ] **Step 3: Add the shared token renderer**

Create `lib/core/sql-token-renderer.js` with this content:

```js
var sqlKeywords = require('./sql-keywords');

function token_value_text(token) {
	return token ? token.value : '';
}

function original_gap_between(document, previousToken, token) {
	if (!document || !previousToken || !token || previousToken.line != token.line) {
		return '';
	}
	return String(document.source || '').slice(previousToken.end, token.start);
}

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

function is_word_token(token, value) {
	if (!token || token.type != 'word') {
		return false;
	}
	if (typeof value == 'undefined') {
		return true;
	}
	return token.value.toUpperCase() == value;
}

function token_inside_scope_kind(document, token, kind) {
	var scopes = document && document.scopes ? document.scopes : [];
	for (var i = 0; i < scopes.length; i++) {
		if (scopes[i].kind == kind
			&& token.index >= scopes[i].startTokenIndex
			&& token.index <= scopes[i].endTokenIndex) {
			return true;
		}
	}
	return false;
}

function follows_window_order_by(document, tokens, index) {
	var token = tokens && tokens[index];
	if (!token || index < 2 || !token_inside_scope_kind(document, token, 'windowSpec')) {
		return false;
	}
	return tokens[index - 1]
		&& tokens[index - 2]
		&& is_word_token(tokens[index - 1], 'BY')
		&& is_word_token(tokens[index - 2], 'ORDER');
}

function owner_function_scope(document, token) {
	var scopes = document && document.scopes ? document.scopes : [];
	var match = null;
	for (var i = 0; i < scopes.length; i++) {
		var scope = scopes[i];
		if (scope.kind != 'functionCall'
			|| token.index < scope.startTokenIndex
			|| token.index > scope.endTokenIndex) {
			continue;
		}
		if (!match || scope.startTokenIndex >= match.startTokenIndex) {
			match = scope;
		}
	}
	return match;
}

function token_inside_function_named(document, token, name) {
	var scope = owner_function_scope(document, token);
	if (!scope || typeof scope.startTokenIndex != 'number') {
		return false;
	}
	var ownerToken = document.tokens[scope.startTokenIndex - 1];
	return ownerToken
		&& ownerToken.type == 'word'
		&& ownerToken.value.toUpperCase() == String(name || '').toUpperCase();
}

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

	return index < 2
		|| tokens[index - 2].type == 'operator'
		|| (tokens[index - 2].type == 'word' && /^(THEN|ELSE|WHEN|IN|AND|OR|NOT|SELECT)$/i.exec(tokens[index - 2].value))
		|| (tokens[index - 2].type == 'punctuation' && /^(,|\(|\[)$/.test(tokens[index - 2].value));
}

function rendered_token_value(token, options) {
	var value = token_value_text(token);
	if (options.applyKeywordCase && token.type == 'word' && sqlKeywords.is_keyword(value)) {
		return options.keywordCase == 'lower' ? value.toLowerCase() : value.toUpperCase();
	}
	return value;
}

function should_preserve_comma_gap(document, previousToken, token, options) {
	if (!previousToken
		|| previousToken.type != 'punctuation'
		|| previousToken.value != ','
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

function render_tokens(document, tokens, options) {
	var config = options || {};
	var output = '';
	var previousToken = null;

	for (var i = 0; i < (tokens || []).length; i++) {
		var token = tokens[i];
		var value = rendered_token_value(token, config);

		if (output == '') {
			output = value;
		} else if (token.type == 'punctuation'
			&& (value == ',' || value == ';' || value == ']' || value == '.')) {
			output = output.replace(/[ \t]+$/g, '') + value;
		} else if (token.type == 'punctuation' && value == ')') {
			var closeScope = token_scope_by_close_index(document, token);
			var closePrefix = closeScope && closeScope.id == config.spacedScopeId ? ' ' : '';
			output = output.replace(/[ \t]+$/g, '') + closePrefix + value;
		} else if (token.type == 'punctuation' && value == '(') {
			var openScope = token_scope_by_open_index(document, token);
			var openSuffix = openScope && openScope.id == config.spacedScopeId ? ' ' : '';
			if (config.spaceBeforeInParen && is_word_token(previousToken, 'IN')) {
				output = output.replace(/[ \t]+$/g, '') + ' ' + value + openSuffix;
			} else {
				output = output.replace(/[ \t]+$/g, '') + value + openSuffix;
			}
		} else if (config.compactOperatorToken && config.compactOperatorToken(document, token)) {
			output = output.replace(/[ \t]+$/g, '') + value;
		} else if (config.followsCompactOperator && config.followsCompactOperator(document, previousToken, token)) {
			output += value;
		} else if (should_join_unary_number(tokens, i, config.unaryNumberMode)) {
			output += value;
		} else if (should_preserve_comma_gap(document, previousToken, token, config)) {
			output = output.replace(/[ \t]+$/g, '') + ' ' + value;
		} else if (config.windowOrderBySpacing && follows_window_order_by(document, tokens, i)) {
			output += '  ' + value;
		} else if (/[\s(.,\[]$/.test(output)) {
			output += value;
		} else {
			output += ' ' + value;
		}

		previousToken = token;
	}

	return output;
}

exports.render_tokens = render_tokens;
```

- [ ] **Step 4: Run the renderer unit test**

Run:

```bash
node tests/sql-token-renderer.test.js
```

Expected: PASS.

- [ ] **Step 5: Wire SELECT mutations through the shared renderer**

Modify `lib/core/sql-select-mutations.js`:

Remove this import:

```js
var sqlKeywords = require('./sql-keywords');
```

Add this import with the other core imports:

```js
var sqlTokenRenderer = require('./sql-token-renderer');
```

Replace the full body of `render_node_tokens_with_options()` with:

```js
function render_node_tokens_with_options(document, tokens, options, spacedScopeId) {
	return sqlTokenRenderer.render_tokens(document, tokens, {
		applyKeywordCase: true,
		keywordCase: options && options.keywordCase,
		spacedScopeId: spacedScopeId,
		unaryNumberMode: 'select',
		windowOrderBySpacing: true
	});
}
```

Keep `render_node_tokens()` as a wrapper:

```js
function render_node_tokens(document, tokens) {
	return render_node_tokens_with_options(document, tokens, null, null);
}
```

Delete these SELECT-local helpers if `rg` confirms no remaining use in `lib/core/sql-select-mutations.js`:

```text
token_inside_scope_kind
follows_window_order_by
token_scope_by_open_index
token_scope_by_close_index
```

- [ ] **Step 6: Wire CASE mutations through the shared renderer**

Modify `lib/core/sql-case-mutations.js`:

Add this import with the other core imports:

```js
var sqlTokenRenderer = require('./sql-token-renderer');
```

Replace the full body of `render_token_values()` with:

```js
function render_token_values(document, tokens, preserveCommaGapTokenIndexes) {
	return sqlTokenRenderer.render_tokens(document, tokens, {
		spaceBeforeInParen: true,
		preserveCommaGapTokenIndexes: preserveCommaGapTokenIndexes,
		preserveCommaGapExceptFunctionName: 'COALESCE',
		compactOperatorToken: is_originally_compact_case_function_plus,
		followsCompactOperator: follows_originally_compact_case_function_plus,
		unaryNumberMode: 'case'
	});
}
```

Keep CASE-specific helpers used by those callbacks:

```text
is_originally_compact_case_function_plus
follows_originally_compact_case_function_plus
token_in_case_value
token_inside_function_named
owner_function_scope
original_gap_between
```

After the replacement, run:

```bash
rg -n "function render_token_values|function render_node_tokens_with_options|sqlKeywords|token_scope_by_open_index|token_scope_by_close_index|follows_window_order_by" lib/core/sql-case-mutations.js lib/core/sql-select-mutations.js
```

Expected: CASE keeps only the `render_token_values` wrapper; SELECT keeps only the `render_node_tokens_with_options` wrapper; no `sqlKeywords` import remains in `sql-select-mutations.js`.

- [ ] **Step 7: Add the renderer unit test to package scripts**

Modify `package.json`:

Add this script near the other structured tests:

```json
"test:token-renderer": "node tests/sql-token-renderer.test.js",
```

Add `node tests/sql-token-renderer.test.js` to `test:verify` immediately after `node tests/format-navigation.test.js`.

- [ ] **Step 8: Run targeted renderer and output tests**

Run:

```bash
node -c lib/core/sql-token-renderer.js
node -c lib/core/sql-select-mutations.js
node -c lib/core/sql-case-mutations.js
node tests/sql-token-renderer.test.js
node tests/case-when.test.js
node tests/select-alignment.test.js
node tests/window-function-spacing.test.js
node tests/structured-differential.test.js
node tests/pipeline-idempotency.test.js
```

Expected: all commands pass. If any formatter output assertion changes, treat it as a regression and fix the extraction rather than updating expected output.

- [ ] **Step 9: Commit Task 2**

Run:

```bash
git add package.json lib/core/sql-token-renderer.js lib/core/sql-select-mutations.js lib/core/sql-case-mutations.js tests/sql-token-renderer.test.js
git commit -m "refactor: extract structured token renderer"
```

Expected: commit succeeds.

## Task 3: Extract Comment Alignment Width Context

**Files:**
- Create: `tests/render-width.test.js`
- Create: `lib/core/sql-render-width.js`
- Modify: `lib/core/sql-comment-mutations.js`
- Modify: `package.json`
- Test: `tests/render-width.test.js`
- Test: `tests/comment-alignment.test.js`
- Test: `tests/token-boundary.test.js`
- Test: `tests/pipeline-idempotency.test.js`
- Test: `tests/tokenizer-profile.test.js`

- [ ] **Step 1: Write the failing render width unit test**

Create `tests/render-width.test.js` with this content:

```js
var assert = require('assert');
var formatDocument = require('../lib/core/sql-format-document');
var scopeModel = require('../lib/core/sql-scope-model');
var formatNodes = require('../lib/core/sql-format-nodes');
var navigation = require('../lib/core/sql-format-navigation');
var mutations = require('../lib/core/sql-format-mutations');
var renderWidth = require('../lib/core/sql-render-width');

function build_context(sql) {
	var config = {
		keywordCase: 'upper',
		commaStyle: 'leading',
		indentStyle: 'space',
		maxAlignWidth: 150,
		caseWhenThenWrapLength: 80,
		dialect: 'generic',
		unsupportedSyntaxPolicy: 'preserve'
	};
	var doc = formatDocument.from_text(sql, config);
	doc.scopes = scopeModel.build(doc, config);
	navigation.attach_scope_index(doc);
	var nodes = formatNodes.extract(doc, config);
	doc.nodes = nodes;
	return {
		document: doc,
		nodes: nodes,
		mutations: mutations.create(),
		config: config
	};
}

var base = build_context('select a as col -- first\nfrom t\n');
var width = renderWidth.create_width_context(base.document, base.nodes, base.mutations, base.config);
assert.strictEqual(width.planned_code_width(base.document.lines[0]), 'select a as col'.length, 'plain planned code width ignores trailing comment');
assert.strictEqual(width.planned_alignment_width(base.document.lines[0]), 'select a'.length, 'alignment width stops before top-level AS');
assert.strictEqual(width.planned_join_prefix_width(base.document.lines[0]), 0, 'unjoined line has no join prefix width');

mutations.add_line_indent(base.mutations, 0, '    ');
width = renderWidth.create_width_context(base.document, base.nodes, base.mutations, base.config);
assert.strictEqual(width.planned_code_width(base.document.lines[0]), 4 + 'select a as col'.length, 'line indent mutation contributes to code width');
assert.strictEqual(width.planned_code_segment(base.document.lines[0]), '    select a as col', 'planned code segment includes effective indent');

console.log('render width tests passed');
```

- [ ] **Step 2: Run the unit test and verify it fails for the missing module**

Run:

```bash
node tests/render-width.test.js
```

Expected: FAIL with `Cannot find module '../lib/core/sql-render-width'`.

- [ ] **Step 3: Create the width helper by moving existing nested width logic**

Create `lib/core/sql-render-width.js`.

Move the following nested helpers out of `apply_comment_alignment_mutations()` in `lib/core/sql-comment-mutations.js` into `lib/core/sql-render-width.js`, preserving behavior:

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
token_after_case_end_on_same_line
is_case_end_alias_comment_line
is_case_branch_value_comment_line
```

Wrap those moved helpers in this public factory. Build `movedSeparatorsByLine` and `removedTokenIds` at factory scope by moving the current setup loops from the top of `apply_comment_alignment_mutations()` without changing the loop logic:

```js
function create_width_context(document, nodes, mutations, config) {
	var movedSeparatorsByLine = {};
	var removedTokenIds = {};
	var alignmentWidthCache = {};
	var moveIndex;
	var tokenOmissionKey;

	for (moveIndex = 0; moveIndex < (mutations.separatorMoves || []).length; moveIndex++) {
		var move = mutations.separatorMoves[moveIndex];
		var separator = separator_node_for_id(move.separatorId);
		if (!separator) {
			continue;
		}
		removedTokenIds[String(separator.tokenId)] = true;
		if (move.target && move.target.placement == 'linePrefix' && move.target.lineIndex != null) {
			var lineKey = String(move.target.lineIndex);
			if (!movedSeparatorsByLine[lineKey]) {
				movedSeparatorsByLine[lineKey] = [];
			}
			movedSeparatorsByLine[lineKey].push(move);
		}
	}

	for (tokenOmissionKey in mutations.tokenOmissions) {
		if (!Object.prototype.hasOwnProperty.call(mutations.tokenOmissions, tokenOmissionKey)) {
			continue;
		}
		removedTokenIds[String(mutations.tokenOmissions[tokenOmissionKey].tokenId)] = true;
	}

	return {
		planned_prefix_width: planned_prefix_width,
		planned_code_width: planned_code_width,
		planned_join_prefix_width: planned_join_prefix_width,
		planned_code_segment: planned_code_segment,
		planned_alignment_width: planned_alignment_width,
		is_case_end_alias_comment_line: is_case_end_alias_comment_line,
		is_case_branch_value_comment_line: is_case_branch_value_comment_line
	};
}

exports.create_width_context = create_width_context;
```

Inside `create_width_context()`, replace direct `get_alignment_width_for_code(...)` calls with this per-context cached wrapper:

```js
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
```

Use `cached_alignment_width_for_code(...)` anywhere the moved width logic only needs `.width`.

Required imports at the top of `lib/core/sql-render-width.js`:

```js
var sqlFormatUtils = require('./sql-format-utils');
var sqlCaseUtils = require('./sql-case-utils');
var sqlFormatMutations = require('./sql-format-mutations');
var sqlFormatNavigation = require('./sql-format-navigation');
var expand_tabs_for_width = sqlFormatUtils.expand_tabs_for_width;
var get_alignment_width_for_code = sqlCaseUtils.get_alignment_width_for_code;
```

- [ ] **Step 4: Wire comment mutations through the width helper**

Modify `lib/core/sql-comment-mutations.js`:

Add this import:

```js
var sqlRenderWidth = require('./sql-render-width');
```

Remove these imports and local aliases if they are no longer used after extraction:

```js
var sqlCaseUtils = require('./sql-case-utils');
var expand_tabs_for_width = sqlFormatUtils.expand_tabs_for_width;
var get_alignment_width_for_code = sqlCaseUtils.get_alignment_width_for_code;
```

Near the top of `apply_comment_alignment_mutations()`, after `removedTokenIds` and `movedSeparatorsByLine` have been removed into the helper, create the width context:

```js
var widthContext = sqlRenderWidth.create_width_context(document, nodes, mutations, config);
```

Replace local width helper calls:

```text
planned_code_width(line) -> widthContext.planned_code_width(line)
planned_alignment_width(line) -> widthContext.planned_alignment_width(line)
planned_join_prefix_width(line) -> widthContext.planned_join_prefix_width(line)
planned_prefix_width(line.index) -> widthContext.planned_prefix_width(line.index)
is_case_end_alias_comment_line(line.index) -> widthContext.is_case_end_alias_comment_line(line.index)
is_case_branch_value_comment_line(line.index) -> widthContext.is_case_branch_value_comment_line(line.index)
```

Keep alignment grouping helpers in `sql-comment-mutations.js`, including:

```text
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

- [ ] **Step 5: Run the render width unit test**

Run:

```bash
node -c lib/core/sql-render-width.js
node -c lib/core/sql-comment-mutations.js
node tests/render-width.test.js
```

Expected: all commands pass.

- [ ] **Step 6: Add the render width test to package scripts**

Modify `package.json`:

Add this script near the other structured tests:

```json
"test:render-width": "node tests/render-width.test.js",
```

Add `node tests/render-width.test.js` to `test:verify` immediately after `node tests/sql-token-renderer.test.js`.

- [ ] **Step 7: Run comment, token, idempotency, and profile checks**

Run:

```bash
node tests/comment-alignment.test.js
node tests/token-boundary.test.js
node tests/pipeline-idempotency.test.js
node tests/tokenizer-profile.test.js
```

Expected: all commands pass. Record the new tokenizer profile output next to the Task 1 baseline. The call count and character ratio must not exceed the wide guards in `tests/tokenizer-profile.test.js`.

- [ ] **Step 8: Commit Task 3**

Run:

```bash
git add package.json lib/core/sql-render-width.js lib/core/sql-comment-mutations.js tests/render-width.test.js
git commit -m "refactor: extract comment alignment width context"
```

Expected: commit succeeds.

## Task 4: Enforce Boundaries And Remove Leftover Comment Spacing Helper

**Files:**
- Modify: `tests/module-boundary.test.js`
- Modify: `lib/core/sql-comment-spacing.js`
- Test: `tests/module-boundary.test.js`
- Test: `tests/tokenizer-profile.test.js`

- [ ] **Step 1: Remove the unused private helper**

Modify `lib/core/sql-comment-spacing.js`.

Delete this function:

```js
function is_mysql_hash_comment_enabled(tokenizer_options) {
	return tokenizer_options && tokenizer_options.dialect == 'mysql';
}
```

Keep the module export unchanged:

```js
exports.normalize_line_comment_spacing = normalize_line_comment_spacing;
```

- [ ] **Step 2: Add module-boundary imports for new helpers**

Modify `tests/module-boundary.test.js`.

Add these imports near the existing structured core imports:

```js
var sqlTokenRenderer = require('../lib/core/sql-token-renderer');
var sqlRenderWidth = require('../lib/core/sql-render-width');
```

- [ ] **Step 3: Add exact export assertions**

In `tests/module-boundary.test.js`, after the existing exact export assertions for mutation modules and `sqlCommentSpacing`, add:

```js
assert.deepStrictEqual(
	Object.keys(sqlTokenRenderer).sort(),
	['render_tokens'],
	'token renderer must expose only render_tokens'
);
assert.deepStrictEqual(
	Object.keys(sqlRenderWidth).sort(),
	['create_width_context'],
	'render width helper must expose only create_width_context'
);
```

- [ ] **Step 4: Add file existence assertions**

In `tests/module-boundary.test.js`, near the existing `fs.existsSync` assertions for structured core modules, add:

```js
assert.ok(
	fs.existsSync(path.join(__dirname, '..', 'lib/core/sql-token-renderer.js')),
	'structured token renderer module must exist'
);
assert.ok(
	fs.existsSync(path.join(__dirname, '..', 'lib/core/sql-render-width.js')),
	'structured render width module must exist'
);
```

- [ ] **Step 5: Guard against copied renderer and width engines**

In `tests/module-boundary.test.js`, add these source checks after the existing helper duplication checks:

```js
[
	'lib/core/sql-case-mutations.js',
	'lib/core/sql-select-mutations.js'
].forEach(function(relativePath) {
	var source = read_source(relativePath);
	assert.strictEqual(
		/function\s+render_tokens\s*\(/.test(source),
		false,
		relativePath + ' must delegate shared token rendering to sql-token-renderer'
	);
});

var commentMutationSource = read_source('lib/core/sql-comment-mutations.js');
[
	'planned_code_width',
	'planned_alignment_width',
	'planned_join_prefix_width',
	'planned_code_segment'
].forEach(function(functionName) {
	assert.strictEqual(
		new RegExp('function\\s+' + functionName + '\\s*\\(').test(commentMutationSource),
		false,
		'sql-comment-mutations.js must delegate width helper implementation: ' + functionName
	);
});
```

- [ ] **Step 6: Require new tests in `test:verify` boundary assertion**

In `tests/module-boundary.test.js`, extend the `verifyScript` expected test list with:

```js
'tests/tokenizer-profile.test.js',
'tests/sql-token-renderer.test.js',
'tests/render-width.test.js',
```

- [ ] **Step 7: Run boundary and profile checks**

Run:

```bash
node -c lib/core/sql-comment-spacing.js
node tests/module-boundary.test.js
node tests/tokenizer-profile.test.js
```

Expected: all commands pass. `tests/tokenizer-profile.test.js` prints tokenizer profile numbers.

- [ ] **Step 8: Commit Task 4**

Run:

```bash
git add tests/module-boundary.test.js lib/core/sql-comment-spacing.js
git commit -m "test: enforce structured renderer helper boundaries"
```

Expected: commit succeeds.

## Task 5: Full Verification And Package Smoke

**Files:**
- Read: `package.json`
- Read: changed files from Tasks 1-4
- Test: full verification and packaging

- [ ] **Step 1: Run syntax checks for changed live modules**

Run:

```bash
node -c lib/core/sql-case-mutations.js
node -c lib/core/sql-select-mutations.js
node -c lib/core/sql-comment-mutations.js
node -c lib/core/sql-token-renderer.js
node -c lib/core/sql-render-width.js
node -c lib/core/sql-comment-spacing.js
```

Expected: all commands exit 0.

- [ ] **Step 2: Run targeted structured regressions**

Run:

```bash
node tests/sql-token-renderer.test.js
node tests/render-width.test.js
node tests/comment-alignment.test.js
node tests/case-when.test.js
node tests/select-alignment.test.js
node tests/window-function-spacing.test.js
node tests/structured-differential.test.js
node tests/token-boundary.test.js
node tests/pipeline-idempotency.test.js
node tests/tokenizer-profile.test.js
node tests/module-boundary.test.js
```

Expected: all commands pass. Record the final tokenizer profile line.

- [ ] **Step 3: Run full verification**

Run:

```bash
npm run test:verify
```

Expected: PASS, including `tests/performance-smoke.test.js` under the existing 5000ms threshold and the new profile/helper tests.

- [ ] **Step 4: Run package smoke**

Run:

```bash
npm run package:vsix
```

Expected: PASS and creates an ignored local `.vsix` artifact. Do not stage or commit the `.vsix` file.

- [ ] **Step 5: Inspect package contents for new helper inclusion and deleted facade absence**

Run:

```bash
node -e "const fs=require('fs'); const cp=require('child_process'); const vsix=fs.readdirSync('.').filter(f=>/^vscode-sql-beautify-v.*\\.vsix$/.test(f)).sort().pop(); if(!vsix) throw new Error('no vsix found'); const out=cp.execFileSync('unzip',['-l',vsix],{encoding:'utf8'}); ['extension/lib/core/sql-token-renderer.js','extension/lib/core/sql-render-width.js'].forEach(p=>{ if(!out.includes(p)) throw new Error('missing '+p+' in '+vsix); }); ['extension/lib/core/sql-select-formatter.js','extension/lib/core/sql-case-formatter.js','extension/lib/core/sql-comment-formatter.js','extension/lib/core/sql-condition-formatter.js'].forEach(p=>{ if(out.includes(p)) throw new Error('obsolete formatter facade packaged: '+p); }); console.log('package smoke checked', vsix);"
```

Expected: prints `package smoke checked <vsix file>` and exits 0.

- [ ] **Step 6: Confirm worktree state**

Run:

```bash
git status --short --ignored
```

Expected: no tracked changes. Ignored `.vsix` artifacts may be listed under ignored files only.

- [ ] **Step 7: Final implementation notes**

In the final response for the implementation session, report the exact profile lines printed in Task 1 Step 6 and Task 5 Step 2. Use this format and replace the descriptive phrases with the recorded command output:

```text
baseline tokenizer profile: tokenizer profile calls line from Task 1 Step 6
final tokenizer profile: tokenizer profile calls line from Task 5 Step 2
performance smoke: elapsed millisecond line from tests/performance-smoke.test.js
verification: npm run test:verify passed; npm run package:vsix passed
artifact note: generated .vsix is ignored and was not committed
```

Expected: the implementation session can explain whether tokenizer work improved, stayed flat, or regressed while still proving formatter behavior did not change.
