# SQL Formatter v2 Wave 5 Cutover Design

- 日期：2026-07-19
- 状态：已完成（已合入本地 `main` 并通过 cutover 门禁，待推送与正式发布）
- 基线：`codex/sql-formatter-v2-wave4` @ `294d0bba84bec760eba4fb87f0ab2db9c76321ec`
- 目标分支：`codex/sql-formatter-v2-wave5`

## 1. 目的

Wave 0-4 已完成 v2 lexer、formatter-oriented CST、analysis、Layout IR、renderer、事务、worker 和 experimental Hive DDL，但这些能力仍未接管扩展入口。Wave 5 将把 v2 作为唯一生产路径，删除旧 1.x core、root shim、positional API 和 legacy command，不保留双路径或隐藏 fallback。

本波次不追求旧版本逐行输出兼容。兼容边界是新的对象式 API、`sqlBeautify.*` 配置和明确的 experimental DDL 结果契约；用户需要回退时使用上一 major VSIX，而不是在 v2 内切换旧实现。

## 2. 最终 Runtime 图

```text
package.json main
  -> dist/extension.cjs
       -> dist/runtime.cjs       (唯一实际 core + adapter runtime)
       -> dist/hive-ddl.cjs      (runtime 的 DDL public facade)
       -> dist/formatter-worker.cjs

Node API exports
  -> dist/sql-formatter.cjs     (只暴露 formatSql / lexSql)
```

- `dist/runtime.cjs` 是 direct executor、persistent worker 和 VS Code adapter 共用的唯一实现 artifact；worker 通过显式 runtime path 加载它，不再复制另一份 formatter core。
- `dist/extension.cjs` 只包含 VS Code host wiring 和外部 artifact 加载，不把 core 再 bundle 一份。
- `dist/sql-formatter.cjs`、`dist/hive-ddl.cjs` 是 public facade，只转出批准的 value exports；内部 transaction、executor、CST 和 parser 不从 public facade 泄漏。
- 生成的 `dist/**` 不提交源码仓库，但必须进入 VSIX allowlist；源码、测试、脚本、superpowers 文档和依赖包不进入 VSIX。

## 3. VS Code Adapter 契约

### 3.1 配置

- 只读取 `sqlBeautify.*`，并绑定目标 `TextDocument.uri`。
- 2.0 配置枚举直接使用 core canonical `postgresql`；不再接受旧 `postgres` 或 `languageMode` 映射，默认仍为 Hive。
- 配置值通过 v2 canonical resolver 进入 executor；未知键、非法枚举、accessor 和 Proxy fail closed。
- 公开优先级为显式 API/命令参数、language-scoped setting、workspace setting、canonical default；VS Code `TextEditorOptions` 不覆盖已声明的 `sqlBeautify.*` 默认值。

### 3.2 标准 provider

- `DocumentFormattingEditProvider` 和 `DocumentRangeFormattingEditProvider` 使用 `prepareFormatTransaction`，provider 只返回完整、已验证的 edit set，不自行拼接字符串。
- document target 覆盖整个 source；range target 必须通过 v2 range ownership、完整行边界、protected/opaque 边界和 CST fragment 检查。
- VS Code cancellation token 通过显式 wrapper 转换为 v2 `CancellationToken`，把 Disposable 转成 unsubscribe function；取消、fatal diagnostic、stale version、结果契约错误均返回空 edit set。

### 3.3 命令与多选区

- 只注册 `sqlBeautify.formatSql`、`sqlBeautify.formatHiveDdl`、`sqlBeautify.extractHiveDdl` 和 `sqlBeautify.copySafeDiagnosticReport`。
- 每个命令只在 registry 的 `sql`、`hive-sql` language context 中启用；不使用 `/sql/` 宽匹配。
- 空选择回退整文档；非空选择按 source offset 排序并构造 target selection。所有 target 先计算，再一次 host commit；任何 target 失败则整次命令无编辑。
- `TransactionSelection` 通过 source map 映射回 VS Code `Selection`，事务契约保留 forward/backward anchor 方向；映射失败时不得提交编辑。

### 3.4 Experimental DDL

- DDL 命令使用独立 DDL operation，但复用 DocumentSnapshot、diagnostic 和原子提交边界。
- DDL 多选区必须使用批量事务：所有目标先计算；仅当全部是 diagnostic-free、非空 `formatted`/`extracted` 结果时一次提交；`unsupported`、`ambiguous`、`empty`、`failed` 或任一异常使整批保持原文。
- DDL 不伪造 query source map；selection 映射不可证明时不修改 selection。

### 3.5 诊断与生命周期

- warning 只显示稳定 code 的安全消息，不显示 SQL、identifier、literal、source path 或 unsupported snippet。
- `sqlBeautify.copySafeDiagnosticReport` 在 v2 adapter 内重建，只输出版本、dialect、source code-unit count、result status 和诊断 code/severity 计数；不复用旧 telemetry/report 模块。
- `debugDiagnostics` 仅写扩展宿主安全摘要。
- activate 时创建一个 routed executor，large request 使用同一 `runtime.cjs` 的 persistent worker；deactivate 时等待 direct/worker dispose。
- worker crash、timeout、stale response、backpressure 和 host edit rejection 都转换成目标级 rejection，不重试部分 selection。

## 4. 删除与公开面

必须删除：

- 根目录 `extension.js`、`vkbeautify.js`；
- `lib/**` 全部旧 core、adapter、DDL 和 root shim；
- `extension.*` command contribution、注册和 activation event；
- `vkbeautify` positional API、旧 require 路径和旧 formatter facade；
- 只依赖旧 `lib` 的生成脚本、旧 support matrix 生成器和失效 1.x 测试入口。

必须保留并迁移：

- `src/core/**`、`src/experimental/ddl/**`、`src/adapters/**` 的 v2 源码；
- v2 Wave 0-4 correctness/performance/invariant corpus；
- `sqlBeautify.*` 配置和 experimental DDL 的用户说明；
- 一份 canonical v2 support matrix、architecture 文档、migration guide 和 Wave 5 cutover plan。

Wave 0 已拒绝的 parser 候选不再作为长期开发依赖：保留 ADR 和结论，删除 evaluator runtime、`dt-sql-parser` 依赖和只服务候选比较的脚本/测试；仍有格式化价值的 corpus 迁入 v2 corpus 后保留。

## 5. Package 与发布

- package version 升为 `2.0.0`；`main` 指向 `./dist/extension.cjs`。
- Node consumers 通过 `exports` 使用 `./formatter` 和 `./experimental/ddl`，只能得到批准的 facade value exports。
- VSIX 只包含 extension entry、四个生产 runtime facade/artifact、package metadata、README、CHANGELOG、LICENSE 和必要 images。
- PR/push workflow 只执行测试和 package smoke，默认 `permissions: contents: read`；只有显式 main release job 才请求写权限。
- release 前核验 package version、tag、Release target、workflow SHA、`origin/main` SHA 和 VSIX 文件名一致。Wave 5 本地工作不自动 push、merge 或创建 release。

## 6. 回滚与风险

- 不在 v2 中保留旧 formatter fallback；回滚方式是安装上一 major VSIX。
- 任何 runtime artifact 缺失、public facade 泄漏、编辑非原子、DDL 产生部分 edit、配置优先级漂移或旧路径残留均阻止 cutover。
- Hive 仍是默认和优先 dialect；generic/postgresql/mysql 只按 support matrix 的已验证状态工作。

## 7. 完成证据

Wave 5 只有在以下证据全部存在时才算完成：

1. `package.json`、extension entry、VSIX manifest 和 supported-language registry 一致；
2. public facade keys 精确、旧模块/命令/API 不可加载；
3. provider、command、多选区、cancellation、stale document、worker failure 和 DDL batch 自动化回归通过；
4. full v2 corpus、idempotency、token equivalence、performance 和 VSIX allowlist 通过；
5. migration/README/CHANGELOG/architecture/support matrix 与实际行为一致；
6. CI least privilege 和 release SHA 检查通过；
7. 独立 reviewer 无 Critical/Important；
8. 当前分支未未经授权 push/merge/release。
