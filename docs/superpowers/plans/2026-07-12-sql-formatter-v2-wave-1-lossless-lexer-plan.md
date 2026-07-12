# SQL Formatter v2 Wave 1 Lossless Lexer Implementation Plan

- 日期：2026-07-12
- 状态：待确认后执行
- 工作目录：`/Users/yingirving/Documents/sql-beautify/.worktrees/sql-formatter-v2-wave1`
- 分支：`codex/sql-formatter-v2-wave1`
- 基线：`c393ccc`
- 设计：`docs/superpowers/specs/2026-07-12-sql-formatter-v2-wave-1-lossless-lexer-design.md`

## 1. 交付目标

在不修改当前 formatter runtime 的前提下，实现并验证第一方 Hive-first lossless lexer：

- strict TypeScript runtime implementation；
- exact source reconstruction；
- UTF-16 contiguous spans；
- protected/trivia/code channel；
- parameter/literal/operator maximal-munch；
- stable lexical diagnostics；
- deterministic corpus/fuzz/performance gates；
- independent v2 build/test entry。

## 2. 全局约束

- 开始前完整阅读 `AGENTS.md`、Wave 1 design、umbrella design 和 formatter architecture；
- 保持 `main`、Wave 0 分支和当前 1.x runtime 不变；
- 禁止修改 `extension.js`、`vkbeautify.js`、`lib/**`、`lib/experimental/**`；
- 禁止注册 VS Code command/provider/configuration；
- 禁止实现 CST、parser、layout、renderer 或 adapter；
- 禁止引入 runtime/development dependency；
- 不复用 `dt-sql-parser` token stream；
- 不用全局 regex 对完整 source 做反复 rewrite；
- 不为 Proxy/恶意 getter/monkey-patch 构建防御系统；
- 测试和 build 串行执行；
- 使用 `apply_patch` 修改文件；
- 完成验证前不提交 commit；
- 不运行网络命令。

## 3. 预计文件范围

### 新增

- `tsconfig.v2.build.json`
- `scripts/build-v2-core.js`
- `src/core/lexer/character-class.ts`
- `src/core/lexer/lexical-profile.ts`
- `src/core/lexer/lossless-lexer.ts`
- `src/core/lexer/index.ts`
- `tests/v2/lossless-lexer.test.js`
- `tests/v2/lossless-lexer-performance.test.js`
- `tests/v2/wave1-boundary.test.js`

### 修改

- `.vscodeignore`
- `package.json`
- `src/core/lexer/token.ts`
- `src/core/index.ts`
- `tests/v2/contracts.type-test.ts`
- `tests/v2/wave0-boundary.test.js`

### 禁止修改

- `package-lock.json`（本波次不新增依赖）
- Wave 0 ADR/evaluation report/scripts/tests
- 当前 runtime 与用户文档
- support matrix（Wave 2 才建立 v2 capability registry）

若实现需要超出上述范围，先说明原因并重新检查是否越过 Wave 1 边界。

## 4. Task 0：基线和红线检查

执行：

```bash
git status --short --branch
git rev-parse --short HEAD
npm run typecheck:v2
npm run test:v2:wave0
npm run test:verify
git diff --name-status HEAD -- extension.js vkbeautify.js lib
```

期望：

- branch 为 `codex/sql-formatter-v2-wave1`；
- HEAD 为 `c393ccc`；
- 除已确认的 Wave 1 design/plan 外无其他改动；
- Wave 0 和 1.x 全绿；
- runtime diff 为空。

## 5. Task 1：先冻结 lexer public contract

### 5.1 扩展 type test

先在 `tests/v2/contracts.type-test.ts` 使用尚不存在的：

- `LexOptions`；
- `LexOutput`；
- `lexSql` value export。

覆盖：

- 默认/显式 dialect options；
- readonly leaves/diagnostics；
- canonical `SourceLeaf`；
- invalid dialect 的 `@ts-expect-error`。

### 5.2 红灯

```bash
npm run typecheck:v2
```

期望因 lexer API 尚不存在而失败。

### 5.3 最小契约实现

- 在 `lossless-lexer.ts` 定义 `LexOptions`、`LexOutput` 和 `lexSql`；
- 在 lexer/index 与 core/index 导出 type 和 value；
- 暂时允许空实现只为 type-check，但不要在本 Task 声称 runtime 完成。

### 5.4 绿灯

```bash
npm run typecheck:v2
```

## 6. Task 2：建立可重复 v2 build/test entry

### 6.1 Build config

新增 `tsconfig.v2.build.json`：

- extends `tsconfig.v2.json`；
- `noEmit: false`；
- rootDir 为 `src`；
- outDir 为 `.tmp/v2-core`；
- 不编译 tests；
- 不生成 declaration/source map；
- 保留全部 strict options。

### 6.2 Build script

`scripts/build-v2-core.js` 必须：

- 使用 `fs.rmSync(..., { recursive: true, force: true })` 清理旧 output；
- 通过 `require.resolve('typescript/bin/tsc')` 使用项目本地 TypeScript；
- 使用 `child_process.spawnSync(process.execPath, [...])`；
- 原样转发 stdio；
- 正确透传非零退出码。

### 6.3 Package scripts

增加：

- `build:v2-core`；
- `test:v2:lexer`；
- `test:v2:lexer-performance`；
- `test:v2:wave1`。

`test:v2:wave1` 只 build 一次，再顺序运行 runtime、performance 和 boundary tests。

### 6.4 Shipping exclude

- `.vscodeignore` 排除所有 `tsconfig.v2*.json`；
- 更新 Wave 0 boundary regex，确保 build config 不进入 VSIX；
- 不包含 `.tmp/v2-core`。

### 6.5 验证

```bash
npm run build:v2-core
node -e "const core=require('./.tmp/v2-core/core/index.js'); console.log(typeof core.lexSql)"
```

期望输出 `function`。

## 7. Task 3：先建立统一 invariant test helper

在 `tests/v2/lossless-lexer.test.js` 实现测试侧 helper：

- `assertConservesSource(source, output)`；
- `assertSingleLeaf(source, dialect, raw, kind?, channel?)`；
- `leafSignature(output)`。

`assertConservesSource` 必须验证 design 第 7 节全部不变量，不只比较 join 结果。

先加入空 source、普通 `SELECT 1`、CRLF、中文和 emoji case。此时 runtime 测试应红灯，证明 placeholder lexer 尚不满足契约。

```bash
npm run build:v2-core
node tests/v2/lossless-lexer.test.js
```

## 8. Task 4：实现 character classes 和 leaf emitter

### 8.1 Character helpers

`character-class.ts` 负责：

- ASCII digit/hex/binary；
- identifier start/continue；
- Unicode code-point width；
- whitespace/newline；
- quote/operator candidate predicates。

不得包含 dialect keyword/operator tables。

### 8.2 Leaf emitter

`lossless-lexer.ts` 内部 emitter：

- cursor/start/end 使用 UTF-16 offset；
- raw 统一由 `source.slice(start, end)` 生成；
- id 自动递增；
- 拒绝 `end <= start`；
- scanner 每轮必须前进，否则发一个 unknown code-point leaf。

### 8.3 首批绿灯

完成：

- whitespace/newline；
- bare identifier/conservative keyword；
- decimal number；
- punctuation；
- unknown code point。

验证基础 conservation cases 通过。

## 9. Task 5：实现 lexical profiles 与 maximal operators

`lexical-profile.ts` 必须提供只读、静态 profile：

- default Hive；
- generic；
- PostgreSQL；
- MySQL。

每个 profile 至少包含：

- double quote 语义；
- backtick 支持；
- hash comment；
- nested block comment；
- dollar string；
- parameter forms；
- prefixed literal forms；
- keyword set；
- 按长度降序的 operator list。

新增 targeted red/green cases：

- Hive `<=>` / `==`；
- PostgreSQL `!~*`、`?`、`?|`、`?&`、`@?`、`@@`、`@>`、`<@`、`::`、`:=`、`=>`、`#`；
- MySQL `<=>`、`:=`、`->>`；
- shared-prefix operator 必须选择最长值；
- 未注册 operator 不得因 generic character run 被随意合并。

## 10. Task 6：实现 protected lexical units

按小步 TDD 顺序实现：

1. single/double quoted string；
2. backtick/double quoted identifier；
3. line comment；
4. normal/nested block comment，以及 MySQL `--` 需 trailing whitespace/control 的 profile 策略；
5. PostgreSQL dollar string；
6. Hive `${...}` template parameter；
7. `$1`、`:id`、`@name`、`?`；
8. `E'...'`、`U&'...'`、`U&"..."`（PG quoted-identifier）、`_utf8mb4'...'`、单引号 bit/hex literal；
9. exponent/hex/binary/leading-dot/trailing-dot number。

每个实现都必须同时断言：

- 单一 leaf；
- exact raw；
- kind/channel；
- span；
- source reconstruction；
- 相邻 token 不被吞并。

不得先写一个包含全部 SQL token 的大测试后一次性实现。

## 11. Task 7：实现 lexical diagnostics

先增加五类 unterminated 红灯：

- string；
- quoted identifier；
- block comment；
- dollar string；
- template parameter。

实现后验证：

- unit 消费到 EOF；
- leaf raw 未丢失；
- diagnostic code/severity/span/recovery 稳定；
- 每个 unit 只产生一条直接 diagnostic；
- unknown leaf 不产生 diagnostic。

## 12. Task 8：复用 Wave 0 corpus

遍历 `tests/fixtures/v2-parser-evaluation-cases.js`：

- 所有 16 case source-conserve；
- 每个 atomic lexeme 由一个 leaf 精确承担；
- invalid/opaque case 只检查 lexical invariants，不要求 syntax status；
- PostgreSQL/MySQL case 使用对应 canonical dialect；
- parser corpus 不得被复制成第二份 fixture。

如果某个 atomic lexeme 无法单 leaf，先修 lexer/profile，不降低断言。

## 13. Task 9：deterministic fuzz

使用固定 seed 的本地 PRNG，生成至少 500 个组合输入，片段池覆盖：

- Hive keywords/identifiers；
- 中文和 emoji；
- CRLF/LF；
- strings/comments；
- quoted identifiers；
- parameters/templates；
- operators/numbers；
- unknown symbols；
- terminated/unterminated units。

每个输入运行两次，断言：

- output deep-equal；
- source/span invariants；
- 无 hang/throw。

不要使用时间或系统随机数作为 seed。

## 14. Task 10：performance baseline

`lossless-lexer-performance.test.js`：

- 使用 production-shaped Hive statement；
- 生成 100/800/1200 statement source；
- 每个规模先 warm-up；
- 取至少 7 次 median；
- 每次结果验证 leaf reconstruction；
- 输出 chars、leaves、medianMs、ratio、processPeakRssKb（同进程累计峰值，非每规模独立峰值）；
- 800/100 ratio <= 12；
- 1200/100 ratio 使用宽灾难门槛 <= 18；
- 不对亚毫秒绝对值设置脆弱阈值。

若 100-case 测量过小，单次 sample 内重复 lex 同一规模固定次数，并用总字符量解释结果。

## 15. Task 11：Wave 1 boundary

新增 `tests/v2/wave1-boundary.test.js`，验证：

- `src/core/lexer/**` 不导入 `lib/**`、adapters、experimental 或 parser evaluation；
- lexer 不依赖 `dt-sql-parser`、esbuild、VS Code；
- current runtime 不导入 `src/**` 或 `.tmp/v2-core`；
- package main 仍为 `./extension.js`；
- package scripts 中 Wave 1 顺序正确；
- build output/source/config/scripts/tests 不进入 VSIX；
- `package-lock.json` dependency graph 未因 Wave 1 增加包。

把 `test:v2:wave1` 接入 `test:verify`，但保留 `test:v2:wave0` 独立可运行。

## 16. Task 12：targeted 和完整验证

按顺序执行：

```bash
npm run typecheck:v2
npm run build:v2-core
node tests/v2/lossless-lexer.test.js
node tests/v2/lossless-lexer-performance.test.js
node tests/v2/wave1-boundary.test.js
npm run test:v2:wave0
npm run test:v2:wave1
npm run test:verify
npm run package:vsix
npm exec -- vsce ls --tree
git diff --check
git status --short --branch
git diff --name-status c393ccc -- extension.js vkbeautify.js lib
```

VSIX 必须：

- 包含全部现役 runtime；
- 不包含 `src/**`、`scripts/**`、`tests/**`、`docs/**`、`.tmp/**`；
- 不包含 `tsconfig.v2*.json`；
- 不包含 TypeScript/esbuild/dt-sql-parser runtime files；
- 文件数/大小不因 Wave 1 source 增长。

## 17. 独立终审

启动独立只读 reviewer，重点检查：

- cursor 是否严格前进且近线性；
- UTF-16/emoji span；
- prefix/operator precedence；
- unterminated recovery；
- dialect profile 是否越权做 syntax 判断；
- corpus atomic lexeme 是否真实来自一个 leaf；
- 是否复制 1.x tokenizer 结构性缺陷；
- 是否意外接管 current runtime；
- VSIX 是否泄漏 v2 source/build；
- 测试是否存在自证或脆弱 timing gate。

无 Critical/Important 才可报告完成。

## 18. 完成报告

最终必须报告：

1. 实际修改文件；
2. public API 和 channel contract；
3. dialect lexical matrix；
4. targeted/corpus/fuzz 数量；
5. diagnostics 行为；
6. 100/800/1200 baseline；
7. 完整验证退出结果；
8. VSIX 内容边界；
9. runtime diff；
10. reviewer findings；
11. 明确说明未实现 CST/layout/adapter；
12. 不创建 commit，等待用户验收。
