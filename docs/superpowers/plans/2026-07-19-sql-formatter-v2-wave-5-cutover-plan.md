# SQL Formatter v2 Wave 5 Cutover Implementation Plan

- 日期：2026-07-19
- 状态：执行中
- 工作树：`/Users/yingirving/Documents/sql-beautify/.worktrees/sql-formatter-v2-wave5`
- 分支：`codex/sql-formatter-v2-wave5`
- 基线：`294d0bba84bec760eba4fb87f0ab2db9c76321ec`
- 设计：[Wave 5 Cutover Design](../specs/2026-07-19-sql-formatter-v2-wave-5-cutover-design.md)

## 阶段 A：Runtime 与 host adapter

- [x] 新增 internal runtime facade，把 core、DDL、transaction、executor 和 production executor factory 聚合为单一实现 artifact。
- [x] 新增 public `formatter` / `experimental/ddl` facade，只导出批准的 value API。
- [x] 新增实际 VS Code adapter：配置读取、language selector、document/range provider、commands、diagnostic collection、safe report、cancellation wrapper、方向保持的 selection 映射和生命周期 dispose。
- [x] 将 DDL 单目标事务扩展为批量 all-or-nothing 事务，并复用同一 host commit seam。
- [x] 构建 `dist/runtime.cjs`、`dist/sql-formatter.cjs`、`dist/hive-ddl.cjs`、`dist/formatter-worker.cjs`、`dist/extension.cjs`；worker 与 direct 必须加载同一 runtime artifact。

## 阶段 B：Cutover 与删除

- [x] 修改 package `main`、`exports`、activation events、commands、keybindings、version 和 VSIX allowlist。
- [x] 删除根 `extension.js`、`vkbeautify.js`、`lib/**`、旧 command alias、positional API 和旧 bridge。
- [x] 删除已拒绝 parser evaluator 与 `dt-sql-parser` 长期依赖，仅保留 ADR/evidence 结论和迁入 v2 corpus 的通用 SQL fixture。
- [x] 删除只依赖旧 runtime 的生成脚本和失效矩阵；将旧测试迁移为 v2 runtime 测试或删除已经不适用的内部实现测试。
- [x] 使用 `package.files` 作为唯一 VSCE allowlist；删除与其冲突的 `.vscodeignore`，确保只允许生产 dist artifacts 和必要 metadata/assets。

## 阶段 C：文档、迁移与 CI

- [ ] 新增最终用户 migration guide，说明 2.0 breaking cleanup、对象式 API、命令/配置变化、Hive 优先边界和 DDL 风险。
- [ ] 更新 README、CHANGELOG、architecture、support matrix，删除“development-stage v2”和“maintained 1.x matrix”冲突表述。
- [ ] 收敛历史 plan：保留 umbrella、Wave design、Wave 5 plan 和仍有 ADR 价值的文档，归档/删除重复失效 implementation plan，不把 superpowers 文档打包。
- [ ] 将 CI 默认权限改为 least privilege，并把 release-only 写权限隔离到明确 job；补充 version/tag/SHA/VSIX 一致性检查。

## 阶段 D：验证与审查

- [ ] 新增 cutover boundary、public facade、extension mock、provider transaction、DDL batch、migration/package tests。
- [ ] 串行运行 `npm run typecheck:v2`、完整 v2 wave suite、`npm run test:verify`（重构后）、`npm run package:vsix`、VSIX manifest、`git diff --check`。
- [ ] 检查旧路径不可加载、旧 command/config 不存在、现役 runtime 只剩 v2 dist artifact。
- [ ] 委派只读 reviewer；Critical/Important 未清零不得提交 cutover。

## 提交边界

建议按以下聚焦提交完成，不改写历史：

1. `feat(v2): 接入生产 VS Code adapter`
2. `refactor(v2): 切换公开入口并删除旧核心`
3. `docs(v2): 完成 2.0 迁移与发布文档`
4. `test(v2): 完成 cutover 发布门`

Wave 5 本地完成后只报告 ready-to-merge/release 状态；不自动 push、merge `main` 或触发正式 release。

## 完成门槛

- `Critical=0`、`Important=0`；
- 现役 VSIX 不含旧 `lib`、root shim、legacy command、tests/docs/scripts；
- public facade keys 精确且 API/extension/runtime 实际可用；
- 所有 target/DDL edit atomic，failed/preserved/unsupported 不提交；
- package version、文档、support matrix、CI 和 VSIX 清单一致；
- 工作树干净，所有本地提交可回滚，未越过 push/merge/release 授权边界。
