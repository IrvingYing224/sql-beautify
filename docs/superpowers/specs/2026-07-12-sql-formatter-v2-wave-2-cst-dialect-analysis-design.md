# SQL Formatter v2 Wave 2 CST、Dialect 与 Analysis Design

- 日期：2026-07-12
- 状态：已批准（用户授权由 Codex 自主判断）
- 分支：`codex/sql-formatter-v2-wave2`
- 基线：`c9b9014`（Wave 1 checkpoint）
- 上位设计：`docs/superpowers/specs/2026-07-10-sql-formatter-v2-optimization-program-design.md`
- 前置设计：`docs/superpowers/specs/2026-07-12-sql-formatter-v2-wave-1-lossless-lexer-design.md`
- 前置决策：`docs/technical/adr/0001-v2-parser-backend.md`

## 1. 目标与核心决策

Wave 2 在 Wave 1 的 canonical `SourceLeaf[]` 上建立项目自有、Hive-first、formatter-oriented 的 lossless CST、dialect capability registry 和一次性 analysis indexes。

本波次只产出“结构事实”，不产出格式化文本。Wave 3 必须直接消费这些事实，不能重新扫描 SQL 字符串、重新猜测 clause/list/comment ownership，或另建第二套 operator/width 语义。

核心决策：

1. `dt-sql-parser` 保持 `rejected`，不得重新作为 runtime backend、oracle 或 token source；
2. parser 只能消费 `lexSql()` 产生的 canonical leaves，不得 re-lex、切片再 tokenize 或扫描 protected leaf 内部；
3. CST 只建模 formatter 需要的结构，不承担数据库完整语义、名称解析、类型推断或执行合法性验证；
4. Hive query 是第一方完整目标；Hive DDL 在 Wave 4 前只作为 statement-level opaque/verbatim；
5. generic、PostgreSQL、MySQL 只结构化 shared query subset 和已有 corpus 证明的 dialect expression；
6. 无法可靠解析的范围必须按可证明边界降级为 `OpaqueNode`，不得猜测；
7. Wave 2 拆为 2A–2E 五个硬检查点，每个检查点独立验证并停止，不允许一次性跨越全部 parser 层。

## 2. 子波次与停止点

### 2A：CST foundation

- 扩展 leaf-range 和 CST 类型契约；
- 建立 immutable dialect capability registry；
- 建立 code-leaf adjacency、delimiter/depth 和 statement segmentation 的有界多趟 O(n) 结构扫描；
- 不实现 query grammar 或 Pratt parser。

### 2B：Hive statement/query/clause CST

- multi-statement、WITH/CTE、SELECT、FROM/JOIN、LATERAL VIEW、filters、group/order/cluster/distribute/sort/limit；
- set operation；
- `INSERT OVERWRITE ... PARTITION ... SELECT`；
- expression body 暂可使用边界明确的 opaque expression，不得伪装为 structured。

### 2C：Pratt expression parser

- dialect-driven prefix/infix/postfix precedence；
- CASE、function call、CAST/type、collection、subquery、window；
- PostgreSQL/MySQL/generic 仅覆盖 registry 声明的 shared/dialect cases。

### 2D：Recovery、opaque 与 trivia ownership

- clause/list/expression/statement 同步恢复；
- context-aware unsupported construct recognition；
- leading/trailing/dangling comment binding；
- depth budget、malformed input 和 deterministic fuzz hardening。

### 2E：Analysis indexes 与 Wave 2 closure

- parent/statement/clause/list/separator/bracket/line/span/trivia/capability indexes；
- generated v2 support matrix；
- corpus、invariant、performance、boundary、VSIX 和完整回归；
- 独立只读 reviewer 无 Critical/Important 后才允许关闭 Wave 2。

任何子波次出现 Critical/Important 都必须停在当前检查点修复，禁止用后续子波次掩盖基础问题。

每个子波次的实现者和审查者都不得自行提交。主 Codex 完成独立验证且 reviewer 的 Critical/Important 清零后，应在 Wave 2 分支自主创建聚焦 checkpoint commit；这些 commit 始终留在 Wave 2 分支，完整长期程序结束前不合并 `main`。

## 3. 非目标

Wave 2 不实现：

- Layout IR、renderer、spacing、keyword case、comma、CASE layout 或 AS alignment；
- `formatSql()`、VS Code command/provider/config、range/multi-selection transaction；
- worker、cancellation 或 stale-document handling；
- experimental DDL/Extract DDL parser；
- 完整 Hive/PostgreSQL/MySQL grammar 或数据库语义验证；
- 旧 1.x output snapshot 兼容；
- 当前 `extension.js`、`vkbeautify.js`、`lib/**` runtime 的迁移或调用 v2；
- public root runtime API 的扩张。

## 4. 信任与 shipping 边界

产品输入仍是 JavaScript primitive `string`、canonical dialect 和项目内部静态 registry。Wave 2 必须安全处理普通无效 SQL、未闭合 delimiter、未知 construct、超深嵌套和自身 invariant failure，但不为恶意 Proxy、getter、monkey-patched built-in 或不可信第三方 parser object 增加反射防御。

Shipping 边界：

- `package.json.main` 保持 `./extension.js`；
- `src/**`、`tests/**`、`scripts/**`、`docs/**`、`.tmp/**` 和 `tsconfig.v2*.json` 不进入 VSIX；
- `extension.js`、`vkbeautify.js`、`lib/**` 和 `package-lock.json` 不因 Wave 2 变化；
- 不新增 dependency 或 runtime parser package；
- v2 仍只在 `.tmp/v2-core` 中构建并由本地/CI tests 消费。

## 5. 固定 pipeline

```text
source string
  -> lexSql(source, dialect)
  -> canonical SourceLeaf[]
  -> bounded multi-pass O(n) structural token table
       code adjacency
       delimiter pair/depth
       top-level statement ranges
  -> formatter-oriented CST
  -> recovery / opaque containment
  -> trivia binding
  -> one-time structural indexes
  -> Wave 3 layout input
```

依赖方向固定为：

```text
source/config/diagnostics
       ↓
lexer ← dialect lexical view
       ↓
dialects → syntax
             ↓
          analysis
```

禁止 `lexer`、`dialects`、`syntax` 或 `analysis` 导入 `layout`、`renderer`、`adapters`、`experimental`、`lib/**` 或 parser evaluation harness。

## 6. Leaf 与 source 不变量

Wave 1 的全部不变量继续成立，Wave 2 不复制或弱化它们：

1. `leaves.map(raw).join("") === source`；
2. leaf span 对 source 构成连续、无重叠、无遗漏的 UTF-16 partition；
3. string、quoted identifier、parameter、unknown 和 comment 的 `raw` 不可改写；
4. parser 不得拆分、合并、替换或重编号 leaf；
5. parser 不得把 keyword-shaped identifier 的 lexical hint 当作上下文语法结论；
6. `ParseOutput.leaves` 必须与 lexer output 在顺序、对象内容和 diagnostics 合并语义上保持一致；
7. 任意 node 的 source slice 必须只由其 leaf range 推导，node 不保存第二份 `raw`。

## 7. CST 契约

### 7.1 LeafRange

新增 end-exclusive leaf-index range：

```ts
export interface LeafRange {
    readonly start: number;
    readonly end: number;
}
```

- 它引用 `ParseOutput.leaves` 的数组下标，不引用 source offset；
- `0 <= start <= end <= leaves.length`；
- node 的 `span` 必须由非空 `leafRange` 的首尾 leaf 派生；
- 空 source/trivia-only program 可以使用 `{ start: 0, end: 0 }` 和 `{ start: 0, end: source.length }`；
- clause head/body 等内部边界允许空 range，但非 program syntax node 必须至少拥有一个 leaf。

### 7.2 Node families

`SyntaxNode` 使用严格 discriminated union，不使用 `Record<string, unknown>`、任意 metadata bag 或 optional field 堆叠。至少包含：

| Node | 必需结构事实 |
| --- | --- |
| `ProgramNode` | ordered statement children |
| `StatementNode` | `statementKind: empty/query/insert-query/opaque` |
| `QueryNode` | `queryKind: select/set/parenthesized`、set operator leaf ids |
| `CteNode` | name range、optional column list、query child |
| `ClauseNode` | `clauseKind`、head range、body range |
| `RelationNode` | table/subquery/join/lateral-view/table-function/opaque、alias |
| `ListNode` | list role、ordered members、separator leaf ids |
| `ListItemNode` | item role、value child、alias、modifier leaf ids |
| `ExpressionNode` | expression kind、operator leaf ids、ordered operands |
| `CaseBranchNode` | when/else branch、condition/value children |
| `WindowSpecNode` | partition/order/frame children |
| `TypeExpressionNode` | type name、argument/member children |
| `OpaqueNode` | reason code、proven boundary、no children |

所有 node 共享：

```ts
interface SyntaxNodeBase<K extends string> {
    readonly id: number;
    readonly kind: K;
    readonly span: SourceSpan;
    readonly leafRange: LeafRange;
}
```

结构化 container 才拥有 `children`。Alias 使用显式结构并以 `null` 表示不存在，不使用含义不明的 optional string：

```ts
interface AliasInfo {
    readonly keywordLeafId: number | null;
    readonly nameLeafRange: LeafRange;
}
```

### 7.3 Node invariants

必须统一验证：

1. root id 为 0，全部 node id 唯一、连续、确定；
2. root span 覆盖完整 source，root leaf range 覆盖全部 leaves；
3. node `span` 与 `leafRange` 指向同一 source slice；
4. children 按 source order 排列；
5. parent 包含 child；无祖先关系的 node 不得部分重叠；
6. siblings 不得重叠；
7. tree 不得出现 cycle 或 shared child；
8. separator/operator/head/body/alias 引用必须落在 owner node 范围内；
9. `OpaqueNode` 不得有 children，且其 range 必须可证明；
10. protected leaf 只能作为原子边界参与结构，不得读取其内部文本推导子结构；
11. parser success 不等于完整 structured；每个 opaque range 必须有 reason code 和对应 diagnostic/capability；
12. invariant failure 不向用户返回部分可信 tree，必须升级为 target-preserving internal diagnostic。

## 8. Structural token table

Wave 2A 建立一次性、只读查询接口，至少提供：

- previous/next code leaf；
- code ordinal 与 leaf index 映射；
- delimiter depth before/after leaf；
- matching `()` / `[]` delimiter；尖括号不在全局 table 中配对，只允许 2C type parser 在明确 type context 内建立局部 pair；
- top-level semicolon statement ranges；
- leaf range 到 source span；
- normalized word comparison helper，且只接受 code leaf。

实现要求：

- 有界多趟 O(n) 顺序扫描（adjacency / delimiter / statement 等职责可分趟），总时间与空间 O(n)；
- 不用 `leaves.filter(...)` 在每个 parser component 重建 code-token 数组；
- 公开查询返回真实 `readonly T[]`（`Array.isArray` 为 true）且运行时不可修改（`Object.freeze`）；不向调用方暴露可修改 `Map`、`Set` 或 mutable backing array；
- comment/string/quoted identifier 内的 punctuation 不参与 depth 或 statement segmentation；
- 未匹配 delimiter 形成稳定 structural issue，不抛异常；
- statement boundary 不可靠时不得假定后续 semicolon 一定是顶层同步点。

## 9. Dialect capability registry

### 9.1 单一权威来源

新增 `src/core/dialects/`。Registry 组合 Wave 1 内部 lexical profile 和 Wave 2 syntax capability：

- lexical profile 继续唯一拥有 token boundary、literal form 和 maximal operator 集；
- syntax registry 只增加 clause/construct/operator precedence/associativity/capability，不复制完整 keyword/operator 数组；
- syntax operator key 必须由测试证明存在于对应 lexical operator view；
- parser、analysis、Wave 3 policy、v2 support matrix 和 capability tests 必须消费同一 registry；
- 当前 1.x `lib/core/sql-*-registry.js` 不是 v2 source，不得导入或复制为运行时依赖。

### 9.2 Capability state

每个 dialect/construct 使用以下状态之一：

- `recognized`：可准确识别边界，但尚未建立完整 node；
- `structured`：Wave 2 CST 完整建模；
- `formatted`：保留给 Wave 3，Wave 2 不得提前声明；
- `verbatim`：边界可证明并生成 opaque node；
- `diagnostic`：边界或安全性不足，升级 statement/target preserve。

状态是事实，不是愿望。生成的 v2 support matrix 必须显示当前状态，不能把计划能力写成已实现能力。

### 9.3 Dialect 范围

Hive 必须优先覆盖：

- multi-statement、WITH/CTE、SELECT without FROM；
- FROM、JOIN、subquery、table function；
- LATERAL VIEW / OUTER / EXPLODE / POSEXPLODE；
- WHERE、GROUP BY、HAVING、WINDOW；
- ORDER BY、CLUSTER BY、DISTRIBUTE BY、SORT BY、LIMIT；
- UNION/INTERSECT/EXCEPT；
- INSERT OVERWRITE TABLE ... PARTITION ... SELECT；
- CASE、function、collection、CAST/type、subquery、window expression；
- `${...}` parameter 作为原子 identifier/expression component，不扫描其内部。

Hive DDL、MERGE、MATCH_RECOGNIZE table construct、PIVOT/UNPIVOT 等未建模结构必须显式 `verbatim` 或 `diagnostic`。

generic/PostgreSQL/MySQL 只覆盖 shared query structure 与已有 corpus 证明的 literal/operator/parameter expression。未声明 capability 不得自动继承 Hive grammar。

## 10. Statement 与 query grammar

### 10.1 Statement segmentation

- document mode 在可靠 depth 0 semicolon 上分割；
- semicolon 属于前一个 statement；
- leading/trailing comments 由 trivia binding 决定，不通过扩大语法猜测移动；
- trivia-only source 不产生伪 statement；
- 连续 semicolon 可形成 `empty` statement 并保持 source order；
- statement mode 只接受一个完整目标；额外顶层 statement 触发 target preserve；
- fragment mode 只在完整、balanced、fully-consumed 时返回 structured fragment，否则保留目标。

### 10.2 Query structure

Parser 采用 recursive-descent statement/clause parser 与独立 Pratt expression parser：

- `WITH` 只在 statement/query start 且后续 CTE 形态成立时识别；
- clause 只在当前 query depth、合法 predecessor 和 capability registry 允许时识别；
- `SELECT qualify AS c`、`WHERE qualify = 1`、`match_recognize(a)` 不得被误判为 clause/construct；
- set operation 在 query level 组合左右 query，不作为普通 binary expression；
- parenthesized subquery 由 delimiter pair 和 query-leading context 同时证明；
- relation alias、select alias 和 type name 必须有独立范围事实，Wave 3 不再猜测。

## 11. Pratt expression parser

Precedence 与 associativity 由 dialect registry 驱动，不在 parser switch 中散落第二份表。

至少覆盖：

- identifier、qualified identifier、wildcard、literal、parameter；
- unary `+ - ~ NOT`；
- arithmetic、comparison、boolean、bitwise 和 dialect operator；
- `IS [NOT] NULL/TRUE/FALSE`、`BETWEEN ... AND ...`、`IN (...)`、`LIKE/RLIKE/REGEXP`；
- function call、DISTINCT argument、named/collection function；
- parenthesized expression 与 subquery；
- searched/simple CASE；
- CAST 与 nested type expression；
- window `OVER(...)`、PARTITION/ORDER/frame；
- PostgreSQL `::`、JSON/operator corpus；
- array/map/struct bracket or function form，仅在 dialect capability 声明时结构化。

表达式 parser 必须 fully consume 其 bounded range。剩余未知 leaf 不能静默忽略；应降级当前 expression/list item 或更高层安全边界。

## 12. Recovery 与 OpaqueNode

恢复顺序固定：

1. expression：当前 list separator、matching close delimiter 或 clause boundary；
2. list item：同层 comma 或 container close；
3. clause：下一合法同层 clause 或 statement boundary；
4. statement：可靠顶层 semicolon；
5. target：无法证明 statement boundary、lexical fatal 或 internal invariant failure。

稳定 diagnostic code 至少包含：

- `SYN_UNMODELED_CONSTRUCT`；
- `SYN_UNSUPPORTED_STATEMENT`；
- `SYN_UNEXPECTED_TOKEN`；
- `SYN_INCOMPLETE_CLAUSE`；
- `SYN_UNMATCHED_DELIMITER`；
- `SYN_MAX_DEPTH_EXCEEDED`；
- `SYN_INTERNAL_INVARIANT`。

规则：

- diagnostics 按 span、severity、code 稳定排序并去重；
- `verbatim-node` 只用于边界完全可证明的 opaque node；
- `preserve-statement` 只在 statement boundary 可靠时使用；
- lexical unterminated unit、无法可靠分割的 delimiter 和 internal invariant failure 使用 `preserve-target`；
- parser nesting budget 固定为 256；达到预算时恢复为 opaque/preserve，不允许 JS call-stack overflow；
- 不以单词值识别 unsupported construct，必须结合 statement/clause/relation context 与 depth。

## 13. Trivia 与 comment ownership

Wave 2 不生成新 whitespace，但必须为 Wave 3 建立唯一 comment ownership：

- `trailing`：同一物理行、前方存在 owner code/list item；
- `leading`：位于下一个 node 前，且未被空白行与前一结构隔断；
- `dangling`：容器内部但无法安全归入相邻 child；
- opaque range 内 comment 归 opaque owner，不参与外部 layout；
- comment raw 永不改变；
- whitespace/newline 仍由 leaves 和 line index 保存，不伪造成 comment binding；
- 每个 comment leaf 恰有一个 owner 和一个 placement。

不得使用 marker、placeholder string 或 render 后 restore 协调 comment。

## 14. Analysis indexes

Wave 2E 一次构建并通过只读 query interface 暴露：

- node by id、parent by id、children、nearest ancestor；
- statement order 与 node-to-statement；
- query/clause order 与 clause-to-query；
- list/member/separator ownership；
- delimiter pair/depth；
- line starts、leaf line/column、offset-to-leaf binary lookup；
- source span/leaf range lookup；
- comment trivia binding；
- dialect capability lookup。

禁止向调用方暴露 mutable `Map`/`Set`。禁止 visitor 在每个 node 上重新遍历全部 leaves/nodes。Ancestor query 可以按 tree depth 走 parent chain，但不得重新过滤全表。

## 15. API 边界

Wave 2 runtime entry 位于内部模块：

```ts
parseSql(source: string, options?: ParseOptions): ParseOutput
analyzeSql(source: string, options?: ParseOptions): AnalysisOutput
```

要求：

- `parseSql()` 内部调用 `lexSql()`；公开入口不接受 caller-supplied leaves；
- test-only/internal helper 可以接收 leaves，但不得从 `src/core/index.ts` value-export；
- `src/core/index.ts` 的运行时 value exports 在 Wave 2 仍只有 `lexSql`；
- Wave 2 可扩展 type exports，但 parser、registry 和 analysis 实现细节不成为最终 public compatibility surface；
- Wave 4 才建立唯一公开 `formatSql(source, options): FormatResult`。

`ParserBackend` 由项目自有实现满足，但 backend id/version 仅用于内部 evidence，不重新引入 backend 选择层。

## 16. 复杂度与资源约束

目标：

- lexing O(n)；
- structural token table O(n)；
- CST construction O(n) 或有界 O(n log n)；
- analysis index construction O(n)；
- node 数量 O(code leaves)，不得因 recovery 指数膨胀；
- parser 不对每个 clause/list/expression 扫描完整 source 或完整 leaf 集；
- source text 只保留一份，node 只保存 span/range/id/typed facts。

性能测试沿用 100/800/1200 statement warm median 与 `process.resourceUsage().maxRSS`。2B 首个完整 query parser 记录 baseline；2E 固化门槛：800/100 与 1200/100 scale ratio 均不得超过 12x，后续已提交 baseline 无解释退化不得超过 20%。

## 17. 测试策略

### 17.1 Contracts/invariants

- strict type contracts 与 exhaustive discriminated union；
- leaf/source conservation；
- node id/range/span/containment/order/no-cycle/no-shared-child；
- separator/operator/alias/head/body owner range；
- parse/analyze deterministic；
- protected leaf 不被内部扫描。

### 17.2 Hive behavior

- Wave 0 16-case corpus；
- production-shaped CTE/window/comments；
- no-FROM SELECT；
- joins/subqueries/lateral view/explode；
- insert overwrite partition；
- set operations；
- group/order/cluster/distribute/sort/limit；
- CASE/cast/collection/window/type；
- template parameter；
- multi-statement 与 empty statement。

### 17.3 Context and recovery

- keyword-shaped identifier/alias/function false positives；
- MATCH_RECOGNIZE/PIVOT/UNPIVOT/MERGE 真实 construct；
- missing expression/comma/paren/clause body；
- lexical fatal propagation；
- reliable vs unreliable statement boundary；
- depth 255/256/257；
- deterministic malformed-input fuzz；
- every recovery returns original leaves and bounded opaque ranges。

### 17.4 Analysis

- every node has one parent except root；
- every comment has one binding；
- every separator has one list owner；
- offset/line lookup handles CRLF、emoji 和 EOF；
- indexes and CST agree under nested query/window/case；
- query APIs do not expose mutators。

### 17.5 Boundary and packaging

- Wave 0/1 tests remain green；
- 1.x `npm run test:verify` remains green；
- VSIX excludes all v2 source/build/test/docs/dependencies；
- current runtime and `package-lock.json` have no diff；
- `git diff --check`；
- independent read-only review。

## 18. Generated v2 support matrix

Wave 2 新建独立 `docs/technical/sql-formatter-v2-support-matrix.md`，不得覆盖当前 1.x `docs/technical/sql-support-matrix.md`。

- 内容由 v2 dialect registry 生成；
- `--write` 仅显式更新；默认 `--check` 比较 committed content；
- 每个 construct/dialect 显示真实 capability state；
- Wave 2 不得出现 `formatted`，除非 Wave 3 已实现并通过对应行为测试；
- generated test 防止 registry、parser tests 和 matrix 漂移；
- 该文档是开发阶段证据，不写入 README，也不进入 VSIX。

## 19. 完成条件

Wave 2 只有同时满足以下条件才可关闭：

1. 2A–2E 每个停止点均独立验证；
2. parser 只消费 Wave 1 canonical leaves；
3. Hive-first query CST 覆盖本设计声明的结构；
4. Pratt parser fully consumes bounded expressions；
5. unknown/unsupported/malformed input 只产生 bounded opaque 或 statement/target preserve；
6. lexical/source/span invariants 100% 保持；
7. CST containment、tree identity 和 reference ownership invariants 100% 通过；
8. comment binding、separator ownership 和 structural indexes 唯一一致；
9. context-aware false-positive regressions 通过；
10. depth/fuzz 不抛异常、不 hang、不丢 source；
11. v2 support matrix 与 registry 同源且通过 check；
12. performance scale gate 通过；
13. `npm run test:v2:wave0`、`test:v2:wave1`、`test:v2:wave2` 和 `test:verify` 全部通过；
14. package/VSIX boundary 通过；
15. `extension.js`、`vkbeautify.js`、`lib/**`、`package-lock.json` 无 diff；
16. 不实现 Wave 3 layout/renderer；
17. independent reviewer Critical=0、Important=0；
18. 任何 Wave 2 checkpoint 都只能在主 Codex 完成验证且 reviewer 的 Critical/Important 清零后创建。

### Validator production vs test-only audit (Wave 2A)

- **Production**: CST + token-table valid-domain facts, independent expected oracle, O(n) multi-pass, O(1) illegal probes.
- **Test-only**: full misuse matrices and adversarial forged tables live under `tests/v2/*hardening*` and performance gates; they must not force production to throw/catch per trivia leaf.
