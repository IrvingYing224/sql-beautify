# 仓库指南

## 项目结构与模块组织
该仓库是一个用于格式化 SQL 和 Hive SQL 的小型 VS Code 扩展。核心运行时代码位于 `extension.js`，负责注册编辑器命令并读取扩展设置。格式化入口仍位于 `vkbeautify.js`，但 SQL token、结构识别、关键词大小写和行模型等支撑逻辑位于 `lib/` 下的 CommonJS 模块。扩展元数据、命令和配置项定义在 `package.json` 中。文档位于 `README.md` 和 `CHANGELOG.md`。图标和演示图片等静态资源位于 `images/`。打包后的 `.vsix` 文件可能会出现在仓库根目录中用于手动验证，但不应提交到版本控制。

## 构建、测试与开发命令
- `npm install`：安装依赖，并运行适用于 VS Code 扩展环境的 `postinstall` 钩子。
- `code .`：在 VS Code 中打开该项目进行开发。
- 在 VS Code 中按 `F5`：启动 Extension Development Host，并以交互方式测试命令。
- `npm run test:verify`：运行长期回归集，覆盖注释对齐、`CASE WHEN` 和 Hive SQL 高风险格式化场景。
- `vsce package`：如果已安装 `vsce`，则可在发布前构建本地 `.vsix` 包用于手动验证。

该仓库已有轻量 CLI 回归集。格式化逻辑变更至少运行 `npm run test:verify`；需要交互验证时再通过 VS Code Extension Development Host 或本地 `.vsix` 安装测试。

## 编码风格与命名约定
遵循 `extension.js` 和 `vkbeautify.js` 中现有的 JavaScript 风格：4 空格缩进、使用分号，以及基于 `var` 的 CommonJS 模块写法。保持命令 ID 和配置键与 `package.json` 中已经使用的 `extension.*` 命名空间一致。优先对格式化逻辑做小而集中的修改，除非是有意变更，否则应保持 Hive SQL 的当前行为不变。

SQL / Hive SQL 格式化核心已经重构为 token 化 + 结构化处理的混合架构。维护时优先复用 `lib/sql-tokenizer.js`、`lib/sql-line-model.js`、`lib/sql-structure.js` 和 `lib/sql-keywords.js`，不要重新在 `vkbeautify.js` 里增加会扫描注释或字符串内容的全局正则补丁。

## 测试指南
对任何格式化相关的改动，都应在 VS Code 中结合 `Alt+Shift+F`、`Alt+Shift+L` 和 `Alt+Shift+;`（适用时）进行手动测试。验证选中文本和整篇文档两种行为，以及 `extension.uppercase`、`extension.comma_location` 等由配置驱动的场景。如果你要补充回归覆盖，请将其放在受影响逻辑附近，并使用带有描述性名称的 SQL 输入/输出夹具。

## 提交与 Pull Request 指南
近期提交历史使用简短的约定式消息，例如 `feat: ...`、`fix: ...` 和 `chore: ...`。每个提交应聚焦于单一改动。Pull Request 应说明受影响的 SQL 模式，列出手动验证步骤，并在格式化输出发生变化时提供前后对比示例。不要提交 `.vsix` 制品；应先在本地构建供评审验证，再在确认行为后更新文档或变更日志。

## 经验规则：先出 `.vsix` 再更新文档和提交
- 触发信号：任何会影响扩展运行行为、格式化结果、命令行为或用户可见配置的改动，进入“请用户验证”阶段时。
- 根因 / 约束：该项目主要通过 VS Code Extension Host 和本地安装包做手动验证；如果先改 `README.md`、`CHANGELOG.md` 或直接提交，容易把未经用户确认的行为和文档一起固化。
- 正确做法：只要下一步是让用户验证，就默认先重新生成新的 `.vsix` 文件供用户安装测试；不要口头让用户直接验证源码工作区，也不要跳过打包步骤。只有在用户明确确认结果无误后，才更新 `CHANGELOG.md`、`README.md` 并提交本次代码改动。
- 验证方法：检查仓库根目录是否生成了对应版本的 `.vsix`，并等待用户基于该包完成验证反馈。
- 适用范围：所有会改变扩展运行行为、格式化结果或用户可见配置的开发任务。

## 经验规则：按固定方式打包 `.vsix`
- 触发信号：每一次准备让用户安装扩展并验证结果时，包括同一问题的二次、三次回归验证。
- 正确做法：保持 `package.json` 中 `vsce.dependencies = false`，并维护项目根目录的 `.vscodeignore`；打包时直接运行 `vsce package`。只要代码在上一次打包后又发生了变更，或者这是新一轮用户验证，就必须重新打包，不得复用旧 `.vsix`，也不要假设“刚打过一次包”可以跳过当前验证前的打包步骤。
- 验证方法：确认仓库根目录生成新的 `.vsix` 文件，并用 `vsce ls --tree` 检查包内只包含扩展运行所需文件。
- 适用范围：所有涉及 VS Code 扩展打包、发布准备、或 `.vsix` 内容收敛的任务。

## 经验规则：格式化改动复用 Hive SQL 回归集
- 触发信号：修改 `vkbeautify.js`、格式化规则、注释对齐、`CASE WHEN`、Hive SQL 相关行为后，需要做回归验证。
- 根因 / 约束：该项目缺少完整测试框架，格式化规则又容易被局部修改带出连锁回归；一次性手工 SQL 很难稳定覆盖高风险 Hive 写法。
- 正确做法：保留并复用 `tests/comment-alignment.test.js`、`tests/case-when.test.js`、`tests/hive-regression.test.js` 作为长期回归集；每次优先覆盖同层 `SELECT/JOIN/WHERE/HAVING` 尾注释、子查询、`CASE WHEN`、CTE、窗口函数、`LATERAL VIEW/EXPLODE`、`INSERT OVERWRITE ... PARTITION` 这些高风险写法。
- 验证方法：至少运行 `npm run test:verify`，必要时再用相同样例到 VS Code / `.vsix` 里做手工格式化验证。
- 适用范围：所有会改变 SQL / Hive SQL 格式化输出的开发任务。

## 经验规则：注释和字符串必须走 token / line model
- 触发信号：修改注释对齐、`CASE WHEN`、顶层 `AS` 对齐、关键词大小写转换、括号列表或 `WHERE` / `ON` / `HAVING` 条件格式化逻辑。
- 根因 / 约束：`--` 到行尾是不可继续解析的注释，单双引号字符串也是不可格式化内容；如果继续用全局正则或占位符扫描整段文本，注释和字符串里的 `WHEN`、`THEN`、`FROM`、逗号、引号会再次污染真实 SQL 结构。
- 正确做法：先用 `lib/sql-tokenizer.js` 区分 `line_comment`、`string_literal` 和真实 SQL token；行级 code/comment 拆分使用 `lib/sql-line-model.js`；顶层词识别使用 `lib/sql-structure.js`；关键词大小写转换使用 `lib/sql-keywords.js`。`CASE`、`AS`、尾注释对齐只允许读取真实 SQL code，不得把注释正文或字符串内容当作 SQL token。
- 验证方法：运行 `npm run test:verify`，并确保覆盖字符串中包含 `--` / 逗号 / `CASE WHEN THEN`、注释中包含 `FROM` / `WHERE` / `GROUP BY` / `SELECT`、`THEN` / `ELSE` 后接行尾注释、CASE 内注释掉分支、CASE 内 IN 列表注释和外层 SELECT 字段注释同时存在的场景。
- 适用范围：所有 SQL / Hive SQL 格式化核心维护任务，尤其是 `vkbeautify.js` 和 `lib/` 下模块。
