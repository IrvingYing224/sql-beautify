# Migrating to SQL Beautify 2.2

SQL Beautify 2.2 是一次兼容的安全性、可观测性和性能修订。公开 Node.js subpath export 与主 formatter 的值 API 保持不变；`formatHiveDdl()` 只增加可选 options。格式化边界、诊断反馈和 Experimental Hive DDL 子集有意扩展，建议先在版本控制中抽样复核输出，再批量升级。

## 从 2.1.x 升级

### Parser、布局与保留边界

- 嵌套、歧义的 unsupported clause 证明现在使用请求内缓存和线性工作预算。类似深层 `QUALIFY` 的输入不再出现指数级解析；预算耗尽会报告 `SYN_PROOF_BUDGET` 并在已证明的 statement 边界保留原文。
- Layout IR 的合法资源耗尽不再伪装成内部 artifact 破坏。过深 `CASE` 或其他超出布局预算的 target 会保留完整原文并报告 warning；provenance、source gap、token equivalence 等不变量破坏仍然 hard fail。
- 合法但很宽的 `maxAlignWidth` 不再使整份 layout plan 失败。对齐目标超过请求级生成宽度预算时，只跳过该对齐机会。
- `commaStyle=trailing` 遇到“item → 行尾注释 → separator”的 source order 时仍局部回退到 leading comma，以保持 source-map 双单调；2.2 新增 `LAYOUT_COMMA_FALLBACK` information 诊断，使该降级可发现。

### Unicode、显示宽度与 tab

- keyword fold 只接受 ASCII candidate，`ſelect` 等 Unicode 大小写折叠结果不会再误判为 SQL keyword。
- 显示宽度数据升级到 Unicode 17.0.0；soft hyphen、ZWSP、ZWJ、word joiner、variation selector 等 default-ignorable code point 不再错误占用一列，可见 grapheme base 仍按其真实宽度计算。
- VS Code 的 document/range provider 使用 `FormattingOptions.tabSize`，手动命令使用活动编辑器的 `tabSize`，direct 与 worker 共享同一 render environment。
- `tabSize` 不是公开 `formatSql(source, options)` 的 option；Node.js 值 API 继续使用 4 作为默认 tab stop。向公开 options 传入未知 key 仍会以 `CFG_UNKNOWN_OPTION` fail closed。
- U+0085、U+2028、U+2029 仍不被当作 SQL physical newline；这是保留的词法契约，不是 JavaScript 文本行语义的映射。

### VS Code 选区、配置与反馈

- 2.1 已支持的有界 Hive `INSERT INTO [TABLE] ... [PARTITION (...)] SELECT/WITH ...` 与 `SET` / `SET key=value` 保持不变；后者的 assignment payload 仍作为 verbatim 保留，不推断表达式语义。
- 完整文档选区以及由两个或更多完整、连续 statement 组成的选区现在按 document mode 验证和格式化。半条 statement、跨 protected/opaque 边界或结构不完整的片段仍拒绝编辑。
- `Shift+Alt+F` / `Format Document` 完全交还 VS Code 标准 formatter 入口；扩展不再注册 `Alt+Shift+F`。若有多个 formatter，请配置 `editor.defaultFormatter`，需要专用快捷键时自行绑定 `sqlBeautify.formatSql`。
- 非法 `sqlBeautify.*` 配置不再静默禁用 formatter。provider 发布不含 SQL 的 `CFG_*` diagnostic；手动命令显示本地化错误，并在 key 经过 allowlist 验证时指出具体 `sqlBeautify.<key>`。
- 命令反馈区分 cancel、stale、range、selection-map、input limit、worker、host edit rejection 与 unsupported preserve；英文和简体中文消息使用同一分类事实。
- opt-in `debugDiagnostics` 仍可能包含 SQL 或异常上下文，但绝对路径会归一化。编辑器诊断和 safe clipboard report 不包含这些 debug event。

### Worker 执行边界

runtime digest mismatch 和带可证明 request identity 的 malformed protocol 会立即返回有界失败，不再等待完整 request timeout。取消后的 worker drain grace 由 source code units 决定：8 KiB 为 224 ms，100k 为 494 ms，512 KiB 为 1736 ms，上限 2000 ms；这降低正常大请求取消后反复重启 worker 的概率。取消、timeout、runtime skew、protocol error 和 stale response 仍然不提交任何 edit。

### Experimental Hive DDL

`formatHiveDdl(source, options?)` 现在接受以下可选 plain-data options：

```js
const { formatHiveDdl } = require('vscode-sql-beautify/experimental/ddl');

formatHiveDdl(source, {
    keywordCase: 'lower',
    commaStyle: 'trailing',
    indentStyle: 'tab',
    maxAlignWidth: 150
});
```

未知 key、非法 enum/范围、Proxy、accessor 或 `null` options 返回 `failed`、`DDL_OPTIONS` 和完整原文。VS Code 的 DDL 命令沿用同一次 `sqlBeautify.keywordCase`、`sqlBeautify.commaStyle`、`sqlBeautify.indentStyle` 与 `sqlBeautify.maxAlignWidth` 配置解析。DDL 列名对齐使用 Unicode 17 display width；目标列超过 `maxAlignWidth` 或线性生成空白预算时只保留一个必要分隔空格，不再按最长名称产生乘法级输出。

完整消费的 `CREATE TABLE` 子集新增按固定顺序出现的可选 `PARTITIONED BY (...)` 和 `STORED AS <format>`。storage format 只允许 `AVRO`、`ORC`、`PARQUET`、`RCFILE`、`SEQUENCEFILE`、`TEXTFILE`。重复或乱序 suffix、未知 storage、`LOCATION`、`TBLPROPERTIES`、CTAS、约束、默认值、多 statement 或结构不完整输入继续整条 `preserved`，不会部分改写。

选区 DDL 格式化会继承首行缩进，只对 formatter 生成的空白应用文档 LF/CRLF 并清理 target 尾部水平空白。string、quoted identifier、parameter 和 comment 内部的 EOL、行尾空格及换行后字符逐 code-unit 保持原样，因此含多行 protected value 的 replacement 可以有意保留其原始 EOL。任一 target 不受支持、超过输出预算、失败、取消或过期时整批零提交。

`extractDdl(source, options?)` 的 options 现在与 formatter 一样要求 plain data：只接受可选 `defaultType`
data property，Proxy、accessor、symbol/未知 key、继承属性或 exotic prototype 返回 `EXTRACT_OPTIONS`，且不会
执行 getter/trap。`defaultType` 最长 128 个 UTF-16 code units，超限或 type shape 非法返回
`EXTRACT_DEFAULT_TYPE` 并保留输入。Extract DDL 同样使用 Unicode display width 与线性输出预算。

## Node.js consumers

公开入口保持为：

```js
const { formatSql, lexSql } = require('vscode-sql-beautify/formatter');
const { formatHiveDdl, extractDdl } = require('vscode-sql-beautify/experimental/ddl');
```

`formatSql()` 的 `formatted` / `unchanged` / `preserved` / `failed` 结果、524,288 个 UTF-16 code units 上限、verbatim 与 keywordCase 边界均保持不变。`extractDdl()` 继续不推断真实类型，未提供有界 `defaultType` 时使用 `__TYPE_REQUIRED__`。

生产 runtime 仍使用 `node:util/types.isProxy` 实施透明 Proxy 的 fail-closed 检测。2.2 的发布契约在 Node 20 和 Node 24 上同时加载 core、两个公开 facade 与 VS Code extension bundle；这不增加 browser runtime、package root export 或 internal `dist` export。

## 仍从 1.x 升级

1.x 的 `extension.beautifySql`、`extension.beautifySqlddl`、`extension.extractDdl` 已移除；请分别改为 `sqlBeautify.formatSql`、`sqlBeautify.formatHiveDdl`、`sqlBeautify.extractHiveDdl`。方言值 `postgres` 应改为 `postgresql`。

package root、`vkbeautify.js`、positional API、`lib/**` require 路径和 `extractddl()` 不会恢复。先应用 [2.0 迁移指南](migration-to-2.0.md) 的 breaking changes，再应用 [2.1 迁移指南](migration-to-2.1.md) 的输入与执行边界，最后应用本文的 2.2 行为变化。

## 回退

2.2 没有切换回旧 formatter 的兼容开关。若现有工作流依赖 2.1 的具体布局、固定 cancellation timing 或未披露的 DDL preserve 行为，请固定安装 `2.1.0` VSIX，并用最小 SQL 样本确认差异后再升级。回退不会恢复 1.x command、positional API 或 `postgres` alias。最低支持 VS Code 版本仍为 `1.90.0`。
