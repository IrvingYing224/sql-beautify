# 仓库指南

## 项目结构与模块组织
该仓库是一个用于格式化 SQL 和 Hive SQL 的小型 VS Code 扩展。核心运行时代码位于 `extension.js`，负责注册编辑器命令、标准 formatter 入口并读取扩展设置。`vkbeautify.js` 是对外兼容 wrapper，实际 SQL 格式化、注释处理、关键词大小写、SELECT 对齐、条件对齐、DDL、方言边界和格式化上下文逻辑位于 `lib/` 下的 CommonJS 模块。扩展元数据、命令和配置项定义在 `package.json` 中。文档位于 `README.md` 和 `CHANGELOG.md`。图标和演示图片等静态资源位于 `images/`。打包后的 `.vsix` 文件可能会出现在仓库根目录中用于本地预检，但不应提交到版本控制。

## 构建、测试与开发命令
- `npm ci`：按 `package-lock.json` 安装项目本地依赖。
- `code .`：在 VS Code 中打开该项目进行开发。
- `npm run test:verify`：运行长期回归集，覆盖注释对齐、`CASE WHEN`、Hive SQL、token 边界、VS Code 贡献、配置映射、pipeline 幂等性和 DDL 风险隔离场景。
- `npm run package:vsix`：使用项目本地 `@vscode/vsce` 生成 `.vsix`，用于本地打包内容预检。
- GitHub Actions `Build VSIX`：发布时通过远端 workflow 构建 `.vsix` 并创建对应 Release。

该仓库已有轻量 CLI 回归集。格式化逻辑变更至少运行 `npm run test:verify`；涉及 VSIX 内容、发布清单或打包配置时，加跑 `npm run package:vsix` 并检查打包清单。

## 编码风格与命名约定
遵循现有 JavaScript 风格：4 空格缩进、使用分号，以及基于 `var` 的 CommonJS 模块写法。旧命令 ID 和旧 `extension.*` 配置键必须保留兼容；新增命令和设置优先使用 `sqlBeautify.*` 命名空间。优先对格式化逻辑做小而集中的修改，除非是有意变更，否则应保持 Hive SQL 的当前行为不变。

SQL / Hive SQL 格式化核心已经重构为 token 化 + shield + pipeline + 结构化处理的混合架构。维护时优先复用 `lib/sql-formatter.js`、`lib/sql-normalize-passes.js`、`lib/sql-comment-formatter.js`、`lib/sql-case-formatter.js`、`lib/sql-select-formatter.js`、`lib/sql-condition-formatter.js`、`lib/sql-ddl-formatter.js`、`lib/sql-dialect.js`、`lib/sql-tokenizer.js`、`lib/sql-shield.js`、`lib/sql-render-options.js`、`lib/sql-line-model.js`、`lib/sql-structure.js` 和 `lib/sql-keywords.js`，不要重新在 `vkbeautify.js` 里增加会扫描注释、字符串、块注释或反引号标识符内容的全局正则补丁。

## 测试指南
对任何格式化相关的改动，都应优先依赖自动化回归。至少运行 `npm run test:verify`；涉及命令、配置、标准 formatter provider、选区处理或错误提示时，补充或更新 `tests/extension-contribution.test.js`、`tests/config-options.test.js` 等覆盖；涉及打包内容时运行 `npm run package:vsix` 并检查清单。配置测试需要同时覆盖 `sqlBeautify.*`、`extension.*` semantic 设置和 legacy fallback。如果你要补充回归覆盖，请将其放在受影响逻辑附近，并使用带有描述性名称的 SQL 输入/输出夹具。必要时可增加 targeted smoke probe，但不把人工验证作为完成条件。

## 提交与 Pull Request 指南
近期提交历史使用简短的约定式消息，例如 `feat: ...`、`fix: ...` 和 `chore: ...`。每个提交应聚焦于单一改动。Pull Request 应说明受影响的 SQL 模式，列出自动化验证命令，并在格式化输出发生变化时提供前后对比示例。不要提交 `.vsix` 制品；发布包通过 GitHub Actions 构建并上传到 GitHub Releases。

## 经验规则：发布 VSIX 必须对应当前版本和 SHA
- 触发信号：准备发布扩展、生成 Release 包或更新 `.vsix` 内容时。
- 根因 / 约束：发布包必须对应当前提交和当前 `package.json` 版本；复用旧 artifact 或旧 Release 会发布过期代码；本地 `.vsix` 可用于预检，但制品不应提交。
- 正确做法：完成自动化回归后，更新版本号、`CHANGELOG.md` 和必要的 `README.md`；提交并推送后触发 `.github/workflows/build-vsix.yml` 的 `Build VSIX` workflow，生成 artifact 和 GitHub Release。
- 验证方法：检查 workflow 成功，且 GitHub Actions run 的 commit SHA、`package.json` 版本、Release tag 和 `.vsix` 文件名一致。

## 经验规则：格式化改动复用 Hive SQL 回归集
- 触发信号：修改任何 SQL / Hive SQL 格式化输出，尤其是注释对齐、`CASE WHEN`、`AS` 对齐、条件换行、关键词大小写或 Hive 特有语法。
- 根因 / 约束：格式化规则容易互相影响；一次性 smoke SQL 不能稳定覆盖尾注释、子查询、CTE、窗口函数、`LATERAL VIEW/EXPLODE`、`INSERT OVERWRITE ... PARTITION` 等高风险写法。
- 正确做法：优先复用现有回归集，并把有长期价值的新失败样例固化到对应测试文件。
- 验证方法：至少运行 `npm run test:verify`；必要时增加 targeted smoke probe。

## 经验规则：不可改写内容必须走 tokenizer / shield / line model
- 触发信号：修改注释、字符串、块注释、反引号标识符、关键词大小写、`CASE`、`AS`、括号列表或条件格式化逻辑。
- 根因 / 约束：注释、字符串、块注释和 quoted identifier 可能包含 `FROM`、`WHERE`、`CASE WHEN THEN`、逗号、引号或大小写敏感内容；全局正则和临时占位符容易把这些内容当成真实 SQL。
- 正确做法：使用 `lib/sql-tokenizer.js` 区分 token，使用 `lib/sql-shield.js` 保护不可改写内容，使用 `lib/sql-line-model.js` 做行级 code/comment 拆分；新增 pass 必须明确运行在 shield 前、shield 后还是 restore 后。
- 验证方法：运行 `node tests/token-boundary.test.js`、`node tests/pipeline-idempotency.test.js` 和 `npm run test:verify`，覆盖字符串/注释内 SQL 关键词、块注释、反引号、转义字符串和二次格式化幂等性。

## 经验规则：新配置不得用默认值覆盖旧配置
- 触发信号：新增、重命名或整理 VS Code 配置项，尤其是为旧配置提供语义化别名或替代项时。
- 根因 / 约束：VS Code `config.get()` 会返回 `package.json` 中的新配置默认值；如果直接用新配置值覆盖旧配置，用户已有的 `extension.uppercase`、`extension.comma_location`、`extension.bracket_char`、`extension.as_loc_cnt` 会在未迁移时被静默改变。
- 正确做法：推荐新增配置使用 `sqlBeautify.*`；保留旧 `extension.*` 配置键兼容；用 `config.inspect(key)` 判断新配置是否被用户显式设置，只有显式设置的新配置才优先于旧配置。配置语义归一化集中放在 `lib/sql-render-options.js`，`extension.js` 只负责读取 VS Code 配置和显式性。
- 验证方法：运行 `node tests/config-options.test.js` 和 `npm run test:verify`；测试必须同时覆盖 `sqlBeautify.*`、`extension.*` semantic 设置、枚举值、显式性判断和 legacy fallback。
- 适用范围：所有 `package.json` 配置项、`extension.js` 配置读取、`lib/sql-render-options.js` 映射逻辑相关改动。

## 经验规则：DDL 能力按 experimental 隔离
- 触发信号：修改 `sqlddl`、`extractddl`、`extension.beautifySqlddl`、`extension.extractDdl`、DDL 文档或 DDL 测试。
- 根因 / 约束：当前 DDL 逻辑不是完整 SQL parser，只能覆盖 Hive DDL 的有限格式化和提取场景；复杂类型、注释文本、嵌套尖括号和括号内逗号很容易被简单逗号拆分破坏。
- 正确做法：保持 `sqlddl` / `extractDdl` 为 Hive DDL experimental，不把它描述为通用 DDL parser；修复时做受限扫描，至少按字符串、括号深度和尖括号深度拆分顶层逗号，不为产品未定义的高级 DDL 能力臆造实现。
- 验证方法：运行 `node tests/ddl-regression.test.js` 和 `npm run test:verify`；必须覆盖 `DECIMAL(18,2)`、`ARRAY<STRING>`、`MAP<STRING,STRING>`、`STRUCT<...>`、`COMMENT` 内含逗号，以及 `extractddl` 的 insert target、CTE、字符串内 `--`、CASE 字符串、函数参数逗号、`a < b` 比较表达式和复杂类型逗号场景。
- 适用范围：所有 DDL / Extract DDL formatter、命令贡献、README/CHANGELOG 中 DDL 能力说明相关改动。
