# SQL Beautify Comprehensive Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 系统性修复本次严格审视发现的所有真实缺陷、语义冲突、维护性风险、性能风险和发布流程风险，把项目推进到更适合长期迭代的状态。

**Architecture:** 继续坚持 `lib/core/`、`lib/adapters/`、`lib/experimental/ddl/` 三层边界，但本计划要求把边界落实到真实实现、测试和发布流程中。核心方向是用 tokenizer / structured model 替换重复字符扫描，收紧 unsupported policy 的真实语义，修正 experimental DDL / extractddl 的误导性输出，并把 CI / release / VS Code adapter 行为变成可验证契约。

**Tech Stack:** VS Code extension、CommonJS、Node.js、本地 CLI regression tests、项目内 SQL formatter core、experimental Hive DDL helper、GitHub Actions、VSIX packaging。

---

## 0. 执行纪律

本计划是实施计划，不是风险清单。执行时不应把任务降级成零散小补丁。

- [ ] 每个任务先写失败测试或结构性 guard，再改实现。
- [ ] 每个任务完成后运行该任务列出的 targeted tests。
- [ ] 所有实现任务完成后运行完整验证：`npm run test:verify` 和 `npm run package:vsix`。
- [ ] 不在实现阶段自动创建 git commit。按项目规则，代码验证完成后先交给用户测试确认；用户确认后再单独提交。
- [ ] 对 root config、CI、发布 workflow、配置面、共享 tokenizer primitive 的改动，在执行前确认当前对话已获得用户授权；本计划本身已经说明这些改动是必要范围。
- [ ] 不恢复 `extension.*` 配置兼容，不把新逻辑塞回 root `lib/*.js` shim，不新增扫描注释 / 字符串 / 反引号内容的全局正则补丁。

---

## 1. 已确认问题与计划覆盖关系

| 问题 | 证据 | 实施任务 |
| --- | --- | --- |
| `extractddl` 只提取最后一个顶层 `SELECT`，`UNION` 输出误导性 schema | `select ... union all select ...` 实测只输出第二支字段 | Task 2 |
| `sqlddl` 的字段拆分不识别反引号列名内逗号 | ``create table t (`a,b` string...)`` 实测输出 `b\`` 伪列 | Task 1 |
| `extractddl` 注释文本未转义双引号，生成无效 DDL | `-- user "display" name` 实测生成 `COMMENT "user "display" name"` | Task 2 |
| 完整 CTE 选区被 range formatter 拒绝 | `WITH ... SELECT ...` 从第 0 字节整段选择返回 unsafe boundary | Task 3 |
| `unsupportedSyntaxPolicy` 名称大于实际能力 | 当前只处理 `context.unsupportedSegments`，`QUALIFY` 等不触发 `bail_out` | Task 4 |
| VS Code resource scoped config 读取不完整 | `getConfiguration('sqlBeautify')` 未传 `document.uri` | Task 5 |
| formatter pipeline 顺序耦合高，多个后处理互相修补 | `format_sql_detailed()` 串联 shield / split / repair / align / restore | Task 6 |
| 大 SQL 文件格式化性能存在真实风险 | 112KB / 2000 条简单 SQL 本地探针约 3950ms | Task 7 |
| release workflow 可从非 main 手动发布，且不校验 Release target SHA | `.github/workflows/build-vsix.yml` workflow_dispatch 无分支 guard | Task 8 |
| PR / push 不做 VSIX packaging smoke | workflow 只在手动触发时 package | Task 8 |
| DDL / extractddl experimental 能力边界需继续可验证 | 当前 README 有提示，但测试与 support matrix 未覆盖上述新增风险 | Task 9 |

---

## 2. 文件职责图

### 2.1 Core

- Modify: `lib/core/sql-token-primitives.js`
  - 新增可复用的 top-level split helper，支持 tokenizer token、paren depth、angle bracket depth、quoted identifier、string literal、line comment / block comment 边界。
- Modify/Create: `lib/core/sql-syntax-risk-detector.js`
  - 识别 known-but-low-confidence syntax，输出 `unsupportedSegments`，供 `unsupportedSyntaxPolicy` 使用。
- Modify: `lib/core/sql-unsupported-policy.js`
  - 保留 policy normalize / enforce，但输入从单一 opaque clause 扩展为 risk detector + opaque protection 共同产物。
- Modify: `lib/core/sql-formatter.js`
  - 接入 risk detector；把 pipeline 中高风险 pass 的输入输出契约显式化。
- Modify/Create: `lib/core/sql-format-model.js`
  - 引入轻量 line model / token model 聚合层，先服务 comment / condition / layout 的高重复 tokenization 路径。
- Modify: `lib/core/sql-comment-formatter.js`
  - 逐步改为消费 `sql-format-model` 提供的行级 code/comment/case/paren 信息。
- Modify: `lib/core/sql-condition-formatter.js`
  - 逐步改为消费统一 line model，减少重复 tokenizer 调用。
- Modify: `lib/core/sql-layout-formatter.js`
  - 逐步改为消费统一 line model，减少重复 bracket delta 计算。
- Modify: `lib/core/sql-clause-registry.js`
  - 增加 CTE/range boundary 所需 metadata；必要时增加 unsupported/risk metadata。
- Modify: `lib/core/sql-dialect.js`
  - 暴露 risk detector 所需 dialect capability。

### 2.2 Adapter

- Modify: `lib/adapters/range-format-policy.js`
  - 允许完整 `WITH` / `WITH RECURSIVE` CTE 作为安全选区起点；继续拒绝不完整结构。
- Modify: `lib/adapters/vscode-config.js`
  - 使用 document scope 读取配置：`getConfiguration('sqlBeautify', document && document.uri)`。
- Modify: `lib/adapters/vscode-extension.js`
  - 只在必要处调整调用；保持命令和 provider 行为兼容。
- Modify: `lib/adapters/formatter-diagnostics.js`
  - 确保新增 risk diagnostics 在 `warn` 模式下可见。

### 2.3 Experimental DDL

- Modify: `lib/experimental/ddl/sql-ddl-format.js`
  - 删除 DDL 私有顶层逗号扫描中的 blind spot，复用 `sql-token-primitives`。
- Modify: `lib/experimental/ddl/sql-extract-ddl.js`
  - 支持 top-level query branches；处理 `UNION` / `UNION ALL` 一致性；转义 comment literal；避免无效或误导输出。
- Modify: `lib/experimental/ddl/sql-ddl-shared.js`
  - 增加 DDL literal render helper，例如 `render_hive_comment_literal(text)`。

### 2.4 Tests

- Modify: `tests/ddl-regression.test.js`
- Modify: `tests/extractddl-safety.test.js`
- Modify: `tests/unsupported-safety.test.js`
- Modify: `tests/extension-contribution.test.js`
- Modify: `tests/config-options.test.js`
- Modify: `tests/generated-support-matrix.test.js`
- Modify: `tests/module-boundary.test.js`
- Modify/Create: `tests/range-format-policy.test.js`
- Modify/Create: `tests/performance-smoke.test.js`
- Modify: `package.json`

### 2.5 Docs / CI

- Modify: `.github/workflows/build-vsix.yml`
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/technical/sql-formatter-architecture.md`
- Modify: `docs/technical/sql-support-matrix.md`
- Modify: `scripts/generate-support-matrix.js`

---

## Task 0: Freeze Baseline And Add Dedicated Test Entrypoints

**Files:**
- Modify: `package.json`
- Create: `tests/range-format-policy.test.js`
- Create: `tests/performance-smoke.test.js`

- [ ] **Step 1: Run baseline verification**

Run:

```bash
npm run test:verify
```

Expected:

```text
unsupported safety tests passed
```

- [ ] **Step 2: Add explicit test scripts**

In `package.json`, add these scripts near the existing test scripts:

```json
"test:range": "node tests/range-format-policy.test.js",
"test:performance": "node tests/performance-smoke.test.js"
```

Also add both commands to `test:verify` after `test:extension` and before DDL tests:

```json
"node tests/range-format-policy.test.js && node tests/performance-smoke.test.js"
```

- [ ] **Step 3: Create range policy test skeleton with real assertions**

Create `tests/range-format-policy.test.js`:

```js
var assert = require('assert');
var rangePolicy = require('../lib/adapters/range-format-policy');
var sqlDialect = require('../lib/core/sql-dialect');

function create_position(offset) {
    return { offset: offset };
}

function create_range(start, end) {
    return {
        start: create_position(start),
        end: create_position(end)
    };
}

function create_document(text) {
    return {
        getText: function(range) {
            if (!range) {
                return text;
            }
            return text.slice(range.start.offset, range.end.offset);
        }
    };
}

function analyze(text, start, end, dialect) {
    return rangePolicy.analyze_range(
        create_document(text),
        create_range(start, end),
        sqlDialect.get_capabilities(dialect || 'generic')
    );
}

var cte = 'with s as (select a from t)\nselect a from s\n';
assert.strictEqual(
    analyze(cte, 0, cte.length, 'generic').safe,
    true,
    'complete CTE selection must be accepted as a safe range'
);

assert.strictEqual(
    analyze('select a,\n b\nfrom t', 1, 11, 'generic').safe,
    false,
    'partial non-whole-line selection must remain unsafe'
);

console.log('range format policy tests passed');
```

- [ ] **Step 4: Create performance smoke test with a generous threshold**

Create `tests/performance-smoke.test.js`:

```js
var assert = require('assert');
var sqlFormatter = require('../lib/sql-formatter');

var unit = 'select a as col_a, b as col_b from t where x=1 and y=2;\n';
var sql = new Array(1001).join(unit);
var start = Date.now();

var output = sqlFormatter.format_sql(sql, {
    keywordCase: 'upper',
    commaStyle: 'leading',
    indentStyle: 'space',
    maxAlignWidth: 150,
    caseWhenThenWrapLength: 80,
    dialect: 'generic',
    unsupportedSyntaxPolicy: 'preserve'
});

var elapsed = Date.now() - start;

assert.ok(output.indexOf('SELECT') >= 0, 'performance smoke must produce formatted SQL');
assert.ok(
    elapsed < 5000,
    'formatting 1000 simple statements should stay under 5000ms on CI-class hardware; actual=' + elapsed + 'ms'
);

console.log('performance smoke tests passed in ' + elapsed + 'ms');
```

- [ ] **Step 5: Run new tests and confirm current failures**

Run:

```bash
node tests/range-format-policy.test.js
node tests/performance-smoke.test.js
```

Expected:

```text
range-format-policy test fails before Task 3 because CTE is currently rejected
performance smoke may pass or fail depending on host speed; record the elapsed time in the implementation notes
```

---

## Task 1: Replace DDL Private Splitter With Token-Aware Top-Level Split

**Files:**
- Modify: `lib/core/sql-token-primitives.js`
- Modify: `lib/experimental/ddl/sql-ddl-format.js`
- Modify: `tests/ddl-regression.test.js`
- Modify: `tests/module-boundary.test.js`

- [ ] **Step 1: Add failing DDL tests**

Append to `tests/ddl-regression.test.js`:

```js
run_contains(
    'ddl keeps comma inside backtick column name',
    "create table t (`a,b` string comment 'x', c int comment 'y')",
    [
        '`a,b`',
        "STRING COMMENT 'x'",
        'c',
        "INT    COMMENT 'y'"
    ]
);

run_contains(
    'ddl keeps nested complex type with backtick field names',
    "create table t (info struct<`a,b`:string,c:int> comment '结构')",
    [
        'info',
        'STRUCT<`a,b`:STRING,c:INT>',
        "COMMENT '结构'"
    ]
);
```

Run:

```bash
node tests/ddl-regression.test.js
```

Expected:

```text
FAIL before implementation because split_ddl_items splits inside `a,b`
```

- [ ] **Step 2: Extend token primitive with angle-aware top-level split**

In `lib/core/sql-token-primitives.js`, replace `split_top_level_items` with an options-aware implementation that preserves existing default behavior:

```js
function split_top_level_items(text, tokenizerOptions, splitOptions) {
    var source = String(text || '');
    var tokens = tokenize(source, tokenizerOptions);
    var options = splitOptions || {};
    var items = [];
    var parenDepth = 0;
    var angleDepth = 0;
    var start = 0;

    for (var i = 0; i < tokens.length; i++) {
        if (tokens[i].type == 'punctuation' && tokens[i].value == '(') {
            parenDepth += 1;
            continue;
        }

        if (tokens[i].type == 'punctuation' && tokens[i].value == ')' && parenDepth > 0) {
            parenDepth -= 1;
            continue;
        }

        if (options.trackAngleBrackets && tokens[i].type == 'operator' && tokens[i].value == '<') {
            angleDepth += 1;
            continue;
        }

        if (options.trackAngleBrackets && tokens[i].type == 'operator' && tokens[i].value == '>' && angleDepth > 0) {
            angleDepth -= 1;
            continue;
        }

        if (tokens[i].type == 'punctuation'
            && tokens[i].value == ','
            && parenDepth == 0
            && angleDepth == 0) {
            items.push(source.slice(start, tokens[i].start));
            start = tokens[i].end;
        }
    }

    items.push(source.slice(start));
    return items;
}
```

- [ ] **Step 3: Make DDL formatter use the shared primitive**

In `lib/experimental/ddl/sql-ddl-format.js`:

```js
var sqlTokenPrimitives = require('../../core/sql-token-primitives');
```

Replace `split_ddl_items` body with:

```js
function split_ddl_items(text) {
    return sqlTokenPrimitives.split_top_level_items(text, null, {
        trackAngleBrackets: true
    });
}
```

Keep `find_matching_ddl_paren` for now because it locates the column-list body, but do not add new scanning logic there.

- [ ] **Step 4: Add module-boundary guard against new DDL splitters**

In `tests/module-boundary.test.js`, add a source assertion for `lib/experimental/ddl/sql-ddl-format.js`:

```js
var ddlFormatSource = read_source('lib/experimental/ddl/sql-ddl-format.js');
assert.ok(
    /split_top_level_items/.test(ddlFormatSource),
    'experimental DDL formatter must reuse token-aware top-level splitter'
);
assert.strictEqual(
    /function\s+split_ddl_items[\s\S]+quote\s*=/.test(ddlFormatSource),
    false,
    'experimental DDL formatter must not maintain a private quote-scanning splitter'
);
```

- [ ] **Step 5: Verify**

Run:

```bash
node tests/ddl-regression.test.js
node tests/module-boundary.test.js
```

Expected:

```text
ddl regression tests passed
module boundary tests passed
```

---

## Task 2: Make Extract DDL Branch-Aware And DDL-Literal Safe

**Files:**
- Modify: `lib/experimental/ddl/sql-ddl-shared.js`
- Modify: `lib/experimental/ddl/sql-extract-ddl.js`
- Modify: `tests/extractddl-safety.test.js`
- Modify: `tests/ddl-regression.test.js`

- [ ] **Step 1: Add failing extractddl tests**

Append to `tests/extractddl-safety.test.js`:

```js
var unionConsistent = vkbeautify.extractddl([
    'select a as id -- ID from first branch',
    'from t1',
    'union all',
    'select b as id -- ID from second branch',
    'from t2'
].join('\n'));
assert_contains(
    'extractddl supports consistent UNION branches',
    unionConsistent,
    ['id', 'COMMENT "ID from first branch"']
);

var unionMismatch = vkbeautify.extractddl([
    'select a as first_id -- first',
    'from t1',
    'union all',
    'select b as second_id -- second',
    'from t2'
].join('\n'));
assert.strictEqual(
    unionMismatch.trim(),
    '',
    'extractddl must reject inconsistent UNION branch schemas instead of returning the final branch'
);

var escapedComment = vkbeautify.extractddl('select a as display_name -- user "display" name\nfrom t');
assert_contains(
    'extractddl escapes double quotes inside generated comment literal',
    escapedComment,
    ['display_name BIGINT COMMENT "user \\"display\\" name"']
);
```

Run:

```bash
node tests/extractddl-safety.test.js
```

Expected:

```text
FAIL before implementation because UNION and double-quote escaping are not handled
```

- [ ] **Step 2: Add Hive comment literal renderer**

In `lib/experimental/ddl/sql-ddl-shared.js`, add:

```js
function render_hive_comment_literal(text) {
    return '"' + String(text || '')
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\r\n|\r|\n/g, '\\n') + '"';
}
```

Export it:

```js
exports.render_hive_comment_literal = render_hive_comment_literal;
```

- [ ] **Step 3: Use the renderer in extractddl output**

In `lib/experimental/ddl/sql-extract-ddl.js`, import:

```js
var render_hive_comment_literal = ddlShared.render_hive_comment_literal;
```

Replace:

```js
+ ' BIGINT COMMENT "'
+ columns[q].comment
+ '"'
```

with:

```js
+ ' BIGINT COMMENT '
+ render_hive_comment_literal(columns[q].comment)
```

- [ ] **Step 4: Split top-level query branches**

In `lib/experimental/ddl/sql-extract-ddl.js`, add helper functions:

```js
function is_set_operator_token(tokens, index) {
    if (!tokens[index] || tokens[index].type != 'word') {
        return false;
    }
    return /^(UNION|INTERSECT|EXCEPT)$/i.exec(tokens[index].value) != null;
}

function split_top_level_query_branches(tokens) {
    var branches = [];
    var state = { paren_depth: 0 };
    var start = 0;

    for (var i = 0; i < tokens.length; i++) {
        if (state.paren_depth == 0 && is_set_operator_token(tokens, i)) {
            branches.push(tokens.slice(start, i));
            i += 1;
            while (i < tokens.length && is_ignorable_token(tokens[i])) {
                i += 1;
            }
            if (tokens[i] && tokens[i].type == 'word' && /^ALL$/i.exec(tokens[i].value)) {
                i += 1;
            }
            start = i;
            i -= 1;
            continue;
        }

        update_sql_depth(tokens[i], state);
    }

    branches.push(tokens.slice(start));
    return branches;
}

function same_column_shape(left, right) {
    if (left.length != right.length) {
        return false;
    }

    for (var i = 0; i < left.length; i++) {
        if (left[i].name != right[i].name) {
            return false;
        }
    }

    return true;
}
```

- [ ] **Step 5: Make extraction branch-aware**

Change `extract_select_columns(sql)` so it tokenizes once, splits branches, extracts each branch, and only returns the first branch when all branches agree:

```js
function extract_columns_from_tokens(tokens) {
    var select_index = find_final_top_level_select(tokens);
    var columns = [];

    if (select_index < 0) {
        return columns;
    }

    var end_index = find_select_list_end(tokens, select_index);
    var item_tokens = split_select_items(tokens.slice(select_index + 1, end_index));

    for (var i = 0; i < item_tokens.length; i++) {
        var column_name = column_name_from_select_item(item_tokens[i]);
        if (column_name == '') {
            continue;
        }

        columns.push({
            name: column_name,
            comment: comment_text_from_item(item_tokens[i])
        });
    }

    return columns;
}

function extract_select_columns(sql) {
    var tokens = sqlTokenizer.tokenize(String(sql || ''), {
        dollarQuotedStrings: true,
        hashLineComments: true
    });
    var branches = split_top_level_query_branches(tokens);
    var first_columns = null;

    for (var i = 0; i < branches.length; i++) {
        var branch_columns = extract_columns_from_tokens(branches[i]);
        if (branch_columns.length == 0) {
            return [];
        }
        if (first_columns == null) {
            first_columns = branch_columns;
            continue;
        }
        if (!same_column_shape(first_columns, branch_columns)) {
            return [];
        }
    }

    return first_columns || [];
}
```

- [ ] **Step 6: Verify extractddl and DDL tests**

Run:

```bash
node tests/extractddl-safety.test.js
node tests/ddl-regression.test.js
```

Expected:

```text
extractddl safety tests passed
ddl regression tests passed
```

---

## Task 3: Fix Range Formatting For Complete CTE Selections

**Files:**
- Modify: `lib/core/sql-clause-registry.js`
- Modify: `lib/adapters/range-format-policy.js`
- Modify: `tests/range-format-policy.test.js`
- Modify: `tests/extension-contribution.test.js`

- [ ] **Step 1: Add more CTE range tests**

Extend `tests/range-format-policy.test.js`:

```js
var recursiveCte = 'with recursive s as (select 1 as id)\nselect id from s\n';
assert.strictEqual(
    analyze(recursiveCte, 0, recursiveCte.length, 'postgres').safe,
    true,
    'complete WITH RECURSIVE selection must be accepted'
);

var incompleteCte = 'with s as (select a from t\nselect a from s\n';
assert.strictEqual(
    analyze(incompleteCte, 0, incompleteCte.length, 'generic').safe,
    false,
    'CTE selection with unbalanced structure must still be rejected'
);

var continuationOnly = 'select a\nfrom t\nwhere x=1\nand y=2\n';
assert.strictEqual(
    analyze(continuationOnly, continuationOnly.indexOf('and'), continuationOnly.length, 'generic').safe,
    false,
    'condition continuation-only range must remain unsafe'
);
```

- [ ] **Step 2: Add registry helper for range-safe starts**

In `lib/core/sql-clause-registry.js`, add `rangeStart: true` to `WITH`, `SELECT`, and statement-start clauses:

```js
{ name: 'WITH', keywords: ['WITH'], dialects: DIALECTS, selectStart: false, selectEnd: false, conditionReset: true, rangeStart: true },
```

For statement-start clauses, add `rangeStart: true` to `DROP`, `CREATE`, `ALTER`, `INSERT`, `DELETE`, `SET`.

Add:

```js
function is_range_start(line, dialect) {
    return line_starts_clause(line, dialect, 'rangeStart')
        || is_statement_start(line, dialect)
        || is_select_block_start(line, dialect)
        || is_condition_clause(line, dialect);
}
```

Export it:

```js
exports.is_range_start = is_range_start;
```

- [ ] **Step 3: Use registry helper in range policy**

In `lib/adapters/range-format-policy.js`, replace the first three positive checks in `starts_with_safe_boundary` with:

```js
return sqlClauseRegistry.is_range_start(trimmed, dialect)
    || /^(FROM|JOIN|LEFT|RIGHT|FULL|INNER|CROSS|ORDER BY|SORT BY|CLUSTER BY|DISTRIBUTE BY|LIMIT|UNION|INTERSECT|EXCEPT|\()/.test(trimmed.toUpperCase());
```

Keep the explicit rejection for leading comma and `AND|OR|WHEN|THEN|ELSE|END`.

- [ ] **Step 4: Update extension contribution mock test**

In `tests/extension-contribution.test.js`, after the unsafe range assertion, add a safe CTE range assertion through the provider:

```js
var cteDocument = create_document('with s as (select a from t)\nselect a from s\n');
cteDocument.languageId = 'sql';
var cteEdits = vscodeMock.rangeProvider.provideDocumentRangeFormattingEdits(
    cteDocument,
    new vscodeMock.Range(create_position(0), create_position(cteDocument.text.length))
);
assert.strictEqual(cteEdits.length, 1, 'complete CTE range should be accepted by VS Code range formatter');
```

- [ ] **Step 5: Verify**

Run:

```bash
node tests/range-format-policy.test.js
node tests/extension-contribution.test.js
```

Expected:

```text
range format policy tests passed
extension contribution tests passed
```

---

## Task 4: Make Unsupported Syntax Policy Match User-Visible Semantics

**Files:**
- Create: `lib/core/sql-syntax-risk-detector.js`
- Modify: `lib/core/sql-formatter.js`
- Modify: `lib/core/sql-unsupported-policy.js`
- Modify: `lib/core/sql-dialect.js`
- Modify: `lib/core/sql-clause-registry.js`
- Modify: `tests/unsupported-safety.test.js`
- Modify: `docs/technical/sql-formatter-architecture.md`
- Modify: `docs/technical/sql-support-matrix.md`
- Modify: `scripts/generate-support-matrix.js`

- [ ] **Step 1: Add failing policy tests**

Append to `tests/unsupported-safety.test.js`:

```js
assert.throws(
    function() {
        vkbeautify.sql(
            'select * from t qualify row_number() over(partition by a order by b)=1',
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
    'bail_out must reject known low-confidence syntax for the selected dialect'
);

var warnedQualify = sqlFormatter.format_sql_detailed(
    'select * from t qualify row_number() over(partition by a order by b)=1',
    {
        keywordCase: 'upper',
        commaStyle: 'leading',
        indentStyle: 'space',
        maxAlignWidth: 150,
        caseWhenThenWrapLength: 80,
        dialect: 'postgres',
        unsupportedSyntaxPolicy: 'warn'
    }
);
assert.ok(
    warnedQualify.diagnostics.some(function(item) {
        return item.code == 'unsupported_syntax';
    }),
    'warn must emit diagnostics for known low-confidence dialect syntax'
);
```

- [ ] **Step 2: Create risk detector**

Create `lib/core/sql-syntax-risk-detector.js`:

```js
var sqlTokenizer = require('./sql-tokenizer');

function previous_code_token(tokens, index) {
    for (var i = index - 1; i >= 0; i--) {
        if (tokens[i].type != 'whitespace' && tokens[i].type != 'newline') {
            return tokens[i];
        }
    }
    return null;
}

function next_code_token(tokens, index) {
    for (var i = index + 1; i < tokens.length; i++) {
        if (tokens[i].type != 'whitespace' && tokens[i].type != 'newline') {
            return tokens[i];
        }
    }
    return null;
}

function snippet_for_token(source, token) {
    var start = Math.max(0, token.start - 40);
    var end = Math.min(source.length, token.end + 120);
    return source.slice(start, end);
}

function detect(text, dialectCapabilities) {
    var source = String(text || '');
    var dialect = dialectCapabilities && dialectCapabilities.dialect ? dialectCapabilities.dialect : 'generic';
    var tokens = sqlTokenizer.tokenize(source, dialectCapabilities);
    var segments = [];

    for (var i = 0; i < tokens.length; i++) {
        if (tokens[i].type != 'word') {
            continue;
        }

        if (/^QUALIFY$/i.exec(tokens[i].value) && dialect == 'postgres') {
            segments.push({
                kind: 'dialect_unsupported_clause',
                text: snippet_for_token(source, tokens[i])
            });
        }

        if (/^MATCH_RECOGNIZE$/i.exec(tokens[i].value)) {
            segments.push({
                kind: 'opaque_clause',
                text: snippet_for_token(source, tokens[i])
            });
        }

        if (/^(PIVOT|UNPIVOT|MERGE)$/i.exec(tokens[i].value)) {
            segments.push({
                kind: 'known_unmodeled_construct',
                text: snippet_for_token(source, tokens[i])
            });
        }

        if (/^OVER$/i.exec(tokens[i].value)) {
            var next = next_code_token(tokens, i);
            var previous = previous_code_token(tokens, i);
            if (next && next.type == 'punctuation' && next.value == '(' && previous && previous.type == 'punctuation' && previous.value == ')') {
                continue;
            }
        }
    }

    return segments;
}

exports.detect = detect;
```

- [ ] **Step 3: Attach risk segments before mutation**

In `lib/core/sql-formatter.js`, import:

```js
var sqlSyntaxRiskDetector = require('./sql-syntax-risk-detector');
```

After dialect capabilities are computed and before `protect_set_payloads`, add:

```js
var riskSegments = sqlSyntaxRiskDetector.detect(text, dialect);
for (var r = 0; r < riskSegments.length; r++) {
    sqlUnsupportedPolicy.note_unsupported(context, riskSegments[r].kind, riskSegments[r].text);
}
```

Keep `protect_opaque_segments` because it still preserves constructs internally.

- [ ] **Step 4: Update support matrix generation**

In `scripts/generate-support-matrix.js`, add a section explaining known low-confidence constructs:

```js
'## Known Low-Confidence Syntax',
'',
'The unsupported policy is driven by protected opaque segments plus a lightweight risk detector. It is not a full parser, but it must reject or warn for known constructs that the formatter cannot safely model.',
'',
'- `MATCH_RECOGNIZE(...)`: protected as opaque',
'- PostgreSQL `QUALIFY`: reported as dialect-unsupported',
'- `PIVOT` / `UNPIVOT` / `MERGE`: reported as known unmodeled constructs',
'',
```

Regenerate:

```bash
node scripts/generate-support-matrix.js --write
```

- [ ] **Step 5: Update architecture docs**

In `docs/technical/sql-formatter-architecture.md`, update `Unsupported Policy`:

```markdown
Unsupported syntax detection has two inputs:

- Opaque protection for constructs whose body must not be rewritten.
- A lightweight syntax risk detector for known dialect mismatches or known unmodeled constructs.

This is still not a full parser. The policy means "known low-confidence syntax", not "every possible unsupported SQL grammar form".
```

- [ ] **Step 6: Verify**

Run:

```bash
node tests/unsupported-safety.test.js
node tests/generated-support-matrix.test.js
node tests/formatter-api.test.js
```

Expected:

```text
unsupported safety tests passed
generated support matrix tests passed
formatter api tests passed
```

---

## Task 5: Respect VS Code Resource-Scoped Configuration

**Files:**
- Modify: `lib/adapters/vscode-config.js`
- Modify: `tests/config-options.test.js`
- Modify: `tests/extension-contribution.test.js`

- [ ] **Step 1: Add source-level config scope test**

In `tests/config-options.test.js`, add:

```js
assert_source_contains(
    'VS Code config adapter must read sqlBeautify configuration with document scope',
    /getConfiguration\('sqlBeautify',\s*document\s*&&\s*document\.uri\)/
);
```

- [ ] **Step 2: Add mock behavior test**

In `tests/extension-contribution.test.js`, update `create_vscode_mock()` so `workspace.getConfiguration` records the scope:

```js
configScopes: [],
```

Inside `workspace.getConfiguration`:

```js
getConfiguration: function(section, scope) {
    mock.configScopes.push({ section: section, scope: scope });
    return {
        ...
    };
}
```

After a document formatting call with `hiveDocument.uri = { fsPath: '/workspace/a.sql' }`, assert:

```js
assert.ok(
    vscodeMock.configScopes.some(function(item) {
        return item.section == 'sqlBeautify' && item.scope == hiveDocument.uri;
    }),
    'VS Code config must be read with document.uri scope'
);
```

- [ ] **Step 3: Implement scoped config read**

In `lib/adapters/vscode-config.js`, replace:

```js
var scopedConfig = vscode.workspace.getConfiguration('sqlBeautify');
```

with:

```js
var scopedConfig = vscode.workspace.getConfiguration('sqlBeautify', document && document.uri);
```

- [ ] **Step 4: Verify**

Run:

```bash
node tests/config-options.test.js
node tests/extension-contribution.test.js
```

Expected:

```text
config options tests passed
extension contribution tests passed
```

---

## Task 6: Introduce A Shared Format Model To Reduce Pipeline Coupling

**Files:**
- Create: `lib/core/sql-format-model.js`
- Modify: `lib/core/sql-comment-formatter.js`
- Modify: `lib/core/sql-condition-formatter.js`
- Modify: `lib/core/sql-layout-formatter.js`
- Modify: `tests/comment-alignment.test.js`
- Modify: `tests/condition-alignment.test.js`
- Modify: `tests/pipeline-idempotency.test.js`
- Modify: `tests/module-boundary.test.js`

- [ ] **Step 1: Add model unit tests through existing behavior**

Create a focused section in `tests/pipeline-idempotency.test.js`:

```js
var sqlFormatModel = require('../lib/core/sql-format-model');

var modeled = sqlFormatModel.from_text([
    'select a -- keep',
    'from t',
    'where x=1 and y=2'
].join('\n'), { dialect: 'generic' });

assert.strictEqual(modeled.lines.length, 3, 'format model must preserve line count');
assert.strictEqual(modeled.lines[0].comment, '-- keep', 'format model must expose trailing comments');
assert.strictEqual(modeled.lines[2].parenDelta, 0, 'format model must expose paren delta');
```

- [ ] **Step 2: Create `sql-format-model.js`**

Create `lib/core/sql-format-model.js`:

```js
var sqlLineModel = require('./sql-line-model');
var sqlTokenizer = require('./sql-tokenizer');
var sqlCaseUtils = require('./sql-case-utils');

function paren_delta(tokens) {
    var delta = 0;
    for (var i = 0; i < tokens.length; i++) {
        if (tokens[i].type == 'punctuation' && tokens[i].value == '(') {
            delta += 1;
        } else if (tokens[i].type == 'punctuation' && tokens[i].value == ')') {
            delta -= 1;
        }
    }
    return delta;
}

function from_text(text, tokenizerOptions) {
    var rawLines = String(text || '').split(/\r\n|\n|\r/);
    var lines = [];

    for (var i = 0; i < rawLines.length; i++) {
        var lineInfo = sqlLineModel.from_text(rawLines[i], tokenizerOptions)[0];
        var codeTokens = sqlTokenizer.tokenize(lineInfo.code, tokenizerOptions);
        lines.push({
            index: i,
            raw: rawLines[i],
            code: lineInfo.code,
            comment: lineInfo.comment,
            isBlank: lineInfo.isBlank,
            isStandaloneComment: lineInfo.isStandaloneComment,
            hasTrailingComment: lineInfo.hasTrailingComment,
            codeTokens: codeTokens,
            parenDelta: paren_delta(codeTokens),
            caseDelta: sqlCaseUtils.get_case_balance_delta(lineInfo.code, tokenizerOptions)
        });
    }

    return {
        lines: lines
    };
}

exports.from_text = from_text;
```

- [ ] **Step 3: Migrate comment formatter high-repeat token paths**

In `lib/core/sql-comment-formatter.js`, import:

```js
var sqlFormatModel = require('./sql-format-model');
```

In `order_comment`, build once:

```js
var model = sqlFormatModel.from_text(str, tokenizer_options);
```

Then replace repeated `get_code_paren_delta(code)` and `get_case_balance_delta(code, tokenizer_options)` calls for each line with `model.lines[i].parenDelta` and `model.lines[i].caseDelta`.

Keep output rebuilding through `text_list` so external behavior remains unchanged.

- [ ] **Step 4: Migrate condition and layout in small increments**

In `lib/core/sql-condition-formatter.js`, for `align_condition_clauses`, compute:

```js
var model = sqlFormatModel.from_text(str, dialect);
```

Use `model.lines[i].caseDelta` where current code recomputes case balance.

In `lib/core/sql-layout-formatter.js`, use the model in `indent_nested_blocks` after `split_trailing_closing_parens` has produced final physical lines.

- [ ] **Step 5: Add boundary guard**

In `tests/module-boundary.test.js`, add:

```js
assert.ok(
    combinedLiveFormatterSource.indexOf('sql-format-model') >= 0,
    'live formatter graph should include shared format model after pipeline coupling cleanup'
);
```

- [ ] **Step 6: Verify behavior and idempotency**

Run:

```bash
node tests/comment-alignment.test.js
node tests/condition-alignment.test.js
node tests/pipeline-idempotency.test.js
node tests/module-boundary.test.js
```

Expected:

```text
comment alignment tests passed
condition alignment tests passed
pipeline idempotency tests pass
module boundary tests passed
```

---

## Task 7: Turn Performance Risk Into A Measured Contract

**Files:**
- Modify: `tests/performance-smoke.test.js`
- Modify: `package.json`
- Modify: `lib/core/sql-format-model.js`
- Modify: `lib/core/sql-comment-formatter.js`
- Modify: `lib/core/sql-condition-formatter.js`
- Modify: `lib/core/sql-layout-formatter.js`

- [ ] **Step 1: Record pre-optimization timing**

Run:

```bash
node tests/performance-smoke.test.js
```

Expected:

```text
performance smoke tests passed in <elapsed>ms
```

If it fails above 5000ms, keep the failure and implement the optimization steps below before adjusting any threshold.

- [ ] **Step 2: Avoid duplicate line model construction**

Where multiple passes need line-level facts, pass a model object explicitly only within a single pass. Do not introduce global mutable cache. The acceptable pattern is:

```js
var model = sqlFormatModel.from_text(str, tokenizer_options);
```

The unacceptable pattern is:

```js
global.__sqlBeautifyTokenCache = {};
```

- [ ] **Step 3: Convert hot string concatenation loops to array joins**

In hot paths that append many full output lines, prefer:

```js
var output = [];
output.push(line);
return output.join('\n');
```

Apply this first to functions with full-line loops:

- `lib/core/sql-condition-formatter.js` `align_condition_clauses`
- `lib/core/sql-layout-formatter.js` `indent_nested_blocks`
- `lib/core/sql-layout-formatter.js` `cleanup_layout_markers`

- [ ] **Step 4: Keep threshold strict enough to catch regression**

After optimization, keep `tests/performance-smoke.test.js` threshold at `5000ms`. If the optimized local result is consistently below `2500ms`, lower the threshold to `3500ms` only after verifying CI stability.

- [ ] **Step 5: Verify**

Run:

```bash
node tests/performance-smoke.test.js
npm run test:verify
```

Expected:

```text
performance smoke tests passed in <elapsed>ms
unsupported safety tests passed
```

---

## Task 8: Harden CI, Packaging Smoke, And Release Safety

**Files:**
- Modify: `.github/workflows/build-vsix.yml`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add packaging smoke to PR and main push**

In `.github/workflows/build-vsix.yml`, change `Package VSIX` so it runs for all events:

```yaml
      - name: Package VSIX
        run: npm run package:vsix
```

Keep artifact upload and release creation restricted to manual dispatch.

- [ ] **Step 2: Guard manual release to main only**

Before uploading artifacts or creating release, add:

```yaml
      - name: Guard release branch
        if: github.event_name == 'workflow_dispatch' && github.ref != 'refs/heads/main'
        run: |
          echo "Formal VSIX release must be built from main. Current ref: ${{ github.ref }}"
          exit 1
```

- [ ] **Step 3: Verify package version and tag consistency**

After `Read package version`, add:

```yaml
      - name: Verify release tag target
        if: github.event_name == 'workflow_dispatch'
        env:
          GH_TOKEN: ${{ github.token }}
          VERSION: ${{ steps.package.outputs.version }}
        run: |
          tag="v${VERSION}"
          if git ls-remote --tags origin "${tag}" | grep -q "${tag}$"; then
            remote_sha="$(git ls-remote --tags origin "${tag}" | awk '{print $1}')"
            current_sha="$(git rev-parse HEAD)"
            if [ "${remote_sha}" != "${current_sha}" ]; then
              echo "Existing tag ${tag} points to ${remote_sha}, but current HEAD is ${current_sha}."
              exit 1
            fi
          fi
```

- [ ] **Step 4: Keep release upload after guards**

Keep:

```yaml
      - name: Upload VSIX artifact
        if: github.event_name == 'workflow_dispatch'
```

Keep release creation after branch and tag guards.

- [ ] **Step 5: Update docs minimally**

In `README.md`, keep user-facing install wording unchanged unless it references a release behavior that is now false.

In `CHANGELOG.md`, add an unreleased entry only if implementation work in the same branch uses changelog-first release flow. If not, leave changelog unchanged until user confirms behavior.

- [ ] **Step 6: Verify workflow syntax indirectly**

Run:

```bash
npm run package:vsix
```

Expected:

```text
vscode-sql-beautify-v<package-version>.vsix
```

No local `.vsix` should be committed.

---

## Task 9: Update Support Matrix And User-Facing Boundaries

**Files:**
- Modify: `README.md`
- Modify: `docs/technical/sql-formatter-architecture.md`
- Modify: `docs/technical/sql-support-matrix.md`
- Modify: `scripts/generate-support-matrix.js`
- Modify: `tests/generated-support-matrix.test.js`

- [ ] **Step 1: Keep README focused on users**

In `README.md`, update only these user-facing facts if changed by implementation:

```markdown
- `Extract Hive DDL (Experimental)` supports high-confidence SELECT extraction and validates compatible UNION branches.
- Inconsistent UNION branch schemas are skipped instead of producing misleading DDL.
- Generated comments are escaped as Hive-compatible string literals.
```

Do not add internal architecture details to README.

- [ ] **Step 2: Update architecture doc with new model**

In `docs/technical/sql-formatter-architecture.md`, add:

```markdown
## Shared Format Model

`lib/core/sql-format-model.js` provides reusable line-level facts for passes that need code/comment split, parenthesis delta, and CASE balance. It does not replace the tokenizer and must not become a mutable global cache. The model exists to reduce repeated tokenization and prevent comment / condition / layout passes from deriving conflicting facts from the same line.
```

- [ ] **Step 3: Update generated support matrix source**

In `scripts/generate-support-matrix.js`, include:

```js
'## Extract DDL Boundary',
'',
'- Consistent top-level UNION branches may be extracted when column shape matches',
'- Inconsistent UNION branch schemas are skipped',
'- Comment text is rendered through Hive-compatible escaped string literals',
'',
```

Regenerate:

```bash
node scripts/generate-support-matrix.js --write
```

- [ ] **Step 4: Verify docs generation**

Run:

```bash
node tests/generated-support-matrix.test.js
```

Expected:

```text
generated support matrix tests passed
```

---

## Task 10: Final Full-System Verification

**Files:**
- No direct code changes in this task.

- [ ] **Step 1: Run targeted high-risk tests**

Run:

```bash
node tests/ddl-regression.test.js
node tests/extractddl-safety.test.js
node tests/range-format-policy.test.js
node tests/unsupported-safety.test.js
node tests/config-options.test.js
node tests/performance-smoke.test.js
node tests/extension-contribution.test.js
```

Expected:

```text
ddl regression tests passed
extractddl safety tests passed
range format policy tests passed
unsupported safety tests passed
config options tests passed
performance smoke tests passed in <elapsed>ms
extension contribution tests passed
```

- [ ] **Step 2: Run full regression**

Run:

```bash
npm run test:verify
```

Expected:

```text
unsupported safety tests passed
```

- [ ] **Step 3: Run packaging smoke**

Run:

```bash
npm run package:vsix
```

Expected:

```text
vscode-sql-beautify-v0.5.4.vsix
```

The version string should match `package.json`. Do not commit the generated `.vsix`.

- [ ] **Step 4: Inspect git diff**

Run:

```bash
git status --short
git diff --stat
```

Expected:

```text
Only task-related source, tests, docs, package.json, and workflow files are modified.
No .vsix file is staged.
```

- [ ] **Step 5: Handoff to user before commit**

Report:

```text
已完成实现与验证。请在 VS Code 中用真实 SQL / Hive SQL 样本测试：
1. Format Document
2. Format Selection with complete CTE
3. Format Hive DDL with backtick column names
4. Extract Hive DDL with consistent and inconsistent UNION branches

用户确认后再创建 git commit。
```

---

## 3. Implementation Order

Recommended order:

1. Task 0: freeze baseline and add test entrypoints
2. Task 1: DDL splitter
3. Task 2: extractddl branch / literal safety
4. Task 3: CTE range policy
5. Task 4: unsupported policy semantics
6. Task 5: VS Code config scope
7. Task 6: shared format model
8. Task 7: performance contract
9. Task 8: CI / release guard
10. Task 9: docs / support matrix
11. Task 10: full verification

This order fixes confirmed user-visible defects before larger architecture and CI cleanup, while still requiring every previously identified issue to be implemented.

---

## 4. Self-Review

- Spec coverage: every issue from the strict engineering review is mapped in section 1 and has an implementation task.
- Placeholder scan: this document contains no deferred implementation slots and no unspecified validation steps.
- Type consistency: new helper names are stable across tasks:
  - `split_top_level_items(text, tokenizerOptions, splitOptions)`
  - `render_hive_comment_literal(text)`
  - `split_top_level_query_branches(tokens)`
  - `sql-syntax-risk-detector.detect(text, dialectCapabilities)`
  - `sql-format-model.from_text(text, tokenizerOptions)`
- Project constraints: commits are intentionally omitted from task steps because project rules require user confirmation before committing verified code.

