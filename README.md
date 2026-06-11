# SQL Beautify

VS Code 扩展，用于格式化 SQL / HQL，并提供实验性的 Hive DDL 格式化与 DDL 提取能力。

![demo](images/demo.gif)

## 安装

从 [GitHub Releases](https://github.com/IrvingYing224/sql-beautify/releases) 下载最新 `.vsix`，然后在 VS Code 中执行 `Extensions: Install from VSIX...` 安装。

最低支持 VS Code `1.90.0`。

## 这个扩展做什么

- 格式化 SQL / HQL
- 对 `SELECT`、`GROUP BY` 和顶层 `ORDER BY` 做列表换行与逗号对齐
- 支持 VS Code 标准 `Format Document` / `Format Selection`
- 提供实验性的 Hive DDL 格式化
- 提供实验性的 Hive `extractddl` 草稿提取

主格式化能力优先面向 Hive SQL / HQL。`generic`、`postgres`、`mysql` 为 best-effort 支持，复杂 SQL 建议格式化后复核结果。

## 怎么用

将文件语言模式设为 `SQL` 或 `hive-sql` 后，可以用下面几种方式：

- 执行 `Format Document` 或 `Format Selection`
- 执行命令 `SQL Beautify: Format SQL`
- 执行命令 `SQL Beautify: Copy Safe Diagnostic Report`：复制一份不包含 SQL 内容的诊断报告，用于在不能外发真实 SQL 的环境里反馈 warning、error 或慢格式化问题
- 使用快捷键 `Alt+Shift+F`

实验性命令：

- `SQL Beautify: Format Hive DDL (Experimental)`
- `SQL Beautify: Extract Hive DDL (Experimental)`

对应快捷键：

- `Alt+Shift+L`：格式化 Hive DDL
- `Alt+Shift+;`：提取 Hive DDL 草稿

## 配置

请在 VS Code 设置中搜索 `sqlBeautify`。

| 配置项 | 可选值 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `sqlBeautify.keywordCase` | `upper` / `lower` | `upper` | SQL 关键词大小写 |
| `sqlBeautify.commaStyle` | `leading` / `trailing` | `leading` | 逗号位于行首或行尾 |
| `sqlBeautify.indentStyle` | `tab` / `space` | `space` | 缩进风格 |
| `sqlBeautify.maxAlignWidth` | `1..500` | `150` | `AS` 与行尾注释参与对齐的最大代码宽度 |
| `sqlBeautify.caseWhenThenWrapLength` | `1..300` | `50` | `CASE WHEN` 中 `THEN` / `ELSE` 值的换行阈值 |
| `sqlBeautify.caseLayout` | `expanded` / `compactShort` | `expanded` | `CASE` 表达式布局；`compactShort` 会在安全且较短时保持单行 |
| `sqlBeautify.dialect` | `generic` / `hive` / `postgres` / `mysql` | `hive` | SQL 方言边界处理 |
| `sqlBeautify.unsupportedSyntaxPolicy` | `preserve` / `warn` / `bail_out` | `preserve` | 未建模语法的处理策略 |
| `sqlBeautify.debugDiagnostics` | `true` / `false` | `false` | 是否在扩展宿主控制台输出调试诊断 |

顶层 `ORDER BY` 会像 `GROUP BY` 一样拆成多行并对齐逗号；窗口函数里的 `ORDER BY` 仍保持原有行内格式。

`sqlBeautify.caseLayout` 默认为 `expanded`，保持原有展开式 `CASE` 排版。设置为 `compactShort` 后，只有短的、CASE 内部无注释、无嵌套且不需要多行保护的 `CASE` 会保持单行；不满足条件时会自动回退到展开式排版。

## Experimental 能力

### Hive DDL formatting

`Format Hive DDL (Experimental)` 只面向 Hive 风格 DDL。它不是通用 DDL parser，复杂建表语句请先在小范围验证结果。

### Hive `extractddl`

`Extract Hive DDL (Experimental)` 适合从常规 `SELECT` / `INSERT SELECT` 字段列表生成 DDL 草稿。

它支持高置信的顶层 `UNION` / `UNION ALL` 分支提取；只有分支字段形状一致时才会生成 DDL，不一致时会跳过，避免输出误导性 schema。生成的字段注释会转义为 Hive 兼容字符串字面量。

它不会推断真实字段类型；复杂表达式、非 Hive 语法、未加别名的表达式或复杂列推断场景，请人工复核输出。

## 简洁风险提示

- 复杂 SQL、非 Hive 方言、以及未建模语法场景下，请在格式化后复核结果。
- `unsupportedSyntaxPolicy=warn` 会继续格式化周边 SQL，并在 VS Code 中给出 warning。
- `unsupportedSyntaxPolicy=bail_out` 会在遇到未建模语法时直接拒绝格式化。
- 选区格式化只接受边界完整的整行片段；不安全片段会被拒绝，而不是猜测性改写。

[Release Notes](https://github.com/IrvingYing224/sql-beautify/blob/main/CHANGELOG.md)
