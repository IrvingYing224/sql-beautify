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
[VSCode Plugin Market](https://marketplace.visualstudio.com/items?itemName=clarkyu.vscode-sql-beautify)


# 💥 特点 Features 

## 0.4 Formatter Core

`0.4.x` 重构了 SQL / Hive SQL 格式化核心。格式化器现在先识别真实 SQL token、行注释和字符串，再处理 `CASE WHEN`、顶层 `AS`、括号列表和行尾注释对齐，避免注释、字符串或字段名子串里的 `WHEN`、`THEN`、`FROM`、`WITH`、逗号、引号被当成 SQL 继续格式化。

Version `0.4.x` refactors the SQL / Hive SQL formatter core. The formatter now identifies real SQL tokens, line comments, and string literals before formatting `CASE WHEN`, top-level `AS`, parenthesized lists, and trailing comments, so SQL-like text inside comments, strings, or column-name substrings stays untouched.

## 1. Beautify SQL

一键美化你的SQL！请确保你使用的语言是`SQL`，选择需要优化的代码块，按下`Alt+Shift+f`即可使用！ 

Beautify your SQL!  Make sure the language is set to `SQL`,then select your sql code and press `Alt+Shift+f` just like you normally would.

![demo](images/demo.gif)

## 2. Beautify SQL DDL (Only for hive-sql)

一键美化你的DDL！请确保你使用的语言是`SQL`，选择需要优化的代码块，按下`Alt+Shift+l`即可使用！ 

Beautify your SQL DDL!  Make sure the language is set to `SQL`,then select your sql code and press `Alt+Shift+l`.

![demo](images/demo2.gif)

## 3. Extract SQL DDL (Only for hive-sql)

一键从你的Insert语句中提取的DDL！请确保你使用的语言是`SQL`，选择需要优化的代码块，按下`Alt+Shift+;`即可使用！ 

Extract ddl from insert sql !  Make sure the language is set to `SQL`,then select your sql code and press `Alt+Shift+;`.

## 4. Customize your own style 🐱‍🏍
你可以在vscode中文件-首选项-设置-扩展中找到一些自定义内容。

Customize your own sql-beautify style in [settings-extension].



# 💡 注意 Attention

* 这个插件在hql语句上更加兼容，因为它是我的主要工作语言。如果你在其他类型sql上使用，请小心使用，尤其是你的代码比较复杂的时候。This extension is more compatible in `Hive SQL` than in other sql language. If you develop on other sql language, it may cause some problems when the code is complex.

* 请小心使用本插件，建议对代码一段段进行格式化，而不是对整个文件一次性进行格式化。
Please be careful when use this plugin. Do not use it for the whole file. Recommend using it on code blocks one by one.

* 如果你真的遇到什么问题了，请先`Ctrl+z`恢复你的代码，然后可以联系我修复可能存在的问题。If you have some problems, try to use `Ctrl+z` to recover your code and contact me to fix the bug if you wish.


 [**Release Notes**](https://github.com/IrvingYing224/sql-beautify/blob/main/CHANGELOG.md)

# 🎅 联系我 Contact Me

如果有任何问题，欢迎在Issues上留言提问题给我。

If you have any problem,welcome to submit issues 
