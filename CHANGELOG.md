
## 😎 更迭日志 Release Notes

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







