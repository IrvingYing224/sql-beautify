
## 😎 更迭日志 Release Notes

> 0.3.23 及以后版本由 [IrvingYing224](https://github.com/IrvingYing224) 维护。
>
> Versions 0.3.23 and later are maintained by [IrvingYing224](https://github.com/IrvingYing224).

### 1.0.0 (2026/06/06)
* 完成默认 SQL formatter 的结构化 pipeline 根治重构，主路径从旧字符串 pass 串联切换为 tokenizer 驱动的 `FormatDocument` / `ScopeModel` / `FormatNodes` / `MutationPlan` / `StructuredRenderer`
* 移除默认路径中的 legacy `formatterEngine` / `sqlFormatPipeline.run` 回流和 restore 后结构 pass，避免注释恢复后再次被当作真实 SQL 重排
* 将 SELECT / GROUP BY、CASE、condition、layout、keyword case 和 comment alignment 迁移为结构化 mutation pass，共用同一份 token、line、scope 和 node 事实源
* 新增 formatter invariant guard，保护注释、字符串、块注释、quoted identifier、opaque unsupported syntax 不进入 active SQL 结构节点或被 mutation 删除 / 改写
* 收紧 SELECT / GROUP BY separator ownership，逗号迁移只作用于明确 owner scope 的顶层 item separator，不再误碰 `IN (...)`、函数参数、window spec 或嵌套括号表达式
* 统一 CASE branch、condition block、右括号缩进和 comment alignment 的 scope ownership，修复 `CASE WHEN ... -- comment` 吞 `THEN`、`ON -- comment` 后首个条件缩进、条件 / SELECT 表达式右括号缩进等长期风险
* 扩展结构模型、invariant、differential、pipeline idempotency、performance smoke、module boundary、token boundary、Hive / DDL / unsupported safety 等回归覆盖，并纳入 `npm run test:verify`
* 将扩展版本提升至 `1.0.0`，本地 VSIX 打包产物对应 `vscode-sql-beautify-v1.0.0.vsix`
* Completed the root-cause structured pipeline rewrite for the default SQL formatter, replacing chained legacy string passes with tokenizer-driven `FormatDocument` / `ScopeModel` / `FormatNodes` / `MutationPlan` / `StructuredRenderer`
* Removed legacy `formatterEngine` / `sqlFormatPipeline.run` fallback from the default path and banned structural passes after restore so restored comments are not parsed as real SQL again
* Migrated SELECT / GROUP BY, CASE, condition, layout, keyword case, and comment alignment behavior to structured mutation passes that share one token, line, scope, and node fact source
* Added formatter invariant guards to keep comments, strings, block comments, quoted identifiers, and opaque unsupported syntax out of active SQL structure nodes and protected from deletion or rewriting
* Tightened SELECT / GROUP BY separator ownership so comma migration only touches top-level item separators with an explicit owner scope and no longer leaks into `IN (...)`, function arguments, window specs, or nested parenthesized expressions
* Unified scope ownership for CASE branches, condition blocks, closing-parenthesis indentation, and comment alignment, fixing long-standing risks around `CASE WHEN ... -- comment` swallowing `THEN`, `ON -- comment` first-condition indentation, and condition / SELECT expression closers
* Expanded structured model, invariant, differential, pipeline idempotency, performance smoke, module boundary, token boundary, Hive / DDL / unsupported safety coverage and included it in `npm run test:verify`
* Bumped the extension version to `1.0.0`; the local VSIX package now resolves to `vscode-sql-beautify-v1.0.0.vsix`

### 0.5.7 (2026/05/17)
* 修复 `SELECT` 后紧跟行尾注释时首个真实字段不参与 SELECT list 重排的问题，连续独立行注释不会再打断字段逗号和缩进状态
* 修复 Hive `--+` hint 被普通注释 spacing 改写成 `-- +` 的问题，避免 `MAPJOIN` 等 hint 失效
* 修复 `SELECT --+ ...` 后首个字段被错误补前导逗号或与后续字段错列的问题；首字段现在不显示逗号，但会保留逗号列占位以保持字段和 `AS` 对齐
* 修复 Hive 方括号索引表达式的 spacing，`matrix ['level' ]`、`tags [0 ]`、`matrix [ 'status' ]` 现在会格式化为紧凑的 `matrix['level']`、`tags[0]`、`matrix['status']`，并保留后续 alias
* 修复 Hive 增强聚合后缀被当成 `GROUP BY` 字段的问题，`WITH GROUPING SETS`、`WITH CUBE`、`WITH ROLLUP` 不再被补前导逗号
* 修复 SELECT / GROUP BY list 中独立单行注释丢失所在代码块缩进的问题，注释仍保持独立成行且不参与字段逗号状态
* 补充 SELECT header 注释、Hive `--+` hint、跨注释字段续接、独立单行注释缩进、Hive 方括号索引、Hive 增强聚合后缀和二次格式化幂等性回归覆盖
* Fixed SELECT-list formatting when `SELECT` is followed by a trailing line comment; standalone comment runs no longer break comma or indentation state for the first real item
* Fixed Hive `--+` hints being normalized to `-- +`, preserving hints such as `MAPJOIN`
* Fixed the first field after `SELECT --+ ...` receiving a leading comma or drifting out of column alignment; it now omits the comma while preserving the comma column for expression and `AS` alignment
* Fixed spacing for Hive bracket index expressions so `matrix ['level' ]`, `tags [0 ]`, and `matrix [ 'status' ]` format compactly as `matrix['level']`, `tags[0]`, and `matrix['status']` while preserving aliases
* Fixed Hive enhanced aggregation suffixes being treated as `GROUP BY` fields; `WITH GROUPING SETS`, `WITH CUBE`, and `WITH ROLLUP` no longer receive a leading comma
* Fixed standalone line comments inside SELECT / GROUP BY lists losing the surrounding code-block indentation while keeping them independent from field comma state
* Added regression coverage for SELECT header comments, Hive `--+` hints, field continuation across comments, standalone comment indentation, Hive bracket indexes, Hive enhanced aggregation suffixes, and idempotent reformatting

### 0.5.6 (2026/05/17)
* 将 `sqlBeautify.indentStyle` 默认值从 `tab` 改为 `space`
* 将 `sqlBeautify.dialect` 默认值从 `generic` 改为 `hive`，让默认格式化路径与 Hive-first 定位一致
* 将 `INTERSECT` / `EXCEPT` 纳入 Hive clause registry，避免默认 Hive dialect 下 set operation 不拆行
* 同步 README 配置表、generated support matrix 和相关配置 / pipeline 回归覆盖
* Changed the default `sqlBeautify.indentStyle` from `tab` to `space`
* Changed the default `sqlBeautify.dialect` from `generic` to `hive` so the default formatter path matches the Hive-first positioning
* Added `INTERSECT` / `EXCEPT` to the Hive clause registry so set operations still split correctly under the default Hive dialect
* Updated the README configuration table, generated support matrix, and focused config / pipeline regression coverage

### 0.5.5 (2026/05/17)
* 修复 Hive DDL 字段拆分对反引号列名、复杂类型逗号、括号和尖括号的边界处理，避免 `` `a,b` ``、`` `a)b` ``、`MAP<STRING,STRING>`、`STRUCT<...>` 等结构被拆坏
* 增强 `extractddl` 的顶层 `UNION` / `UNION ALL` 处理：字段形状一致时提取 schema，不一致时返回空，避免输出误导性字段；生成的 Hive `COMMENT` 字面量现在会转义双引号、反斜杠和换行
* 允许完整 `WITH` / `WITH RECURSIVE` 选区格式化，同时继续拒绝非整行、结构不完整和 continuation-only 片段
* 修复 VS Code 配置读取未绑定文档 URI 的问题，多工作区和 resource-scoped `sqlBeautify.*` 设置现在按目标文档解析
* 收紧 `unsupportedSyntaxPolicy` 的可见语义：新增轻量低置信语法检测，`QUALIFY` / `PIVOT` / `MERGE` 等只在真实语法上下文触发，不再误杀普通字段名、别名或 `WHERE` 表达式函数
* 引入 shared format model，减少 comment / condition / layout pass 的重复 tokenization，并新增 performance smoke 作为主回归的一部分
* 加固 GitHub Actions VSIX workflow：PR / main push 也执行打包 smoke，手动 release 限制在 `main`，并校验已有 tag target，兼容 annotated tag 和 lightweight tag
* 更新 README 的 experimental 边界说明、formatter 架构文档、生成的 support matrix 和相关回归覆盖
* Fixed Hive DDL field splitting around backtick identifiers, commas inside complex types, parentheses, and angle brackets so structures such as `` `a,b` ``, `` `a)b` ``, `MAP<STRING,STRING>`, and `STRUCT<...>` are preserved
* Improved `extractddl` for top-level `UNION` / `UNION ALL`: consistent branch shapes are extracted, mismatched schemas return empty output, and generated Hive `COMMENT` literals now escape quotes, backslashes, and newlines
* Allowed complete `WITH` / `WITH RECURSIVE` range formatting while continuing to reject partial-line, structurally incomplete, and continuation-only fragments
* Fixed VS Code configuration lookup to use the target document URI so multi-root and resource-scoped `sqlBeautify.*` settings resolve correctly
* Tightened `unsupportedSyntaxPolicy` semantics with a lightweight low-confidence syntax detector; `QUALIFY`, `PIVOT`, and `MERGE` now trigger only in real syntax contexts instead of ordinary identifiers, aliases, or `WHERE` expression functions
* Added a shared format model to reduce repeated tokenization across comment, condition, and layout passes, plus a performance smoke check in the main regression suite
* Hardened the GitHub Actions VSIX workflow so PR / main push runs packaging smoke, manual releases are limited to `main`, and existing tag targets are validated for both annotated and lightweight tags
* Updated README experimental boundaries, formatter architecture docs, the generated support matrix, and focused regression coverage

### 0.5.3 (2026/05/17)
* Breaking cleanup：移除全部旧 `extension.*` 配置项，VS Code 侧只保留 `sqlBeautify.*`
* `unsupportedSyntaxPolicy=warn` 现在具有真实行为：保留未建模片段并通过 VS Code warning 暴露诊断
* 命令式选区格式化与标准 range formatter 统一走 range safety，拒绝不完整片段
* 继续推进 token-aware primitive 和 dialect capability 在 `CASE` / condition / comment 路径中的贯穿
* 统一输出空白契约：LF、最多单个空行、单尾换行
* 收紧 README 到最终用户手册边界，并把支持边界、experimental 说明、diagnostics 契约收回技术文档与 support matrix
* Breaking cleanup: removed all legacy `extension.*` settings so the VS Code configuration surface is now `sqlBeautify.*` only
* `unsupportedSyntaxPolicy=warn` now has real behavior by preserving unmodeled fragments and surfacing a VS Code warning
* Command-driven selection formatting now shares the same range-safety gate as the standard range formatter and rejects incomplete fragments
* Continued the token-aware primitive and dialect-capability rollout through `CASE`, condition, and comment paths
* Unified the whitespace output contract around LF, at most one blank line, and a single trailing newline
* Tightened the README back to an end-user manual and moved support-boundary, experimental-scope, and diagnostics contract detail into technical docs and the support matrix

### 0.5.4 (2026/05/17)
* 修复一元正负号在主格式化链中的 spacing 错误，`THEN -1`、`a=-1`、`a=+1`、`1*-1`、`1/-1` 不再被错误改写为 `- 1`、`=+ 1`、`*- 1` 等无效形式
* 增加 `CASE`、条件表达式和算术表达式中一元 `+/-` 的回归覆盖，确保二元运算符 spacing 与 Postgres / MySQL 特殊运算符行为不回归
* Fixed unary plus/minus spacing in the main formatter path so expressions such as `THEN -1`, `a=-1`, `a=+1`, `1*-1`, and `1/-1` are no longer rewritten into invalid forms like `- 1`, `=+ 1`, or `*- 1`
* Added regression coverage for unary `+/-` in `CASE`, condition expressions, and arithmetic expressions to protect normal binary spacing and dialect-specific operators from regression

### 0.5.2 (2026/05/17)
* 将核心 SQL formatter 进一步收敛为 canonical options + dialect/clause/operator registry + structured pipeline，减少对历史字符串熔炉 pass 的依赖
* 将 `SELECT` / condition / `CASE` / comment 的职责边界拆开，主流程改为显式结构化 pass，而不是继续在 `special_wrap` / `condition_wrap` 之类混合逻辑里叠规则
* 收紧 unsupported 行为：`MATCH_RECOGNIZE(...)` 等未建模结构优先保守保护，不再尝试高风险重排
* 将 unsupported opaque 保护前移到 lexical normalize 之前，确保 `MATCH_RECOGNIZE(...)` 等未建模子句内部不会被关键字大小写、operator spacing 或 clause split 提前改写
* 重写 `extractddl` 的高置信提取策略：显式 alias 和简单列引用可提取，复杂无 alias 表达式直接跳过，不再猜 `b` / `concat` / `end` 这类误导性列名
* 移除 `String.prototype.times` 全局污染和一批无调用面死代码，明确 module boundary
* 彻底将 `replace_char`、`condition_wrap`、`except_subquery`、`bracket_deep`、`extra` 等旧熔炉 / 状态机从 live formatter path 移除，并用依赖图级 module-boundary 测试防止间接回流
* 新增 `operator-matrix`、`clause-registry`、`select-alignment`、`condition-alignment`、`extractddl-safety`、`unsupported-safety` 等 focused regression tests，并将其纳入 `npm run test:verify`
* 更新 README 的用户说明，收敛技术实现细节，明确 Hive SQL 优先、其他方言建议人工复核，以及 DDL / Extract DDL 仍属 experimental
* Further restructured the core formatter around canonical options, dialect/clause/operator registries, and a structured pipeline instead of continuing to grow legacy string-melting passes
* Split responsibilities for `SELECT`, condition blocks, `CASE`, and comments into explicit passes rather than mixed `special_wrap` / `condition_wrap` behavior
* Tightened unsupported behavior so unmodeled syntax such as `MATCH_RECOGNIZE(...)` is handled conservatively instead of being aggressively rewritten
* Moved unsupported opaque protection ahead of lexical normalization so unmodeled clauses such as `MATCH_RECOGNIZE(...)` are preserved before keyword casing, operator spacing, or clause splitting can rewrite them
* Reworked `extractddl` into a high-confidence extractor: explicit aliases and simple column references are kept, while complex alias-free expressions are skipped rather than guessed into misleading column names
* Removed `String.prototype.times` global pollution and other dead code while tightening module boundaries
* Fully removed legacy `replace_char`, `condition_wrap`, `except_subquery`, `bracket_deep`, and `extra` from the live formatter path, and added dependency-graph module-boundary checks to prevent indirect regressions
* Added focused regression coverage for operator matrices, clause registries, select alignment, condition alignment, extractddl safety, and unsupported-syntax safety
* Refreshed the README for end users by removing implementation-heavy details and clarifying Hive-first guidance, manual review expectations for other dialects, and the experimental scope of DDL / Extract DDL

### 0.5.1 (2026/05/16)
* 将 `vkbeautify.js` 拆为轻量 wrapper，并把 SQL 格式化、注释处理、大小写转换、SELECT 对齐、条件对齐、DDL、方言边界和格式化上下文拆入 `lib/` 下的独立 CommonJS 模块
* 修复内部占位符与用户 SQL 文本碰撞的问题，避免 `NEEDReplace`、`--{LC0}`、`{SQLSETPAYLOAD0}`、`{SQLSTANDALONECOMMENT0}` 等 marker-like 文本被错误恢复或污染
* 增加 PostgreSQL dollar quote、PostgreSQL JSON `->>`、MySQL `#` 注释等 best-effort 方言边界保护；Hive SQL 仍是主要支持目标
* 新增 `sqlBeautify.*` 配置命名空间，同时保留 `extension.*` 兼容；显式优先级为 `sqlBeautify.*` > `extension` semantic settings > legacy fallback > package defaults
* 增加现代命令别名 `sqlBeautify.formatSql`、`sqlBeautify.formatHiveDdl`、`sqlBeautify.extractHiveDdl`，并保留旧 `extension.*` 命令 ID
* 强化 VS Code 标准 `Format Document` / `Format Selection`、多选区格式化、重叠选区拒绝和 edit 失败错误提示
* 重构 `extractddl` 的 SELECT 字段提取逻辑，修复 INSERT 目标表被当作列、CTE 内部字段污染、字符串内 `--`、CASE 字符串、函数参数逗号、`a < b` 比较表达式等场景
* 明确 `sqlddl` / `extractDdl` 仍为 Hive SQL experimental 能力；`extractDdl` 是有限 SELECT 列提取工具，不是完整 SQL parser，不推断真实字段类型
* 现代化测试、CI 和本地 VSIX 打包链路，改用 `npm ci`、项目本地 `@vscode/vsce` / `@types/vscode`，并将最低 VS Code engine 提升到 `^1.90.0`
* 更新 VSIX 清单排除规则，避免把 `.github/`、测试、计划文档、`node_modules/` 和本地 `.vsix` 制品打进发布包
* 补充 placeholder collision、dialect boundary、formatter API、module boundary、extension mock、配置优先级、DDL / extract DDL 风险场景等回归测试，并纳入 `npm run test:verify`
* Split `vkbeautify.js` into a thin wrapper and moved SQL formatting, comments, keyword casing, SELECT alignment, condition alignment, DDL, dialect boundaries, and formatting context into focused CommonJS modules under `lib/`
* Fixed internal placeholder collisions with marker-like user SQL text such as `NEEDReplace`, `--{LC0}`, `{SQLSETPAYLOAD0}`, and `{SQLSTANDALONECOMMENT0}`
* Added best-effort dialect boundary protection for PostgreSQL dollar quotes, PostgreSQL JSON `->>`, and MySQL `#` comments while keeping Hive SQL as the primary target
* Added the `sqlBeautify.*` configuration namespace while preserving `extension.*` compatibility
* Added modern command aliases while preserving legacy `extension.*` command IDs
* Hardened standard VS Code document/range formatting, multi-selection formatting, overlapping selection rejection, and edit failure reporting
* Reworked `extractddl` SELECT item extraction to avoid INSERT target, CTE, string/comment, function comma, CASE string, and `a < b` comparison contamination
* Clarified that `sqlddl` / `extractDdl` remain experimental Hive SQL features; `extractDdl` is a limited SELECT column extractor, not a full SQL parser, and does not infer real column types
* Modernized test, CI, and local VSIX packaging with `npm ci`, project-local `@vscode/vsce` / `@types/vscode`, and the `^1.90.0` VS Code engine baseline
* Updated VSIX packaging exclusions for `.github/`, tests, planning docs, `node_modules/`, and local `.vsix` artifacts
* Added placeholder collision, dialect boundary, formatter API, module boundary, extension mock, config precedence, and DDL / extract DDL regression coverage to `npm run test:verify`

### 0.5.0 (2026/05/16)
* 增强 token 边界保护，`/* ... */` 块注释、反引号标识符、反斜杠转义字符串和双单引号字符串不再被当作真实 SQL 结构重排或改写大小写
* 修复 shield 占位符与用户 SQL 标识符冲突的问题，并保持独立行块注释不被并入上一行
* 用 tokenizer-based shield 替换 `vkbeautify.sql(...)` 主路径中的旧字符串保护入口，并拆出 `sql-shield`、`sql-render-options`、`sql-format-pipeline` 以收敛格式化流程
* 补齐 VS Code 命令贡献项和命令激活事件，并注册标准 `Format Document` / `Format Selection` formatter；格式化异常时显示错误且不替换原文
* 新增语义化配置 `extension.keywordCase`、`extension.commaStyle`、`extension.indentStyle`、`extension.maxAlignWidth`，同时保留旧配置兼容；新配置仅在显式设置时覆盖旧配置
* 将 `sqlddl` / `extractDdl` 标注为 Hive DDL experimental，并修复 DDL 中 `DECIMAL(18,2)`、`ARRAY<STRING>`、`MAP<STRING,STRING>`、`STRUCT<...>` 和 `COMMENT` 内逗号的基础保留问题
* 新增 token 边界、VS Code 贡献、配置映射、pipeline 幂等性和 DDL 风险隔离回归测试，并纳入 `npm run test:verify`
* Hardened token boundaries so `/* ... */` block comments, backtick quoted identifiers, backslash-escaped strings, and doubled-quote strings are no longer reformatted or recased as real SQL
* Fixed shield placeholder collisions with user SQL identifiers and kept standalone block comments on their own lines
* Replaced the old string protection entry in the main `vkbeautify.sql(...)` path with tokenizer-based shielding, and introduced `sql-shield`, `sql-render-options`, and `sql-format-pipeline`
* Added missing VS Code command contributions and command activation events, and registered standard `Format Document` / `Format Selection` providers; formatter errors now show a message without replacing source text
* Added semantic settings `extension.keywordCase`, `extension.commaStyle`, `extension.indentStyle`, and `extension.maxAlignWidth` while preserving legacy settings; new settings override legacy settings only when explicitly configured
* Marked `sqlddl` / `extractDdl` as experimental Hive DDL features and fixed basic preservation for `DECIMAL(18,2)`, `ARRAY<STRING>`, `MAP<STRING,STRING>`, `STRUCT<...>`, and commas inside `COMMENT`
* Added token-boundary, VS Code contribution, config mapping, pipeline idempotency, and DDL risk-isolation regression tests to `npm run test:verify`

### 0.4.4 (2026/05/16)
* 修复独立行注释后紧跟 `DROP TABLE` 时，`DROP` 行前被错误保留一个空格的问题
* 调整独立行注释保护占位符，避免被后续格式化流程误判为行尾注释
* 补充独立行注释后接 `DROP TABLE` 的回归覆盖
* Fixed an extra leading space being kept before `DROP TABLE` when it follows a standalone line comment
* Adjusted the standalone line-comment placeholder so later formatting stages no longer treat it as a trailing comment
* Added regression coverage for standalone line comments followed by `DROP TABLE`

### 0.4.3 (2026/05/13)
* 修复连续 Hive `SET` 配置语句格式化后被合并成一行的问题
* 保持 `SET hive.exec.dynamic.partition=true;` 和 `SET hive.exec.dynamic.partition.mode=non-strict;` 这类连续配置语句分行输出
* 补充连续 Hive `SET` 配置语句的回归覆盖
* Fixed consecutive Hive `SET` config statements being merged into one line after formatting
* Kept statements such as `SET hive.exec.dynamic.partition=true;` and `SET hive.exec.dynamic.partition.mode=non-strict;` on separate output lines
* Added regression coverage for consecutive Hive `SET` config statements

### 0.4.2 (2026/05/13)
* 修复 Hive `SET hive.exec.dynamic.partition = true;` 中配置键和值被错误当作 SQL 关键字大写的问题
* 修复 `t.partition`、`t.true`、`db.table` 等点号限定标识符中的关键字片段被误改写的问题
* 保持 `PARTITION(...)`、`PARTITION BY`、`TRUE` / `FALSE` / `NULL` 等真实 SQL 语法关键字和常量的现有大小写转换行为
* 补充 Hive `SET` 配置和点号限定标识符的回归覆盖
* Fixed Hive `SET hive.exec.dynamic.partition = true;` config keys and values being incorrectly uppercased as SQL keywords
* Fixed keyword-like parts inside dotted identifiers such as `t.partition`, `t.true`, and `db.table` being rewritten
* Preserved existing keyword casing for real SQL syntax such as `PARTITION(...)`, `PARTITION BY`, and `TRUE` / `FALSE` / `NULL`
* Added regression coverage for Hive `SET` configs and dotted identifiers

### 0.4.1 (2026/04/28)
* 修复字段名局部包含 SQL 关键字时误触发结构格式化的问题，例如 `WITHRI_SITU_CD`、`JOINER_CD`、`FROM_ACCT_CD`、`ORDER_BY_FLAG`
* 收紧括号拆行、`ORDER BY`、语句起始识别和 `extractddl` 中的关键字判断，统一使用单词边界或行首匹配，避免字段名子串被当成真实 SQL 关键字
* 补充连续 `CASE WHEN` 字段前存在关键字前缀字段名的回归覆盖
* Fixed structural formatting being triggered by SQL keyword substrings inside column names, such as `WITHRI_SITU_CD`, `JOINER_CD`, `FROM_ACCT_CD`, and `ORDER_BY_FLAG`
* Tightened keyword detection for bracket wrapping, `ORDER BY`, statement starts, and `extractddl` with word-boundary or line-start matching
* Added regression coverage for consecutive `CASE WHEN` columns following keyword-like column names

### 0.4.0 (2026/04/28)
* 重构 SQL / Hive SQL 格式化核心，新增 token 化、结构识别和行模型，减少正则、占位符和全局状态导致的互相污染
* 将 `--` 行注释和单双引号字符串作为不可格式化内容处理，注释或字符串内的 `CASE` / `WHEN` / `THEN` / `FROM` / 逗号不再被识别为真实 SQL
* 重写 `CASE` 解析与渲染，支持多行 `WHEN`、`IN (...)` 列表、`THEN` / `ELSE` 后接行尾注释、注释掉的分支和嵌套 `CASE`
* 重写行尾注释对齐分组，顶层 `SELECT` 字段、`CASE` 内部、括号列表和 `WHERE` / `ON` / `HAVING` 条件分别对齐，避免跨作用域拉长
* 将关键词大小写转换迁移到 token 层，只转换真实 SQL keyword，不修改字符串、注释和占位符内容
* 保持 `vkbeautify.sql(...)`、`vkbeautify.sqlddl(...)`、`vkbeautify.extractddl(...)`、VS Code 命令 ID 和配置项兼容
* 补充并更新 `CASE WHEN`、注释隔离、字符串隔离、AS 对齐、Hive SQL 和注释分组回归测试
* Refactored the SQL / Hive SQL formatting core with tokenization, structure recognition, and a line model to reduce cross-contamination from regexes, placeholders, and global state
* Treats `--` line comments and quoted strings as opaque content, so SQL-like words and punctuation inside them are no longer formatted as real SQL
* Reworked `CASE` parsing and rendering for multiline `WHEN`, `IN (...)` lists, comments after `THEN` / `ELSE`, commented-out branches, and nested `CASE`
* Reworked trailing comment alignment by scope: top-level `SELECT` items, `CASE` internals, parenthesized lists, and `WHERE` / `ON` / `HAVING` conditions are aligned separately
* Moved keyword casing to the token layer so only real SQL keywords are converted
* Preserved compatibility for public APIs, VS Code command IDs, and existing configuration keys
* Added and updated regression coverage for `CASE WHEN`, comments, strings, AS alignment, Hive SQL, and scoped comment alignment

### 0.3.32 (2026/04/27)
* 修复了多行 `CASE WHEN ... IN (...)` 条件中的列表项和行尾注释被错误合并、截断或改写的问题
* 修复了 `CASE` 字段内部 `IN (...)` 列表注释被外层 `SELECT` 字段注释拉长对齐的问题
* 修复了 `-- ,'ABC'` 等注释内容被继续格式化，以及 `) -- comment` 后的 `THEN` 被注释吞掉的问题
* 修复了 `CASE` 内注释掉的单行和多行 `WHEN` / `THEN` 分支被删除的问题
* 补充了 `CASE WHEN`、列表注释、注释掉分支和注释对齐的回归覆盖
* Fixed multiline `CASE WHEN ... IN (...)` list items and trailing comments being incorrectly merged, truncated, or rewritten
* Fixed comments inside `CASE` field `IN (...)` lists being aligned with outer `SELECT` field comments
* Fixed comment text such as `-- ,'ABC'` being reformatted and `THEN` after `) -- comment` being swallowed by the comment
* Fixed commented-out single-line and multi-line `WHEN` / `THEN` branches inside `CASE` being dropped
* Added regression coverage for `CASE WHEN`, list comments, commented-out branches, and comment alignment

### 0.3.31 (2026/04/24)
* 修复了整行注释中的 `IN (SELECT ...)` / `EXISTS (SELECT ...)` 被错误拆成非注释 SQL 的问题
* 修复了行内注释包含第二个 `--`、`${...}` 变量或位于 `FROM` / `AND` 后方时被继续格式化的问题
* 修复了字段列表中穿插整行注释后，前后字段行尾注释不再对齐的问题
* 补充了注释子查询、行内注释尾部和穿插注释字段列表的回归覆盖
* Fixed standalone comments containing `IN (SELECT ...)` / `EXISTS (SELECT ...)` being incorrectly reformatted as active SQL
* Fixed inline comments containing a second `--`, `${...}` variables, or comments after `FROM` / `AND` being reformatted further
* Fixed trailing comment alignment when commented-out select items appear between active select fields
* Added regression coverage for commented subqueries, inline comment tails, and select lists with commented-out items

### 0.3.30 (2026/04/24)
* 修复了 Hive SQL 中 `LEFT SEMI JOIN` / `LEFT ANTI JOIN` 被错误拆行的问题
* 补充了 `SORT BY`、`CLUSTER BY`、`EXISTS`、`INTERSECT`、`EXCEPT` 和常见 Hive 关键字的大写与格式化支持
* 修复了 `GROUPING SETS` 前出现孤立逗号、`POSEXPLODE(...)` 被误拆行的问题
* 修复了独立行 `-- AND` 等注释泄漏 `iscomment`，以及行尾注释后续 `AND` 不继续换行的问题
* 精简了 VS Code 命令处理逻辑，并补充 Hive 关键字、注释和条件换行回归覆盖
* Fixed incorrect wrapping of `LEFT SEMI JOIN` / `LEFT ANTI JOIN` in Hive SQL
* Added uppercase and formatting support for `SORT BY`, `CLUSTER BY`, `EXISTS`, `INTERSECT`, `EXCEPT`, and common Hive keywords
* Fixed stray comma output before `GROUPING SETS` and incorrect wrapping of `POSEXPLODE(...)`
* Fixed `iscomment` leakage for standalone comments such as `-- AND` and continued `AND` wrapping after trailing comments
* Simplified VS Code command handling and added regression coverage for Hive keywords, comments, and condition wrapping

### 0.3.29 (2026/04/24)
* 修复了 `WHERE` / `HAVING` 条件中的 `CASE WHEN` 误插入 `THEN AND`，并统一了多行 `CASE` 条件块的 `CASE` / `END` 缩进
* 统一了 `extension.as_loc_cnt` 对顶层别名 `AS` 与行尾注释的宽度判定，避免出现 `AS` 仍对齐但注释提前失去对齐的情况
* 更新了 `extension.as_loc_cnt` 的配置说明，并补充了 `CASE WHEN`、注释对齐、Hive SQL 的回归覆盖
* Fixed the `THEN AND` corruption in `CASE WHEN` expressions inside `WHERE` / `HAVING` clauses and unified `CASE` / `END` indentation for multi-line conditional CASE blocks
* Unified the width threshold logic controlled by `extension.as_loc_cnt` for both top-level alias `AS` alignment and trailing comment alignment
* Updated the `extension.as_loc_cnt` setting description and added regression coverage for `CASE WHEN`, comment alignment, and Hive SQL

### 0.3.28 (2026/04/23)
* 统一了 `ON` / `WHERE` / `HAVING` 条件子句中顶层 `AND` / `OR` 的换行与尾部对齐
* 修复了 `JOIN ... ON` 后续条件不换行、`WHERE` 中 `OR` 不换行以及条件续行缩进不一致的问题
* 保留 `BETWEEN ... AND ...`、`IN(...)`、`IF(...)` 和括号内布尔表达式的原有格式，避免误拆嵌套条件
* Unified wrapping and keyword-tail alignment for top-level `AND` / `OR` in `ON`, `WHERE`, and `HAVING` clauses
* Fixed missing wraps after `JOIN ... ON`, missing `OR` wraps in `WHERE`, and inconsistent indentation for continued conditions
* Preserved existing formatting for `BETWEEN ... AND ...`, `IN(...)`, `IF(...)`, and parenthesized boolean expressions to avoid incorrect nested-condition splits

### 0.3.27 (2026/04/23)
* 修复了多行 `CASE` 在 `SELECT` / `CTE` 中与 `AS`、行尾注释的对齐问题
* 修复了同层 `SELECT/JOIN/WHERE/HAVING` 与子查询场景下的 `--` 注释分组对齐
* 支持将 `HAVING` / 单行表达式中的 `CASE ... END` 转为大写并按块格式化
* 修复了顶层别名 `AS` 被 `cast(... AS string)` 等内部 `AS` 误参与对齐的问题，同时保留 `CASE` 代码块与别名列的视觉分区
* 新增长期回归验证入口 `npm run test:verify`
* Fixed `AS` and trailing comment alignment for multi-line `CASE` in `SELECT` and `CTE`
* Fixed grouped `--` comment alignment across same-level `SELECT/JOIN/WHERE/HAVING` blocks and subqueries
* Added block formatting for inline `CASE ... END` expressions in clauses such as `HAVING`
* Prevented top-level alias alignment from being affected by inner `AS` usages like `cast(... AS string)` while keeping visual separation between `CASE` blocks and aliases
* Added the long-term regression verification entry `npm run test:verify`

### 0.3.26 (2026/04/22)
* 修复了 `SELECT` 中多行 `CASE` 参与 `AS` 和行尾注释对齐时的异常
* 将 `AS` 与 `--` 对齐规则调整为保留整列对齐，同时让最长项的最短间隔保持为 1 个空格
* Fixed incorrect `AS` and trailing comment alignment when multi-line `CASE` expressions appear in `SELECT`
* Kept column alignment while reducing the minimum gap before `AS` and `--` to a single space on the widest item

### 0.3.25 (2026/04/21)
* 深度优化了 `CASE WHEN` 的对齐和换行逻辑
* 确保多 `WHEN` 情况下的 `THEN` 关键字纵向对齐
* 强制 `ELSE` 和 `END` 换行，并对齐 `ELSE` 的结果值
* Deeply optimized the alignment and line-wrapping logic of `CASE WHEN`
* Ensured the `THEN` keywords are vertically aligned in multi-`WHEN` scenarios
* Forced `ELSE` and `END` to wrap to new lines and aligned the result values of `ELSE`

### 0.3.24 (2026/04/17)
* 修复了独立行注释被错误合并和对齐的 BUG
* Fix the bug where standalone comment lines were incorrectly merged and aligned

### 0.3.23 (2026/04/17)
* 优化了 '--' 注释的对齐功能
* 确保 '--' 注释符号与内容之间有一个空格
* Optimize the alignment of '--' comments
* Ensure there is a space between the '--' symbol and the comment content

### 0.3.22 (2023/08/26)
* 修正了一些BUG
* FIx some bugs

### 0.3.20 (2023/07/25)
* 修正了关键词小写转换bug@lpy1997c
* FIx [the bug of lowercase](https://github.com/clarkyu2016/sql-beautify/issues/47) @lpy1997c
* SQL中lambda表达式中的-> 中间添加空格@MuRo-J
* FIx [the bug of lambda expression](https://github.com/clarkyu2016/sql-beautify/issues/51) @MuRo-J

### 0.3.17 (2023/03/14)
* 修正了字段中的select会被分行@maohr
* FIx [the bug of Select](https://github.com/clarkyu2016/sql-beautify/issues/49) @maohr

### 0.3.16 (2022/11/21)
* 合并了@fourgold的Pull，优化了强制转换关键词为小写的体验
* Merge [Fourgold's Pull](https://github.com/clarkyu2016/sql-beautify/pull/46) @fourgold

### 0.3.13 (2022/06/15)
* 修正了注释下面接with语句的格式化问题@BryceQin
* FIx [the bug of COMMENT and With](https://github.com/clarkyu2016/sql-beautify/issues/40) @BryceQin
* 修正了DDL中表名带有特定关键字时会出现错误@YouboFAN
* FIx [the bug of DDL with keywords](https://github.com/clarkyu2016/sql-beautify/issues/39) @YouboFAN
* 修正了:= 会被添加空格导致失效@lpzzz
* FIx [the bug of :=](https://github.com/clarkyu2016/sql-beautify/issues/38) @lpzzz

### 0.3.9 (2022/05/27)
* 调整了引号内的格式化逻辑，修正以前的错误问题(看起来很难遇到的[“大优化”](https://github.com/clarkyu2016/sql-beautify/wiki/%E5%BC%80%E5%8F%91%E6%97%A5%E5%BF%97%EF%BC%88%E4%B8%AD%E6%96%87%EF%BC%89#%E6%96%B0%E5%A2%9E%E4%BA%86%E5%AF%B9%E5%BC%95%E5%8F%B7%E5%86%85%E5%AD%97%E7%AC%A6%E4%B8%8D%E6%93%8D%E4%BD%9C%E7%9A%84%E9%80%BB%E8%BE%91-20220527))
* Adjusted logic for formatting "string" inside quotes

### 0.3.6 (2022/05/17)
* 修复了一些错误，感谢@BryceQin, @timegambler和@thx-god
* Fixed some bugs,Thanks for @BryceQin, @timegambler and @thx-god

### 0.3.5 (2022/02/23)
* 感谢[@fourgold](https://github.com/fourgold)新增了两个功能,在小写模式开启下：where后面and和on的对齐，以及注释的对齐
* Thanks for [@fourgold](https://github.com/fourgold) to add new functions and let SQL Beuatify can order the comment and insert indents before 'and' and 'on'
* 再次修复了小写关键词设置下对某些字段名的错误小写
* Fixed some bugs when using lowercase keywords.

### 0.3.0 (2023/01/29)
* 修复了小写关键词设置下对某些字段名的错误小写
* Fixed some bugs when using lowercase keywords.@ljfre
* 感谢@italodamato 修复了"Extension 'SQL Beautify' is configured as formatter but it cannot format 'SQL'-files" 的问题
* Thanks for @italodamato to fixed the bug "Extension 'SQL Beautify' is configured as formatter but it cannot format 'SQL'-files" 
* 祝大家2022年新年快乐！

### 0.2.8 (2021/11/01)
* 修复了一些带有注释的问题，包括注释后面重新逗号和括号以及复原的问题
* Fixed some bugs with "Comments".
* 修复了一个ddl美化的bug
* Fixed [a ddl bug](https://github.com/clarkyu2016/sql-beautify/issues/16) @xubuild
* 修复了一些其他的bug
* Fixed some bugs @rongsheng @zhangzhe @wuhuanzi

### 0.2.4 (2021/07/14)
* 删除了每行末尾不必要的空格
* delete [the whitespace character at the end of line](https://github.com/clarkyu2016/sql-beautify/issues/4) @Geek-Roc
* 修复了一些带有注释的问题
* Fixed some bugs with "Comments".

### 0.1.39 (2021/07/14)
* 支持了"With...as..."的格式化
* Support sql with "With...as..."
* fix some bugs @sakura

### 0.1.36 (2021/06/24)
* 修复了一些带有注释的问题
* Fixed some bugs with "Comments".
* 如果你的代码中有很多非常规的注释，请小心使用本插件，可能会有些未知的错误
* If you have many irregular comments in your code, please be careful when use sql-beautify, which may cause some unknown bugs.


### 0.1.32
* Fixed some bugs with "Comments".

### 0.1.32
* Add "Use whitespace to replace Tab in the indentation of subquery" setting.

![tablevswhitespace](https://clarkyu1993.coding.net/p/tuku/shared-depot/pic/git/raw/master/tablevswhitespace.png?raw=true)

* 端午节快乐！

### 0.1.30
* Add comma location setting.

![comma](https://clarkyu1993.coding.net/p/tuku/shared-depot/pic/git/raw/master/comma.png?raw=true)

### 0.1.28

* fix [the bug of COMMENT](https://github.com/clarkyu2016/sql-beautify/issues/4) @LiHaoyu1994 

### 0.1.28

* fix [the bug of COMMENT](https://github.com/clarkyu2016/sql-beautify/issues/3) @aleegreat 

### 0.1.24

* add hive-sql format support

### 0.1.22

* fix some bugs

### 0.1.21

* Add Uppercase setting. You can choose convert key words to uppercase or lowercase.(Default is Uppercase)

### 0.1.15

* Add ddl extract.

### 0.1.13

* Fix some bugs of ddl beautify.

### 0.1.8

* Fix `order by` auto-wrap when `order by` in special hql syntax like `row number() over(partition by order by)`

### 0.1.7

* Align words after `as` left

![as](https://clarkyu1993.coding.net/p/tuku/shared-depot/pic/git/raw/master/as.gif?raw=true)

### 0.0.12
* Fix some bugs of auto-wrap

### 0.0.9
* Support `CASE WHEN` auto-wrap

### 0.0.7
* Add beautify ddl

### 0.0.4

* Fix some bugs

### 0.0.1

* Initial release
