# Migrating to SQL Beautify 3.0

SQL Beautify 3.0 收紧 2.x formatter 的输入、执行器、诊断和方言边界，并新增有界的 Hive `INSERT INTO` 与 `SET` 支持。公开 Node.js 函数名和 subpath export 保持不变，但格式化行为与资源上限有意发生变化，因此应先在版本控制中复核输出再批量升级。

## 从 2.x 升级

### 输入与输出边界

- CRLF、lone CR、LF 和 offset 0 的 UTF-8 BOM 现在会在整个格式化请求中保持一致；verbatim source slice 内的原始换行不会被改写。
- `commaStyle=trailing` 遇到“item → 行尾注释 → separator”的 source 顺序时，该局部边界会安全回退为 leading comma，以保持 source map 的 source/output 双单调契约。
- 主 formatter 的单个完整文档或 target 上限为 524,288 个 JavaScript UTF-16 code units。`formatSql()` 对超限输入返回 `preserved` 和完整原文；VS Code document/range/multi-selection 事务会拒绝整批编辑。不要把该数值当作 UTF-8 byte 上限。
- document、range、multi-selection、worker 和 experimental DDL 继续 all-or-nothing。取消、过期文档、超限、任一 target 拒绝或 executor 异常都不会提交部分 edit。

### unsupported 与 verbatim

`unsupportedSyntaxPolicy=preserve` 仍会隐藏 capability editor warning，但手动执行 `SQL Beautify: Format SQL` 且结果因 capability 证据为 `unchanged`/`rejected` 时，会显示一次不含 SQL 内容的汇总提示。format provider 与 format-on-save 不弹窗；遇到 `hive-ddl` 时，提示会指向专用的 experimental Hive DDL 命令。

verbatim 区域是原文保留边界，不参与 `keywordCase`。因此同一输出中，已建模区域可以变为大写或小写，而 `EXPLAIN`、`GROUPING SETS`、`TRANSFORM`、主 formatter 中的 Hive DDL、`UPDATE`、`DELETE` 等明确 preserved 区域仍保持输入大小写。这不是 keyword case 漏改。

### Hive 与方言能力

3.0 新增以下 `hive` formatted capability：

- `INSERT INTO [TABLE] target [PARTITION (...)] SELECT/WITH ...`；
- `SET`、`SET key` 和 `SET key=value`，其中 payload 作为有界 verbatim assignment 保留，不推断变量或表达式语义。

`EXPLAIN`、`GROUPING SETS`、`TRANSFORM`、主 formatter 中的 Hive DDL、`UPDATE` 和 `DELETE` 仍是整句 verbatim，不应理解为已经格式化。完整状态以 [support matrix](technical/sql-support-matrix.md) 为准。`CREATE TABLE` 只有在专用 `SQL Beautify: Format Hive DDL (Experimental)` 命令或 `formatHiveDdl()` 中，且完整匹配已建模子集时才会格式化。

裸标识符的字符集现在按方言决定：`hive`/`generic` 继续使用保守 ASCII 边界；PostgreSQL 接受保守的 Unicode letter 子集；MySQL 使用有界的 BMP unquoted-name 范围。需要跨方言稳定行为时，请使用目标方言认可的 quoted identifier。

### 执行器与排障

direct / persistent worker 路由是内部实现，不新增公开配置。小请求必须同时小于 8,192 code units 和 2,000 leaves 才走 direct；其他受支持请求走 worker。range 的完整文档结构校验也进入同一 executor 路径，避免在 VS Code 主线程同步分析大文档。

`sqlBeautify.debugDiagnostics` 仍默认关闭。启用后，本地扩展宿主控制台中的 opt-in debug event 可能包含 SQL 片段、异常 message/stack frame 和本地文件路径；只在可以接受这些内容暴露到控制台时开启。编辑器诊断与 `SQL Beautify: Copy Safe Diagnostic Report` 不包含 debug event。

## Node.js consumers

公开入口保持为：

```js
const { formatSql, lexSql } = require('vscode-sql-beautify/formatter');
const { formatHiveDdl, extractDdl } = require('vscode-sql-beautify/experimental/ddl');
```

`formatSql(source, options)` 仍返回冻结的结构化结果：

- `formatted` / `unchanged`：包含 `text`、`diagnostics` 和 validated `sourceMap`；
- `preserved` / `failed`：`text` 是完整原文，不暴露部分 `sourceMap`。

公开 `FormatResult` 没有增加 statistics 或 debug 字段。canonical dialect 仍是 `hive`、`generic`、`postgresql`、`mysql`。Experimental `extractDdl()` 仍不推断类型，未提供有界 `defaultType` 时使用 `__TYPE_REQUIRED__`。

## 仍从 1.x 升级

1.x 的 `extension.beautifySql`、`extension.beautifySqlddl`、`extension.extractDdl` 命令已经移除；请分别使用 `sqlBeautify.formatSql`、`sqlBeautify.formatHiveDdl`、`sqlBeautify.extractHiveDdl`。`postgres` 配置值应改为 `postgresql`。

package root、`vkbeautify.js`、positional API、`lib/**` require 路径和 `extractddl()` 不会恢复。完整 1.x → 2.0 cutover 背景仍保留在 [2.0 历史迁移指南](migration-to-2.0.md)；升级到 3.0 时还必须应用本文的输入与行为边界。

## 回退

3.0 没有切换回旧 formatter 的兼容开关。如现有工作流依赖超过 524,288 code units 的单次格式化、2.x 的 `preserve` 静默行为或旧的方言 tokenization，请先拆分输入或固定安装 `2.0.1` VSIX，再单独评估迁移。最低支持 VS Code 版本仍为 `1.90.0`。
