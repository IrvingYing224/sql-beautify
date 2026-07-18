# 仓库指南

## 项目结构与模块组织
该仓库是一个用于格式化 SQL 和 Hive SQL 的小型 VS Code 扩展。`extension.js` 现在只是极薄的 VS Code 入口壳层；VS Code 配置读取、命令注册和 formatter provider 逻辑位于 `lib/adapters/`。`vkbeautify.js` 是对外兼容 wrapper。实际 SQL formatter core 位于 `lib/core/`，experimental Hive DDL / Extract DDL 位于 `lib/experimental/ddl/`。根目录 `lib/*.js` 文件目前主要是兼容旧 require 路径的 shim。扩展元数据、命令和配置项定义在 `package.json` 中。用户文档位于 `README.md` 和 `CHANGELOG.md`，维护者技术文档位于 `docs/technical/`。图标和演示图片等静态资源位于 `images/`。打包后的 `.vsix` 文件可能会出现在仓库根目录中用于本地预检，但不应提交到版本控制。

## 构建、测试与开发命令
- `npm ci`：按 `package-lock.json` 安装项目本地依赖。
- `code .`：在 VS Code 中打开该项目进行开发。
- `npm run test:verify`：运行长期回归集，覆盖注释对齐、`CASE WHEN`、Hive SQL、token 边界、VS Code 贡献、配置映射、pipeline 幂等性和 DDL 风险隔离场景。
- `npm run package:vsix`：使用项目本地 `@vscode/vsce` 生成 `.vsix`，用于本地打包内容预检。
- GitHub Actions `Build VSIX`：发布时通过远端 workflow 构建 `.vsix` 并创建对应 Release。

该仓库已有轻量 CLI 回归集。格式化逻辑变更至少运行 `npm run test:verify`；涉及 VSIX 内容、发布清单或打包配置时，加跑 `npm run package:vsix` 并检查打包清单。
`npm run test:verify`、`npm run package:vsix`、VSIX 内容检查、`node tests/*.test.js`、`git diff --check` 等本地命令不需要代理，也不要额外设置 `ALL_PROXY`。只有真实访问网络的命令才按当前机器网络要求配置代理，例如远端 git push/fetch、依赖下载、GitHub CLI/API、Homebrew 或 npm install/ci。

## 编码风格与命名约定
遵循现有 JavaScript 风格：4 空格缩进、使用分号，以及基于 `var` 的 CommonJS 模块写法。旧命令 ID 仍需保留兼容；VS Code 配置面只使用 `sqlBeautify.*` 命名空间，不再新增或恢复 `extension.*` 配置兼容。优先对格式化逻辑做小而集中的修改，除非是有意变更，否则应保持 Hive SQL 的当前行为不变。

SQL / Hive SQL 格式化核心已经重构为 `core / adapters / experimental` 分层。维护 formatter 行为时优先修改 `lib/core/`；维护 VS Code 配置和命令入口时优先修改 `lib/adapters/`；维护 Hive DDL / Extract DDL 时优先修改 `lib/experimental/ddl/`。根目录 `lib/*.js` shim 只用于兼容旧路径，不应承载新逻辑。不要重新在 `vkbeautify.js` 或 root shim 中增加会扫描注释、字符串、块注释或反引号标识符内容的全局正则补丁。

## 测试指南
对任何格式化相关的改动，都应优先依赖自动化回归。至少运行 `npm run test:verify`；涉及命令、配置、标准 formatter provider、选区处理或错误提示时，补充或更新 `tests/extension-contribution.test.js`、`tests/config-options.test.js` 等覆盖；涉及 core / adapter 边界、legacy bridge、marker 泄漏或 support matrix 时，还应关注 `tests/module-boundary.test.js`、`tests/canonical-core-boundary.test.js`、`tests/layout-marker-leakage.test.js`、`tests/generated-support-matrix.test.js`；涉及打包内容时运行 `npm run package:vsix` 并检查清单。配置测试应覆盖 `sqlBeautify.*`、枚举值、显式性判断、canonical 归一化和 breaking cleanup 后的实际配置面，不再为已移除的 `extension.*` 配置补兼容回归。如果你要补充回归覆盖，请将其放在受影响逻辑附近，并使用带有描述性名称的 SQL 输入/输出夹具。必要时可增加 targeted smoke probe，但不把人工验证作为完成条件。

## 提交与 Pull Request 指南
近期提交历史使用简短的约定式消息，例如 `feat: ...`、`fix: ...` 和 `chore: ...`。每个提交应聚焦于单一改动。Pull Request 应说明受影响的 SQL 模式，列出自动化验证命令，并在格式化输出发生变化时提供前后对比示例。不要提交 `.vsix` 制品；发布包通过 GitHub Actions 构建并上传到 GitHub Releases。

## 经验规则：仓库内工作无须用户确认
- 触发信号：用户已经给出总体目标或明确任务范围，后续需要制定或调整计划、跨越 checkpoint、修改代码、运行测试、处理审查、委派子任务、更新必要文档、stage 或创建聚焦的本地提交时。
- 根因 / 约束：等待用户逐次测试、批准或回复“继续”会割裂长期任务，也不能替代自动化验证和独立审查。本规则是仓库级明确授权，覆盖默认工作方式中“代码修改后须先等用户确认，才能更新文档或创建提交”的要求。
- 正确做法：主代理应在既定范围内自主连续推进，直至目标完成；上述项目内操作均无须以用户确认作为前置条件。代理委派同样无须用户授权，主代理可以自主创建只读 reviewer 或委派边界清晰的子任务，并对最终结论负责。
- 完成约束：无须确认不等于降低质量门槛。验证失败、证据不足或存在未解决的 Critical / Important finding 时，不得声称完成或创建对应完成提交；主代理必须独立复核关键证据。用户明确要求暂停、暂不提交或改变范围时，应立即遵从。
- 授权边界：本规则适用于仓库内可验证、可回退的工作，不自动授权推送、发布、改写历史、删除用户数据或其他不可逆 / 外部状态变更；这些操作需要任务本身已经明确包含相应授权。
- 验证方法：最终交付应列出实际改动、验证命令与结果、审查结论和本地提交信息，并确认未越过任务范围与授权边界。
- 适用范围：本仓库内的规划、实现、测试、审查、代理委派、文档维护、暂存和本地 Git 提交。

## 经验规则：发布 VSIX 必须对应当前版本和 SHA
- 触发信号：准备发布扩展、生成 Release 包或更新 `.vsix` 内容时。
- 根因 / 约束：发布包必须对应当前提交和当前 `package.json` 版本；复用旧 artifact 或旧 Release 会发布过期代码；本地 `.vsix` 可用于预检，但制品不应提交。
- 正确做法：完成自动化回归后，更新版本号、`CHANGELOG.md` 和必要的 `README.md`；先将发布提交合入并推送到 `main`，再从 `main` 触发 `.github/workflows/build-vsix.yml` 的 `Build VSIX` workflow，生成 artifact 和 GitHub Release。不要从功能分支触发正式发布。
- 验证方法：检查 workflow 成功，且 GitHub Actions run 的分支为 `main`，run commit SHA、`origin/main`、Release target、Release tag 和 `.vsix` 文件名一致。

## 经验规则：本地验证命令不用代理
- 触发信号：运行本地测试、格式化验证、本地 `.vsix` 打包或 VSIX 内容检查时。
- 根因 / 约束：`npm run test:verify`、`npm run package:vsix`、`node tests/*.test.js`、`git diff --check` 和本地 VSIX 清单检查都只依赖当前仓库与项目本地依赖；给这些命令强行加 `ALL_PROXY` 会制造噪音，也容易让后续计划误判“本地打包等于网络操作”。
- 正确做法：这些本地命令直接运行，不加代理。只有命令确实访问外部网络时才设置代理，例如远端 git 操作、依赖下载、GitHub API/CLI、Homebrew、`npm install` 或 `npm ci`。
- 验证方法：计划和最终记录里的本地命令应写成 `npm run package:vsix`、`npm run test:verify` 等原始形式；不要写成 `ALL_PROXY=... npm run package:vsix`。

## 经验规则：格式化改动复用 Hive SQL 回归集
- 触发信号：修改任何 SQL / Hive SQL 格式化输出，尤其是注释对齐、`CASE WHEN`、`AS` 对齐、条件换行、关键词大小写或 Hive 特有语法。
- 根因 / 约束：格式化规则容易互相影响；一次性 smoke SQL 不能稳定覆盖尾注释、子查询、CTE、窗口函数、`LATERAL VIEW/EXPLODE`、`INSERT OVERWRITE ... PARTITION` 等高风险写法。
- 正确做法：优先复用现有回归集，并把有长期价值的新失败样例固化到对应测试文件。
- 验证方法：至少运行 `npm run test:verify`；必要时增加 targeted smoke probe。

## 经验规则：不可改写内容必须走 tokenizer / shield / line model
- 触发信号：修改注释、字符串、块注释、反引号标识符、关键词大小写、`CASE`、`AS`、括号列表或条件格式化逻辑。
- 根因 / 约束：注释、字符串、块注释和 quoted identifier 可能包含 `FROM`、`WHERE`、`CASE WHEN THEN`、逗号、引号或大小写敏感内容；全局正则和临时占位符容易把这些内容当成真实 SQL。
- 正确做法：使用 `lib/core/sql-tokenizer.js` 区分 token，使用 `lib/core/sql-shield.js` 保护不可改写内容，使用 `lib/core/sql-line-model.js` 做行级 code/comment 拆分；新增 pass 必须明确运行在 shield 前、shield 后还是 restore 后；不要重新引入 marker 驱动的 comment / layout 协作机制。
- 验证方法：运行 `node tests/token-boundary.test.js`、`node tests/pipeline-idempotency.test.js` 和 `npm run test:verify`，覆盖字符串/注释内 SQL 关键词、块注释、反引号、转义字符串和二次格式化幂等性。

## 经验规则：配置面只保留 `sqlBeautify.*`
- 触发信号：新增、重命名或整理 VS Code 配置项时。
- 根因 / 约束：旧 `extension.*` 配置已经作为 breaking cleanup 移除；重新引入 legacy fallback 会再次制造重复设置面、优先级歧义、文档膨胀和测试分叉。
- 正确做法：VS Code 配置读取只面向 `sqlBeautify.*`；配置语义归一化集中放在 `lib/adapters/sql-render-options.js`，VS Code 配置读取集中在 `lib/adapters/vscode-config.js`，`extension.js` 只保留薄入口壳层；不要恢复或新增 `extension.*` 配置键兼容。
- 验证方法：运行 `node tests/config-options.test.js` 和 `npm run test:verify`；测试应覆盖公开配置面、枚举值、显式性判断和 canonical 归一化。
- 适用范围：所有 `package.json` 配置项、`lib/adapters/vscode-config.js` 配置读取、`lib/adapters/sql-render-options.js` 映射逻辑相关改动。

## 经验规则：README 只写最终用户说明
- 触发信号：修改 `README.md`，尤其是新增配置说明、行为说明、experimental 能力说明或发布说明时。
- 根因 / 约束：README 是最终用户的说明书；如果把迁移优先级、兼容策略、架构边界或实现细节塞进去，用户会更难找到真正需要的使用信息，维护者文档也会与 README 混层。
- 正确做法：README 只保留用户会直接关心的内容，例如扩展做什么、怎么用、如何配置、哪些能力是 experimental、必要但简洁的风险提示；迁移策略、技术架构、support matrix、内部契约写到 `CHANGELOG.md` 或 `docs/technical/`。
- 验证方法：检查 README 是否仍能被非维护者快速用于安装、使用和配置；确认技术细节没有从 `docs/technical/` 反向复制回 README。
- 适用范围：所有 README 改动，以及任何想把迁移设计、架构说明或内部契约写回 README 的场景。

## 经验规则：DDL 能力按 experimental 隔离
- 触发信号：修改 `sqlddl`、`extractddl`、`extension.beautifySqlddl`、`extension.extractDdl`、DDL 文档或 DDL 测试。
- 根因 / 约束：当前 DDL 逻辑不是完整 SQL parser，只能覆盖 Hive DDL 的有限格式化和提取场景；复杂类型、注释文本、反引号字段名、嵌套尖括号和括号内逗号很容易被简单逗号拆分或全局 regex normalize 破坏。
- 正确做法：保持 `sqlddl` / `extractDdl` 为 Hive DDL experimental，不把它描述为通用 DDL parser；修复时优先修改 `lib/experimental/ddl/`，至少按字符串、反引号标识符、括号深度和尖括号深度拆分顶层逗号；类型 normalize 只能改写 quoted identifier / string literal 外部的类型关键字和分隔符空白，不为产品未定义的高级 DDL 能力臆造实现。
- 验证方法：运行 `node tests/ddl-regression.test.js` 和 `npm run test:verify`；必须覆盖 `DECIMAL(18,2)`、`ARRAY<STRING>`、`MAP<STRING,STRING>`、`STRUCT<...>`、反引号列名 / 字段名中的逗号、右括号和类型关键字、`COMMENT` 内含逗号，以及 `extractddl` 的 insert target、CTE、字符串内 `--`、CASE 字符串、函数参数逗号、`a < b` 比较表达式和复杂类型逗号场景。
- 适用范围：所有 DDL / Extract DDL formatter、命令贡献、README/CHANGELOG 中 DDL 能力说明相关改动。

## 经验规则：低置信语法检测必须验证真实上下文
- 触发信号：修改 `unsupportedSyntaxPolicy`、`lib/core/sql-syntax-risk-detector.js`、`lib/core/sql-opaque-protector.js`、`lib/core/sql-clause-registry.js`、dialect capability 或新增未建模 SQL 结构时。
- 根因 / 约束：`QUALIFY`、`PIVOT`、`MERGE` 等词也可能是普通字段名、别名或表达式函数名；如果只按单词值判断 unsupported 或 clause boundary handling，会把 `SELECT qualify AS c`、`WHERE qualify = 1`、`WHERE x = pivot(y)` 等合法输入误拒绝或静默改写。
- 正确做法：低置信语法检测和 clause boundary handling 必须同时验证前后 token、当前 SELECT/FROM/WHERE 等 clause 上下文、括号深度和真实 construct 边界；opaque 结构才走保护，detector-only 诊断不能声称内容一定被 opaque preserved。
- 验证方法：运行 `node tests/unsupported-safety.test.js`、`node tests/dialect-boundary.test.js` 和 `npm run test:verify`；必须同时覆盖普通 identifier / alias / WHERE expression function 不触发 `bail_out`，以及真实 `QUALIFY` clause、`PIVOT` table construct、`MATCH_RECOGNIZE(...)` 仍按策略拒绝、警告或保护。
- 适用范围：所有 unsupported policy、dialect-specific clause、clause registry、clause boundary handling、support matrix 和 diagnostics 文案相关改动。

## 经验规则：root lib shim 只做兼容导出
- 触发信号：修改 `lib/sql-*.js`、`lib/sql-canonical-options.js` 或调整模块路径时。
- 根因 / 约束：root `lib/*.js` 现在承担旧 require 路径兼容；如果再次把真实逻辑塞回这些 shim，会破坏 `core / adapters / experimental` 分层，并让 module-boundary 测试失去意义。
- 正确做法：新逻辑写到 `lib/core/`、`lib/adapters/` 或 `lib/experimental/ddl/`；root shim 只保留单行 re-export。若某个 shim 需要多于 re-export 的内容，先停下来重新审视边界。
- 验证方法：运行 `node tests/module-boundary.test.js`、`node tests/canonical-core-boundary.test.js`、`npm run test:verify`。
- 适用范围：所有 formatter core 分层、目录重组、兼容导出路径相关改动。

## 经验规则：core / adapter / support matrix 改动先看技术文档
- 触发信号：修改 `lib/core/`、`lib/adapters/`、`lib/experimental/ddl/`、clause/operator registry、support matrix 生成脚本，或调整 formatter 架构边界时。
- 根因 / 约束：这类改动同时受目录边界、依赖方向、generated support matrix 和 module-boundary tests 约束；如果只看单个文件，很容易把 core / adapter / experimental 混回去，或改了 registry 却漏更技术文档和生成产物。
- 正确做法：先读 `docs/technical/sql-formatter-architecture.md`；修改 registry 或支持边界后同步检查 `docs/technical/sql-support-matrix.md` 和 `scripts/generate-support-matrix.js`；不要把详细技术正文复制回 `README.md`。
- 验证方法：至少运行 `node tests/module-boundary.test.js`、`node tests/canonical-core-boundary.test.js`、`node tests/generated-support-matrix.test.js`、`npm run test:verify` 和 `npm run package:vsix`。
- 适用范围：所有 formatter core 分层、compat adapter、experimental DDL 边界、support matrix、技术维护文档相关改动。
