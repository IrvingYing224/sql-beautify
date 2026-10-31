# 仓库指南

## 定位

SQL Beautify 是所有者个人使用的 Hive SQL 格式化 VS Code 扩展，VSIX 通过 GitHub Releases 分发，
不发布 npm 或 Marketplace。优先级：排版正确 > 代码简单 > 性能。不追求可证明正确，
不防御恶意输入，也不防御项目自身的代码。

代码结构与格式化流程见 `docs/technical/sql-formatter-architecture.md`；3.0 重构的决定（D1–D14）
见 `docs/technical/adr/0006-3.0-refactor.md`。

## 结构

- `src/core/`：lexer → syntax（CST）→ analysis → layout（Layout IR）→ renderer → api（formatSql）；
  另有 `dialects/`（Hive 语法表）、`config/`、`diagnostics/`、`source/`
- `src/ddl/`：Experimental Hive DDL 格式化与 Extract DDL
- `src/edits/`：computeEdits、范围校验、执行器（direct / worker）
- `src/vscode/` 与 `src/extension.ts`：VS Code 宿主
- `tests/golden/`：排版规格（黄金快照）；`tests/unit/`：行为测试；`tests/vscode/`：真实宿主冒烟（手动）
- `scripts/`：`build.js`（esbuild）、`check-vsix.js`、`run-vscode-smoke.js`，以及只在升级 Unicode
  版本时运行的 `generate-v2-unicode-width-data.js`
- `docs/technical/`：架构文档与 ADR

## 命令

- `npm ci`、`npm run typecheck`、`npm run build`
- `npm test`：golden 加 unit，结果必须确定
- `npm run golden:update`：重写快照；之后必须逐条审 diff
- `node tests/golden/run.js --fuzz <次数>`：确定性随机变异，检查幂等与底线
- `npm run test:private -- <目录>`：对仓库外的真实 SQL 检查底线和 failed，结果不进仓库（D9）
- `npm run package`：构建并检查 VSIX
- `npm run test:vscode`：真实宿主冒烟；`SQL_BEAUTIFY_VSCODE_VERSION=1.90.0` 指定最低版本

同一工作区的 build 和 test 串行执行。

本地命令不需要代理。只有远端 Git、GitHub API、依赖下载等真实网络操作，才按当前机器要求
设置 `ALL_PROXY=socks5://127.0.0.1:7897`。

## 安全底线（只有这五条）

1. lexer 无损：所有 leaf 拼接等于原文。
2. 格式化输出 token 等价且粘连保持：相邻的单词类 leaf（keyword、identifier、number、
   parameter）之间有没有空白与原文相同；`${…}` 模板片段内部不出现空白，片段外侧原有的空白
   不删除（完整定义见架构文档的"五条底线的细则"）；不成立时返回原文。Extract 不适用。
3. 编辑原子提交：快照版本 → 计算全部 target → 复查版本 → 一次提交并检查结果；
   任一失败、取消或过期时不提交任何 edit。
4. 资源上限：输入长度、parser 深度、输出上限；超限时返回原文。
5. 字符串、注释、引号标识符、`${…}` 模板、Hive 数字 literal、脚本命令载荷、模板片段，
   内容（包括大小写和内部空白）不改写。模板保护以"展开值不改变词法结构"为前提（D13）。

内部 bug 直接 throw，由顶层 catch 返回原文加 `FMT_INTERNAL`。除此之外没有运行时"契约"。

## 排版规则

- `tests/golden` 是排版行为的唯一规格。任何排版变化都必须体现为 golden diff，并在提交说明中解释。
- 修排版 bug：先加或改 golden 用例，再改 layout policy。
- 纯重构提交：golden 必须零变化。
- layout policy 只产出 Layout IR；renderer 是唯一写空白和关键字大小写的地方；render 之后不做全局正则。
- 未建模结构优先走通用排版层；只有词法不安全时才原样保留，且只保留最小安全片段。
- 通用排版层只改空白的量，不改空白的有无；只对语句头表中的前导关键字改大小写；命令载荷原样保留。
- 结构判断来自 CST，不按单词值或局部正则猜测语法。

## 明确不做（写代码和复核都不要提出）

- 对内部构造的对象做 Proxy、descriptor、prototype、brand、provenance、WeakSet 归属检查
- debug-only 的不变量 oracle、只给测试用的统计计数、记账型资源预算
- 墙钟或比值性能门、发布字节溯源、锁定文档措辞的测试
- 为没有复现的理论竞态增加防御
- npm 公共 API、第二套事务实现

## 编码

- TypeScript strict、ES module、4 空格缩进；Node 脚本使用 CommonJS。
- 改动落在拥有该职责的层，不在宿主里复制 core 逻辑。
- 新增抽象必须让总代码量下降，或直接支撑某个 golden 用例。
- 函数尽量不超过 150 行，文件尽量不超过 800 行（parser 除外）。

## 测试

- 改 core 或 ddl：`npm test`，排版改动另跑 `--fuzz 20000`。
- 改 edits 或 vscode：`npm test`，必要时手动运行 `npm run test:vscode`。
- 行为以 golden 和少量 unit 测试为准，不要求逐函数写单测。

## 提交与发布

- 提交格式 `<type>(scope): <summary>`，中文 summary 以动词开头、不超过 50 字、不以句号结尾；
  一个提交对应一个可回滚的边界。行为变化逐条写在提交说明中。
- 在 `claude/*` 功能分支上开发；验收和复核通过后快进合入 `main`，不走 PR。每批合入前至少
  通过 `npm run typecheck`、`npm run build`、`npm test`、`npm run package`，fuzz 与 smoke 按
  "测试"一节视改动范围另跑。不能快进时先把 `main` 合入功能分支；不 rebase，不 force-push。
  推送 `main` 后确认 CI，失败时在下一个提交里修复或 revert。
- 发布：在 `main` 上手动触发 workflow；package 版本、tag、CHANGELOG 三者一致；
  未发布的版本不写发布日期，发布时补上。
- 不提交 `.vsix`、`dist/`、`.tmp/`。

## 复核

Claude 主导实现，GPT 复核；GPT 写的部分由 Claude 复核。每批改动合入 `main` 之前复核一次。

**输入**：需求原话与所有者的决定、改动范围（`git diff main...<分支>`）、`npm test` 输出、golden 变化清单。

**检查项：**

1. 改动范围是否与需求一致，有无夹带改动；
2. 纯重构的 golden 是否零变化；行为变化是否逐条有解释；
3. 五条安全底线是否仍然成立；
4. 有没有重新引入"明确不做"中的机制；
5. 新代码是否可读，是否让总代码量下降。

**严重度（个人使用口径）：**

- **Blocker**：违反任一条底线且附有复现，或纯重构出现未解释的 golden 变化。
- **Major**：常见 Hive SQL 出现排版回归或幂等失败（附复现）；明显偏离需求。
- **Minor**：可读性、命名、残留死代码、注释不准确。
- **Question**：没有复现的疑虑，作为问题提出，不计为缺陷。

**不在复核范围（请不要提出）**：hostile、Proxy、accessor、prototype 污染类输入与恶意 workspace
配置；内部对象的 provenance、brand、所有权证明；没有复现的理论竞态；缺少性能门或发布字节溯源；
缺少 npm API 或类型声明；"与 2.x 技术契约不一致"本身。

**每条发现必须包含**：位置（`file:line`）、复现（SQL + 选项 + 实际输出 + 期望输出，或者具体的
调用路径）、修改建议。

**处理**：Blocker 和 Major 在合入前必须解决，或由所有者明确豁免；Minor 可以延后；Question 由
主导方答复。复核意见写在 `.tmp/review/<主题>/`，不进仓库；主导方在修复提交的说明里逐条写处理结果。

## 协作

- 仓库内可回退的规划、实现、测试、文档和本地提交可以自主推进；可以 push 到 `claude/*`
  功能分支，验收和复核通过后可以快进合入 `main` 并推送（D12）；发布、改写历史、
  删除用户数据需要所有者确认。
- 验证失败或证据不足时，不得声称完成。
