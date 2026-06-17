# Tokenizer Query Correctness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix tokenizer literal corruption and compact subquery idempotency defects without mixing in cleanup-only refactors.

**Architecture:** Keep the fix inside the existing structured formatter core. `lib/core/sql-tokenizer.js` will own literal and Hive substitution token recognition, while `lib/core/sql-layout-formatter.js` will make real parenthesized query scopes expand on the first pass so compact CTE and `IN (select ...)` inputs reach a stable layout immediately.

**Tech Stack:** CommonJS JavaScript, Node.js `assert` tests, existing SQL Beautify core under `lib/core/`, local verification with `npm run test:verify`.

---

## File Structure

- Modify: `tests/token-boundary.test.js`
  - Add failing regression tests for numeric literal tokens, typed quoted literals, formatter output, and idempotency.
- Modify: `tests/hive-regression.test.js`
  - Add failing regression tests for Hive `${...}` substitutions in table names and predicates.
- Modify: `tests/pipeline-idempotency.test.js`
  - Add failing regression tests for compact CTE and compact `IN (select ...)` query layout.
- Modify: `lib/core/sql-tokenizer.js`
  - Add focused readers for exponent decimals, leading-dot decimals, hex numbers, adjacent typed quoted literals, and `${...}` substitutions.
- Modify: `lib/core/sql-layout-formatter.js`
  - Replace the broad `IN` / `EXISTS` inline query exemption with a structural rule that expands every non-root parenthesized query scope on the first pass.

Do not modify `lib/adapters/`, `lib/experimental/ddl/`, root `lib/*.js` shims, README, package metadata, `sql-clause-splitter.js`, `sql-shield.js`, publishing workflows, or `.vsix` artifacts.

---

### Task 1: Add Failing Tokenizer and Hive Regression Tests

**Files:**
- Modify: `tests/token-boundary.test.js`
- Modify: `tests/hive-regression.test.js`

- [ ] **Step 1: Read the approved design**

Run:

```bash
sed -n '1,240p' docs/superpowers/specs/2026-06-17-tokenizer-query-correctness-design.md
```

Expected: the design limits this work to tokenizer literal hardening, Hive `${...}` preservation, query layout idempotency, and focused tests.

- [ ] **Step 2: Run baseline tests**

Run:

```bash
node tests/token-boundary.test.js
node tests/hive-regression.test.js
```

Expected: both commands pass before edits. If either command fails, stop and report the exact failure before changing code.

- [ ] **Step 3: Add tokenizer assertions to `tests/token-boundary.test.js`**

At the top of `tests/token-boundary.test.js`, after the existing `require` lines, add:

```js
var sqlTokenizer = require('../lib/core/sql-tokenizer');
```

After `assert_structured_contains(...)` helper, add these helper functions:

```js
function token_signature(sql, dialect) {
	return sqlTokenizer.tokenize(sql, { dialect: dialect || 'hive' }).filter(function(token) {
		return token.type != 'whitespace' && token.type != 'newline';
	}).map(function(token) {
		return token.type + ':' + token.value;
	});
}

function assert_token_signature(name, sql, expected, dialect) {
	assert.deepStrictEqual(
		token_signature(sql, dialect),
		expected,
		name
	);
}
```

Then append these tests before the final existing PostgreSQL dollar string assertion:

```js
assert_token_signature(
	'exponent numeric literals stay single tokens',
	'select 6.022e23, 1.5e-3, 1E+3 from t',
	[
		'word:select',
		'number:6.022e23',
		'punctuation:,',
		'number:1.5e-3',
		'punctuation:,',
		'number:1E+3',
		'word:from',
		'word:t'
	]
);

assert_token_signature(
	'hex and leading-dot numeric literals stay single tokens',
	'select 0xFF, 0X1a, .5, .5e2 from t',
	[
		'word:select',
		'number:0xFF',
		'punctuation:,',
		'number:0X1a',
		'punctuation:,',
		'number:.5',
		'punctuation:,',
		'number:.5e2',
		'word:from',
		'word:t'
	]
);

assert_token_signature(
	'adjacent typed quoted literals stay single string literal tokens',
	"select x'1F', X'2A', b'0101', B'1010' from t",
	[
		'word:select',
		"string_literal:x'1F'",
		'punctuation:,',
		"string_literal:X'2A'",
		'punctuation:,',
		"string_literal:b'0101'",
		'punctuation:,',
		"string_literal:B'1010'",
		'word:from',
		'word:t'
	]
);

assert_exact(
	'numeric and typed literals are not split by formatter',
	"select 6.022e23, 1.5e-3, 0xFF, x'1F', .5 from t",
	[
		"SELECT  6.022e23",
		"       ,1.5e-3",
		"       ,0xFF",
		"       ,x'1F'",
		"       ,.5",
		"FROM t"
	].join('\n')
);

assert_idempotent(
	'literal boundary formatting is idempotent',
	"select 6.022e23, 1.5e-3, 0xFF, x'1F', .5 from t"
);
```

Expected: the file now imports `sqlTokenizer`, has token signature helpers, and contains explicit failing guards for the confirmed literal bugs.

- [ ] **Step 4: Run the token boundary test and verify failure**

Run:

```bash
node tests/token-boundary.test.js
```

Expected: FAIL. The failure should show current tokenization splitting exponent numbers, hex numbers, typed quoted literals, or `.5`.

- [ ] **Step 5: Add Hive substitution tests to `tests/hive-regression.test.js`**

Append these tests before the final `console.log('hive regression tests passed');` line:

```js
run_case(
	'hive variable substitutions preserve bytes in table names and predicates',
	"select a from ${db}.tbl where dt=${hivevar:day} and path=${hiveconf:warehouse}",
	[
		'SELECT  a',
		'FROM ${db}.tbl',
		'WHERE dt = ${hivevar:day}',
		'  AND path = ${hiveconf:warehouse}'
	].join('\n')
);

run_case(
	'hive variable substitutions remain stable after formatting',
	format("select a from ${db}.tbl where dt=${hivevar:day}"),
	[
		'SELECT  a',
		'FROM ${db}.tbl',
		'WHERE dt = ${hivevar:day}'
	].join('\n')
);
```

Expected: the tests document that the leading `$` remains attached to `{...}`.

- [ ] **Step 6: Run the Hive regression test and verify failure**

Run:

```bash
node tests/hive-regression.test.js
```

Expected: FAIL. The failure should show `$ {db}`, `$ {hivevar:day}`, or `$ {hiveconf:warehouse}` in the actual output.

- [ ] **Step 7: Commit the failing correctness tests**

Run:

```bash
git add tests/token-boundary.test.js tests/hive-regression.test.js
git commit -m "test: cover tokenizer literal boundaries"
```

Expected: commit succeeds with failing tests intentionally staged. Do not run `npm run test:verify` at this point because the new tests are expected to fail until Task 2.

---

### Task 2: Harden SQL Tokenizer Literal Recognition

**Files:**
- Modify: `lib/core/sql-tokenizer.js`

- [ ] **Step 1: Add helper predicates and readers**

In `lib/core/sql-tokenizer.js`, after `is_digit`, add:

```js
function is_hex_digit(ch) {
	return /[0-9A-Fa-f]/.test(ch || '');
}

function is_typed_string_prefix(ch) {
	return /[XxBb]/.test(ch || '');
}
```

After `read_placeholder`, add:

```js
function read_dollar_placeholder(text, start) {
	if (text[start] != '$' || text[start + 1] != '{') {
		return start;
	}

	var end = text.indexOf('}', start + 2);
	if (end < 0) {
		return start;
	}

	return end + 1;
}

function read_number(text, start) {
	var i = start;

	if (text[i] == '0' && (text[i + 1] == 'x' || text[i + 1] == 'X') && is_hex_digit(text[i + 2])) {
		i += 3;
		while (i < text.length && is_hex_digit(text[i])) {
			i += 1;
		}
		return i;
	}

	if (text[i] == '.') {
		if (!is_digit(text[i + 1])) {
			return start;
		}
		i += 1;
	}

	while (i < text.length && is_digit(text[i])) {
		i += 1;
	}

	if (text[i] == '.') {
		i += 1;
		while (i < text.length && is_digit(text[i])) {
			i += 1;
		}
	}

	if ((text[i] == 'e' || text[i] == 'E')
		&& (is_digit(text[i + 1])
			|| ((text[i + 1] == '+' || text[i + 1] == '-') && is_digit(text[i + 2])))) {
		i += 1;
		if (text[i] == '+' || text[i] == '-') {
			i += 1;
		}
		while (i < text.length && is_digit(text[i])) {
			i += 1;
		}
	}

	return i;
}

function read_typed_string_literal(text, start) {
	if (!is_typed_string_prefix(text[start]) || (text[start + 1] != '\'' && text[start + 1] != '"')) {
		return start;
	}

	return read_string(text, start + 1);
}
```

Expected: helper functions are local to the tokenizer and do not change exports.

- [ ] **Step 2: Recognize typed quoted literals before normal words**

In `tokenize`, before the existing `if (is_word_start(ch))` block, add:

```js
if (is_typed_string_prefix(ch) && (text[i + 1] == '\'' || text[i + 1] == '"')) {
	var typed_string_end = read_typed_string_literal(text, i);
	if (typed_string_end > i) {
		i = typed_string_end;
		push_token(tokens, 'string_literal', text.slice(start, i), start, i);
		continue;
	}
}
```

Expected: adjacent `x'1F'` and `b'0101'` are consumed as one string literal, while `x '1F'` remains a word followed by a string because whitespace separates the tokens.

- [ ] **Step 3: Recognize `${...}` placeholders before bare `{...}` placeholders**

In `tokenize`, after the PostgreSQL dollar-quoted string block and before the existing `if (ch == '{')` block, add:

```js
if (ch == '$') {
	var dollar_placeholder_end = read_dollar_placeholder(text, i);
	if (dollar_placeholder_end > i) {
		i = dollar_placeholder_end;
		push_token(tokens, 'placeholder', text.slice(start, i), start, i);
		continue;
	}
}
```

Expected: PostgreSQL dollar-quoted strings still win because that block runs first when `options.dollarQuotedStrings` is enabled.

- [ ] **Step 4: Replace numeric token reading**

Replace the existing numeric block:

```js
if (is_digit(ch)) {
	i += 1;
	while (i < text.length && /[0-9.]/.test(text[i])) {
		i += 1;
	}
	push_token(tokens, 'number', text.slice(start, i), start, i);
	continue;
}
```

with:

```js
if (is_digit(ch) || (ch == '.' && is_digit(text[i + 1]))) {
	var number_end = read_number(text, i);
	if (number_end > i) {
		i = number_end;
		push_token(tokens, 'number', text.slice(start, i), start, i);
		continue;
	}
}
```

Expected: `.` remains punctuation when it is not followed by a digit, so dotted identifiers such as `db.table` keep existing behavior.

- [ ] **Step 5: Run targeted tokenizer tests**

Run:

```bash
node tests/token-boundary.test.js
node tests/hive-regression.test.js
```

Expected: both commands pass. If the token-boundary expected output differs only in alignment spaces, inspect the actual output and update the expected string only if the SQL bytes for literals are preserved exactly.

- [ ] **Step 6: Run boundary-adjacent tests**

Run:

```bash
node tests/placeholder-collision.test.js
node tests/tokenizer-profile.test.js
node tests/dialect-boundary.test.js
```

Expected: all commands pass. `tokenizer-profile.test.js` may print profile counts; count changes are acceptable if the test passes.

- [ ] **Step 7: Commit tokenizer hardening**

Run:

```bash
git add lib/core/sql-tokenizer.js
git commit -m "fix: preserve sql literal token boundaries"
```

Expected: commit succeeds.

---

### Task 3: Add Failing Query Layout Idempotency Tests

**Files:**
- Modify: `tests/pipeline-idempotency.test.js`

- [ ] **Step 1: Run baseline idempotency test**

Run:

```bash
node tests/pipeline-idempotency.test.js
```

Expected: PASS before adding the new query layout tests.

- [ ] **Step 2: Add a formatter helper that uses spaces**

After `format_with_indent`, add:

```js
function format_space(sql) {
	return format_with_indent(sql, 'space');
}
```

Expected: this helper keeps new expected strings readable with four-space indents.

- [ ] **Step 3: Add compact CTE and compact `IN` subquery tests**

Append these tests after the existing protected token idempotency assertion and before `whitespaceContractInput`:

```js
function assert_format_once_and_twice(name, input, expected) {
	var once = format_space(input);
	var twice = format_space(once);

	assert.strictEqual(
		once,
		expected.trim(),
		name + ' first pass output\n--- actual ---\n' + once + '\n--- expected ---\n' + expected.trim()
	);
	assert.strictEqual(
		twice,
		once,
		name + ' must be idempotent\n--- once ---\n' + once + '\n--- twice ---\n' + twice
	);
}

assert_format_once_and_twice(
	'compact CTE subquery expands to stable query block',
	'with c as (select a from t) select * from c',
	[
		'WITH c AS',
		'(',
		'    SELECT  a',
		'    FROM t',
		')',
		'SELECT  *',
		'FROM c'
	].join('\n')
);

assert_format_once_and_twice(
	'compact IN subquery expands to stable query block',
	'select * from t where x in (select id from u)',
	[
		'SELECT  *',
		'FROM t',
		'WHERE x IN (',
		'    SELECT  id',
		'    FROM u',
		')'
	].join('\n')
);

assert_format_once_and_twice(
	'compact EXISTS subquery expands to stable query block',
	'select * from t where exists (select 1 from u where u.id=t.id)',
	[
		'SELECT  *',
		'FROM t',
		'WHERE EXISTS (',
		'    SELECT  1',
		'    FROM u',
		'    WHERE u.id = t.id',
		')'
	].join('\n')
);
```

Expected: the tests choose expanded subquery blocks as the stable target, matching existing multi-line `IN` and `EXISTS` subquery expectations in this same test file.

- [ ] **Step 4: Run idempotency test and verify failure**

Run:

```bash
node tests/pipeline-idempotency.test.js
```

Expected: FAIL. The failure should show the first pass keeping inner `SELECT ... FROM ...` inline or using asymmetric `( SELECT ... )` spacing.

- [ ] **Step 5: Commit failing query layout tests**

Run:

```bash
git add tests/pipeline-idempotency.test.js
git commit -m "test: cover compact subquery idempotency"
```

Expected: commit succeeds with failing tests intentionally staged. Do not run `npm run test:verify` at this point because the new tests are expected to fail until Task 4.

---

### Task 4: Expand Real Parenthesized Query Scopes on First Pass

**Files:**
- Modify: `lib/core/sql-layout-formatter.js`

- [ ] **Step 1: Replace inline query exemption helper**

In `lib/core/sql-layout-formatter.js`, replace:

```js
function is_inline_subquery_exempt(document, openToken) {
	var previous = sqlFormatNavigation.previous_code_token(document, openToken);
	return is_word(previous, 'IN') || is_word(previous, 'EXISTS');
}
```

with:

```js
function should_expand_query_scope(document, scope, openToken) {
	if (!scope || scope.kind != 'query' || typeof scope.openTokenIndex != 'number') {
		return false;
	}
	if (!openToken) {
		return false;
	}
	if (scope.id == 0) {
		return false;
	}
	return true;
}
```

Expected: the new helper says all non-root parenthesized query scopes should be expanded. It keeps the decision structural and does not special-case `IN` or `EXISTS`.

- [ ] **Step 2: Use the new helper in scope layout mutation application**

In `apply_scope_layout_mutations`, replace:

```js
var token = sqlFormatNavigation.token_by_index(document, scope.openTokenIndex);
if (!token || is_inline_subquery_exempt(document, token)) {
	continue;
}
```

with:

```js
var token = sqlFormatNavigation.token_by_index(document, scope.openTokenIndex);
if (!should_expand_query_scope(document, scope, token)) {
	continue;
}
```

Expected: compact `IN (select ...)`, `EXISTS (select ...)`, `FROM (select ...)`, and `WITH ... AS (select ...)` all receive the same first-pass line break mutations when their scope is a real query.

- [ ] **Step 3: Run the new idempotency tests**

Run:

```bash
node tests/pipeline-idempotency.test.js
```

Expected: PASS. If only close-paren indentation differs, inspect `lib/core/sql-render-indent.js` behavior before changing expected strings; the existing expanded `IN` tests in `pipeline-idempotency.test.js` are the source of truth for the desired indentation.

- [ ] **Step 4: Run query-layout adjacent tests**

Run:

```bash
node tests/format-scope-model.test.js
node tests/format-navigation.test.js
node tests/format-invariants.test.js
node tests/structured-pipeline-regression.test.js
node tests/structured-differential.test.js
node tests/hive-regression.test.js
```

Expected: all commands pass. If `structured-differential.test.js` fails because the approved stable query layout changed a golden output, inspect the diff and update only the affected expected output if it is a compact parenthesized query becoming expanded.

- [ ] **Step 5: Commit query layout fix**

Run:

```bash
git add lib/core/sql-layout-formatter.js tests/pipeline-idempotency.test.js
git commit -m "fix: stabilize compact subquery layout"
```

Expected: commit succeeds.

---

### Task 5: Full Verification and Review

**Files:**
- Review all files changed by Tasks 1-4.

- [ ] **Step 1: Run targeted correctness suite**

Run:

```bash
node tests/token-boundary.test.js
node tests/hive-regression.test.js
node tests/pipeline-idempotency.test.js
```

Expected: all commands pass.

- [ ] **Step 2: Run boundary and architecture suite**

Run:

```bash
node tests/placeholder-collision.test.js
node tests/dialect-boundary.test.js
node tests/module-boundary.test.js
node tests/canonical-core-boundary.test.js
node tests/layout-marker-leakage.test.js
```

Expected: all commands pass. `module-boundary.test.js` should confirm root `lib/*.js` shims remain single-line compatibility exports.

- [ ] **Step 3: Run full verification**

Run:

```bash
npm run test:verify
git diff --check
```

Expected: `npm run test:verify` passes and `git diff --check` prints no whitespace errors.

- [ ] **Step 4: Inspect final diff**

Run:

```bash
git diff --stat HEAD~4..HEAD
git diff HEAD~4..HEAD -- lib/core/sql-tokenizer.js lib/core/sql-layout-formatter.js tests/token-boundary.test.js tests/hive-regression.test.js tests/pipeline-idempotency.test.js
```

Expected: the diff is limited to tokenizer logic, query scope layout, and focused tests. There should be no changes to `lib/adapters/`, `lib/experimental/ddl/`, root `lib/*.js` shims, README, package metadata, release workflows, or `.vsix` files.

- [ ] **Step 5: Document any changed formatter output in the final handoff**

Record these facts in the final implementation handoff:

```text
Tokenizer literals preserved:
- scientific notation
- signed exponents
- hex numbers
- typed quoted literals
- leading-dot decimals
- Hive ${...} substitutions

Query layout behavior:
- compact CTE subqueries expand on the first pass
- compact IN/EXISTS subqueries expand on the first pass
- targeted idempotency checks pass
```

Expected: the handoff states the exact validation commands and the intended compact subquery behavior change.
