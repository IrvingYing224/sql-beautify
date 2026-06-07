# Structured Clause Safety Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Centralize token-aware clause and low-confidence syntax boundary checks so clause splitting, syntax-risk diagnostics, and structured clause mutations classify production SQL constructs consistently.

**Architecture:** Add `lib/core/sql-clause-context.js` as an internal core helper for raw tokenizer context, `QUALIFY`, `PIVOT` / `UNPIVOT`, `MERGE`, and `MATCH_RECOGNIZE(...)` recognition. Migrate `sql-clause-splitter.js`, `sql-syntax-risk-detector.js`, and `sql-clause-formatter.js` to use that shared module while preserving formatter output and unsupported-syntax policy behavior.

**Tech Stack:** CommonJS JavaScript, Node.js `assert` tests, existing SQL tokenizer and formatter core under `lib/core/`, existing regression suite via `npm run test:verify`.

---

## File Structure

- Create: `lib/core/sql-clause-context.js`
  - Shared raw-token navigation, query-clause context, and high-risk construct recognition.
- Create: `tests/clause-context.test.js`
  - Focused unit tests for the new shared context helper.
- Modify: `lib/core/sql-clause-splitter.js`
  - Use the shared context helper for token navigation, paren matching, `QUALIFY`, and opaque `MATCH_RECOGNIZE(...)` handling.
- Modify: `lib/core/sql-syntax-risk-detector.js`
  - Use the shared context helper for `QUALIFY`, `PIVOT` / `UNPIVOT`, `MERGE`, and `MATCH_RECOGNIZE(...)` detection.
- Modify: `lib/core/sql-clause-formatter.js`
  - Use the shared query context state and `QUALIFY` clause guard while keeping document-scope filtering local.
- Modify: `tests/unsupported-safety.test.js`
  - Add production-shaped behavior guards for spaced `MATCH RECOGNIZE`, nested `QUALIFY`, mixed `pivot` function / real `PIVOT`, and `MERGE` identifier vs statement.
- Modify: `tests/module-boundary.test.js`
  - Enforce the new module export surface and prevent migrated duplicate helper implementations from returning.
- Modify: `package.json`
  - Add `test:clause-context` and include it in `test:verify`.

Do not modify `lib/adapters/`, `lib/experimental/ddl/`, root `lib/*.js` shims, `README.md`, or publishing workflow files.

---

### Task 1: Baseline And Focused Context Red Tests

**Files:**
- Create: `tests/clause-context.test.js`
- Modify: `package.json`

- [ ] **Step 1: Read the approved spec**

Run:

```bash
sed -n '1,460p' docs/superpowers/specs/2026-06-08-structured-clause-safety-context-design.md
```

Expected: the spec requires shared clause/risk context logic, migration of `sql-clause-splitter.js`, `sql-syntax-risk-detector.js`, and `sql-clause-formatter.js`, unchanged formatter behavior, module-boundary guards, and final `npm run test:verify`.

- [ ] **Step 2: Run baseline targeted checks**

Run:

```bash
node tests/unsupported-safety.test.js
node tests/dialect-boundary.test.js
node tests/module-boundary.test.js
node tests/clause-registry.test.js
node tests/structured-differential.test.js
node tests/pipeline-idempotency.test.js
```

Expected: all commands pass before edits. If any command fails on the untouched baseline, stop and report the failure before changing code.

- [ ] **Step 3: Add the focused clause-context test**

Create `tests/clause-context.test.js` with this complete file:

```js
var assert = require('assert');
var sqlTokenizer = require('../lib/core/sql-tokenizer');
var clauseContext = require('../lib/core/sql-clause-context');

function tokens(sql) {
	return sqlTokenizer.tokenize(sql, { dialect: 'generic' });
}

function code_tokens(sql) {
	return tokens(sql).filter(function(token) {
		return token.type != 'whitespace'
			&& token.type != 'newline'
			&& token.type != 'line_comment'
			&& token.type != 'block_comment';
	});
}

function word_index(tokenList, value, occurrence) {
	var seen = 0;
	for (var i = 0; i < tokenList.length; i++) {
		if (tokenList[i].type == 'word' && tokenList[i].value.toUpperCase() == value) {
			if (seen == (occurrence || 0)) {
				return i;
			}
			seen += 1;
		}
	}
	return -1;
}

function context_after_clauses(clauseNames) {
	var context = clauseContext.create_query_context();
	for (var i = 0; i < clauseNames.length; i++) {
		clauseContext.update_query_clause_context(context, clauseNames[i]);
	}
	return context;
}

var qualifyClauseTokens = code_tokens('select * from t qualify row_number() over(partition by a order by b)=1');
var qualifyClauseIndex = word_index(qualifyClauseTokens, 'QUALIFY');
assert.strictEqual(
	clauseContext.is_real_qualify_clause(
		qualifyClauseTokens,
		qualifyClauseIndex,
		context_after_clauses(['SELECT', 'FROM'])
	),
	true,
	'QUALIFY after SELECT ... FROM with expression must be treated as a real clause'
);

var qualifyAliasTokens = code_tokens('select qualify as c from t');
var qualifyAliasIndex = word_index(qualifyAliasTokens, 'QUALIFY');
assert.strictEqual(
	clauseContext.is_real_qualify_clause(
		qualifyAliasTokens,
		qualifyAliasIndex,
		context_after_clauses(['SELECT'])
	),
	false,
	'QUALIFY-shaped SELECT-list identifier must not be treated as a real clause'
);

var qualifyOperandTokens = code_tokens('select * from t where qualify = 1');
var qualifyOperandIndex = word_index(qualifyOperandTokens, 'QUALIFY');
assert.strictEqual(
	clauseContext.is_real_qualify_clause(
		qualifyOperandTokens,
		qualifyOperandIndex,
		context_after_clauses(['SELECT', 'FROM', 'WHERE'])
	),
	false,
	'QUALIFY-shaped WHERE operand must not be treated as a real clause'
);

var qualifyFunctionTokens = code_tokens('select * from t where x = qualify(y)');
var qualifyFunctionIndex = word_index(qualifyFunctionTokens, 'QUALIFY');
assert.strictEqual(
	clauseContext.is_real_qualify_clause(
		qualifyFunctionTokens,
		qualifyFunctionIndex,
		context_after_clauses(['SELECT', 'FROM', 'WHERE'])
	),
	false,
	'QUALIFY-shaped function name must not be treated as a real clause'
);

var pivotConstructTokens = code_tokens('select * from t pivot (sum(x) for y in (1))');
var pivotConstructIndex = word_index(pivotConstructTokens, 'PIVOT');
assert.strictEqual(
	clauseContext.is_pivot_construct(
		pivotConstructTokens,
		pivotConstructIndex,
		context_after_clauses(['SELECT', 'FROM'])
	),
	true,
	'PIVOT after a table reference and before parens must be treated as a table construct'
);

var pivotFunctionTokens = code_tokens('select * from t where x = pivot(y)');
var pivotFunctionIndex = word_index(pivotFunctionTokens, 'PIVOT');
assert.strictEqual(
	clauseContext.is_pivot_construct(
		pivotFunctionTokens,
		pivotFunctionIndex,
		context_after_clauses(['SELECT', 'FROM', 'WHERE'])
	),
	false,
	'PIVOT-shaped WHERE function call must not be treated as a table construct'
);

var unpivotConstructTokens = code_tokens('select * from t unpivot (v for k in (c1,c2))');
var unpivotConstructIndex = word_index(unpivotConstructTokens, 'UNPIVOT');
assert.strictEqual(
	clauseContext.is_pivot_construct(
		unpivotConstructTokens,
		unpivotConstructIndex,
		context_after_clauses(['SELECT', 'FROM'])
	),
	true,
	'UNPIVOT after a table reference and before parens must follow table construct rules'
);

var mergeStatementTokens = code_tokens('merge into target t using source s on t.id=s.id when matched then update set v=s.v');
var mergeStatementIndex = word_index(mergeStatementTokens, 'MERGE');
assert.strictEqual(
	clauseContext.is_merge_statement(mergeStatementTokens, mergeStatementIndex, 0),
	true,
	'MERGE INTO at top-level statement start must be treated as a merge statement'
);

var mergeAliasTokens = code_tokens('select merge as c from t');
var mergeAliasIndex = word_index(mergeAliasTokens, 'MERGE');
assert.strictEqual(
	clauseContext.is_merge_statement(mergeAliasTokens, mergeAliasIndex, 0),
	false,
	'MERGE-shaped SELECT item must not be treated as a merge statement'
);

var compactMatchSql = 'select * from t match_recognize (partition by a order by b measures match_number() as mn)';
var compactMatchTokens = tokens(compactMatchSql);
var compactMatchIndex = word_index(compactMatchTokens, 'MATCH_RECOGNIZE');
var compactRange = clauseContext.match_recognize_range(compactMatchSql, compactMatchTokens, compactMatchIndex);
assert.strictEqual(
	compactRange.text,
	'match_recognize (partition by a order by b measures match_number() as mn)',
	'MATCH_RECOGNIZE compact token form must return the full opaque range'
);

var spacedMatchSql = 'select * from t match recognize (partition by a order by b measures match_number() as mn)';
var spacedMatchTokens = tokens(spacedMatchSql);
var spacedMatchIndex = word_index(spacedMatchTokens, 'MATCH');
var spacedRange = clauseContext.match_recognize_range(spacedMatchSql, spacedMatchTokens, spacedMatchIndex);
assert.strictEqual(
	spacedRange.text,
	'match recognize (partition by a order by b measures match_number() as mn)',
	'MATCH RECOGNIZE spaced token form must return the full opaque range'
);

var noisyTokens = tokens('select a -- keep\nfrom t');
var selectIndex = word_index(noisyTokens, 'SELECT');
var fromIndex = word_index(noisyTokens, 'FROM');
assert.strictEqual(
	clauseContext.next_code_token(noisyTokens, selectIndex).value,
	'a',
	'next_code_token must skip whitespace and comments'
);
assert.strictEqual(
	clauseContext.previous_code_token(noisyTokens, fromIndex).value,
	'a',
	'previous_code_token must skip whitespace and comments'
);

console.log('clause context tests passed');
```

- [ ] **Step 4: Run the new test to verify it fails**

Run:

```bash
node tests/clause-context.test.js
```

Expected: FAIL with `Cannot find module '../lib/core/sql-clause-context'`.

- [ ] **Step 5: Add the npm script and verify it fails through the script**

In `package.json`, add a new script entry immediately after `test:clauses`:

```json
"test:clause-context": "node tests/clause-context.test.js",
```

Then add `&& node tests/clause-context.test.js` in `test:verify` immediately after `node tests/clause-registry.test.js`.

Run:

```bash
npm run test:clause-context
```

Expected: FAIL with `Cannot find module '../lib/core/sql-clause-context'`.

- [ ] **Step 6: Leave the red test uncommitted for Task 2**

Run:

```bash
git status --short
```

Expected: `tests/clause-context.test.js` and `package.json` appear as tracked changes. Do not commit this failing intermediate state; Task 2 will commit the test together with the implementation so the branch remains bisectable.

---

### Task 2: Shared Clause Context Module

**Files:**
- Create: `lib/core/sql-clause-context.js`
- Test: `tests/clause-context.test.js`

- [ ] **Step 1: Create the shared context module**

Create `lib/core/sql-clause-context.js` with this complete file:

```js
function is_ignorable(token) {
	return token && (
		token.type == 'whitespace'
		|| token.type == 'newline'
		|| token.type == 'line_comment'
		|| token.type == 'block_comment'
	);
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

function next_code_index(tokens, index) {
	for (var i = index + 1; i < (tokens || []).length; i++) {
		if (!is_ignorable(tokens[i])) {
			return i;
		}
	}
	return -1;
}

function next_code_token(tokens, index) {
	var found = next_code_index(tokens, index);
	return found >= 0 ? tokens[found] : null;
}

function previous_code_token(tokens, index) {
	for (var i = index - 1; i >= 0; i--) {
		if (!is_ignorable(tokens[i])) {
			return tokens[i];
		}
	}
	return null;
}

function find_matching_paren(tokens, openIndex) {
	var depth = 0;

	for (var i = openIndex; i < (tokens || []).length; i++) {
		if (tokens[i].type == 'punctuation' && tokens[i].value == '(') {
			depth += 1;
		} else if (tokens[i].type == 'punctuation' && tokens[i].value == ')') {
			depth -= 1;
			if (depth == 0) {
				return i;
			}
		}
	}

	return -1;
}

function create_query_context() {
	return {
		inSelect: false,
		seenFrom: false,
		lastClause: ''
	};
}

function clause_name(clauseOrName) {
	if (!clauseOrName) {
		return '';
	}
	if (typeof clauseOrName == 'string') {
		return clauseOrName.toUpperCase();
	}
	return String(clauseOrName.name || '').toUpperCase();
}

function update_query_clause_context(context, clauseOrName) {
	var name = clause_name(clauseOrName);

	if (!context) {
		return;
	}

	if (name == 'SELECT') {
		context.inSelect = true;
		context.seenFrom = false;
		context.lastClause = 'SELECT';
		return;
	}

	if (!context.inSelect) {
		return;
	}

	if (/^(FROM|JOIN|LEFT JOIN|LEFT OUTER JOIN|RIGHT JOIN|RIGHT OUTER JOIN|FULL JOIN|FULL OUTER JOIN|INNER JOIN|CROSS JOIN|LEFT SEMI JOIN|LEFT ANTI JOIN)$/.test(name)) {
		context.seenFrom = true;
		context.lastClause = name == 'FROM' ? 'FROM' : 'JOIN';
		return;
	}

	if (/^(WHERE|GROUP BY|ORDER BY|HAVING|QUALIFY|LIMIT|UNION|INTERSECT|EXCEPT|ON)$/.test(name)) {
		context.lastClause = name.split(' ')[0];
	}
}

function is_clause_boundary_word(value) {
	return /^(SELECT|FROM|JOIN|WHERE|GROUP|ORDER|HAVING|QUALIFY|LIMIT|UNION|INTERSECT|EXCEPT|ON)$/.test(String(value || '').toUpperCase());
}

function can_precede_qualify_clause(previous) {
	var value;

	if (!previous) {
		return false;
	}

	if (previous.type == 'operator') {
		return false;
	}

	if (previous.type == 'punctuation') {
		return previous.value == ')';
	}

	if (previous.type != 'word') {
		return true;
	}

	value = previous.value.toUpperCase();
	return !/^(AS|SELECT|FROM|JOIN|WHERE|ON|HAVING|QUALIFY|AND|OR|NOT|IN|EXISTS|WHEN|THEN|ELSE|BY)$/.test(value);
}

function can_follow_qualify_clause(next) {
	var value;

	if (!next) {
		return false;
	}

	if (next.type == 'operator') {
		return false;
	}

	if (next.type == 'punctuation' && /^(,|;|\))$/.test(next.value)) {
		return false;
	}

	if (next.type == 'word') {
		value = next.value.toUpperCase();
		if (value == 'AS' || is_clause_boundary_word(value)) {
			return false;
		}
	}

	return true;
}

function is_real_qualify_clause(tokens, index, context) {
	var previous;
	var next;

	if (!is_word((tokens || [])[index], 'QUALIFY')) {
		return false;
	}

	if (!context || !context.inSelect || !context.seenFrom) {
		return false;
	}

	previous = previous_code_token(tokens, index);
	next = next_code_token(tokens, index);

	return can_precede_qualify_clause(previous)
		&& can_follow_qualify_clause(next);
}

function is_statement_boundary(previous) {
	return !previous || (previous.type == 'punctuation' && previous.value == ';');
}

function is_merge_statement(tokens, index, depth) {
	var previous = previous_code_token(tokens, index);
	var next = next_code_token(tokens, index);

	return depth == 0
		&& is_word((tokens || [])[index], 'MERGE')
		&& is_statement_boundary(previous)
		&& is_word(next, 'INTO');
}

function is_pivot_construct(tokens, index, context) {
	var token = (tokens || [])[index];
	var previous = previous_code_token(tokens, index);
	var next = next_code_token(tokens, index);

	if (!is_word(token) || !/^(PIVOT|UNPIVOT)$/.test(token.value.toUpperCase())) {
		return false;
	}

	if (!context || !context.inSelect || !context.seenFrom) {
		return false;
	}

	if (!/^(FROM|JOIN)$/.test(context.lastClause || '')) {
		return false;
	}

	if (!previous || (previous.type == 'word' && /^(AS|FROM|JOIN)$/i.exec(previous.value))) {
		return false;
	}

	if (previous.type == 'operator') {
		return false;
	}

	return next && next.type == 'punctuation' && next.value == '(';
}

function snippet_range(source, token, index) {
	var start = token ? token.start : 0;
	var end = token ? token.end : 0;
	return {
		startIndex: typeof index == 'number' ? index : -1,
		endIndex: typeof index == 'number' ? index : -1,
		start: start,
		end: end,
		text: String(source || '').slice(Math.max(0, start - 40), Math.min(String(source || '').length, end + 120)),
		complete: false
	};
}

function match_recognize_paren_anchor_index(tokens, index, value) {
	if (value == 'MATCH_RECOGNIZE') {
		return index;
	}
	return next_code_index(tokens, index);
}

function match_recognize_range(source, tokens, index) {
	var token = (tokens || [])[index];
	var value = token && token.type == 'word' ? token.value.toUpperCase() : '';
	var recognizeIndex;
	var anchorIndex;
	var openIndex;
	var closeIndex;

	if (value == 'MATCH') {
		recognizeIndex = next_code_index(tokens, index);
		if (recognizeIndex < 0 || !is_word(tokens[recognizeIndex], 'RECOGNIZE')) {
			return null;
		}
	} else if (value != 'MATCH_RECOGNIZE') {
		return null;
	}

	anchorIndex = match_recognize_paren_anchor_index(tokens, index, value);
	openIndex = next_code_index(tokens, anchorIndex);
	if (openIndex < 0 || !tokens[openIndex] || tokens[openIndex].type != 'punctuation' || tokens[openIndex].value != '(') {
		return null;
	}

	closeIndex = find_matching_paren(tokens, openIndex);
	if (closeIndex < 0) {
		return snippet_range(source, token, index);
	}

	return {
		startIndex: index,
		endIndex: closeIndex,
		start: tokens[index].start,
		end: tokens[closeIndex].end,
		text: String(source || '').slice(tokens[index].start, tokens[closeIndex].end),
		complete: true
	};
}

exports.previous_code_token = previous_code_token;
exports.next_code_token = next_code_token;
exports.next_code_index = next_code_index;
exports.find_matching_paren = find_matching_paren;
exports.create_query_context = create_query_context;
exports.update_query_clause_context = update_query_clause_context;
exports.can_precede_qualify_clause = can_precede_qualify_clause;
exports.can_follow_qualify_clause = can_follow_qualify_clause;
exports.is_real_qualify_clause = is_real_qualify_clause;
exports.is_merge_statement = is_merge_statement;
exports.is_pivot_construct = is_pivot_construct;
exports.match_recognize_range = match_recognize_range;
```

- [ ] **Step 2: Run the focused context test**

Run:

```bash
node tests/clause-context.test.js
```

Expected: PASS and prints `clause context tests passed`.

- [ ] **Step 3: Run baseline behavior tests before migration**

Run:

```bash
node tests/unsupported-safety.test.js
node tests/dialect-boundary.test.js
node tests/module-boundary.test.js
```

Expected: `unsupported-safety` and `dialect-boundary` pass. `module-boundary` may still pass because it does not yet know about `sql-clause-context.js`.

- [ ] **Step 4: Commit the shared module**

Run:

```bash
git add lib/core/sql-clause-context.js tests/clause-context.test.js package.json
git commit -m "refactor: add structured clause context helper"
```

Expected: commit succeeds.

---

### Task 3: Migrate Syntax Risk Detector And Behavior Fixtures

**Files:**
- Modify: `lib/core/sql-syntax-risk-detector.js`
- Modify: `tests/unsupported-safety.test.js`

- [ ] **Step 1: Add production-shaped unsupported-safety fixtures**

In `tests/unsupported-safety.test.js`, add this block immediately before the existing `var extractedAdd = vkbeautify.extractddl('select a + b from t');` block:

```js
assert.throws(
    function() {
        vkbeautify.sql(
            'select * from (select a, row_number() over(partition by k order by ts) as rn from t qualify rn=1) q',
            true,
            false,
            true,
            150,
            80,
            {
                dialect: 'postgres',
                unsupportedSyntaxPolicy: 'bail_out'
            }
        );
    },
    /Unsupported SQL fragment detected/,
    'bail_out must reject real QUALIFY inside nested subqueries'
);

assert.doesNotThrow(
    function() {
        vkbeautify.sql(
            'with qualify_alias as (select qualify as c from t) select * from qualify_alias where c=1',
            true,
            false,
            true,
            150,
            80,
            {
                dialect: 'postgres',
                unsupportedSyntaxPolicy: 'bail_out'
            }
        );
    },
    'bail_out must allow CTEs and SELECT-list aliases named qualify'
);

assert.doesNotThrow(
    function() {
        vkbeautify.sql(
            'select merge as c from t where merge = 1',
            true,
            false,
            true,
            150,
            80,
            {
                dialect: 'generic',
                unsupportedSyntaxPolicy: 'bail_out'
            }
        );
    },
    'bail_out must allow MERGE-shaped identifiers outside statement-start context'
);

assert.throws(
    function() {
        vkbeautify.sql(
            'merge into target t using source s on t.id=s.id when matched then update set v=s.v',
            true,
            false,
            true,
            150,
            80,
            {
                dialect: 'generic',
                unsupportedSyntaxPolicy: 'bail_out'
            }
        );
    },
    /Unsupported SQL fragment detected/,
    'bail_out must reject real MERGE INTO statements'
);

assert.doesNotThrow(
    function() {
        vkbeautify.sql(
            'select * from t where x = pivot(y)',
            true,
            false,
            true,
            150,
            80,
            {
                dialect: 'generic',
                unsupportedSyntaxPolicy: 'bail_out'
            }
        );
    },
    'bail_out must allow PIVOT-shaped expression functions'
);

assert.throws(
    function() {
        vkbeautify.sql(
            'select * from t pivot (sum(x) for y in (1)) where x = pivot(y)',
            true,
            false,
            true,
            150,
            80,
            {
                dialect: 'generic',
                unsupportedSyntaxPolicy: 'bail_out'
            }
        );
    },
    /Unsupported SQL fragment detected/,
    'bail_out must reject real PIVOT table constructs even when PIVOT-shaped functions also exist'
);
```

- [ ] **Step 2: Run unsupported-safety to capture current behavior**

Run:

```bash
node tests/unsupported-safety.test.js
```

Expected: current behavior may already pass these detector-focused guards. If it fails, confirm the failure is one of the new detector-focused assertions before continuing.

- [ ] **Step 3: Replace syntax-risk detector internals with shared context**

Replace the entire contents of `lib/core/sql-syntax-risk-detector.js` with this complete file:

```js
var sqlTokenizer = require('./sql-tokenizer');
var sqlClauseContext = require('./sql-clause-context');

function is_ignorable(token) {
	return token && (
		token.type == 'whitespace'
		|| token.type == 'newline'
		|| token.type == 'line_comment'
		|| token.type == 'block_comment'
	);
}

function snippet_for_range(source, start_index, end_index) {
	var start = Math.max(0, start_index - 40);
	var end = Math.min(source.length, end_index + 120);
	return source.slice(start, end);
}

function note_segment(segments, kind, text) {
	segments.push({
		kind: kind,
		text: text
	});
}

function build_syntax_lookup(items) {
	var lookup = {};

	for (var i = 0; i < items.length; i++) {
		lookup[String(items[i].name || '').toUpperCase()] = items[i].kind;
	}

	return lookup;
}

function get_depth_state(states, depth) {
	if (!states[depth]) {
		states[depth] = sqlClauseContext.create_query_context();
	}

	return states[depth];
}

function reset_depth_state(states, depth) {
	states[depth] = null;
}

function update_select_context(state, value) {
	if (value == 'GROUP') {
		sqlClauseContext.update_query_clause_context(state, 'GROUP BY');
		return;
	}

	if (value == 'ORDER') {
		sqlClauseContext.update_query_clause_context(state, 'ORDER BY');
		return;
	}

	sqlClauseContext.update_query_clause_context(state, value);
}

function detect(text, dialectCapabilities) {
	var source = String(text || '');
	var capabilities = dialectCapabilities || {};
	var tokens = sqlTokenizer.tokenize(source, capabilities);
	var syntaxLookup = build_syntax_lookup(capabilities.knownLowConfidenceSyntax || []);
	var segments = [];
	var states = [];
	var depth = 0;
	var state;
	var value;
	var kind;
	var matchRange;

	for (var i = 0; i < tokens.length; i++) {
		if (tokens[i].type == 'punctuation') {
			if (tokens[i].value == '(') {
				depth += 1;
				reset_depth_state(states, depth);
			} else if (tokens[i].value == ')') {
				reset_depth_state(states, depth);
				depth = Math.max(0, depth - 1);
			} else if (tokens[i].value == ';' && depth == 0) {
				reset_depth_state(states, 0);
			}
			continue;
		}

		if (is_ignorable(tokens[i]) || tokens[i].type != 'word') {
			continue;
		}

		state = get_depth_state(states, depth);
		value = tokens[i].value.toUpperCase();

		if (syntaxLookup.MATCH_RECOGNIZE || syntaxLookup.MATCH) {
			matchRange = sqlClauseContext.match_recognize_range(source, tokens, i);
			if (matchRange) {
				note_segment(
					segments,
					syntaxLookup.MATCH_RECOGNIZE || syntaxLookup.MATCH,
					matchRange.text || snippet_for_range(source, tokens[i].start, tokens[i].end)
				);
				update_select_context(state, value);
				i = typeof matchRange.endIndex == 'number' && matchRange.endIndex > i
					? matchRange.endIndex
					: i;
				continue;
			}
		}

		kind = syntaxLookup[value];
		if (kind == 'dialect_unsupported_clause'
			&& value == 'QUALIFY'
			&& sqlClauseContext.is_real_qualify_clause(tokens, i, state)) {
			note_segment(segments, kind, snippet_for_range(source, tokens[i].start, tokens[i].end));
		} else if (kind == 'known_unmodeled_construct'
			&& value == 'MERGE'
			&& sqlClauseContext.is_merge_statement(tokens, i, depth)) {
			note_segment(segments, kind, snippet_for_range(source, tokens[i].start, tokens[i].end));
		} else if (kind == 'known_unmodeled_construct'
			&& /^(PIVOT|UNPIVOT)$/.test(value)
			&& sqlClauseContext.is_pivot_construct(tokens, i, state)) {
			note_segment(segments, kind, snippet_for_range(source, tokens[i].start, tokens[i].end));
		}

		update_select_context(state, value);
	}

	return segments;
}

exports.detect = detect;
```

- [ ] **Step 4: Run detector-focused tests**

Run:

```bash
node tests/clause-context.test.js
node tests/unsupported-safety.test.js
node tests/dialect-boundary.test.js
node tests/formatter-api.test.js
```

Expected: all commands pass.

- [ ] **Step 5: Commit detector migration**

Run:

```bash
git add lib/core/sql-syntax-risk-detector.js tests/unsupported-safety.test.js
git commit -m "refactor: use clause context for syntax risk detection"
```

Expected: commit succeeds.

---

### Task 4: Migrate Clause Splitter Opaque And Clause Guards

**Files:**
- Modify: `lib/core/sql-clause-splitter.js`
- Modify: `tests/unsupported-safety.test.js`

- [ ] **Step 1: Add the spaced MATCH RECOGNIZE splitter fixture**

In `tests/unsupported-safety.test.js`, add this block immediately before the existing `var extractedAdd = vkbeautify.extractddl('select a + b from t');` block. If Task 3 inserted detector fixtures there, place this block immediately before those Task 3 fixtures:

```js
var spacedMatchRecognize = format(
    'select * from t match recognize (partition by a order by b measures match_number() as mn one row per match pattern (A B+) define A as x=1, B as y=2)',
    'generic'
);

var originalSpacedMatchRecognizeClause = 'match recognize (partition by a order by b measures match_number() as mn one row per match pattern (A B+) define A as x=1, B as y=2)';

assert_contains(
    'unsupported MATCH RECOGNIZE spaced clause must be preserved exactly before normal formatting resumes',
    spacedMatchRecognize,
    originalSpacedMatchRecognizeClause
);
```

- [ ] **Step 2: Run unsupported-safety to verify the splitter fixture fails or is already guarded**

Run:

```bash
node tests/unsupported-safety.test.js
```

Expected: FAIL if the spaced `MATCH RECOGNIZE` form is not yet preserved by the splitter. If it already passes, continue; the fixture still guards the splitter migration.

- [ ] **Step 3: Add the shared import**

In `lib/core/sql-clause-splitter.js`, add this require after `var sqlOperatorRegistry = require('./sql-operator-registry');`:

```js
var sqlClauseContext = require('./sql-clause-context');
```

- [ ] **Step 4: Replace local token navigation and paren helpers with wrappers**

In `lib/core/sql-clause-splitter.js`, replace the bodies of `previous_code_token`, `next_code_token`, and `find_matching_paren` with these wrappers:

```js
function previous_code_token(tokens, index) {
	return sqlClauseContext.previous_code_token(tokens, index);
}

function next_code_token(tokens, index) {
	return sqlClauseContext.next_code_token(tokens, index);
}
```

And:

```js
function find_matching_paren(tokens, open_index) {
	return sqlClauseContext.find_matching_paren(tokens, open_index);
}
```

Keep these wrapper names temporarily in this task because other local code still calls them. Module-boundary cleanup removes them in Task 6.

- [ ] **Step 5: Replace query context creation and updates**

Replace `get_query_clause_context` with:

```js
function get_query_clause_context(contexts, depth) {
	if (!contexts[depth]) {
		contexts[depth] = sqlClauseContext.create_query_context();
	}

	return contexts[depth];
}
```

Replace `update_query_clause_context` with:

```js
function update_query_clause_context(context, clause) {
	sqlClauseContext.update_query_clause_context(context, clause);
}
```

- [ ] **Step 6: Replace local QUALIFY guard implementation**

Replace the body of `should_apply_clause_match` with:

```js
function should_apply_clause_match(tokens, index, clause_match, context) {
	var clause = clause_match && clause_match.clause;
	var previous;
	var next;

	if (clause && clause.name == 'WITH' && context.lastClause == 'GROUP') {
		previous = previous_code_token(tokens, index);
		next = next_code_token(tokens, index);
		if (previous != null
			&& previous.type != 'operator'
			&& next != null
			&& next.type == 'word'
			&& /^(CUBE|ROLLUP|GROUPING)$/i.exec(next.value)) {
			return false;
		}
	}

	if (!clause || clause.name != 'QUALIFY') {
		return true;
	}

	return sqlClauseContext.is_real_qualify_clause(tokens, index, context);
}
```

- [ ] **Step 7: Replace opaque MATCH_RECOGNIZE protection**

Replace the entire `protect_opaque_segments` function with:

```js
function protect_opaque_segments(text, dialect, context) {
	var tokens = sqlTokenizer.tokenize(text, dialect);
	var result = '';
	var cursor = 0;
	var range;

	for (var i = 0; i < tokens.length; i++) {
		if (tokens[i].type != 'word') {
			continue;
		}

		range = sqlClauseContext.match_recognize_range(text, tokens, i);
		if (!range) {
			continue;
		}
		if (range.complete === false) {
			sqlUnsupportedPolicy.note_unsupported(context, 'opaque_clause', range.text);
			continue;
		}

		sqlUnsupportedPolicy.note_unsupported(context, 'opaque_clause', range.text);
		result += text.slice(cursor, range.start);
		result += context.store('opaque_clause', range.text);
		cursor = range.end;
		i = range.endIndex;
	}

	result += text.slice(cursor);
	return result;
}
```

- [ ] **Step 8: Run splitter-sensitive tests**

Run:

```bash
node tests/unsupported-safety.test.js
node tests/dialect-boundary.test.js
node tests/clause-registry.test.js
node tests/structured-differential.test.js
node tests/pipeline-idempotency.test.js
```

Expected: all commands pass.

- [ ] **Step 9: Commit splitter migration**

Run:

```bash
git add lib/core/sql-clause-splitter.js tests/unsupported-safety.test.js
git commit -m "refactor: use clause context in clause splitter"
```

Expected: commit succeeds.

---

### Task 5: Migrate Structured Clause Formatter QUALIFY Guard

**Files:**
- Modify: `lib/core/sql-clause-formatter.js`

- [ ] **Step 1: Add the shared import**

In `lib/core/sql-clause-formatter.js`, add this require after `var sqlGroupByExtension = require('./sql-group-by-extension');`:

```js
var sqlClauseContext = require('./sql-clause-context');
```

- [ ] **Step 2: Replace local active-token previous/next helpers**

Replace:

```js
function previous_code_token(tokens, index) {
	return index > 0 ? tokens[index - 1] : null;
}

function next_code_token(tokens, index) {
	return index + 1 < tokens.length ? tokens[index + 1] : null;
}
```

with:

```js
function previous_code_token(tokens, index) {
	return sqlClauseContext.previous_code_token(tokens, index);
}

function next_code_token(tokens, index) {
	return sqlClauseContext.next_code_token(tokens, index);
}
```

Keep these wrappers temporarily because other local code still calls the names. Module-boundary cleanup removes duplicated function declarations in Task 6 where safe.

- [ ] **Step 3: Use shared query context in query_context_before_token**

In `query_context_before_token`, replace the local context literal:

```js
var context = {
	inSelect: false,
	seenFrom: false,
	lastClause: ''
};
```

with:

```js
var context = sqlClauseContext.create_query_context();
```

Replace the whole local `update_query_clause_context` function with:

```js
function update_query_clause_context(context, clause) {
	sqlClauseContext.update_query_clause_context(context, clause);
}
```

- [ ] **Step 4: Replace local QUALIFY validation**

Replace the body of `should_apply_clause_match` with:

```js
function should_apply_clause_match(document, tokens, index, match, dialect) {
	var context;

	if (!match || !match.clause || match.clause.name != 'QUALIFY') {
		return true;
	}

	context = query_context_before_token(document, tokens, index, dialect);

	return sqlClauseContext.is_real_qualify_clause(tokens, index, context);
}
```

- [ ] **Step 5: Run structured formatter clause tests**

Run:

```bash
node tests/condition-alignment.test.js
node tests/unsupported-safety.test.js
node tests/dialect-boundary.test.js
node tests/structured-pipeline-regression.test.js
node tests/structured-differential.test.js
node tests/pipeline-idempotency.test.js
```

Expected: all commands pass.

- [ ] **Step 6: Commit clause formatter migration**

Run:

```bash
git add lib/core/sql-clause-formatter.js
git commit -m "refactor: use clause context in structured clause formatter"
```

Expected: commit succeeds.

---

### Task 6: Module Boundary Enforcement And Duplicate Cleanup

**Files:**
- Modify: `lib/core/sql-clause-splitter.js`
- Modify: `lib/core/sql-clause-formatter.js`
- Modify: `tests/module-boundary.test.js`

- [ ] **Step 1: Remove duplicate wrapper functions from clause splitter**

In `lib/core/sql-clause-splitter.js`, remove these function declarations entirely:

```js
function previous_code_token(tokens, index) {
	return sqlClauseContext.previous_code_token(tokens, index);
}

function next_code_token(tokens, index) {
	return sqlClauseContext.next_code_token(tokens, index);
}

function find_matching_paren(tokens, open_index) {
	return sqlClauseContext.find_matching_paren(tokens, open_index);
}
```

Then replace local call sites:

```js
previous_code_token(tokens, index)
next_code_token(tokens, index)
find_matching_paren(tokens, index)
```

with:

```js
sqlClauseContext.previous_code_token(tokens, index)
sqlClauseContext.next_code_token(tokens, index)
sqlClauseContext.find_matching_paren(tokens, index)
```

Also update the `is_query_paren`, `get_query_paren_kind`, `protect_opaque_segments`, `should_apply_clause_match`, and `is_unary_prefix_operator` call sites as needed so the file no longer declares migrated helper functions.

- [ ] **Step 2: Remove duplicate wrapper functions from clause formatter**

In `lib/core/sql-clause-formatter.js`, remove these function declarations entirely:

```js
function previous_code_token(tokens, index) {
	return sqlClauseContext.previous_code_token(tokens, index);
}

function next_code_token(tokens, index) {
	return sqlClauseContext.next_code_token(tokens, index);
}
```

Then replace local call sites:

```js
previous_code_token(tokens, index)
next_code_token(tokens, index)
```

with:

```js
sqlClauseContext.previous_code_token(tokens, index)
sqlClauseContext.next_code_token(tokens, index)
```

- [ ] **Step 3: Remove obsolete local QUALIFY helper functions**

In `lib/core/sql-clause-splitter.js` and `lib/core/sql-clause-formatter.js`, remove local declarations of:

```js
function can_precede_qualify_clause(...)
function can_follow_qualify_clause(...)
```

There should be no call sites left after Tasks 4 and 5.

- [ ] **Step 4: Add clause-context module-boundary imports and export assertion**

At the top of `tests/module-boundary.test.js`, add this require after `var sqlRenderWidth = require('../lib/core/sql-render-width');`:

```js
var sqlClauseContext = require('../lib/core/sql-clause-context');
```

After the existing `sqlRenderWidth` export assertion, add:

```js
assert.deepStrictEqual(
	Object.keys(sqlClauseContext).sort(),
	[
		'can_follow_qualify_clause',
		'can_precede_qualify_clause',
		'create_query_context',
		'find_matching_paren',
		'is_merge_statement',
		'is_pivot_construct',
		'is_real_qualify_clause',
		'match_recognize_range',
		'next_code_index',
		'next_code_token',
		'previous_code_token',
		'update_query_clause_context'
	],
	'clause context module must expose only shared clause/risk helpers'
);
```

- [ ] **Step 5: Add module existence assertion**

After the existing `sql-render-width.js` existence assertion block in `tests/module-boundary.test.js`, add:

```js
assert.ok(
	fs.existsSync(path.join(__dirname, '..', 'lib/core/sql-clause-context.js')),
	'structured clause context module must exist'
);
```

- [ ] **Step 6: Add import and duplicate-helper boundary checks**

In `tests/module-boundary.test.js`, after the existing `commentMutationSource` helper-boundary block, add:

```js
[
	'lib/core/sql-clause-splitter.js',
	'lib/core/sql-syntax-risk-detector.js',
	'lib/core/sql-clause-formatter.js'
].forEach(function(relativePath) {
	var source = read_source(relativePath);
	assert.ok(
		source.indexOf("require('./sql-clause-context')") >= 0,
		relativePath + ' must use shared sql-clause-context'
	);
});

[
	'lib/core/sql-clause-splitter.js',
	'lib/core/sql-syntax-risk-detector.js',
	'lib/core/sql-clause-formatter.js'
].forEach(function(relativePath) {
	var source = read_source(relativePath);
	[
		'can_precede_qualify_clause',
		'can_follow_qualify_clause',
		'is_pivot_construct',
		'is_merge_statement',
		'match_recognize_range'
	].forEach(function(functionName) {
		assert.strictEqual(
			new RegExp('function\\s+' + functionName + '\\s*\\(').test(source),
			false,
			relativePath + ' must delegate shared clause/risk helper implementation: ' + functionName
		);
	});
});

[
	'lib/core/sql-clause-splitter.js',
	'lib/core/sql-syntax-risk-detector.js',
	'lib/core/sql-clause-formatter.js'
].forEach(function(relativePath) {
	var source = read_source(relativePath);
	[
		'previous_code_token',
		'next_code_token',
		'find_matching_paren'
	].forEach(function(functionName) {
		assert.strictEqual(
			new RegExp('function\\s+' + functionName + '\\s*\\(').test(source),
			false,
			relativePath + ' must delegate raw token helper implementation: ' + functionName
		);
	});
});
```

Do not include `sql-clause-context.js` in these no-local-helper lists. It is the owner of these helpers.

- [ ] **Step 7: Add test:verify membership check for clause-context test**

In the `verifyScript` membership list in `tests/module-boundary.test.js`, add:

```js
'tests/clause-context.test.js',
```

Place it near `tests/clause-registry.test.js` or the other structured pipeline guards.

- [ ] **Step 8: Run module-boundary and targeted tests**

Run:

```bash
node tests/module-boundary.test.js
node tests/clause-context.test.js
node tests/unsupported-safety.test.js
node tests/dialect-boundary.test.js
node tests/structured-differential.test.js
node tests/pipeline-idempotency.test.js
```

Expected: all commands pass.

- [ ] **Step 9: Commit boundary cleanup**

Run:

```bash
git add lib/core/sql-clause-splitter.js lib/core/sql-clause-formatter.js tests/module-boundary.test.js package.json
git commit -m "test: enforce structured clause context boundaries"
```

Expected: commit succeeds.

---

### Task 7: Final Verification And Package Smoke

**Files:**
- No planned source edits.
- Possible modify only if verification reveals a real issue in files changed by earlier tasks.

- [ ] **Step 1: Run the full verification suite**

Run:

```bash
npm run test:verify
```

Expected: PASS.

- [ ] **Step 2: Run VSIX packaging**

This plan creates a new runtime core module, so run the package smoke even though extension metadata does not change.

```bash
ALL_PROXY=socks5://127.0.0.1:7897 npm run package:vsix
```

Expected: PASS and generates ignored `vscode-sql-beautify-v1.0.0.vsix`.

- [ ] **Step 3: Check VSIX package contents**

Run:

```bash
node - <<'NODE'
var child_process = require('child_process');
var listing = child_process.execFileSync('unzip', ['-Z1', 'vscode-sql-beautify-v1.0.0.vsix'], {
	encoding: 'utf8'
});

function assert_contains(path) {
	if (listing.indexOf(path + '\n') < 0) {
		throw new Error('VSIX is missing expected file: ' + path);
	}
}

function assert_absent(path) {
	if (listing.indexOf(path + '\n') >= 0) {
		throw new Error('VSIX contains excluded file: ' + path);
	}
}

assert_contains('extension/lib/core/sql-clause-context.js');
assert_absent('extension/tests/clause-context.test.js');

if (/^extension\/docs\/superpowers\//m.test(listing)) {
	throw new Error('VSIX contains excluded docs/superpowers files');
}

console.log('VSIX content check passed');
NODE
```

Expected:

```text
VSIX content check passed
```

The check confirms that `extension/lib/core/sql-clause-context.js` is packaged and that `tests/clause-context.test.js` plus `docs/superpowers` remain excluded by `.vscodeignore`.

- [ ] **Step 4: Inspect final status**

Run:

```bash
git status --short --ignored
```

Expected: no tracked changes. Ignored files such as `.DS_Store`, `node_modules/`, and local `.vsix` artifacts may appear and must not be committed.

- [ ] **Step 5: Record final commits and validation**

Run:

```bash
git log --oneline -8
```

Expected: recent commits include:

```text
test: add structured clause context guards
refactor: add structured clause context helper
refactor: use clause context for syntax risk detection
refactor: use clause context in clause splitter
refactor: use clause context in structured clause formatter
test: enforce structured clause context boundaries
```

Report:

- final commit SHAs
- `npm run test:verify` result
- `ALL_PROXY=socks5://127.0.0.1:7897 npm run package:vsix` result
- VSIX content check result
- any ignored artifacts present
