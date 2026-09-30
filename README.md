# SQL Beautify

VS Code 扩展，用于格式化 SQL / HQL，并提供实验性的 Hive DDL 格式化与 DDL 提取能力。

## 安装

从 [GitHub Releases](https://github.com/IrvingYing224/sql-beautify/releases) 下载最新 `.vsix`，然后在 VS Code 中执行 `Extensions: Install from VSIX...` 安装。

最低支持 VS Code `1.90.0`。

从 1.x、2.0.x 或 2.1.x 升级时，请先阅读 [2.2 迁移指南](https://github.com/IrvingYing224/sql-beautify/blob/v2.2.0/docs/migration-to-2.2.md)。

## 这个扩展做什么

- 格式化 SQL / HQL
- 对 `SELECT`、`GROUP BY` 和顶层 `ORDER BY` 做列表换行与逗号对齐
- 格式化有界的 Hive `INSERT INTO [TABLE] ... [PARTITION (...)] SELECT/WITH ...` 与 `SET` 命令
- 支持 VS Code 标准 `Format Document` / `Format Selection`
- 提供实验性的 Hive DDL 格式化
- 提供实验性的 Hive Extract DDL 草稿提取

主格式化能力优先面向 Hive SQL / HQL。`generic`、`postgresql`、`mysql` 为 best-effort 支持，复杂 SQL 建议格式化后复核结果。

## 怎么用

将文件语言模式设为 `SQL` 或 `hive-sql` 后，可以用下面几种方式。`hive-sql` language id 由第三方 Hive 语言扩展提供，SQL Beautify 本身不注册语言：

- 执行 `Format Document` 或 `Format Selection`
- 执行命令 `SQL Beautify: Format SQL`
- 执行命令 `SQL Beautify: Copy Safe Diagnostic Report`：复制一份不包含 SQL 内容的诊断报告，用于在不能外发真实 SQL 的环境里反馈 warning、error 或慢格式化问题

SQL Beautify 不覆盖 VS Code 的 `Shift+Alt+F` / `Format Document` 默认入口。若安装了多个 formatter，请把 `editor.defaultFormatter` 设为 `clarkyu.vscode-sql-beautify`；需要专用快捷键时可在 Keyboard Shortcuts 中为 `sqlBeautify.formatSql` 自行绑定。

实验性命令：

- `SQL Beautify: Format Hive DDL (Experimental)`
- `SQL Beautify: Extract Hive DDL (Experimental)`

对应快捷键：

- `Alt+Shift+L`：格式化 Hive DDL
- `Alt+Shift+;`：提取 Hive DDL 草稿

## 配置

请在 VS Code 设置中搜索 `sqlBeautify`。

格式化选项支持工作区、文件夹及 `[sql]` / `[hive-sql]` 按语言覆盖，由 VS Code 按当前文档解析；程序调用 `sqlBeautify.formatSql` 时传入的显式选项再覆盖这些设置。`debugDiagnostics` 是窗口级设置。缩进风格以 `sqlBeautify.indentStyle` 为准，空格缩进固定为 4 个空格；编辑器的 `insertSpaces` 不覆盖它，`tabSize` 只决定 tab stop 和显示宽度。数值选项只接受表中范围内的整数。

| 配置项 | 可选值 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `sqlBeautify.keywordCase` | `upper` / `lower` | `upper` | SQL 关键词大小写 |
| `sqlBeautify.commaStyle` | `leading` / `trailing` | `leading` | 逗号位于行首或行尾；行尾注释阻断 source order 时，`trailing` 会局部回退到行首并报告信息诊断 |
| `sqlBeautify.indentStyle` | `tab` / `space` | `space` | 缩进风格 |
| `sqlBeautify.maxAlignWidth` | `1..500` | `150` | `AS` 与行尾注释参与对齐的最大代码宽度 |
| `sqlBeautify.caseWhenThenWrapLength` | `1..300` | `50` | `CASE WHEN` 中 `THEN` / `ELSE` 值的换行阈值 |
| `sqlBeautify.caseLayout` | `expanded` / `compactShort` | `expanded` | `CASE` 表达式布局；`compactShort` 会在安全且较短时保持单行 |
| `sqlBeautify.dialect` | `generic` / `hive` / `postgresql` / `mysql` | `hive` | SQL 方言边界处理 |
| `sqlBeautify.unsupportedSyntaxPolicy` | `preserve` / `warn` / `bail_out` | `warn` | 未建模语法的处理策略 |
| `sqlBeautify.debugDiagnostics` | `true` / `false` | `false` | 是否在扩展宿主控制台输出调试诊断 |

顶层 `ORDER BY` 会像 `GROUP BY` 一样拆成多行并对齐逗号；窗口函数里的 `ORDER BY` 仍保持原有行内格式。

`sqlBeautify.caseLayout` 默认为 `expanded`，保持原有展开式 `CASE` 排版。设置为 `compactShort` 后，只有短的、CASE 内部无注释、无嵌套且不需要多行保护的 `CASE` 会保持单行；不满足条件时会自动回退到展开式排版。

已建模区域会应用 `sqlBeautify.keywordCase`；verbatim 区域始终保留原文，因此其中的关键词大小写不会被改写。主 formatter 的单个完整文档或 target 上限为 524,288 个 UTF-16 code units；超限输入会保留完整原文且不提交编辑。

格式化或提取时的 tab stop 来自 VS Code 的 `FormattingOptions.tabSize` 或活动编辑器设置，并同时用于主 formatter、Experimental DDL 与 Extract DDL 的显示宽度和对齐计算。公开 Node.js `formatSql()`、`formatHiveDdl()` 与 `extractDdl()` 使用默认 tab stop 4，`tabSize` 不是它们的公开 option。非法 `sqlBeautify.*` 配置会发布安全的 `CFG_*` 诊断；手动命令会在配置 key 可安全识别时指出具体设置，不再静默跳过。

## Experimental 能力

### Hive DDL formatting

`Format Hive DDL (Experimental)` 只接受完整消费的、已建模的 Hive `CREATE TABLE` 子集。除列定义和列 `COMMENT` 外，当前还支持按顺序出现的可选 `PARTITIONED BY (...)` 与 `STORED AS <format>`；`format` 仅限 `AVRO`、`ORC`、`PARQUET`、`RCFILE`、`SEQUENCEFILE` 和 `TEXTFILE`。DDL 输出沿用 `sqlBeautify.keywordCase`、`sqlBeautify.commaStyle`、`sqlBeautify.indentStyle` 与 `sqlBeautify.maxAlignWidth`；超宽列名会放弃补齐空格而不是放大输出。

它不是通用 DDL parser；`ALTER`、`DROP`、多 statement、`LOCATION`、`TBLPROPERTIES`、CTAS、重复或乱序后缀、未知 storage format、约束、默认值或结构不完整的输入都会保留完整原文，不会被猜测性改写。选区命令只对生成空白应用首行缩进与文档 LF/CRLF；多行 string、quoted identifier 和 comment 内部的原始空格与 EOL 保持逐字符不变。公开 DDL / Extract DDL API 的单次输入及 VS Code DDL transaction 的完整文档同样以 524,288 个 UTF-16 code units 为上限；所有目标继续以整批原子方式提交，任一目标不受支持或超过输入/输出资源预算时不会提交部分编辑。

主 `Format SQL` 命令会保留 Hive DDL；需要格式化 `CREATE TABLE` 时，应使用专用的 `Format Hive DDL (Experimental)` 命令。

### Hive Extract DDL

`Extract Hive DDL (Experimental)` 只从完整的 `SELECT` 查询字段列表生成 DDL 草稿，支持带 `WITH` 的查询；当前不接受 `INSERT SELECT`，此类输入会保留原文并提示不支持。

它支持高置信的顶层 `UNION` / `UNION ALL` 分支提取；只有分支字段形状一致时才会生成 DDL，不一致时会跳过，避免输出误导性 schema。生成的字段注释会转义为 Hive 兼容字符串字面量。

它不会推断真实字段类型；Node.js API 的可选 `defaultType` 必须来自普通 data property、最长 128 个 UTF-16 code units，Proxy、accessor、未知 key 或异常 prototype 会安全失败。复杂表达式、非 Hive 语法、未加别名的表达式或复杂列推断场景，请人工复核输出。

公开 Node.js `formatSql()`、`formatHiveDdl()`、`extractDdl()` 通过省略选项使用默认值；选项对象为 `null`，或对象内字段显式设为 `null` / `undefined`，都会失败，避免把配置错误静默解释为默认值。Extract DDL 生成的是待补全类型的字段草稿，使用固定的行首逗号和空格布局，不读取主 formatter 的排版选项。

## 简洁风险提示

- 复杂 SQL、非 Hive 方言、以及未建模语法场景下，请在格式化后复核结果。
- `unsupportedSyntaxPolicy=warn` 会继续格式化周边 SQL，并在 VS Code 中给出 warning。
- `unsupportedSyntaxPolicy=preserve` 使用相同的安全输出，但不在编辑器中显示 capability warning；手动执行 `SQL Beautify: Format SQL` 且因未建模区域没有修改时，会显示一次不含 SQL 内容的汇总提示。format provider 与 format-on-save 不弹出该提示。
- `unsupportedSyntaxPolicy=bail_out` 会在出现任何未建模或解析恢复区域时保留整个格式化目标的原文，包括尚未登记能力名称的语法、局部语法错误和 parser 深度超限；同一目标中其余语句也不会修改。
- parser 遇到未建模语法、局部语法错误或资源预算耗尽时，按可证明边界保留对应区域、整条语句或整个目标，并报告 warning。`warn` / `preserve` 允许继续格式化局部保留区域之外的 SQL；`bail_out` 则保留整个目标。layout 或 renderer 预算耗尽会保留整个目标，不提交部分布局；内部不变量破坏仍作为 hard failure 处理。
- Hive 的 `EXPLAIN`、`GROUPING SETS`、`TRANSFORM`、主 formatter 中的 DDL、`UPDATE` 和 `DELETE` 目前明确按 verbatim 保留，不宣称已格式化；完整边界以生成的 support matrix 为准。
- 选区格式化接受完整文档、完整单句或两个以上连续完整 statement；半条 statement、跨 protected/opaque 边界或结构不完整的片段会被拒绝，而不是猜测性改写。
- `sqlBeautify.debugDiagnostics=true` 会在本地扩展宿主控制台输出 opt-in 调试事件，可能包含 SQL 片段、错误栈和本地文件路径；只在可以接受这些信息暴露到控制台时启用。编辑器诊断和 `Copy Safe Diagnostic Report` 不包含这些调试事件。

[Release Notes](https://github.com/IrvingYing224/sql-beautify/blob/main/CHANGELOG.md)
