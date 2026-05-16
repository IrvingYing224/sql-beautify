# SQL Beautify 核心架构重构与长期演进执行计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 彻底解决当前 formatter 的核心矛盾：外层已经引入 token / shield / line model，但核心格式化仍被大规模字符串替换和历史状态机主导。目标不是继续修补，而是把格式化核心重建为“可验证、可扩展、可维护”的结构化格式化系统，同时保留 VS Code 扩展对现有用户的可迁移兼容。

**Architecture:** 以 `vkbeautify.js` 为兼容 API 壳层，重构 `lib/` 下的 SQL formatter 核心。建立统一的 canonical render options、dialect capability registry、clause registry、token-aware operator normalization、line model 驱动的渲染流程，以及更严格的 DDL / Extract DDL 风险隔离。允许删除死代码、重组模块、重写主流程、调整测试结构、修改文档和必要配置；但必须用自动化回归、负向测试和迁移说明证明行为边界。

**Tech Stack:** VS Code extension、CommonJS、Node.js、本地 CLI 回归测试、项目内 formatter 模块、GitHub Actions / VSIX packaging。

## 实施状态更新（2026-05-17）

这份计划已执行完成，并在首次收口后又经历了两轮返工，最终状态如下：

- 已落地 canonical options、dialect / clause / operator registry 和结构化 formatter pipeline。
- `replace_char()`、`condition_wrap()`、`except_subquery()`、`bracket_deep()`、`extra()` 已退出 live formatter path，不再主导实际格式化结果。
- unsupported 结构采用更保守的 opaque 保护策略；`MATCH_RECOGNIZE(...)` 等未建模结构会在 lexical normalize 之前被冻结，避免被关键字大小写、operator spacing 或 clause split 提前改写。
- `extractddl` 已收紧为高置信提取：显式 alias 和简单列引用可提取，复杂无 alias 表达式会直接跳过，不再猜测误导性列名。
- 自动化回归已扩展到 operator matrix、clause registry、select / condition alignment、unsupported safety、extractddl safety、module boundary 等 focused tests。

仍可继续做的工作主要属于“二次清理”而不是本计划阻塞项，例如进一步收缩历史 layout marker cleanup、简化内部兼容桥接、补更强的编辑器集成验证。

---

## 1. 背景与核心判断

当前项目已经完成了一部分正确方向的治理：

- 引入了 `sql-tokenizer.js`
- 引入了 `sql-shield.js`
- 引入了 `sql-line-model.js`
- 引入了 `sql-render-options.js`
- 引入了若干模块化 formatter

但主矛盾没有解决：

- `lib/sql-formatter.js` 仍把大量核心行为交给 `replace_char()`、`get_bracket()`、`special_wrap()`、`bracket_deep()`、`extra()` 这种字符串 pass。
- clause 边界、关键字集合、operator spacing、condition alignment、dialect 兼容等规则散落在多个模块里重复硬编码。
- dialect 对外表现为 `generic / hive / postgres / mysql`，但内部只实现了部分 token 边界保护，没有形成可验证的 clause / operator / keyword / syntax 支持矩阵。
- `extractddl` 在 unsupported 情况下仍会“猜一个结果”，这会产出误导性错误 DDL。

因此，本计划不接受“继续在旧 pass 上补丁式修修补补”的路线。后续执行必须以结构化重建为主。

---

## 2. 执行原则

- [ ] 以结构化替代字符串补丁：新增格式化规则时，优先落到 token / line / clause registry，不再向 `replace_char()` 追加全局正则。
- [ ] 以单一事实源替代多点硬编码：关键字、子句边界、operator 规则、dialect 能力统一集中定义。
- [ ] 以保守失败替代错误猜测：不支持的语法或不可靠提取，不得生成“看起来像对的”错误输出。
- [ ] 以 canonical config 替代历史参数穿透：兼容层可保留，但 formatter 内部只接受语义化配置对象。
- [ ] 以测试矩阵约束行为：不仅测正向样例，还要测 operator、dialect、unsupported、迁移兼容和幂等性。
- [ ] 以迁移清晰度替代隐式行为：语言模式、dialect 默认值、experimental 能力边界、配置优先级必须明示。

---

## 3. 本次重构必须解决的问题清单

### 3.1 已证实问题

- [ ] `sqlBeautify.dialect` 的产品承诺与真实能力不一致，且默认值与“Hive 优先”定位冲突。
- [ ] `hive-sql` 语言模式未自动映射到 Hive dialect。
- [ ] MySQL `<=>` 被错误格式化为 `<= >`。
- [ ] `QUALIFY`、`RECURSIVE`、`VALUES` 等子句/关键字没有形成统一支持模型。
- [ ] `extractddl` 在无 alias 或复杂表达式场景会错误猜列名。
- [ ] 关键语义规则散落在多个模块，存在重复实现和边界不一致。

### 3.2 结构性风险

- [ ] `replace_char()` 作为“规则熔炉”承担过多职责，继续叠加规则会显著放大回归风险。
- [ ] clause 判断与关键字判断分散在 `sql-normalize-passes.js`、`sql-select-formatter.js`、`sql-condition-formatter.js`、`sql-keywords.js` 等多个模块。
- [ ] 历史命名如 `bracket_char`、`as_loc_cnt`、`comma_location` 仍直接渗透到内部逻辑。
- [ ] `String.prototype.times` 属于全局污染，增加未来维护与测试不确定性。
- [ ] DDL / Extract DDL 与主 SQL formatter 的成熟度不同，但仍处于相近产品暴露面。

### 3.3 长期演进阻碍

- [ ] 想继续扩展 dialect、operator、clause 支持时，需要在多个模块同步补丁，成本高且容易漏。
- [ ] 测试更多是样例回归，缺少系统级 matrix coverage。
- [ ] 当前架构不利于定义“支持什么、不支持什么、遇到 unsupported 怎么处理”的明确边界。

---

## 4. 目标架构

最终目标架构应接近以下形态。命名允许微调，但职责边界不得模糊。

### 4.1 顶层兼容层

- `vkbeautify.js`
  - 只负责兼容公开 API：
    - `sql(text, uppercase, comma_location, bracket_char, as_loc_cnt, case_when_then_wrap_length, advanced_options)`
    - `sqlddl(text)`
    - `extractddl(text)`
  - 不再包含任何真实格式化逻辑。
  - 只做 legacy args -> canonical options 转换，并调用 `lib/` 中的核心实现。

### 4.2 Canonical 配置层

- `lib/sql-render-options.js`
  - 统一内部 canonical options：
    - `keywordCase`
    - `commaStyle`
    - `indentStyle`
    - `maxAlignWidth`
    - `caseWhenThenWrapLength`
    - `dialect`
    - `languageMode`
    - `unsupportedSyntaxPolicy`
  - 扩展层负责读取 VS Code 配置。
  - formatter 内部禁止再使用 `uppercase`、`comma_location`、`bracket_char`、`as_loc_cnt` 这类历史语义字段。

### 4.3 Dialect / Clause 能力注册层

- `lib/sql-dialect.js`
  - 统一维护 dialect capability registry。
  - 不只定义 token boundary，还要定义：
    - quote / comment / operator 能力
    - keyword set 扩展
    - clause support matrix
    - unsupported syntax policy

- `lib/sql-clause-registry.js`（新建）
  - 单一事实源定义 clause：
    - canonical keyword text
    - clause start / clause end
    - select-block 边界
    - condition-block 边界
    - alignment eligibility
  - 支持 generic / hive / postgres / mysql 差异映射。

- `lib/sql-operator-registry.js`（新建）
  - 集中定义 operator spacing / no-split / normalize 规则。
  - 至少覆盖：
    - `=`, `!=`, `<>`, `<=`, `>=`
    - `<=>`
    - `:=`
    - `->`, `->>`
    - `::`
    - `||`
    - `#>`, `#>>`

### 4.4 结构化格式化核心

- `lib/sql-tokenizer.js`
  - 继续作为 token 基础。
  - 必须明确“哪些只是 lexical token，哪些会进入 higher-level formatting”。

- `lib/sql-shield.js`
  - 只负责不可改写 token 的保护/恢复。
  - 不再承担格式化副作用。

- `lib/sql-line-model.js`
  - 统一 code/comment 分离、空行、独立注释、trailing comment 建模。

- `lib/sql-formatter.js`
  - 负责总 orchestration。
  - 只串联“结构化 pass”。
  - 不允许继续依赖大型字符串 replace 熔炉。

- `lib/sql-lexical-normalizer.js`（新建）
  - 只做安全的 token-aware whitespace/operator normalize。

- `lib/sql-clause-splitter.js`（新建）
  - 基于 token / clause registry 决定 clause 边界，不使用分散正则。

- `lib/sql-select-formatter.js`
  - 只负责 SELECT / GROUP BY list 的结构化排版与 AS 对齐。
  - 不再混入老式 `special_wrap` 兼容逻辑。

- `lib/sql-condition-formatter.js`
  - 只负责 WHERE / ON / HAVING 条件树或条件行块对齐。
  - Clause 识别来自 registry，不再自带一套硬编码 start/end 词表。

- `lib/sql-case-formatter.js`
  - 只负责 CASE 块解析和渲染。
  - 必须清晰处理 root CASE、nested CASE、ELSE、comments、suffix。

- `lib/sql-comment-formatter.js`
  - 只负责 comment marker spacing、独立注释恢复、trailing comment 对齐。

### 4.5 DDL 隔离层

- `lib/sql-ddl-formatter.js`
  - 明确仅为 Hive DDL experimental。
  - `ddl()` 与 `extractddl()` 内部逻辑分离。
  - `extractddl()` 默认只提取高置信字段，不再猜复杂表达式列名。

---

## 5. 产品与兼容策略

### 5.1 用户可见边界

- [ ] 主能力：SQL formatting。
- [ ] 次能力：Hive DDL formatting（experimental）。
- [ ] 次能力：Hive DDL extraction（experimental）。
- [ ] `dialect` 解释改为“best-effort syntax boundary and formatting profile”，不再暗示完整 parser 级支持。

### 5.2 语言模式策略

- [ ] `sql` 默认 `generic`
- [ ] `hive-sql` 默认 `hive`
- [ ] 用户显式配置的 `sqlBeautify.dialect` 优先于语言模式默认值
- [ ] 如未来支持更多 languageId，需通过映射表显式声明，不允许隐式推断

### 5.3 历史配置兼容

- [ ] 外部继续兼容：
  - `extension.uppercase`
  - `extension.comma_location`
  - `extension.bracket_char`
  - `extension.as_loc_cnt`
  - `extension.case_when_then_wrap_length`
- [ ] 但内部 canonical options 不再传播这些命名。
- [ ] README 和配置文案中把新配置作为主入口，旧配置作为兼容 fallback 说明。

### 5.4 Unsupported 策略

- [ ] 格式化器遇到 unsupported 语法时优先保守输出，不擅自重排高风险结构。
- [ ] `extractddl` 遇到复杂表达式且无 alias 时，默认跳过或生成明确占位，不得返回误导性列名。
- [ ] unsupported 行为必须有测试覆盖与文档说明。

---

## 6. 分阶段执行计划

## Phase 0: 基线冻结与证据固化

**Files:**
- Modify: `package.json`
- Create/Modify: `tests/*.test.js`

- [ ] 运行当前基线：

```bash
npm run test:verify
```

- [ ] 新增并固化以下失败/风险测试：
  - dialect default by language mode
  - MySQL `<=>`
  - PostgreSQL `QUALIFY` / `::` / `->>` / `#>>`
  - `WITH RECURSIVE`
  - `VALUES`
  - unsupported extractddl with no alias
  - command path vs provider path consistency
  - unsupported syntax 保守失败

- [ ] 为当前已证实问题建立“先失败后修复”的 targeted tests。
- [ ] 记录哪些行为是现有设计刻意保留，哪些是明确待改变。

**Exit Criteria:**

- 所有已知问题都有对应测试或明确 TODO 测试项。
- 团队能区分“兼容保留行为”和“本次允许破坏性修正行为”。

---

## Phase 1: 配置与入口模型重建

**Files:**
- Modify: `extension.js`
- Modify: `lib/sql-render-options.js`
- Modify: `package.json`
- Modify: `tests/config-options.test.js`
- Modify/Create: `tests/extension-contribution.test.js`

- [ ] 把 `sql-render-options.js` 重构为 canonical options 模型。
- [ ] 扩展层负责：
  - 读取 `sqlBeautify.*`
  - 读取 legacy `extension.*`
  - 判断显式性
  - 结合 `document.languageId` 提供默认 dialect
- [ ] `formatSql()` 支持显式传入上下文信息，不再只能从全局配置静态推断。
- [ ] 为 document formatter / range formatter / command path 建立统一入口，避免不同路径各长各的逻辑。
- [ ] 补测试：
  - `hive-sql` 默认 Hive
  - 用户显式 dialect 覆盖语言模式默认值
  - 新旧配置优先级矩阵
  - 多选区命令行为与 provider 行为边界

**Exit Criteria:**

- formatter 内部只消费 canonical options。
- `hive-sql` 默认 dialect 行为与产品文档一致。

---

## Phase 2: Dialect / Clause / Operator Registry 建立

**Files:**
- Create: `lib/sql-clause-registry.js`
- Create: `lib/sql-operator-registry.js`
- Modify: `lib/sql-dialect.js`
- Modify: `lib/sql-keywords.js`
- Modify/Create: `tests/dialect-boundary.test.js`
- Create: `tests/operator-matrix.test.js`
- Create: `tests/clause-registry.test.js`

- [ ] 把 keyword 集从单纯大小写列表升级为 registry 驱动。
- [ ] clause registry 统一维护：
  - clause names
  - clause boundaries
  - select-block terminators
  - condition-block resets
  - alignment scopes
- [ ] operator registry 统一维护：
  - no-split operator
  - spacing policy
  - dialect availability
- [ ] 修复 `<=>`、`::`、`#>>`、`#>`、`->`、`->>` 等 operator 问题。
- [ ] `QUALIFY`、`RECURSIVE`、`VALUES` 至少做到：
  - 不被错误拆坏
  - keyword case 可控
  - clause 边界行为清楚

**Exit Criteria:**

- clause / operator 规则不再分散于多个 formatter 模块各自维护。
- 新增 clause 或 operator 时，不需要到多个模块重复补同一组正则。

---

## Phase 3: 主格式化管线结构化重写

**Files:**
- Create: `lib/sql-lexical-normalizer.js`
- Create: `lib/sql-clause-splitter.js`
- Modify: `lib/sql-formatter.js`
- Modify: `lib/sql-normalize-passes.js`
- Modify: `lib/sql-select-formatter.js`
- Modify: `lib/sql-condition-formatter.js`
- Modify: `lib/sql-comment-formatter.js`
- Modify: `lib/sql-case-formatter.js`
- Modify: `tests/pipeline-idempotency.test.js`

- [ ] 将主 pipeline 重写为明确阶段：
  - protect
  - lexical normalize
  - clause split
  - structure-aware formatting
  - alignment
  - keyword case
  - restore

- [ ] `replace_char()` 不再作为核心规则入口。
- [ ] `get_bracket()`、`special_wrap()`、`extra()`、`condition_wrap()` 中的高价值逻辑要么被结构化迁移，要么被删除。
- [ ] 对老 pass 做清理：
  - 不再被主流程调用的函数必须删除或标记淘汰
  - 不允许保留一套“看起来还在工作、实际没人敢动”的历史实现

- [ ] 建立更强幂等性测试：
  - 格式化两次输出一致
  - clause registry 扩展后不破坏已有 Hive 回归
  - protected token restore 前后语义文本不变

**Exit Criteria:**

- 主格式化逻辑不再依赖规则熔炉式全局字符串替换。
- 每个阶段职责清晰且可单测。

---

## Phase 4: CASE / SELECT / 条件 / 注释职责彻底收敛

**Files:**
- Modify: `lib/sql-case-formatter.js`
- Modify: `lib/sql-select-formatter.js`
- Modify: `lib/sql-condition-formatter.js`
- Modify: `lib/sql-comment-formatter.js`
- Modify/Create: `tests/case-when.test.js`
- Modify/Create: `tests/comment-alignment.test.js`
- Create: `tests/select-alignment.test.js`
- Create: `tests/condition-alignment.test.js`

- [ ] CASE 解析与渲染必须完全独立，不再依赖注释模块或 select 模块中的边缘逻辑。
- [ ] SELECT list 格式化只关心：
  - item split
  - comma style
  - AS alignment
  - item comment alignment
- [ ] condition formatter 只关心：
  - WHERE / ON / HAVING block
  - AND / OR layout
  - CASE in condition 的缩进处理
- [ ] comment formatter 只关心：
  - standalone comment restore
  - trailing comment spacing
  - alignment groups

**Exit Criteria:**

- 模块之间不再互相借壳解析对方语义。
- 阅读单个模块时能清楚知道它负责什么，不负责什么。

---

## Phase 5: DDL / Extract DDL 重构与风险隔离

**Files:**
- Modify: `lib/sql-ddl-formatter.js`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify/Create: `tests/ddl-regression.test.js`
- Create: `tests/extractddl-safety.test.js`

- [ ] 将 `ddl()` 与 `extractddl()` 拆成内部独立逻辑。
- [ ] `extractddl()` 引入高置信策略：
  - 显式 alias 直接提取
  - 无 alias 简单列引用可选提取
  - 复杂表达式默认跳过
  - 必要时生成 `_col_N` 也必须可配置且有文档说明
- [ ] experimental 文案与能力边界对齐：
  - 不再把 Extract DDL 暗示成通用列推导器
  - README 明确列出受支持/不保证支持的场景

**Exit Criteria:**

- `extractddl` 不再产出明显误导的错误 DDL。
- DDL 能力边界在代码、测试、文档上保持一致。

---

## Phase 6: 死代码清理、全局污染清理与边界收口

**Files:**
- Modify: `lib/sql-format-utils.js`
- Modify: `lib/sql-normalize-passes.js`
- Modify: `lib/sql-select-formatter.js`
- Modify: `lib/sql-comment-formatter.js`
- Modify: `lib/sql-ddl-formatter.js`
- Create: `tests/module-boundary.test.js`

- [ ] 移除 `String.prototype.times` 依赖，改为局部 helper。
- [ ] 删除未使用或已被替代的函数，例如：
  - `modify_comma_to_speicific`
  - `newsql`
  - 重复包装的 `split_code_and_comment`
  - 仅为旧逻辑残留的兼容函数
- [ ] 明确 module boundary：
  - shared utils 在单独模块
  - formatter 模块只依赖 shared utils，不互相复制逻辑

**Exit Criteria:**

- 代码库中不存在明显历史残骸和全局污染点。
- module boundary 测试覆盖关键导出与职责边界。

---

## Phase 7: 测试体系升级

**Files:**
- Modify: `package.json`
- Create/Modify: `tests/*.test.js`

- [ ] 建立以下测试层级：
  - smoke regression
  - syntax matrix
  - operator matrix
  - dialect matrix
  - config precedence matrix
  - unsupported / safety tests
  - idempotency tests
  - extension entry tests

- [ ] `test:verify` 重新组织为可读且可定位失败来源的序列。
- [ ] 若必要，增加 `npm run test:focused:*` 便于局部重构阶段快速回归。

**Exit Criteria:**

- 测试能清楚回答：
  - 我们支持什么
  - 我们不支持什么
  - unsupported 时是否保守
  - 新旧配置与入口是否一致

---

## Phase 8: 文档、迁移说明与发布前硬化

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `package.json`
- Optional Modify: `.github/workflows/*`

- [ ] README 重写以下部分：
  - 产品定位
  - dialect 能力边界
  - `hive-sql` 默认行为
  - 新旧配置说明
  - DDL / Extract DDL experimental 说明
- [ ] CHANGELOG 说明行为变化与可能的兼容差异。
- [ ] 如测试组织或 package 行为变化影响 CI，更新 workflow。

**Exit Criteria:**

- 文档不再承诺超过代码真实能力的功能。
- 用户可以明确理解升级后的行为变化。

---

## 7. 测试矩阵要求

## 7.1 必测语法类别

- [ ] 标准 SELECT / FROM / WHERE / GROUP BY / ORDER BY
- [ ] JOIN / ON / nested subquery
- [ ] CASE WHEN / nested CASE / CASE in condition
- [ ] CTE / WITH RECURSIVE
- [ ] window functions / `OVER(...)`
- [ ] QUALIFY
- [ ] VALUES
- [ ] Hive:
  - `LATERAL VIEW`
  - `POSEXPLODE`
  - `INSERT OVERWRITE ... PARTITION`
- [ ] PostgreSQL:
  - dollar-quoted strings
  - `->`, `->>`, `#>`, `#>>`, `::`
- [ ] MySQL:
  - `#` comments
  - `<=>`
  - `:=`

## 7.2 必测安全边界

- [ ] strings / comments / quoted identifiers 内部不得被误格式化
- [ ] unsupported 语法不应被破坏性重写
- [ ] `extractddl` 不得对复杂表达式瞎猜列名
- [ ] formatter 二次执行必须幂等

## 7.3 必测配置矩阵

- [ ] `sqlBeautify.*`
- [ ] `extension.*`
- [ ] 显式新配置覆盖旧配置
- [ ] 未显式设置时旧配置仍生效
- [ ] `sql` vs `hive-sql` 默认 dialect

---

## 8. 验收标准

本计划执行完成后，必须同时满足：

- [ ] `npm run test:verify` 全通过。
- [ ] 新增 matrix / safety / unsupported 测试通过。
- [ ] MySQL `<=>`、PostgreSQL `->>` 等已证实兼容问题修复。
- [ ] `hive-sql` 默认 Hive dialect 行为落地并被测试证明。
- [ ] `extractddl` 不再输出明显错误猜测列名。
- [ ] 主格式化流程不再依赖 `replace_char()` 这类规则熔炉驱动核心结果。
- [ ] 新增 clause / operator / dialect 规则时，修改点主要落在 registry，而不是多个 formatter 模块同时打补丁。
- [ ] README / CHANGELOG / package 配置描述与代码行为一致。

---

## 9. 明确不接受的做法

- [ ] 不接受继续把新规则堆进 `replace_char()`。
- [ ] 不接受“为了兼容旧行为”而保留两套核心 formatter 并长期并存。
- [ ] 不接受 unsupported 语法下的误导性猜测输出。
- [ ] 不接受只改 README 不改真实行为。
- [ ] 不接受仅靠人工 spot-check 宣称重构完成。

---

## 10. 推荐执行顺序

1. 先补失败测试与语言模式 / dialect 行为测试。
2. 然后重建 canonical options 与入口层。
3. 再建立 clause / operator / dialect registry。
4. 再重写主 pipeline，消灭规则熔炉。
5. 然后清理 CASE / SELECT / condition / comment 职责边界。
6. 再收紧 DDL / Extract DDL。
7. 最后清死代码、补文档、跑全量验证。

---

## 11. 对执行者的要求

- [ ] 每个 phase 开始前先读相关模块和测试，不允许盲改。
- [ ] 每个 phase 结束后必须更新或新增对应测试。
- [ ] 如出现行为变化，必须写明：
  - 这是修 Bug
  - 这是有意破坏性调整
  - 这是 unsupported 场景收紧
- [ ] 若某一阶段引发大面积回归，优先回到 registry / pipeline / boundary 设计层修复，不回退到堆更多字符串补丁。
