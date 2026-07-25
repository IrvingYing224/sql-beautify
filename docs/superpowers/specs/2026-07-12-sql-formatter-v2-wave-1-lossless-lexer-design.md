# SQL Formatter v2 Wave 1 Lossless Lexer Design

- 日期：2026-07-12
- 状态：已完成（历史设计基线）
- 分支：`codex/sql-formatter-v2-wave1`
- 基线：`c393ccc`
- 上位设计：`docs/superpowers/specs/2026-07-10-sql-formatter-v2-optimization-program-design.md`
- 前置决策：`docs/technical/adr/0001-v2-parser-backend.md`

## 1. 目标

Wave 1 实现项目自有、Hive-first、严格 source-preserving 的 TypeScript lexer，为 Wave 2 的 CST/dialect analysis 提供唯一 leaf stream。

本波次必须完成：

1. 按 UTF-16 code-unit offset 切分全部 source leaf；
2. 任意输入都满足 source reconstruction 和连续 span partition；
3. 字符串、quoted identifier、注释、参数、模板替换和未知片段保留原始 `raw`；
4. 参数、literal prefix、数值和多字符方言 operator 使用 maximal-munch；
5. unterminated lexical unit 产生稳定 diagnostic，但仍保留全部 source；
6. 建立 Hive-first corpus、方言 token、随机 conservation 和性能回归；
7. 暴露独立 v2 lexer API，但不接管当前 VS Code formatter。

## 2. 非目标

Wave 1 不实现：

- SQL grammar、CST、Pratt expression parser 或 clause ownership；
- keyword context、reserved-word 合法性或完整语法验证；
- Layout IR、renderer、formatter output 或 source map；
- VS Code command/provider/configuration；
- experimental DDL/Extract DDL；
- 当前 `lib/**` tokenizer 的替换或双向适配；
- 任何 runtime parser dependency；
- Wave 2 及以后才能证明的 token semantic equivalence。

`dt-sql-parser` 的角色已经关闭为 `rejected`。Wave 1 不重新打开 candidate 选型，也不复用其 token stream。

## 3. 信任边界

Wave 1 的产品输入是：

- JavaScript primitive `string`；
- TypeScript 定义的普通 lexer options；
- 项目内静态 dialect profile。

本波次不把以下内容当作产品安全边界：

- 恶意 Proxy；
- 状态型 getter；
- 被篡改的 JavaScript built-in；
- 主动 monkey-patch 项目模块；
- 不可信第三方 parser object。

代码必须处理普通无效 SQL、unterminated lexical unit 和自身异常，但不为刻意对抗型 JavaScript 对象增加复杂反射防御。

## 4. 固定架构

```text
SQL source string
  -> dialect lexical profile
  -> monotonic UTF-16 cursor
  -> maximal-munch scanners
  -> SourceLeaf[] + Diagnostic[]
  -> source/span invariant tests
  -> Wave 2 CST input
```

建议源码边界：

```text
src/core/lexer/
  token.ts                public leaf contracts
  character-class.ts      code-unit/code-point predicates
  lexical-profile.ts      Hive-first keyword/operator/literal capabilities
  lossless-lexer.ts       scanner orchestration and public API
  index.ts                lexer exports
```

职责要求：

- `character-class.ts` 不知道 SQL clause 或 formatter policy；
- `lexical-profile.ts` 只描述词法能力，不判断真实 construct；
- `lossless-lexer.ts` 只单向扫描，不建立 CST；
- `token.ts` 不引用 parser、layout、adapter 或第三方类型；
- `src/core/index.ts` 是独立 v2 public entry 的唯一聚合出口。

## 5. Public API

```ts
export interface LexOptions {
    readonly dialect?: Dialect;
}

export interface LexOutput {
    readonly leaves: readonly SourceLeaf[];
    readonly diagnostics: readonly Diagnostic[];
}

export function lexSql(source: string, options?: LexOptions): LexOutput;
```

规则：

- 默认 dialect 是 `hive`；
- dialect 只接受 Wave 0 canonical 值：`hive | generic | postgresql | mysql`；
- 不接受 `postgres` legacy alias；
- 空字符串返回空 leaves/diagnostics；
- `SourceLeaf.id` 从 0 连续递增；
- `SourceLeaf.raw` 必须直接来自 `source.slice(span.start, span.end)`；
- API 不格式化、normalize 或修改输入。

## 6. SourceLeaf channel contract

| Token kind | Channel | 说明 |
| --- | --- | --- |
| `keyword` | `code` | 仅保守 lexical hint，不代表上下文中一定是 clause |
| `identifier` | `code` | bare identifier |
| `number` | `code` | 原子 numeric literal |
| `operator` | `code` | dialect profile 中的 maximal operator |
| `punctuation` | `code` | comma、semicolon、dot、brackets 等 |
| `string` | `protected` | 包含 prefix 的完整 string literal |
| `quoted-identifier` | `protected` | backtick/double-quoted identifier |
| `parameter` | `protected` | `$1`、`:id`、`@name`、`${...}`；`?` 仅作为 hive/generic/mysql placeholder（PostgreSQL 中 `?` 是 operator） |
| `unknown` | `protected` | 未建模 code point，保留原文，不在 lexer 猜语义 |
| `line-comment` | `trivia` | 不包含行结束符 |
| `block-comment` | `trivia` | 完整或 unterminated comment |
| `whitespace` | `trivia` | 非换行 whitespace run |
| `newline` | `trivia` | `\r\n` 作为一个 leaf，或单独 `\r`/`\n` |

注释虽然属于 trivia，其 `raw` 仍不可改写。`protected` 表示未来 formatter 不得改变该 code-like leaf 的内部内容。

## 7. Lexer invariants

对任意 source：

1. `leaves.map(raw).join("") === source`；
2. 第一个 leaf 从 0 开始；
3. 相邻 leaf 满足 `left.span.end === right.span.start`；
4. 最后 leaf 的 end 等于 `source.length`；
5. `span.end > span.start`，不得产生空 leaf；
6. `raw.length === span.end - span.start`；
7. leaf id 与 source order 一致；
8. lexer cursor 每轮必须前进；
9. unknown input 也必须被 leaf 覆盖，不能丢弃；
10. diagnostic span 必须位于 source 范围内。

这些不变量由构造方式保证，并由测试统一验证；生产 lexer 不在每次调用后做额外 O(N) defensive reconstruction。

## 8. Tokenization precedence

每个 cursor 位置按以下优先级尝试：

1. CRLF/LF/CR；
2. horizontal/Unicode whitespace；
3. line/block comment；
4. dialect-specific prefixed/dollar/template literal；
5. quoted identifier/string；
6. number；
7. bare identifier/keyword；
8. registered multi-character operator；
9. named/positional parameter；
10. punctuation；
11. single code-point unknown leaf。

对共享首字符必须使用局部更具体优先级：

- PostgreSQL `$tag$...$tag$` 在 `$1` 前；
- `${...}` 在普通 `$` 处理前；
- `::` / `:=` 在 `:id` 前；
- `@>` / `@?` / `@@` 在 `@name` 前；
- `?|` / `?&` 在 bare `?` 前（PostgreSQL 中三者均为 operator；其他方言 bare `?` 可为 parameter）；
- `.5` 在 `.` punctuation 前；
- `_utf8mb4'...'`、`U&'...'`、`E'...'` 在 bare identifier 前。

## 9. Dialect lexical profiles

### 9.1 Hive（默认）

- single/double quoted string；
- backtick quoted identifier；
- `${name}` / `${hivevar:name}` parameter；
- decimal、exponent、hex、binary number；
- Hive/common operators，包括 `<=>`、`==` 和 bitwise operators；
- `--` 与 `/* ... */` comment；
- Hive/common structural keyword hint。

### 9.2 PostgreSQL

- single quoted string；
- double quoted identifier；
- `E'...'`、`U&'...'`、`X'...'`、`B'...'` 单引号 prefixed string；
- `U&"..."` Unicode quoted identifier（完整 leaf，channel=protected）；
- `$1` positional parameter（不含 bare `?` placeholder）；
- `$$...$$` / `$tag$...$tag$` dollar string；
- maximal operators 含 `::`、`:=`、`=>`、`->`、`->>`、`#`、`#>`、`#>>`、`@>`、`<@`、`?`、`?|`、`?&`、`@?`、`@@`、`!~*` 等；
- bare `?` 是 operator/code，不是 parameter；
- nested block comment；
- 标准 `--` 行注释（不要求 trailing whitespace）。

### 9.3 MySQL

- single/double quoted string；
- backtick quoted identifier；
- `_charset'...'`、`N'...'`、`X'...'`、`B'...'` 仅单引号 prefixed string；
- `0b...`、`0x...`；
- `@name`、`:name`、`?` parameter；
- `<=>`、`:=`、`->`、`->>` 等 operator；
- `#` line comment；
- `--` 行注释要求第二个 `-` 后为 whitespace 或 control character（如 `SELECT 1-- 2` 是注释，`SELECT 1--2` 不是）。

### 9.4 Generic

- SQL-standard single string / double quoted identifier；
- common parameter forms；
- conservative union of common operators；
- 不因为单词值识别 `MATCH_RECOGNIZE`、`PIVOT` 或其他 construct。

Profile 决定 token boundary，不决定语法合法性。Wave 2 才能结合上下文解释 keyword/operator。

## 10. String、identifier 与 comment scanning

- 支持 doubled quote escape；
- Hive/MySQL 以及 explicit escape string 支持 backslash + next code unit；
- quoted identifier 支持 doubled delimiter；
- `E'...'`、`U&'...'`、`N'...'`、`X'...'`、`B'...'`、`_charset'...'` 只接受单引号 string 形式，不得用双引号绕过 double-quote semantics；
- PostgreSQL `U&"..."` 形成一个完整的 `quoted-identifier` leaf；
- line comment 到换行前结束，换行另发 leaf；
- MySQL `--` 仅在第二个 `-` 后跟 whitespace/control 时成立；Hive/PostgreSQL/generic 使用标准 `--`；
- PostgreSQL nested block comment 使用 depth counter；
- 其他 profile 的 block comment 以首个 `*/` 结束；
- dollar string closing tag 必须与 opening tag 完全相同；
- scanner 不使用 `source.slice(cursor).match(...)` 扫描剩余全文。

## 11. Numeric literals

Wave 1 至少原子识别：

- integer / decimal；
- leading-dot / trailing-dot decimal；
- exponent 与 signed exponent；
- `0x` hexadecimal；
- `0b` binary；
- dialect prefixed quoted bit/hex literal。

正负号始终作为 operator，不并入 number。Numeric scanner 只消费能证明属于同一 literal 的字符；不负责数值范围或 SQL 类型合法性。

## 12. Diagnostics and recovery

稳定 diagnostic code：

- `LEX_UNTERMINATED_STRING`；
- `LEX_UNTERMINATED_QUOTED_IDENTIFIER`；
- `LEX_UNTERMINATED_BLOCK_COMMENT`；
- `LEX_UNTERMINATED_DOLLAR_STRING`；
- `LEX_UNTERMINATED_TEMPLATE`。

规则：

- severity 为 `error`；
- span 从 opening delimiter 到 source end；
- recovery 为 `preserve-target`；
- unterminated unit 仍形成一个 protected/trivia leaf 并消费到 EOF；
- 不因 `unknown` leaf 产生 warning；未知语法属于 Wave 2，而不是 lexer 猜测范围。

## 13. Keyword policy

Wave 1 只建立保守 keyword registry，用于区分明显结构词和普通 identifier。

- keyword matching 大小写不敏感；
- raw 永远保持用户原始大小写；
- keyword kind 不触发任何 casing mutation；
- dotted identifier、function name和 keyword-shaped identifier 的语义由 Wave 2 决定；
- `MATCH_RECOGNIZE` 等低置信词不在 lexer 中声明真实 construct。

## 14. Build and execution boundary

Wave 1 TypeScript runtime tests使用项目本地 `tsc` 编译到：

```text
.tmp/v2-core/
```

新增独立 build config 和清理脚本：

- `tsconfig.v2.build.json`；
- `scripts/build-v2-core.js`。

约束：

- build 前清理旧 `.tmp/v2-core`；
- 不依赖 Node 原生 TypeScript stripping；
- 不新增 npm dependency；
- `src/**`、build scripts、tests、tsconfig 和 `.tmp/**` 不进入 VSIX；
- 当前 `package.json.main` 保持 `./extension.js`；
- `lib/**` 不导入 v2 source/build output。

## 15. Testing strategy

### 15.1 Contract and targeted tests

- public API type-check；
- token kind/channel/id/span；
- empty source；
- CRLF/LF/CR；
- Unicode/emoji UTF-16 offsets；
- string/comment/quoted identifier preservation；
- unterminated diagnostics；
- parameter/literal/operator maximal-munch；
- dialect-specific quote and operator behavior。

### 15.2 Corpus conservation

复用 Wave 0 的 16-case Hive-first corpus：

- 每个 case 必须 source-conserve；
- 每个 `atomicLexemes` 值必须由一个完整 leaf 承担；
- invalid/opaque SQL 也必须完整切分，不要求 lexer 拒绝语法。

### 15.3 Deterministic fuzz

使用固定 seed 组合 keyword、identifier、Unicode、literal、comment、operator、parameter、CRLF 和 unknown code point，验证：

- termination；
- reconstruction；
- span partition；
- deterministic output。

不新增 property-testing dependency。

### 15.4 Performance

- 100/800/1200 statement synthetic Hive input；
- warm-up 后 median；
- 800/100 scale ratio 不超过 12x；
- 输出时间与 process peak RSS（`process.resourceUsage().maxRSS`，同进程累计峰值）作为 Wave 1 baseline；
- scanner 不允许按 token 重新扫描 source prefix/full source。

## 16. Shipping boundary

Wave 1 完成后：

- 当前 SQL formatter 输出必须完全不变；
- v2 lexer 不注册 command/provider/configuration；
- VSIX 仍只包含当前 `extension.js`、`vkbeautify.js`、`lib/**` 和现有资源；
- `.tmp/v2-core` 仅用于本地/CI 测试；
- Wave 2 只能消费 canonical `SourceLeaf[]`，不能绕过 lexer 直接切 source。

## 17. 完成条件

1. `lexSql()` API 与 strict type contracts 通过；
2. 全部 source conservation/span invariants 通过；
3. Wave 0 corpus atomic lexemes 全部成为单 leaf；
4. Hive-first targeted cases通过；
5. PostgreSQL/MySQL/generic 边界 regression 通过；
6. unterminated unit 产生 diagnostic 且不丢 source；
7. deterministic fuzz 通过；
8. 100/800/1200 performance gate 通过；
9. `npm run test:v2:wave0` 继续通过；
10. `npm run test:v2:wave1` 通过；
11. `npm run test:verify` 通过；
12. VSIX content boundary 通过；
13. `extension.js`、`vkbeautify.js`、`lib/**` 无 diff；
14. 不实现 Wave 2/CST/layout/adapter；
15. 独立 reviewer 无 Critical/Important。
