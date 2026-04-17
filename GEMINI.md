# 核心规则
* **文档编写和回复必须使用简体中文。**
* **提交代码时必须忽略 .vsix 文件。**

# 项目概述
本项目是一个名为 **SQL Beautify** (`vscode-sql-beautify`) 的 Visual Studio Code 插件。它的主要功能是格式化和美化 SQL 及 Hive SQL (HQL) 代码。

**主要技术栈:**
- **Node.js:** VS Code 插件的底层运行时环境。
- **VS Code Extension API:** 用于注册命令并与编辑器进行交互。
- **vkbeautify (v0.99.1):** 核心的外部依赖项，用于执行实际的 SQL 格式化和 DDL 提取操作。

**主要功能:**
- 美化 SQL (`Alt+Shift+f`)
- 美化 SQL DDL（仅限 Hive-SQL）(`Alt+Shift+l`)
- 从 Insert 语句中提取 SQL DDL（仅限 Hive-SQL）(`Alt+Shift+;`)

# 构建和运行
作为一个标准的 VS Code 插件，你可以按照以下步骤进行构建和测试：
1.  **安装依赖项:** 在项目根目录下运行 `npm install`。`postinstall` 脚本将自动安装 VS Code 的类型定义（typings）。
2.  **运行/调试:** 在 VS Code 中打开本项目，然后按 `F5` 启动插件开发主机（Extension Development Host）。
3.  **测试:** 在新弹出的 VS Code 窗口中，打开一个 SQL 文件，选中一些 SQL 代码，然后使用注册的快捷键（例如 `Alt+Shift+f`）来触发插件命令。

# 开发约定
- **主要入口点:** 核心逻辑包含在 `extension.js` 中。`activate` 函数负责注册插件的各项命令。
- **命令注册:** 命令在 `package.json` 的 `contributes.commands` 字段下定义，并使用 `vscode.commands.registerCommand()` 在 `extension.js` 中进行注册。
- **文本编辑器交互:** 该插件直接与当前活动的文本编辑器 (`vscode.window.activeTextEditor`) 交互，读取选中的文本或整个文档的内容，应用 `vkbeautify` 的转换逻辑，并使用 `builder.replace` 来更新文档。
- **用户配置:** 该插件通过 `vscode.workspace.getConfiguration('extension')` 读取在 `package.json` 中定义的自定义设置（如 `uppercase`、`comma_location`、`bracket_char`、`as_loc_cnt`）。如果需要修改格式化逻辑，请确保遵循并尊重这些配置项。
