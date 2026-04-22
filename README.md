<h1 align="center">
 SQL Beautify
</h1>

<p align="center">
  😀格式化你杂乱无章的sql/hql代码😀
  
</p>
<p align="center">
  VS Code extension that beautifies SQL(HQL).
  
</p>

<div align=center>
<img  src="https://clarkyu1993.coding.net/p/tuku/shared-depot/pic/git/raw/master/demo.gif"/>
</div>


# 📸 安装 Installation 
[VSCode Plugin Market](https://marketplace.visualstudio.com/items?itemName=clarkyu.vscode-sql-beautify)


# 💥 特点 Features 

## 1. Beautify SQL

一键美化你的SQL！请确保你使用的语言是`SQL`，选择需要优化的代码块，按下`Alt+Shift+f`即可使用！ 

Beautify your SQL!  Make sure the language is set to `SQL`,then select your sql code and press `Alt+Shift+f` just like you normally would.

![demo](https://clarkyu1993.coding.net/p/tuku/shared-depot/pic/git/raw/master/demo.gif)

## 2. Beautify SQL DDL (Only for hive-sql)

一键美化你的DDL！请确保你使用的语言是`SQL`，选择需要优化的代码块，按下`Alt+Shift+l`即可使用！ 

Beautify your SQL DDL!  Make sure the language is set to `SQL`,then select your sql code and press `Alt+Shift+l`.

![demo](https://clarkyu1993.coding.net/p/tuku/shared-depot/pic/git/raw/master/demo2.gif)

## 3. Extract SQL DDL (Only for hive-sql)

一键从你的Insert语句中提取的DDL！请确保你使用的语言是`SQL`，选择需要优化的代码块，按下`Alt+Shift+;`即可使用！ 

Extract ddl from insert sql !  Make sure the language is set to `SQL`,then select your sql code and press `Alt+Shift+;`.

![demo](https://clarkyu1993.coding.net/p/tuku/shared-depot/pic/git/raw/master/demo3.gif)

## 4. Customize your own style 🐱‍🏍
你可以在vscode中文件-首选项-设置-扩展中找到一些自定义内容。详细的说明，可以阅读wiki-[功能说明](https://github.com/clarkyu2016/sql-beautify/wiki/%E5%8A%9F%E8%83%BD%E8%AF%B4%E6%98%8E-Features)！

Customize your own sql-beautify style in [settings-extension]. For more detail, please read wiki [Features](https://github.com/clarkyu2016/sql-beautify/wiki/%E5%8A%9F%E8%83%BD%E8%AF%B4%E6%98%8E-Features) to get more details about features of this extension

![customize](https://clarkyu1993.coding.net/p/tuku/shared-depot/pic/git/raw/master/customize.png)



# 💡 注意 Attention

* 这个插件在hql语句上更加兼容，因为它是我的主要工作语言。如果你在其他类型sql上使用，请小心使用，尤其是你的代码比较复杂的时候。This extension is more compatible in `Hive SQL` than in other sql language. If you develop on other sql language, it may cause some problems when the code is complex.

* 请小心使用本插件，建议对代码一段段进行格式化，而不是对整个文件一次性进行格式化。
Please be careful when use this plugin. Do not use it for the whole file. Recommend using it on code blocks one by one.

* 如果你真的遇到什么问题了，请先`Ctrl+z`恢复你的代码，然后可以联系我修复可能存在的问题。If you have some problems, try to use `Ctrl+z` to recover your code and contact me to fix the bug if you wish.

* Chatgpt横空出世，本插件几乎宣告下岗。Chatgpt was born out of nowhere, this plug-in was almost laid off

# 😎 更迭日志 Release Notes
### 0.3.26 (2026/04/22)
* 修复了多行 `CASE` 与 `AS`、行尾注释的对齐问题
* 保留整体列对齐，同时将最长项前的最短间隔调整为 1 个空格
* Fixed alignment issues between multi-line `CASE`, `AS`, and trailing comments
* Kept overall column alignment while reducing the minimum gap on the widest item to one space

### 0.3.25 (2026/04/21)
* 深度优化了 `CASE WHEN` 对齐和换行逻辑
* Optimized `CASE WHEN` alignment and wrapping

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


 [**More Release Notes**](https://github.com/clarkyu2016/sql-beautify/blob/main/CHANGELOG.md)

# 🎅 联系我 Contact Me

如果有任何问题，欢迎在Issues上留言提问题给我。也可以通过我的微信和我联系

If you have any problem,welcome to submit issues or You can contact me via wechat.

![wechat](https://clarkyu1993.coding.net/p/tuku/shared-depot/pic/git/raw/master/wechat.jpg)
