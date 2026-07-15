# SQL Formatter v2 Wave 2 CST、Dialect 与 Analysis Implementation Plan

- 日期：2026-07-12
- 状态：待执行
- 工作目录：`/Users/yingirving/Documents/sql-beautify/.worktrees/sql-formatter-v2-wave2`
- 分支：`codex/sql-formatter-v2-wave2`
- 基线：`c9b9014`
- 设计：`docs/superpowers/specs/2026-07-12-sql-formatter-v2-wave-2-cst-dialect-analysis-design.md`

## 1. 执行策略

Wave 2 必须按 2A、2B、2C、2D、2E 顺序执行，每个子波次完成后停止，由独立 reviewer 验证。当前第一轮只执行 **2A**；不得提前实现 query parser、Pratt parser、trivia binding、analysis indexes 或 layout。

原因：Wave 2 是 v2 中语法风险最高的一层。先冻结 typed CST、dialect registry 和 structural token table，能在 query grammar 开始前发现 range、delimiter、statement boundary 和 capability authority 的根本问题。

所有子波次遵循：

1. 先写能命中真实缺口的 red test；
2. 记录红灯命令、失败断言和退出码；
3. 实现最小完整能力；
4. targeted test 绿灯；
5. 运行此前全部 Wave 0/1/2 gates；
6. 检查 runtime/VSIX/Git boundary；
7. 停止并交付报告；
8. 实现者和 reviewer 不创建 commit；主 Codex 验证通过且 reviewer 的 Critical/Important 清零后，自主创建聚焦 checkpoint；不合并、不推送。

## 2. 全局硬约束

- 开始前完整阅读根 `AGENTS.md`、Wave 2 design、v2 umbrella design、Wave 1 design、parser ADR 和 `docs/technical/sql-formatter-architecture.md`；
- 保持 `main`、Wave 0、Wave 1 worktree 不变；
- 禁止修改 `extension.js`、`vkbeautify.js`、`lib/**`、`package-lock.json`；
- 禁止修改当前 `docs/technical/sql-support-matrix.md`；
- 禁止注册 VS Code command/provider/configuration；
- 禁止实现 Layout IR、renderer、format output、DDL 或 adapter；
- 禁止新增 dependency；
- 禁止导入 `dt-sql-parser`、parser evaluation adapter、`lib/**`、`vscode`、`adapters` 或 `experimental`；
- 禁止 re-lex source、按 substring 再 tokenize 或扫描 protected leaf 内部；
- 禁止暴露 mutable `Map`、`Set`、backing array 或 registry mutator；
- 禁止从 `src/core/index.ts` value-export parser/registry/analysis helper；Wave 2 root runtime keys 仍只能是 `lexSql`；
- 禁止运行 `npm run evaluate:v2:parser`、任何 `--write` evidence 命令或重写 Wave 0 evidence；
- 本地测试和 VSIX 打包不设置代理；
- 实现者和 reviewer 不创建 git commit；只有主 Codex 可在当前子波次通过完整验证和独立审查后创建聚焦 checkpoint；不改写历史。

## 3. 预期文件边界

### 允许修改

- `package.json`
- `src/core/index.ts`（仅 type export）
- `src/core/syntax/node.ts`
- `src/core/syntax/parser-backend.ts`
- `src/core/lexer/lexical-profile.ts`（仅为 dialect registry 提供内部只读 view；不得改变 Wave 1 token behavior）
- `tests/v2/contracts.type-test.ts`
- `tests/v2/wave1-boundary.test.js`（仅在新目录边界需要时最小扩展）
- `.vscodeignore`（仅在现有规则确实不能排除新文件时修改）

### 计划新增

```text
src/core/dialects/
  types.ts
  registry.ts
  index.ts

src/core/syntax/
  leaf-range.ts
  token-table.ts
  cursor.ts
  node-factory.ts
  invariants.ts
  parser.ts
  statement-parser.ts
  query-parser.ts
  expression-parser.ts
  type-parser.ts
  recovery.ts
  index.ts

src/core/analysis/
  types.ts
  structural-index.ts
  trivia-binding.ts
  analyze.ts
  index.ts

tests/fixtures/
  v2-cst-cases.js

tests/v2/
  cst-contracts.type-test.ts
  dialect-capability-registry.test.js
  syntax-token-table.test.js
  syntax-invariants.test.js
  hive-cst-parser.test.js
  expression-parser.test.js
  recovery-opaque.test.js
  trivia-binding.test.js
  analysis-index.test.js
  wave2-corpus.test.js
  wave2-performance.test.js
  wave2-boundary.test.js

scripts/
  generate-v2-support-matrix.js

docs/technical/
  sql-formatter-v2-support-matrix.md
```

不是每个子波次都创建以上全部文件。若职责可以保持单一且文件较短，可合并相邻内部 helper；不得为了减少文件数制造 parser/registry/analysis 巨型模块，也不得创建无逻辑的 facade。

## 4. Preflight

在 Wave 2A 开始前执行并记录：

```bash
pwd
git branch --show-current
git rev-parse --short HEAD
git status --short
git rev-list --count c9b9014..HEAD
git diff --name-status c9b9014 -- extension.js vkbeautify.js lib package-lock.json
npm run typecheck:v2
npm run test:v2:wave1
git diff --check
```

预期：

- cwd 为 Wave 2 worktree；
- branch 为 `codex/sql-formatter-v2-wave2`；
- HEAD 为 `c9b9014`，ahead count 为 0；
- 除本 design/plan 外无未解释改动；
- runtime/package-lock diff 为空；
- Wave 1 baseline 通过。

若不满足，停止，不清理或覆盖用户改动。

---

# Wave 2A：CST Foundation

## 5. Task 2A-1：冻结 LeafRange 与 typed CST contracts

### 测试先行

新增 `tests/v2/cst-contracts.type-test.ts`，更新 `tests/v2/contracts.type-test.ts`。Red tests 至少证明：

- `LeafRange` 使用 end-exclusive leaf indexes；
- `SyntaxNode` 是 exhaustive discriminated union；
- program/statement/query/cte/clause/relation/list/list-item/expression/case-branch/window-spec/type-expression/opaque 均有独立类型；
- node 共享 `id/kind/span/leafRange`；
- structured container 有 readonly children，opaque 无 children；
- alias 使用 typed `AliasInfo | null`；
- list separators、expression operators 和 clause head/body 使用 leaf id/range，不保存 raw text；
- 任意 metadata bag、legacy node shape 和非法 enum 由 `@ts-expect-error` 拒绝；
- `ParserBackend` 仍返回 canonical `ParseOutput`；
- root runtime import 仍只有 `lexSql` value。

先运行：

```bash
npm run typecheck:v2
```

预期：FAIL，原因必须是新契约尚不存在，不得用故意语法错误制造红灯。

### 实现

修改/新增：

- `src/core/syntax/leaf-range.ts`
- `src/core/syntax/node.ts`
- `src/core/syntax/parser-backend.ts`
- `src/core/syntax/index.ts`
- `src/core/index.ts`（types only）

实现要求：

- 使用 design 第 7 节的 typed families；
- 不使用 `any`、`unknown` metadata、string-index signature 或 class hierarchy；
- optional fact 优先使用显式 `null`，避免含义不清的 absent/undefined 分叉；
- `StructuredSyntaxKind` 与 union 同源，不维护手写重复 enum；
- 不新增 root runtime value export。

绿灯：

```bash
npm run typecheck:v2
npm run build:v2-core
node - <<'NODE'
var core = require('./.tmp/v2-core/index.js');
var assert = require('assert');
assert.deepStrictEqual(Object.keys(core).sort(), ['lexSql']);
console.log('Wave 2A root runtime surface OK');
NODE
```

## 6. Task 2A-2：建立 dialect capability registry

### 测试先行

新增 `tests/v2/dialect-capability-registry.test.js`。Red tests 覆盖：

- canonical dialect 只有 `hive/generic/postgresql/mysql`；
- unknown dialect 明确拒绝，不回退 generic；
- registry lookup 大小写策略明确且不接受 `postgres` alias；
- capability state 仅为 `recognized/structured/formatted/verbatim/diagnostic`；
- Wave 2A 不得有任何 `formatted` capability；
- 设计列出的 Hive query construct 在 2A 当前只能是 `recognized`，只有对应 parser 与测试落地后才能原位升级为 `structured`；
- Hive DDL、MERGE、MATCH_RECOGNIZE table construct、PIVOT/UNPIVOT 为 `verbatim` 或 `diagnostic`；
- keyword-shaped function/identifier 不因 registry entry 自动成为 construct；
- syntax operator semantics 的 key 必须存在于对应 lexical operator view；
- registry/static arrays/runtime lookups 返回真实冻结数组：`Array.isArray` 为 true，类型与运行时一致，直接或间接修改失败或不产生变化（不要求 `push` 属性必须不存在）；
- caller 修改返回对象/数组不能改变后续 lookup；
- registry 不 import `lib/**` 或 parser evaluation；
- `src/core/index.ts` 不泄漏 registry runtime API。

先 build 后运行，预期 FAIL：

```bash
npm run build:v2-core
node tests/v2/dialect-capability-registry.test.js
```

### 实现

新增：

- `src/core/dialects/types.ts`
- `src/core/dialects/registry.ts`
- `src/core/dialects/index.ts`

必要时最小修改 `src/core/lexer/lexical-profile.ts`，只增加内部只读 lexical view。要求：

- lexical token boundary 数据不复制到 dialect registry；
- registry 组合 lexical view 与 syntax facts；
- static data 在模块初始化时校验并冻结；
- public query 返回 immutable value/copy 或只读 lookup method，不返回 backing `Map/Set/Array`；
- operator precedence/associativity 的详细表可在 2C 补全，2A 只定义 typed contract 和已知 shared keys；
- capability id 使用稳定 kebab-case；
- capability state 表达“当前已实现状态”，不得把 2B/2C 计划写成 `structured`。

绿灯：

```bash
npm run typecheck:v2
npm run build:v2-core
node tests/v2/dialect-capability-registry.test.js
npm run test:v2:lexer
```

Wave 1 lexer leaves/diagnostics 必须 byte-for-byte/field-for-field 不漂移。

## 7. Task 2A-3：建立 structural token table

### 测试先行

新增 `tests/v2/syntax-token-table.test.js`。测试必须通过 `lexSql()` 获取 leaves，不手造可绕过 lexer 的 product path。至少覆盖：

- empty、trivia-only、semicolon-only、连续 semicolon；
- previous/next code leaf 和 code ordinal；
- `()`、`[]` matching 与 depth；
- protected string/comment/quoted identifier 中的 `();[]` 不参与结构；
- CRLF、emoji 的 source span 不漂移；
- top-level statement segmentation；
- parenthesized subquery 内 semicolon 不切 document statement；
- line/block comment 中 semicolon 不切 statement；
- unmatched closer、unmatched opener 和 mixed delimiter 产生 stable structural issue；
- statement boundary 不可靠时不继续猜测后续顶层分割；
- `<`/`>` 默认是 operator，不在全局 token table 伪装成 type delimiter；
- range-to-span 对 empty/non-empty range 正确；
- 每个 query method 不泄漏 mutable backing storage；
- 同一 input 重复构建结果 deterministic；
- 100k leaves targeted probe 不出现 per-query full scan。

Red command：

```bash
npm run build:v2-core
node tests/v2/syntax-token-table.test.js
```

### 实现

新增：

- `src/core/syntax/token-table.ts`
- `src/core/syntax/cursor.ts`

实现要求：

- bounded multi-pass O(n)（adjacency / delimiter / statement 等职责可分趟，总时间与空间 O(n)）；
- code adjacency/depth/matching/statement ranges 共用同一 table；
- query interface 用 leaf index，越界输入明确拒绝；
- cursor 只移动 leaf/code position，不复制数组；
- comment/trivia 跳过必须保持原 leaf index；
- structural issue 使用 typed internal record，不提前伪造 Wave 2D diagnostic；
- parser depth 与 type-angle context 不在 2A 猜测；
- 不读取 protected leaf raw 的内部字符。

绿灯：

```bash
npm run typecheck:v2
npm run build:v2-core
node tests/v2/syntax-token-table.test.js
node tests/v2/lossless-lexer.test.js
```

## 8. Task 2A-4：建立 foundation invariant validator

新增：

- `src/core/syntax/invariants.ts`
- `tests/v2/syntax-invariants.test.js`

2A validator 先验证可在无 parser 情况下证明的内容：

- leaf range bounds；
- range-to-span；
- root empty/full-source special case；
- id uniqueness/contiguity；
- parent containment、sibling order/no overlap；
- cycle/shared child；
- owner references in range；
- opaque no children；
- table delimiter pair symmetry/depth consistency。

测试必须包含正例与 fail-closed 反例，不只测试 validator 自己构造的 happy path。普通非法 object 返回 structured invariant failures，不向外抛；恶意 Proxy/getter 不属于产品边界，不增加 Wave 0 evaluation adapter 式反射加固。

运行：

```bash
npm run typecheck:v2
npm run build:v2-core
node tests/v2/syntax-invariants.test.js
```

## 9. Task 2A-5：接入 scripts、boundary 与 aggregate gate

修改：

- `package.json`
- `tests/v2/wave2-boundary.test.js`
- 必要时 `.vscodeignore`

新增 scripts：

```json
{
  "test:v2:wave2-foundation": "npm run build:v2-core && node tests/v2/dialect-capability-registry.test.js && node tests/v2/syntax-token-table.test.js && node tests/v2/syntax-invariants.test.js && node tests/v2/wave2-boundary.test.js",
  "test:v2:wave2": "npm run test:v2:wave2-foundation"
}
```

将 `npm run test:v2:wave2` 加入 `test:verify`，只出现一次。后续子波次扩展 aggregate，不反复追加多个 Wave 2 entry。

`wave2-boundary.test.js` 至少验证：

- root runtime keys 仍仅 `lexSql`；
- `syntax/dialects` 不依赖 forbidden layers；
- current runtime 不 import `src`/`.tmp/v2-core`；
- no new dependency/package-lock change；
- VSIX 排除 `src/scripts/tests/docs/.tmp/tsconfig.v2*` 和 evaluation dependencies；
- package main 不变；
- Wave 0/1 scripts 仍存在且 aggregate 不遗漏；
- source tree 不包含 layout/renderer/adapter/DDL implementation changes。

## 10. Wave 2A 完整验证与停止条件

串行执行：

```bash
npm run typecheck:v2
npm run test:v2:wave0
npm run test:v2:wave1
npm run test:v2:wave2
npm run test:verify
npm run package:vsix
npm exec -- vsce ls --tree
git diff --check
git status --short --branch
git diff --name-status c9b9014 -- extension.js vkbeautify.js lib package-lock.json
git rev-list --count c9b9014..HEAD
```

检查精确 VSIX artifact：

```bash
unzip -Z1 vscode-sql-beautify-v1.0.13.vsix | rg '(^|/)(src|scripts|tests|docs|\.tmp|\.superpowers)/|tsconfig\.v2|node_modules/(typescript|esbuild|dt-sql-parser)|\.ts$'
```

预期无匹配。若版本变化，以 `package.json.version` 计算 artifact 名，不硬编码复用旧包。

Wave 2A 完成后必须停止。Ready for Wave 2B 需要：

- Critical 0；
- Important 0；
- contracts/registry/token table/invariants 全部通过；
- Wave 1 lexer output 未漂移；
- runtime/package/VSIX boundary 通过；
- 未出现 query parser、Pratt、analysis、layout 代码；
- 无 commit。

---

# Wave 2B：Hive Statement/Query/Clause CST

## 11. Task 2B-1：建立 parser fixtures 和 node factory

新增 `tests/fixtures/v2-cst-cases.js`，每个 case 明确：

- dialect/mode/source；
- expected statement/query/clause/list/relation kinds；
- expected opaque ranges/diagnostics；
- expected comment leaves 但暂不要求 binding；
- required node source slices；
- fully structured / partially opaque / target-preserved expectation。

覆盖 Wave 0 Hive cases，并增加 multi-statement、empty statement、no-FROM、set operation、nested CTE、join/subquery、lateral view outer/posexplode、insert overwrite partition。

新增 `node-factory.ts`，node id、span 和 leaf range 只能通过 factory 创建；parser 不手写 span。新增 parser-level invariant tests。

## 12. Task 2B-2：document/statement/query parser

新增 `parser.ts`、`statement-parser.ts`、`query-parser.ts`。要求：

- internal `parseSql()` 必须调用 `lexSql()`；
- lex diagnostics 原样保留并按 recovery 阻止不安全 parse；
- document/statement/fragment mode 行为符合 design；
- WITH/CTE、SELECT、parenthesized query、set operation；
- unknown statement 降级，不抛；
- query parser fully consumes bounded statement/query range。

## 13. Task 2B-3：clause、relation 与 list boundaries

实现 typed clause/relation/list/list-item：

- SELECT list；
- FROM/table/subquery/table function；
- JOIN variants 与 ON；
- LATERAL VIEW / OUTER / EXPLODE / POSEXPLODE；
- WHERE、GROUP BY、HAVING、WINDOW；
- ORDER/CLUSTER/DISTRIBUTE/SORT BY、LIMIT；
- alias/head/body/separator facts；
- `INSERT OVERWRITE TABLE ... PARTITION ... SELECT`。

2B expression body 只在边界完整时创建 `OpaqueNode(boundary=expression/list-item)`，capability 保持 `recognized` 或 `verbatim`，不得标 `structured expression`。

## 14. Task 2B-4：query CST tests 与首个性能 baseline

新增 `hive-cst-parser.test.js`、`wave2-corpus.test.js` 和初始 `wave2-performance.test.js`。验证：

- complete source leaves preserved；
- node/source ranges、containment、no shared child；
- clause context false positives；
- every unstructured expression explicitly opaque；
- parser never scans string/comment content；
- 100/800/1200 baseline 记录，不先虚构绝对门槛；scale ratio disaster gate <= 12x。

扩展 `test:v2:wave2`，完成后停止并独立 review。

---

# Wave 2C：Pratt Expression Parser

## 15. Task 2C-1：operator semantics registry

在 dialect registry 中补齐 prefix/infix/postfix、precedence、associativity 和 compound word operator。测试必须证明：

- semantics key 是 lexical operator/keyword capability 子集；
- longest lexical token 已在 Wave 1 原子化；
- precedence/associativity 无重复冲突；
- dialect 不错误继承 operator；
- parser 不维护第二份 switch precedence table。

## 16. Task 2C-2：Pratt core 与 bounded consumption

新增 `expression-parser.ts`，先覆盖 atom、qualified identifier、literal、parameter、unary、binary、parenthesized、list。每个 parse 调用必须接受明确 end boundary 并 fully consume；剩余 token 触发当前安全边界 opaque，不静默成功。

## 17. Task 2C-3：CASE/call/cast/type/subquery/window

新增/完善：

- searched/simple CASE 与 branch nodes；
- function/collection call、DISTINCT args；
- CAST 与 `type-parser.ts`；
- nested type argument/member；
- IN/subquery/EXISTS；
- OVER/PARTITION/ORDER/frame；
- select alias、order modifier facts。

覆盖 Hive 生产形态与 PostgreSQL JSON/`::`/array、MySQL variables/prefixed literals、generic array shared subset。未声明 syntax 继续 opaque。

新增 `expression-parser.test.js`，更新 capability state 只把真实通过的能力改为 `structured`。完成后停止并 review。

---

# Wave 2D：Recovery、Opaque 与 Trivia

## 18. Task 2D-1：分层 recovery

新增 `recovery.ts` 和 `recovery-opaque.test.js`：

- expression/list/clause/statement/target 同步点；
- missing body、unexpected comma/operator、unmatched delimiter；
- previous valid statement 可继续，boundary 不可靠时 target preserve；
- diagnostics stable、sorted、deduplicated；
- every opaque range 可从 leaves 精确重建；
- no partial trusted tree on invariant failure。

## 19. Task 2D-2：context-aware unsupported recognition

覆盖：

- `match_recognize(a)` function 正例；
- `MATCH_RECOGNIZE (...)` relation construct；
- identifier/alias `qualify/pivot/merge`；
- real clause/table/statement construct；
- depth 和 predecessor context；
- 不基于 raw regex 或 word value alone。

## 20. Task 2D-3：trivia binding

新增 `trivia-binding.ts` 和 tests：

- leading/trailing/dangling；
- comment after select item/comma/semicolon；
- CTE/container dangling；
- comment-only lines与 blank line；
- nested query/CASE/window；
- opaque comment owner；
- every comment exactly one binding；
- raw unchanged。

## 21. Task 2D-4：depth/fuzz hardening

- depth 255 通过；
- depth 256 边界确定；
- depth 257 产生 `SYN_MAX_DEPTH_EXCEEDED` 并安全恢复；
- deterministic malformed-input fuzz；
- no throw/no hang/source conservation；
- 不增加 Proxy/getter 对抗测试。

完成后停止并 review。

---

# Wave 2E：Analysis、Matrix 与 Closure

## 22. Task 2E-1：一次性 structural indexes

新增 `analysis/types.ts`、`structural-index.ts`、`analyze.ts`、tests。建立 design 第 14 节全部 indexes。要求：

- 单次 node/leaf traversal；
- query interface 不泄漏 mutator；
- parent/statement/clause/list/separator/trivia/delimiter/line/span/capability 一致；
- offset lookup 使用 binary search 或等价 bounded 方法，不建立 source-length 大小的重复对象表；
- analysis 不重新 parse 或重新绑定 grammar。

## 23. Task 2E-2：generated v2 support matrix

新增 `scripts/generate-v2-support-matrix.js` 和 `docs/technical/sql-formatter-v2-support-matrix.md`：

- `--write` 显式生成；
- `--check` 默认验证；
- output 只来自 registry；
- Wave 2 不出现 `formatted`；
- 不覆盖 1.x matrix；
- package/VSIX 排除文档与 generator。

允许在本任务执行一次明确的 `--write` 生成初始 committed artifact；最终验证只运行 `--check`。

## 24. Task 2E-3：性能、corpus 与 boundary closure

固化：

- 100/800/1200 median 和 maxRSS；
- scale ratio <= 12x；
- 相对已提交 2B baseline 无解释退化 <= 20%；
- deep CTE、nested expression、long comment；
- Wave 0 16-case + production-shaped Hive corpus；
- all invariants、determinism 和 opaque preservation。

最终 `test:v2:wave2` 必须 build 一次后串行运行全部 Wave 2 tests；`test:verify` 只包含一个 Wave 2 aggregate entry。

## 25. Wave 2 最终验证矩阵

```bash
npm run typecheck:v2
npm run test:v2:parser-corpus
npm run test:v2:parser-harness
npm run test:v2:dt-parser
npm run test:v2:parser-report
npm run verify:v2:parser-evidence
npm run test:v2:wave0
npm run test:v2:wave1
npm run test:v2:wave2
npm run test:verify
npm run package:vsix
npm exec -- vsce ls --tree
git diff --check
git status --short --branch
git diff --name-status c9b9014 -- extension.js vkbeautify.js lib package-lock.json
git rev-list --count c9b9014..HEAD
```

不得运行 parser evidence write。

## 26. 独立 review 清单

Reviewer 只读，不修改文件、不提交，重点检查：

1. parser 是否只消费 canonical leaves；
2. protected leaf 是否被内部扫描；
3. node range/span/identity/tree invariants；
4. keyword-shaped identifier false positive；
5. recovery 是否越过安全边界；
6. opaque 是否有精确 range/reason/diagnostic；
7. operator precedence 是否只有 registry 一份权威；
8. comment/separator ownership 是否唯一；
9. indexes 是否重复全表扫描或暴露 mutator；
10. capability/matrix 是否夸大能力；
11. depth/fuzz/performance 是否真实；
12. runtime/package/VSIX boundary。

结论必须分 Critical/Important/Minor，并明确 `Ready to close Wave 2: Yes/No`。

## 27. 每个子波次交付报告格式

1. 工作目录、分支、HEAD、ahead count；
2. 本次只执行哪个子波次；
3. 修复前 red evidence；
4. 根因/设计落实；
5. 实际改动文件；
6. contract/behavior/invariant 结果；
7. recovery/opaque/source preservation 证据；
8. performance 数据（适用时）；
9. 完整验证命令与退出码；
10. VSIX 内容与 forbidden scan；
11. runtime/package-lock diff；
12. git status；
13. reviewer findings；
14. 下一子波次 readiness；
15. 明确声明未创建 commit、未改写历史。

## 28. Wave 2 最终完成定义

以 design 第 19 节为唯一关闭标准。测试全绿但存在以下任一情况仍不得关闭：

- expression 未 fully consume；
- unknown token 被静默跳过；
- opaque range 无法证明；
- statement boundary 不可靠却继续格式化；
- parser 或 analysis 重新扫描 protected raw；
- dialect/parser/support matrix 存在第二权威；
- runtime root API 泄漏内部 registry/parser；
- 复杂度接近 O(n²)；
- Critical/Important 未清零；
- current runtime 或 VSIX 边界漂移。

## Wave 2A validator responsibility split (post-closure)

Production invariants (`src/core/syntax/{invariants,cst-invariants,token-table-invariants,token-table-expected}.ts`):

- Validate real CST topology and project-internal `StructuralTokenTable` **valid-domain** facts.
- Canonical expected statement ranges / delimiter issues are derived independently (`token-table-expected.ts`), never shared with `buildStructuralTokenTable` results.
- Illegal-input rejection sampling is **fixed O(1)** (one representative per input class: trivia, protected, negative, non-integer, out-of-range). No per-trivia throw/catch on the hot path.
- Dense array exactness for `structuralIssues` / `statementRanges` (no holes, ordered multi-set, frozen snapshots).

Test-only API audit (`tests/v2/wave2a-token-table-hardening.test.js` and related):

- Exhaustive or expanded misuse matrices against the **real** table implementation (fractional indexes, channel misuse, empty-table `codeWordsEqual`, sparse collections).
- Must not be folded back into production per-leaf validation.

Performance gate: `tests/v2/syntax-invariants-performance.test.js` — ~100k–120k leaves, validation median ≤ max(500ms, table-build median × 20).
