# SQL Formatter v2 长期优化程序设计

- 日期：2026-07-10
- 状态：已批准
- 适用范围：SQL / Hive SQL formatter core、VS Code adapter、experimental Hive DDL、配置与公开 API、测试、性能、打包和发布流程

## 1. 背景

当前项目已经形成 `core / adapters / experimental` 的合理分层，也具备 MutationPlan、不变量检查、诊断报告、回归测试和较轻的运行时依赖等基础。但是，审计确认现有实现仍存在一组不能通过局部补丁长期解决的问题：

- 最终全局空白处理会改写 dollar string、多行字符串、块注释等受保护内容；
- lexer 会拆坏参数、literal prefix 和多字符方言操作符；
- clause、scope、list、spacing 和 width 存在多套推断逻辑；
- 部分合法子查询会触发 protected token invariant；
- 无 `FROM` 查询、数组、嵌套查询和空行恢复存在边界错误或非幂等行为；
- experimental DDL 会改写 quoted identifier / literal，Extract DDL 失败时可能清空选区；
- range formatting、multi-selection 和异步编辑缺少事务性；
- 多个热路径反复扫描全部 token、node 或 mutation，已观察到接近 O(N²) 的增长；
- 配置、命令、公开 API、support matrix 和实际行为之间存在不一致；
- root shim、legacy command、旧 positional API、不可达模块和打包内容增加维护负担。

用户已明确选择长期最优路线：当前 1.x 可以继续使用，v2 不需要维持旧内部实现、旧 API、旧命令或历史输出快照兼容。

## 2. 已确认的产品决策

1. Hive 是默认且优先完整支持的 dialect。
2. 保留 generic、PostgreSQL 和 MySQL 模式，但只格式化已明确建模并通过测试的结构。
3. 遇到未完整建模的结构时，默认保持原文并产生明确 warning；`bail_out` 是用户主动启用的严格模式。
4. 保留真正有价值的 `keywordCase`、`indentStyle`、`commaStyle`、`caseLayout` 等配置，并确保每个公开值都有真实、可验证的行为。
5. `sqlddl` 和 `extractddl` 继续作为 Hive experimental 能力；低置信、失败或空结果不得修改文档。
6. v2 分波次开发和验证，但全部完成后统一作为一次 major 版本发布。
7. 当前 1.x 冻结功能开发；如确有必要，只接受独立的严重数据损坏或安全 hotfix，不向 1.x 回迁 v2 架构。

## 3. 目标

### 3.1 语义安全

- 字符串、注释、quoted identifier、参数和 opaque 结构按 JS source string 原文保真。
- formatter 不得通过猜测改变未知语法。
- 任意可恢复或不可恢复失败均不得产生空替换、部分编辑或 SQL 损坏。
- 格式化前后的有效非 trivia token 序列必须等价；允许的差异仅限已配置的 keyword case 和布局 trivia。

### 3.2 长期可维护性

- clause、operator、dialect capability、scope、list、spacing、width 和配置各自只有一个权威来源。
- lexer、syntax、layout、renderer、diagnostics 和 adapter 职责单一，依赖方向清晰。
- 使用 TypeScript strict mode 表达 token、CST、layout IR、diagnostic 和 result 的不可变契约。
- 删除旧路径 shim、legacy command、旧 positional API 和不可达实现。

### 3.3 扩展性

- Hive grammar 和 formatting policy 可独立扩展。
- 非 Hive dialect 通过显式 capability 和 registry 扩展，不通过全局正则或名称猜测扩展。
- unsupported construct 可以稳定降级为 opaque/verbatim，而不阻塞其他已知 statement。

### 3.4 稳定性与生产适配

- 整文档、选区、多选区和 experimental command 都使用结构化结果与事务性编辑。
- 大文档格式化异步、可取消，不长期阻塞 VS Code extension host。
- 时间和空间复杂度接近线性，并由固定 corpus 与 benchmark 持续约束。
- CI、VSIX 内容、版本、提交 SHA 和 Release target 可追溯。

## 4. 非目标

- v2 不是 SQL 执行器、类型检查器、查询优化器或完整语义验证器。
- 不承诺覆盖所有数据库的完整语法。
- 不保留旧输出的逐行 snapshot 兼容。
- 不保留 legacy command、root require shim、`vkbeautify` positional bridge 或 `extension.*` 配置兼容。
- 不将 experimental DDL 描述成通用 DDL parser。
- 不在 renderer 之后增加任何全局 SQL 正则修补阶段。

## 5. 方案评估

### 5.1 旧核心逐项修补

优点是短期改动小，但会继续维护多套 clause/scope/spacing 模型，后续清理会再次改变行为，产生两次迁移和两轮回归风险，因此否决。

### 5.2 直接采用普通 AST parser

普通 AST 通常不完整保留注释、空白、原始 token 和错误片段，无法天然满足 formatter 的 source string 保真和 opaque fallback 要求。外部 parser 的 Hive 覆盖、包体、许可证与错误恢复也尚未验证，因此不能把“使用 AST”本身当作长期架构。

### 5.3 并行重建 lossless formatter core

采用 lossless lexer、formatter-oriented CST、统一 Layout IR 和单一 renderer。当前版本继续可用，v2 达到门槛后一次性切换。该方案能从结构上消除本次审计发现的主要根因，确定为目标方案。

## 6. 总体架构

```text
SQL source
  -> lossless lexer
  -> formatter-oriented lossless CST
  -> dialect validation and recovery
  -> one-time structural indexes
  -> formatting policy
  -> Layout IR
  -> single renderer
  -> structured FormatResult
  -> API / VS Code adapter
```

建议的源码边界：

```text
src/
  core/
    lexer/
    syntax/
    dialects/
    analysis/
    layout/
    renderer/
    diagnostics/
    api/
  adapters/
    vscode/
  experimental/
    ddl/
dist/
```

- `src/` 是唯一源码来源。
- `dist/` 是构建产物，只用于测试打包结果和 VSIX。
- TypeScript 是开发/构建依赖，不因语言迁移本身增加运行时依赖。
- parser runtime 依赖只有在技术验证证明其价值并通过许可证、体积与性能检查后才允许引入，最终只能保留一个生产 backend。

## 7. Lossless lexer

Core 接收的是 JavaScript string，不是带原始文件编码信息的 byte buffer。因此：

- `SourceSpan.start/end` 使用 end-exclusive UTF-16 code-unit offset，与 JavaScript `slice()` 和 VS Code 文档 offset 一致；
- 本文中的“字节保真”均指 source string 的 code-unit sequence 不变，实际可执行不变量是拼接全部 leaf `raw` 后与输入 string 严格相等；
- 文件编码、BOM 与落盘编码属于 adapter/host 边界，不由 formatter core 推断。

每个 leaf token/trivia 至少包含：

```ts
type SourceSpan = {
    start: number;
    end: number;
};

type Token = {
    id: number;
    kind: TokenKind;
    raw: string;
    span: SourceSpan;
};
```

硬约束：

- 按 source order 拼接全部 leaf token/trivia 的 `raw` 必须严格等于输入。
- leaf span 必须按 UTF-16 code-unit offset 对输入形成无重叠、无遗漏分区。
- 父级 CST span 可以包含子节点；无祖先关系的节点不得部分重叠。
- lexer 采用 maximal-munch，优先识别最长合法 token。
- 参数、literal prefix 和方言操作符必须在 lexer 层成为原子 token，例如 `$1`、`:id`、`@name`、`E'...'`、`U&'...'`、`_utf8mb4'...'`、`0b101`、`@>`、`<@`、`!~*`、`?|`、`?&`、`@?` 和 `@@`。
- 字符串、quoted identifier、line comment 和 block comment 的 `raw` 不允许被后续阶段改写。

## 8. Formatter-oriented CST

CST 以格式化所需的结构为边界，不承担数据库完整语义分析。

第一方 Hive 查询结构至少覆盖：

- multi-statement；
- `WITH` / CTE；
- query expression 与 set operation；
- `SELECT` list，包括无 `FROM` 查询；
- `FROM`、join、subquery 和 table construct；
- `LATERAL VIEW` / `EXPLODE`；
- `WHERE`、`GROUP BY`、`HAVING`、window；
- `ORDER BY`、`CLUSTER BY`、`DISTRIBUTE BY`、`SORT BY`、`LIMIT`；
- `INSERT OVERWRITE ... PARTITION`；
- `CASE`、function call、array/map/struct、cast 和 type expression。

表达式建议使用由 dialect operator registry 驱动的 Pratt parser。statement/clause parser 使用可同步恢复的容错解析，恢复点限定在可证明安全的 statement boundary、clause boundary、顶层逗号或匹配括号。

不能可靠解析的结构按以下顺序处理：

1. 能证明边界：创建 `OpaqueNode`，按原始 source slice 输出该范围。
2. 只能证明 statement 边界：保留整个 statement，其他 statement 可继续格式化。
3. statement 边界也不可靠：保留整个请求目标。

不允许仅依据某个单词值认定 `QUALIFY`、`PIVOT`、`MATCH_RECOGNIZE` 等真实 construct；必须结合上下文、深度和结构边界。

## 9. Trivia 与注释

- 空白和注释作为 lossless trivia 保存在 CST 中。
- 注释关联只有 leading、trailing、dangling 三类，并由相邻 token、原始换行和容器节点确定。
- trailing comment 必须与其语句项保持稳定关联。
- dangling comment 必须由明确容器负责，不能通过 marker 在 layout 与 restore 阶段传递。
- 注释文本中的 clause、逗号、括号、关键字和空行不参与结构判断。

## 10. 一次性结构索引

analysis 阶段一次性构建：

- parent/ancestor index；
- statement 与 clause index；
- bracket/depth index；
- list/member/separator index；
- token offset 与 line index；
- source span lookup；
- dialect capability lookup。

后续 visitor 只能查询这些索引，不得在每个 node 或每一行上重新过滤全部 token、owner 或 mutation。

目标复杂度：

- lexing：O(n)；
- CST construction：O(n) 或有界 O(n log n)；
- index construction：O(n)；
- layout generation：O(n)；
- rendering：O(n)。

## 11. Layout IR 与 renderer

Layout IR 至少包含：

- `Text`；
- `Verbatim`；
- `Concat`；
- `Line`；
- `SoftLine`；
- `Indent`；
- `Align`；
- `Group`。

约束：

- formatting policy 只能生成 IR，不能直接做最终字符串全局替换。
- `Verbatim` 只能引用原始 source span，renderer 必须按原始 code-unit sequence 写回。
- spacing、keyword case、comma placement、CASE layout 和 AS alignment 均由同一 policy/IR 路径产生。
- 宽度测量必须复用 renderer 的 token/IR 语义，不能维护第二套 operator width 公式。
- renderer 是唯一能生成格式化空白的组件。
- render 完成后只允许执行断言和结果封装，禁止再执行 whitespace normalization。

## 12. Dialect 模型

`hive` 是默认 dialect。每个 dialect profile 显式声明：

- keywords；
- operators 与 precedence；
- literal/identifier lexical forms；
- clauses 与 table constructs；
- type syntax；
- parser extensions；
- formatter capabilities。

`generic`、`postgresql` 和 `mysql` 只暴露已有 corpus 与行为测试证明的 capability。support matrix 不再使用单一“支持/不支持”，而使用：

- recognized；
- structured；
- formatted；
- verbatim；
- diagnostic。

registry 是 support matrix、parser、formatter 和测试生成/校验的唯一来源。

## 13. 公开 API 与结果契约

公开调用收敛为：

```ts
formatSql(source: string, options: FormatOptions): FormatResult
```

`FormatResult`：

```ts
type FormatStatus =
    | "formatted"
    | "unchanged"
    | "preserved"
    | "failed";

type FormatResult = {
    status: FormatStatus;
    text: string;
    diagnostics: Diagnostic[];
    sourceMap?: SourceMap;
};
```

契约：

- `unchanged` 表示输入已符合格式；
- `preserved` 表示因 unsupported、边界不完整或用户策略而保持原文；
- `failed` 必须携带原始文本，不得返回空字符串；
- public boundary 捕获用户输入导致的解析失败并转换成 diagnostic；
- internal invariant failure 转换成稳定的 internal-error diagnostic，同时保留原文；
- 删除 positional API、root shim 和旧 `vkbeautify` compatibility bridge。

## 14. 错误与 unsupported 策略

Diagnostic 至少包含稳定 code、severity、message、source span 和 recovery action。

默认策略 `warn`：

- 能隔离的未知 node 按原始 source slice 保留；
- 已知周边结构可以继续格式化；
- 返回 warning，adapter 负责可见提示；
- 不得宣称 detector-only 语法已被 opaque preserved。

`preserve`：

- 使用同样的安全保留策略；
- 不显示用户级 warning，但结果仍可包含非展示型 diagnostic 供 API 检查。

`bail_out`：

- 当前请求目标整体保持原文；
- 返回明确 diagnostic；
- adapter 不提交该目标的编辑。

unterminated string/comment、无法确定 statement 边界或 internal invariant failure 必须升级为目标级 preserve/failed。

## 15. 配置模型

配置只使用 `sqlBeautify.*` 命名空间，并由一个 canonical schema 负责：

- 默认值；
- 枚举值；
- TypeScript 类型；
- adapter normalization；
- `package.json` contribution 校验或生成；
- 用户文档片段；
- 配置回归测试。

优先级固定为：

1. API/command 显式参数；
2. VS Code language-scoped workspace setting；
3. VS Code workspace setting；
4. canonical default。

保留且完整实现有行为价值的配置，包括 keyword case、indent、comma style、CASE layout 和 unsupported policy。删除没有实际分支的 `languageMode`，改用默认 `hive` 的显式 `dialect`。

任何配置值在进入公开 schema 前必须同时具备：

- 独立行为实现；
- 正反例；
- 幂等性测试；
- 文档说明；
- 与其他配置组合的优先级定义。

整文档默认保留输入是否具有最终换行；range/fragment formatting 绝不在选择范围外增加换行。

## 16. VS Code adapter

adapter 只负责：

- 读取并归一化配置；
- 捕获 document version、selection 和 cancellation token；
- 调用 formatter executor；
- 转换 diagnostic；
- 构造并提交原子编辑；
- 恢复合理的 cursor/selection。

整文档和多选区流程：

1. 捕获文档版本和全部目标。
2. 在不修改 editor 的情况下计算全部结果。
3. 验证 document version、目标边界、重叠、fatal result 和 cancellation。
4. 任一 fatal result 取消整次命令。
5. 将全部有效变更构造成一次 WorkspaceEdit 或 provider edit set。
6. 一次提交；失败时不重试部分 selection。

selection 必须满足：

- 起止点不位于字符串、注释或 quoted token 内部；
- 只包含完整、可安全格式化的 CST fragment；
- 不扩大到用户未选择的 source range；
- 不因 core 的最终换行策略产生额外空行。

大文档通过异步 FormatterExecutor 执行。阈值由 benchmark 决定；小文档可直接执行，大文档使用持久 worker，二者必须调用同一 core artifact 并支持取消。

VS Code contribution 使用一份受校验的 supported-language registry：

- formatter provider selector、command enablement、keybinding `when` 条件和测试使用同一组 language ID；
- 不再使用范围宽于 provider selector 的 `/sql/` 正则；
- 每个用户命令在 Command Palette 中只出现一次；
- experimental DDL command 只在明确支持的 SQL/Hive language context 中启用。

## 17. Experimental Hive DDL

DDL 与 query formatter 共享：

- lossless lexer；
- span/depth 基础设施；
- diagnostic；
- result contract；
- adapter transaction。

DDL 保留独立 parser 和命令边界，至少正确处理：

- `DECIMAL(18,2)`；
- `ARRAY<STRING>`；
- `MAP<STRING,STRING>`；
- 嵌套 `STRUCT<...>`；
- quoted identifier 内的逗号、括号和类型关键字；
- `COMMENT` string 内的逗号与 SQL 关键字；
- 括号、尖括号和 function argument 的顶层分隔。

禁止对整个 DDL 执行 whitespace collapse。类型大小写和分隔空白只能由 CST/layout 改写。

Extract DDL 使用 discriminated result；只有高置信且非空的 `extracted` 结果可以产生编辑。unsupported、ambiguous、empty 和 failed 都保持原文并产生 diagnostic。

## 18. 性能设计

- 所有 hot path 必须基于预计算 index 或 cursor，不允许在每个 node/line 上扫描全部 token。
- token、node 和 layout object 的生命周期限制在一次请求内。
- source slice 尽量引用 span，在 renderer 边界统一 materialize。
- benchmark 覆盖 100、800、1200 statement 以及大 CTE、深嵌套表达式和长注释。
- 固定 benchmark 采用 warm-up 后 median，并记录输入规模、耗时和峰值内存。
- 首个 parser prototype 必须先建立绝对 latency 基线；随后提交硬门槛。
- 规模扩大 8 倍时，median 耗时增长不得超过 12 倍，避免重新出现近二次增长。
- 后续提交不得在固定 runner 上使已提交 v2 baseline 无解释退化超过 20%。
- worker 路径必须测试 cancellation、crash recovery 和 stale document result 丢弃。

## 19. 测试策略

### 19.1 属性与不变量

- lexer source conservation；
- leaf span partition；
- CST containment；
- protected/verbatim source preservation；
- output non-trivia token equivalence；
- format idempotency；
- failed/preserved result returns original text；
- no marker leakage。

### 19.2 行为回归

必须固化本次审计发现的全部 P0/P1 输入，包括：

- dollar string、CRLF、多空行字符串和块注释；
- literal/quoted identifier 开头的嵌套 SELECT/CTE；
- placeholders、literal prefixes 和方言操作符；
- 无 `FROM` SELECT、array/list、嵌套 clause 和空行；
- leading/trailing comma；
- operator width、AS alignment、CASE 和 comments；
- `MATCH_RECOGNIZE` 函数名误判；
- selection ending before newline；
- multi-selection 原子性；
- DDL quoted identifier/literal 与 Extract DDL 空结果。

### 19.3 Corpus

建立 Hive-first 的真实生产形态 corpus，至少覆盖 CTE、subquery、window、lateral view/explode、insert overwrite partition、复杂类型、templated placeholder、注释密集 SQL 和多 statement。

现有测试作为行为证据复用，但不要求 v2 复刻全部历史布局。任何 intentional output change 必须更新 golden fixture，并在迁移说明中给出前后示例。

### 19.4 集成与打包

- core、adapter、DDL、config 和 generated support matrix 分层测试；
- VS Code provider/command mock；
- `npm run test:verify` 对应的完整长期回归；
- VSIX allowlist 与内容检查；
- `git diff --check`；
- release workflow 的版本/SHA/tag 一致性检查。

## 20. 实施波次

本文件是 umbrella design。每个波次在实现前必须形成自己的聚焦 spec 和 implementation plan。

### Wave 0：技术验证与契约冻结

- 对外部 lossless parser/CST 候选与自研 formatter-oriented parser 做有时限比较；
- 使用相同 Hive corpus 检查 round-trip、错误恢复、扩展性、包体、许可证和性能；
- 记录 ADR，并选择唯一 backend；
- 冻结 token、CST、diagnostic、Layout IR、FormatResult 和 config schema 契约；
- 建立 benchmark baseline。

### Wave 1：Lexing 与 lossless foundation

- TypeScript strict 工程骨架；
- lexer、source span、trivia、diagnostic；
- source conservation 和方言 token 回归；
- v2 独立入口，不接管现有命令。

### Wave 2：CST、dialect 与 analysis

- Hive-first query CST；
- Pratt expression parser；
- recovery/opaque node；
- 一次性结构索引；
- support matrix capability registry。

### Wave 3：Layout 与 renderer

- Layout IR；
- 单一 renderer；
- spacing/width/comma/CASE/AS/comment policy；
- 配置组合与幂等性；
- 删除任何 render 后正则 normalize。

### Wave 4：Adapter 与 DDL

- structured public API；
- VS Code transaction、range、多选区、diagnostic 和 cancellation；
- 大文档 executor/worker；
- experimental Hive DDL 和 Extract DDL 安全重建。

### Wave 5：Cutover 与发布

- 删除旧 core、shim、legacy command、positional API 和死代码；
- 收敛打包 allowlist；
- 将仍有长期价值的历史设计结论提炼为 ADR，归档或删除已完成、已失效的重复 implementation plan；
- 完成 migration guide、README、CHANGELOG、architecture 和 support matrix；
- CI least privilege；
- 全量 correctness、idempotency、performance 和 VSIX 验证；
- 从 `main` 发布 major 版本。

## 21. 迁移与公开面

- 新命令统一采用 `sqlBeautify.*` ID。
- 旧 `extension.*` command 不保留 alias。
- 配置仍使用 `sqlBeautify.*`；有真实价值的设置尽量保持名称，语义变化写入 migration guide。
- `languageMode` 被 `dialect` 替代。
- JS 调用方迁移到对象式 `formatSql(source, options)` 和 `FormatResult`。
- README 只保留最终用户用法、配置和 experimental 风险说明。
- 架构、能力状态和迁移细节放入 `docs/technical/`、CHANGELOG 或独立 migration guide。

## 22. CI、打包与发布

- workflow 默认 `contents: read`。
- 只有 release job 获得必要的 `contents: write`。
- PR/push 只构建、测试和预检 VSIX，不创建 release。
- VSIX 使用 allowlist，仅包含运行所需 `dist/`、package metadata、README、CHANGELOG、LICENSE 和必要 images。
- 不包含 generator script、测试、历史 spec、旧模块和本地 VSIX。
- 历史 superpowers 文档不进入 VSIX；仓库内只保留仍有追踪价值的 spec/plan，稳定架构结论转入简洁 ADR。
- 正式发布只能从 `main` 触发。
- package version、tag、Release target、workflow run SHA、`origin/main` SHA 和 VSIX 文件名必须一致。

## 23. 审计问题追踪

| 问题族 | v2 结构性处理 |
| --- | --- |
| protected token 被全局空白处理改写 | lossless leaf + Verbatim + 禁止 post-render normalize |
| 参数、literal prefix、方言 operator 被拆坏 | maximal-munch lexer + dialect lexical registry |
| protected token spacing invariant 冲突 | CST policy 不直接修改 protected leaf |
| DDL/Extract DDL 破坏性行为 | 独立 CST + discriminated result + atomic adapter |
| trailing comma 配置无行为 | canonical config + 单一 list layout policy |
| range newline 与 multi-selection 部分编辑 | fragment boundary contract + single transaction |
| 空行恢复、无 FROM、array/list 非幂等 | CST clause/list/trivia ownership |
| 双 renderer spacing/width 漂移 | 单一 Layout IR 与 renderer measurement |
| O(N²) owner/range/line scan | one-time indexes + benchmark gate |
| unsupported syntax false positive | context-aware construct recognition + opaque recovery |
| token/array 接口误用 | TypeScript strict discriminated types |
| 配置、命令、support matrix 不一致 | canonical schema/registry 生成或校验 |
| keybinding 正则宽于 provider selector、命令重复展示 | supported-language registry + contribution contract test |
| root shim、legacy API、dead module、包污染 | major cutover 删除 + VSIX allowlist |
| 历史计划文档体积与有效信息失衡 | 提炼 ADR + 归档/删除失效计划 |
| CI 权限过宽 | workflow/job least privilege |

## 24. 风险与缓解

### Hive grammar 范围膨胀

使用 formatter-oriented CST、真实 corpus 优先级和 opaque fallback，不以一次覆盖完整 Hive grammar 为发布前提，但不得把未建模能力标成 formatted。

### 外部 parser 不满足 lossless 要求

Wave 0 使用同一 acceptance corpus 比较；不满足 source string round-trip、error recovery 或扩展要求即拒绝。架构不依赖候选库的私有 AST。

### CST 内存开销

使用 source span 和共享 source，避免为每个 node 复制 raw text；在 benchmark 中同时记录峰值内存。

### 输出大幅变化

不追求旧 snapshot 兼容，但所有变化必须通过 token equivalence、idempotency 和人工可审查 golden fixture；发布时提供关键前后示例。

### 长期分支漂移

每个 wave 独立提交、验证和文档化；旧核心在切换前不接受功能扩张；只有最终 release gate 完成后才替换默认入口。

### Worker 与平台兼容

core 保持纯函数和平台无关；执行器属于 adapter。首发明确支持的 VS Code host 范围，Web extension 如未验证则不宣称支持。

## 25. 完成标准

v2 只有在以下条件全部满足后才可以接管默认 formatter：

1. 本次审计的全部 P0/P1 输入均有自动化回归并通过。
2. lexer source conservation、protected/verbatim preservation 和 output token equivalence 属性成立。
3. 完整 corpus 二次格式化结果不变。
4. unknown/unsupported/failed 输入均不会产生破坏性编辑。
5. clause、scope、list、spacing、width、config 和 capability 不存在第二权威来源。
6. 固定 benchmark 满足复杂度与退化门槛。
7. 整文档、range、多选区、cancellation 和 stale document 行为均通过 adapter 测试。
8. experimental DDL 通过复杂类型、quoted content 和 empty result 安全测试。
9. legacy command、root shim、positional API、不可达模块和无关 VSIX 内容已删除。
10. README、migration guide、architecture、support matrix、CHANGELOG 和 package metadata 一致。
11. CI 权限最小化，测试、打包和 release SHA 验证全部通过。
12. major 发布提交已合入并推送到 `main`，正式 VSIX 从该 SHA 构建。
