# SQL Formatter v2 Wave 4 Adapter 与 Experimental DDL Implementation Plan

- 日期：2026-07-18
- 状态：执行中
- 工作目录：`/Users/yingirving/Documents/sql-beautify/.worktrees/sql-formatter-v2-wave4`
- 分支：`codex/sql-formatter-v2-wave4`
- 基线：`0d765402fe022c84499a641d6ef020df14f17e85`
- 设计：`docs/superpowers/specs/2026-07-18-sql-formatter-v2-wave-4-adapter-ddl-design.md`

## 1. 执行策略

Wave 4 按 4A、4B、4C、4D、4E 连续推进。每个 checkpoint 固定执行：

1. 先增加能复现缺口的 red tests，并记录失败证据；
2. 实现完整契约，不用测试特判或放宽门槛绕过；
3. 串行运行 targeted、Wave 0/1/2/3、1.x regression 和 boundary tests；
4. 检查 `extension.js`、`vkbeautify.js`、`lib/**`、`package-lock.json` 与 VSIX boundary；
5. 由独立只读 reviewer 审查，Critical/Important 必须为 0；
6. 主代理创建单一聚焦本地提交并进入下一 checkpoint。

仓库规则已经授权主代理自主跨 checkpoint、委派 reviewer、修改测试/文档、stage 和本地 commit；
不自动授权 push、merge、发布、改写历史或删除用户数据。Wave 5 完成前不合并 `main`。

## 2. 全局硬约束

- 开工前完整阅读根 `AGENTS.md`、Wave 4 design、umbrella design、Wave 3 design 和 architecture 文档；
- Wave 4 禁止修改现役 `extension.js`、`vkbeautify.js`、`lib/core/**`、`lib/experimental/**`、`package-lock.json`
  和现役 provider/command contribution；允许新增 `src/adapters/**`、`dist/**` 构建产物
  及构建脚本，并允许诊断/config 辅助，但不得把现役入口切到 v2；
- `src/core` 不得导入 `src/adapters`、`src/experimental/ddl`、`vscode` 或任何 CommonJS runtime；
- adapter 不重复实现 lexer/parser/layout；DDL 不得复制 core angle/depth/token boundary 逻辑；
- 失败和取消必须 fail closed：原文返回、无 partial edit、无 partial source map；
- 不运行 `npm run evaluate:v2:parser` 或任何 `--write` evidence 命令；
- 本地测试/构建/打包不设置代理；只有依赖下载和远端网络命令设置 `ALL_PROXY`；
- `.tmp/v2-core` 同一工作树禁止并发 build；VSIX 只用于预检，提交前删除；
- 不把 `node_modules`、`.vsix`、`.tmp` 或 worker build 产物 stage。

## 3. 允许的新增边界

```text
src/core/api/public-format.ts
src/core/source/source-map.ts
src/adapters/transaction/{types,range,prepare,cursor}.ts
src/adapters/diagnostics/{types,convert}.ts
src/adapters/executor/{types,direct,persistent-worker,worker-entry}.ts
src/adapters/vscode/{supported-languages,adapter-contract}.ts
src/experimental/ddl/{types,parser,layout,format,extract}.ts
tests/v2/wave4a-*.test.js
tests/v2/wave4b-*.test.js
tests/v2/wave4c-*.test.js
tests/v2/wave4d-*.test.js
tests/v2/wave4e-*.test.js
tests/v2/wave4*.type-test.ts
tests/fixtures/v2-wave4-*.js
docs/technical/sql-formatter-v2-wave4-*.md
src/adapters/**
dist/**（仅由构建脚本生成，不 stage）
scripts/build-v2-runtime.js
```

若实现证明某文件边界不合理，应先更新 design/plan 和 boundary test，再移动职责；禁止形成
同时拥有 core facts、transaction orchestration 和 worker loop 的巨型模块。

## 4. Preflight

在 4A red test 前串行执行：

```bash
pwd
git branch --show-current
git rev-parse HEAD
git status --short
git rev-list --count 0d765402fe022c84499a641d6ef020df14f17e85..HEAD
git diff --name-status 0d765402fe022c84499a641d6ef020df14f17e85 -- extension.js vkbeautify.js lib package-lock.json
npm run typecheck:v2
npm run test:v2:wave3
git diff --check
```

预期分支 `codex/sql-formatter-v2-wave4`、ahead 0、runtime/package-lock diff 为空。

## 5. Wave 4A：Public API 与基础 transaction contract

### 5.1 Red tests

新增：

- `tests/v2/wave4a-public-api.test.js`：root build 可 value-import `formatSql`；两参数 document mode；
  `formatted/unchanged/preserved/failed` 的 text/sourceMap/status contract；冻结与错误原文；
- `tests/v2/wave4a-source-map.test.js`：exact/left/right affinity、gap、边界、非法 map fail closed；
- `tests/v2/wave4a-transaction.test.js`：target shape、bounds、排序、overlap、同一 snapshot、
  all-results-before-edit、任何失败零编辑；
- `tests/v2/wave4a-contracts.type-test.ts`：FormatExecutor、CancellationToken、TransactionResult
  和 public result discriminated union；

先证明当前 root 没有 `formatSql` value export，当前 API 没有可复用的 source-map cursor helper，
并用 fake executor 证明旧式逐目标编辑会产生 partial edit。

### 5.2 实现

1. 新增 `public-format.ts` document-only wrapper，root 只新增该 value export；runtime bundle
   另带 adapter-private `formatSqlTarget`，bridge 通过私有面执行 fragment，不复制 pipeline。
2. 将 source-map monotonic validation 和 `mapSourceOffset` 放在 `src/core/source/source-map.ts`，
   renderer 生成的 map 继续作为唯一 source authority。
3. 新增 host-neutral transaction types、range validator、diagnostic aggregation、prepare/validate
   orchestration；计算阶段只读 source，commit 由宿主回调完成。
4. 保证所有返回 collections 深冻结，并将 target-relative spans/source maps 转为绝对 edit metadata。

### 5.3 验证与提交

```bash
npm run typecheck:v2
npm run build:v2-core
node tests/v2/wave4a-public-api.test.js
node tests/v2/wave4a-source-map.test.js
node tests/v2/wave4a-transaction.test.js
npm run test:v2:wave3
npm run test:verify
git diff --check
```

独立 reviewer 清零后提交：`feat(v2): 建立公开格式化接口与事务契约`。

## 6. Wave 4B：Range、多选区、diagnostic、cancellation 与 cursor

### 6.1 Red tests

新增：

- `tests/v2/wave4b-range-transaction.test.js`：whole-line、newline 前 end、protected token 内部、
  clause/list boundary、fragment parse failure、range 不外扩；
- `tests/v2/wave4b-multiselection.test.js`：相邻/重叠、多选区排序、一个 fatal 结果整批不编辑、
  unchanged/warning 结果、document version stale；
- `tests/v2/wave4b-cancellation-diagnostics.test.js`：pre-cancel、during compute、before commit、
  warning/error 聚合、绝对 span、无 source snippet；
- `tests/v2/wave4b-cursor.test.js`：生成空白 gap、selection start/end affinity、外部编辑 delta、
  无 map 时保持原 selection；
- `tests/v2/wave4b-language-registry.test.js`：selector/command/DDL context 只来自 registry。

### 6.2 实现

1. 使用一次完整 lossless analysis 检查 protected boundary 与 fragment ownership，不重扫 raw source；
2. 实现 `CancellationToken` listener 生命周期和 transaction 四阶段 version/cancellation recheck；
3. 将 core diagnostics 安全转换为绝对 document diagnostics，固定排序和错误码；
4. 实现 cursor mapping 与多 edit 的 cumulative delta，提交前 map 失败则 reject 而不是猜测；
5. 建立 supported-language registry 和 adapter contract mock；Wave 4 不改现役 package JSON。

### 6.3 验证与提交

```bash
npm run typecheck:v2
npm run build:v2-core
node tests/v2/wave4b-range-transaction.test.js
node tests/v2/wave4b-multiselection.test.js
node tests/v2/wave4b-cancellation-diagnostics.test.js
node tests/v2/wave4b-cursor.test.js
node tests/v2/wave4b-language-registry.test.js
npm run test:v2:wave3
npm run test:verify
git diff --name-status -- extension.js vkbeautify.js lib package-lock.json
git diff --check
```

提交：`feat(v2): 收敛选区事务与取消诊断`。

## 7. Wave 4C：Direct/worker executor 与故障路径

### 7.1 Red tests

新增：

- `tests/v2/wave4c-executor.test.js`：direct/worker parity、same artifact digest、threshold routing；
- `tests/v2/wave4c-worker-lifecycle.test.js`：queued/active cancellation、dispose、worker crash restart、
  request id/source digest/version stale response；
- `tests/v2/wave4c-performance.test.js`：100/800/1200 statements、large CTE/comment、transfer outside
  timing、p50/p95/RSS/cancel latency；

先用 fake worker 复现 crash/stale result 和 active cancellation，确保红灯来自 executor contract 而非 SQL layout。

### 7.2 实现

1. `DirectFormatterExecutor` 调用内部 target core function；每次 request 周围检查 cancellation。
2. `PersistentWorkerExecutor` 使用 request queue、单 active request、generation 和 bounded failure
   state；active cancel terminate 并重启，crash fail current/retry queue；dispose 全部取消。
3. worker entry 只加载同一 `.tmp/v2-core` core artifact，禁止复制 formatter 逻辑；source transfer、
   worker startup 不计入 formatting latency，但必须单独记录。
4. threshold 默认值由 benchmark 结果冻结，并提供显式测试 override；不通过放宽 ratio gate 掩盖回归。

### 7.3 验证与提交

```bash
npm run typecheck:v2
npm run build:v2-core
node tests/v2/wave4c-executor.test.js
node tests/v2/wave4c-worker-lifecycle.test.js
node tests/v2/wave4c-performance.test.js
npm run test:v2:wave3
npm run test:verify
git diff --check
```

提交：`feat(v2): 实现可取消格式化执行器`。

## 8. Wave 4D：Experimental Hive DDL 与 Extract DDL

### 8.1 Red tests

新增 `tests/v2/wave4d-ddl.test.js`、`wave4d-extract-ddl.test.js` 和
`tests/fixtures/v2-wave4-ddl.js`，先锁定当前证据：

- quoted table/header/comment 中双空格、`(`、逗号不得被改写；
- invalid/unknown column 不得被静默丢弃；
- `COMMENT` 只在 column grammar 位置生效；
- empty/ambiguous extract 不得产生空替换；
- 多 statement、wildcard、重复 alias、UNION schema mismatch 全量拒绝；
- complex Hive types、quoted member、suffix 和 idempotency；
- `ExtractDdlResult` 每个状态与 `text === source`/non-empty invariant。

### 8.2 实现

1. 复用 core lossless leaves、depth/table、diagnostics；若 type cursor 需要抽取，先在 core 建
   明确 bounded helper，禁止 DDL 自建第二 angle parser。
2. 建立 DDL CST 与 conservative layout island；无法完整消费的目标 preserved/failed，保留全部 raw。
3. 使用 query CST/analysis 做 extract；只输出高置信完整 schema。默认类型策略为显眼占位或显式
   `defaultType`，禁止无诊断的 `BIGINT` 猜测。
4. DDL/extract 结果接入 Wave 4 transaction contract，只有 formatted/extracted 可编辑。

### 8.3 验证与提交

```bash
npm run typecheck:v2
npm run build:v2-core
node tests/v2/wave4d-ddl.test.js
node tests/v2/wave4d-extract-ddl.test.js
npm run test:v2:wave3
npm run test:verify
git diff --check
```

提交：`feat(v2): 重建 Hive experimental DDL 边界`。

## 9. Wave 4E：Aggregate、性能、boundary、VSIX 与 review

### 9.1 新增验证

- `tests/v2/wave4-boundary.test.js`：dependency graph、禁止 import、唯一 public value export、
  no CommonJS/runtime leakage、worker artifact boundary、source map/result immutability；
- `tests/v2/wave4-properties.test.js`：DDL/query token equivalence、protected preservation、fuzz no-throw、
  transaction all-or-nothing、direct/worker digest parity；
- `tests/v2/wave4-performance.test.js`：executor/DDL fixed corpus complexity and memory gates；
- 更新 `scripts/build-v2-core.js` 或独立 build manifest，确保 worker 只包含当前 v2 core/adapters 所需 runtime。

### 9.2 Full gate

```bash
npm run typecheck:v2
npm run test:v2:wave0
npm run test:v2:wave1
npm run test:v2:wave2
npm run test:v2:wave3
npm run test:v2:wave4
npm run test:verify
npm run package:vsix
npm exec -- vsce ls --tree
git diff --name-status -- extension.js vkbeautify.js lib package-lock.json
git diff --check
```

VSIX 必须保持现役 1.x allowlist；Wave 4 的 `src/**`、worker、tests、docs 不得进入当前包。
独立 reviewer Critical/Important 清零后创建 aggregate 提交：`feat(v2): 完成Wave 4适配器与DDL`。

## 10. 完成标准

1. root `formatSql` public value export 和 `FormatResult` contract 可独立消费；
2. transaction 对 document/range/multi-selection 全部 all-or-nothing；
3. stale version、overlap、protected boundary、cancellation、worker crash/edit reject 均无 partial edit；
4. direct/worker 使用同一 core artifact，结果 parity 和性能证据成立；
5. Hive DDL/Extract DDL 复杂类型、quoted 内容、空结果和 malformed 输入全部 fail closed；
6. Wave 0/1/2/3、1.x `test:verify`、package/VSIX、runtime diff 与 git diff check 全通过；
7. 独立 reviewer 无 Critical/Important；
8. 未修改、stage 或提交现役 1.x runtime，未 push/merge/release。
