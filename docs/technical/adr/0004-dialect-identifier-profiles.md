# ADR 0004：按方言限定裸标识符字符集并合并 unknown run

状态：接受

日期：2026-07-26

## 背景

lexer 已把 quote、literal、parameter、comment 和 operator 行为放进 `LexicalProfile`，但裸标识符仍
调用全局 ASCII-only predicate。结果是 PostgreSQL/MySQL 合法的 BMP/Unicode 字母标识符被逐码点发射
为 protected unknown leaf；Hive 中文裸名也为每个码点生成一个 leaf。后者虽应继续 preserve，却会
无意义放大 leafCount，并影响 direct/worker 双阈值的含义。

不能用 ECMAScript `ID_Start` / `ID_Continue` 同时代替各数据库 scanner contract；MySQL 的明确
unquoted range、PostgreSQL 的服务端编码行为和 Hive 的 quoted-name 要求并不相同。

## 决策

`LexicalProfile.identifierCharacters` 成为 identifier start/continue 的唯一方言入口：

- Hive 与 generic 继续使用 `[A-Za-z_]` start、`[A-Za-z0-9_$]` continue；裸 CJK 仍是 protected
  unknown，不宣称为结构化标识符；
- PostgreSQL 使用保守 UTF-8 子集：Unicode `Letter` 或 `_` 可 start；continue 只在 start 集合上
  增加 ASCII digit 和 `$`。combining mark、其他 Unicode number 和 emoji 不扩张；
- MySQL 按 MySQL 8.4 Reference Manual “Schema Object Names” 的 unquoted character range 建显式
  predicate：ASCII `[0-9A-Za-z$_]` 与 BMP `U+0080..U+FFFF`。排除 surrogate、supplementary code
  point、lexer whitespace 和 interior `U+FEFF`。纯数字仍由 number scanner 拥有；数字开头且包含
  非数字 identifier character 的连续 run 才是 identifier，合法 exponent/hex/binary 仍优先为 number；
- dollar-quote tag、charset introducer 和 named parameter 保持各自既有 ASCII grammar，不借用 SQL
  identifier profile 扩张协议。

连续、且下一个位置不能启动任何已知 leaf 的 unknown code point 合并为一个 protected leaf。合并只
改变 leaf 分区粒度，不改变 raw bytes、UTF-16 span、protected channel 或 formatter 的 verbatim 边界。

## 路由约束

unknown 合并会降低 leafCount，因此本决策与已落地的默认阈值共同验收：direct 必须同时满足
`source.length < 8_192` 与 `leaves.length < 2_000`。测试固定以下边界：

- 8,191-code-unit 连续 Hive unknown run 可 direct；8,192 必须 worker；
- 小于 8,192 但由 whitespace 分隔、达到 2,000 leaves 的 unknown runs 必须 worker；
- PostgreSQL/MySQL 连续 CJK identifier 小于两个阈值时可 direct；
- 512 Ki 独立 worker 门继续要求 `<10 s` 与 `<1.25 GiB maxRSS`。

M1 Pro / Node v24.18.0 的 9-sample direct p95 实测：8,191-unit Hive unknown 24.97 ms、7,007-unit
PostgreSQL CJK 20.16 ms、7,007-unit MySQL CJK 19.15 ms、8,014-unit large comment 20.35 ms，均低于
预设 150 ms 门。512 Ki worker 同轮为 4.11 s / 1,134,272 KiB maxRSS。

## 验证与后果

- lexer matrix 覆盖 CJK、combining mark、Unicode number、BMP/supplementary letter、emoji、invalid
  surrogate、whitespace、BOM、quoted identifier 和 MySQL digit-start ambiguity；
- formatter matrix 覆盖四方言 CJK 输出、alignment、token equivalence 与二次幂等；
- 30k/240k/360k code-point Hive unknown run 都严格为一个 leaf；中位数规模比为 7.96 / 12.26，
  保持线性；
- 如果未来扩大 PostgreSQL continue 或 MySQL supplementary 范围，必须引用对应 scanner/encoding
  证据，并重新运行 token-equivalence、route 和 direct p95 门；用户常见程度不能替代方言证据。
