# SQL Beautify Full Refactor And Production Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 全面修复本项目已识别的稳定性、架构、兼容性、配置、编辑器入口、DDL、测试、文档和发布工具链问题，并把 `vkbeautify.js` 从单体实现拆成可长期维护的模块化 formatter。

**Architecture:** 这是新分支上的大胆重构计划。先用回归测试锁定当前高风险 bug 和既有 Hive SQL 行为，再把 `vkbeautify.js` 中的注释保护、CASE 渲染、SELECT/AS 对齐、条件换行、DDL/Extract DDL、pipeline orchestration 拆到 `lib/` 下的独立模块。允许文件移动、删除死代码、修改 root config / CI、引入开发依赖和调整命令/配置贡献，但必须通过测试、文档和兼容性说明把行为变化讲清楚。

**Tech Stack:** VS Code extension、CommonJS、Node.js、项目内 CLI 回归测试、GitHub Actions、VSIX packaging。

---

## Execution Authorization

- 全程在 `/Users/yingirving/Documents/sql-beautify` 执行。
- 这是新分支，允许大规模重构、文件拆分、移动代码、删除确认无用的死代码、修改 `package.json`、`.github/workflows/*`、`.vscodeignore`、README/CHANGELOG 和测试结构。
- 允许引入开发依赖，例如 `@vscode/vsce`、`@types/vscode`、`@vscode/test-electron` 或轻量测试 runner；不引入运行时依赖，除非任务执行者能证明它直接降低 formatter 风险且更新文档和测试。
- 允许调整 VS Code command/config 贡献；若改动用户可见入口，必须提供迁移说明，并尽量保留旧入口 alias 或 fallback，除非测试和文档明确证明移除是有意破坏性变更。
- 所有网络命令前必须使用 `export ALL_PROXY=socks5://127.0.0.1:7897`。
- 不创建 git commit、不推送、不打包 Release VSIX，除非用户在执行会话里明确要求。
- 每个任务都要先写或更新测试，再改实现，再运行指定测试。格式化相关阶段结束必须运行 `npm run test:verify`。
- 如果测试失败，不得绕过断言；保留失败输出，定位根因，修复实现或修正测试预期中的错误假设。

## Problems To Implement

This plan must address every issue from the engineering review:

- Internal placeholder collisions can corrupt user SQL: `NEEDReplace`, `{LC0}`, `{SQLSETPAYLOAD0}`, `{SQLSTANDALONECOMMENT0}`.
- `vkbeautify.js` is a 2800+ line coupled formatter mixing token protection, regex passes, CASE rendering, SELECT alignment, condition alignment, DDL formatting, extract DDL, config-era behavior, and global state.
- Current formatter presents as generic SQL but is materially Hive-first; non-Hive syntax such as PostgreSQL dollar quotes, MySQL `#` comments, and PostgreSQL JSON `->>` can be corrupted.
- `extension.*` config namespace is too generic; new/old config priority and numeric validation need to be explicit.
- VS Code editor entry points do not reject overlapping selections and do not report failed `editor.edit(...)` calls.
- DDL and Extract DDL are experimental but implementation and tests do not fully isolate risk.
- Test suite has useful regression coverage but lacks high-risk negative tests, module-level API tests, and editor/config source tests for the new architecture.
- Tooling is outdated: old `vscode` devDependency, dynamic unpinned `npx @vscode/vsce`, no predictable package/install path in CI.
- README describes best-effort caveats but product boundaries and migration guidance need to match actual behavior.

## Target File Structure

The final shape should be close to this. Exact internal helper names may differ, but file responsibilities must stay clear.

- `vkbeautify.js`
  - Public API wrapper only: exports `sql`, `sqlddl`, `extractddl`.
  - No formatter implementation blocks longer than simple orchestration.
- `lib/sql-formatter.js`
  - Main `format_sql(text, options)` pipeline.
  - Owns pass ordering and restore order.
- `lib/sql-format-context.js`
  - Per-format-call nonce markers and protected item stores.
  - Replaces global `restore_list`, `restore_cnt`, `NEEDReplace`, `{LC0}`, `{SQLSETPAYLOAD0}` style placeholders.
- `lib/sql-comment-formatter.js`
  - Standalone/inline line-comment protection, comment marker normalization, trailing comment alignment.
- `lib/sql-case-formatter.js`
  - All `CASE WHEN` parsing and rendering.
- `lib/sql-select-formatter.js`
  - SELECT/GROUP BY list wrapping, comma layout, top-level `AS` alignment.
- `lib/sql-condition-formatter.js`
  - WHERE/ON/HAVING AND/OR wrapping and alignment.
- `lib/sql-ddl-formatter.js`
  - Hive DDL formatting and Extract DDL experimental implementation.
- `lib/sql-dialect.js`
  - Dialect capability flags and token/operator rules for `hive`, `generic`, `postgres`, and `mysql` best-effort behavior.
- Existing modules retained and improved:
  - `lib/sql-tokenizer.js`
  - `lib/sql-shield.js`
  - `lib/sql-format-pipeline.js`
  - `lib/sql-render-options.js`
  - `lib/sql-line-model.js`
  - `lib/sql-structure.js`
  - `lib/sql-keywords.js`
- New/modified tests:
  - `tests/placeholder-collision.test.js`
  - `tests/dialect-boundary.test.js`
  - `tests/formatter-api.test.js`
  - `tests/module-boundary.test.js`
  - existing `tests/*.test.js`

## Task 1: Baseline And High-Risk Regression Tests

**Files:**
- Create: `tests/placeholder-collision.test.js`
- Create: `tests/dialect-boundary.test.js`
- Create: `tests/formatter-api.test.js`
- Modify: `package.json`

- [ ] **Step 1: Run current baseline**

Run:

```bash
npm run test:verify
```

Expected: exit 0. Save the command and result for the final report.

- [ ] **Step 2: Add placeholder collision tests**

Create `tests/placeholder-collision.test.js`:

```js
var assert = require('assert');
var vkbeautify = require('../vkbeautify');

function format(sql) {
    return vkbeautify.sql(sql, true, false, true, 150, 80).trim();
}

function assert_contains(name, input, expected) {
    var actual = format(input);
    assert.ok(actual.indexOf(expected) >= 0, name + '\n--- expected ---\n' + expected + '\n--- actual ---\n' + actual);
}

function assert_not_contains(name, input, forbidden) {
    var actual = format(input);
    assert.strictEqual(actual.indexOf(forbidden), -1, name + '\n--- forbidden ---\n' + forbidden + '\n--- actual ---\n' + actual);
}

assert_not_contains('NEEDReplace identifier is not replaced with undefined', 'select NEEDReplace as c from t', 'undefined');
assert_contains('NEEDReplace identifier survives', 'select NEEDReplace as c from t', 'NEEDReplace');

assert_not_contains('line comment marker text is not restored from internal store', 'select a --{LC0}\nfrom t', 'undefined');
assert_contains('line comment marker text survives', 'select a --{LC0}\nfrom t', '-- {LC0}');

assert_not_contains('set payload marker-looking code is not restored from internal store', 'select {SQLSETPAYLOAD0} as x from t', 'undefined');
assert_contains('set payload marker-looking code survives', 'select {SQLSETPAYLOAD0} as x from t', '{SQLSETPAYLOAD0}');

assert_not_contains('standalone marker-looking code is not restored from internal store', 'select {SQLSTANDALONECOMMENT0} as x from t -- c', 'undefined');
assert_contains('standalone marker-looking code survives', 'select {SQLSTANDALONECOMMENT0} as x from t -- c', '{SQLSTANDALONECOMMENT0}');

console.log('placeholder collision tests passed');
```

- [ ] **Step 3: Add dialect boundary tests**

Create `tests/dialect-boundary.test.js`:

```js
var assert = require('assert');
var vkbeautify = require('../vkbeautify');

function format(sql, dialect) {
    return vkbeautify.sql(sql, true, false, true, 150, 80, { dialect: dialect || 'generic' }).trim();
}

function assert_contains(name, input, expected, dialect) {
    var actual = format(input, dialect);
    assert.ok(actual.indexOf(expected) >= 0, name + '\n--- expected ---\n' + expected + '\n--- actual ---\n' + actual);
}

function assert_not_contains(name, input, forbidden, dialect) {
    var actual = format(input, dialect);
    assert.strictEqual(actual.indexOf(forbidden), -1, name + '\n--- forbidden ---\n' + forbidden + '\n--- actual ---\n' + actual);
}

assert_contains(
    'PostgreSQL dollar quoted string is opaque in generic mode',
    'select $$from where case when then$$ as s from t where a=1',
    '$$from where case when then$$',
    'generic'
);

assert_contains(
    'MySQL hash comment is a line comment in generic mode',
    'select a # from where\nfrom t',
    '# from where',
    'generic'
);

assert_contains(
    'PostgreSQL JSON operator keeps arrow text',
    "select data->>'name' as name from t where data->'x' is not null",
    "data->>'name'",
    'postgres'
);

assert_not_contains(
    'PostgreSQL JSON operator is not split by greater-than spacing',
    "select data->>'name' as name from t",
    '->  >',
    'postgres'
);

console.log('dialect boundary tests passed');
```

- [ ] **Step 4: Add public API tests before refactor**

Create `tests/formatter-api.test.js`:

```js
var assert = require('assert');
var vkbeautify = require('../vkbeautify');

assert.strictEqual(typeof vkbeautify.sql, 'function', 'vkbeautify.sql must be exported');
assert.strictEqual(typeof vkbeautify.sqlddl, 'function', 'vkbeautify.sqlddl must be exported');
assert.strictEqual(typeof vkbeautify.extractddl, 'function', 'vkbeautify.extractddl must be exported');

var formatted = vkbeautify.sql('select a,b from t where x=1 and y=2', true, false, true, 150, 80).trim();
assert.ok(formatted.indexOf('SELECT') >= 0, 'sql formatter should uppercase SELECT by default');
assert.ok(formatted.indexOf('WHERE x = 1') >= 0, 'sql formatter should preserve formatted WHERE condition');

var lower = vkbeautify.sql('select a from t', false, false, true, 150, 80).trim();
assert.ok(lower.indexOf('select') >= 0, 'sql formatter should keep lower keyword mode');

console.log('formatter api tests passed');
```

- [ ] **Step 5: Wire scripts**

Modify `package.json` scripts:

```json
"test:placeholder": "node tests/placeholder-collision.test.js",
"test:dialect": "node tests/dialect-boundary.test.js",
"test:api": "node tests/formatter-api.test.js"
```

Update `test:verify` to include the new scripts after `test:token`:

```json
"test:verify": "node tests/comment-alignment.test.js && node tests/case-when.test.js && node tests/hive-regression.test.js && node tests/token-boundary.test.js && node tests/placeholder-collision.test.js && node tests/dialect-boundary.test.js && node tests/formatter-api.test.js && node tests/extension-contribution.test.js && node tests/config-options.test.js && node tests/pipeline-idempotency.test.js && node tests/ddl-regression.test.js"
```

- [ ] **Step 6: Confirm new tests expose current defects**

Run:

```bash
npm run test:placeholder
npm run test:dialect
npm run test:api
```

Expected: `test:api` passes. At least one of `test:placeholder` or `test:dialect` fails before implementation. Record failures for final report.

## Task 2: Introduce Format Context And Remove Global Placeholder State

**Files:**
- Create: `lib/sql-format-context.js`
- Modify: `vkbeautify.js`
- Test: `tests/placeholder-collision.test.js`

- [ ] **Step 1: Create context module**

Create `lib/sql-format-context.js`:

```js
function escape_regex(text) {
    return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function create_nonce(source, label) {
    var seed = 0;
    var nonce = '';
    do {
        nonce = 'SQLBEAUTIFY_' + label + '_' + seed + '_';
        seed += 1;
    } while (String(source || '').indexOf(nonce) >= 0);
    return nonce;
}

function create_context(source) {
    return {
        source: String(source || ''),
        stores: {},
        nonces: {},
        marker: function(label, index) {
            if (!this.nonces[label]) {
                this.nonces[label] = create_nonce(this.source, label);
            }
            return '{' + this.nonces[label] + index + '}';
        },
        marker_regex: function(label) {
            if (!this.nonces[label]) {
                this.nonces[label] = create_nonce(this.source, label);
            }
            return new RegExp('\\{' + escape_regex(this.nonces[label]) + '(\\d+)\\}', 'g');
        },
        store: function(label, value) {
            if (!this.stores[label]) {
                this.stores[label] = [];
            }
            var index = this.stores[label].length;
            this.stores[label].push(value);
            return this.marker(label, index);
        },
        restore: function(label, text) {
            var values = this.stores[label] || [];
            return String(text || '').replace(this.marker_regex(label), function(match, index) {
                return values[parseInt(index, 10)];
            });
        }
    };
}

exports.create_context = create_context;
exports.escape_regex = escape_regex;
```

- [ ] **Step 2: Replace SET payload markers**

In `vkbeautify.js`, require the context module:

```js
var sqlFormatContext = require('./lib/sql-format-context');
```

Change `protect_set_payloads(str)` to accept `context`:

```js
function protect_set_payloads(str, context) {
```

Replace `{SQLSETPAYLOAD...}` with:

```js
context.store('set_payload', normalize_set_payload(payload_text))
```

Replace `{SQLSETNEWLINE}` with:

```js
context.store('set_newline', '\n')
```

Return only `{ text: text }`.

Replace `restore_set_payloads` with:

```js
function restore_set_payloads(str, context) {
    return context.restore('set_newline', context.restore('set_payload', str));
}
```

- [ ] **Step 3: Replace line-comment and standalone-comment markers**

Change `protect_standalone_comments(str)` to accept `context` and store comment text via:

```js
text_list[i] = context.store('standalone_comment', comment_text);
```

Return `{ text: text_list.join("\n") }`.

Change `protect_inline_comments(str, context)` so inline comments are stored as:

```js
text_list[i] = text_list[i].slice(0, comment_loc) + '--' + context.store('line_comment', text_list[i].slice(comment_loc).replace(/\s+$/ig, ""));
```

Replace `restore_standalone_comments(str, comment_store)` with:

```js
function restore_comments(str, context) {
    var result = context.restore('line_comment', str);
    return context.restore('standalone_comment', result);
}
```

- [ ] **Step 4: Remove `NEEDReplace` from the main SQL path**

Keep legacy `extract_quotation_mark` and `restore_strmark` only if `extractddl` still needs them during this task. The main `vkbeautify.prototype.sql` path must not call `extract_quotation_mark`, `restore_strmark`, `repeat_text_replace`, `restore_list`, or `restore_cnt`.

At the start of `vkbeautify.prototype.sql`, create context:

```js
var context = sqlFormatContext.create_context(text);
```

Use it for SET and comment protection/restoration.

- [ ] **Step 5: Verify placeholder fix**

Run:

```bash
npm run test:placeholder
npm run test:verify
```

Expected: both pass. If Hive regression changes unexpectedly, fix the refactor rather than changing expected output.

## Task 3: Split `vkbeautify.js` Into Formatter Modules

**Files:**
- Create: `lib/sql-comment-formatter.js`
- Create: `lib/sql-case-formatter.js`
- Create: `lib/sql-select-formatter.js`
- Create: `lib/sql-condition-formatter.js`
- Create: `lib/sql-ddl-formatter.js`
- Create: `lib/sql-formatter.js`
- Create: `tests/module-boundary.test.js`
- Modify: `vkbeautify.js`
- Modify: `package.json`

- [ ] **Step 1: Create module boundary test**

Create `tests/module-boundary.test.js`:

```js
var assert = require('assert');

var sqlFormatter = require('../lib/sql-formatter');
var sqlCommentFormatter = require('../lib/sql-comment-formatter');
var sqlCaseFormatter = require('../lib/sql-case-formatter');
var sqlSelectFormatter = require('../lib/sql-select-formatter');
var sqlConditionFormatter = require('../lib/sql-condition-formatter');
var sqlDdlFormatter = require('../lib/sql-ddl-formatter');

assert.strictEqual(typeof sqlFormatter.format_sql, 'function', 'sql-formatter must export format_sql');
assert.strictEqual(typeof sqlCommentFormatter.normalize_line_comment_spacing, 'function', 'comment formatter must export normalize_line_comment_spacing');
assert.strictEqual(typeof sqlCaseFormatter.format_case_blocks, 'function', 'case formatter must export format_case_blocks');
assert.strictEqual(typeof sqlSelectFormatter.align_as_in_select_blocks, 'function', 'select formatter must export align_as_in_select_blocks');
assert.strictEqual(typeof sqlConditionFormatter.align_condition_clauses, 'function', 'condition formatter must export align_condition_clauses');
assert.strictEqual(typeof sqlDdlFormatter.ddl, 'function', 'DDL formatter must export ddl');
assert.strictEqual(typeof sqlDdlFormatter.extractddl, 'function', 'DDL formatter must export extractddl');

console.log('module boundary tests passed');
```

Add script:

```json
"test:modules": "node tests/module-boundary.test.js"
```

Add `node tests/module-boundary.test.js` to `test:verify` after `node tests/formatter-api.test.js`.

- [ ] **Step 2: Move comment logic**

Move these functions from `vkbeautify.js` to `lib/sql-comment-formatter.js`:

```text
get_line_comment_loc
split_code_and_comment
split_case_code_and_comment
get_first_comment_loc
protect_standalone_comments
protect_inline_comments
restore_comments
reshape_comment
normalize_line_comment_spacing
order_comment
return_right_comment_loc
```

Export at least:

```js
exports.reshape_comment = reshape_comment;
exports.protect_standalone_comments = protect_standalone_comments;
exports.protect_inline_comments = protect_inline_comments;
exports.restore_comments = restore_comments;
exports.get_first_comment_loc = get_first_comment_loc;
exports.normalize_line_comment_spacing = normalize_line_comment_spacing;
exports.order_comment = order_comment;
exports.split_code_and_comment = split_code_and_comment;
exports.split_case_code_and_comment = split_case_code_and_comment;
```

Update `vkbeautify.js` and moved modules to require `sql-comment-formatter` instead of local functions.

- [ ] **Step 3: Move CASE logic**

Move these functions to `lib/sql-case-formatter.js`:

```text
split_line_before_end
split_line_at_token
get_case_tokens
format_case_branch_value
append_case_value_text
find_top_level_as_loc
is_case_branch_line
get_outer_as_code_width
get_alignment_width_for_code
get_case_balance_delta
find_outer_then_token
split_outer_else_text
apply_case_then_else_split
find_case_block_end
get_case_prefix_layout
parse_case_expression
build_case_formatted_text
split_case_boundary_lines
normalize_case_multiline_condition_lines
format_case_multiline_when_item
format_case_expression_line
format_case_blocks
find_root_case_start_loc
```

Export at least:

```js
exports.get_case_tokens = get_case_tokens;
exports.get_case_balance_delta = get_case_balance_delta;
exports.find_top_level_as_loc = find_top_level_as_loc;
exports.get_alignment_width_for_code = get_alignment_width_for_code;
exports.format_case_expression_line = format_case_expression_line;
exports.format_case_blocks = format_case_blocks;
exports.find_root_case_start_loc = find_root_case_start_loc;
```

Update dependencies so this module imports `sql-tokenizer`, `sql-structure`, and `sql-comment-formatter`.

- [ ] **Step 4: Move SELECT/list/AS/comma logic**

Move these functions to `lib/sql-select-formatter.js`:

```text
expand_tabs_for_width
is_select_item_start
collect_as_alignment_items
is_select_block_start
is_select_block_end
apply_as_alignment_on_items
align_as_in_select_blocks
select_wrap
special_wrap
except_subquery
convert_comma_loaction
```

Export at least:

```js
exports.expand_tabs_for_width = expand_tabs_for_width;
exports.align_as_in_select_blocks = align_as_in_select_blocks;
exports.special_wrap = special_wrap;
exports.except_subquery = except_subquery;
exports.convert_comma_loaction = convert_comma_loaction;
```

Replace calls to CASE helpers with imports from `sql-case-formatter`.

- [ ] **Step 5: Move condition logic**

Move these functions to `lib/sql-condition-formatter.js`:

```text
condition_wrap
get_condition_leading_tabs
shift_line_leading_indent
build_condition_line
align_condition_clauses
```

Export:

```js
exports.condition_wrap = condition_wrap;
exports.align_condition_clauses = align_condition_clauses;
```

Import `expand_tabs_for_width` from `sql-select-formatter` and CASE helpers from `sql-case-formatter`.

- [ ] **Step 6: Move DDL and Extract DDL logic**

Move these functions to `lib/sql-ddl-formatter.js`:

```text
modify_comma_to_speicific
repeat_space
find_matching_ddl_paren
split_ddl_items
find_ddl_comment_index
normalize_ddl_type
parse_ddl_column
format_ddl_columns
ddl
newsql
extractddl
convert_lowercase
```

If `newsql` still depends on main SQL formatting helpers, replace it with a call to `sql-formatter.format_sql(...)` after Task 7. Until Task 7, keep a local minimal path that preserves existing `extractddl` tests.

Export:

```js
exports.ddl = ddl;
exports.extractddl = extractddl;
```

- [ ] **Step 7: Create main formatter orchestrator**

Create `lib/sql-formatter.js` with public orchestration:

```js
var sqlShield = require('./sql-shield');
var sqlKeywords = require('./sql-keywords');
var sqlFormatPipeline = require('./sql-format-pipeline');
var sqlFormatContext = require('./sql-format-context');
var sqlCommentFormatter = require('./sql-comment-formatter');
var sqlCaseFormatter = require('./sql-case-formatter');
var sqlSelectFormatter = require('./sql-select-formatter');
var sqlConditionFormatter = require('./sql-condition-formatter');

function format_sql(text, options) {
    var config = options || {};
    var context = sqlFormatContext.create_context(text);
    var set_shield = config.protect_set_payloads(text, context);
    var token_shield = sqlShield.protect(set_shield.text, { line_comment: false });
    var step0 = token_shield.text;
    var comment_shield = sqlCommentFormatter.protect_standalone_comments(step0, context);
    step0 = sqlCommentFormatter.protect_inline_comments(comment_shield.text, context);

    var step7 = sqlFormatPipeline.run(step0, [
        sqlCommentFormatter.reshape_comment,
        config.replace_char,
        config.get_bracket,
        function(value) {
            return sqlSelectFormatter.except_subquery(value)
                .replace(/\{\.\*\.\*\}/ig, "(")
                .replace(/\{\*\.\*\.\}/ig, ")");
        },
        function(value) {
            return sqlSelectFormatter.special_wrap(value, config.as_loc_cnt, config.case_when_then_wrap_length, false);
        },
        config.bracket_deep,
        config.extra
    ]);

    var currentStep = step7;
    currentStep = sqlCommentFormatter.restore_comments(currentStep, context);
    currentStep = config.restore_set_payloads(currentStep, context);
    currentStep = sqlShield.preserve_standalone_block_lines(currentStep, token_shield.items);
    currentStep = sqlShield.restore(currentStep, token_shield.tokens, token_shield.items);
    currentStep = sqlCaseFormatter.format_case_blocks(currentStep, config.case_when_then_wrap_length);
    currentStep = sqlSelectFormatter.align_as_in_select_blocks(currentStep, config.as_loc_cnt);
    currentStep = sqlKeywords.apply_keyword_case(currentStep, config.uppercase !== false);

    if (config.comma_location === true) {
        currentStep = sqlSelectFormatter.convert_comma_loaction(currentStep);
    }

    currentStep = sqlConditionFormatter.align_condition_clauses(currentStep);
    currentStep = sqlCommentFormatter.order_comment(currentStep, config.as_loc_cnt);

    if (config.bracket_char === true) {
        currentStep = currentStep.replace(/\t/ig, "    ");
    }

    return sqlCommentFormatter.normalize_line_comment_spacing(currentStep);
}

exports.format_sql = format_sql;
```

During implementation, if exact helper dependencies differ, keep this public `format_sql(text, options)` interface and update tests accordingly.

- [ ] **Step 8: Shrink `vkbeautify.js`**

After moved modules are working, reduce `vkbeautify.js` to public wrapper plus any small legacy helpers that have not yet been moved:

```js
var sqlFormatter = require('./lib/sql-formatter');
var sqlDdlFormatter = require('./lib/sql-ddl-formatter');

function vkbeautify() {}

vkbeautify.prototype.sql = function(text, uppercase, comma_location, bracket_char, as_loc_cnt, case_when_then_wrap_length, advanced_options) {
    return sqlFormatter.format_sql(text, {
        uppercase: uppercase,
        comma_location: comma_location,
        bracket_char: bracket_char,
        as_loc_cnt: as_loc_cnt,
        case_when_then_wrap_length: case_when_then_wrap_length,
        dialect: advanced_options && advanced_options.dialect
    });
};

vkbeautify.prototype.sqlddl = function(text) {
    return sqlDdlFormatter.ddl(text);
};

vkbeautify.prototype.extractddl = function(text) {
    return sqlDdlFormatter.extractddl(text);
};

module.exports = new vkbeautify();
```

The final `vkbeautify.js` should be under 150 lines. If it is longer, finish moving remaining formatter logic into `lib/`.

- [ ] **Step 9: Run module and full tests**

Run:

```bash
npm run test:modules
npm run test:api
npm run test:verify
```

Expected: all pass. If a module extraction changes Hive output, fix dependency wiring or moved helper state first.

## Task 4: Dialect-Aware Tokenizer And Operator Handling

**Files:**
- Create: `lib/sql-dialect.js`
- Modify: `lib/sql-tokenizer.js`
- Modify: `lib/sql-shield.js`
- Modify: `lib/sql-formatter.js`
- Modify: `lib/sql-select-formatter.js`
- Test: `tests/dialect-boundary.test.js`

- [ ] **Step 1: Add dialect capability module**

Create `lib/sql-dialect.js`:

```js
function normalize_dialect(value) {
    var dialect = String(value || 'generic').toLowerCase();
    if (dialect == 'hive' || dialect == 'generic' || dialect == 'postgres' || dialect == 'mysql') {
        return dialect;
    }
    return 'generic';
}

function get_capabilities(value) {
    var dialect = normalize_dialect(value);
    return {
        dialect: dialect,
        dollarQuotedStrings: dialect == 'generic' || dialect == 'postgres',
        hashLineComments: dialect == 'generic' || dialect == 'mysql',
        postgresJsonOperators: dialect == 'generic' || dialect == 'postgres'
    };
}

exports.normalize_dialect = normalize_dialect;
exports.get_capabilities = get_capabilities;
```

- [ ] **Step 2: Extend tokenizer options**

Modify `lib/sql-tokenizer.js` so `tokenize(text, options)` accepts capabilities. Add dollar-quoted string support:

```js
function read_dollar_quoted_string(text, start) {
    var tag_match = text.slice(start).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
    if (!tag_match) {
        return start;
    }
    var tag = tag_match[0];
    var end = text.indexOf(tag, start + tag.length);
    return end < 0 ? text.length : end + tag.length;
}
```

Inside `tokenize`, before word handling:

```js
if (options && options.dollarQuotedStrings && ch == '$') {
    var dollar_end = read_dollar_quoted_string(text, i);
    if (dollar_end > i) {
        i = dollar_end;
        push_token(tokens, 'string_literal', text.slice(start, i), start, i);
        continue;
    }
}
```

Add hash comment support:

```js
if (options && options.hashLineComments && ch == '#') {
    i += 1;
    while (i < text.length && text[i] != '\n' && text[i] != '\r') {
        i += 1;
    }
    push_token(tokens, 'line_comment', text.slice(start, i), start, i);
    continue;
}
```

- [ ] **Step 3: Pass dialect capabilities through shield and formatter**

Update `sql-shield.protect(text, options)` to pass tokenizer options through:

```js
var tokens = tokenizer.tokenize(source, options && options.tokenizerOptions);
```

In `sql-formatter.format_sql`, load capabilities:

```js
var sqlDialect = require('./sql-dialect');
var dialect = sqlDialect.get_capabilities(config.dialect);
```

Pass tokenizer options to shield:

```js
var token_shield = sqlShield.protect(set_shield.text, {
    line_comment: false,
    tokenizerOptions: dialect
});
```

Where modules tokenize restored text after shield, use default generic-safe behavior unless the module receives dialect. For critical paths that split comments, pass `dialect` into comment formatter helpers.

- [ ] **Step 4: Preserve JSON arrow operators**

In the module containing `replace_char`, ensure after generic comparison spacing:

```js
.replace(/-\s*>\s*>/ig, "->>")
.replace(/-\s*>/ig, "->")
```

If `replace_char` stays in `sql-formatter.js`, add this there. If moved to a new `sql-legacy-passes.js`, add it there.

- [ ] **Step 5: Run dialect and full tests**

Run:

```bash
npm run test:dialect
npm run test:token
npm run test:verify
```

Expected: all pass.

## Task 5: Configuration Namespace, Validation, And Dialect Option

**Files:**
- Modify: `package.json`
- Modify: `extension.js`
- Modify: `lib/sql-render-options.js`
- Modify: `tests/config-options.test.js`

- [ ] **Step 1: Add `sqlBeautify.*` configuration namespace**

Add new properties in `package.json`:

```json
"sqlBeautify.keywordCase": {
    "scope": "resource",
    "type": "string",
    "enum": ["upper", "lower"],
    "default": "upper",
    "description": "Keyword case for formatted SQL. /格式化后的 SQL 关键词大小写"
},
"sqlBeautify.commaStyle": {
    "scope": "resource",
    "type": "string",
    "enum": ["leading", "trailing"],
    "default": "leading",
    "description": "Comma placement style. /逗号位置风格"
},
"sqlBeautify.indentStyle": {
    "scope": "resource",
    "type": "string",
    "enum": ["tab", "space"],
    "default": "tab",
    "description": "Indentation style for formatted SQL. /格式化缩进风格"
},
"sqlBeautify.maxAlignWidth": {
    "scope": "resource",
    "type": "number",
    "default": 150,
    "minimum": 1,
    "maximum": 500,
    "description": "Maximum code width for AS and trailing comment alignment. /AS 和行尾注释对齐的最大代码宽度"
},
"sqlBeautify.caseWhenThenWrapLength": {
    "scope": "resource",
    "type": "number",
    "default": 50,
    "minimum": 1,
    "maximum": 300,
    "description": "Wrap threshold for CASE WHEN THEN and ELSE values. /CASE WHEN 中 THEN 和 ELSE 值的换行阈值"
},
"sqlBeautify.dialect": {
    "scope": "resource",
    "type": "string",
    "enum": ["generic", "hive", "postgres", "mysql"],
    "default": "generic",
    "description": "Best-effort SQL dialect boundary handling. Hive remains the primary formatting target. /SQL 方言边界处理；Hive 仍是主要格式化目标"
}
```

Keep existing `extension.*` settings as legacy fallback.

- [ ] **Step 2: Normalize config precedence**

In `extension.js`, read:

```js
var scopedConfig = vscode.workspace.getConfiguration('sqlBeautify');
var legacyConfig = vscode.workspace.getConfiguration('extension');
```

Pass raw values and explicit flags into `sqlRenderOptions.normalize(...)`. New `sqlBeautify.*` explicit values win over legacy semantic `extension.keywordCase` etc.; legacy semantic values win over old boolean settings; old boolean settings remain fallback.

- [ ] **Step 3: Clamp numeric options**

In `lib/sql-render-options.js`, implement:

```js
function normalize_number(value, fallback, min, max) {
    var parsed = parseInt(value, 10);
    if (isNaN(parsed)) {
        parsed = fallback;
    }
    if (parsed < min) {
        return min;
    }
    if (parsed > max) {
        return max;
    }
    return parsed;
}
```

Use it for `as_loc_cnt` and `case_when_then_wrap_length`.

- [ ] **Step 4: Stop treating default language value as explicit**

In `hasConfiguredValue`, do not count `defaultLanguageValue` as user explicit configuration. Keep:

```js
globalValue
workspaceValue
workspaceFolderValue
globalLanguageValue
workspaceLanguageValue
workspaceFolderLanguageValue
```

- [ ] **Step 5: Add config tests**

Update `tests/config-options.test.js` to assert:

```js
[
    'sqlBeautify.keywordCase',
    'sqlBeautify.commaStyle',
    'sqlBeautify.indentStyle',
    'sqlBeautify.maxAlignWidth',
    'sqlBeautify.caseWhenThenWrapLength',
    'sqlBeautify.dialect'
].forEach(assert_property);
```

Add normalization assertions covering:

```text
sqlBeautify.* explicit overrides extension.keywordCase / extension.commaStyle / extension.indentStyle / extension.maxAlignWidth
extension.keywordCase explicit overrides extension.uppercase
old extension.uppercase fallback still works
maxAlignWidth clamps to 1..500
caseWhenThenWrapLength clamps to 1..300
dialect defaults to generic
```

- [ ] **Step 6: Run config and full tests**

Run:

```bash
npm run test:config
npm run test:verify
```

Expected: all pass.

## Task 6: VS Code Command, Formatter, And Selection Hardening

**Files:**
- Modify: `extension.js`
- Modify: `package.json`
- Modify: `tests/extension-contribution.test.js`

- [ ] **Step 1: Make command strategy explicit**

Decide command IDs in `package.json`:

- Keep old command IDs as aliases if renaming:
  - `extension.beautifySql`
  - `extension.beautifySqlddl`
  - `extension.extractDdl`
- Add clearer command IDs if desired:
  - `sqlBeautify.formatSql`
  - `sqlBeautify.formatHiveDdl`
  - `sqlBeautify.extractHiveDdl`

If new IDs are added, both old and new IDs must call the same implementation. Update activationEvents and README.

- [ ] **Step 2: Reject overlapping selections**

In `replaceTargetRanges`, sort ranges by start and reject overlaps:

```js
ranges.sort(function(a, b) {
    if (a.start.isBefore(b.start)) {
        return -1;
    }
    if (b.start.isBefore(a.start)) {
        return 1;
    }
    return 0;
});

for (var i = 1; i < ranges.length; i++) {
    if (ranges[i - 1].end.isAfter(ranges[i].start)) {
        vscode.window.showErrorMessage('SQL Beautify failed: overlapping selections are not supported.');
        return;
    }
}
```

- [ ] **Step 3: Report edit failures**

Handle `editor.edit(...)` promise:

```js
editor.edit(function(builder) {
    for (var i = 0; i < ranges.length; i++) {
        var range = ranges[i];
        var text = editor.document.getText(range).toString();
        var formatted = tryFormat(formatter, text);
        if (formatted !== null) {
            builder.replace(range, formatted);
        }
    }
}).then(function(success) {
    if (!success) {
        vscode.window.showErrorMessage('SQL Beautify failed: VS Code rejected the edit.');
    }
});
```

- [ ] **Step 4: Add source tests**

In `tests/extension-contribution.test.js`, assert the source includes:

```js
overlapping selections are not supported
VS Code rejected the edit
registerDocumentFormattingEditProvider
registerDocumentRangeFormattingEditProvider
sqlBeautify
```

- [ ] **Step 5: Run extension and full tests**

Run:

```bash
npm run test:extension
npm run test:verify
```

Expected: all pass.

## Task 7: DDL And Extract DDL Isolation

**Files:**
- Modify: `lib/sql-ddl-formatter.js`
- Modify: `tests/ddl-regression.test.js`
- Modify: `README.md`

- [ ] **Step 1: Add DDL risk tests**

Add tests to `tests/ddl-regression.test.js`:

```js
run_contains(
    'ddl keeps table suffix clauses outside the column list',
    "create table t (id bigint comment 'id') partitioned by (ds string) stored as parquet",
    [
        "PARTITIONED BY",
        "STORED AS PARQUET"
    ]
);

run_contains(
    'ddl keeps comment text with SQL-looking words',
    "create table t (name string comment 'from,where,case when then')",
    [
        "COMMENT 'from,where,case when then'"
    ]
);

run_contains(
    'extract ddl remains experimental but produces column comments',
    "insert overwrite table target select a as user_id -- 用户ID\n,b as amount -- 金额\nfrom source",
    [
        "user_id",
        "COMMENT",
        "用户ID"
    ]
);
```

- [ ] **Step 2: Keep DDL implementation bounded but explicit**

In `lib/sql-ddl-formatter.js`, keep `ddl()` limited to Hive-style column list formatting. Do not claim support for constraints/generated columns/full parser behavior. Make parsing functions pure and exported only if tests need them.

- [ ] **Step 3: Make Extract DDL call the new formatter API**

Replace legacy `newsql` dependency with a direct call into `sql-formatter.format_sql(...)` if needed. Avoid reintroducing `NEEDReplace` or global quote state.

- [ ] **Step 4: Run DDL and full tests**

Run:

```bash
npm run test:ddl
npm run test:verify
```

Expected: all pass.

## Task 8: Tooling, Dev Dependencies, CI, And Package Hygiene

**Files:**
- Modify: `package.json`
- Create or modify: `package-lock.json`
- Modify: `.github/workflows/build-vsix.yml`
- Modify: `.vscodeignore`
- Modify: `tests/extension-contribution.test.js`

- [ ] **Step 1: Replace deprecated VS Code dev dependency**

Update `package.json` devDependencies:

```json
"devDependencies": {
    "@types/vscode": "^1.90.0",
    "@vscode/vsce": "^3.2.2"
}
```

Remove:

```json
"vscode": "^0.11.0"
```

Remove the deprecated postinstall script:

```json
"postinstall": "node ./node_modules/vscode/bin/install"
```

- [ ] **Step 2: Add package script**

Add:

```json
"package:vsix": "vsce package --out vscode-sql-beautify-v${npm_package_version}.vsix"
```

- [ ] **Step 3: Generate or update lockfile**

Run with proxy:

```bash
export ALL_PROXY=socks5://127.0.0.1:7897
npm install --package-lock-only
```

Expected: `package-lock.json` exists or is updated. If the environment blocks network, request the required sandbox escalation as part of execution and rerun the same command with proxy.

- [ ] **Step 4: Modernize CI**

Update `.github/workflows/build-vsix.yml`:

```yaml
name: Build VSIX

on:
  workflow_dispatch:
  pull_request:
  push:
    branches:
      - main

permissions:
  contents: write

concurrency:
  group: build-vsix-${{ github.ref }}
  cancel-in-progress: false

jobs:
  build-vsix:
    name: Build VSIX
    runs-on: ubuntu-latest

    steps:
      - name: Checkout
        uses: actions/checkout@v5

      - name: Setup Node.js
        uses: actions/setup-node@v5
        with:
          node-version: 24
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Run regression tests
        run: npm run test:verify

      - name: Package VSIX
        if: github.event_name == 'workflow_dispatch'
        run: npm run package:vsix

      - name: Upload VSIX artifact
        if: github.event_name == 'workflow_dispatch'
        uses: actions/upload-artifact@v6
        with:
          name: vscode-sql-beautify-vsix
          path: "*.vsix"
          if-no-files-found: error

      - name: Read package version
        if: github.event_name == 'workflow_dispatch'
        id: package
        run: |
          version=$(node -p "require('./package.json').version")
          echo "version=${version}" >> "$GITHUB_OUTPUT"

      - name: Create or update GitHub Release
        if: github.event_name == 'workflow_dispatch'
        env:
          GH_TOKEN: ${{ github.token }}
          VERSION: ${{ steps.package.outputs.version }}
        run: |
          tag="v${VERSION}"
          if gh release view "${tag}" > /dev/null 2>&1; then
            gh release upload "${tag}" ./*.vsix --clobber
          else
            gh release create "${tag}" ./*.vsix --title "${tag}" --notes "Manual VSIX build for ${tag}."
          fi
```

- [ ] **Step 5: Keep package clean**

Update `.vscodeignore` to exclude:

```text
docs/**
tests/**
*.vsix
*.vsixmanifest
node_modules/**
.DS_Store
```

- [ ] **Step 6: Run tests**

Run:

```bash
npm run test:verify
```

Expected: pass.

## Task 9: Documentation And User Experience Boundaries

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `package.json`
- Modify: `tests/extension-contribution.test.js`

- [ ] **Step 1: Update README capability boundaries**

README must explicitly state:

```markdown
SQL Beautify is Hive SQL first. Generic SQL, PostgreSQL, and MySQL handling are best-effort boundary protections, not full dialect formatters.
```

Add a table for:

```markdown
| Area | Status |
| --- | --- |
| Hive SQL SELECT / JOIN / WHERE / CASE / comments | Primary support |
| Hive DDL formatting | Experimental |
| Extract DDL | Experimental |
| PostgreSQL dollar quotes and JSON arrows | Boundary protection only |
| MySQL # comments | Boundary protection only |
| Full SQL parser behavior | Not supported |
```

- [ ] **Step 2: Document new settings**

README settings table must include `sqlBeautify.*`, legacy `extension.*`, and precedence:

```text
sqlBeautify.* explicit > extension semantic explicit > extension legacy fallback > package defaults
```

- [ ] **Step 3: Update changelog**

Add an unreleased section:

```markdown
### Unreleased
* Refactored the formatter core out of `vkbeautify.js` into focused CommonJS modules.
* Fixed internal placeholder collisions that could corrupt user SQL containing marker-like text.
* Added dialect boundary protections for PostgreSQL dollar quotes, PostgreSQL JSON arrows, and MySQL hash comments.
* Added `sqlBeautify.*` settings while preserving legacy `extension.*` fallback.
* Hardened VS Code selection formatting and edit failure reporting.
* Modernized test, CI, and VSIX packaging tooling.
```

- [ ] **Step 4: Verify docs references**

Run:

```bash
npm run test:extension
npm run test:config
npm run test:verify
```

Expected: all pass.

## Task 10: Final Verification And Refactor Quality Gates

**Files:**
- No new files unless fixing failures.

- [ ] **Step 1: Run full test suite**

Run:

```bash
npm run test:verify
```

Expected: exit 0 and include success messages from all test files.

- [ ] **Step 2: Run targeted smoke probes**

Run:

```bash
node -e 'const vk=require("./vkbeautify"); const cases=["select NEEDReplace as c from t","select a --{LC0}\\nfrom t","select $$from where case when then$$ as s from t where a=1","select data->>\\x27name\\x27 as name from t"]; for (const sql of cases) { const out=vk.sql(sql,true,false,true,150,80,{dialect:"generic"}); if (/undefined|->  >/.test(out)) { throw new Error("bad output for "+sql+"\\n"+out); } } console.log("smoke probes passed");'
```

Expected:

```text
smoke probes passed
```

- [ ] **Step 3: Enforce `vkbeautify.js` size gate**

Run:

```bash
node -e 'const fs=require("fs"); const lines=fs.readFileSync("vkbeautify.js","utf8").split(/\r?\n/).length; if (lines > 150) { throw new Error("vkbeautify.js still too large: "+lines+" lines"); } console.log("vkbeautify.js lines:", lines);'
```

Expected: line count at or below 150.

- [ ] **Step 4: Inspect module sizes**

Run:

```bash
wc -l vkbeautify.js lib/*.js tests/*.js
```

Expected: no new formatter module should become an unreviewable replacement monolith. If any new `lib/sql-*.js` file exceeds 800 lines, split it by responsibility before finishing.

- [ ] **Step 5: Inspect changed files**

Run:

```bash
git status --short
git diff --stat
```

Expected: changes are limited to code, tests, docs, config, CI, and lockfile needed by this plan. No `.vsix`, `.DS_Store`, or `node_modules` files are included.

## Self-Review Checklist

- [ ] Placeholder collision tests fail before the fix and pass after context-based placeholders.
- [ ] Dialect boundary tests fail before tokenizer/operator hardening and pass after implementation.
- [ ] `vkbeautify.js` is a public wrapper under 150 lines.
- [ ] CASE, SELECT, condition, comments, DDL, and orchestration live in separate modules.
- [ ] Existing Hive regression tests still pass.
- [ ] New `sqlBeautify.*` config works and legacy `extension.*` fallback remains tested.
- [ ] VS Code overlapping selections and edit failure paths are handled.
- [ ] DDL/Extract DDL remains explicitly experimental and tested.
- [ ] CI uses `npm ci`, local `@vscode/vsce`, and only creates Release artifacts on manual dispatch.
- [ ] README and CHANGELOG describe the new architecture, settings, and dialect boundary honestly.
- [ ] No commit, push, or VSIX release was created unless the user explicitly requested it in the execution session.

## Handoff Prompt

Use this prompt in a new Codex conversation:

```text
请在 /Users/yingirving/Documents/sql-beautify 中执行 docs/superpowers/plans/2026-05-16-sql-beautify-production-hardening.md。

要求：
1. 使用计划文件要求的 Superpowers 执行流程。
2. 这是新分支，我明确授权大规模重构、移动/删除任务范围内代码、拆分 vkbeautify.js、修改 lib/、tests/、extension.js、package.json、package-lock.json、README.md、CHANGELOG.md、.vscodeignore 和 .github/workflows/build-vsix.yml。
3. 我明确授权引入开发依赖和更新 lockfile；需要网络时先执行 export ALL_PROXY=socks5://127.0.0.1:7897，并按 Codex 安全流程处理必要的 sandbox escalation。
4. 按任务顺序推进，先写失败测试，再实现，再运行对应测试；遇到测试失败要基于证据自行定位并修复，不要降低断言。
5. 不要创建 git commit，不要推送，不要打包 VSIX，不要创建 GitHub Release，除非我在当前新对话里明确要求。
6. 完成后汇报修改文件、验证命令和结果、vkbeautify.js 最终行数、剩余风险。
```
