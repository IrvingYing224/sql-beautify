# SQL Formatter v2 Wave 3 Layout 与 Renderer Implementation Plan

- 日期：2026-07-16
- 状态：执行中
- 工作目录：`/Users/yingirving/Documents/sql-beautify/.worktrees/sql-formatter-v2-wave3`
- 分支：`codex/sql-formatter-v2-wave3`
- 基线：`c4369e9`（Wave 2E closure）
- 设计：`docs/superpowers/specs/2026-07-16-sql-formatter-v2-wave-3-layout-renderer-design.md`

## 1. 执行策略

Wave 3 严格按 3A、3B、3C、3D、3E、3F 推进。每个 checkpoint 都执行：

1. 先增加能命中真实缺口的 red test，并记录失败原因；
2. 实现当前 checkpoint 的完整契约，不用测试特判绕过；
3. 串行运行 targeted、此前 Wave 3、Wave 0/1/2 与 1.x gates；
4. 检查 root runtime、1.x runtime、package-lock、VSIX 与 Git boundary；
5. 由独立只读 reviewer 审查，Critical/Important 必须为 0；
6. 主 Codex 创建单一聚焦 commit，然后直接进入下一 checkpoint。

用户已授权自主推进和自主委派，不再要求每个 checkpoint 人工确认。任何 checkpoint
若出现未解决 Critical/Important、基线退化、1.x runtime diff 或 provenance/等价性失败，
则不得提交，也不得进入下一 checkpoint。Wave 5 完成前不 merge `main`，本计划不 push。

## 2. 全局硬约束

- 开工前完整阅读根 `AGENTS.md`、Wave 3 design、v2 umbrella design、Wave 2 design 和
  `docs/technical/sql-formatter-architecture.md`；
- 禁止修改 `extension.js`、`vkbeautify.js`、`lib/**`、`package-lock.json`；
- 禁止修改当前 1.x formatter 行为、VS Code provider/command/configuration 或 DDL；
- 禁止新增 runtime/development dependency；
- 禁止导入 `lib/**`、`vscode`、parser-evaluation adapter、`dt-sql-parser`、adapter 或
  experimental DDL；
- `src/core/index.ts` 在 Wave 3 仍只能 value-export `lexSql`；新增 export 只能是 type；
- layout 不得 re-lex、按 substring tokenize、扫描 protected raw、维护 keyword/operator/
  clause/capability word set，或从 node kind/raw 重建 parser facts；
- renderer 不得导入 parser、analysis、dialect registry 或 SQL policy；
- 禁止 arbitrary SQL/whitespace string LayoutDoc、post-render regex、trim、marker restore 和
  whole-output diff；
- 所有失败必须 fail closed：`failed/preserved` 返回原始目标，不泄漏 partial text/map；
- 不运行 `npm run evaluate:v2:parser` 或任何 `--write` evidence 命令；
- 本地测试和 VSIX 打包不设置代理；真实网络操作才配置 `ALL_PROXY`；
- `.tmp/v2-core` 是 worktree 内共享 build 目录。同一 worktree 严禁并发运行任何包含
  `build:v2-core` 的命令；reviewer 运行测试时主代理只做只读源码审查，不重建 `.tmp`；
- 生成的 `.vsix` 仅用于检查，checkpoint 提交前删除且不得 stage；
- `node_modules` 是当前 worktree 按 lockfile 建立的项目本地环境，保持 ignored，不进入
  status/commit，也不与其他 worktree 共用符号链接。

## 3. 预期目录与职责

现有文件允许按职责修改：

```text
src/core/
  analysis/{analyze,structural-index,types}.ts
  api/format-result.ts
  config/options.ts
  dialects/{registry,types}.ts
  layout/doc.ts
  syntax/{node,node-factory,cst-invariants,cst-container-invariants}.ts
  syntax/{parser,statement-parser,query-parser,relation-parser}.ts
  syntax/{expression-parser,list-parser,type-parser,window-parser}.ts
  index.ts                         # types only
```

计划新增的聚焦模块：

```text
src/core/analysis/artifact.ts      # canonical AnalysisArtifact proof
src/core/layout/doc-factory.ts     # canonical immutable LayoutDoc graph
src/core/layout/artifact.ts        # LayoutArtifact provenance
src/core/layout/invariants.ts      # doc ownership/coverage/resource validation
src/core/layout/plan.ts            # direct-address LayoutPlan and conflict rules
src/core/layout/compiler.ts        # monotonic gap cursor compiler
src/core/layout/policy.ts          # registry-gated policy orchestration
src/core/layout/alignment-policy.ts # renderer-column alignment proof
src/core/layout/dialect-policy.ts   # shared registry-gated transaction
src/core/layout/query-policy.ts
src/core/layout/expression-policy.ts
src/core/layout/trivia-policy.ts
src/core/renderer/display-width.ts
src/core/renderer/unicode-width-data.ts # pinned Unicode 15.1 subset tables
src/core/renderer/metrics.ts
src/core/renderer/render.ts
src/core/renderer/types.ts
src/core/api/format.ts             # internal orchestration; no root value export
src/core/config/resolve-options.ts
```

文件可以在职责短小且耦合更低时合并，但不得形成同时拥有 parser facts、layout policy 和
render loop 的巨型模块，也不得创建只转发而无边界价值的 facade。

主要测试文件：

```text
tests/v2/wave3a-contracts.type-test.ts
tests/v2/wave3a-contextual-facts.test.js
tests/v2/wave3a-layout-invariants.test.js
tests/v2/wave3b-renderer.test.js
tests/v2/wave3b-format-kernel.test.js
tests/v2/wave3c-hive-query-layout.test.js
tests/v2/wave3d-expression-layout.test.js
tests/v2/wave3e-trivia-layout.test.js
tests/v2/wave3e-alignment-options.test.js
tests/v2/wave3e-dialect-layout.test.js
tests/v2/wave3e-option-matrix.test.js
tests/v2/wave3-properties.test.js
tests/v2/wave3-performance.test.js
tests/v2/wave3-boundary.test.js
tests/fixtures/v2-layout-cases.js
```

## 4. Preflight

开始 3A 前串行执行并记录：

```bash
pwd
git branch --show-current
git rev-parse HEAD
git status --short
git rev-list --count c4369e9..HEAD
git diff --name-status c4369e9 -- extension.js vkbeautify.js lib package-lock.json
npm run typecheck:v2
npm run test:v2:wave2
git diff --check
```

预期 branch 为 `codex/sql-formatter-v2-wave3`，HEAD 为 `c4369e9`，ahead 为 0；只有本
design/plan 与 ignored `node_modules`；runtime/package-lock diff 为空；Wave 2 通过。

---

# Wave 3A：Contextual Facts、IR 与 Provenance Contracts

## 5. Task 3A-1：冻结 contextual occurrence 与 CST marker contracts

### Red tests

修改 `tests/v2/contracts.type-test.ts`，新增
`tests/v2/wave3a-contracts.type-test.ts` 与
`tests/v2/wave3a-contextual-facts.test.js`。先证明以下缺口确实存在：

- `SyntaxNodeBase` 缺 typed `syntaxMarkers/capabilityId/formatRole`；
- `RelationNode` 缺 `nameLeafRange`，`ClauseNode` 缺 direct separators；
- `StructuralIndex` 无对每个 leaf 都可用的 O(1) contextual facts 查询；
- `SELECT window AS order FROM group` 中真实语法词与 keyword-shaped identifier/name 不可区分；
- CTE `AS`、JOIN head、set operator、CASE、window、LATERAL VIEW marker 无稳定 owner；
- CASE/WHEN/THEN/ELSE/END、window/type markers 与多词 part ordinal必须可直接区分；
- no-FROM SELECT 与含 FROM SELECT 必须拥有不同 query-level authority，SELECT clause不能
  继续把 `select-without-from` 当通用 capability；
- word operator/builtin type 没有 keyword-case proof，user type/identifier 又不能被误转换；
- quoted relation name 的 protected channel、relation role 与 opaque ownership 必须可正交表达；
- clone/mutable/sparse/duplicate marker、跨 range marker 和 protected marker 必须被拒绝。

Red commands：

```bash
npm run typecheck:v2
npm run build:v2-core
node tests/v2/wave3a-contextual-facts.test.js
```

### 实现

修改：

- `src/core/syntax/node.ts`
- `src/core/syntax/node-factory.ts`
- `src/core/syntax/{statement,query,relation,list,expression,type,window}-parser.ts`
- `src/core/syntax/cst-invariants.ts`
- `src/core/syntax/cst-container-invariants.ts`
- `src/core/analysis/types.ts`
- `src/core/analysis/structural-index.ts`
- `src/core/index.ts`（type export only）

要求：

- factory 是 marker/capability/range 冻结入口，parser call site 必须显式传已识别 facts；
- 不允许 factory 维护 `nodeKind -> capability` 第二映射；
- `syntaxMarkers` 只含 node 直接拥有 grammar markers，记录 finite/registry-owned syntaxId、
  multiword partOrdinal、syntaxRole 与 keywordCaseEligible，严格递增且唯一；CASE/window/type
  optional markers 必须精确 identity，layout 无需看 ordinal gap/raw；
- alias/relation/type/CTE name 使用 explicit range，不能以 lexical keyword kind 代替；
- structural index 用 one CST traversal 构建 dense direct-address leaf-context table；
- direct owner 固定为显式 typed owner优先、否则最深 direct-gap owner；同深度歧义失败；
- occurrence 冲突、未覆盖 marker、错误 owner/capability 均使 analysis fail closed；
- SourceLeaf kind/channel、CommentBinding、syntaxRole 与 opaqueOwnerNodeId 分开保存；
- Opaque 范围内部不产生 syntax keyword transform proof，但 comment/protected identity不丢；
- `formatRole` 明确 capability/intrinsic-container/intrinsic-primitive/opaque，null capability
  不能被视为默认 formatted。
- SELECT clause 改为 null-capability intrinsic container；只有真实 no-FROM QueryNode 使用
  `select-without-from`，含 FROM QueryNode 使用 `from` authority。

## 6. Task 3A-2：冻结 capability 与 operator occurrence identity

### Red tests

扩展 `dialect-capability-registry.test.js`、`expression-parser.test.js` 和
`wave3a-contextual-facts.test.js`：

- `OperatorSemantics` 必须有 dialect-local stable `id`、nullable `capabilityId`、`formatClass`；
- PostgreSQL `@>`、`::`，MySQL `->>`，Hive `NOT BETWEEN`/`IS NOT NULL` 保留完整 occurrence；
- compound/special operator leaf order、fixity、format class 与 capability 精确；
- clause/JOIN/set occurrence 可直接回查 capability；
- clone semantics、unknown capability、同 leaf 双 ownership、raw-key fallback 均拒绝；
- formatted ancestor + non-formatted PG/MySQL operator 使完整 owner expression verbatim；
- registry validator 接受 `formatted` 作为 `structured` 的后继，但本 task 不升级任何行为状态。

### 实现

修改：

- `src/core/dialects/types.ts`
- `src/core/dialects/registry.ts`
- `src/core/syntax/node.ts`
- `src/core/syntax/node-factory.ts`
- `src/core/syntax/expression-parser.ts`
- `src/core/analysis/{types,structural-index}.ts`
- `tests/v2/v2-support-matrix.test.js`

要求：

- shared operators 使用 stable semantics id 且 `capabilityId=null`；dialect-specific
  operator 在存在对应 registry capability 时直接引用既有
  `postgres-json-operators`、`postgres-type-cast`、`mysql-json-operators` 等能力；
- `formatClass` 使用有限 union，例如 prefix-word/prefix-symbol/infix-word/infix-symbol/
  postfix-word/postfix-symbol/attached，不嵌入 formatter callback；
- parser 在 match 成功时保留 canonical semantics identity，不在 factory 重新 lookup；
- expression 的每个 operator occurrence 关联 owner expression id 与完整 leaves；
- word operator occurrence 的每个 keyword leaf都有 case-eligible proof；
- intrinsic node/operator 只能继承最近 formatted authority，显式 non-formatted/opaque 边界阻断；
- non-null operator capability 未 formatted 时生成带 trigger identity 的 dominating range
  handle；任一未 formatted operator支配完整 owner expression；
- support matrix 仍显示 `structured`，不能提前声称 formatted。

## 7. Task 3A-3：建立 canonical AnalysisArtifact

### Red tests

扩展 `analysis-index.test.js`，新增 `wave3a-layout-invariants.test.js`：

- 当前 output 丢失 source/dialect/mode；
- wrong source、same-length source、wrong dialect/mode、root/leaves/index clone 必须失败；
- canonical parser -> analysis identity 保持；
- failed/preserved artifact 仍携带原始 provenance；
- 不允许通过 leaves raw join 伪造 source。

### 实现

新增/修改：

- `src/core/analysis/artifact.ts`
- `src/core/analysis/analyze.ts`
- `src/core/analysis/types.ts`
- `src/core/analysis/index.ts`
- `src/core/index.ts`（types only）

要求：

- `AnalysisArtifact` 保持 discriminated union：analyzed/preserved 始终有 index，failed 始终
  `index:null`，并共同含 source/dialect/mode/root/leaves/diagnostics；
- module-private WeakSet/WeakMap proof 绑定 canonical ParseArtifact 与 exact index；
- `analyzeSql/analyzeParseArtifact` 返回 canonical artifact；
- 现有调用/测试若使用 `AnalysisOutput`，以 compatible alias 平滑迁移，不保留 provenance-less
  production constructor；
- layout 只接受 canonical 且 status=`analyzed` 的 object identity；preserved/failed 由
  orchestration 直接返回 original text，不创建 LayoutArtifact。

在 LayoutArtifact 之前新增 `src/core/config/resolve-options.ts` 与 config contract tests：
resolver 负责 defaults、unknown key拒绝、enum/range、dialect一致性、异常 containment、deep
freeze 和 module-private canonical identity。LayoutArtifact 从 3A 起只接受该 resolver
产出的 options；字段相同的 plain clone 也必须拒绝。此处只建立配置契约，不改变
`package.json` 的 1.x defaults。

Resolver 对 allowed own enumerable string key 各读取一次；任何 unknown string key、symbol、
non-enumerable key、getter/Proxy/ownKeys/read failure 都返回稳定 config failure且不向外抛。

## 8. Task 3A-4：破坏性收紧 LayoutDoc 与 LayoutArtifact

### Red tests

type/runtime tests 必须先让以下构造变红：

- `{kind:'text', value:'DROP TABLE...'}` 与 whitespace string；
- naked `SourceSpan`、无 owner 或任意 in-bounds slice verbatim；
- protected/comment keyword transform；
- duplicate/missing/reordered leaf、overlap/nested verbatim；
- sparse/mutable/cyclic/shared doc graph；
- forged leaf/range, cross-source/cross-analysis artifact；
- wrong options dialect、noncanonical options、huge numeric whitespace amplification；
- illegal hard-line flat field、auto group without relative maxFlatWidth、flat/break group with
  width、zero/negative branded values；
- arbitrary line-suffix content、flat group + hard line/multiline raw leaf/verbatim；
- same doc/factory node reused across analysis artifacts；
- empty source fake leaf/verbatim。

### 实现

新增/修改：

- `src/core/layout/doc.ts`
- `src/core/layout/doc-factory.ts`
- `src/core/layout/artifact.ts`
- `src/core/layout/invariants.ts`
- `src/core/config/options.ts`
- `src/core/index.ts`（只读 type surface）

要求：

- source token 只能由 analysis-scoped leaf id 或 canonical range handle 引用；
- `createLayoutDocFactory(analyzedArtifact)` 用 WeakMap 将每个 source-derived doc node绑定
  exact analysis/factory identity，cross-analysis reuse fail closed；
- verbatim 必须绑定 exact owner node range，owner 只能是 opaque、未 formatted structured
  node或被未 formatted operator支配的完整 expression；handle保留 node/operator/capability
  trigger；preserved/failed analysis 不进入 layout；
- LayoutDoc graph 只能由 module-private canonical factory 生成并深冻结；
- Line/Group 使用真正 discriminated union；positive numeric brand 只能由 factory 产生；
- line-suffix 只保存 trailing comment leaf id 和受限 space/pad，不接受 child LayoutDoc；
- `LayoutArtifact` 绑定 exact AnalysisArtifact、doc、canonical options/diagnostics；
- invariant validator iterative、bounded、拒绝 cycle/shared identity；
- emission ledger 验证 code/protected/comment exactly once、source order、无 overlap；
- whitespace nodes 才能生成 whitespace；固定预算为 doc `24U+64`、actions `16U+64`、
  nesting `min(4096,U+64)`、indent `min(512,U+32)`、suffix `min(4096,U)`、generated
  columns/line `4U+256`、generated code units `32U+2S+4096`；append 前检查；
- every source leaf at most once，code/protected/comment exactly once；
- 此 checkpoint 不实现 renderer 或 SQL behavior。

## 9. Task 3A-5：boundary、aggregate 与完整验证

新增 `test:v2:wave3-foundation`，建立 `test:v2:wave3` aggregate。Boundary 至少断言：

- root runtime value keys 仍只有 `lexSql`；
- layout/renderer 不 import `lib/**`、vscode、adapter、experimental、evaluation；
- renderer 目录尚无 SQL parser/registry dependency；
- layout source 不出现 raw clause/operator/capability word sets；
- no arbitrary `text.value`/naked span doc contract；
- Wave 0/1/2 scripts 与 test:verify aggregate 不遗漏；
- VSIX 排除全部 v2 source/test/docs/build。

串行验证：

```bash
npm run typecheck:v2
npm run test:v2:wave0
npm run test:v2:wave1
npm run test:v2:wave2
npm run test:v2:wave3
npm run test:verify
npm run package:vsix
npm exec -- vsce ls --tree
git diff --check
git diff --name-status c4369e9 -- extension.js vkbeautify.js lib package-lock.json
```

独立 reviewer 必须确认 Wave 3 前置终审全部 contract 阻塞项已关闭，Critical/Important=0。
通过后删除 VSIX，创建：

```text
feat(v2): 建立Wave 3A布局契约
```

该 checkpoint commit 明确包含本 Wave 3 design 与 plan；它们不得持续 dirty 到后续波次。

---

# Wave 3B：Renderer、Source Map 与 Safe Compiler

## 10. Task 3B-1：renderer primitives

复用 3A canonical option resolver；不新增公开 `printWidth`，auto group 必须自带相对
`maxFlatWidth`。

实现 `display-width.ts` 与 `metrics.ts`，测试：

- ASCII、CJK、fullwidth 与 grapheme cluster：combining/VS16/ZWJ family/flag/keycap/skin tone；
- checked-in Unicode 15.1 subset tables + deterministic scanner；禁止 `Intl.Segmenter`/host ICU
  决定输出，未列入 code point保守宽度1；
- tab stop 4、CRLF 单换行、multiline leaf/verbatim；
- soft line empty/space、hard line、flat/break/auto group；
- indent 相对 level、align 相对列、pad-to-column 绝对列；
- budget内最大合法深度可 iterative measurement；>10k adversarial doc 被 iterative validator
  有界拒绝且无 call-stack overflow；
- context-independent summary memoized，每 doc node 至多常数次访问；tab 按 start-column
  context计算；pad/align/suffix 不进入 auto-group static flat width；
- auto group 比较相对 `flatWidth<=maxFlatWidth`，不混用 absolute output column；
- 同一 subtree 从 display column 0..3 与 nested align/pad/suffix 环境渲染结果正确。

## 11. Task 3B-2：iterative renderer 与 source map

新增 `renderer/types.ts`、`renderer/render.ts`、`wave3b-renderer.test.js`。

要求：

- explicit stack；chunks join once；
- renderer 只读取 canonical artifact，不 import SQL layers；
- source map 在 emission 同步建立，相邻连续 run 可合并；
- entries/output/source spans frozen、单调、不重叠；generated whitespace 无映射；
- keyword-case 长度保持且只作用于 occurrence case-eligible leaf（含 word operator/builtin type）；
- line suffix FIFO，在物理 line 前 flush；EOF line comment 无后续 syntax 时不凭空加 LF；
- multiline raw leaf/verbatim 使 flat 不可用；final-newline 在 emission 时遵守原 source；
- document/statement/fragment 都保留输入最终换行存在性；statement/fragment 不在目标 span
  外新增 leading/trailing newline，EOF comment 覆盖三种 mode；
- 每次 append 前检查 3A 固定预算，不泄漏 partial text/source map；
- wrong artifact、coverage 或 resource invariant 不抛到 public boundary。

## 12. Task 3B-3：LayoutPlan 与 monotonic compiler

新增 `layout/plan.ts`、`layout/compiler.ts`、`layout/policy.ts`。先实现 identity/safe leaf
compiler，再且只实现 Hive `select-without-from` 最小 behavior；在同一 checkpoint 用
behavior/golden/protected/idempotency 证据把该 capability 转为 `formatted`。其他 SQL behavior
从 3C 开始，禁止 test-only bypass。

Red/green 必须证明：

- dominating range 先注册并阻止 descendants；同 boundary 不兼容 claim 一律失败；
- unclaimed boundary 保留 original trivia，不做 raw lexical adjacency fallback；
- parent 只处理 child gaps，opaque 一次消费；
- 每 leaf visit/emission/lookup 计数在线性预算内；
- identity compiler 对 Wave 0/2 corpus 100% source round-trip；
- Hive `SELECT 1`/keyword-shaped identifier 正反例通过真实 formatted authority 验证
  keyword-case、spacing、source map 与 idempotency；
- protected/comment/opaque exact、non-trivia token equivalent；
- failed/preserved 始终 original text。

## 13. Task 3B-4：internal format orchestration 与 baseline

新增 `src/core/api/format.ts` 与 `wave3b-format-kernel.test.js`。内部 API 组合
resolve -> analyze -> plan -> doc -> validate -> render -> equivalence；不从 root value export。

建立首个 `wave3-performance.test.js` baseline，记录：

- 100/800/1200 statement median；
- source/output chars、leaf/node/doc/action count；
- leaf visit/emission/lookup count；
- maxRSS、Node/platform/arch/CPU；
- isolated child process maxRSS、absolute disaster gates；normalized time/input ratio <=1.5
  （800/100<=12x、1200/100<=18x）。

同步更新 v2 registry/generated matrix/tests，只把 Hive `select-without-from` 标为 formatted；
generic/PostgreSQL/MySQL 与其他 Hive capability 保持 structured/verbatim/diagnostic。

完整 gates/reviewer 通过后提交：

```text
feat(v2): 完成Wave 3B渲染内核
```

把该 commit SHA 固定为后续 3C–3F performance baseline。比较器必须从 Git object + Node
文件 API 物化 baseline source，不依赖 shell `tar`；CI 保持完整 history。后续
checkpoint current/baseline 中位数使用 `current/max(baseline,5ms)<=1.20`；baseline<5ms
另允许最多 +2ms absolute noise，除此之外无解释退化不得超过 20%。

---

# Wave 3C：Hive Query、Clause、Relation 与 List Layout

## 14. Task 3C-1：statements/query/clause policy

新增 `query-policy.ts` 与 Hive golden fixtures。按结构事实实现：

- multi statement、semicolon、final-newline preservation；
- WITH/CTE、SELECT/FROM/JOIN/LATERAL、WHERE/GROUP/HAVING/WINDOW/ORDER/
  CLUSTER/DISTRIBUTE/SORT/LIMIT；
- INSERT OVERWRITE TABLE/PARTITION/SELECT；
- parenthesized query、set query、no-FROM；
- bounded opaque 最小 verbatim。

禁止 clause word switch 重新识别输入；policy dispatch 只能使用 typed node、occurrence 与
capability state。

## 15. Task 3C-2：list/comma/relation layout

实现 query-level multiline、function/type/value structurally-flat-eligible policy、leading/trailing comma、
FROM/CTE direct separators、join ON/USING、qualified relation name/alias。测试包含 comment/
subquery/CASE 导致 break、keyword-shaped names、tab/space content column一致。

## 16. Task 3C-3：capability transition 与 checkpoint

只有 behavior + protected + golden + idempotency 全部通过的 Hive query capability 才从
`structured` 改为 `formatted`。同步：

- `src/core/dialects/registry.ts`
- `tests/v2/v2-support-matrix.test.js`
- `scripts/generate-v2-support-matrix.js`
- `docs/technical/sql-formatter-v2-support-matrix.md`

运行 current/baseline performance，<=1.20；完整 gates/reviewer 后提交：

```text
feat(v2): 完成Wave 3C Hive查询布局
```

---

# Wave 3D：Expression、CASE、Type、Collection 与 Window

## 17. Task 3D-1：registry-driven operator 与 expression policy

只消费 `OperatorOccurrence.formatClass/fixity` 实现 prefix/infix/postfix/attached spacing。
覆盖 shared/Hive/PostgreSQL/MySQL operator 正反例、nested boolean continuation、delimiter、
dot、subscript、function call。Boundary test 禁止 raw operator switch/table。

## 18. Task 3D-2：CASE、type、collection、window

实现：

- CASE expanded/compactShort 与唯一 metrics threshold；
- long THEN/ELSE、nested CASE、CASE in list；
- CAST、PostgreSQL `::`、Hive STRUCT/MAP/ARRAY、generic/PostgreSQL ARRAY subset；
- function args、IN/value collection、subquery expression；
- OVER/PARTITION/ORDER/frame 与 named window。

unknown/unformatted expression 最小 range verbatim，不能局部猜 spacing。

## 19. Task 3D-3：capability transition 与 checkpoint

只升级已具备四类证据的 expression capability。运行 golden、protected、equivalence、
idempotency、depth-256 和 current/baseline <=1.20。完整 review 后提交：

```text
feat(v2): 完成Wave 3D表达式布局
```

---

# Wave 3E：Trivia、Alignment、Dialects 与 Option Matrix

## 20. Task 3E-1：comment/blank line policy

新增 `trivia-policy.ts`，唯一消费 `CommentBinding` 和 line facts：

- leading/trailing/dangling；
- line suffix 和 line comment forced break；
- multiline block comment；
- 最多保留一个用户 blank line；
- protected/comment raw code-unit exact。

禁止从 comment raw 猜 placement，禁止 marker text。

## 21. Task 3E-2：AS/comment alignment 与 option matrix

使用同一 renderer metrics/pad-to-column 实现连续 single-line AS 与 trailing comment
alignment。测试 maxAlignWidth 边界、multiline/opaque group termination、CJK/emoji/tab；
覆盖 keywordCase/commaStyle/indentStyle/caseLayout/threshold/unsupported policy 的 pairwise
与关键 Cartesian 组合，断言每个 option 有真实行为而不是 dead config。

## 22. Task 3E-3：generic/PostgreSQL/MySQL proven subset

对共享 query/expression subset 增加 golden/protected/idempotency；dialect-specific operator
只在 occurrence 与 behavior 都有证据时 formatted。MERGE/PIVOT/UNPIVOT/QUALIFY/
MATCH_RECOGNIZE 与 Hive DDL 继续 diagnostic/verbatim，不夸大 matrix。

完整 performance/reviewer 后提交：

```text
feat(v2): 完成Wave 3E注释与方言布局
```

---

# Wave 3F：Closure

## 23. Task 3F-1：properties、corpus、fuzz 与 resource closure

扩展 `wave3-properties.test.js`、fixtures 与 fuzz：

- protected/comment/opaque exactness 100%；
- non-trivia token equivalence 100%；
- full corpus strict idempotency；
- deterministic doc/map/result；
- malformed artifact/doc/plan fail closed；
- deep CTE、depth-256 expression、budget内最大合法 graph；10k nested adversarial doc 有界
  拒绝且无 stack overflow；250k comment、comment-dense list；
- output/doc/action/resource count 线性有界；
- target preserve/failure original text。

## 24. Task 3F-2：performance 与 aggregate closure

串行运行：

```bash
npm run typecheck:v2
npm run test:v2:wave0
npm run test:v2:wave1
npm run test:v2:wave2
npm run test:v2:wave3
npm run test:verify
npm run package:vsix
npm exec -- vsce ls --tree
git diff --check
```

性能要求：3B baseline 三档按 ratio/floor 规则均通过；normalized time/input <=1.5；无
O(n²) 计数；在隔离 child process 记录环境与 maxRSS。禁止与 reviewer 并发 build。

## 25. Task 3F-3：shipping boundary 与最终 reviewer

核验：

- VSIX 精确包含全部现役 `lib/**`、`extension.js`、`vkbeautify.js`；
- 不含 `src/scripts/tests/docs/.tmp/tsconfig.v2`、v2 dependency runtime、`.ts`；
- `extension.js`、`vkbeautify.js`、`lib/**`、`package-lock.json` 相对 `c4369e9` 无 diff；
- root v2 runtime value keys 仍只有 `lexSql`；
- no Wave 4 adapter/provider/range transaction；
- no `.vsix`、`.tmp`、`node_modules` staged；
- support matrix 与 registry deterministic 一致；
- independent reviewer Critical=0、Important=0。

通过后删除 VSIX，创建：

```text
feat(v2): 完成Wave 3F布局收口
```

## 26. 每个 checkpoint 的 Git 与审查规则

- reviewer 只读，不修改、不 stage、不 commit；
- 主 Codex 在 reviewer 清零后再次检查 `git diff --check`、status 和 staging；
- commit 只包含当前 checkpoint 已验证文件；不混入主 worktree 的 `AGENTS.md` 或其他用户改动；
- commit message 使用本计划指定的中文 conventional commit；
- commit 后立即验证 HEAD、ahead、clean status，并记录 SHA；
- 不 amend/rebase/squash；若未来必须改写历史，先迁移 Wave 2B/3B performance anchors；
- 不 merge、不 push。

## 27. Wave 3 完成定义

只有设计第 19 节 20 项完成条件全部满足、3A–3F commits 均存在、最终 reviewer
Critical/Important=0、工作树干净且 1.x runtime 零 diff，才可宣布 Wave 3 完成并进入
Wave 4。任何“测试大部分通过”“只有手工 smoke”“matrix 先标 formatted 后补测试”都不算完成。
