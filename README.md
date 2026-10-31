# SQL Beautify

VS Code 扩展，用来格式化 Hive SQL / HQL。另外提供两个实验性命令：格式化 Hive 建表语句，以及从 SELECT 查询生成建表字段的草稿。

**只支持 Hive。** `SQL` 与 `hive-sql` 两种语言模式都按 Hive 的词法处理。PostgreSQL 的 `$$…$$`、`E'…'`、双引号标识符，MySQL 的 `#` 注释等写法会被误读，格式化后可能改变语义，请不要用它格式化其他数据库的 SQL。

## 效果

格式化前：

```sql
set hive.exec.dynamic.partition.mode=nonstrict;
insert overwrite table dw.user_daily partition (ds='${hiveconf:ds}')
select u.user_id, u.city as city_name, count(distinct o.order_id) as order_cnt,
sum(case when o.paid = 1 then o.amount else 0 end) as paid_amount,
case when u.level >= 3 then 'vip' when u.level = 2 then 'regular' else 'new' end as user_type -- 用户分层
from ods.users u left join ods.orders o on u.user_id = o.user_id and o.ds = '${hiveconf:ds}'
where u.is_test = 0 group by u.user_id, u.city, u.level;
```

格式化后（默认设置）：

```sql
SET hive.exec.dynamic.partition.mode=nonstrict;
INSERT OVERWRITE TABLE dw.user_daily
PARTITION (ds = '${hiveconf:ds}')
SELECT
      u.user_id
    , u.city                                             AS city_name
    , count(DISTINCT o.order_id)                         AS order_cnt
    , sum(CASE WHEN o.paid = 1 THEN o.amount ELSE 0 END) AS paid_amount
    , CASE
          WHEN u.level >= 3 THEN 'vip'
          WHEN u.level = 2 THEN 'regular'
          ELSE 'new'
      END AS user_type -- 用户分层
FROM ods.users u
LEFT JOIN ods.orders o
    ON u.user_id = o.user_id
        AND o.ds = '${hiveconf:ds}'
WHERE u.is_test = 0
GROUP BY
      u.user_id
    , u.city
    , u.level;
```

## 安装

从 [GitHub Releases](https://github.com/IrvingYing224/sql-beautify/releases) 下载最新的 `.vsix`，在 VS Code 中执行 `Extensions: Install from VSIX...` 安装。最低支持 VS Code 1.90.0。

从 2.x 升级时，请先看 [CHANGELOG](CHANGELOG.md) 中 3.0.0 的升级说明：删除了两项设置和一个命令，`sqlBeautify.caseLayout` 的默认值也改了。

## 使用

把文件的语言模式设为 `SQL` 或 `hive-sql`（`hive-sql` 由第三方 Hive 语言扩展提供），然后：

- 执行 `Format Document` 或 `Format Selection`，也可以用多个选区一起格式化；
- 或者执行命令 `SQL Beautify: Format SQL`。

装了多个 SQL formatter 时，把 `editor.defaultFormatter` 设为 `clarkyu.vscode-sql-beautify`。扩展不占用 `Shift+Alt+F`，需要专用快捷键时，可以在 Keyboard Shortcuts 中给 `sqlBeautify.formatSql` 绑定。

格式化选区时，选区要覆盖整行，并且正好是一条语句、一个子句或一个列表，或者若干条连续的完整语句。半条语句、选区两端落在字符串或注释中间时，不做修改并给出提示。多个选区一起格式化时，只要有一个不能格式化，所有选区都不修改。

第一条语句前有缩进时（例如从别的文件里拷来的一段 SQL），格式化后每一行都保留这段缩进。

## 排版规则

- 关键字按 `keywordCase` 统一大小写；表名、列名、函数名保持原样。
- SELECT、GROUP BY 和顶层 ORDER BY 的列表每项一行；`AS` 别名和行尾注释在 `maxAlignWidth` 以内按列对齐。逗号前置时，各项内容对齐到同一列，CASE、子查询这类多行内容也一样。
- 逗号后面紧跟注释时（`a, -- 说明`），为了让注释留在原来那一行，整张列表改用后置逗号。逗号后置模式下，逗号前有行注释时（`a -- 说明` 换行接 `, b`），整张列表改用前置逗号，并给出一条信息级诊断。
- CASE：默认（`compactShort`）短的 CASE 收成一行；整个 CASE 平铺后超过 `caseWhenThenWrapLength` 列，或者内部有注释、模板、跨行内容时展开。展开时 `END` 与 `CASE` 对齐，`WHEN`、`ELSE` 多缩进一层，函数参数里的 CASE 也一样。`WHEN … THEN …` 一行超过 `caseWhenThenWrapLength` 时，THEN 的值换到下一行。
- WHERE、ON 中的 AND、OR 换行并缩进；窗口函数 `OVER (…)` 里的内容保持在一行。
- 注释保持在原来的位置。关键字后面同一行的注释留在关键字那一行；如果是行注释，后面的内容换行并缩进一层。
- 字符串、注释、反引号标识符、`${…}` 变量、Hive 数字 literal（`0L`、`1.0BD` 等）以及命令后面的路径和参数，一个字符都不改，包括大小写和内部空白。紧贴变量的写法（`ds=${hiveconf:ds}`、`tbl_${dt}`）也保持原样，因为插入空格可能改变变量展开后的 SQL。

## 支持的语句

| 语句 | 处理 |
| --- | --- |
| SELECT、WITH、UNION 等集合运算；`INSERT INTO/OVERWRITE … SELECT`（含 PARTITION 与列清单）；CTAS（`CREATE TABLE … AS SELECT`） | 完整排版。CTAS 中 `AS` 之前的部分只规范空白，查询从下一行开始 |
| `SET key=value` | `SET` 改大小写，后面的内容原样保留 |
| `USE`、`SHOW`、`DESCRIBE`、`MSCK`、`ANALYZE`、`LOAD DATA`、`DROP`、`TRUNCATE`、`ALTER TABLE`、`CREATE FUNCTION` 等脚本语句 | 只规范空白：行内连续空白压成一个空格，删除行尾空白，换行不变；只有开头的关键字（如 `ANALYZE TABLE`）改大小写 |
| `ADD JAR`、`DFS`、`!`、`SOURCE` 等命令 | 命令名改大小写，后面的路径、URI、类名和参数原样保留 |
| 列定义形式的 `CREATE TABLE`、`CREATE VIEW`、`EXPLAIN`、`GROUPING SETS`、`TRANSFORM`、`UPDATE`、`DELETE`、`MERGE`、`GRANT`、`REVOKE`、FROM 开头的 multi-insert | 原样保留，并给出 warning（见下面的 `unsupportedSyntaxPolicy`）。列定义形式的 `CREATE TABLE` 可以用实验性的 Format Hive DDL 命令 |

语句中有语法错误时，只原样保留出错的那一段，其余部分照常格式化，并给出 warning。

## 配置

在 VS Code 设置中搜索 `sqlBeautify`。设置可以按工作区、文件夹或语言（`[sql]`、`[hive-sql]`）分别指定。

| 配置项 | 可选值 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `sqlBeautify.keywordCase` | `upper` / `lower` | `upper` | 关键字大小写 |
| `sqlBeautify.commaStyle` | `leading` / `trailing` | `leading` | 逗号放在行首或行尾 |
| `sqlBeautify.indentStyle` | `space` / `tab` | `space` | 缩进用 4 个空格或 tab；不受编辑器 `insertSpaces` 影响，`tabSize` 只决定 tab 的显示宽度 |
| `sqlBeautify.maxAlignWidth` | `1..500` | `150` | `AS` 与行尾注释参与对齐的最大代码宽度 |
| `sqlBeautify.caseWhenThenWrapLength` | `1..300` | `50` | CASE 收成一行的最大宽度，以及 `WHEN … THEN …` 换行的阈值 |
| `sqlBeautify.caseLayout` | `compactShort` / `expanded` | `compactShort` | `expanded` 时所有 CASE 都展开 |
| `sqlBeautify.unsupportedSyntaxPolicy` | `warn` / `preserve` / `bail_out` | `warn` | 遇到不支持的语法或语法错误时怎么办，见下 |

`unsupportedSyntaxPolicy`：

- `warn`：不支持的部分原样保留，其余照常格式化，在编辑器中给出 warning。
- `preserve`：与 `warn` 相同，但不显示 warning。手动执行 `SQL Beautify: Format SQL` 而文档因此没有变化时，会提示一次有几处未支持的区域。
- `bail_out`：只要有不支持的部分，整个文档（或选区）都不修改。

## 诊断与日志

- 编辑器诊断直接显示格式化器的消息，最多 200 个字符，可能包含 SQL 片段。
- 内部错误（含错误栈）写入输出面板的 `SQL Beautify` 通道。每次格式化的结果摘要按 debug 级别记录，用 `Developer: Set Log Level` 调到 Debug 后可以看到。
- 单个文档或选区最多 524,288 个字符（UTF-16 code units），超过时不修改。格式化出错或结果没法确认安全时，也不修改文档。

## 实验性命令

### Format Hive DDL

`SQL Beautify: Format Hive DDL (Experimental)`，快捷键 `Alt+Shift+L`。格式化选中的建表语句；没有选区时处理整个文档，这时文档里只能有这一条语句：

```sql
CREATE TABLE dw.t
(
     id        BIGINT COMMENT 'ID'
    ,user_name STRING COMMENT '用户名'
    ,location  STRING
)
PARTITIONED BY
(
     ds STRING
)
STORED AS ORC;
```

只接受 Hive `CREATE TABLE` 的一个子集：列定义与列 `COMMENT`，后面可以依次跟 `PARTITIONED BY (…)` 和 `STORED AS AVRO|ORC|PARQUET|RCFILE|SEQUENCEFILE|TEXTFILE`。带表 `COMMENT`、`ROW FORMAT`、`LOCATION`、`TBLPROPERTIES`、约束或默认值的语句，以及多条语句，都保留原文。输出使用 `keywordCase`、`commaStyle`、`indentStyle` 与 `maxAlignWidth`。CTAS 由普通的格式化命令处理，这个命令保留它的原文。

### Extract Hive DDL

`SQL Beautify: Extract Hive DDL (Experimental)`，快捷键 `Alt+Shift+;`。从选中的 SELECT 查询（可以带 WITH；没有选区时用整个文档）生成建表字段的草稿，替换原来的查询。例如 `select u.id, u.name as user_name, count(1) as cnt -- 次数` 加上 FROM、GROUP BY 子句，生成：

```sql
     id        __TYPE_REQUIRED__
    ,user_name __TYPE_REQUIRED__
    ,cnt       __TYPE_REQUIRED__ COMMENT '次数'
```

字段名取别名或列名，行尾注释变成 `COMMENT`。它不推断字段类型，`__TYPE_REQUIRED__` 需要手动替换。`SELECT *`、没有别名的表达式、重名字段，以及 UNION 各分支字段不一致时，不生成草稿；`INSERT … SELECT` 也不支持。

## 注意

- 复杂 SQL 格式化后请看一眼结果；已知的排版缺陷见 [架构文档](docs/technical/sql-formatter-architecture.md) 末尾。
- `${…}` 变量按"展开后不会带出未配对的引号、注释开头或分号"来处理。把一个字符串拆在两个变量里的写法（如 `${left},${right}` 展开成 `'a,b'`）格式化后可能改变展开结果。

[Release Notes](CHANGELOG.md)
