# 仓库指南

## 项目结构与模块组织
该仓库是一个用于格式化 SQL 和 Hive SQL 的小型 VS Code 扩展。核心运行时代码位于 `extension.js`，负责注册编辑器命令并读取扩展设置。格式化逻辑位于 `vkbeautify.js`。扩展元数据、命令和配置项定义在 `package.json` 中。文档位于 `README.md` 和 `CHANGELOG.md`。图标和演示图片等静态资源位于 `images/`。打包后的 `.vsix` 文件可能会出现在仓库根目录中用于手动验证，但不应提交到版本控制。

## 构建、测试与开发命令
- `npm install`：安装依赖，并运行适用于 VS Code 扩展环境的 `postinstall` 钩子。
- `code .`：在 VS Code 中打开该项目进行开发。
- 在 VS Code 中按 `F5`：启动 Extension Development Host，并以交互方式测试命令。
- `vsce package`：如果已安装 `vsce`，则可在发布前构建本地 `.vsix` 包用于手动验证。

该仓库没有专门的 CLI 测试套件。验证主要通过在开发宿主中对示例 SQL 选区运行扩展来完成。

## 编码风格与命名约定
遵循 `extension.js` 和 `vkbeautify.js` 中现有的 JavaScript 风格：4 空格缩进、使用分号，以及基于 `var` 的 CommonJS 模块写法。保持命令 ID 和配置键与 `package.json` 中已经使用的 `extension.*` 命名空间一致。优先对格式化逻辑做小而集中的修改，除非是有意变更，否则应保持 Hive SQL 的当前行为不变。

## 测试指南
对任何格式化相关的改动，都应在 VS Code 中结合 `Alt+Shift+F`、`Alt+Shift+L` 和 `Alt+Shift+;`（适用时）进行手动测试。验证选中文本和整篇文档两种行为，以及 `extension.uppercase`、`extension.comma_location` 等由配置驱动的场景。如果你要补充回归覆盖，请将其放在受影响逻辑附近，并使用带有描述性名称的 SQL 输入/输出夹具。

## 提交与 Pull Request 指南
近期提交历史使用简短的约定式消息，例如 `feat: ...`、`fix: ...` 和 `chore: ...`。每个提交应聚焦于单一改动。Pull Request 应说明受影响的 SQL 模式，列出手动验证步骤，并在格式化输出发生变化时提供前后对比示例。不要提交 `.vsix` 制品；应先在本地构建供评审验证，再在确认行为后更新文档或变更日志。

## 经验规则：先出 `.vsix` 再更新文档和提交
- 触发信号：完成扩展功能或修复后，用户需要先安装实际扩展包验证行为。
- 根因 / 约束：该项目主要通过 VS Code Extension Host 和本地安装包做手动验证；如果先改 `README.md`、`CHANGELOG.md` 或直接提交，容易把未经用户确认的行为和文档一起固化。
- 正确做法：需求完成后，先生成新的 `.vsix` 文件供用户安装测试；只有在用户明确确认结果无误后，才更新 `CHANGELOG.md`、`README.md` 并提交本次代码改动。
- 验证方法：检查仓库根目录是否生成了对应版本的 `.vsix`，并等待用户基于该包完成验证反馈。
- 适用范围：所有会改变扩展运行行为、格式化结果或用户可见配置的开发任务。
