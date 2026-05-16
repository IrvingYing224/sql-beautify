# SQL Beautify 二次洁净化重构执行计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在主矛盾已经解决的基础上，继续清除剩余历史包袱，把 formatter 从“架构已经正确但仍有残余历史痕迹”推进到“边界严格、职责纯净、对长期迭代和洁癖式维护都友好”的状态。

**Architecture:** 继续保持 canonical options + registry-driven structured pipeline 这条主线，但这次不再以“保证可用”为目标，而是以“消灭残余耦合、消灭伪 SQL marker、消灭 legacy 语义渗透、明确 core / adapter / experimental 边界”为目标。允许大幅重组 `lib/` 目录、删除中间兼容层、拆文件、重写 layout/comment 渲染路径，只要求对外用户接口保持兼容，并用更严格的测试证明旧残留真的退出了 live path。

**Tech Stack:** VS Code extension、CommonJS、Node.js、本地 CLI 回归测试、项目内 formatter 模块、VSIX packaging、registry-driven formatter core。

---

## 1. 背景与本次计划的核心判断

上一轮重构已经解决了最重要的问题：

- `replace_char()`、`condition_wrap()`、`except_subquery()`、`bracket_deep()`、`extra()` 已退出 live formatter path。
- canonical options、dialect / clause / operator registry、unsupported opaque protection、`extractddl` 高置信收紧、focused regressions 都已落地。

但从苛刻的长期代码洁癖标准看，当前仓库仍然保留了几类明确的残余技术债：

- `lib/sql-comment-formatter.js` 仍通过 `reshape_comment()` 注入 `--WHEREiscomment`、`{comma}`、`shouldhavenbehind`、`{.*.*}` / `{*.*.}` 这类伪 SQL marker 协调 comment / layout 行为。
- `lib/sql-layout-formatter.js` 仍通过正则链清理这些 marker，并且 `indent_nested_blocks()` 仍以硬编码 `\t` 作为缩进单位，再由主流程末尾统一替换为空格。
- `lib/sql-clause-splitter.js` 仍显式识别 `shouldhavenbehind`，说明 marker 已经跨模块泄漏，不是局部技术债。
- `lib/sql-formatter.js` 仍调用 `sqlRenderOptions.to_legacy(config)`，并把 `legacy.case_when_then_wrap_length`、`legacy.as_loc_cnt` 继续传入 core passes，说明 canonical config 还没有做到真正 end-to-end。
- `lib/sql-select-formatter.js` 仍暴露并被 live path 调用 `convert_comma_loaction()` 这种 typo + legacy naming API。
- `lib/sql-ddl-formatter.js` 仍把 `ddl()`、`extractddl()`、DDL 解析辅助逻辑放在同一个文件里，并与主 SQL formatter 并列放在核心 `lib/` 目录，experimental 边界仍不够清晰。
- `extension.js` 仍同时承担命令注册、provider 注册、config 读取、legacy explicitness 判断和 document path orchestration，adapter 边界还不够干净。

因此，这份计划不是“继续微调现有实现”，而是明确允许并鼓励继续进行以下级别的重构：

- 删除或替换历史 marker 机制
- 删除或迁移 legacy bridge
- 拆分 `extension.js`
- 重构 layout / comment 渲染模型
- 重组 `lib/` 目录，把 core / adapter / experimental 显式分层

---

## 2. 本次二次清理的执行标准

本计划完成后，应尽量满足以下标准：

- [ ] live formatter path 中不再存在伪 SQL marker 协作机制，例如 `WHEREiscomment`、`shouldhavenbehind`、`{comma}`、`UNIONALLALL`、`{.*.*}` 这类历史占位物。
- [ ] core formatter modules 的输入输出统一为 canonical 语义对象或明确的结构化数据，不再接受 legacy scalar 参数名作为内部事实源。
- [ ] 缩进和 layout 渲染不再依赖“先全部用 tab，再在末尾全局替换为空格”的后处理策略。
- [ ] experimental DDL 逻辑不再与主 SQL formatter 在同一责任层混放。
- [ ] README 只保留用户说明；技术支持边界、registry 细节、support matrix、module contract 放到维护者文档或生成文档。
- [ ] 验证链路不仅证明“输出没坏”，还要证明“旧脏路径真的退出了 live path，且新边界在代码结构上可被持续检查”。

---

## 3. 本次重构允许的破坏性整理范围

本次计划明确允许：

- [ ] 大幅重组 `lib/` 目录，只要对外 API 与 VS Code 扩展命令保持兼容。
- [ ] 删除已经只剩历史意义的 helper、marker、shim、拼写错误 API。
- [ ] 把当前单文件职责过重的模块拆成多个小文件。
- [ ] 新增内部技术文档、维护者文档、生成脚本和更强的 module-boundary / integration tests。
- [ ] 为了得到更洁净的长期结构，允许修改大量测试用例和测试工具，只要行为边界被更清楚地证明。

本次计划不以“尽量少改”为目标；优先级是长期结构正确，而不是短期 diff 小。

---

## 4. 目标架构（本次二次清理之后）

### 4.1 Core 层

只保留真正的 SQL formatting core：

- tokenization / shielding
- canonical options
- registry lookup
- clause split
- structured select / condition / case / comment passes
- layout model / renderer
- keyword case

Core 层不得：

- 感知 VS Code 配置读取细节
- 感知 legacy `extension.*` 键名
- 依赖实验性 DDL 逻辑
- 通过伪 SQL marker 串联跨模块语义

### 4.2 Adapter 层

显式隔离：

- VS Code config adapter
- VS Code command/provider adapter
- `vkbeautify` legacy args adapter

Adapter 层负责兼容和参数转换，但不得成为格式化语义逻辑的事实源。

### 4.3 Experimental 层

把 Hive DDL formatting / extract DDL 显式移入 experimental boundary：

- 与主 SQL formatter 在目录、文档、测试上都清楚分层
- 保留对外命令和 API，但内部实现不再和 core formatter 模块混放

### 4.4 Contract / Verification 层

新增长期维护契约：

- support matrix 文档或生成产物
- live path dependency guard
- marker leakage guard
- extension host / package smoke

---

## 5. 分阶段执行计划

## Phase 0: 基线冻结与残余技术债证据固化

**Intent:** 先把“还剩哪些脏点”写成失败测试和结构性检查，避免后续二次清理又被“功能没坏就行”稀释掉。

**Files:**
- Modify: `package.json`
- Modify/Create: `tests/module-boundary.test.js`
- Modify/Create: `tests/pipeline-idempotency.test.js`
- Modify/Create: `tests/extension-contribution.test.js`
- Create: `tests/layout-marker-leakage.test.js`
- Create: `tests/canonical-core-boundary.test.js`

- [ ] 跑当前基线：

```bash
npm run test:verify
```

- [ ] 补充“残余技术债仍存在”的结构性检查：
  - `lib/sql-formatter.js` live path 仍调用 `sqlRenderOptions.to_legacy(...)`
  - `lib/sql-formatter.js` live path 仍调用 `convert_comma_loaction(...)`
  - `lib/sql-comment-formatter.js` 仍定义 `reshape_comment(...)`
  - `lib/sql-layout-formatter.js` 仍清理 `WHEREiscomment` / `shouldhavenbehind` / `{comma}`
  - `lib/sql-clause-splitter.js` 仍识别 `shouldhavenbehind`

- [ ] 新增 marker leakage regression：
  - 格式化包含 `WHEREiscomment`
  - 格式化包含 `shouldhavenbehind`
  - 格式化包含 `{comma}`
  - 格式化包含 `UNIONALLALL`
  - 断言这些字面量不会因为内部 marker 机制被误恢复、误清理或误改写

- [ ] 新增 canonical purity regression：
  - `sqlFormatter.format_sql(text, canonicalOptions)` 不应再在内部回退到 legacy naming
  - live formatter path 不应再依赖 `to_legacy`
  - downstream formatters 的公开内部接口应逐步切到 canonical config object

- [ ] 把 `npm run package:vsix` 纳入本次阶段性基线，验证大重组不会让打包清单和入口失控。

**Exit Criteria:**

- 所有“二次清理要消灭的历史残留”都有对应失败测试或结构性 guard。
- 团队可以明确区分：
  - 输出正确但结构仍脏
  - 结构已收敛且有 guard 防止回流

---

## Phase 1: Canonical Options 真正贯穿 Core

**Intent:** 把 canonical config 从“入口和主 formatter 知道”推进到“所有 core passes 都只认 canonical 语义”，彻底切断 `to_legacy()` 在 live path 的存在理由。

**Files:**
- Modify: `lib/sql-render-options.js`
- Modify: `lib/sql-formatter.js`
- Modify: `lib/sql-case-formatter.js`
- Modify: `lib/sql-select-formatter.js`
- Modify: `lib/sql-comment-formatter.js`
- Modify: `lib/sql-condition-formatter.js`
- Modify: `lib/sql-layout-formatter.js`
- Modify: `vkbeautify.js`
- Modify: `extension.js`
- Modify/Create: `tests/config-options.test.js`
- Modify/Create: `tests/canonical-core-boundary.test.js`

- [ ] 将 `lib/sql-render-options.js` 拆成两个概念层：
  - canonical options normalization
  - legacy args / legacy settings adapter

- [ ] 目标状态：
  - `lib/sql-formatter.js` 不再调用 `to_legacy()`
  - `sql-case-formatter` 接收 `config.caseWhenThenWrapLength`
  - `sql-select-formatter` / `sql-comment-formatter` 接收 `config.maxAlignWidth`
  - `sql-layout-formatter` 接收 `config.indentStyle` 或明确的 `indentUnit`

- [ ] 把 typo API `convert_comma_loaction()` 改名为语义化名字，例如：
  - `apply_trailing_comma_style()`
  - 或 `render_trailing_commas()`

- [ ] 清理 core 模块内部还在传播的 legacy 术语：
  - `uppercase`
  - `comma_location`
  - `bracket_char`
  - `as_loc_cnt`
  - `case_when_then_wrap_length`

- [ ] 把 legacy 兼容收敛到 adapter 边界：
  - `vkbeautify.js` 负责 legacy positional args -> canonical options
  - `extension.js` 或新的 VS Code config adapter 负责 `sqlBeautify.*` / `extension.*` -> canonical options
  - core formatter 不再感知 legacy naming

**Exit Criteria:**

- `sql-formatter.js` live path 中不再出现 `to_legacy()`
- core modules 的参数命名和内部字段全部切到 canonical 语义
- typo API 从 live path 消失

---

## Phase 2: 彻底拆掉 Comment / Layout 的伪 SQL Marker 机制

**Intent:** 把 `reshape_comment()`、`WHEREiscomment`、`{comma}`、`shouldhavenbehind` 一整套历史协作机制从系统里拔掉。只要这套机制还在，formatter 就还没有达到真正的洁净状态。

**Files:**
- Modify: `lib/sql-comment-formatter.js`
- Modify: `lib/sql-layout-formatter.js`
- Modify: `lib/sql-clause-splitter.js`
- Modify: `lib/sql-line-model.js`
- Modify/Create: `lib/sql-comment-model.js`
- Modify/Create: `lib/sql-layout-model.js`
- Modify: `lib/sql-format-context.js`
- Modify/Create: `tests/layout-marker-leakage.test.js`
- Modify: `tests/module-boundary.test.js`
- Modify: `tests/pipeline-idempotency.test.js`

- [ ] 设计新的 comment/layout data flow：
  - comment 不再通过伪 SQL 字符串编码语义
  - trailing comment、standalone comment、comment-after-comma、comment-after-paren 等状态以结构化元数据表达

- [ ] 替换 `reshape_comment()`：
  - 不再把 `-- WHERE` 改成 `--WHEREiscomment`
  - 不再把 `,` 改成 `{comma}`
  - 不再把 `(` / `)` 改成 `{.*.*}` / `{*.*.}`
  - 不再附加 `shouldhavenbehind`

- [ ] 目标是让 `sql-comment-formatter` 与 `sql-layout-formatter` 通过显式结构交互，而不是通过“我往字符串里塞个假 token，你再用正则猜回来”交互。

- [ ] 清理 `sql-clause-splitter.js` 中对 `shouldhavenbehind` 的识别逻辑，证明 marker 没有跨模块残留。

- [ ] 如果需要新的中间结构，优先建立：
  - `sql-comment-model.js`
  - `sql-layout-model.js`
  - 或扩展 `sql-line-model.js`

- [ ] 为“marker 彻底消失”增加 hard guard：
  - live path source graph 里不再出现 `reshape_comment`
  - 不再出现 `restore_reshaped_comment_markers`
  - 不再出现 `WHEREiscomment`
  - 不再出现 `shouldhavenbehind`
  - 不再出现 `{comma}`

**Exit Criteria:**

- live formatter path 不再依赖任何伪 SQL marker
- layout/comment 交互基于结构化数据，而不是 marker string 协议

---

## Phase 3: Layout Renderer 纯化，移除 Tab 后替换和文本补丁式渲染

**Intent:** 让 layout 成为真正的 renderer，而不是“前面先随便拼一个 tab 风格字符串，最后再全局修空格和 marker”。

**Files:**
- Modify: `lib/sql-layout-formatter.js`
- Modify/Create: `lib/sql-renderer.js`
- Modify: `lib/sql-formatter.js`
- Modify: `lib/sql-select-formatter.js`
- Modify: `lib/sql-comment-formatter.js`
- Modify/Create: `tests/select-alignment.test.js`
- Modify/Create: `tests/condition-alignment.test.js`
- Modify/Create: `tests/layout-marker-leakage.test.js`

- [ ] 把 `indent_nested_blocks()` 从“硬编码 tab 缩进器”升级为 canonical renderer：
  - 明确 `indentUnit`
  - 不再依赖 `if (config.indentStyle === 'space') replace(/\t/g, '    ')`

- [ ] 如果需要，新增 `lib/sql-renderer.js` 承接最终字符串渲染，把职责从 `sql-layout-formatter.js` 分出来：
  - 缩进
  - 语句间空行
  - clause 间距
  - 逗号风格渲染

- [ ] 把 comma style 处理从末尾字符串转换迁移到结构化渲染阶段，删除 live path 对 `convert_comma_loaction()` 的任何依赖。

- [ ] 让 statement gap / select-after-statement gap 等规则基于明确的 statement model / clause registry，而不是散落在清理阶段的文本逻辑。

- [ ] 重新审视 `UNION ALL`、`;` 间距、`SET` 语句堆叠、select block 起止空行等布局行为，确保它们属于 renderer 规则，而不是 marker cleanup 的副作用。

**Exit Criteria:**

- 主流程末尾不存在全局 tab -> spaces 替换
- comma style 在 renderer 中完成，而不是 post-hoc 文本改写
- layout formatter / renderer 不再承担语义修补职责

---

## Phase 4: Core / Adapter / Experimental 目录与依赖边界重组

**Intent:** 不是简单拆文件，而是让目录结构本身表达架构边界，避免未来维护时再把 experimental、adapter、core 搅回一起。

**Files:**
- Modify/Create: `lib/core/**/*`
- Modify/Create: `lib/adapters/**/*`
- Modify/Create: `lib/experimental/ddl/**/*`
- Modify: `extension.js`
- Modify: `vkbeautify.js`
- Modify/Create: `tests/module-boundary.test.js`
- Modify/Create: `tests/extension-contribution.test.js`
- Modify/Create: `tests/ddl-regression.test.js`

- [ ] 把 VS Code 相关逻辑从 `extension.js` 中拆出：
  - config adapter
  - command / provider registration
  - range selection / edit orchestration

- [ ] 目标是让 `extension.js` 接近一个薄壳：
  - 激活
  - 注册
  - 组合 adapter

- [ ] 把 experimental DDL 明确移入单独边界，例如：
  - `lib/experimental/ddl/sql-ddl-format.js`
  - `lib/experimental/ddl/sql-extract-ddl.js`
  - `lib/experimental/ddl/sql-ddl-shared.js`

- [ ] 根据需要决定是否保留原路径 shim：
  - 如果内部 require 已全部迁移，优先删掉旧 shim
  - 如果暂时保留 shim，shim 只能是单行 re-export，不得包含真实逻辑

- [ ] 加强 module boundary tests：
  - core formatter 不得 import adapter 层
  - core formatter 不得 import experimental DDL 层
  - extension adapter 可依赖 core，但 core 不得反向感知 extension adapter

**Exit Criteria:**

- 目录结构清楚表达 core / adapter / experimental 分层
- `extension.js` 不再是职责混杂的大入口
- DDL 与主 SQL formatter 的边界在代码组织上明确可见

---

## Phase 5: Support Contract、维护者文档与更强验证链路

**Intent:** 把“仓库现在实际上支持什么、为什么能相信它”写进机器可检查的契约和维护者文档，而不是只留在口头共识里。

**Files:**
- Create: `docs/technical/sql-support-matrix.md`
- Create: `docs/technical/sql-formatter-architecture.md`
- Create/Modify: `scripts/generate-support-matrix.js`
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `package.json`
- Modify/Create: `tests/module-boundary.test.js`
- Modify/Create: `tests/extension-contribution.test.js`
- Modify/Create: `tests/generated-support-matrix.test.js`

- [ ] 建立面向维护者的技术文档：
  - formatter pipeline 图
  - core / adapter / experimental 边界
  - registry contract
  - unsupported policy

- [ ] 建立 support matrix 产物，至少覆盖：
  - dialect
  - clause
  - operator
  - unsupported 保守策略
  - experimental DDL 范围

- [ ] 优先从 registry 生成技术文档或中间 JSON，而不是再手写一份容易过期的矩阵。

- [ ] README 继续只保留用户说明，不回填实现细节；技术细节统一放到 `docs/technical/`。

- [ ] 把验证链路提升到“结构 + 行为 + 打包”三层：
  - `npm run test:verify`
  - `npm run package:vsix`
  - generated support matrix freshness check
  - extension contribution / activation smoke

**Exit Criteria:**

- 维护者文档与 registry contract 同步
- README 不再承担技术设计说明职责
- 支持边界和 unsupported 策略可查、可测、可生成

---

## 6. 最终验收标准

只有同时满足下面这些条件，才算这份“二次清理计划”真正完成：

- [ ] live formatter path source graph 中不再出现：
  - `to_legacy`
  - `reshape_comment`
  - `restore_reshaped_comment_markers`
  - `convert_comma_loaction`
  - `WHEREiscomment`
  - `shouldhavenbehind`
  - `{comma}`
  - `UNIONALLALL`

- [ ] 主流程不再依赖：
  - tab-first / replace-later 缩进策略
  - marker-based comment/layout 协作
  - legacy scalar naming 作为 core formatter 输入

- [ ] core / adapter / experimental 的目录和依赖关系可被测试验证。

- [ ] `npm run test:verify` 通过。
- [ ] `npm run package:vsix` 通过。
- [ ] 技术支持矩阵与维护者文档已同步更新。

---

## 7. 实施建议

这份计划不适合“边想边改”。建议执行时遵循下面策略：

- [ ] 先做 Phase 0，把所有残余脏点冻结成测试和 boundary guard。
- [ ] Phase 1 和 Phase 2 优先完成，因为 canonical options end-to-end 和 marker 机制拆除是本次洁净化的两个真正核心。
- [ ] Phase 3 在 Phase 2 之后做，否则 layout renderer 仍会被旧 marker 协议拖住。
- [ ] Phase 4 再做目录重组，避免一边拆 marker 一边搬目录造成审查困难。
- [ ] Phase 5 最后收口，确保技术文档和 generated contract 反映的是最终结构，而不是中间态。

如果实现过程中必须在中间阶段保留某个 shim、旧命名或桥接函数，汇报里必须明确说明：

- 为什么此阶段还保留
- 它是否仍处于 live path
- 计划在哪个后续 phase 删除

不允许把“临时保留”默默变成永久残留。
