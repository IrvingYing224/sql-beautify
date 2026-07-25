# SQL Beautify 2.0.1 工程审查报告

> 这是一次性的工程审查记录，不是维护契约。架构与内部契约以
> [`sql-formatter-architecture.md`](sql-formatter-architecture.md) 为准，能力矩阵以
> [`sql-support-matrix.md`](sql-support-matrix.md) 为准。本文只记录审查当时观察到的问题、
> 实测数据与改进建议。

- 审查对象：`vscode-sql-beautify` 2.0.1
- 审查提交：`bc08772`（分支 `codex/docs-v2.0.1-cleanup`，除本报告外源码基线干净）
- 审查日期：2026-07-26
- 基线状态：`npm run test:verify` 退出码 0，Wave 1–5 全部通过；`npm run verify:clean-package` 通过
- 实测环境：Node v24.18.0 / darwin arm64 / Apple M1 Pro（10 核）/ 32 GB / V8 `heap_size_limit` 4288 MB

**现有测试门没有把本文列出的现象判为失败**——有的确实未覆盖，有的则被**显式断言为预期契约**。
两者的处理方式完全不同：前者补测试即可，后者要先改契约再改测试。属于后者的已在正文标注，例如
[4.2](#42-unsupportedsyntaxpolicy-preserve-下完全静默)（`wave5-vscode-adapter.test.js:350`
断言 preserve 必须抑制编辑器 capability warning）与
[3.5](#35-worker-生命周期)（`wave4c-worker-lifecycle.test.js:173/288`
断言 `ADAPTER_WORKER_TIMEOUT` / `ADAPTER_WORKER_BACKPRESSURE`）。

基线为绿是本报告的前提，不是结论。

### 定级说明

本文**不使用 P0/P1 作为发布阻断定级**。rev.1/rev.2 曾使用 `P0–P4` 作为章节标签，
实践中被读成发布严重度并导致优先级误判，rev.3 起改为描述性章节名，
并在每条缺陷上单独标注影响面。发布是否阻断由维护者结合用户分布另行判断。

### 修订记录

| 版本 | 说明 |
| --- | --- |
| rev.1 | 初稿 |
| rev.2 | 复核后修正 12 处不准确断言 |
| rev.3 | 二次复核后修正 11 处，其中内存与主线程阻塞两项以**独立进程**及**真实 `PersistentWorkerExecutor` 路径**重新测量，结论方向性改变 |
| rev.4 | 收紧 10 处：撤销 maxRSS 线性趋势推断（比值 1.48/1.44/1.44/1.06，两次运行又相差 17–22%）、修正超时余量算术、修正 §3.1 与 §5.2 的问题边界、补齐可运行的 worker 基准脚本、更正"所有问题均未被测试覆盖" |
| rev.5 | 消除 rev.4 遗留的自相矛盾：摘要表、优先级表与附录 C 中残留的 rev.3 旧结论已同步；删除"进程级 maxRSS 逼近单 isolate `heap_size_limit`"这一无测量基础的解释；消除"1 MB 是已验证上界"与"4 MB 已验证可完成"的冲突；软化 §3.1"唯一方案"与 §3.4"确定上界"。被推翻的旧结论见 [附录 C](#附录-c-已撤销的结论) |
| rev.6 | 补做此前只靠阅读推断的验证，并首次全文通读：§2.1 根因跟踪到具体代码并更正错误的文件行号、§4.5 三条 O(n) 复核，其中两条完成实测（并推翻自己对 `linePrefixIsWhitespace` 的根因判断）、自测复现 direct 路由尾延迟至 528 ms 以印证外部的 552 ms。新增 [A.8](#a8-主机层-on-热点)。通读中另查出三处自身错误：§2.3 误称 BOM 诊断会被 `preserve` 抑制（实测 `capabilityId` 为 `null`，不会被抑制）、§5.3 的"约 5 个文件"实为 5–6 个、§7 中 `commaStyle=trailing` 那一项沿用已被推翻的"顺序修复"措辞。全文表格列数、锚点与量化断言均已系统性交叉扫描 |
| rev.7 | 撤销 §2.1 的修复建议——朴素修法与 `render.ts:299-308` 的 source-map 单调性契约直接冲突，无法实现；改为给出"局部降级"与"重构 source-map"两条路线，并把该项从第一批拆分——路线 A 移入第二批（策略降级，不需 ADR）、路线 B 移入第三批。更正 `positionAtText` 少算一倍（每选区 2 次调用，505 KB × 50 选区实为 49.5 ms）、补测 `validateDdlTargets`、为所有微基准补方法学、修正"反向扫很快"的自相矛盾表述、去除对 V8 sliced string 的契约化断言 |

> 若你手上是本文任一早期版本的副本（或从 issue / 聊天记录中引用的片段），
> 先看 [附录 C](#附录-c-已撤销的结论)：其中多条结论已被实测推翻，按旧版行动会做出错误决策。

---

## 目录

- [1. 总体判断](#1-总体判断)
- [2. 已确认的功能缺陷](#2-已确认的功能缺陷)
- [3. 架构与性能](#3-架构与性能)
- [4. 用户体验与可诊断性](#4-用户体验与可诊断性)
- [5. 可维护性与结构](#5-可维护性与结构)
- [6. 能力覆盖度](#6-能力覆盖度)
- [7. 建议落地顺序](#7-建议落地顺序)
- [附录 A 实测数据汇总](#附录-a-实测数据汇总)
- [附录 B 复现方式与测量方法的局限](#附录-b-复现方式与测量方法的局限)
- [附录 C 已撤销的结论](#附录-c-已撤销的结论)

---

## 1. 总体判断

这是一个工程质量明显高于同类 VS Code formatter 的项目。分层（lexer → CST → analysis →
Layout IR → renderer）职责清晰，fail-closed 事务边界完整，token-equivalence 校验闭环，
发布门齐全。`AGENTS.md` 与 `docs/technical/` 描述的架构与代码实际形态一致，这一点很少见。

多轮复核后需要记录两条方法论结论：

1. **本项目的防御性设计比表面看起来更完整。** provenance 短路
   （`isCanonicalParseArtifact` / `ownsNode` / `isCanonicalLayoutPlan`）、
   alignment 的廉价前置检查、worker 侧独立 digest 校验、`adapter-contract` 的
   语言→dialect 缺省映射，初读时都容易被误判为缺失，实际均已实现。
   审查此类代码必须先验证"是否已存在"。
2. **性能与内存结论必须在独立进程、真实执行路径上测量。** rev.1–rev.2 的内存数据来自
   同一进程内连续测量，被 GC 时机污染，导致"堆增长次线性""内存不是主要风险"两个错误结论；
   主线程阻塞上限则因为只测了单一语料形态而被低估。见
   [附录 B.4](#b4-测量方法的已知局限)。

当前已确认的风险面：

| 风险 | 表现 |
| --- | --- |
| 外部输入多样性覆盖不足 | CRLF、BOM、`trailing` 逗号 + 行尾注释组合、非 ASCII 标识符，均未进入回归 |
| 可诊断性 | 内核诊断信息丰富，但传到用户眼前时被统一抹成一句 `Formatter reported a recoverable diagnostic` |
| 大输入的时间与内存 | 4 MB 输入实测 49.99 s / maxRSS 4.35 GB，完成后距 60 s 硬超时仅剩 10.01 s（预算的 16.7%）；当前无单请求体积上限 |
| 主线程阻塞 | direct 路由中位约 340–420 ms，**尾延迟已观测至 552 ms**，上限未确定；`Format Selection` 另有与选区大小无关的全文档分析开销 |

---

## 2. 已确认的功能缺陷

| # | 缺陷 | 影响面 | 是否有 workaround |
| --- | --- | --- | --- |
| [2.1](#21-commastyle-trailing--行尾注释--逗号单独成行且对齐全失) | `trailing` 逗号 + 行尾注释 | 中：非默认选项组合 | 有（改用默认 `leading`） |
| [2.2](#22-crlf-输入--输出混合行尾) | CRLF → 混合行尾 | 高：影响所有 CRLF 仓库，产生大规模 diff | 无 |
| [2.3](#23-utf-8-bom--静默完全不格式化) | BOM → 静默 no-op | 中：表现为安全 no-op，无数据损坏 | 有（去掉 BOM） |

### 2.1 `commaStyle: "trailing"` + 行尾注释 → 逗号单独成行且对齐全失

输入：

```sql
select aaaaaaaaaa as x -- c1
, b as y -- c2
, cc as z -- c3
from t
```

| `commaStyle` | 输出 |
| --- | --- |
| `leading`（默认） | <pre>SELECT<br>      aaaaaaaaaa AS x -- c1<br>    , b          AS y -- c2<br>    , cc         AS z -- c3<br>FROM t</pre> ✅ |
| `trailing` | <pre>SELECT<br>    aaaaaaaaaa AS x -- c1<br>    ,<br>    b AS y -- c2<br>    ,<br>    cc AS z -- c3<br>FROM t</pre> ❌ |

无行尾注释时 `trailing` 完全正常：

```
SELECT
    aaaaaaaaaa AS x,
    b          AS y,
    cc         AS z
FROM t
```

**根因**（已跟踪到具体代码，非推测）：

1. `query-list-policy.ts:271-276` 对 `trailing` 设 `beforeSeparator = EMPTY`、
   `afterSeparator = HARD_LINE`，即逗号紧跟左侧 item、其后硬换行。这部分是对的。
2. 但行尾注释走 `line-suffix` 通道，在逗号发射时**仍排在队列里未输出**。
3. 逗号 leaf 经 `appendLeaf` → `render.ts:430-438` 的 `beforeSource(",")`：
   检测到有挂起 suffix，先 `flushSuffixes()` 吐出 ` -- c1`，
   由于 `hadLineComment === true` 且 `","` 不以换行开头，**追加一个 `\n`**。
4. 于是逗号被推到新行，`afterSeparator` 的 HARD_LINE 再产生第二个换行。

净效果即 `x -- c1\n,\n`。正确顺序应是 `expr, -- comment`。
同一路径下 `AS` 对齐候选整体失效。

`trailing` 是 README 中一等公民的配置项，但默认值是 `leading`，所以这条组合从未进入回归。

- 定位：`src/core/layout/query-list-policy.ts:271-276`（分隔符 gap 决策）、
  `src/core/renderer/render.ts:430-438`（`beforeSource` 在 flush 行注释后强制换行）

> ⚠️ **朴素修法与 source-map 契约直接冲突，走不通。**
> 复现输入中两个 leaf 的 source span 是：
>
> ```
> -- c1   span 23–28
> ,       span 29–30
> ```
>
> 要输出 `x, -- c1`，就必须**先发射 span 29–30 的逗号，再发射 span 23–28 的注释**。
> 而 `render.ts:299-308` 的 `appendSource` 在 `span.start < previous.sourceEnd`
> （即 23 < 30）时直接 `RenderAbort("RENDER_SOURCE_MAP",
> "Source-derived emissions are out of order")`；`appendMapEntry` 也要求
> source 与 output 同时单调。因此"把行尾注释 line-suffix 绑到分隔符之后"
> **无法在当前契约下实现**。

两条可行路线：

| 路线 | 做法 | 性质 |
| --- | --- | --- |
| A. 局部 fail-closed 降级 | 检测到"注释在前、逗号在后"的边界时，该处**保留 leading comma**（其余位置仍按 `trailing`） | 小改动，输出不完美但安全、可解释；与项目既有的 fail-closed 取向一致 |
| B. 重构 source-map 支持 source run 重排 | 允许 output 单调而 source 非单调，并**重新证明** selection mapping、token equivalence、`isValidSourceMap` 等契约 | **架构级**，需 ADR |

- 回归补在 `tests/v2/wave3e-option-matrix.test.js`，覆盖 `commaStyle × 有无行尾注释`
  的笛卡尔积。若选路线 A，回归应固定"该边界降级为 leading comma"这一预期，
  而不是期望 `x, -- c1`。

### 2.2 CRLF 输入 → 输出混合行尾

```js
in:  "select a,b,c\r\nfrom t\r\nwhere x=1\r\n"
out: "SELECT\n      a\n    , b\n    , c\nFROM t\nWHERE x = 1\r\n"
// 输入 3 个 CR，输出 1 个
```

`renderCanonical` 的 `emitLineBreak()` 硬编码 `appendGenerated("\n", 0, true)`
（`src/core/renderer/render.ts:427`）。全代码库无 EOL 感知——`rg 'eol|EndOfLine'` 在 `src/`
下只命中 experimental DDL 的两处正则；VS Code 适配层从不读 `document.eol`。

**后果**：CRLF 仓库里格式化一次等于整文件 EOL 被打乱，git diff 全红，且文件进入混合 EOL 状态。
这是本文影响面最大的缺陷，建议按发布前高优先级处理。

- 建议：在 `CanonicalFormatOptions` 增加**内部**（非用户可见）`newline: "\n" | "\r\n"`，
  由 lexer 从源文本首个换行推断，或由 VS Code 侧透传 `document.eol`；renderer 作为唯一写入者
  统一使用它。`RENDER_NEWLINE_CONTRACT` 检查同步升级为按选定 EOL 校验。

### 2.3 UTF-8 BOM → 静默完全不格式化

```
输入: "﻿select a,b from t"
结果: status = unchanged，原文不动
诊断: SYN_UNSUPPORTED_STATEMENT warning "hive statement ﻿ is not structured"
```

U+FEFF 既不在 `isHorizontalWhitespace` 也不是标识符起始字符，被当成 `unknown` leaf，
导致整条语句 opaque。带 BOM 的 SQL 文件在 Windows / 中文环境相当常见，
用户按 `Alt+Shift+F` 会完全没有反应。

行为是安全的 no-op，无数据损坏风险。该诊断的 `capabilityId` 为 `null`（已实测），
因此**不会**被 [4.2](#42-unsupportedsyntaxpolicy-preserve-下完全静默) 的 `preserve` 抑制逻辑吞掉，
编辑器里仍会出现一条 warning——但受 [4.1](#41-所有诊断消息被统一抹成一句话影响最大的-ux-问题)
影响，它显示为通用的 `Formatter reported a recoverable diagnostic`，
用户依然无从判断"为什么整个文件不格式化"。

- 定位：`src/core/lexer/character-class.ts:41`、`src/core/lexer/lossless-lexer.ts`
- 建议：在 offset 0 把 U+FEFF 识别为 boundary trivia leaf（保持 lossless）；
  非 offset 0 的 U+FEFF 维持现状。

---

## 3. 架构与性能

### 3.1 `Format Selection` 的前置 range 校验在主线程做全文档分析

`prepareFormatTransactionInternal` 在派发 executor **之前**调用
`validateFormatTargetRanges`，后者只要存在 `fragment` target 就对整个文档
`analyzeSql`（`src/adapters/transaction/range.ts:355`）：

| 文档大小 | 选区大小 | `validateFormatTargetRanges` 耗时 |
| --- | --- | --- |
| 50 KB | 516 B | **158 ms** |
| 151 KB | 516 B | **292 ms** |
| 303 KB | 516 B | **445 ms** |

这段时间发生在 extension host 主线程（命令路径与 range provider 路径都是）。

**准确的问题边界**：被绕过的**只是这段前置校验**——它不经过 executor，因此与
`RoutedFormatterExecutor` 的阈值无关。其后真正的格式化仍然正常走 executor 路由，
大选区照样会进 worker。所以这不是"worker 路由失效"，而是
**在路由决策之前多了一段无法被路由的全文档同步工作**，且这段工作的成本只取决于
文档总大小，与选区大小无关。选区格式化是常见操作，代价直接落在主线程。

**注意两个 artifact 不可直接互换**：range 校验用 `mode: "document"` 分析**完整源文本**，
executor 用 `target.mode`（通常是 `"fragment"`）分析**目标 slice**。
两者的 leaf 分区、statement 边界、恢复行为都不同，因此
"缓存一份 analyze 结果给两边复用"是不成立的。

可行方向：

1. 把 range 校验整体下沉到 worker：新增一次 `validate + format` 组合请求，
   主线程只做便宜的 target 形状校验（`snapshotTarget` / 非重叠 / 行边界）。
   在保持当前"命令触发即全量 analyze"架构、且要求冷路径也不阻塞的前提下，
   这是最直接可靠的方案。若愿意改变该架构，后台增量分析或预计算 artifact
   同样可能消除命令时阻塞。
2. 若要做缓存，缓存键比看起来复杂，至少需要：
   - **document identity（URI）**——`documentVersion` 是文档内单调计数，跨文档不唯一，单用它会撞键；
   - **`dialect` 与 `mode`**——见上文，`document` 与 `fragment` 不是同一个 artifact；
   - 对 fragment 还需 **target range 或 slice digest**——同一文档同一版本下不同选区是不同 slice。

   且**不应以完整 source 字符串做 key**——那会把整份源文本连同 artifact 一起钉在内存里
   （参考 [3.2](#32-时间与内存均构成约束安全上限尚未确定) 的驻留数据）。
   综合看缓存的正确性成本不低，方案 1 更可靠。
3. 短期止血：`fragment` 校验只在 `source.length` 低于阈值时同步做，超过时直接走方案 1。

### 3.2 时间与内存均构成约束，安全上限尚未确定

#### 核心直调（`.tmp/v2-core`，每次独立进程，3 次一致）

1010 KB 输入：

| 指标 | 值 |
| --- | --- |
| 耗时 | 10.99 – 11.16 s |
| status | `formatted` |
| 返回时堆增量 | **1116 – 1122 MB** |
| 返回时 RSS | 1336 – 1344 MB |
| 保留结果并强制 GC 后堆增量 | 131 MB |
| 丢弃结果并强制 GC 后堆增量 | 99 MB |
| source map entries | 162,000 |

"返回时堆增量"（1116 MB）与"GC 后堆增量"（131 MB）相差约 **8.5 倍**，说明**该指标高度依赖 GC 时机，
不能用来推断增长阶数**。rev.2 据此得出的"次线性""内存不是主要风险"两个结论已撤销。

#### 生产 worker 路径（`dist/` artifacts，每次独立进程）

覆盖 `RoutedFormatterExecutor` → `PersistentWorkerExecutor` → worker thread →
structured clone 回传 → 主进程两次 snapshot 的完整链路：

| 源码 | 路由 | 状态 | 耗时 | maxRSS | source map entries |
| --- | --- | --- | --- | --- | --- |
| 513 KB | worker | ready | 6.05 s | 759 MB | 82,296 |
| 1026 KB | worker | ready | 12.51 s | 1477 MB | 164,592 |
| 2052 KB | worker | ready | 24.52 s | 2964 MB | 329,184 |
| **4104 KB** | worker | ready | **49.99 s** | **4352 MB** | 658,368 |

worker 在 4 MB 下仍存活并返回 `ready`。

**不要从上表推断增长规律。** maxRSS / 源码 KB 的四个比值分别为
**1.48 / 1.44 / 1.44 / 1.06**——前三点接近，第四点明显偏低，本报告不解释这个偏离。

> ⚠️ 不要把进程级 `maxRSS` 与 V8 的 `heap_size_limit` 直接比较。
> 该进程同时包含主线程与 worker 的**多个 isolate**，各有独立堆限额；
> RSS 还包含 native memory、代码页、线程栈等非 V8 堆部分。两者不同量纲，
> 任何"逼近 heap 限额"式的解释都缺乏测量基础。

可以说的只有"内存随输入显著增长"；每档只有 1–2 次观测，且
[A.4](#a4-生产-worker-路径dist-artifacts每次独立进程) 显示同一配置两次运行的 maxRSS
可相差 17–22%，不足以判定增长阶数，也不足以外推 8 MB 及以上的行为。

#### 结论

| 断言 | 状态 |
| --- | --- |
| 1 MB 输入可完成 | ✅ 已验证。但 11.82–12.51 s / maxRSS 1.48–1.72 GB（两次观测，见 [A.4](#a4-生产-worker-路径dist-artifacts每次独立进程)）只证明**能完成**，不证明可接受——它不是"舒适区"，也没有对照任何 UX 目标 |
| 内存不是主要风险 | ❌ 撤销。4 MB 时 maxRSS 4.35 GB，对编辑器宿主进程是严重负担 |
| 4 MB 是合理输入上限 | ❌ 撤销。49.99 s 后仅剩 10.01 s，占 `requestTimeoutMs: 60_000` 的 **16.7%**；换言之比本机慢 **20.0%** 的机器即会超时。留给硬件差异的空间过小 |
| 安全上限已确定 | ❌ 未确定。**已验证可完成的最大档位是 4 MB**；而"可接受"需要先定义延迟与内存目标，本报告未定义，故无法给出安全上限 |

`maxQueuedSourceCodeUnits: 4 MB` 只是队列背压，**不是单请求上限**；
当前没有任何单请求体积保护。

建议：

1. 加显式输入上限。**1 MB 是建议的临时风险削减阈值候选**——它只是本报告中
   时间与内存都还在一个数量级内的最大档位，**并未被证明满足任何 UX 或 SLO 目标**。
   超限立即返回带明确 code 的 `preserved`（"文件过大"），而不是让用户等 50 秒再失败。
2. 上调该上限前，需要在更多机器 / 更慢 CPU 上重跑上表，并补测：
   worker 在内存压力下的存活率、`requestTimeoutMs` 的实际命中率、
   以及 162k–658k 条 source-map entry 的 structured clone 单独耗时。
3. source-map entry 数量与源码规模同阶（本报告语料下约 160 entry/KB）。

   > ⚠️ 这个密度**只来自重复拼接的合成语料**，真实异构 SQL 的 entry/KB 可能显著不同
   > （entry 会对连续区间做合并，语料越规整合并率越高）。
   > 更重要的是，本报告**没有做内存归因 profiling**，因此不能断言
   > "source map 比 analysis index 更值得优化"。两者都只是**待 profiling 的候选方向**，
   > 优先级必须先用堆快照确定各组件的实际占比，再决定动谁。

### 3.3 对齐第二遍：廉价前置检查已存在，但存在 false positive

`src/core/api/format.ts:502-602` 在第一次 render 之后调用 `deriveLayoutAlignmentPlan`，
若 `targets.length > 0` 就把 `buildLayoutPlan → compileLayoutPlan → renderLayoutArtifact`
整条重跑。

96 KB 合成样本各阶段中位数：

| 阶段 | 耗时 | 占比 |
| --- | --- | --- |
| `analyzeSql` | 133 ms | 23% |
| `buildLayoutPlan` | 28 ms | 5% |
| `compileLayoutPlan` | 64 ms | 11% |
| `renderLayoutArtifact` | 201 ms | **35%** |
| `deriveLayoutAlignmentPlan` | 109 ms | **19%** |
| equivalence 重新 lex | 10 ms | 2% |

第二遍是否触发取决于语料形态：
`tests/fixtures/production-corpus/public/` 的两个 Hive fixture
（`hive-cte-window-comments.sql`、`hive-template-variables.sql`）**均产出 1 个 target**，
因此在这两个样本上第二遍会跑；而本节的 96 KB 合成样本产出 **0 个 target**。
不能断言"带 `AS` + 行尾注释必然产出 target"——本节下文正说明多行、verbatim、
宽度限制都会让候选归零。

**廉价前置检查已经存在且位置正确**：`hasPotentialAlignmentGroup(lists, comments)` 在
`src/core/layout/alignment-policy.ts:516`，位于 `sourceLeafOutputStarts()`、
`outputPositions()`、`buildItemOutputShapeProjection()` 之前，命中即
`return canonicalPlan(analysis, options, [])`。**不存在"把它前置就能省 19%"的机会。**

真正的问题是**这个检查过于粗糙**。它只判断"是否存在 ≥2 个连续 item 带 `AS` 别名
或恰好 1 条行尾注释"；而最终候选还额外要求 item 单行、无 verbatim、
`position.column < maxAlignWidth`。合成样本（含多行 `CASE`）中前置检查返回 `true`，
109 ms 全量工作跑完后产出 **0 个 target**——纯浪费。

另外 `trailingCommentsByItem(analysis)` 在前置检查**之前**无条件执行，
其内部 `nearestListItemProjection()` 会做一次全节点树遍历。

可行方向：

1. **收窄昂贵计算的作用域。** `sourceLeafOutputStarts()` 遍历全部 leaves、
   `buildItemOutputShapeProjection()` 遍历全部 leaves + 全部 nodes；
   而真正的候选 leaf 只有"item 的 `AS` keyword leaf"和"item 的单条行尾注释 leaf"。
   300 语句合成样本实测：13499 leaves 中候选 leaf 上界为 **900 个（600 个 `AS` +
   300 条行尾注释），占 6.7%**。

   > ⚠️ 6.7% 是**候选 leaf 占比**，不等于耗时可降到 6.7%。
   > `outputLineStarts()` 仍需扫描完整输出文本，source-map 定位也需要可索引结构。
   > 实际收益必须先做原型再测，不能按比例外推。

2. 精化前置检查需要输出行信息（item 是否单行），而这正是昂贵部分，
   因此"更精确的廉价预检"未必存在。方案 1 比继续加强预检更可靠。
3. 中期：让 renderer 支持"带对齐参数的重渲染"，第二遍只重跑 render（201 ms）
   而非 plan + compile + render（293 ms）。

### 3.4 direct 路由的主线程阻塞：尾延迟已观测至 552 ms，上限未确定

`DEFAULT_EXECUTOR_THRESHOLDS = { sourceCodeUnits: 65_536, leafCount: 12_000 }`。
两个阈值任一命中即路由到 worker，因此 direct 路由的成本上界由
**同时低于两个阈值的最坏输入形态**决定，而不是由某一种语料的边界决定。

实测四种形态（均为 direct 路由）：

| 形态 | 源码 | leaves | 中位耗时 | 最高 |
| --- | --- | --- | --- | --- |
| `hive-cte-window-comments.sql` × 63 | 31.8 KB | 11843 | 341 ms | — |
| 注释密集（940 项 / pad 45） | 63.95 KB | 9404 | 385 ms | 410 ms |
| 注释密集（1195 项 / pad 29） | 63.28 KB | 11954 | **400 ms** | **457 ms** |
| 叶子稀疏（大段注释） | 62.8 KB | 342 | 242 ms | — |

**rev.2 声称的"现实上限 300–350 ms"是错的**：它只反映了单一重复语料在 leaf 阈值附近的表现。

**上表 457 ms 不是上限。** 对 6 组同时低于两个阈值的注释密集配置各采样 9 次：

| items / pad | 源码 | leaves | 中位 | 最高 |
| --- | --- | --- | --- | --- |
| 1175 / 30 | 63.3 KB | 11754 | 397 ms | 435 ms |
| 1150 / 30 | 61.9 KB | 11504 | 379 ms | 487 ms |
| 1125 / 30 | 60.5 KB | 11254 | 369 ms | **508 ms** |
| 1175 / 25 | 57.6 KB | 11754 | 360 ms | 498 ms |
| 1075 / 35 | 62.9 KB | 10754 | 386 ms | **528 ms** |
| 1100 / 30 | 59.1 KB | 11004 | 361 ms | 469 ms |

中位稳定在 **360–400 ms**，但**尾部噪声很大**（同量级配置的 max 在 435–528 ms 间跳动）。
另有一次独立复测在 63.44 KB / 11999 leaves 上观察到中位约 421 ms、最高约 552 ms，
与本表同量级，可互相印证。

由于耗时同时受源码长度、注释数量、display-width 计算、CST 形态和 alignment 路径影响，
**本报告无法给出 direct 路由的真实耗时上限**，只能确认它明显高于 rev.2 的估计，
且尾延迟可超过 500 ms。

同理，**"把 leafCount 降到 6000 就能保证约 170 ms"也不成立**——降低 leaf 阈值
不约束源码长度，注释密集的输入仍可在低 leaf 数下消耗大量时间。

若目标是限制主线程延迟，可行方案：

1. 同时校准 `sourceCodeUnits` 与 `leafCount` 两个阈值，并用多形态语料（注释密集 /
   宽字符密集 / 深嵌套）验证组合上界，而不是单一语料。
2. 或者更简单：把所有非微型请求（例如 > 8 KB 或 > 2000 leaves）一律路由到 worker，
   direct 只保留真正的小片段。代价是 worker 冷启；收益是主线程延迟**更容易校准和收紧**
   （双阈值只约束输入规模，并不自动证明所有 CST 形态的耗时上界，仍需多形态实测）。

另外 `src/adapters/executor/routed.ts:51` 的
`snapshot.source.length >= this.thresholds.leafCount` 是拿**码元数**去比**叶子数阈值**。
它恰好安全（`leaves.length <= source.length` 恒成立，只是个下界剪枝），
但读起来像单位混淆，且没有注释说明这个不变量。

### 3.5 worker 生命周期

| 位置 | 问题 | 建议 |
| --- | --- | --- |
| `persistent-worker.ts:262` | 取消 active 请求 = terminate 整个 worker。这是中断同步格式化的唯一手段，选择正确，但代价是每次取消都要付一次 worker 冷启。provider token 在文档变更时就会取消，打字期间容易反复重启 | 加"取消后延迟 terminate"窗口（如 200 ms 内若请求已自然完成则不 terminate） |
| `persistent-worker.ts:376` | timeout 只在派发时装。排队中的请求没有总时限，最坏 `maxQueueSize=64` × 60 s | 加 enqueue 时刻的 deadline |
| `src/runtime/internal.ts` | activate 时 `readFileSync(workerPath)` 整读一个文件**仅为确认存在** | 改 `accessSync`，安全等价 |

> ⚠️ **不要**把主进程算好的 runtime digest 传给 worker 以省掉 worker 侧的
> `readFileSync` + sha256。`worker-entry.ts:34` 计算的是**它自己实际 `require` 的那个文件**
> 的 digest，这提供了"主进程启动后、worker 启动前文件被替换"的检测能力。
> 传入 digest 会把这个校验退化成自证。此处的重复计算是有意的安全成本，不是冗余。

---

## 4. 用户体验与可诊断性

### 4.1 所有诊断消息被统一抹成一句话（影响最大的 UX 问题）

`src/adapters/diagnostics/convert.ts:73` —— `message: safeMessage(snapshot.code)`。
除 7 个 `CFG_*` 码外，**全部**返回 `"Formatter reported a recoverable diagnostic"`。

内核里的这两条：

```
"Statement preserved: hive QUALIFY clause is recognized but not structured"  (span 0-48)
"hive QUALIFY clause is recognized but not structured"                       (span 16-48)
```

到用户编辑器里变成两条**完全相同**的 `Formatter reported a recoverable diagnostic`
波浪线（嵌套 span，看起来像重复告警）。用户只能靠 `code` 猜。

设计动机（消息里可能夹带 SQL 片段，如 `"Unsupported expression atom 中"`）正当，
但处理方式过度。

建议：

- 把 `SAFE_MESSAGE_BY_CODE` 从 7 条扩成**全码表**，每个 code 一句静态、不含任何源码片段的
  人话；并利用已经透传的 `capabilityId` 组装，例如
  `"QUALIFY (capability: qualify) 未建模，该语句已按原文保留"`。
  低风险、高收益、可增量推进，是本报告中最推荐优先做的一条。

  > ⚠️ 消息中**不能出现方言名**。`convertDiagnostic(value, targetId, targetStart, targetLength)`
  > 没有 dialect 形参，adapter 层拿不到方言上下文。要么把 `dialect` 显式传进来
  > （会改动 `convert.ts` 与 `prepare.ts` 两处签名），要么就用不带方言的静态措辞。
  > 后者更简单，且 `capabilityId` 本身已足够定位问题。

- 对嵌套的同 code 同 capability 诊断做 span 包含去重，避免双波浪线。

### 4.2 `unsupportedSyntaxPolicy: "preserve"` 下完全静默

链路：

```
create table ...
  → core status = unchanged，诊断 capabilityId = "hive-ddl"，severity = warning
  → 事务 unchanged（edits.length === 0）
  → reportCommandFailure 只在 rejected 时提示           ← 无弹窗
  → publishDiagnostics 在 preserve 下跳过所有带 capabilityId 的 warning  ← 无波浪线
```

结果：**按下快捷键，什么都没发生，什么提示都没有**。
用户无法区分"扩展坏了"和"这段语法不支持"。

> ⚠️ **这是被测试显式断言的契约，不是覆盖缺口。**
> `tests/v2/wave5-vscode-adapter.test.js:339-354` 设置
> `unsupportedSyntaxPolicy = 'preserve'` 后断言
> `'preserve policy must suppress only editor capability warnings'`，
> 并断言安全报告仍保留 capability 证据。
> 因此本条不能当 bug 直接修——要先决定"`preserve` 是否应当完全无反馈"，
> 改契约、改测试、改实现三件事一起做。

- 建议：把 `preserve` 的语义明确为"不在编辑器里打红/黄"，而非"完全无反馈"；
  在 `unchanged` 且存在 capability 诊断时给一次 status bar 或 information
  message（"未做修改：N 处语法未建模"）。这不违反上述测试断言的字面含义
  （它只约束 editor diagnostics），但仍应同步更新测试以固定新的预期。

### 4.3 诊断状态无文档关闭清理（内存泄漏）

`src/adapters/vscode/extension.ts:269` 的 `latestDiagnosticGeneration: Map<string, number>`
只增不减；`activate` 只注册了 `onDidChangeTextDocument`（`extension.ts:788`），
没有 `onDidCloseTextDocument`。长会话中打开过的每个 SQL 文档 URI 都会永久驻留，
`DiagnosticCollection` 中的条目同样不会清。

- 建议：注册 `workspace.onDidCloseTextDocument` →
  `latestDiagnosticGeneration.delete(key)` + `diagnostics.delete(uri)`。

### 4.4 `publishDiagnostics` 循环内反复 `document.getText()`

`extension.ts:411-416`：每条诊断调用两次 `document.getText().length`。
N 条诊断 = **2N 次全文 `getText()` 调用**。

> VS Code 是否每次都完整物化字符串没有 API 契约保证（可能有内部缓存），
> 因此不能断言"2N 次全文本拷贝"。但无论实现如何，重复调用本身没有必要。

- 建议：循环外 `const length = document.getText().length;` 提一次。
  `documentTarget()`（`extension.ts:90`）同样是为拿长度而 `getText()`。

### 4.5 主机层的几个 O(n) 陷阱

三条均已实测（方法学见 [A.8](#a8-主机层-on-热点)）。

| 位置 | 问题 | 实测 | 建议 |
| --- | --- | --- | --- |
| `extension.ts:242` `positionAtText` | 逐字符从 0 扫到 offset。`extension.ts:540-541` 对**每个 selection 调用两次**（anchor + active），故成本是 O(n · 2m) | 505 KB × 50 选区（100 次调用）= **49.5 ms**；× 10 选区 = 9.9 ms；× 1 选区 = 1.0 ms | 对 `outputSource` 预建一次行首表二分 |
| `experimental-ddl.ts:212` `linePrefixIsWhitespace` | 见下方根因说明 | 505 KB × 20 target = **3.3 ms**（50 KB 时 0.34 ms，随文档线性） | 复用预建行首表 |
| `experimental-ddl.ts` `validateDdlTargets` | 遍历全文 leaves **两次**并分配两个结果数组（元素仍是原 leaf 引用，非深拷贝） | 505 KB / 187999 leaves = **14.2 ms**（252 KB 6.9 ms、50 KB 1.3 ms）。每次命令一次，非每 target | 单次遍历 + 索引游标 |

> **`linePrefixIsWhitespace` 的根因与直觉相反。** 关键在这一行做了**两次**反向查找：
>
> ```ts
> Math.max(source.lastIndexOf("\n", offset - 1), source.lastIndexOf("\r", offset - 1))
> ```
>
> 第一次查 `\n`：目标就在附近（上一行末尾），**一找到就停**，成本与文档大小无关。
> 第二次查 `\r`：在 **LF-only 文件**（macOS / Linux 的常态）中**根本不存在**，
> 于是必须一路反向扫到索引 0 才能确认"没有"——这次才是全文扫描。
>
> 505 KB 实测（方法学见 [A.8](#a8-主机层-on-热点)）：查 `\n` < 0.0001 ms，
> 查 `\r` **0.1651 ms**；换成 CRLF 文件后 `\r` 随处可见，立刻回落到 < 0.0001 ms。
> 即：**成本只在 LF-only 文件上出现，且完全由那次注定失败的 `\r` 查找贡献。**
>
> 顺带澄清：同文件的 `lineSuffixIsWhitespace` 用 `source.slice(offset).search(...)`
> 看着像全量拷贝，但在本次测试（Node v24.18.0 + 本语料 + 该 offset 位置）中
> 实测 **0.002–0.004 ms 且未观察到随文档增长**，
> **因此没有证据支持优先优化它**——但这不等于它在其他 V8 版本或输入形态下恒定如此。
> 字符串切片是否复制底层数据**不是 JS/Node 的契约**，是 V8 的实现细节（sliced string），
> 可能随版本、字符串长度阈值或扁平化时机而变。

### 4.6 `ddlCommit` 与 `queryCommit` 不对称

`extension.ts:583` 的 `ddlCommit.apply` 忽略 `expected` 参数、不做 edit 范围预演校验
（`queryCommit` 有 `applyTransactionEdits`）、不恢复选区。
DDL 批量替换后的光标行为与查询格式化不一致。

- 建议：抽出共享的 commit 构造函数，两条路径共用同一套校验与选区恢复。

### 4.7 未建模构造导致同一语句内混合大小写（预期行为，属文档缺口）

```sql
-- 输入: group by a,b grouping sets ((a),(b),())
GROUP BY
      a
    , b grouping sets ((a),(b),())   -- GROUP BY 大写，grouping sets 小写
```

`TRANSFORM ... USING ... AS`、多语句脚本中的 `insert into` / `set` 同理。

**这不是缺陷。** `sql-formatter-architecture.md` 已明确规定
opaque/verbatim 结构保留精确 source slice，混合大小写是保真优先的必然结果，
且是正确的取舍——猜测性改写 verbatim 区间会破坏本项目最核心的安全保证。

问题只在于**用户不知道**，容易反复上报为 bug。

- 建议：在 README 风险提示中补一句"未建模语法按原文保留，因此同一文件内可能出现
  与 `keywordCase` 不一致的大小写"；架构文档中把这条后果显式写出，
  避免后续维护者误当缺陷去"修"。

---

## 5. 可维护性与结构

### 5.1 `statistics()` 的 16 个位置参数是长期迭代的地雷

`src/core/api/format.ts:157` 定义 **16 个**带默认值的位置参数，**16 个调用点**，
调用形如：

```ts
statistics(source.length, source.length, leafCount, syntaxNodeCount,
    planned.plan.statistics.actionCount, planned.plan.budget.maxPlanActions,
    leafVisitCount, compiled.statistics.leafEmissionCount, directLookupCount,
    0, planned.plan.statistics.scopeActionCount, 0,
    ...)
```

`0` 占位、参数顺序全靠人眼对齐。

而且第二遍对齐的失败路径（`format.ts:558` / `:574` / `:590`）退化成
`statistics(source.length)`，**丢掉了已经算出来的 leafCount / syntaxNodeCount**，
与其他失败路径不一致——这已经是一处实际的行为不一致。

- 建议：改成单个 `FormatPipelineStatistics` 对象累加器，全流程增量填充，
  失败路径直接快照当前累加器。可同时消掉那三处退化。

### 5.2 `FMT_INTERNAL` 全链路丢失排障信息

`format.ts:681` 把整条 pipeline 包在裸 `catch {}` 里，返回 `FMT_INTERNAL`。
fail-closed 是对的，但异常信息在**三个环节**被逐层丢弃：

| 环节 | 行为 |
| --- | --- |
| `format.ts:681` | `catch {}` 不接收 error，message 硬编码为 `"Formatter internal boundary failed"` |
| `convert.ts:73` | 即便 core 保留了消息，adapter 也会用 `safeMessage(code)` 覆盖掉 |
| `extension.ts:376` | `debugSummary` 只输出 `{phase, languageId, documentVersion, status, diagnosticCodes}`，不含任何 message |

同一代码库内另有两套不同做法：

- `analyze.ts:23` `internalMessage(error)` —— 保留 `error.message` 并截断到 512 字符，**不含 stack**
- `parser.ts:341` —— 直接使用**完整未截断**的 `error.message`

**两条可行路线，各有代价**：

| 路线 | 要点 | 代价 |
| --- | --- | --- |
| A. 独立 debug 通道 | core 侧 callback / logger，不经过 `FormatResult` 与 `TransactionDiagnostic` | **无法直接跨 `worker_threads`**。direct 路径可用；worker 路径必须扩展 `protocol.ts` 的请求/响应消息，或另建一条事件通道回传，否则 worker 内的异常仍然拿不到 |
| B. 正式扩展结果协议 | 在 `FormatResult` 增加一个受控 debug 字段 | 需同步改 `RESULT_KEYS` / `snapshotFormatResult` / `isFormatResultSafeForSource`，以及 worker 协议的对应校验。改动面大但天然跨线程 |

> ⚠️ rev.3 曾称"只有 callback/logger 可行"，这是错的——B 同样可行，只是成本更高。
> 但**附加一个未登记的字段绝对不可行**：`data-snapshot.ts:25` 对任何不在白名单内的键
> 直接 `return null`，整个结果会被边界丢弃。

> ⚠️ **`error.stack` 不是脱敏的。** 它的首行通常就是 `Error: <message>`，
> 而 message 可能包含源码片段（如 `"Unsupported expression atom 中"`）。
> 因此不能"原样打印 stack 且声称脱敏契约不变"。可选做法：
> 只输出 stack 的**调用帧部分**（丢弃首行）、或对首行套用与
> `safeMessage` 同级的脱敏、或把完整 stack 限定在
> `debugDiagnostics=true` 且明确告知用户该输出可能含 SQL 片段的前提下。

- 附带修改：若决定保留 stack，`analyze.ts:23` 的 `internalMessage` 也需扩展
  ——它目前只取 `error.message`，不含 stack。

### 5.3 invariants：没有明显可安全删除的校验，优化必须保持全量证明语义

`src/core/syntax/parser.ts:303` 每次解析都跑 `validateSyntaxInvariants`。实测占比：

| 源码大小 | 占 parse 阶段 | 占端到端 |
| --- | --- | --- |
| 6 KB | 27.5% | 7.0% |
| 31 KB | 37.1% | 6.2% |
| 96 KB | 40.3% | 5.7% |

**provenance 短路已经实现，不存在"没用上"的优化空间**：

- `cst-invariants.ts:1320` —— `trustedRootShape = hasCanonicalProgramProof && canonicalValidation.ownsNode(root)`
- `cst-invariants.ts:565` —— `validateNodeShape()` 的 `if (trustedCanonicalShape)` 快路径
- `cst-invariants.ts:505` —— `snapshotChildren()` 对可信节点直接返回 `children`，跳过逐属性 descriptor 检查

`deriveExpectedTable(leaves)`（`cst-invariants.ts:1359`）虽然是独立重算，
但实测仅 **1.78 ms / 33.13 ms = 5%**，不是成本主体。

成本主体是树遍历中的 `validateContextualNodeFacts` 与 `validateContainerRelationships`
关系校验——那是不变量的语义本体。

**准确表述**：没有明显可以安全删除的校验；任何优化都必须保持"每次解析全量证明"的语义。
这不等于成本不可降——以下方向仍然开放，但都需要原型验证：

- 融合遍历：目前多个 invariant 家族各自走树，合并为单趟遍历可省重复访存
- 生成式 validator：从节点形状声明生成校验代码，替代手写分支
- 数据布局优化：把节点事实改为并行 TypedArray，减少对象跳转

而"按 statement 抽查"会把"每次解析都证明"降级为"抽样证明"，
直接削弱 fail-closed 保证，属于**安全模型变更**，不能作为普通性能优化推进，
需要单独 ADR 论证威胁模型。

另一个独立问题是**可维护性**：

```
cst-invariants.ts                      1846
cst-marker-closure-invariants.ts       1792
token-table-invariants.ts              1479
cst-container-invariants.ts             943
cst-contextual-fact-invariants.ts       745
invariant-shared.ts                     660
cst-capability-allowlist-invariants.ts  376
cst-contextual-invariant-support.ts     285
────────────────────────────────────────────
                                    ≈ 8100 行，占 src/ 约 20%
```

每增加一种 CST 节点形状，需要同步改动其中 **5–6 个文件**（实测：抽样
`"window-spec"` / `"cte"` / `"list-item"` / `"type-expression"` 四种 kind
各出现在 6 个 invariant 文件中，`"case-branch"` 出现在 5 个）。

- 建议：不动运行时行为，先做结构治理——为"新增节点类型"编写 checklist，
  或把跨文件的节点形状契约收敛到单一 registry（类似 `dialects/registry.ts` 对
  operator/capability 的做法），让新增形状只需改一处声明。
  这也是上面"生成式 validator"的前置条件。

### 5.4 boundary snapshot 的第二次执行可以短路

| 路径 | 第一次 | 第二次 |
| --- | --- | --- |
| direct | `direct.ts:64` | `prepare.ts:487` |
| worker | `persistent-worker.ts:423` | `prepare.ts:487` |

`snapshotFormatResult` 会**深拷贝整个 source map**：50 KB 文档 = 8100 条 entry，
每条新建 3 个 frozen 对象。实测单次 **7.74 ms**，两次约 15 ms（占端到端约 3%），
外加约 5 万个短命对象。

> ⚠️ **第一次 snapshot 不能省。** worker 经 structured clone 回传的对象仍属不可信输入
> （跨线程边界、协议可能被篡改），`persistent-worker.ts:423` 的校验是必要的；
> direct 路径同理，`direct.ts:64` 是 core → adapter 的边界。

可短路的只有**第二次**：第一次产生的是 adapter 自己构造的 frozen 对象，
到达 `prepare.ts` 时其可信性已被证明。

- 建议：用与 `CANONICAL_OPTIONS` / `CANONICAL_PARSE_ARTIFACTS` 相同的 `WeakSet`
  provenance 手法给**第一次 snapshot 的产物**打 brand，`prepare.ts` 见到 brand 直接复用。
  项目里已有这个模式，只是没用在这条边界上。

### 5.5 `adapter-contract.ts` 与 `extension.ts` 的重复实现

`src/adapters/vscode/adapter-contract.ts` 导出 `createDocumentTarget` /
`createFragmentTargets` / `optionsForLanguage` / `FORMATTER_SELECTOR`，
但**只被 `tests/v2/wave4b-language-registry.test.js` 引用**；
`extension.ts` 自己实现了功能重叠的 `documentTarget()`（`:88`）与
`selectionTargets()`（`:107`）。

这是典型的"测试测的是 A，生产跑的是 B"。

- 建议：让 `extension.ts` 真正消费 `adapter-contract.ts`；否则删除该文件并把测试指向真实路径。

### 5.6 `supported-languages.ts` 的 `dialect` 字段在生产路径未被读取

`SupportedLanguage.dialect` 恒为 `"hive"`。它**并非完全无人读取**——
`adapter-contract.ts:88` 会在选项未显式指定 dialect 时用它作为缺省值：

```ts
dialect: hasDialect ? snapshot.dialect : supported.dialect,
```

但如 [5.5](#55-adapter-contractts-与-extensionts-的重复实现) 所述，
`adapter-contract.ts` 只被测试使用，**生产路径（`extension.ts` → `config.ts`）从未读取它**，
实际 dialect 完全来自 `sqlBeautify.dialect`。

因此这不是"死字段"，而是"**一个已实现但未接线的语言→dialect 缺省映射**"。
配置权威分散在两处，其中一处只有测试能看到。

- 建议：与 5.5 一并处理。要么把 `optionsForLanguage` 接入生产路径
  （`hive-sql` 强制 hive、`sql` 跟随配置，这本身是个合理特性），
  要么连同 `adapter-contract.ts` 一起删除。不要维持"只有测试走的第二套权威"。

### 5.7 `LexicalProfile` 抽象不完整：标识符字符类没有 dialect 化

`src/core/lexer/lexical-profile.ts` 把 `doubleQuote` 语义、`dollarStrings` 做成了
per-dialect，但 `isIdentifierStart` / `isIdentifierContinue`
（`src/core/lexer/character-class.ts:41-47`）是全局硬编码 ASCII-only。

实测后果：

```
select 中文字段 as c1, b as c2 from t
→ 中 / 文 / 字 / 段 各自成为一个 unknown leaf
→ 该 select item 被判定 hasVerbatim → 整组 AS 对齐被禁用
```

| 输入 | AS 对齐 |
| --- | --- |
| `select abcdefgh as c1, b as c2` | ✅ |
| `select 中文字段 as c1, b as c2` | ❌ 完全不对齐 |
| ``select `中文字段` as c1, b as c2`` | ✅ |

Hive 官方语法确实要求反引号包裹非 ASCII 标识符，所以严格说不算 bug；
但对本扩展的核心用户群（Hive + 中文列名/注释）是高频体感问题，
而且 `postgresql` / `mysql` 两个 best-effort dialect **本身允许**不加引号的 Unicode 标识符。

建议与前置约束：

1. 把 identifier 字符类下沉进 `LexicalProfile`，`hive` 保持 ASCII-only。

   > ⚠️ **不要直接套用 ECMAScript 的 `ID_Start` / `ID_Continue`。**
   > PostgreSQL 与 MySQL 各有自己的标识符 lexical contract
   > （PostgreSQL 依赖服务端编码与 `downcase` 规则，MySQL 有自己的允许字符集与长度限制），
   > 必须按各 dialect 的真实规范实现，否则会引入新的方言不一致。

2. `src/core/lexer/lossless-lexer.ts:738` 对 unknown 字符**逐码点发射 leaf**，
   一段中文列名会造成叶子数爆炸，应合并连续 unknown 为单个 leaf。

   > ⚠️ 合并 unknown leaf 会**降低** CJK 密集文档的 leafCount，
   > 使其更晚触发 `leafCount: 12_000` 路由阈值、更久停留在 direct 路径。
   > 该改动必须与 [3.4](#34-direct-路由的主线程阻塞尾延迟已观测至-552-ms上限未确定)
   > 的路由阈值重新校准一起做。

### 5.8 公共回归语料规模过小

`tests/fixtures/production-corpus/public/` 有 **5 个 SQL 文件**
（`hive-cte-window-comments.sql`、`hive-template-variables.sql`、`postgres-json-dollar.sql`、
`unsupported-match-recognize.sql`、`unsupported-pivot-qualify-safety.sql`），
**最大 516 字节**；`tests/v2/wave5-production-corpus.test.js:7` 断言 `>= 5`。
真正的生产语料在 `wave5-production-private.test.js` 引用的仓库外私有集。

数量不是问题，**规模和形态多样性是**：外部贡献者无法复现"生产形态"的回归证据，
而恰恰是 CRLF、BOM、`trailing` 逗号、CJK 这类问题需要它。

- 建议：构造一批合成但生产形态的公开 fixture（几 KB 到几十 KB，覆盖
  CTE + 窗口 + CASE + 中文注释 + 行尾注释 + CRLF / BOM 变体），并把断言从
  `>= 5` 改为按用例清单逐项断言。

---

## 6. 能力覆盖度

### 6.1 未建模构造（实测，走原文保留）

| 构造 | 结果 |
| --- | --- |
| `INSERT INTO t SELECT ...` | `SYN_UNSUPPORTED_STATEMENT` |
| `INSERT INTO TABLE t SELECT ...` | `SYN_UNSUPPORTED_STATEMENT` |
| `SET hive.exec.dynamic.partition=true;` | `SYN_UNSUPPORTED_STATEMENT` |
| `EXPLAIN SELECT ...` | `SYN_UNSUPPORTED_STATEMENT` |
| `GROUP BY ... GROUPING SETS (...)` | `SYN_UNEXPECTED_TOKEN` |
| `SELECT TRANSFORM(...) USING ...` | `SYN_INCOMPLETE_CLAUSE` |
| `CREATE TABLE ...`（主 `formatSql` 命令） | `SYN_UNSUPPORTED_STATEMENT` |
| `UPDATE` / `DELETE` | `SYN_UNSUPPORTED_STATEMENT` |

### 6.2 已建模且表现良好（实测通过）

`INSERT OVERWRITE TABLE ... PARTITION`、CTE / `WITH`、`LATERAL VIEW explode`、
`${var}` 模板变量、`UNION ALL`、FROM 子查询、`IN (subquery)`、窗口函数、
`DISTRIBUTE BY` / `SORT BY` / `CLUSTER BY`、`/*+ HINT */`、`LIMIT`。

### 6.3 优先级建议

`INSERT INTO` 与 `SET` 看起来是投入产出比最高的两个缺口：
它们让"多语句脚本格式化"退化成花斑输出
（见 [4.7](#47-未建模构造导致同一语句内混合大小写预期行为属文档缺口)）。

> ⚠️ 两点未经证实，不应直接作为排期依据：
>
> - "几乎每个生产 Hive 脚本都以 `SET` 开头、主体大量使用 `INSERT INTO`" ——
>   这是基于通用 Hive 实践的印象，**未用本项目的私有语料统计**。
>   排期前应先统计私有 corpus 中 `SET` / `INSERT INTO` 的出现文件数与占比。
> - "`INSERT INTO ... SELECT` 与 `INSERT OVERWRITE ... SELECT` 结构同构，扩展成本很低" ——
>   仅从语法形态推断，**未做实现评估**。应先看
>   `src/core/syntax/statement-parser.ts` 与 `relation-parser.ts` 中
>   `insert-overwrite-partition-select` 的实际建模方式，确认 `INTO` 分支能否复用
>   同一 clause 结构与 layout policy。

准确表述：**语法形态相近，值得优先做设计评估**；扩展成本待评估后确定。

另外 `Format SQL` 完全不处理 DDL，需要另一个命令 + 另一个快捷键（`Alt+Shift+L`）。
用户在 DDL 文件上按 `Alt+Shift+F` 得到静默无反应
（叠加 [4.1](#41-所有诊断消息被统一抹成一句话影响最大的-ux-问题) /
[4.2](#42-unsupportedsyntaxpolicy-preserve-下完全静默)）。

- 建议：检测到目标为 `hive-ddl` capability 且结果 unchanged 时，
  提示"该语句为 DDL，请使用 `SQL Beautify: Format Hive DDL`"。

---

## 7. 建议落地顺序

排序依据：**影响面 × 实施风险**，与 [§2](#2-已确认的功能缺陷) 的影响面标注一致。
rev.2 曾把 CRLF 标为最高级却排在第二批，此处已修正。

### 第一批：低风险，影响面明确

| # | 事项 | 章节 |
| --- | --- | --- |
| 1 | **CRLF EOL 感知贯穿 renderer**（影响面最大） | [2.2](#22-crlf-输入--输出混合行尾) |
| 2 | `SAFE_MESSAGE_BY_CODE` 扩成全码表 + 嵌套诊断去重 | [4.1](#41-所有诊断消息被统一抹成一句话影响最大的-ux-问题) |
| 3 | BOM 作为 boundary trivia | [2.3](#23-utf-8-bom--静默完全不格式化) |
| 4 | `onDidCloseTextDocument` 清理 + `publishDiagnostics` 提取 `getText()` | [4.3](#43-诊断状态无文档关闭清理内存泄漏) / [4.4](#44-publishdiagnostics-循环内反复-documentgettext) |
| 5 | `workerPath` 存在性检查改 `accessSync`（**不动 runtime digest**） | [3.5](#35-worker-生命周期) |

### 第二批：需要契约变更或先补测量

| # | 事项 | 前置条件 | 章节 |
| --- | --- | --- | --- |
| 6 | 显式输入上限 | 临时阈值候选 1 MB（**仅为风险削减，未证明满足 UX/SLO**）；定值前需先定义延迟与内存目标并补多机器测量 | [3.2](#32-时间与内存均构成约束安全上限尚未确定) |
| 7 | `statistics()` 改对象累加器 | — | [5.1](#51-statistics-的-16-个位置参数是长期迭代的地雷) |
| 8 | 打通 debug 排障通道 | 先在"独立通道"与"正式扩展结果协议"间选路线；两者都要覆盖 direct + worker 两条路径，并解决 `error.stack` 的脱敏问题 | [5.2](#52-fmt_internal-全链路丢失排障信息) |
| 9 | direct/worker 双阈值重新校准 | 需多形态语料（注释密集 / 宽字符 / 深嵌套）验证组合上界 | [3.4](#34-direct-路由的主线程阻塞尾延迟已观测至-552-ms上限未确定) |
| 10 | `INSERT INTO ... SELECT` / `SET` 建模 | **先做私有语料统计 + 实现评估** | [6.3](#63-优先级建议) |
| 11 | `commaStyle=trailing` + 行尾注释：**路线决策**，并实施路线 A（该边界局部降级为 leading comma） | 属策略降级，非架构变更，不需要 ADR；须固定"降级为 leading comma"的回归预期，而不是期望 `x, -- c1` | [2.1](#21-commastyle-trailing--行尾注释--逗号单独成行且对齐全失) |

### 第三批：架构级，需要 ADR

| # | 事项 | 章节 |
| --- | --- | --- |
| 12 | **路线 B**：重构 source-map 支持 source run 重排（output 单调、source 非单调），并重新证明 selection mapping、token equivalence、`isValidSourceMap` 契约。仅在路线 A 的输出不可接受时才考虑 | [2.1](#21-commastyle-trailing--行尾注释--逗号单独成行且对齐全失) |
| 13 | range 校验下沉 worker（**不是**缓存复用，两个 artifact 的 mode 不同） | [3.1](#31-format-selection-的前置-range-校验在主线程做全文档分析) |
| 14 | 第二次 boundary snapshot 用 brand 短路（**第一次必须保留**） | [5.4](#54-boundary-snapshot-的第二次执行可以短路) |
| 15 | alignment 昂贵投影收窄到候选集（需原型验证收益） | [3.3](#33-对齐第二遍廉价前置检查已存在但存在-false-positive) |
| 16 | identifier 字符类进 `LexicalProfile`（按各 dialect 真实契约）+ unknown leaf 合并（须与 #9 双阈值校准同步） | [5.7](#57-lexicalprofile-抽象不完整标识符字符类没有-dialect-化) |
| 17 | source-map entry 规模治理（**前置：先做内存归因 profiling**；160 entry/KB 只来自重复拼接语料，且未证明它比 analysis index 更值得动） | [3.2](#32-时间与内存均构成约束安全上限尚未确定) |
| 18 | invariants 节点形状契约收敛为单一 registry（不动运行时语义） | [5.3](#53-invariants没有明显可安全删除的校验优化必须保持全量证明语义) |
| 19 | `adapter-contract.ts` 接入生产路径或删除（含 5.6 的 dialect 缺省映射） | [5.5](#55-adapter-contractts-与-extensionts-的重复实现) / [5.6](#56-supported-languagests-的-dialect-字段在生产路径未被读取) |

### 文档层

| # | 事项 | 章节 |
| --- | --- | --- |
| 20 | README + 架构文档写明 verbatim 区间不参与 `keywordCase` | [4.7](#47-未建模构造导致同一语句内混合大小写预期行为属文档缺口) |
| 21 | 公共生产形态语料补齐 + 逐项断言 | [5.8](#58-公共回归语料规模过小) |

---

## 附录 A 实测数据汇总

环境：Node v24.18.0 / darwin arm64 / Apple M1 Pro（10 核）/ 32 GB，
V8 `heap_size_limit` 4288 MB，提交 `bc08772`。

### A.1 端到端吞吐（核心直调，同一进程连续测量）

语料：`hive-cte-window-comments.sql` 重复 N 次。

| N | 源码 | 中位耗时 | ms/KB |
| --- | --- | --- | --- |
| 1 | 516 B | 8.6 ms | 17.00 |
| 10 | 5.0 KB | 53.9 ms | 10.68 |
| 50 | 25 KB | 235.9 ms | 9.34 |
| 100 | 50 KB | 463.6 ms | 9.18 |
| 200 | 101 KB | 938.3 ms | 9.29 |

> 本表**仅耗时可用**。同批次采集的内存数据因进程状态污染已作废，见 A.3。

### A.2 阶段拆解（96 KB 合成语料，alignment targets = 0）

| 阶段 | 中位耗时 |
| --- | --- |
| `lexSql` | 9.90 ms |
| `buildStructuralTokenTable` | 1.81 ms |
| `parseSqlArtifact`（含 invariants） | 81.06 ms |
| └ `validateSyntaxInvariants` 单独 | 32.67 ms |
| &nbsp;&nbsp;&nbsp;&nbsp;└ `deriveExpectedTable` 单独 | 1.78 ms（占 invariants 5%） |
| `analyzeSql`（parse + index） | 132.97 ms |
| `buildLayoutPlan` | 28.20 ms |
| `compileLayoutPlan` | 63.58 ms |
| `renderLayoutArtifact` | 201.03 ms |
| `deriveLayoutAlignmentPlan` | 108.60 ms |
| `lexSql`（equivalence 复核） | 9.73 ms |
| **`formatSqlWithStatistics` 全量** | **569.21 ms** |

### A.3 内存：核心直调，1010 KB，每次独立进程（3 次）

| 指标 | 值 |
| --- | --- |
| 耗时 | 10.99 / 11.12 / 11.16 s |
| 返回时堆增量 | 1116 / 1122 / 1122 MB |
| 返回时 RSS | 1336 / 1344 / 1337 MB |
| 保留结果 + 强制 GC 后堆增量 | 131 MB（三次一致） |
| 丢弃结果 + 强制 GC 后堆增量 | 99 MB（三次一致） |
| source map entries | 162,000 |

"返回时堆增量"与"GC 后堆增量"相差约 8.5 倍，该指标不可用于推断增长阶数。

### A.4 生产 worker 路径（`dist/` artifacts，每次独立进程）

链路：`createProductionFormatterExecutor` → `RoutedFormatterExecutor` →
`PersistentWorkerExecutor` → worker thread → structured clone → 主进程两次 snapshot。

| 源码 | 路由 | 状态 | 耗时 | 返回时堆 | 返回时 RSS | maxRSS | source map entries |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 513 KB | worker | ready | 6.05 s | 79 MB | 759 MB | 759 MB | 82,296 |
| 1026 KB | worker | ready | 12.51 s | 151 MB | 1341 MB | 1477 MB | 164,592 |
| 2052 KB | worker | ready | 24.52 s | 296 MB | 2964 MB | 2964 MB | 329,184 |
| 4104 KB | worker | ready | 49.99 s | 668 MB | 4352 MB | 4352 MB | 658,368 |

4104 KB 完成后距 `requestTimeoutMs: 60_000` 仅剩 10.01 s（预算的 16.7%）。

**运行间波动明显。** 用 [B.3](#b3-生产-worker-路径a4) 的脚本重跑同样两档：

| 源码 | 首轮 maxRSS | 复跑 maxRSS | 首轮耗时 | 复跑耗时 |
| --- | --- | --- | --- | --- |
| 513 KB | 759 MB | **928 MB** | 6.05 s | 6.11 s |
| 1026 KB | 1477 MB | **1724 MB** | 12.51 s | 11.82 s |

耗时接近（差 ±5%），但两次运行的 maxRSS 相差 **17–22%**。
每档各只有两次观测，不足以估计方差，只能说明**单次 maxRSS 不可作为趋势依据**
——这正是 [3.2](#32-时间与内存均构成约束安全上限尚未确定) 不给出增长阶数的原因。

### A.5 direct 路由主线程阻塞（多形态）

| 形态 | 源码 | leaves | 路由 | 中位 | 最高 |
| --- | --- | --- | --- | --- | --- |
| `hive-cte-window-comments.sql` × 62 | 31.3 KB | 11655 | direct | — | — |
| `hive-cte-window-comments.sql` × 63 | 31.8 KB | 11843 | direct | 341 ms | — |
| `hive-cte-window-comments.sql` × 64 | 32.3 KB | 12031 | **worker** | — | — |
| 注释密集（940 项 / pad 45） | 63.95 KB | 9404 | direct | 385 ms | 410 ms |
| 注释密集（1195 项 / pad 29） | 63.28 KB | 11954 | direct | 400 ms | 457 ms |
| 注释密集（1125 项 / pad 30） | 60.5 KB | 11254 | direct | 369 ms | **508 ms** |
| 注释密集（1075 项 / pad 35） | 62.9 KB | 10754 | direct | 386 ms | **528 ms** |
| 叶子稀疏（大段注释） | 62.8 KB | 342 | direct | 242 ms | — |

6 组注释密集配置各采样 9 次：中位集中在 360–400 ms，最高值在 435–528 ms 间跳动。
独立复测的 63.44 KB / 11999 leaves 样本（中位 421 ms / 最高 552 ms）与本表同量级。

叶子密度：`hive-cte-window-comments.sql` 371 leaves/KB，
`hive-template-variables.sql` 302 leaves/KB。

### A.6 range 校验（主线程）

| 文档 | 选区 | `validateFormatTargetRanges` |
| --- | --- | --- |
| 50 KB | 516 B | 158 ms |
| 151 KB | 516 B | 292 ms |
| 303 KB | 516 B | 445 ms |

### A.7 boundary snapshot（50 KB 文档，8100 条 source map entry）

| 函数 | 单次耗时 |
| --- | --- |
| `snapshotFormatResult` | 7.74 ms |
| `isFormatResultSafeForSource` | 0.78 ms |

### A.8 主机层 O(n) 热点

对应 [4.5](#45-主机层的几个-on-陷阱)。

**方法学**：`hive-cte-window-comments.sql` 重复拼接构造语料；每项预热 3 轮后测 9 轮取
**中位数**；`lastIndexOf` 属微基准，每轮内再循环 200 次取均值以脱离计时器分辨率。
所有数字为单机（M1 Pro / Node v24.18.0）单次会话，未做跨机器验证。

`positionAtText` —— **每选区 2 次调用**（`extension.ts:540-541` 的 anchor + active）：

| 文档 | 1 选区 / 2 调用 | 10 选区 / 20 调用 | 50 选区 / 100 调用 |
| --- | --- | --- | --- |
| 50 KB | 0.2 ms | 1.1 ms | 4.9 ms |
| 252 KB | 0.5 ms | 4.9 ms | 25.0 ms |
| 505 KB | 1.0 ms | 9.9 ms | **49.5 ms** |

`linePrefixIsWhitespace` / `lineSuffixIsWhitespace`（各 20 target）：

| 文档 | `linePrefixIsWhitespace` | `lineSuffixIsWhitespace` |
| --- | --- | --- |
| 50 KB | 0.344 ms | 0.004 ms |
| 252 KB | 1.648 ms | 0.003 ms |
| 505 KB | **3.305 ms** | 0.002 ms |

单次 `lastIndexOf` 成本（505 KB 语料，offset 居中，200 次/轮）：

| 调用 | 耗时 |
| --- | --- |
| `lastIndexOf("\n", off-1)`，LF-only 文件（目标存在） | < 0.0001 ms |
| `lastIndexOf("\r", off-1)`，LF-only 文件（目标不存在 → 全文反扫） | **0.1651 ms** |
| `lastIndexOf("\r", off-1)`，CRLF 文件（目标存在） | < 0.0001 ms |

`validateDdlTargets` 的两次全量 `filter`：

| 文档 | leaves | 两次 filter |
| --- | --- | --- |
| 50 KB | 18,799 | 1.26 ms |
| 252 KB | 93,999 | 6.86 ms |
| 505 KB | 187,999 | **14.19 ms** |

### A.9 alignment 候选规模（300 语句合成样本）

| 指标 | 值 |
| --- | --- |
| leaves | 13,499 |
| nodes | 5,701 |
| lists | 300 |
| list items | 600 |
| 带 `AS` 的 item（候选 leaf） | 600 |
| trailing comment binding（候选 leaf） | 300 |
| **候选 leaf 上界 / leaves** | **900 / 13499 = 6.7%** |

---

## 附录 B 复现方式与测量方法的局限

核心直调测量在 `npm run build:v2-core` 产出的 `.tmp/v2-core/` 上进行；
worker 路径测量需要 `npm run build:v2-runtime` 产出的 `dist/`。

```bash
npm run build:v2-core
npm run build:v2-runtime
```

### B.1 行为类缺陷

```bash
# CRLF
node -e "var f=require('./.tmp/v2-core/core/api/format.js');
var s='select a,b,c\r\nfrom t\r\nwhere x=1\r\n';
console.log(JSON.stringify(f.formatSql(s,{dialect:'hive'}).text));"

# BOM
node -e "var f=require('./.tmp/v2-core/core/api/format.js');
console.log(f.formatSql('﻿select a,b from t',{dialect:'hive'}).status);"

# commaStyle=trailing + 行尾注释
node -e "var f=require('./.tmp/v2-core/core/api/format.js');
var s='select aaaaaaaaaa as x -- c1\n, b as y -- c2\n, cc as z -- c3\nfrom t';
['leading','trailing'].forEach(function(c){
  console.log('=== '+c);
  console.log(f.formatSql(s,{dialect:'hive',commaStyle:c}).text);});"

# CJK 标识符 → 对齐失效
node -e "var f=require('./.tmp/v2-core/core/api/format.js');
console.log(f.formatSql('select 中文字段 as c1\n, b as c2\nfrom t',{dialect:'hive'}).text);
console.log(f.formatSql('select abcdefgh as c1\n, b as c2\nfrom t',{dialect:'hive'}).text);"
```

### B.2 内存（必须每次独立进程）

```bash
# A.3：核心直调 1 MB。重复三次，每次一个全新进程。
for i in 1 2 3; do node --expose-gc -e "
var fs=require('fs');var fmt=require('./.tmp/v2-core/core/api/format.js');
var b=fs.readFileSync('tests/fixtures/production-corpus/public/hive-cte-window-comments.sql','utf8');
var s=new Array(2000).fill(b).join('\n');
global.gc();global.gc();
var before=process.memoryUsage().heapUsed;
var t=Date.now();
var r=fmt.formatSqlWithStatistics(s,{dialect:'hive'});
var ms=Date.now()-t;var m=process.memoryUsage();
global.gc();global.gc();
var kept=process.memoryUsage().heapUsed-before;
var entries=r.result.sourceMap?r.result.sourceMap.entries.length:0;
r=null;global.gc();global.gc();
var dropped=process.memoryUsage().heapUsed-before;
console.log('ms='+ms,
 'atReturnHeapMB='+((m.heapUsed-before)/1048576).toFixed(0),
 'atReturnRssMB='+(m.rss/1048576).toFixed(0),
 'keptGCHeapMB='+(kept/1048576).toFixed(0),
 'droppedGCHeapMB='+(dropped/1048576).toFixed(0),
 'sourceMapEntries='+entries);"; done
```

### B.3 生产 worker 路径（A.4）

把下面的脚本存为仓库根目录下的 `.tmp/worker-bench.js`（`.tmp/**` 已被 git 忽略），
先 `npm run build:v2-runtime`，再**每个体积各跑一个独立进程**：

```bash
npm run build:v2-runtime
for kb in 512 1024 2048 4096; do node .tmp/worker-bench.js $kb; done
```

```js
'use strict';
// 走完整生产链路：RoutedFormatterExecutor -> PersistentWorkerExecutor
// -> worker thread -> structured clone 回传 -> 主进程 snapshot。
// 用法：node .tmp/worker-bench.js <targetKb>
var fs = require('fs');
var path = require('path');

var REPO = path.resolve(__dirname, '..');
var runtimePath = path.join(REPO, 'dist/runtime.cjs');
var workerPath = path.join(REPO, 'dist/formatter-worker.cjs');
var corpusPath = path.join(
    REPO,
    'tests/fixtures/production-corpus/public/hive-cte-window-comments.sql'
);

var targetKb = Number(process.argv[2] || 1024);
var base = fs.readFileSync(corpusPath, 'utf8');
var repeats = Math.max(1, Math.round((targetKb * 1024) / base.length));
var source = new Array(repeats).fill(base).join('\n');

var runtime = require(runtimePath);
var executor = runtime.createProductionFormatterExecutor({
    runtimePath: runtimePath,
    workerPath: workerPath,
});

var startedAt = Date.now();
runtime.prepareFormatTransaction({
    source: source,
    documentVersion: 1,
    targets: [Object.freeze({
        id: 'document', start: 0, end: source.length, mode: 'document',
    })],
    options: { dialect: 'hive' },
}, executor).then(function (result) {
    var elapsedMs = Date.now() - startedAt;
    var usage = process.memoryUsage();
    var edit = result.edits && result.edits.length > 0 ? result.edits[0] : null;
    console.log(JSON.stringify({
        sourceKb: Math.round(source.length / 1024),
        route: executor.lastRoute(),
        status: result.status,
        elapsedMs: elapsedMs,
        atReturnHeapMb: Math.round(usage.heapUsed / 1048576),
        atReturnRssMb: Math.round(usage.rss / 1048576),
        // process.resourceUsage().maxRSS 的单位是 KB。
        maxRssMb: Math.round(process.resourceUsage().maxRSS / 1024),
        edits: result.edits ? result.edits.length : 0,
        sourceMapEntries: edit && edit.sourceMap ? edit.sourceMap.entries.length : 0,
        diagnostics: result.diagnostics.length,
    }));
    return executor.dispose();
}).then(function () {
    process.exit(0);
}).catch(function (error) {
    console.log(JSON.stringify({
        sourceKb: Math.round(source.length / 1024),
        elapsedMs: Date.now() - startedAt,
        maxRssMb: Math.round(process.resourceUsage().maxRSS / 1024),
        failed: String(error && error.message ? error.message : error),
    }));
    process.exit(1);
});
```

### B.4 测量方法的已知局限

| 局限 | 说明 |
| --- | --- |
| **内存必须独立进程** | rev.1/rev.2 在同一进程连续测多个体积，堆已扩张且 GC 已运行，1 MB 的返回时堆被低估为 488 MB（实际 1116–1122 MB）。所有内存数据必须每个体积一个全新进程 |
| **返回时堆 ≠ 执行峰值** | `formatSqlWithStatistics` 全同步，执行期间事件循环不运行，`setInterval` 采样值恒等于返回值（已实测）。真实峰值需 `--trace-gc` 或 `v8.setHeapSnapshotNearHeapLimit`。附录中的"返回时堆"仅是峰值下界，且受 GC 时机影响巨大 |
| **单一语料形态会低估上界** | rev.2 只用 `hive-cte-window-comments.sql` 重复测 direct 路由，得出 341 ms 并误称"上限"；换成注释密集形态即达 457 ms。所有阈值/上界结论都必须多形态验证 |
| **单机少次** | 所有数据来自一台 M1 Pro，每档 1–3 次观测。按 A.4 的 49.99 s，比本机慢 20% 以上的机器会让 4 MB 用例超时；慢多少才触发未在其他硬件验证 |
| **不经过 VS Code** | 主线程阻塞是按内部模块耗时推断的，未在真实 extension host 中测量 UI 冻结时长 |
| **合成语料** | 重复拼接的语料可能让 V8 的 IC / hidden class 比真实异构 SQL 更友好，实际生产可能更慢 |

---

## 附录 C 已撤销的结论

本节只保留**会改变决策的**旧结论，覆盖 rev.1–rev.6 期间被推翻的所有结论，供持有任一早期副本的读者对照。
每条的完整论证已写在正文对应章节（多数带 ⚠️ 标注），此处不重复展开。

| 旧结论（rev.1–rev.6） | 现行结论 | 正文 |
| --- | --- | --- |
| 峰值堆约 1 MB/KB，2 MB 接近 OOM；后改为堆增长次线性、内存不是主要风险、4 MB 是合理上限 | 同进程连续测量污染了数据。独立进程实测 1 MB 返回时堆 1116–1122 MB；真实 worker 路径 4 MB 为 49.99 s / maxRSS 4.35 GB。**内存是真实约束**；安全上限的现行结论见本表"4 MB 后仅剩 20% 余量……"一行 | [3.2](#32-时间与内存均构成约束安全上限尚未确定) |
| 主线程阻塞上限 600 ms；后改为 300–350 ms，并建议 leafCount 降到 4000 / 6000 以保证延迟 | 单一语料形态低估了上界。注释密集形态实测 400 ms 中位 / 457 ms 最高，独立复测另见 552 ms，**上限未确定**。降低 leafCount 不约束源码长度；双阈值联合校准只是更易收紧，不构成延迟证明 | [3.4](#34-direct-路由的主线程阻塞尾延迟已观测至-552-ms上限未确定) |
| `hasPotentialAlignmentGroup()` 未前置，前置即可纯收益约 19% | 已在 `alignment-policy.ts:516` 前置且命中即早返回。**不存在该优化机会**；真实问题是该检查 false positive | [3.3](#33-对齐第二遍廉价前置检查已存在但存在-false-positive) |
| `ownsNode()` 未用于跳过 shape 防御；`deriveExpectedTable` 是 invariants 主要开销，可抽查 | provenance 三级短路均已实现；`deriveExpectedTable` 仅占 5%。抽查属安全模型变更，需 ADR | [5.3](#53-invariants没有明显可安全删除的校验优化必须保持全量证明语义) |
| 用 `(source, dialect)` 缓存 analyze 结果，给 range 校验与 format 复用 | 缺 `mode`；range 用 `document` 分析全文，executor 用 `fragment` 分析 slice，**非同一 artifact，无法复用** | [3.1](#31-format-selection-的前置-range-校验在主线程做全文档分析) |
| runtime digest 由主进程算好传给 worker 以省一次读文件 | **安全退化**。`worker-entry.ts:34` 校验的是它自己实际加载的文件，传入 digest 会丢失启动前文件变更检测 | [3.5](#35-worker-生命周期) |
| 两次 boundary snapshot 都是重复开销 | 第一次**必须保留**——worker 的 structured clone 仍属不可信输入。只有第二次可用 brand 短路 | [5.4](#54-boundary-snapshot-的第二次执行可以短路) |
| 把异常信息放进 core diagnostic message，或作为未登记的附加字段挂在结果上 | `convert.ts:73` 会覆盖 message；未登记字段会被 `data-snapshot.ts:25` 的键白名单拒绝，整个结果被丢弃。可行路线见本表"debug 信息只有独立 callback/logger 一条路……"一行 | [5.2](#52-fmt_internal-全链路丢失排障信息) |
| `postgresql` / `mysql` 放开到 ECMAScript `ID_Start` / `ID_Continue` | 各方言有自己的 lexical contract，不能等价替换。且合并 unknown leaf 会降低 CJK 文档 leafCount，须与路由阈值同步校准 | [5.7](#57-lexicalprofile-抽象不完整标识符字符类没有-dialect-化) |
| `supported-languages.ts` 的 `dialect` 字段从未被读取 | `adapter-contract.ts:88` 读取它作为缺省 dialect。准确表述：**生产路径未读取，仅测试专用 contract 使用** | [5.6](#56-supported-languagests-的-dialect-字段在生产路径未被读取) |
| `INSERT INTO` 扩展成本很低；几乎每个生产脚本都用 `SET` | 两项均无支撑（未做实现评估、未用私有语料统计）。改为"值得优先做设计评估" | [6.3](#63-优先级建议) |
| 未建模构造导致混合大小写属功能缺陷；以 `P0–P4` 标注严重度 | 混合大小写是 verbatim 保真优先的预期结果，架构文档已规定。`P0–P4` 被读成发布阻断定级并导致排期矛盾，已弃用 | [4.7](#47-未建模构造导致同一语句内混合大小写预期行为属文档缺口) / [定级说明](#定级说明) |
| maxRSS 与源码近似线性，约 1.06 MB/KB；并以"逼近 `heap_size_limit`"解释末点偏离 | 四点比值为 1.48 / 1.44 / 1.44 / 1.06，两次运行的 maxRSS 又相差 17–22%，**不足以推断增长规律**。且进程级 maxRSS 与单 isolate 的 `heap_size_limit` 不同量纲，该解释无测量基础，已删除 | [3.2](#32-时间与内存均构成约束安全上限尚未确定) |
| 4 MB 后仅剩 20% 余量，任何机器慢一点就必超时；1 MB 是舒适区 / 已验证可完成的上界 | 剩余 10.01 s = 预算的 **16.7%**，需比本机慢 **20.0%** 才超时。**已验证可完成的最大档位是 4 MB**；1 MB 只是**建议的临时风险削减阈值候选**，未证明满足任何 UX/SLO 目标 | [3.2](#32-时间与内存均构成约束安全上限尚未确定) |
| `Format Selection` 使 worker 路由被完全绕过 | 被绕过的**只是前置 range 校验**；其后的格式化仍正常经 executor 路由。问题是路由决策之前多了一段无法被路由的全文档同步工作 | [3.1](#31-format-selection-的前置-range-校验在主线程做全文档分析) |
| debug 信息只有独立 callback/logger 一条路；`error.stack` 可原样打印且脱敏契约不变 | **正式扩展 `FormatResult` 协议同样可行**（成本更高但天然跨线程）；callback 无法直接跨 `worker_threads`，worker 路径须改 `protocol.ts` 或另建通道；`error.stack` 首行含 message，可能带源码片段，不能原样打印 | [5.2](#52-fmt_internal-全链路丢失排障信息) |
| 本文所有问题均未被现有测试门覆盖 | 部分现象被**显式断言为预期契约**（preserve 抑制、worker timeout/backpressure）。改这些要先改契约再改测试 | [4.2](#42-unsupportedsyntaxpolicy-preserve-下完全静默) |
| 诊断消息示例含方言名（“在 hive 下”） | `convertDiagnostic` 无 dialect 形参，adapter 层拿不到方言上下文。应改用不带方言的静态措辞，或显式传入 `dialect` | [4.1](#41-所有诊断消息被统一抹成一句话影响最大的-ux-问题) |
| source map 比 analysis index 更值得优化；160 entry/KB | 未做内存归因 profiling，无证据支持优先级；该密度只来自重复拼接语料。两者均为**待 profiling 的候选方向** | [3.2](#32-时间与内存均构成约束安全上限尚未确定) |
| 把 range 校验下沉 worker 称为"唯一能消除主线程阻塞的方案" | 在保持"命令触发即全量 analyze"架构的前提下它最直接可靠；改变该架构后，后台增量分析或预计算 artifact 同样可能消除阻塞 | [3.1](#31-format-selection-的前置-range-校验在主线程做全文档分析) |
| §2.1 根因指向 `trivia-policy.ts:346`，并称"把分隔符提前发射"即可修复 | 该行号无关（是 `leafContext` 调用）。真实链路是 `query-list-policy.ts:271-276` 的 gap 决策 + `render.ts:430-438` 的 `beforeSource` 在 flush 行注释后强制换行；根因链路涉及 suffix flush 时机，但修复还受 source-map 单调性约束（见本表下一行） | [2.1](#21-commastyle-trailing--行尾注释--逗号单独成行且对齐全失) |
| §2.1 建议"把行尾注释 line-suffix 绑到分隔符之后"，并列为第一批低风险修复 | **该修法不可实现**：注释 span 23–28 在逗号 span 29–30 之前，重排会触发 `render.ts:299-308` 的 `RENDER_SOURCE_MAP` 单调性守卫。只剩两条路线：路线 A（该边界局部降级为 leading comma，属策略降级，已列入第二批）与路线 B（重构 source-map 支持 source run 重排，架构级，列入第三批需 ADR） | [2.1](#21-commastyle-trailing--行尾注释--逗号单独成行且对齐全失) |
| §4.5 称 `linePrefixIsWhitespace` 慢在"用 `lastIndexOf` 反向扫" | 不是所有反向查找都慢：查**存在**的 `\n` 一找到就停（< 0.0001 ms）；只有查**不存在**的 `\r` 才被迫全文反扫（LF-only 文件下 0.1651 ms）。同文件的 `lineSuffixIsWhitespace` 仅在当前 Node 版本与语料下**未观察到**随文档增长，不能断言它"不是问题" | [4.5](#45-主机层的几个-on-陷阱) / [A.8](#a8-主机层-on-热点) |
| §4.5 称 `positionAtText` 在 505 KB × 50 选区为 25.0 ms | 少算一倍。`extension.ts:540-541` 每选区调用**两次**（anchor + active），实测 **49.5 ms**；原表把调用次数误标为选区数 | [4.5](#45-主机层的几个-on-陷阱) / [A.8](#a8-主机层-on-热点) |
| §2.3 称 BOM 的诊断会被 `preserve` 抑制、"连诊断也看不到" | 该诊断 `capabilityId` 为 `null`（实测），而抑制条件要求非 `null`，**不会被抑制**；编辑器里仍有 warning。BOM 不可见的真因是 [4.1](#41-所有诊断消息被统一抹成一句话影响最大的-ux-问题) 的通用消息，不是 [4.2](#42-unsupportedsyntaxpolicy-preserve-下完全静默) 的抑制逻辑 | [2.3](#23-utf-8-bom--静默完全不格式化) |

此外 rev.1 / rev.2 有若干计数与措辞不准（`statistics()` 形参与调用点数量、public corpus 文件数、
"带 `AS` + 行尾注释必然产出 alignment target"、alignment 候选占比混用 item 与 leaf 单位、
"每条诊断 2N 次全文本拷贝"），以及 rev.3 附录 B.3 给出的 worker 基准"脚本"实为不可运行的伪代码。
这些已在正文就地更正或补齐，不影响任何决策，故不单独列出。
