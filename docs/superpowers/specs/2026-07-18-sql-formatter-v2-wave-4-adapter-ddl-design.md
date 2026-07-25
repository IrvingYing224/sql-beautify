# SQL Formatter v2 Wave 4 Adapter 与 Experimental DDL Design

- 日期：2026-07-18
- 状态：已完成（历史设计基线）
- 分支：`codex/sql-formatter-v2-wave4`
- 基线：`0d765402fe022c84499a641d6ef020df14f17e85`（Wave 3F closure）
- 上位设计：`docs/superpowers/specs/2026-07-10-sql-formatter-v2-optimization-program-design.md`
- 前置设计：Wave 0、Wave 1、Wave 2、Wave 3 design

## 1. 目标

Wave 4 将 Wave 3 的内部 formatter kernel 收敛为可被宿主安全消费的 API，并在不接管
当前 1.x runtime 的前提下重建 adapter、executor 和 experimental Hive DDL 边界。

核心目标：

1. 对外提供对象式 `formatSql(source, options): FormatResult`，所有失败保留原文；
2. 整文档、range、多选区和 DDL 命令均先计算完整结果，再一次性提交编辑；
3. 用 document version、目标边界、重叠检查和 cancellation 防止 stale 或 partial edit；
4. 小文档 direct、大文档 persistent worker 必须调用同一 core artifact，并覆盖取消、崩溃恢复和 stale result；
5. 通过 source map 恢复 cursor/selection，映射算法对生成空白有明确 affinity，不猜测位置；
6. 以 lossless lexer/CST、diagnostic 和 `FormatResult` 重建 experimental Hive DDL；
7. Extract DDL 使用全量高置信的 discriminated result，任何 ambiguous/empty/failed 都不得编辑文档；
8. 新 formatter/adapter/DDL 源码留在 `src/**`；为让 Wave 5 使用可追溯的生产 artifact，Wave 4
   允许新增构建脚本和 `dist/**` 构建产物，但不得接入现役入口。

## 2. 已确认的边界

### 2.1 Shipping 与兼容边界

- Wave 4 是独立 v2 源码和测试波次，不接管现役 1.x VS Code 入口。
- `src/core` 继续平台无关，不导入 `vscode`、`lib/**` 或 experimental DDL。
- adapter 可以依赖 core，但 core 不得反向依赖 adapter。现役 adapter 只允许增加可独立测试的
  诊断/config 辅助，不得把 provider/command 切到 v2。
- root `src/core/index.ts` 在本波次新增唯一 public value export `formatSql`；`lexSql` 继续导出。
- 旧 positional API、legacy command、root shim 和现役 DDL 入口留到 Wave 5 cutover 处理。
- 不新增 runtime 或 npm dependency；worker 只使用 Node 内置 `worker_threads`，宿主 adapter 通过接口注入 worker factory。

### 2.2 失败语义

- `formatted` / `unchanged` 是唯一允许产生编辑的状态。
- `preserved` / `failed` 必须满足 `result.text === source`，并携带至少一个 diagnostic。
- transaction 中任一目标为 `preserved`、`failed`、越界、重叠或 cancellation，整批不提交任何编辑。
- formatter throw、worker crash、edit rejection 都转换为稳定 diagnostic，不把异常文本或 SQL 内容放入用户诊断。
- 结果对象、diagnostics、sourceMap、edit set 和 selection set 全部冻结；调用方不能通过引用修改内部状态。

## 3. 公开 Core API

### 3.1 API 形状

`src/core/api/format.ts` 保留支持测试和 adapter 的内部 target mode；新增
`src/core/api/public-format.ts` 只暴露 document mode 的两参数入口：

```ts
formatSql(source: string, options?: FormatOptions): FormatResult
```

它必须调用 Wave 3 同一 `formatSqlWithStatistics` pipeline，不得复制 parse/layout/render
逻辑。非字符串运行时输入由边界转换为 `failed` 原文结果；合法字符串的失败路径保持原文。
`src/core/index.ts` 只 value-export `lexSql` 与这个两参数 `formatSql`。生产 bundle 可以额外
携带未列入 core root 的 `formatSqlTarget` adapter-private value，bridge 只能通过该私有面执行
fragment；它不是对外公开 API，不能被 root boundary test 当作 public export。

### 3.2 Result 约束

`FormatResult` 延续 Wave 3 的 discriminated union：

```ts
type FormatStatus = "formatted" | "unchanged" | "preserved" | "failed";
```

成功结果拥有冻结的 `SourceMap`；原文结果不得携带 source map，避免下游误用 partial map。
`Diagnostic.span` 使用目标内 UTF-16 code-unit offset；adapter 转换为文档绝对 offset。

### 3.3 Source map cursor 映射

`SourceMap.entries` 按 source/output 单调递增且不重叠。source-derived run 为可精确映射区，
生成的 whitespace 没有 entry。由于 entries 本身不能证明尾部 output 长度，新增
`mapSourceOffset(map, offset, sourceLength, outputLength, affinity)`：

- `exact`：命中 entry 时按长度差映射；
- `left`：落在生成 gap 时选择前一个 mapped run 的末端；
- `right`：落在生成 gap 时选择后一个 mapped run 的起点；
- 超出 source map 范围时夹到 0 或 output length；
- 非法 map/offset fail closed，返回 `null`，adapter 保持原 selection 而不提交额外编辑。

selection 起点使用 `left`，终点使用 `right`，普通 cursor 使用 `exact` 后按相邻 gap 的稳定
affinity 选择。该规则只恢复用户位置，不改变编辑范围。

## 4. Adapter transaction contract

### 4.1 Host-neutral request/result

新增 `src/adapters/transaction/`，不导入 VS Code：

```ts
type FormatTarget = {
    readonly id: string;
    readonly start: number;
    readonly end: number;
    readonly mode: "document" | "fragment";
};

type FormatTransactionRequest = {
    readonly source: string;
    readonly documentVersion: number;
    readonly targets: readonly FormatTarget[];
    readonly options?: FormatOptions;
    readonly cancellation?: CancellationToken;
};

type FormatTransactionResult =
    | { readonly status: "ready"; readonly version: number; readonly edits: readonly TextEdit[]; readonly selections: readonly Selection[] }
    | { readonly status: "unchanged"; readonly version: number; readonly selections: readonly Selection[] }
    | { readonly status: "cancelled" | "rejected"; readonly version: number; readonly diagnostics: readonly Diagnostic[] };
```

`TextEdit` 使用 UTF-16 offsets和局部 source map；`Selection` 同时记录旧目标和新目标。
targets 必须是同一 source snapshot 的有序、非重叠区间；相邻区间允许，空 target 只产生
unchanged。整文档默认使用 `[0, source.length)`，fragment 不扩大到目标外。

### 4.2 事务阶段

事务固定分为四个阶段，阶段之间不共享可变宿主状态：

1. **snapshot**：捕获 source、version、目标和 cancellation；验证整数边界、整行边界、
   protected token 边界、目标排序和 overlap；
2. **compute**：对全部目标调用同一 `FormatExecutor`，不触碰 editor；每个结果保留原始
   target text 和相对 diagnostics/sourceMap；
3. **validate**：再次读取 cancellation，验证每个状态可编辑、版本仍相等、source snapshot
   摘要未改变、source map 与 replacement 长度一致；任一失败整批 reject；
4. **commit**：adapter 将全部 edit 构造成一个 WorkspaceEdit/单次 provider edit set；
   commit 失败时只报告失败，不重试或提交部分目标。

### 4.3 Range boundary

range validator 使用一次完整 source 的 lossless leaves 和结构 index，再验证目标：

- 起止不在 string、comment、quoted identifier、parameter 或其他 protected leaf 内；
- 起止位于安全的 line boundary，允许 selection end 恰好位于 newline 前；
- fragment parser 能证明 statement/clause/list 的完整边界，无法证明则 reject；
- 不使用全局 regex、`trim` 或选区外扩展来“修复”不安全范围；
- diagnostic 只包含稳定 code/message，不包含 source snippet。

## 5. Cancellation、diagnostic 与语言 registry

### 5.1 Cancellation

新增最小 host-neutral `CancellationToken`：`isCancellationRequested`、一次性 listener
注册和 disposer。direct executor 在 parse、layout、render 前后检查；worker executor 在
排队、派发、响应和 commit 前检查。取消中的结果永不进入 edit set。

### 5.2 Diagnostic 转换

`src/adapters/diagnostics/` 将 core diagnostic 转为 host diagnostic：保留 code、severity、
绝对 span、recovery action 和安全 message；不复制 raw SQL、identifier、literal、path、URL。
warning 可以继续计算并提交安全结果，error/fatal 使 transaction reject。单次事务聚合结果按
target id 与 source span 稳定排序。

### 5.3 Supported language registry

`src/adapters/vscode/supported-languages.ts` 是 selector、command enablement、DDL context
和测试的唯一 registry，首版显式列出 `sql` 与 `hive-sql`，不使用宽泛 `/sql/` 正则。Wave 4
只建立可测试 registry，不修改 package.json 的现役贡献；Wave 5 cutover 时由该 registry 生成/校验 contribution。

## 6. FormatterExecutor

### 6.1 统一接口

新增 `src/adapters/executor/`：

```ts
interface FormatterExecutor {
    format(request: FormatExecutionRequest): Promise<FormatResult>;
    dispose(): Promise<void>;
}
```

`DirectFormatterExecutor` 直接调用 core target pipeline；`PersistentWorkerExecutor` 使用同一
编译产物的 worker entry。executor 不实现 SQL 规则，只负责调度、request id、错误边界和资源生命周期。

### 6.2 Threshold 与 worker 规则

默认阈值由 Wave 4 benchmark 冻结为 source code-unit 和 leaf count 的显式配置，默认值在
4C 通过固定 corpus 选择；测试可以注入阈值。低于阈值 direct，高于阈值 worker，两条路径
必须输出同一 result text/status/diagnostic/sourceMap digest。

worker 请求串行执行，保证取消和 crash recovery 可证明：

- queued cancellation 只移除该 request；
- active cancellation terminate worker，当前 request 返回 cancelled，队列重启后继续；
- worker `error`/`exit` 无正常响应时当前 request failed，后续请求在新 worker 上继续；
- request id、document version 和 source digest 不匹配时丢弃 stale response；
- dispose 终止 worker，所有未完成请求以 cancelled 结束。

worker 只传输 source/options/target mode 等结构化输入，不传输 editor、selection object 或可变 core object。

## 7. Experimental Hive DDL

### 7.1 独立 parser 与支持边界

新增 `src/experimental/ddl/`，只依赖 core lexer、span/depth、diagnostic 和 result contract。
第一版只将明确建模的 Hive `CREATE TABLE` 子集标记为 formatted；ALTER、DROP、多 statement、
未消费的 constraint/default、未知 suffix、未闭合 delimiter 和无法证明列边界的输入整体 `preserved`
或 `failed`。不能静默删除字段、约束或 suffix。

DDL CST 至少包含 document、create-table、table-name、column-list、column、type、comment、
table-suffix。列和 type 的边界来自 lossless leaves、paren/angle depth 和 protected channel；
禁止 `indexOf("(")`、全局 whitespace collapse、raw regex splitter 和重复 angle parser。

### 7.2 DDL layout

只改已证明的 DDL keyword/type keyword、column separator、缩进和最终布局 trivia。反引号标识符、
string/block/line comment、未知 suffix 的原始 code-unit 必须保留。支持并测试 `DECIMAL(18,2)`、
`ARRAY<STRING>`、`MAP<STRING,STRING>`、嵌套 `STRUCT<...>`、quoted member、comment 内逗号和括号。

### 7.3 Extract DDL result

新增：

```ts
type ExtractDdlStatus = "extracted" | "unsupported" | "ambiguous" | "empty" | "failed";
```

只有 `extracted` 且生成文本非空时允许编辑；其他状态的 `text` 必须等于 source，并带 diagnostic。
Extract 使用 v2 query CST/analysis 的 statement ownership，不再扫描“最后一个 SELECT”。
任一 wildcard、重复 alias、畸形 alias、无法确定 item 名称、混合可/不可提取 item、
多 statement 或 UNION branch schema 不一致均为全量 `ambiguous`，不得返回部分 schema。
不得无诊断伪造 `BIGINT`；默认使用显眼的 `__TYPE_REQUIRED__` 占位或要求显式 `defaultType`，
其行为在 config/schema 和测试中固定。

## 8. 测试与性能门

### 8.1 必须的自动化证据

- public API：two-argument root export、status/result immutability、failed text identity；
- transaction：overlap、out-of-bounds、protected boundary、multi-target atomicity、stale version、
  cancellation、edit rejection、cursor map；
- executor：direct/worker parity、queued/active cancellation、crash recovery、stale response、dispose；
- DDL：complex types、quoted content、unknown suffix、malformed input、idempotency、source conservation；
- Extract：positive high-confidence、all ambiguous/empty/unsupported/failed cases and no partial schema；
- properties：token equivalence、protected preservation、no-throw fuzz、`extracted` iff non-empty;
- unchanged 1.x regression and v2 Wave 0/1/2/3 gates remain green.

### 8.2 性能

- executor benchmark 固定记录 direct/worker 的 p50、p95、峰值内存和 cancellation latency；
- DDL benchmark 覆盖 100、800、1200 columns、深嵌套 STRUCT、长 COMMENT、大 set query；
- 规模扩大 8 倍 median 不得超过 12 倍；worker 不得在 source transfer 计时中重复编译 core；
- 不通过提高阈值、减少样本或强制 GC 掩盖退化；失败报告必须保留每轮原始数据。

## 9. Wave 5 交接

Wave 4 完成后只交付 v2 `src/**`、测试、设计/计划和必要技术文档。Wave 5 才负责：

- 将 VS Code runtime 切到 v2 adapter；
- 删除旧 core、root shim、legacy command 和 positional API；
- 收敛 package/VSIX allowlist、README、CHANGELOG、migration guide；
- 在 `main` 上完成 major release。

Wave 4 的完成不等于可以合并 `main` 或发布；必须保留当前 1.x 可用状态直到 Wave 5 release gate。
