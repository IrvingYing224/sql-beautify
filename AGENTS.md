# 仓库指南

## 项目结构与模块组织

该仓库是 Hive-first 的 SQL Beautify 2.x VS Code 扩展。`src/` 是唯一源码来源：`src/core/` 依次包含 lossless lexer、formatter-oriented CST、analysis、Layout IR、renderer、diagnostics 与 public API；`src/adapters/` 负责事务、direct/worker executor 和 VS Code host；`src/experimental/ddl/` 隔离 experimental Hive DDL / Extract DDL。`src/extension.ts` 是源码入口。

`npm run build:v2-runtime` 生成五个被 Git 忽略的生产 artifact：`dist/runtime.cjs`、`dist/sql-formatter.cjs`、`dist/hive-ddl.cjs`、`dist/formatter-worker.cjs`、`dist/extension.cjs`。不得恢复根 `extension.js`、`vkbeautify.js`、`lib/**`、旧 bridge、root shim 或第二套生产 formatter。

用户文档位于 `README.md`、`CHANGELOG.md` 和 `docs/migration-to-2.0.md`；维护者契约位于 `docs/technical/`。`docs/technical/sql-support-matrix.md` 是由 dialect registry 生成的唯一能力矩阵。

## 构建、测试与开发命令

- `npm ci`：按 lockfile 安装项目本地依赖。
- `npm run typecheck:v2`：运行 TypeScript strict 类型检查。
- `npm run test:verify`：运行 Wave 1–5 的完整长期回归、性能和发布门。
- `npm run verify:clean-package`：在无 `dist` 的隔离源码副本中执行 npm package lifecycle 并加载公开 facade。
- `npm run package:vsix`：构建并验证版本化 `.vsix`。
- `npm exec -- vsce ls --tree --no-dependencies`：检查 VSIX allowlist。

这些本地命令不需要代理。只有远端 Git、GitHub API、依赖下载、Homebrew、`npm install` 或 `npm ci` 等真实网络操作才按当前机器要求设置 `ALL_PROXY=socks5://127.0.0.1:7897`。

同一 worktree 的 build/test 必须串行：构建共享 `.tmp/v2-core` 和 `dist`，并行重建会制造非代码竞争。`.vsix`、`dist/**`、`.tmp/**` 不提交。

## 编码与架构规则

TypeScript 源码遵循现有 strict、ES module、不可变对象与 4 空格缩进风格；Node 构建/测试脚本继续使用 4 空格、分号、`var` 与 CommonJS。改动应落在拥有该职责的层，不在 facade 或 host 中复制 core 逻辑。

- `src/core/**` 不得导入 adapter、VS Code 或 experimental DDL。
- lexer 是 token/source span 的唯一权威；CST/syntax 是结构边界的唯一权威；analysis index 是后续查询结构关系的唯一权威。
- layout policy 只生成 Layout IR；renderer 是格式化空白和 keyword case 的唯一写入者。render 后不得增加全局 SQL regex 或 whitespace normalization。
- 注释、字符串、quoted identifier、参数、方言 literal 和 verbatim/opaque source slice 不得被结构 pass 改写。
- 未建模或 malformed 结构必须按可证明边界 preserve；禁止通过单词值或局部正则猜测语法。
- document、range、multi-selection、worker 和 experimental DDL 必须 fail closed 且 all-or-nothing；失败、取消、stale 或任一 target 拒绝时不提交部分 edit。
- 热路径查询复用 analysis index 和预计算 facts；不得为每个 node/leaf 重新全表扫描。

公开值 API 只允许 `vscode-sql-beautify/formatter` 的 `formatSql`/`lexSql` 和 `vscode-sql-beautify/experimental/ddl` 的 `formatHiveDdl`/`extractDdl`。不得公开 parser、CST、layout、transaction、executor 或 internal `dist` 路径。

## 配置、命令与 experimental 边界

VS Code 只读取 `sqlBeautify.*`；仅注册 `sqlBeautify.formatSql`、`sqlBeautify.formatHiveDdl`、`sqlBeautify.extractHiveDdl`、`sqlBeautify.copySafeDiagnosticReport`。不得恢复 `extension.*` command、`languageMode` fallback、positional API 或 `postgres` alias。canonical PostgreSQL 值是 `postgresql`，默认 dialect 是 `hive`，默认 unsupported policy 是 `warn`。

Experimental Hive DDL 不是通用 DDL parser。格式化器只接受完整消费的已建模 `CREATE TABLE` 子集；Extract DDL 只接受完整且不歧义的 projection schema，不推断真实类型。任何非成功结果必须保留完整原文，批量 DDL 任一目标失败时整批不提交。

README 只写最终用户的安装、使用、配置和风险信息。迁移细节写入 `docs/migration-to-2.0.md`；架构与内部契约写入 `docs/technical/`；不要把阶段性实现计划复制回 README。

## 测试指南

格式化 core 改动至少运行受影响的 targeted test 与 `npm run test:verify`。registry/support boundary 改动还要运行 `npm run test:v2:support-matrix` 并明确执行 generator `--write` 后再 `--check`。adapter、命令、配置、range、selection、worker 或 DDL 改动必须覆盖对应 `tests/v2/wave4*.test.js` 与 Wave 5 boundary。发布、exports、files、版本或 workflow 改动还要运行：

```bash
npm run verify:clean-package
npm run package:vsix
npm exec -- vsce ls --tree --no-dependencies
node tests/v2/wave5-release-boundary.test.js
git diff --check
```

验证完成必须以实际命令输出为证据，不把人工 smoke 当成自动化门的替代。

## 提交与发布

提交格式为 `<type>(scope): <summary>`；中文 summary 以动词开头、不超过 50 个汉字且不以句号结尾。每个提交只覆盖一个可回滚边界。不得提交 `.vsix`。

PR/push CI 默认只读并执行测试/package smoke。正式发布必须先把发布提交合入并推送 `main`，再从 `main` 手动触发 `Build VSIX` workflow。package version、lock root version、VSIX 文件名/manifest、workflow SHA、`origin/main`、tag 和 Release target 必须一致。不要从功能分支发布。

## 经验规则：仓库内工作无须用户确认

- 触发信号：用户已给出长期目标或明确范围，后续需要规划、跨 checkpoint、修改代码、测试、审查、委派、文档、stage 或创建聚焦本地提交。
- 根因 / 约束：逐次等待“继续”会割裂长期任务，且不能替代自动验证与独立审查。
- 正确做法：主代理在既定范围内自主连续推进，并可自主委派边界清晰的实现或只读 review；主代理对证据和结论负责。
- 完成约束：验证失败、证据不足或 Critical/Important 未清零时不得声称完成或创建对应完成提交。用户明确暂停、禁止提交或改变范围时立即遵从。
- 授权边界：适用于仓库内可验证、可回退的规划、实现、测试、审查、委派、文档、暂存和本地提交；不授权 push、merge、release、改写历史或删除用户数据。
- 验证方法：交付列出改动、实际命令结果、审查结论和本地提交，并声明未越过外部状态边界。
