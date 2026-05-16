<h1 align="center">
 SQL Beautify
</h1>

<p align="center">
  😀格式化你杂乱无章的sql/hql代码😀
  
</p>
<p align="center">
  VS Code extension that beautifies SQL(HQL).
  
</p>

<p align="center">
  Maintained by <a href="https://github.com/IrvingYing224">IrvingYing224</a> since version 0.3.23.
</p>

<div align=center>
<img  src="images/demo.gif"/>
</div>


# 📸 安装 Installation

从 [GitHub Releases](https://github.com/IrvingYing224/sql-beautify/releases) 下载由 GitHub Actions 构建的最新 `.vsix` 文件，然后在 VS Code 中执行 `Extensions: Install from VSIX...` 进行安装。

Download the latest `.vsix` file built by GitHub Actions from [GitHub Releases](https://github.com/IrvingYing224/sql-beautify/releases), then run `Extensions: Install from VSIX...` in VS Code.

最低支持 VS Code `1.90.0`。

Minimum supported VS Code version is `1.90.0`.


# 💥 特点 Features 

## 1. Beautify SQL

一键美化你的SQL！请确保你使用的语言是`SQL`，选择需要优化的代码块，按下`Alt+Shift+f`即可使用！ 

Beautify your SQL!  Make sure the language is set to `SQL`,then select your sql code and press `Alt+Shift+f` just like you normally would.

也可以将本扩展设置为 VS Code 的默认 SQL formatter，然后使用 VS Code 标准的 `Format Document` / `Format Selection` 入口。

You can also configure this extension as the default VS Code formatter for SQL, then use the standard `Format Document` / `Format Selection` actions.

![demo](images/demo.gif)

## 2. Beautify SQL DDL (Experimental, Hive SQL)

一键美化你的DDL！请确保你使用的语言是`SQL`，选择需要优化的代码块，按下`Alt+Shift+l`即可使用！ 

Beautify your SQL DDL!  Make sure the language is set to `SQL`,then select your sql code and press `Alt+Shift+l`.

DDL 格式化目前主要面向 Hive DDL，仍属于 experimental 功能。复杂建表语句建议先选中小段内容验证结果。

DDL formatting is currently focused on Hive DDL and remains experimental. For complex `CREATE TABLE` statements, format a small selection first and review the result.

![demo](images/demo2.gif)

## 3. Extract SQL DDL (Experimental, Hive SQL)

一键从你的Insert语句中提取的DDL！请确保你使用的语言是`SQL`，选择需要优化的代码块，按下`Alt+Shift+;`即可使用！ 

Extract ddl from insert sql !  Make sure the language is set to `SQL`,then select your sql code and press `Alt+Shift+;`.

该能力同样按 Hive SQL experimental 处理，适合从常规 `SELECT` / `INSERT SELECT` 字段列表生成 DDL 草稿。复杂 SQL、非 Hive 语法或未加别名的表达式，请先在临时文件中验证输出并人工复核。

This feature is also treated as experimental for Hive SQL. It is intended to draft DDL from common `SELECT` / `INSERT SELECT` field lists. For complex SQL, non-Hive syntax, or expressions without aliases, verify the output in a temporary file and review it manually.

## 4. Customize your own style 🐱‍🏍
你可以在vscode中文件-首选项-设置-扩展中找到一些自定义内容。

Customize your own sql-beautify style in [settings-extension].

SQL Beautify works best with Hive SQL. Other SQL dialects may work for common cases, but complex statements should be reviewed after formatting.

| Area | Status |
| --- | --- |
| Hive SQL formatting | Primary support |
| Hive DDL formatting | Experimental |
| Extract DDL | Experimental |
| Other SQL dialects | Use with caution |

推荐优先使用 `sqlBeautify.*` 配置；旧 `extension.*` 配置仍然保留兼容。如果新旧配置同时存在，会优先使用 `sqlBeautify.*`。

Prefer `sqlBeautify.*` settings. Legacy `extension.*` settings remain compatible. When both are configured, `sqlBeautify.*` takes precedence.

| 新配置 New setting | 可选值 Values | 旧配置 Legacy setting | 说明 |
| --- | --- | --- | --- |
| `sqlBeautify.keywordCase` | `upper` / `lower` | `extension.keywordCase` / `extension.uppercase` | 控制 SQL 关键词大小写 |
| `sqlBeautify.commaStyle` | `leading` / `trailing` | `extension.commaStyle` / `extension.comma_location` | 控制逗号位于行首或行尾 |
| `sqlBeautify.indentStyle` | `tab` / `space` | `extension.indentStyle` / `extension.bracket_char` | 控制缩进风格 |
| `sqlBeautify.maxAlignWidth` | 1..500 | `extension.maxAlignWidth` / `extension.as_loc_cnt` | 控制 `AS` 和行尾注释参与对齐的最大代码宽度 |
| `sqlBeautify.caseWhenThenWrapLength` | 1..300 | `extension.case_when_then_wrap_length` | 控制 `CASE WHEN` 中 `THEN` / `ELSE` 值换行阈值 |
| `sqlBeautify.dialect` | `generic` / `hive` / `postgres` / `mysql` | none | 选择 SQL 类型 |

# 💡 注意 Attention

* 这个插件在 HQL / Hive SQL 语句上更加兼容。如果你在 Spark SQL、Presto/Trino 或其他 SQL 方言上使用，请在格式化后检查结果，尤其是代码比较复杂的时候。This extension is more compatible with `Hive SQL` / HQL. For Spark SQL, Presto/Trino, and other SQL dialects, review the result after formatting, especially when the code is complex.

* 请小心使用本插件，建议对代码一段段进行格式化，而不是对整个文件一次性进行格式化。
Please be careful when use this plugin. Do not use it for the whole file. Recommend using it on code blocks one by one.

* 如果你真的遇到什么问题了，请先`Ctrl+z`恢复你的代码，然后可以联系我修复可能存在的问题。If you have some problems, try to use `Ctrl+z` to recover your code and contact me to fix the bug if you wish.


 [**Release Notes**](https://github.com/IrvingYing224/sql-beautify/blob/main/CHANGELOG.md)

# 🎅 联系我 Contact Me

如果有任何问题，欢迎在Issues上留言提问题给我。

If you have any problem,welcome to submit issues 
