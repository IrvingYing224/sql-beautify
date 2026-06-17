# Dead Code Breaking Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the obsolete `sql-clause-splitter` module name, keep only the live opaque unsupported-syntax protection behavior, and remove the impossible `SQLSHIELDX{i}X` restore fallback.

**Architecture:** Move active `MATCH_RECOGNIZE(...)` opaque protection into `lib/core/sql-opaque-protector.js` with a two-function API. Update the structured formatter to depend on that module, delete both old splitter paths, and make module-boundary tests guard the new breaking-cleanup boundary. Keep formatter output and unsupported diagnostics behavior unchanged.

**Tech Stack:** Node.js CommonJS, repository-local test scripts, 4-space indentation, `var`, semicolons, no proxy for local validation commands.

---

## File Map

- Create: `lib/core/sql-opaque-protector.js`
  - Owns tokenizer-backed complete `MATCH_RECOGNIZE(...)` opaque protection and restore.
  - Exports only `protect_opaque_segments` and `restore_opaque_segments`.
- Delete: `lib/core/sql-clause-splitter.js`
  - Removes dead `split_clauses()` and all legacy clause splitting helpers.
- Delete: `lib/sql-clause-splitter.js`
  - Removes root compatibility shim for the obsolete private path.
- Modify: `lib/core/sql-formatter.js`
  - Replaces `sqlClauseSplitter` dependency with `sqlOpaqueProtector`.
- Modify: `lib/core/sql-shield.js`
  - Removes dead restore fallback that synthesizes `SQLSHIELDX{i}X` placeholders.
- Modify: `tests/module-boundary.test.js`
  - Guards the new opaque protector module and old splitter file removal.
- Modify: `tests/pipeline-idempotency.test.js`
  - Adds a direct regression for the removed `SQLSHIELDX{i}X` fallback.
- Modify: `docs/technical/sql-formatter-architecture.md`
  - Documents `sql-opaque-protector.js` as the owner for opaque unsupported segment protection.
- Modify: `AGENTS.md`
  - Updates current maintainer guidance so future low-confidence syntax work points at the new opaque protector, not the deleted splitter.

Do not modify, stage, delete, or depend on `docs/technical/engineering-review-2026-06-16.md`; it is user-owned and currently untracked.

## Task 1: Lock The New Module Boundary With Failing Tests

**Files:**
- Modify: `tests/module-boundary.test.js`

- [ ] **Step 1: Add the new module import**

In `tests/module-boundary.test.js`, add this require after the existing `sqlDiagnostics` require:

```js
var sqlOpaqueProtector = require('../lib/core/sql-opaque-protector');
```

- [ ] **Step 2: Add the opaque protector export assertion**

In `tests/module-boundary.test.js`, after the `sqlDiagnostics` export assertion, add:

```js
assert.deepStrictEqual(
	Object.keys(sqlOpaqueProtector).sort(),
	['protect_opaque_segments', 'restore_opaque_segments'],
	'opaque protector must expose only opaque protection helpers'
);
```

- [ ] **Step 3: Replace old splitter existence expectations**

Find the existing module existence assertions near the `sql-clause-context` and diagnostics checks. Keep the existing `sql-clause-context` and diagnostics assertions, then add these assertions nearby:

```js
assert.ok(
	fs.existsSync(path.join(__dirname, '..', 'lib/core/sql-opaque-protector.js')),
	'opaque protector module must exist'
);
assert.strictEqual(
	fs.existsSync(path.join(__dirname, '..', 'lib/core/sql-clause-splitter.js')),
	false,
	'obsolete core clause splitter must not exist'
);
assert.strictEqual(
	fs.existsSync(path.join(__dirname, '..', 'lib/sql-clause-splitter.js')),
	false,
	'obsolete root clause splitter shim must not exist'
);
```

- [ ] **Step 4: Update shared clause context boundary arrays**

In `tests/module-boundary.test.js`, replace each array that currently starts with `lib/core/sql-clause-splitter.js` and also contains `lib/core/sql-syntax-risk-detector.js` and `lib/core/sql-clause-formatter.js` with this array:

```js
[
	'lib/core/sql-opaque-protector.js',
	'lib/core/sql-syntax-risk-detector.js',
	'lib/core/sql-clause-formatter.js'
].forEach(function(relativePath) {
	var source = read_source(relativePath);
	assert.ok(
		source.indexOf("require('./sql-clause-context')") >= 0,
		relativePath + ' must use shared sql-clause-context'
	);
});
```

For the next two loops in the same section, use the same three-file array and keep their existing helper-name assertions:

```js
[
	'lib/core/sql-opaque-protector.js',
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
	'lib/core/sql-opaque-protector.js',
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

- [ ] **Step 5: Add live formatter graph assertions**

In `tests/module-boundary.test.js`, after `combinedLiveFormatterSource` is defined and before the obsolete formatter API assertions, add:

```js
assert.ok(
	formatterSource.indexOf("require('./sql-opaque-protector')") >= 0,
	'sql-formatter must import the opaque protector module'
);
assert.strictEqual(
	combinedLiveFormatterSource.indexOf('sql-clause-splitter'),
	-1,
	'live formatter source graph must not reference obsolete sql-clause-splitter'
);
assert.strictEqual(
	/\bsplit_clauses\b/.test(combinedLiveFormatterSource),
	false,
	'live formatter source graph must not retain split_clauses'
);
```

- [ ] **Step 6: Run the focused boundary test and confirm failure**

Run:

```bash
node tests/module-boundary.test.js
```

Expected: FAIL because `../lib/core/sql-opaque-protector` does not exist yet, or because the old splitter files still exist. Do not commit this failing state.

## Task 2: Replace Clause Splitter With Opaque Protector

**Files:**
- Create: `lib/core/sql-opaque-protector.js`
- Modify: `lib/core/sql-formatter.js`
- Delete: `lib/core/sql-clause-splitter.js`
- Delete: `lib/sql-clause-splitter.js`
- Test: `tests/module-boundary.test.js`
- Test: `tests/unsupported-safety.test.js`
- Test: `tests/diagnostics-explainability.test.js`
- Test: `tests/safe-diagnostic-report.test.js`

- [ ] **Step 1: Create the new opaque protector module**

Create `lib/core/sql-opaque-protector.js` with this complete content:

```js
var sqlTokenizer = require('./sql-tokenizer');
var sqlClauseContext = require('./sql-clause-context');
var sqlUnsupportedPolicy = require('./sql-unsupported-policy');

function note_opaque_segment(context, range) {
    var protectedSource = !(range && range.complete === false);
    sqlUnsupportedPolicy.note_unsupported(context, 'opaque_clause', {
        kind: 'opaque_clause',
        label: 'MATCH_RECOGNIZE',
        text: range.text,
        snippet: range.text,
        range: {
            start: range.start,
            end: range.end
        },
        source: protectedSource ? 'opaque_protection' : 'syntax_risk_detector',
        confidence: 'known_low_confidence'
    });
}

function protect_opaque_segments(text, dialect, context, options) {
    var behavior = options || {};
    var recordUnsupported = behavior.recordUnsupported !== false;
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
            if (recordUnsupported) {
                note_opaque_segment(context, range);
            }
            continue;
        }

        if (recordUnsupported) {
            note_opaque_segment(context, range);
        }
        result += text.slice(cursor, range.start);
        result += context.store('opaque_clause', range.text);
        cursor = range.end;
        i = range.endIndex;
    }

    result += text.slice(cursor);
    return result;
}

function restore_opaque_segments(text, context) {
    return context.restore('opaque_clause', text);
}

exports.protect_opaque_segments = protect_opaque_segments;
exports.restore_opaque_segments = restore_opaque_segments;
```

- [ ] **Step 2: Update the formatter dependency**

In `lib/core/sql-formatter.js`, replace this require:

```js
var sqlClauseSplitter = require('./sql-clause-splitter');
```

with:

```js
var sqlOpaqueProtector = require('./sql-opaque-protector');
```

Then replace the structured protect/restore helper bodies with:

```js
function protect_structured_input(text, config, dialect, context) {
	var protectedText = sqlNormalizePasses.protect_set_payloads(text, context, dialect).text;
	protectedText = sqlOpaqueProtector.protect_opaque_segments(protectedText, config.dialect, context, {
		recordUnsupported: false
	});
	return protectedText;
}

function restore_structured_output(text, context) {
	var restored = sqlOpaqueProtector.restore_opaque_segments(text, context);
	return sqlNormalizePasses.restore_set_payloads(restored, context);
}
```

- [ ] **Step 3: Delete obsolete module files**

Run:

```bash
git rm lib/core/sql-clause-splitter.js lib/sql-clause-splitter.js
```

Expected: both files are removed and staged as deletions.

- [ ] **Step 4: Run focused tests**

Run:

```bash
node tests/module-boundary.test.js
node tests/unsupported-safety.test.js
node tests/diagnostics-explainability.test.js
node tests/safe-diagnostic-report.test.js
```

Expected: all four commands pass. If an unsupported diagnostic assertion fails, compare the new `note_opaque_segment()` data against the old `lib/core/sql-clause-splitter.js` behavior from before deletion and preserve the old metadata shape.

- [ ] **Step 5: Confirm no live old splitter implementation remains**

Run:

```bash
rg -n "require\\(['\"].*sql-clause-splitter|function\\s+split_clauses|exports\\.split_clauses" lib tests
```

Expected: no output.

- [ ] **Step 6: Commit the boundary migration**

Run:

```bash
git add tests/module-boundary.test.js lib/core/sql-formatter.js lib/core/sql-opaque-protector.js
git commit -m "refactor: replace clause splitter with opaque protector"
```

Expected: one commit that includes the new module, formatter import change, tests, and both splitter deletions that were already staged by `git rm`. Do not stage `docs/technical/engineering-review-2026-06-16.md`.

## Task 3: Remove The Dead Shield Restore Fallback

**Files:**
- Modify: `tests/pipeline-idempotency.test.js`
- Modify: `lib/core/sql-shield.js`
- Test: `tests/pipeline-idempotency.test.js`
- Test: `tests/token-boundary.test.js`

- [ ] **Step 1: Add the failing shield fallback regression**

In `tests/pipeline-idempotency.test.js`, immediately after the existing assertion that `sqlShield.restore(shielded.text, shielded.tokens)` reproduces `shieldInput`, add:

```js
assert.strictEqual(
	sqlShield.restore('SQLSHIELDX0X', ['SHOULD_NOT_APPEAR']),
	'SQLSHIELDX0X',
	'shield restore must not synthesize obsolete SQLSHIELDX placeholders'
);
```

- [ ] **Step 2: Run the focused test and confirm failure**

Run:

```bash
node tests/pipeline-idempotency.test.js
```

Expected: FAIL because current `restore()` fabricates `SQLSHIELDX0X` and replaces it with `SHOULD_NOT_APPEAR`.

- [ ] **Step 3: Replace the restore implementation**

In `lib/core/sql-shield.js`, replace the entire `restore()` function with:

```js
function restore(text, protected_tokens, items) {
    var result = String(text || '');
    var restore_items = items || (protected_tokens && protected_tokens.items) || [];

    for (var q = 0; q < restore_items.length; q++) {
        result = result.split(restore_items[q].placeholder).join(restore_items[q].value);
    }

    return result;
}
```

This keeps current `protect()` contract restoration and returns input unchanged when no item metadata exists.

- [ ] **Step 4: Run focused tests**

Run:

```bash
node tests/pipeline-idempotency.test.js
node tests/token-boundary.test.js
```

Expected: both pass. `tests/token-boundary.test.js` already covers user text shaped like `SQLSHIELDX0X`; keep that assertion.

- [ ] **Step 5: Commit the shield cleanup**

Run:

```bash
git add tests/pipeline-idempotency.test.js lib/core/sql-shield.js
git commit -m "fix: remove dead shield restore fallback"
```

Expected: one focused commit for the shield fallback behavior.

## Task 4: Update Current Architecture Guidance And Run Full Validation

**Files:**
- Modify: `docs/technical/sql-formatter-architecture.md`
- Modify: `AGENTS.md`
- Test: full local validation commands

- [ ] **Step 1: Update the core boundary description**

In `docs/technical/sql-formatter-architecture.md`, replace the `lib/core/` boundary bullet with:

```markdown
- `lib/core/`: SQL formatting core. It owns tokenization, shielding, canonical options, registries, opaque unsupported-segment protection, clause line-break mutations, comment/code line modeling, case/select/condition formatting, layout rendering, and keyword casing.
```

- [ ] **Step 2: Add the opaque protector boundary bullet**

In `docs/technical/sql-formatter-architecture.md`, add this bullet after the `lib/core/sql-clause-context.js` bullet:

```markdown
- `lib/core/sql-opaque-protector.js`: tokenizer-backed protection for complete `MATCH_RECOGNIZE(...)` opaque unsupported clauses. It stores and restores complete opaque ranges, records unsupported metadata, and must not own general clause splitting or layout.
```

- [ ] **Step 3: Update the clause context boundary bullet**

In `docs/technical/sql-formatter-architecture.md`, replace the `lib/core/sql-clause-context.js` bullet with:

```markdown
- `lib/core/sql-clause-context.js`: shared token-aware context helper for opaque protection, syntax-risk detection, and structured clause mutation boundaries. `QUALIFY`, `PIVOT` / `UNPIVOT`, `MERGE`, and `MATCH_RECOGNIZE` detection must use this helper rather than duplicating local word-value checks.
```

- [ ] **Step 4: Update the unsupported policy wording**

In `docs/technical/sql-formatter-architecture.md`, replace this sentence:

```markdown
Clause splitting follows the same rule so a `SELECT qualify AS c` list item is not rewritten into a `QUALIFY` clause.
```

with:

```markdown
Clause boundary handling follows the same rule so a `SELECT qualify AS c` list item is not rewritten into a `QUALIFY` clause.
```

- [ ] **Step 5: Update current maintainer guidance**

In `AGENTS.md`, replace the trigger line that mentions `lib/core/sql-clause-splitter.js` with the same line using `lib/core/sql-opaque-protector.js` instead:

```markdown
- 触发信号：修改 `unsupportedSyntaxPolicy`、`lib/core/sql-syntax-risk-detector.js`、`lib/core/sql-opaque-protector.js`、`lib/core/sql-clause-registry.js`、dialect capability 或新增未建模 SQL 结构时。
```

Do not rewrite old historical plans/specs under `docs/superpowers/`; they are records of prior work.

- [ ] **Step 6: Run targeted validation**

Run:

```bash
node tests/module-boundary.test.js
node tests/unsupported-safety.test.js
node tests/diagnostics-explainability.test.js
node tests/safe-diagnostic-report.test.js
node tests/pipeline-idempotency.test.js
node tests/token-boundary.test.js
```

Expected: every command prints its passing message or exits with code 0.

- [ ] **Step 7: Run full regression validation**

Run:

```bash
npm run test:verify
```

Expected: all repository verification tests pass.

- [ ] **Step 8: Run package validation and inspect runtime contents**

Run:

```bash
npm run package:vsix
VSIX="vscode-sql-beautify-v$(node -p "require('./package.json').version").vsix"
MATCHES="$(unzip -l "$VSIX" | rg "extension/lib/core/sql-opaque-protector\\.js|extension/lib/core/sql-clause-splitter\\.js|extension/lib/sql-clause-splitter\\.js")"
printf '%s\n' "$MATCHES"
test "$(printf '%s\n' "$MATCHES" | rg -c "extension/lib/core/sql-opaque-protector\\.js")" = "1"
test "$(printf '%s\n' "$MATCHES" | rg -c "extension/lib/core/sql-clause-splitter\\.js|extension/lib/sql-clause-splitter\\.js")" = "0"
rm -f "$VSIX"
```

Expected: the `unzip` check prints exactly one relevant module entry, `extension/lib/core/sql-opaque-protector.js`. It must not print `extension/lib/core/sql-clause-splitter.js` or `extension/lib/sql-clause-splitter.js`.

- [ ] **Step 9: Run whitespace validation**

Run:

```bash
git diff --check
```

Expected: no output.

- [ ] **Step 10: Confirm final worktree shape before committing docs**

Run:

```bash
git status --short --branch
```

Expected: changed tracked files include `docs/technical/sql-formatter-architecture.md` and `AGENTS.md`; the only unrelated untracked file remains `docs/technical/engineering-review-2026-06-16.md`. There must be no `.vsix` file staged or untracked.

- [ ] **Step 11: Commit the documentation update**

Run:

```bash
git add docs/technical/sql-formatter-architecture.md AGENTS.md
git commit -m "docs: document opaque protector boundary"
```

Expected: one focused documentation commit.

- [ ] **Step 12: Final status check**

Run:

```bash
git status --short --branch
```

Expected: branch is ahead of `origin/main`; only `docs/technical/engineering-review-2026-06-16.md` remains untracked.

## Final Acceptance Checklist

- [ ] `lib/core/sql-opaque-protector.js` exists and exports only `protect_opaque_segments` and `restore_opaque_segments`.
- [ ] `lib/core/sql-clause-splitter.js` is deleted.
- [ ] `lib/sql-clause-splitter.js` is deleted.
- [ ] `lib/core/sql-formatter.js` imports `./sql-opaque-protector`.
- [ ] `lib/core/sql-shield.js` no longer contains `SQLSHIELDX`.
- [ ] `MATCH_RECOGNIZE(...)` preserve/warn/bail-out behavior remains covered by tests.
- [ ] `npm run test:verify` passes.
- [ ] `npm run package:vsix` passes and the generated VSIX contains `sql-opaque-protector.js` but not the old splitter files.
- [ ] `git diff --check` passes.
- [ ] The untracked engineering review file remains untouched.
