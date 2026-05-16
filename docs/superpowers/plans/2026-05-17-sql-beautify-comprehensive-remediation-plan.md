# SQL Beautify 全面整改与架构升级执行计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` or an equivalent disciplined execution flow. Use checkbox progress tracking. Do not downgrade this plan into isolated micro-fixes. The goal is full implementation of the identified recommendations, not conservative patching.

**Goal:** 基于本轮缺陷修复和前一轮严格审视结果，对项目进行一次不保守的系统性整改。目标不是“继续缝缝补补”，而是把配置面、formatter pipeline、core / adapter / experimental 边界、测试体系和用户体验契约全部收敛到适合长期迭代的状态。

**Scope:** 本计划覆盖：

- 已确认缺陷：
  - 复杂 `SELECT` continuation line 中 `CASE ... END` 后续字段未继续拆分，导致多个顶层字段回流到同一行
  - `SELECT` 列表中“行尾逗号 + 独立注释 + 下一个字段”场景的状态机脆弱
  - 设置面板同时暴露旧 `extension.*` 和新 `sqlBeautify.*`，造成重复配置和优先级理解成本
- 本轮审视中确认的结构性问题：
  - token-aware 与手写文本扫描混用，真实方言边界不稳
  - dialect 能力传递不彻底，局部 pass 仍带 `'generic'` 假默认
  - 输出空白契约不明确，空行/尾随换行/CRLF 行为不可预测
  - VS Code range formatting 缺少“局部片段安全策略”
  - experimental DDL / extract DDL 能力边界表达不足
  - helper 重复、职责重叠、错误观测能力不足
  - `unsupportedSyntaxPolicy` 目前更像半成品接口

**Architecture Direction:** 保持 `core / adapters / experimental` 分层，但本次计划不再满足于“分层存在”；要求每一层的职责、输入契约、失败策略、测试边界和文档说明都彻底收敛。

**Tech Stack:** VS Code extension、CommonJS、Node.js、本地 CLI 回归测试、registry-driven SQL formatter core、experimental Hive DDL helper。

---

## 1. 本次整改的基本判断

当前项目已经不属于“完全失控”的状态，主要 formatter 主链路也已有较高测试覆盖。但现状仍然有一个明确特征：

- 核心思路正在向 token-driven、canonical-options、registry-driven 靠拢；
- 若干关键辅助模块仍然保留旧式状态机、手写字符扫描和 UI/兼容层遗留；
- 因此系统表面稳定，组合态输入下仍会暴露脆弱点。

这意味着本轮不适合再采取“哪里炸了补哪里”的方式。继续保守补丁只会让逻辑越来越绕，最终形成“测试越来越多、代码越来越难懂”的坏平衡。

本计划明确要求：

- [ ] 将所有已识别建议转化为阶段化实施任务，而不是只写成风险说明
- [ ] 允许对 `package.json` 配置面、adapter 层、formatter pipeline、测试体系和文档结构做较大整理
- [ ] 以长期可维护性和行为契约清晰为第一优先级，不以 diff 小为目标

---

## 2. 已识别问题总表

### 2.1 已确认功能缺陷

- [ ] 复杂 `SELECT` continuation line 中，`CASE ... END` 后继续跟随多个顶层字段时，旧逻辑无法继续拆分
- [ ] 独立注释夹在两个 `SELECT` item 之间时，旧状态机容易留下孤立逗号或错误缩进
- [ ] 设置面板暴露重复配置键，用户无法快速判断应该用哪一组配置

### 2.2 已确认设计缺陷

- [ ] `split_top_level_items()`、`split_code_and_comment()`、部分 `AS` / comment / CASE 边界 helper 仍有手写字符扫描思维
- [ ] 某些 pass 的 dialect 传递不彻底，局部仍依赖 `'generic'` fallback
- [ ] whitespace / blank line / trailing newline / CRLF 没有统一输出契约
- [ ] range formatting 与 document formatting 共用激进结构化格式化策略，局部片段缺少保守模式
- [ ] `unsupportedSyntaxPolicy` 已在 canonical options 中出现，但缺少对应执行矩阵
- [ ] experimental DDL 当前仍容易被误读为“更强 SQL parser”，产品边界表达不足

### 2.3 已确认维护性问题

- [ ] helper 存在语义重复，未来修边界 bug 时容易多点漏改
- [ ] adapter 层、配置兼容层、UI 暴露层混杂
- [ ] 错误诊断和现场定位能力不足，失败行为虽然保守，但开发者缺少足够证据
- [ ] 回归样例偏“理想化”，真实生产复杂 SQL 样本比例不够

---

## 3. 整改原则

- [ ] 兼容旧用户配置，但不继续把 legacy 配置作为一等 UX 面暴露
- [ ] formatter core 只接受 canonical 语义，不再向内部传播 legacy 命名
- [ ] 任何涉及字符串/注释/quoted identifier/dollar-quoted string/hash comment 的处理，优先走 tokenizer / token model，不再允许新增手写字符扫描实现
- [ ] 对用户可见行为建立明确输出契约：空行、换行、失败策略、range formatting 语义
- [ ] 对 experimental 能力明确降级宣传，避免“表面支持大于真实能力”
- [ ] 测试不再只验证“语法正确”，还要验证“真实组合输入稳定”

---

## 4. 目标状态

### 4.1 配置面

- 设置 UI 只展示 `sqlBeautify.*`
- `extension.*` 仅作为兼容读取路径存在
- 文档明确新旧优先级、迁移关系、行为兼容范围

### 4.2 Core 层

- core 全链路只使用 canonical options
- select/comment/case/condition/layout 的基础 primitive 统一 token-aware
- dialect capabilities 贯穿所有需要感知方言边界的 pass

### 4.3 Adapter 层

- VS Code config mapping、命令注册、format provider orchestration、legacy positional args adapter 职责清晰拆分
- range formatting 对不完整结构有明确保守策略或拒绝策略

### 4.4 Experimental 层

- DDL / extract DDL 在目录、文档、能力宣称和测试边界上都保持实验性定位

### 4.5 验证层

- 回归包含真实生产样本
- 输出契约有专门测试
- 关键结构债务有模块边界 guard，避免未来回流

---

## 5. 分阶段执行计划

## Phase 0: 基线冻结与问题分组固化

**Intent:** 在进入大改前，把“要修什么、为什么修、怎么验证修完”全部固化，避免后续又退回机会主义补丁。

**Files:**
- Modify/Create: `docs/superpowers/plans/2026-05-17-sql-beautify-comprehensive-remediation-plan.md`
- Modify/Create: `tests/select-alignment.test.js`
- Modify/Create: `tests/config-options.test.js`
- Modify/Create: `tests/comment-alignment.test.js`
- Modify/Create: `tests/pipeline-idempotency.test.js`

- [ ] 保留本次已修的 `SELECT` 列表回归
- [ ] 新增“真实生产复杂 `SELECT` 样本”回归目录或测试块
- [ ] 将本轮审视发现的问题按下面几个问题域分组：
  - 配置面与兼容策略
  - core token-aware primitive
  - whitespace / 输出契约
  - adapter / range formatting
  - experimental DDL 边界
  - 错误诊断与观测

**Exit Criteria:**

- 每个问题域都有明确 owner、实施范围、验证入口
- 回归集已经覆盖本次真实用户样本，而不是只覆盖简化样例

---

## Phase 1: 配置面全面收敛

**Intent:** 解决重复配置、优先级理解困难和兼容层 UI 泄漏问题。

**Files:**
- Modify: `package.json`
- Modify: `lib/adapters/vscode-config.js`
- Modify: `lib/adapters/sql-render-options.js`
- Modify/Create: `tests/config-options.test.js`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

- [ ] 把 `extension.uppercase`、`extension.comma_location`、`extension.bracket_char`、`extension.as_loc_cnt`、`extension.case_when_then_wrap_length`
  保留为兼容读取路径，但从主配置面板迁出或显式标记为 deprecated / hidden
- [ ] 评估 `extension.keywordCase`、`extension.commaStyle`、`extension.indentStyle`、`extension.maxAlignWidth` 是否还需要继续展示
  - 目标倾向：全部收敛到 `sqlBeautify.*`
- [ ] 保持读取优先级：
  - 用户显式设置的 `sqlBeautify.*` 优先
  - 未显式设置新键时，兼容读取旧键
  - 绝不让新默认值静默覆盖旧用户设置
- [ ] README 中加入“配置迁移表”
- [ ] 配置测试新增：
  - UI 只推荐新键
  - 旧键仍可生效
  - 显式新键优先于显式旧键
  - 没有任何设置时行为与当前默认兼容

**Risks:**

- 修改 `package.json` 配置贡献时，最容易误伤 VS Code 设置面行为

**Validation:**

- `node tests/config-options.test.js`
- `node tests/extension-contribution.test.js`
- 手工检查 `package.json` 配置面贡献与 README 一致

**Exit Criteria:**

- 用户设置面不再看到重复配置面
- 兼容性读取仍然保留
- 文档与实际优先级一致

---

## Phase 2: `SELECT` / comment 真实复杂样本硬化

**Intent:** 不只修本次单点 bug，而是把 `SELECT` 列表、独立注释、trailing comment、`CASE`、函数调用混合场景系统硬化。

**Files:**
- Modify: `lib/core/sql-select-formatter.js`
- Modify: `lib/core/sql-comment-formatter.js`
- Modify: `lib/core/sql-formatter.js`
- Modify/Create: `tests/select-alignment.test.js`
- Modify/Create: `tests/comment-alignment.test.js`
- Modify/Create: `tests/hive-regression.test.js`

- [ ] 将 `SELECT` list continuation 处理彻底建立在 token-aware top-level item split 上
- [ ] 收口“独立注释恢复”和 `SELECT` 状态机之间的隐式耦合
- [ ] 增补以下高风险样例：
  - continuation line 中 `CASE ... END` 后跟多个顶层字段
  - 行尾逗号 + 独立注释 + 下一个字段是 `CASE`
  - `CASE`、函数调用、行尾注释、独立注释交错出现
  - 多段 `SELECT` / nested query / Hive `INSERT OVERWRITE` 组合场景
- [ ] 把这类真实样例提取成“长期样本回归”而不是散落在单文件中

**Validation:**

- `node tests/select-alignment.test.js`
- `node tests/comment-alignment.test.js`
- `node tests/hive-regression.test.js`
- `npm run test:verify`

**Exit Criteria:**

- 这类复杂 `SELECT` 样本全部稳定
- `SELECT` 与 comment 的交互不再依赖偶然的 pipeline 顺序

---

## Phase 3: 清除 core 中的手写字符扫描，统一 token-aware primitive

**Intent:** 解决“今天靠 shield 顺序能过，明天换一个 pass 就炸”的根本问题。

**Files:**
- Modify: `lib/core/sql-select-formatter.js`
- Modify: `lib/core/sql-line-model.js`
- Modify: `lib/core/sql-structure.js`
- Modify: `lib/core/sql-case-utils.js`
- Modify/Create: `lib/core/sql-token-primitives.js`
- Modify/Create: `tests/token-boundary.test.js`
- Modify/Create: `tests/pipeline-idempotency.test.js`

- [ ] 收口以下基础能力为 token-aware primitive：
  - code/comment 拆分
  - 顶层逗号 item 拆分
  - 顶层 `AS` 定位
  - CASE/THEN/ELSE/END 边界
  - quoted identifier / string / block comment / dollar-quoted string / hash comment 边界
- [ ] 将当前散落在多个模块里的手写字符扫描逻辑逐步迁出
- [ ] 新增强约束：新逻辑若需要重新处理 SQL 文本边界，必须复用 primitive，不允许重复实现

**Risks:**

- 这是最值得做、也最容易扩大改动面的阶段

**Validation:**

- `node tests/token-boundary.test.js`
- `node tests/pipeline-idempotency.test.js`
- `npm run test:verify`

**Exit Criteria:**

- 关键 helper 只保留一套 token-aware 真正事实源
- Postgres / MySQL / Hive 的边界处理不再依赖“刚好 shield 了”

---

## Phase 4: dialect capabilities 全链路贯穿

**Intent:** 解决“对外说支持 dialect，但局部 pass 仍默默按 generic 工作”的问题。

**Files:**
- Modify: `lib/core/sql-select-formatter.js`
- Modify: `lib/core/sql-comment-formatter.js`
- Modify: `lib/core/sql-structure.js`
- Modify: `lib/core/sql-line-model.js`
- Modify: `lib/core/sql-case-formatter.js`
- Modify/Create: `tests/dialect-boundary.test.js`
- Modify/Create: `tests/token-boundary.test.js`

- [ ] 清理局部 pass 中残留的 `'generic'` 假默认
- [ ] 所有依赖语法边界的 helper 都显式接收 dialect capabilities 或 tokenizer options
- [ ] 新增样例：
  - Postgres dollar-quoted string
  - MySQL `#` line comment
  - quoted identifier 中包含 keyword
  - 不同 dialect 下的 clause / operator / string 边界

**Exit Criteria:**

- dialect 不再只是入口配置，而成为下游 helper 的真实上下文

---

## Phase 5: whitespace / 输出契约收敛

**Intent:** 解决“空行丢失、尾部固定双换行、CRLF 归一化行为不明确”的体验问题。

**Files:**
- Modify: `lib/core/sql-layout-formatter.js`
- Modify: `lib/core/sql-formatter.js`
- Modify/Create: `tests/pipeline-idempotency.test.js`
- Modify/Create: `tests/formatter-api.test.js`
- Modify/Create: `tests/hive-regression.test.js`

- [ ] 定义输出契约：
  - 保留单个用户空行
  - 尾部只保留一个换行
  - 对 CRLF 输入的策略明确：统一输出 LF，还是保留原行尾风格
- [ ] 统一空白后处理逻辑，避免多个 pass 分散修改换行
- [ ] 为“空行保留”和“尾部换行”新增专门回归

**Validation:**

- `node tests/pipeline-idempotency.test.js`
- `node tests/formatter-api.test.js`
- `npm run test:verify`

**Exit Criteria:**

- 输出空白行为可预测
- 不再制造无意义 diff

---

## Phase 6: VS Code adapter 与 range formatting 契约重构

**Intent:** 解决局部选区格式化缺少安全策略的问题。

**Files:**
- Modify: `lib/adapters/vscode-extension.js`
- Modify/Create: `lib/adapters/range-format-policy.js`
- Modify/Create: `tests/extension-contribution.test.js`
- Modify: `README.md`

- [ ] 明确 `provideDocumentRangeFormattingEdits` 的策略：
  - 方案 A：对非完整 clause / statement 走保守模式，仅做轻量 whitespace / keyword case
  - 方案 B：无法保证安全时直接拒绝并提示
- [ ] 为多选区、片段选区、半个子查询、半个 `WHERE`、半个 `SELECT item` 增加回归
- [ ] adapter 层明确“不安全就不改”的失败策略

**Exit Criteria:**

- range formatting 不再复用 whole-document 激进策略而无边界说明

---

## Phase 7: `unsupportedSyntaxPolicy` 补齐或收缩

**Intent:** 解决“接口看起来成熟，但行为没有真正落地”的问题。

**Files:**
- Modify: `lib/core/sql-canonical-options.js`
- Modify: `lib/adapters/sql-render-options.js`
- Modify/Create: `lib/core/sql-unsupported-policy.js`
- Modify/Create: `tests/unsupported-safety.test.js`
- Modify: `README.md`

- [ ] 明确支持的策略集合，例如：
  - `preserve`
  - `warn`
  - `bail_out`
- [ ] 若短期不实现多策略，则从公开配置/文档中收缩，避免误导
- [ ] 对 unsupported 片段如何 preserve、何时报警、何时拒绝格式化建立统一策略

**Exit Criteria:**

- `unsupportedSyntaxPolicy` 不再是半成品字段

---

## Phase 8: experimental DDL / extract DDL 边界收紧

**Intent:** 继续把 DDL helper 保持在真实能力边界内，避免错误产品预期。

**Files:**
- Modify: `lib/experimental/ddl/sql-ddl-format.js`
- Modify: `lib/experimental/ddl/sql-extract-ddl.js`
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify/Create: `tests/ddl-regression.test.js`
- Modify/Create: `tests/extractddl-safety.test.js`

- [ ] 文档上明确它们是 experimental Hive helper，而不是通用 DDL parser
- [ ] 对 extract DDL 的样本边界写清楚：
  - 只基于最终顶层 `SELECT`
  - alias / simple reference 提取策略
  - 不承诺复杂表达式推导
- [ ] 若未来要扩更强 DDL 能力，应单独立项，不在当前轻量文本处理路径上继续堆补丁

**Exit Criteria:**

- 用户对 DDL 能力的期待与真实实现一致

---

## Phase 9: 错误诊断与可观测性增强

**Intent:** 解决“用户报 formatter 失败时，开发者缺少现场证据”的问题。

**Files:**
- Modify: `lib/adapters/vscode-extension.js`
- Modify/Create: `lib/adapters/formatter-diagnostics.js`
- Modify/Create: `tests/extension-contribution.test.js`

- [ ] 维持“失败时不写入任何修改”的保守策略
- [ ] 为开发者提供受控诊断信息：
  - 记录失败阶段
  - 记录错误 message
  - 可选 debug 开关，不默认污染用户体验
- [ ] 对 adapter 层做更清晰的错误分级：
  - formatter throw
  - VS Code reject edit
  - unsupported / unsafe fragment

**Exit Criteria:**

- 用户失败提示更明确
- 开发者排障成本显著下降

---

## Phase 10: 文档、技术债 guard 与收尾

**Intent:** 把整改结果沉淀为长期维护契约，而不是只停留在代码 diff。

**Files:**
- Modify: `README.md`
- Modify: `docs/technical/sql-formatter-architecture.md`
- Modify: `docs/technical/sql-support-matrix.md`
- Modify/Create: `tests/module-boundary.test.js`
- Modify/Create: `tests/generated-support-matrix.test.js`

- [ ] README 只保留用户关心的行为、配置、experimental 能力说明
- [ ] 技术文档同步说明：
  - token-aware primitive
  - range formatting contract
  - whitespace contract
  - config migration policy
- [ ] 若实现中新增新的底层 primitive 或 adapter policy，必须有对应技术文档和测试 guard

**Exit Criteria:**

- 项目文档、代码结构和测试契约一致

---

## 6. 执行顺序建议

建议严格按以下顺序推进，避免相互踩踏：

1. Phase 0
2. Phase 1
3. Phase 2
4. Phase 3
5. Phase 4
6. Phase 5
7. Phase 6
8. Phase 7
9. Phase 8
10. Phase 9
11. Phase 10

理由：

- 配置面和当前已知复杂 `SELECT` 缺陷优先级最高，直接影响用户体验。
- token-aware primitive 和 dialect 贯穿必须在中段进行，否则前后行为会重复改。
- whitespace、range formatting、unsupported policy 和 DDL 边界属于“系统收口”。

---

## 7. 每阶段统一验收标准

每个阶段结束时，至少满足：

- [ ] 对应代码实现完成
- [ ] 对应回归测试补齐
- [ ] `npm run test:verify` 通过
- [ ] 若涉及 `package.json` / README /技术文档，文档同步完成
- [ ] 没有引入新的未解释兼容分叉

---

## 8. 最终完成标准

本计划全部完成后，应达到以下状态：

- [ ] 设置面只保留一套推荐配置面
- [ ] core formatter 真正变成 token-aware、canonical、dialect-aware
- [ ] 复杂真实 SQL 样本能稳定回归
- [ ] whitespace / range formatting / failure behavior 都有明确契约
- [ ] experimental DDL 能力边界清晰，不再制造错误预期
- [ ] 项目进入“可持续演进”状态，而不是继续靠局部补丁延命

