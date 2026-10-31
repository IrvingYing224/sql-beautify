# SQL Beautify 架构（3.0）

本文说明 3.0 的代码结构和格式化流程，供改代码和复核时查阅。用户可见的行为见 `README.md`，工作规则见 `AGENTS.md`，3.0 重构的决定见 [ADR 0006](adr/0006-3.0-refactor.md)。

## 目录与依赖方向

```
src/
  extension.ts   组装：注册 provider、命令和诊断
  vscode/        宿主：配置读取、provider、命令、选区、诊断与提示文案
  edits/         computeEdits（查询、DDL、Extract 共用）、范围校验、offset 换算、执行器与 worker
  core/          lexer → syntax → analysis → layout → renderer → api
  ddl/           Experimental Hive DDL 格式化与 Extract DDL
```

依赖只能从上往下：`vscode` 用 `edits`，`edits` 用 `core` 与 `ddl`，`ddl` 用 `core`。`core` 不引用其余目录，也不引用 VS Code。

`core/` 内部：

| 目录 | 职责 |
| --- | --- |
| `lexer/` | 无损 lexer：leaf 按 UTF-16 offset 切分原文，拼接后等于原文；BOM 是 offset 0 的 trivia leaf；`${…}` 模板片段合成一个 leaf |
| `dialects/` | Hive 的 capability 表、运算符优先级、子句与 JOIN 语法表 |
| `syntax/` | 面向格式化的 CST：语句、查询、表达式、类型、窗口的 parser，语句头表（`statement-head.ts`），局部恢复与未建模结构识别，嵌套深度上限 256 |
| `analysis/` | 一次遍历建立结构索引（父子、语句、子句、列表、分隔符），并把每个注释绑定到 leading、trailing 或 dangling 位置 |
| `layout/` | 排版策略：产出 layout plan（gap 决定与 scope），再编译成 Layout IR |
| `renderer/` | 唯一写空白和改关键字大小写的地方：执行 Layout IR，计算显示宽度与平铺宽度，生成 source map |
| `api/` | `formatSql` 的流程、结果类型、输入与输出上限、底线 2 的检查（`floor.ts`） |
| `config/` | 选项定义（默认值、枚举、整数范围）与解析 |
| `diagnostics/`、`source/` | 诊断与 debug event、source span 与 source map |

## formatSql 的流程

```
lex → parse（CST）→ analyze（索引 + 注释绑定）→ plan → compile（Layout IR）→ render
    → 有对齐目标时：把 plan 中对应的 gap 改成 pad-to-column → compile → render
    → 底线 2 检查（token 等价与粘连保持）→ FormatResult
```

- **plan**：policy 按 CST 给每个 leaf 之间的 gap 登记决定（空格、无空白、换行、保留原文），并给 leaf 区间登记 scope：`indent`（缩进几层）、`align`（加几列）、`group` 与 `auto-group`（平铺或拆行；`auto-group` 在平铺宽度不超过上限时平铺）、`hang`（内部的行对齐到 scope 开始时的输出列，用于 CASE）。scope 必须嵌套，同一范围上的顺序固定为 align、group、hang、indent，由外到内。gap 或 scope 冲突时 plan 失败，target 返回原文。
- **Layout IR**：`text`、`space`、`line`（hard 或可平铺）、`concat`、`indent`、`align`、`hang`、`group`、`pad-to-column`、`line-suffix`（推迟到行尾写出的注释）、`verbatim`。
- **render**：栈式执行 Layout IR，行前缀在写出第一个非空白内容时才生成。第一条语句所在行有缩进时，这段缩进作为基准缩进加在之后每一行的前面（空行和原样片段内部除外）。metrics 计算各节点的平铺宽度，供 `auto-group` 判断。
- **对齐第二遍**：第一遍渲染后测量 `AS` 和行尾注释所在的列，把 plan 里相应的 gap 改写成 `pad-to-column` 再编译、渲染一次，不重跑 policy（ADR 0003）。
- **底线 2 检查**（`api/floor.ts`）：重新 lex 输出，与原文逐 leaf 比较 token 与粘连，规则见下一节。

结果有四种 status：`formatted`、`unchanged`（带 source map），`preserved`、`failed`（原文加诊断，没有 source map）。内部错误一律 throw，由 `formatSql` 顶层 catch 转为返回原文加 `FMT_INTERNAL`。

## 五条底线的细则

`AGENTS.md` 列出五条底线，这里写它们的完整定义。

1. **lexer 无损**：所有 leaf 拼接起来等于原文，只在 lexer 中检查一次。
2. **token 等价与粘连保持**，适用于 `formatSql` 与 `formatHiveDdl`；Extract 生成的是另一种 SQL，不适用。
   - token 等价：输出重新 lex 后，非空白 token 的 kind、channel、原文与输入逐个相同，只有计划改大小写的关键字按大小写不敏感比较。不成立时返回原文，status 为 `failed`，诊断 `FMT_TOKEN_EQUIVALENCE`（视为内部错误）。
   - 粘连保持：检查按顺序排列的非空白 leaf（包括 channel 为 `protected` 的 parameter），注释算作分隔。相邻两个单词类 leaf（keyword、identifier、number、parameter）之间有没有空白，必须与原文相同。模板片段从每个 `${…}` 出发向两侧吸收零宽相邻的 leaf，遇到空白、换行、注释或 `,`、`(`、`)`、`;` 时停止；片段内部不得出现空白，片段外侧原有的空白不得删除。lexer 把每个模板片段合成一个 parameter leaf，所以运行时实际只需检查单词类相邻和片段外侧空白；golden runner 按完整定义独立检查。不成立时返回原文，status 为 `preserved`，warning `FMT_GLUE_PRESERVED`。
   - 这条规则补的是 token 等价看不到的地方：`0L` → `0 L`、`${p}desc` → `${p} DESC`、`${lhs}=1` → `${lhs} = 1`（`lhs` 为 `x>` 时 `>=` 被拆开），token 指纹都不变。代价是模板紧贴运算符的写法（`ds=${hiveconf:run_date}`）保持原样。前提是 `${…}` 的展开值不改变词法结构（ADR 0006 的 D13）；`?`、`:name` 这类绑定占位符不做文本替换，不适用。
3. **编辑原子提交**：计算前记下文档版本，算出全部 target，提交前复查文档身份与版本，一次提交并检查结果；任一 target 失败、取消或过期时不提交任何 edit。
4. **资源上限**，超限一律返回原文：
   - 单个文档或 target 最多 524,288 个 UTF-16 code units（`FMT_INPUT_LIMIT`，status 为 `preserved`）；
   - parser 嵌套深度 256（`SYN_MAX_DEPTH_EXCEEDED`，超出的部分按语法错误原样保留），每个查询块识别未建模子句最多尝试 16 次，超出时整条语句原样保留（`SYN_PROOF_BUDGET`）；
   - `formatSql` 每个 target 的输出不超过 4 × 输入 + 65,536，renderer 边写边计数，超限立即停止（`RENDER_OUTPUT_LIMIT`）；`formatHiveDdl` 与 Extract 不超过 4 × 输入 + 4,096 + 160 × 行数；
   - 批量操作不另设总上限，target 互不重叠，总量已受单个 target 与输入上限约束。
5. **受保护文本不改写**，字符原样保留，包括大小写和内部空白：字符串、注释、引号标识符、`${…}` 模板与模板片段（作为一个原子参与排版）、Hive 数字 literal 整体（`0L`、`10Y`、`5S`、`1.0D`、`1.0BD`）、命令载荷（包括 SET 的值），以及通用层中语句头表以外的词（保持原大小写）。

原样保留以最小安全片段为单位：一个模板片段、一段载荷或一个未建模节点。只有词法错误（未闭合的字符串或注释）、资源超限、第 2 条不成立、内部异常，或者 `bail_out` 下还有原样保留的片段时，整个 target 才保持原文。幂等是测试属性，由 golden runner 和 fuzz 检查，运行时不检查。

## 三层排版与原样保留

| 层 | 范围 | 行为 |
| --- | --- | --- |
| 已建模 | 查询（SELECT、WITH、集合运算）、INSERT、CTAS 的查询部分 | 完整排版 |
| 通用层 | 语句头表命中的脚本语句（`USE`、`SHOW`、`DESCRIBE`、`MSCK`、`ANALYZE`、`LOAD DATA`、`DROP`、`ALTER TABLE` 等）与 CTAS 的外壳 | 只改空白的量：行内连续空白压成一个空格，删除行尾空白；换行、续行缩进和零宽间隙不变；只有语句开头那段关键字按 `keywordCase` 改大小写 |
| 命令载荷 | `ADD JAR`、`DFS`、`!`、`SOURCE`、`RESET`、`COMPILE` 等命令头之后到 `;` 之前的文本，以及 SET 的载荷 | 命令头改大小写，载荷逐字节保留 |
| 原样保留 | 未建模语法（列定义形式的 `CREATE TABLE`、`CREATE VIEW`、`EXPLAIN`、`GROUPING SETS`、`TRANSFORM`、`UPDATE`、`DELETE`、`MERGE`、FROM 开头的 multi-insert）、语法错误、超出上限 | 取能证明边界的最小范围保留原文，并给出诊断 |

通用层不改空白的有无，所以不会往 `0L`、`/tmp/my-udf.jar` 这类零宽间隙里插入空格。原样保留的范围由 `layout/verbatim-claims.ts` 登记为 verbatim claim，renderer 直接写出原文，不改大小写。

`unsupportedSyntaxPolicy` 决定原样保留的片段怎么报：`warn` 报 warning，`preserve` 不报（宿主隐藏带 capability 的 warning），`bail_out` 只要还有原样保留的片段，就让整个 target 保持原文。通用层、命令载荷和 CTAS 外壳处理过的范围不算原样保留。

## 编辑与执行器（`src/edits/`）

`computeEdits({ op, source, targets, options, newline, tabSize })` 是纯函数，`op` 为 `format`、`hive-ddl` 或 `extract`：

1. 规范化 target：排序，有重叠时整批拒绝；
2. 逐个校验范围：两端不能落在字符串、注释等受保护 leaf 内部；查询的选区要覆盖整行，并且正好是一条语句、一个子句或一个列表，或者若干条连续的完整语句（整个文档总是可以）；DDL 与 Extract 的选区同样要覆盖整行，由各自的 parser 判断能否完整消费；
3. 逐个 target 计算，DDL 的结果同样经过底线 2 的检查；
4. 返回 `{ status, edits, diagnostics }`，任一 target 被拒时整批不给 edit。

执行器：输入不小于 32 Ki code units 时在 worker 中计算，否则直接计算。worker 懒创建；出错或退出时拒绝所有挂起的请求，下次请求重建。取消唯一挂起的请求时直接 terminate worker；还有其他请求时只结束被取消的那个，忽略它的回复。

## VS Code 宿主（`src/vscode/`）

- 对 `sql` 与 `hive-sql` 两个 language id 注册 Format Document、Format Selection 和多选区格式化，另有 `SQL Beautify: Format SQL` 与两个 Experimental DDL 命令。
- 提交：记下文档版本 → 计算全部 target → 复查版本与文本 → 一次 `editor.edit` 或 provider 返回，检查结果；任一失败、取消或过期都不提交（底线 3）。光标与选区有 source map 时按 source map 恢复，否则按 offset 偏移量恢复。
- 诊断：一个 `DiagnosticCollection`，提交成功且文档文本等于预测输出时才发布；文档有无关编辑或关闭时清除；配置变化时刷新 `CFG_*` 诊断。编辑器诊断直接显示格式化器的消息，截断到 200 字符；内部异常和每次格式化的 status 摘要写入 "SQL Beautify" 输出通道。

## Experimental DDL（`src/ddl/`）

- `formatHiveDdl`：只接受完整消费的 Hive `CREATE TABLE` 子集（列定义与列 `COMMENT`，可选 `PARTITIONED BY` 与 `STORED AS` 六种格式），列名、类型、注释按列对齐；其余输入保留原文。
- `extractDdl`：从完整的 SELECT 字段列表生成 DDL 草稿，类型写占位符，不推断类型；UNION 各分支字段形状一致时才生成。

## 测试

- `tests/golden/`：排版规格。用例在 `cases/<分组>/<名字>.in.txt`，首行可写 `-- golden: {...}` 指定 op、选项、模式、换行、tabSize、起始列与变体；输出存为 `.out.txt`（输出等于输入时不存），status 与诊断 code 记在 `snapshot.json`。runner 对每个用例检查逐字节输出、幂等（第二遍 status 必须为 `unchanged`）、token 等价与粘连保持。`--fuzz N` 用确定性随机变异检查幂等与底线；`--private <目录>` 对仓库外的真实 SQL 只检查底线和 failed。`known-issues.json` 登记暂时豁免的检查，3.0 时为空。
- `tests/unit/`：lexer、core、DDL、edits、执行器与宿主的行为测试，覆盖编辑原子性、范围校验、source map 与光标恢复、worker 重建与取消、上限边界和配置校验。
- `tests/vscode/smoke.js`：在真实 VS Code（1.90.0 与 stable）中运行的冒烟测试，手动执行 `npm run test:vscode`。

## 构建与发布

- `scripts/build.js` 用 esbuild 从 TS 打出 `dist/extension.cjs` 与 `dist/worker.cjs`，core 打进两个 bundle；`npm run typecheck` 只做类型检查。
- `npm run package` 用 `vsce package --no-dependencies` 打包，`scripts/check-vsix.js` 核对 VSIX 的文件清单。
- CI（`.github/workflows/build-vsix.yml`）在 push 与 PR 时运行 typecheck、`npm test` 和 package。从 `main` 手动触发时，`release` job 检查 CHANGELOG 有当前版本的条目、tag 尚不存在，然后创建 GitHub Release 并上传 VSIX。
- `scripts/generate-v2-unicode-width-data.js` 只在升级 Unicode 版本时手动运行。

## 3.0 之后的已知缺陷

| 编号 | 问题 | 类别 |
| --- | --- | --- |
| K16 | 超长行从不换行，例如长 IN 列表、多参数 `concat_ws` | 功能缺失 |
| K19 | Experimental DDL 不接受带表 `COMMENT`、`ROW FORMAT`、`LOCATION`、`TBLPROPERTIES` 的 DDL，生产 DDL 大多不在支持范围内 | 功能缺失 |
| K39 | 逗号前置时，逗号后紧跟的行尾注释无法留在左项那一行：`select a, b, -- c` 换行接 `c` 时整张列表改用后置逗号。保持前置逗号要把注释移到逗号前，需要放宽 source map 的双单调、选区映射与底线 2 的顺序比较（ADR 0002） | Minor |
| K40 | 括号查询后接 ORDER BY 时整句原样保留：`(select a from s) order by a`、`insert into t (select 1) order by a`、`create table t as (select …) order by a` | 功能缺失 |
| K41 | 窗口定义引用基窗口名时，该项原样保留并报 warning：`over (w order by b)` | 功能缺失 |
| K42 | 源码中注释本来就单独成行时，比较运算的右操作数落在第 0 列：`where a =`、`/* x */`、`1` 各占一行 | Minor |

修这些问题时，先加 golden 用例，再改 layout policy 或 parser。
