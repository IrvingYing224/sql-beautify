# Format Navigation Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Centralize structured formatter token and scope navigation so large formatter modules stop repeating linear lookup helpers.

**Architecture:** `FormatDocument` will own stable token and line indexes. A new `sql-format-navigation.js` module will expose document navigation helpers and scope index attachment. Structured formatter modules will consume that navigation API while preserving formatter output and keeping raw token-array modules out of the document abstraction.

**Tech Stack:** CommonJS, Node.js, SQL formatter core, existing tokenizer, CLI regression tests, `npm run test:verify`.

---

## Current State Notes

- The current working tree already contains an unstaged documentation change in `docs/superpowers/plans/2026-05-17-structured-formatter-pipeline-root-cause-plan.md` from the previous status sync. Do not revert it and do not include it in cleanup commits unless the user explicitly asks.
- The design spec for this work is committed as `e12d09b docs: add format navigation cleanup design`.
- This cleanup is behavior-preserving. Any formatter output change must be treated as suspicious until explained by a targeted test and explicitly accepted.

---

## File Responsibility Map

- Create: `lib/core/sql-format-navigation.js`
  - Owns `FormatDocument` navigation helpers and scope index attachment.
  - Does not make formatting decisions.

- Modify: `lib/core/sql-format-document.js`
  - Builds token, code token, and line indexes once during `from_text()`.

- Modify: `lib/core/sql-formatter.js`
  - Calls `sqlFormatNavigation.attach_scope_index(document)` after scope build and before node extraction.

- Modify: `lib/core/sql-structured-renderer.js`
  - Replaces local document token/scope lookup helpers with `sql-format-navigation`.

- Modify: `lib/core/sql-layout-formatter.js`
  - Replaces local token navigation helpers with `sql-format-navigation`.

- Modify: `lib/core/sql-case-formatter.js`
  - Replaces local document scope and token navigation helpers with `sql-format-navigation`.

- Modify: `lib/core/sql-condition-formatter.js`
  - Replaces duplicate document scope lookup helpers with `sql-format-navigation`.

- Modify: `lib/core/sql-format-nodes.js`
  - Reuses indexed active tokens and document scope lookup.

- Modify: `lib/core/sql-scope-model.js`
  - Reuses indexed active tokens; keeps scope-building state local where the document scope index does not exist yet.

- Create: `tests/format-navigation.test.js`
  - Verifies indexed lookup and navigation semantics.

- Modify: `tests/format-document-model.test.js`
  - Verifies `FormatDocument` exposes stable indexes.

- Modify: `tests/module-boundary.test.js`
  - Guards against reintroducing local document navigation helper definitions in structured modules.

- Modify: `package.json`
  - Adds `test:format-navigation` and includes the new test in `test:verify`.

---

## Task 0: Baseline And Scope Guard

**Files:**
- Read: `docs/superpowers/specs/2026-06-06-format-navigation-cleanup-design.md`
- Read: `git status`

- [x] **Step 1: Confirm the existing unstaged change**

Run:

```bash
git status --short
```

Expected:

```text
 M docs/superpowers/plans/2026-05-17-structured-formatter-pipeline-root-cause-plan.md
?? docs/superpowers/plans/2026-06-06-format-navigation-cleanup-plan.md
```

If additional unrelated tracked changes are present, inspect them before editing and do not overwrite them.

- [x] **Step 2: Run focused baseline tests**

Run:

```bash
node tests/format-document-model.test.js
node tests/format-scope-model.test.js
node tests/format-invariants.test.js
node tests/module-boundary.test.js
node tests/performance-smoke.test.js
```

Expected output includes:

```text
format document model tests passed
format scope model tests passed
format invariant tests passed
module boundary tests passed
performance smoke tests passed
```

---

## Task 1: Add Failing Navigation Tests

**Files:**
- Create: `tests/format-navigation.test.js`
- Modify: `tests/format-document-model.test.js`

- [x] **Step 1: Add `tests/format-navigation.test.js`**

Create the file with this content:

```js
var assert = require('assert');
var formatDocument = require('../lib/core/sql-format-document');
var scopeModel = require('../lib/core/sql-scope-model');
var navigation = require('../lib/core/sql-format-navigation');

var sql = [
    "select a, '-- keep select' as s -- trailing comment",
    'from t',
    'where a in (',
    '1, -- one',
    '2 -- two',
    ')'
].join('\n');

var doc = formatDocument.from_text(sql, { dialect: 'generic' });
doc.scopes = scopeModel.build(doc, { dialect: 'generic' });
navigation.attach_scope_index(doc);

var selectToken = doc.tokens.filter(function(token) {
    return token.type == 'word' && token.value.toUpperCase() == 'SELECT';
})[0];
var fromToken = doc.tokens.filter(function(token) {
    return token.type == 'word' && token.value.toUpperCase() == 'FROM';
})[0];
var stringToken = doc.tokens.filter(function(token) {
    return token.type == 'string_literal';
})[0];
var commaToken = doc.tokens.filter(function(token) {
    return token.type == 'punctuation' && token.value == ',';
})[0];

assert.strictEqual(navigation.token_by_id(doc, selectToken.id), selectToken, 'token lookup by id uses document index');
assert.strictEqual(navigation.token_by_index(doc, fromToken.index), fromToken, 'token lookup by index uses document index');
assert.strictEqual(navigation.line_by_index(doc, 0), doc.lines[0], 'line lookup by index returns physical line');
assert.strictEqual(navigation.active_tokens(doc)[0], selectToken, 'active tokens preserve source order');
assert.strictEqual(navigation.previous_code_token(doc, fromToken).value.toUpperCase(), 's'.toUpperCase(), 'previous code token skips comments and whitespace');
assert.strictEqual(navigation.next_code_token(doc, commaToken), stringToken, 'next code token skips whitespace');

var whereScope = doc.scopes.filter(function(scope) {
    return scope.kind == 'conditionBlock' && scope.keyword == 'WHERE';
})[0];
assert.ok(whereScope, 'WHERE condition scope exists');
assert.strictEqual(navigation.scope_by_id(doc, whereScope.id), whereScope, 'scope lookup by id uses attached scope index');

console.log('format navigation tests passed');
```

- [x] **Step 2: Extend `tests/format-document-model.test.js` with index assertions**

Add after the existing token assertions:

```js
var firstToken = doc.tokens[0];
assert.strictEqual(doc.tokenById[String(firstToken.id)], firstToken, 'document indexes tokens by id');
assert.strictEqual(doc.tokenByIndex[String(firstToken.index)], firstToken, 'document indexes tokens by tokenizer index');
assert.ok(doc.codeTokens.length > 0, 'document exposes active code tokens');
assert.strictEqual(
    doc.codeTokens[doc.codeTokenPositionByIndex[String(firstToken.index)]],
    firstToken,
    'document indexes active code token positions by tokenizer index'
);
assert.strictEqual(doc.lineByIndex[String(doc.lines[0].index)], doc.lines[0], 'document indexes lines by line index');
```

- [x] **Step 3: Run tests to verify failure**

Run:

```bash
node tests/format-navigation.test.js
```

Expected:

```text
Error: Cannot find module '../lib/core/sql-format-navigation'
```

Run:

```bash
node tests/format-document-model.test.js
```

Expected:

```text
TypeError
```

The exact `TypeError` can vary, but it must be caused by missing `tokenById`, `tokenByIndex`, `codeTokens`, `codeTokenPositionByIndex`, or `lineByIndex`.

---

## Task 2: Add FormatDocument Indexes

**Files:**
- Modify: `lib/core/sql-format-document.js`
- Test: `tests/format-document-model.test.js`

- [x] **Step 1: Add index builder helpers**

Add these functions before `from_text()`:

```js
function create_document_indexes(tokens, lines) {
    var tokenById = {};
    var tokenByIndex = {};
    var codeTokens = [];
    var codeTokenPositionByIndex = {};
    var lineByIndex = {};
    var i;

    for (i = 0; i < tokens.length; i++) {
        tokenById[String(tokens[i].id)] = tokens[i];
        tokenByIndex[String(tokens[i].index)] = tokens[i];
        if (tokens[i].isCode) {
            codeTokenPositionByIndex[String(tokens[i].index)] = codeTokens.length;
            codeTokens.push(tokens[i]);
        }
    }

    for (i = 0; i < lines.length; i++) {
        lineByIndex[String(lines[i].index)] = lines[i];
    }

    return {
        tokenById: tokenById,
        tokenByIndex: tokenByIndex,
        codeTokens: codeTokens,
        codeTokenPositionByIndex: codeTokenPositionByIndex,
        lineByIndex: lineByIndex
    };
}

function assign_document_indexes(document, indexes) {
    document.tokenById = indexes.tokenById;
    document.tokenByIndex = indexes.tokenByIndex;
    document.codeTokens = indexes.codeTokens;
    document.codeTokenPositionByIndex = indexes.codeTokenPositionByIndex;
    document.lineByIndex = indexes.lineByIndex;
    return document;
}
```

- [x] **Step 2: Return indexed document from `from_text()`**

Replace the final `return { ... }` in `from_text()` with:

```js
return assign_document_indexes({
    source: source,
    tokenizerOptions: options,
    tokens: tokens,
    lines: lines,
    scopes: [],
    scopeById: {},
    nodes: null,
    diagnostics: []
}, create_document_indexes(tokens, lines));
```

- [x] **Step 3: Run document model test**

Run:

```bash
node tests/format-document-model.test.js
```

Expected:

```text
format document model tests passed
```

---

## Task 3: Add `sql-format-navigation.js`

**Files:**
- Create: `lib/core/sql-format-navigation.js`
- Test: `tests/format-navigation.test.js`

- [x] **Step 1: Create navigation module**

Create `lib/core/sql-format-navigation.js`:

```js
function object_lookup(object, key) {
    return object && Object.prototype.hasOwnProperty.call(object, String(key))
        ? object[String(key)]
        : null;
}

function token_by_id(document, tokenId) {
    return object_lookup(document && document.tokenById, tokenId);
}

function token_by_index(document, tokenIndex) {
    return object_lookup(document && document.tokenByIndex, tokenIndex);
}

function line_by_index(document, lineIndex) {
    return object_lookup(document && document.lineByIndex, lineIndex);
}

function active_tokens(document) {
    return document && document.codeTokens ? document.codeTokens : [];
}

function code_position(document, token) {
    if (!document || !token || !document.codeTokenPositionByIndex) {
        return -1;
    }
    var value = document.codeTokenPositionByIndex[String(token.index)];
    return typeof value == 'number' ? value : -1;
}

function previous_code_token(document, token) {
    var tokens = active_tokens(document);
    var position = code_position(document, token);
    return position > 0 ? tokens[position - 1] : null;
}

function next_code_token(document, token) {
    var tokens = active_tokens(document);
    var position = code_position(document, token);
    return position >= 0 && position + 1 < tokens.length ? tokens[position + 1] : null;
}

function attach_scope_index(document) {
    var scopeById = {};
    var scopes = document && document.scopes ? document.scopes : [];

    for (var i = 0; i < scopes.length; i++) {
        scopeById[String(scopes[i].id)] = scopes[i];
    }

    if (document) {
        document.scopeById = scopeById;
    }
    return document;
}

function scope_by_id(document, scopeId) {
    return object_lookup(document && document.scopeById, scopeId);
}

function scope_by_id_from_list(scopes, scopeId) {
    for (var i = 0; i < (scopes || []).length; i++) {
        if (scopes[i].id == scopeId) {
            return scopes[i];
        }
    }
    return null;
}

exports.token_by_id = token_by_id;
exports.token_by_index = token_by_index;
exports.line_by_index = line_by_index;
exports.active_tokens = active_tokens;
exports.previous_code_token = previous_code_token;
exports.next_code_token = next_code_token;
exports.attach_scope_index = attach_scope_index;
exports.scope_by_id = scope_by_id;
exports.scope_by_id_from_list = scope_by_id_from_list;
```

- [x] **Step 2: Run navigation test**

Run:

```bash
node tests/format-navigation.test.js
```

Expected:

```text
format navigation tests passed
```

---

## Task 4: Wire Scope Index Attachment Into Main Pipeline

**Files:**
- Modify: `lib/core/sql-formatter.js`
- Modify: `tests/module-boundary.test.js`
- Modify: `package.json`

- [x] **Step 1: Require navigation in `sql-formatter.js`**

Add near the other structured formatter requires:

```js
var sqlFormatNavigation = require('./sql-format-navigation');
```

- [x] **Step 2: Attach scope index before node extraction**

In `format_sql_structured_detailed()`, change:

```js
document.scopes = sqlScopeModel.build(document, config);
var nodes = sqlFormatNodes.extract(document, config);
```

to:

```js
document.scopes = sqlScopeModel.build(document, config);
sqlFormatNavigation.attach_scope_index(document);
var nodes = sqlFormatNodes.extract(document, config);
```

- [x] **Step 3: Add test script entries**

In `package.json`, add:

```json
"test:format-navigation": "node tests/format-navigation.test.js"
```

Add `node tests/format-navigation.test.js` to `test:verify` after `tests/format-scope-model.test.js`.

- [x] **Step 4: Add module-boundary existence guard**

In `tests/module-boundary.test.js`, add next to the `sql-format-document.js` existence assertion:

```js
assert.ok(
    fs.existsSync(path.join(__dirname, '..', 'lib/core/sql-format-navigation.js')),
    'structured formatter must expose sql-format-navigation.js'
);
```

- [x] **Step 5: Run targeted tests**

Run:

```bash
node tests/format-navigation.test.js
node tests/module-boundary.test.js
```

Expected:

```text
format navigation tests passed
module boundary tests passed
```

---

## Task 5: Migrate Renderer And Layout Navigation

**Files:**
- Modify: `lib/core/sql-structured-renderer.js`
- Modify: `lib/core/sql-layout-formatter.js`
- Test: `tests/structured-pipeline-regression.test.js`
- Test: `tests/window-function-spacing.test.js`
- Test: `tests/condition-alignment.test.js`

- [x] **Step 1: Add navigation require to renderer**

In `lib/core/sql-structured-renderer.js`, add:

```js
var sqlFormatNavigation = require('./sql-format-navigation');
```

- [x] **Step 2: Replace renderer token and scope lookups**

In `lib/core/sql-structured-renderer.js`, replace calls as follows:

```js
token_by_index(document, value)
```

with:

```js
sqlFormatNavigation.token_by_index(document, value)
```

Replace:

```js
scope_by_id(document, value)
previous_code_token(document, token)
next_code_token(document, token)
```

with:

```js
sqlFormatNavigation.scope_by_id(document, value)
sqlFormatNavigation.previous_code_token(document, token)
sqlFormatNavigation.next_code_token(document, token)
```

After replacements, remove the local `token_by_index`, `scope_by_id`, `previous_code_token`, and `next_code_token` function definitions from the renderer.

- [x] **Step 3: Add navigation require to layout formatter**

In `lib/core/sql-layout-formatter.js`, add:

```js
var sqlFormatNavigation = require('./sql-format-navigation');
```

- [x] **Step 4: Replace layout token lookups**

In `lib/core/sql-layout-formatter.js`, replace local calls:

```js
token_by_index(document, value)
previous_code_token(document, token)
next_code_token(document, token)
```

with:

```js
sqlFormatNavigation.token_by_index(document, value)
sqlFormatNavigation.previous_code_token(document, token)
sqlFormatNavigation.next_code_token(document, token)
```

Remove the local helper definitions after all usages are replaced.

- [x] **Step 5: Run renderer and layout focused tests**

Run:

```bash
node tests/structured-pipeline-regression.test.js
node tests/window-function-spacing.test.js
node tests/condition-alignment.test.js
```

Expected:

```text
structured pipeline regression tests passed
window function spacing tests passed
condition alignment tests passed
```

---

## Task 6: Migrate Case, Condition, Nodes, And Scope Model Navigation

**Files:**
- Modify: `lib/core/sql-case-formatter.js`
- Modify: `lib/core/sql-condition-formatter.js`
- Modify: `lib/core/sql-format-nodes.js`
- Modify: `lib/core/sql-scope-model.js`
- Test: `tests/case-when.test.js`
- Test: `tests/condition-alignment.test.js`
- Test: `tests/format-scope-model.test.js`
- Test: `tests/format-invariants.test.js`

- [x] **Step 1: Replace case formatter lookup helpers**

Add to `lib/core/sql-case-formatter.js`:

```js
var sqlFormatNavigation = require('./sql-format-navigation');
```

Replace local calls:

```js
scope_by_id(document, scopeId)
previous_code_token(document, token)
next_code_token(document, token)
```

with:

```js
sqlFormatNavigation.scope_by_id(document, scopeId)
sqlFormatNavigation.previous_code_token(document, token)
sqlFormatNavigation.next_code_token(document, token)
```

Remove the local document lookup helper definitions after replacement.

- [x] **Step 2: Replace condition formatter scope helpers**

Add to `lib/core/sql-condition-formatter.js`:

```js
var sqlFormatNavigation = require('./sql-format-navigation');
```

Replace duplicate local `scope_by_id(document, scopeId)` calls with:

```js
sqlFormatNavigation.scope_by_id(document, scopeId)
```

Remove both duplicate local `scope_by_id` definitions after replacement.

- [x] **Step 3: Replace format node active token and scope helpers**

Add to `lib/core/sql-format-nodes.js`:

```js
var sqlFormatNavigation = require('./sql-format-navigation');
```

Replace local `active_tokens(document)` calls with:

```js
sqlFormatNavigation.active_tokens(document)
```

Replace the inner `scope_by_id(scopeId)` helper in `find_condition_blocks()` with:

```js
function scope_by_id(scopeId) {
    return sqlFormatNavigation.scope_by_id(document, scopeId);
}
```

Remove the local top-level `active_tokens(document)` helper once no usages remain.

- [x] **Step 4: Replace scope model active token helper**

Add to `lib/core/sql-scope-model.js`:

```js
var sqlFormatNavigation = require('./sql-format-navigation');
```

Replace:

```js
var tokens = active_tokens(document);
```

with:

```js
var tokens = sqlFormatNavigation.active_tokens(document);
```

Remove the local `active_tokens(document)` helper. Keep the local `scope_by_id(scopes, scopeId)` only if it is used while building scopes before `document.scopeById` exists; otherwise replace it with:

```js
sqlFormatNavigation.scope_by_id_from_list(scopes, scopeId)
```

- [x] **Step 5: Run focused tests**

Run:

```bash
node tests/case-when.test.js
node tests/condition-alignment.test.js
node tests/format-scope-model.test.js
node tests/format-invariants.test.js
```

Expected:

```text
case-when tests passed
condition alignment tests passed
format scope model tests passed
format invariant tests passed
```

---

## Task 7: Add Navigation Boundary Guards

**Files:**
- Modify: `tests/module-boundary.test.js`

- [x] **Step 1: Add structured helper duplication guard**

Add this block near the other source-level boundary checks in `tests/module-boundary.test.js`:

```js
[
    'lib/core/sql-structured-renderer.js',
    'lib/core/sql-layout-formatter.js',
    'lib/core/sql-case-formatter.js',
    'lib/core/sql-condition-formatter.js',
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

[
    'lib/core/sql-structured-renderer.js',
    'lib/core/sql-case-formatter.js',
    'lib/core/sql-condition-formatter.js',
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

Do not include `lib/core/sql-scope-model.js` in the scope lookup guard, because scope building may still need local lookup over the in-progress `scopes` array before `document.scopeById` exists.

- [x] **Step 2: Run module boundary test**

Run:

```bash
node tests/module-boundary.test.js
```

Expected:

```text
module boundary tests passed
```

---

## Task 8: Full Verification And Performance Check

**Files:**
- Verify only

- [x] **Step 1: Run focused navigation and model tests**

Run:

```bash
node tests/format-navigation.test.js
node tests/format-document-model.test.js
node tests/format-scope-model.test.js
node tests/format-invariants.test.js
node tests/module-boundary.test.js
node tests/performance-smoke.test.js
```

Expected output includes:

```text
format navigation tests passed
format document model tests passed
format scope model tests passed
format invariant tests passed
module boundary tests passed
performance smoke tests passed
```

- [x] **Step 2: Run full regression**

Run:

```bash
npm run test:verify
```

Expected final output includes:

```text
unsupported safety tests passed
```

- [x] **Step 3: Review final diff**

Run:

```bash
git diff --stat
git diff --check
```

Expected:

`git diff --check` must emit no output and exit 0.

- [x] **Step 4: Commit cleanup implementation**

Stage only files changed for this cleanup. Do not stage the existing status-sync modification unless the user explicitly asks.

Run:

```bash
git add lib/core/sql-format-document.js \
    lib/core/sql-format-navigation.js \
    lib/core/sql-formatter.js \
    lib/core/sql-structured-renderer.js \
    lib/core/sql-layout-formatter.js \
    lib/core/sql-case-formatter.js \
    lib/core/sql-condition-formatter.js \
    lib/core/sql-format-nodes.js \
    lib/core/sql-scope-model.js \
    tests/format-navigation.test.js \
    tests/format-document-model.test.js \
    tests/module-boundary.test.js \
    package.json
git commit -m "refactor: centralize format document navigation"
```

Expected:

```text
[codex/structured-formatter-pipeline-plan <sha>] refactor: centralize format document navigation
```

---

## Plan Self-Review

- [x] Spec coverage: covers FormatDocument indexes, navigation module, structured path helper replacement, raw token-array boundary, validation, and risks.
- [x] Completeness scan: no incomplete-marker words or ambiguous test instructions remain.
- [x] Boundary check: root `lib/*.js` shims are untouched; new logic stays in `lib/core/`.
- [x] Risk control: behavior-preserving refactor is split into indexed model, navigation module, pipeline wiring, module migrations, guard tests, and final verification.
