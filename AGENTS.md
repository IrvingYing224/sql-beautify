# 仓库指南

## 定位

SQL Beautify 是所有者个人使用的 Hive SQL 格式化 VS Code 扩展，VSIX 通过 GitHub Releases 分发，
不发布 npm 或 Marketplace。优先级：排版正确 > 代码简单 > 性能。不追求可证明正确，
不防御恶意输入，也不防御项目自身的代码。

3.0 重构期间，以 `docs/technical/3.0-refactor-plan.md` 为准；该文与本文冲突时以该文为准。

## 结构（3.0 目标结构，重构期间逐步到位）

- `src/core/`：lexer → syntax（CST）→ analysis → layout（Layout IR）→ renderer → api（formatSql）
- `src/ddl/`：Hive `CREATE TABLE` 格式化与 Extract DDL
- `src/edits/`：计算 edits、范围校验、执行器（direct / worker）
- `src/vscode/` 与 `src/extension.ts`：VS Code 宿主
- `tests/golden/`：排版规格（黄金快照）；`tests/unit/`：行为测试；`tests/vscode/`：真实宿主冒烟（手动）

## 命令

- `npm ci`、`npm run typecheck`、`npm run build`
- `npm test`：golden 加 unit，结果必须确定；P4a 之前 unit 的位置由 `tests/v2` 中存续的旧测试占着
- `npm run golden:update`：重写快照；之后必须逐条审 diff
- `npm run test:private -- <目录>`：对仓库外的真实 SQL 检查底线和 failed，结果不进仓库（D9）
- `npm run package`：构建并检查 VSIX

同一工作区的 build 和 test 串行执行。

本地命令不需要代理。只有远端 Git、GitHub API、依赖下载等真实网络操作，才按当前机器要求
设置 `ALL_PROXY=socks5://127.0.0.1:7897`。

## 安全底线（只有这五条）

1. lexer 无损：所有 leaf 拼接等于原文。
2. 格式化输出 token 等价且粘连保持：相邻的单词类 leaf（keyword、identifier、number、
   parameter）之间有没有空白与原文相同；`${…}` 模板片段内部不出现空白，片段外侧原有的空白
   不删除（完整定义见 3.0 方案 §4）；不成立时返回原文。Extract 不适用。
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

- 改 core 或 ddl：`npm test`。
- 改 edits 或 vscode：`npm test`，必要时手动运行 `npm run test:vscode`。
- 行为以 golden 和少量 unit 测试为准，不要求逐函数写单测。

## 提交与发布

- 提交格式 `<type>(scope): <summary>`，中文 summary 以动词开头、不超过 50 字、不以句号结尾；
  一个提交对应一个可回滚的边界。
- 在 `claude/*` 功能分支上开发；阶段验收和复核通过后快进合入 `main`，不走 PR。
- 发布：在 `main` 上手动触发 workflow；package 版本、tag、CHANGELOG 三者一致；
  未发布的版本不写发布日期。
- 不提交 `.vsix`、`dist/`、`.tmp/`。

## 协作

- Claude 主导实现，GPT 复核；复核规则见 `docs/technical/3.0-refactor-plan.md` §8。
- 仓库内可回退的规划、实现、测试、文档和本地提交可以自主推进；可以 push 到 `claude/*`
  功能分支，阶段验收和复核通过后可以快进合入 `main` 并推送（D12）；发布、改写历史、
  删除用户数据需要所有者确认。
- 验证失败或证据不足时，不得声称完成。
