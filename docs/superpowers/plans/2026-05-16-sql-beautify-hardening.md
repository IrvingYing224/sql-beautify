# SQL Beautify 稳定性与架构演进执行计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 先解决会破坏生产 SQL 的高风险格式化问题，再逐步把核心流程迁移到 token / line model 驱动的可维护结构。

**Architecture:** 保持 `vkbeautify.sql(...)`、VS Code 命令和现有配置兼容。优先补不可改写 token 与回归测试，再用轻量 wrapper 收敛主流程，不一次性重写 formatter。

**Tech Stack:** VS Code extension、CommonJS、Node.js、项目内 CLI 回归测试。

---

## Summary

目标是先解决会破坏生产 SQL 的高风险问题，再把格式化核心从“全局正则 + 占位符”逐步迁移到 token / line model 驱动的可维护结构。

优先级分三批：

1. **稳定性修复:** 块注释、反引号标识符、转义字符串、回归测试。
2. **架构收敛:** 统一字符串/注释保护，拆分 formatter passes，降低 `vkbeautify.js` 耦合。
3. **编辑器与产品能力:** 标准 VS Code formatter、配置整理、Hive/Spark/Presto 企业功能路线。

## Task 1: 建立高风险回归测试

**Files:**
- Create: `tests/token-boundary.test.js`
- Modify: `package.json`

- [x] 新增 token 边界测试，覆盖块注释、反引号标识符、转义字符串、双单引号字符串、注释和字符串内 `CASE WHEN THEN`、幂等性。
- [x] 将 `node tests/token-boundary.test.js` 加入 `npm run test:verify`。
- [x] 运行 `node tests/token-boundary.test.js`，确认新增测试在修复前失败。

## Task 2: 扩展 tokenizer 的不可改写 token

**Files:**
- Modify: `lib/sql-tokenizer.js`
- Modify: `lib/sql-keywords.js`
- Modify: `lib/sql-line-model.js`

- [x] 新增 `block_comment` token，完整保护 `/* ... */`。
- [x] 新增 `quoted_identifier` token，支持反引号内容整体保留。
- [x] 保持 `string_literal` 对 `\\` 和 `''` 的支持。
- [x] keyword case 只处理真实 `word` token，不处理 comment、string、quoted identifier。
- [x] `split_code_and_comment` 继续只把 `line_comment` 作为行尾注释，块注释不参与 SQL 结构识别。
- [x] 运行 `node tests/token-boundary.test.js` 和 `npm run test:verify`。

## Task 3: 移除旧字符串保护的行为入口

**Files:**
- Modify: `vkbeautify.js`

- [x] 停止在主 `sql()` 流程中依赖 `restore_list` / `NEEDReplace` 对字符串做保护。
- [x] 用 tokenizer-based shield 替代 `extract_quotation_mark()` 对字符串的递归替换。
- [x] 保留旧函数仅在未迁移路径中使用，或删除已确认未使用的死代码。
- [x] 禁止新增扫描字符串/注释正文的全局 regex。
- [x] 验证 `select 'can\\'t from where' as s, a from t`、`select 'it''s from where' as s`、`select '--, CASE WHEN THEN' as s`。

## Task 4: 修复块注释格式化破坏

**Files:**
- Modify: `vkbeautify.js`
- Modify: `lib/sql-tokenizer.js`

- [x] 在进入 `replace_char/get_bracket/special_wrap/condition_wrap` 前保护 `block_comment`。
- [x] 渲染后原样恢复块注释文本。
- [x] 块注释位于独立行时保持独立行。
- [x] 块注释位于行尾时不参与尾注释对齐。
- [x] 运行 `npm run test:verify`。

## Task 5: 收敛 VS Code 命令与 formatter 入口

**Files:**
- Modify: `extension.js`
- Modify: `package.json`

- [x] `contributes.commands` 补齐 `extension.beautifySqlddl` 和 `extension.extractDdl`。
- [x] 注册 `vscode.languages.registerDocumentFormattingEditProvider`。
- [x] 注册 `vscode.languages.registerDocumentRangeFormattingEditProvider`。
- [x] 标准 formatter 使用 `vkbeautify.sql(...)`。
- [x] 保留现有快捷键行为。
- [x] 如果格式化抛错，显示 `vscode.window.showErrorMessage`，不替换原文。
- [x] 运行 `npm run test:verify`。

## Task 6: 配置语义整理但保持兼容

**Files:**
- Modify: `package.json`
- Modify: `extension.js`
- Modify: `README.md`

- [x] 保留旧配置键：`extension.uppercase`、`extension.comma_location`、`extension.bracket_char`、`extension.as_loc_cnt`、`extension.case_when_then_wrap_length`。
- [x] 新增清晰配置：`extension.keywordCase`、`extension.commaStyle`、`extension.indentStyle`、`extension.maxAlignWidth`。
- [x] 新配置优先级高于旧配置。
- [x] README 明确说明 Hive 优先、Spark/Presto 为 best-effort。
- [x] 增加配置映射测试或可直接执行的 Node 验证。
- [x] 运行 `npm run test:verify`。

## Task 7: 架构拆分

**Files:**
- Create: `lib/sql-shield.js`
- Create: `lib/sql-render-options.js`
- Create: `lib/sql-format-pipeline.js`
- Create: `tests/pipeline-idempotency.test.js`
- Modify: `vkbeautify.js`
- Modify: `package.json`

- [x] 新增 `sql-shield.js`，集中保护/恢复 string、line comment、block comment、quoted identifier。
- [x] 新增 `sql-render-options.js`，统一归一化旧/新配置。
- [x] 新增 `sql-format-pipeline.js`，串联现有 passes。
- [x] `vkbeautify.sql()` 保持公开 API 不变。
- [x] 新增幂等性测试并加入 `test:verify`。
- [x] 运行 `npm run test:verify` 和 `node tests/pipeline-idempotency.test.js`。

## Task 8: DDL / Extract DDL 风险隔离

**Files:**
- Modify: `README.md`
- Modify: `package.json`
- Create: `tests/ddl-regression.test.js`

- [x] 标注 `sqlddl` / `extractDdl` 为 Hive DDL experimental。
- [x] 增加 DDL 回归测试：`DECIMAL(18,2)`、`ARRAY<STRING>`、`MAP<STRING,STRING>`、`STRUCT<...>`、`COMMENT` 内含逗号。
- [x] 不在本轮强行重写 DDL parser。
- [x] 运行 `npm run test:verify` 和 `node tests/ddl-regression.test.js`。

## Test Plan

每个任务完成后必须运行：

```bash
npm run test:verify
```

关键任务额外运行：

```bash
node tests/token-boundary.test.js
node tests/pipeline-idempotency.test.js
node tests/ddl-regression.test.js
```

最终验收必须满足：

- 所有自动测试通过。
- 高风险样例不会改写注释、字符串、反引号内容。
- 常见 Hive 样例输出与既有回归一致。
- 同一 SQL 二次格式化输出不再变化。
- VS Code 命令和标准 formatter 均可用。

## Assumptions

- 不引入外部 SQL parser，先延续当前零运行时依赖策略。
- 不在第一批实现血缘分析、Explain、智能优化建议；这些需要独立产品设计和外部连接能力。
- 不提交 `.vsix`。
- 代码修改完成后先让用户验证，再更新文档和提交。
- 若需要发布验证包，按项目规则通过 GitHub Actions 构建 Release `.vsix`。
