# 仓库指南

## 项目结构与模块组织
该仓库是一个用于格式化 SQL 和 Hive SQL 的小型 VS Code 扩展。核心运行时代码位于 `extension.js`，负责注册编辑器命令、标准 formatter 入口并读取扩展设置。格式化入口仍位于 `vkbeautify.js`，但 SQL token、结构识别、关键词大小写、行模型、不可改写内容保护、配置归一化和格式化 pipeline 等支撑逻辑位于 `lib/` 下的 CommonJS 模块。扩展元数据、命令和配置项定义在 `package.json` 中。文档位于 `README.md` 和 `CHANGELOG.md`。图标和演示图片等静态资源位于 `images/`。打包后的 `.vsix` 文件可能会出现在仓库根目录中用于手动验证，但不应提交到版本控制。

## 构建、测试与开发命令
- `npm install`：安装依赖，并运行适用于 VS Code 扩展环境的 `postinstall` 钩子。
- `code .`：在 VS Code 中打开该项目进行开发。
- 在 VS Code 中按 `F5`：启动 Extension Development Host，并以交互方式测试命令。
- `npm run test:verify`：运行长期回归集，覆盖注释对齐、`CASE WHEN`、Hive SQL、token 边界、VS Code 贡献、配置映射、pipeline 幂等性和 DDL 风险隔离场景。
- GitHub Actions `Build VSIX`：推送版本和文档更新后，通过远端 workflow 构建 `.vsix` 并发布 Release 供手动验证。

该仓库已有轻量 CLI 回归集。格式化逻辑变更至少运行 `npm run test:verify`；需要安装包验证时，优先通过 GitHub Actions 生成 `.vsix`，再从 GitHub Releases 下载安装测试。

## 编码风格与命名约定
遵循 `extension.js` 和 `vkbeautify.js` 中现有的 JavaScript 风格：4 空格缩进、使用分号，以及基于 `var` 的 CommonJS 模块写法。保持命令 ID 和配置键与 `package.json` 中已经使用的 `extension.*` 命名空间一致。优先对格式化逻辑做小而集中的修改，除非是有意变更，否则应保持 Hive SQL 的当前行为不变。

SQL / Hive SQL 格式化核心已经重构为 token 化 + shield + pipeline + 结构化处理的混合架构。维护时优先复用 `lib/sql-tokenizer.js`、`lib/sql-shield.js`、`lib/sql-format-pipeline.js`、`lib/sql-render-options.js`、`lib/sql-line-model.js`、`lib/sql-structure.js` 和 `lib/sql-keywords.js`，不要重新在 `vkbeautify.js` 里增加会扫描注释、字符串、块注释或反引号标识符内容的全局正则补丁。

## 测试指南
对任何格式化相关的改动，都应在 VS Code 中结合 `Alt+Shift+F`、标准 `Format Document` / `Format Selection`、`Alt+Shift+L` 和 `Alt+Shift+;`（适用时）进行手动测试。验证选中文本和整篇文档两种行为，以及 `extension.keywordCase`、`extension.commaStyle`、`extension.indentStyle`、`extension.maxAlignWidth` 和旧配置 fallback 等由配置驱动的场景。如果你要补充回归覆盖，请将其放在受影响逻辑附近，并使用带有描述性名称的 SQL 输入/输出夹具。

## 提交与 Pull Request 指南
近期提交历史使用简短的约定式消息，例如 `feat: ...`、`fix: ...` 和 `chore: ...`。每个提交应聚焦于单一改动。Pull Request 应说明受影响的 SQL 模式，列出手动验证步骤，并在格式化输出发生变化时提供前后对比示例。不要提交 `.vsix` 制品；需要安装包验证时，通过 GitHub Actions 构建并从 GitHub Releases 获取。

## 经验规则：用 GitHub Actions 生成验证 `.vsix`
- 触发信号：任何会影响扩展运行行为、格式化结果、命令行为或用户可见配置的改动，进入“请用户验证”阶段时。
- 根因 / 约束：该项目的安装包验证应尽量复用远端 GitHub Actions 环境，避免本地 `vsce`、Node 版本、网络代理或未清理文件影响 `.vsix` 内容；`.vsix` 制品不应提交到版本控制。
- 正确做法：先完成代码改动和回归验证，再更新 `package.json` 版本号、`CHANGELOG.md` 和必要的 `README.md` 说明；提交并推送到远端后，触发 `.github/workflows/build-vsix.yml` 的 `Build VSIX` workflow，由 GitHub Actions 打包、上传 artifact 并创建对应版本的 GitHub Release。不要在本地执行 `vsce package` 作为默认验证路径，除非用户明确要求本地打包。
- 验证方法：确认 workflow 成功完成，GitHub Release 中存在对应版本的 `.vsix`，并等待用户基于该 Release 包完成安装验证反馈。
- 适用范围：所有会改变扩展运行行为、格式化结果或用户可见配置的开发任务。

## 经验规则：远端打包必须触发新 workflow
- 触发信号：每一次准备让用户安装扩展并验证结果时，包括同一问题的二次、三次回归验证。
- 根因 / 约束：验证包必须对应当前提交和当前 `package.json` 版本；复用旧 artifact 或旧 Release 会让用户验证到过期代码。
- 正确做法：只要代码、版本或文档在上一次远端打包后发生变化，或者这是新一轮用户验证，就必须重新推送当前提交并触发 `Build VSIX` workflow；不得复用旧 `.vsix`，也不要假设“刚打过一次包”可以跳过当前验证前的远端构建。
- 验证方法：检查 GitHub Actions run 的 commit SHA、`package.json` 版本、Release tag 和 `.vsix` 文件名一致。
- 适用范围：所有涉及 VS Code 扩展打包、发布准备、或 `.vsix` 内容收敛的任务。

## 经验规则：格式化改动复用 Hive SQL 回归集
- 触发信号：修改 `vkbeautify.js`、格式化规则、注释对齐、`CASE WHEN`、Hive SQL 相关行为后，需要做回归验证。
- 根因 / 约束：该项目缺少完整测试框架，格式化规则又容易被局部修改带出连锁回归；一次性手工 SQL 很难稳定覆盖高风险 Hive 写法。
- 正确做法：保留并复用 `tests/comment-alignment.test.js`、`tests/case-when.test.js`、`tests/hive-regression.test.js` 作为长期回归集；每次优先覆盖同层 `SELECT/JOIN/WHERE/HAVING` 尾注释、子查询、`CASE WHEN`、CTE、窗口函数、`LATERAL VIEW/EXPLODE`、`INSERT OVERWRITE ... PARTITION` 这些高风险写法。
- 验证方法：至少运行 `npm run test:verify`，必要时再用相同样例到 VS Code / `.vsix` 里做手工格式化验证。
- 适用范围：所有会改变 SQL / Hive SQL 格式化输出的开发任务。

## 经验规则：注释和字符串必须走 token / line model / shield
- 触发信号：修改注释对齐、`CASE WHEN`、顶层 `AS` 对齐、关键词大小写转换、括号列表或 `WHERE` / `ON` / `HAVING` 条件格式化逻辑。
- 根因 / 约束：`--` 到行尾是不可继续解析的注释，单双引号字符串、块注释和反引号标识符也是不可格式化内容；如果继续用全局正则或临时占位符扫描整段文本，注释、字符串、块注释和反引号标识符里的 `WHEN`、`THEN`、`FROM`、逗号、引号会再次污染真实 SQL 结构。
- 正确做法：先用 `lib/sql-tokenizer.js` 区分 `line_comment`、`block_comment`、`string_literal`、`quoted_identifier` 和真实 SQL token；不可改写内容保护使用 `lib/sql-shield.js`；行级 code/comment 拆分使用 `lib/sql-line-model.js`；顶层词识别使用 `lib/sql-structure.js`；关键词大小写转换使用 `lib/sql-keywords.js`。`CASE`、`AS`、尾注释对齐只允许读取真实 SQL code，不得把注释正文、字符串、块注释或反引号内容当作 SQL token。
- 验证方法：运行 `npm run test:verify`，并确保覆盖字符串中包含 `--` / 逗号 / `CASE WHEN THEN`、注释中包含 `FROM` / `WHERE` / `GROUP BY` / `SELECT`、块注释中包含 SQL 关键词、反引号标识符包含混合大小写和关键词、`THEN` / `ELSE` 后接行尾注释、CASE 内注释掉分支、CASE 内 IN 列表注释和外层 SELECT 字段注释同时存在的场景。
- 适用范围：所有 SQL / Hive SQL 格式化核心维护任务，尤其是 `vkbeautify.js` 和 `lib/` 下模块。

## 经验规则：不可改写边界必须走 sql-shield
- 触发信号：修改 `vkbeautify.sql()` 主流程、格式化 pipeline、关键词大小写、块注释、反引号标识符、字符串转义或幂等性相关逻辑。
- 根因 / 约束：`/* ... */` 块注释、反引号标识符、反斜杠转义字符串和双单引号字符串都可能包含 `FROM`、`WHERE`、`CASE WHEN THEN`、逗号或大小写敏感内容；如果在进入旧正则 passes 前不统一 shield，这些内容会被误重排或误改写。
- 正确做法：优先复用 `lib/sql-shield.js` 保护/恢复 `string_literal`、`line_comment`、`block_comment` 和 `quoted_identifier`；主格式化流程需要保留行注释特殊处理时，明确通过参数关闭 `line_comment` shield，而不是新增局部占位符体系。新增格式化 passes 时，先确认它们运行在 shield 后还是 restore 后，并说明原因。
- 验证方法：运行 `node tests/token-boundary.test.js`、`node tests/pipeline-idempotency.test.js` 和 `npm run test:verify`；必须覆盖块注释、反引号、`can\\'t`、`it''s`、字符串/注释内 `CASE WHEN THEN` 和二次格式化幂等性。
- 适用范围：所有 `vkbeautify.js` 主 SQL formatter、`lib/sql-shield.js`、`lib/sql-format-pipeline.js`、`lib/sql-tokenizer.js` 相关改动。

## 经验规则：新配置不得用默认值覆盖旧配置
- 触发信号：新增、重命名或整理 VS Code 配置项，尤其是为旧配置提供语义化别名或替代项时。
- 根因 / 约束：VS Code `config.get()` 会返回 `package.json` 中的新配置默认值；如果直接用新配置值覆盖旧配置，用户已有的 `extension.uppercase`、`extension.comma_location`、`extension.bracket_char`、`extension.as_loc_cnt` 会在未迁移时被静默改变。
- 正确做法：保留旧配置键兼容；用 `config.inspect(key)` 判断新配置是否被用户显式设置，只有显式设置的新配置才优先于旧配置。配置语义归一化集中放在 `lib/sql-render-options.js`，`extension.js` 只负责读取 VS Code 配置和显式性。
- 验证方法：运行 `node tests/config-options.test.js` 和 `npm run test:verify`；测试必须同时覆盖新配置存在、枚举值、显式性判断和旧配置 fallback。
- 适用范围：所有 `package.json` 配置项、`extension.js` 配置读取、`lib/sql-render-options.js` 映射逻辑相关改动。

## 经验规则：DDL 能力按 experimental 隔离
- 触发信号：修改 `sqlddl`、`extractddl`、`extension.beautifySqlddl`、`extension.extractDdl`、DDL 文档或 DDL 测试。
- 根因 / 约束：当前 DDL 逻辑不是完整 SQL parser，只能覆盖 Hive DDL 的有限格式化和提取场景；复杂类型、注释文本、嵌套尖括号和括号内逗号很容易被简单逗号拆分破坏。
- 正确做法：保持 `sqlddl` / `extractDdl` 为 Hive DDL experimental，不把它描述为通用 DDL parser；修复时做受限扫描，至少按字符串、括号深度和尖括号深度拆分顶层逗号，不为产品未定义的高级 DDL 能力臆造实现。
- 验证方法：运行 `node tests/ddl-regression.test.js` 和 `npm run test:verify`；必须覆盖 `DECIMAL(18,2)`、`ARRAY<STRING>`、`MAP<STRING,STRING>`、`STRUCT<...>`、`COMMENT` 内含逗号。
- 适用范围：所有 DDL / Extract DDL formatter、命令贡献、README/CHANGELOG 中 DDL 能力说明相关改动。
