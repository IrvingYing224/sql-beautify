# SQL Formatter v2 Wave 3 Layout 与 Renderer Design

- 日期：2026-07-16
- 状态：已完成（历史设计基线）
- 分支：`codex/sql-formatter-v2-wave3`
- 基线：`c4369e9`（Wave 2E closure）
- 上位设计：`docs/superpowers/specs/2026-07-10-sql-formatter-v2-optimization-program-design.md`
- 前置设计：`docs/superpowers/specs/2026-07-12-sql-formatter-v2-wave-2-cst-dialect-analysis-design.md`

## 1. 目标

Wave 3 在 Wave 2 的 canonical leaves、lossless CST 和 structural indexes 上建立唯一 Layout IR、唯一 whitespace authority 和唯一 renderer，并产出内部 `FormatResult`。本波次必须完成 Hive-first query formatting，但仍不接管当前 1.x VS Code runtime。

核心目标：

1. protected leaf、comment 与 opaque range 的原始 code-unit sequence 永不改变；
2. formatter 只移动或生成 trivia，不新增、删除、重排 SQL syntax token；
3. formatting policy 只消费 parser/analysis 已证明的结构事实，不按 raw 单词重新实现 parser；
4. renderer 是唯一能生成空格、换行、缩进、对齐 padding 的组件；
5. keyword case、operator spacing、comma、CASE、AS、comment 和 width 使用同一 IR/measurement 路径；
6. layout generation 与 rendering 保持 O(n) 或有界 O(n log n)，禁止恢复 per-node full scan；
7. 形成 Wave 4 adapter 可直接消费的 text、diagnostic 与 source map，但不在本波次公开 root value API。

## 2. 已确认的设计决策

1. Hive 是默认且第一方完整格式化目标。
2. generic、PostgreSQL、MySQL 只格式化 registry 明确标为 `formatted` 的 capability；其他结构按最小可靠边界 verbatim。
3. Wave 3 不复刻 1.x 全部输出 snapshot；新输出由 token equivalence、protected exactness、idempotency 和新 golden fixtures 约束。
4. 不增加隐藏的第二套 clause/operator/type 识别逻辑。
5. 不增加 render 后正则、全局 whitespace normalize 或 marker restore pass。
6. 不在 Wave 3 新增公开 `printWidth`。Query/list 换行由结构 policy 决定；`Group` 的 bounded fit 只使用 owning policy 的明确阈值，例如 `caseWhenThenWrapLength`。
7. space indentation unit 固定为四个空格；tab indentation unit 固定为一个 `\t`，display tab stop 固定为 4。
8. document/statement/fragment 三种 mode 都保留“是否存在最终换行”，生成的内部布局换行
   使用 LF；verbatim 内容内部的 CR/LF/CRLF 原样保留。statement/fragment 不在目标边界外
   新增 leading/trailing newline，边界 newline trivia 未获明确内部 ownership 时 raw 保留。
9. 每个子波次在自动验证和独立只读 reviewer Critical/Important 清零后由主 Codex 自主创建聚焦 commit，无需逐次用户确认；Wave 5 完成前不合并 `main`。

## 3. 非目标与 shipping 边界

Wave 3 不实现：

- VS Code provider、command、selection transaction、worker、cancellation 或 stale document handling；
- experimental Hive DDL / Extract DDL parser；
- public root `formatSql` value export；
- 旧 positional API、legacy command、root shim 删除；
- README、CHANGELOG、migration guide 或正式发布；
- 当前 `extension.js`、`vkbeautify.js`、`lib/**` runtime 迁移；
- 对未声明 dialect capability 的猜测性格式化。

Shipping 边界继续保持：

- `package.json.main` 为 `./extension.js`；
- `src/**`、`tests/**`、`scripts/**`、`docs/**`、`.tmp/**` 不进入当前 VSIX；
- `extension.js`、`vkbeautify.js`、`lib/**`、`package-lock.json` 不因 Wave 3 变化；
- 不新增 runtime dependency。

## 4. 固定 pipeline 与依赖方向

```text
source + canonical options
  -> analyzeSql() retained parse artifact
  -> contextual formatting facts
  -> typed LayoutPlan decisions
  -> one-pass LayoutDoc compiler
  -> LayoutDoc invariant / source ownership validation
  -> single renderer + shared measurement
  -> text + source map
  -> token-equivalence / result invariant
  -> internal FormatResult
```

依赖方向：

```text
lexer -> dialects -> syntax -> analysis
                              ↓
config --------------------> layout -> renderer
                                  \       /
                                   api orchestration
```

硬边界：

- `syntax`、`lexer`、`dialects`、`analysis` 不得导入 `layout` 或 `renderer`；
- `renderer` 不得导入 parser、CST、dialect registry 或 SQL policy；
- `layout` 可读取 immutable node/index/capability/config facts，但不得调用 parser helper、重新 lex、扫描 protected raw 或按单词重建 grammar；
- `api` orchestration 可以组合 analysis、layout、renderer，但 root `src/core/index.ts` 的 value export 在 Wave 3 仍只有 `lexSql`。

## 5. Wave 3A 必须先完成的 formatter-fact closure

Wave 2 的 clause head、expression operator ids、list/separator ownership、alias/modifier、delimiter 和 comment binding 已可复用，但直接进入 layout 仍有三个高风险缺口。

### 5.1 Contextual leaf facts

`SourceLeaf.kind === "keyword"` 只是 lexical hint，不是语法结论。例如
`SELECT window AS order FROM group` 中 keyword-shaped identifier/alias/table name 不得因
`keywordCase` 被当成结构关键字。反过来，word operator 与 builtin type keyword 又必须能
执行 keyword case。

3A 增加 parser/analysis-owned contextual fact。Lexer 的 `kind/channel`、comment binding、
syntax role 与 opaque ownership 是正交维度，不能压成一个互斥 `role`：

```ts
type SyntaxLeafRole =
    | "syntax-keyword"
    | "word-operator-keyword"
    | "builtin-type-keyword"
    | "identifier-name"
    | "alias-name"
    | "relation-name"
    | "user-type-name"
    | "literal"
    | "parameter"
    | "symbol-operator"
    | "delimiter"
    | "separator"
    | "punctuation"
    | "unknown-preserved";

type SyntaxMarkerId =
    | `clause:${ClauseKind}`
    | "statement-terminator"
    | "cte-as"
    | "alias-as"
    | "join-head"
    | "set-operator"
    | "case:start"
    | "case:when"
    | "case:then"
    | "case:else"
    | "case:end"
    | "window:over"
    | "window:partition-by"
    | "window:order-by"
    | "window:rows"
    | "window:range"
    | "window:groups"
    | "window:between"
    | "window:and"
    | "window:unbounded"
    | "window:current-row"
    | "window:preceding"
    | "window:following"
    | "type:name"
    | "type:cast"
    | "type:as"
    | "type:member-colon"
    | "delimiter"
    | "separator"
    | "operator";

interface SyntaxLeafOccurrence {
    readonly leafId: number;
    readonly directOwnerNodeId: number;
    readonly syntaxRole: SyntaxLeafRole;
    readonly syntaxId: SyntaxMarkerId | null;
    readonly capabilityId: string | null;
    readonly keywordCaseEligible: boolean;
}

interface ContextualLeafFacts {
    readonly leafId: number;
    readonly syntax: SyntaxLeafOccurrence | null;
    readonly opaqueOwnerNodeId: number | null;
}
```

`SourceLeaf` 继续唯一拥有 lexical kind/channel/raw/span；comment/trivia 的 `syntax=null`，
placement 继续来自 `CommentBinding`。`ContextualLeafFacts` 对每个 leaf 都存在，因此 quoted
relation name 可以同时是 `channel=protected`、`syntaxRole=relation-name`；opaque 内 comment
仍是 comment，同时由 `opaqueOwnerNodeId` 表达覆盖。

Direct owner 算法固定为：先使用 parser 显式的 operator/separator/name/marker ownership；
其余 syntax leaf 归属到“包含该 leaf、且它不属于任何 direct child range”的最深 node。
同深度多 owner、显式 fact 互相冲突或遍历顺序才能决定结果时 analysis fail closed。祖先
containment 不会覆盖 direct owner；`opaqueOwnerNodeId` 单独记录最深 opaque owner。

`StructuralIndex.leafContext(leafId)` 为 O(1)。只有其 syntax occurrence 为
`syntax-keyword/word-operator-keyword/builtin-type-keyword` 且
`keywordCaseEligible=true` 才可执行 keyword case；transform 与 token-equivalence checker
消费同一 proof。Layout 禁止 `.raw.toLowerCase()`、word set、regex 或 clause-name switch
重新识别语法。正反例至少锁定 clause head、CTE `AS`、JOIN/set、CASE、
`OVER/PARTITION/ORDER`、`AND/OR/NOT IN/NOT BETWEEN/IS NOT NULL`、builtin/user type、
alias、relation name 和 keyword-shaped identifier。

### 5.2 CST marker 与 name ownership

为避免 layout 从 node gap 猜 marker，CST 增加 parser 已识别的直接 marker 事实：

- `SyntaxNodeBase.syntaxMarkers`：冻结的 `{leafId, syntaxId, partOrdinal, syntaxRole,
  keywordCaseEligible}` records；只包含该 node 直接拥有、且不属于 child value/name/operator
  的 grammar marker；多词 marker 使用同一 stable syntaxId 与从 0 开始的 part ordinal；
- `SyntaxNodeBase.capabilityId`：该 occurrence 的主 registry identity，结构辅助 node 可为 `null`；
- `SyntaxNodeBase.formatRole`：`capability/intrinsic-container/intrinsic-primitive/opaque`，
  明确 null capability 的权限语义；
- `RelationNode.nameLeafRange`：table relation 的完整 qualified name；非 table relation 为 `null`；
- `ClauseNode.separatorLeafIds`：WITH CTE 与 comma-separated FROM 等未使用 `ListNode` 的直接 separators；其他 clause 为空数组。

既有 `operatorLeafIds`、`separatorLeafIds`、`modifierLeafIds`、alias ranges、clause
head/body ranges 等保留为更精确的 typed facts。Invariant 必须验证 marker 在 owner range
内、严格递增且唯一、是 code channel grammar leaf、不是 protected content，name/separator
与 children 不冲突。每个 marker 必须进入 contextual occurrence table，不能只增加一个无人
消费的 CST 字段。

### 5.3 Capability 与 operator occurrence identity

Layout 不维护 `nodeKind/operator -> capability` 第二映射。

- `StructuralIndex.capabilityForNode(nodeId)` 只从 node occurrence identity 与 dialect registry 返回；
- `OperatorSemantics` 增加 registry-owned stable `id`、nullable `capabilityId` 与单一
  `formatClass`；`id` 在同一 dialect 内唯一，`formatClass` 只表达 spacing/layout 类别，
  不携带 formatter callback；
- expression parser 在匹配 operator 时创建 immutable `OperatorOccurrence`，至少保留
  `ownerNodeId`、完整有序 `leafIds`、semantics `id`、nullable `capabilityId`、`fixity` 和
  `formatClass`；compound/special operator 不得退化为首 leaf；
- `StructuralIndex.operatorOccurrencesOf(expressionNodeId)` 与
  `operatorOccurrenceForLeaf(leafId)` 均为 direct-address 查询；layout 不允许根据
  `operatorLeafIds`/raw 再调用 registry lookup；
- parser、registry validator 与 support matrix 将 `formatted` 视为 `structured` 的严格后继状态，而不是停止解析；
- 任一 capability 只有在对应 behavior/golden/idempotency tests 通过后才可从 `structured` 改为 `formatted`；
- `structured` 但未 `formatted` 的 node 在渐进实现期间按最小可靠 range verbatim，不得静默冒充已格式化。

一个 node 可以只有一个主 capability，但可以拥有多个 operator occurrences；二者不能用
一个可空字符串混为一谈。若同一 expression operator leaf 被两个 occurrence 占用、occurrence
引用不同 dialect semantics 或 capability 不存在，analysis 必须 fail closed。

```ts
type CapabilityOccurrence =
    | {
          readonly ownerNodeId: number;
          readonly capabilityId: string;
          readonly source: "node";
          readonly operatorId: null;
      }
    | {
          readonly ownerNodeId: number;
          readonly capabilityId: string;
          readonly source: "operator";
          readonly operatorId: string;
      };
```

`StructuralIndex.capabilityOccurrencesOf(nodeId)` 返回主 node occurrence 与 operator
occurrences 的冻结 projection；`capabilityForNode(nodeId)` 只表示主 occurrence。二者都从
parser 保留的 identity 构造，不做 kind/raw lookup。

`capabilityId=null` 的 operator occurrence 仍存在于 operator index，但不进入
`capabilityOccurrencesOf()`。任一 operator occurrence 的 non-null capability state 不是
`formatted` 时，它建立 dominating verbatim claim：handle range 精确等于
`operatorOccurrence.ownerNodeId` 的完整 ExpressionNode range，并保留 triggering operator id
与 capability id。一个 expression 有多个 operators 时，只要一个显式 capability未 formatted，
整个 owner expression verbatim；ancestor authority 不得局部格式化它。

`capabilityId=null` 不是“默认已 formatted”。Gating 规则：

1. `formatRole=capability` 必须引用 registry capability；只有 state=`formatted` 才打开该
   node range 的 format authority；structured/recognized/verbatim/diagnostic 都阻止该 range
   的行为布局并使用 exact verbatim；
2. `intrinsic-container` 只能组织已获 authority 的 descendants/gaps，不能自行授予未声明
   construct 格式化权限；
3. `intrinsic-primitive` 只能在最近的 formatted authority 内 raw/keyword-proof emit；
4. 遇到显式 non-formatted capability 或 opaque child 时，祖先 authority 在其边界停止；
5. `opaque` 永远 verbatim，capabilityId 可空或为 preservation capability；
6. parser/factory/invariant 使用明确组合 allowlist；null capability + `formatRole=capability`
   或不受 authority 的 intrinsic behavior 都 fail closed。

SELECT authority 粒度固定为 query-level：

- SELECT clause 本身是 `intrinsic-container`，其 `QueryClauseSyntax.capabilityId=null`；registry
  只允许 `select` syntax 使用这一 null 组合；
- 只有确认没有 FROM 的 select `QueryNode` 才携带 `select-without-from` occurrence；
- 含 FROM 的 select `QueryNode` 携带 `from` authority；在 `from` 尚未 formatted 时整棵 query
  verbatim，不能因 no-FROM capability transition 部分格式化 SELECT；
- set/parenthesized/insert query 使用各自显式 authority 或受已 formatted owner控制，不借用
  `select-without-from`。

3B 在 identity kernel 通过后实现且只实现 Hive `select-without-from` 最小 behavior，并在
同一 checkpoint 完成对应 `structured -> formatted` transition，以便用真实 authority 验证
keyword transform、source map 和 end-to-end renderer。其他 SQL behavior 从 3C 开始；禁止
test-only bypass capability gating。

### 5.4 Canonical AnalysisArtifact

Wave 2 的 `AnalysisOutput` 会丢失 `ParseArtifact.source/dialect/mode`，不能作为 renderer
provenance。3A 将内部结果升级为 canonical `AnalysisArtifact`：

```ts
interface AnalysisArtifactBase<S extends AnalysisStatus> {
    readonly status: S;
    readonly source: string;
    readonly dialect: Dialect;
    readonly mode: ParseMode;
    readonly root: ProgramNode;
    readonly leaves: readonly SourceLeaf[];
    readonly diagnostics: readonly Diagnostic[];
}

interface AnalyzedArtifact extends AnalysisArtifactBase<"analyzed"> {
    readonly index: StructuralIndex;
}

interface PreservedAnalysisArtifact extends AnalysisArtifactBase<"preserved"> {
    readonly index: StructuralIndex;
}

interface FailedAnalysisArtifact extends AnalysisArtifactBase<"failed"> {
    readonly index: null;
}

type AnalysisArtifact =
    | AnalyzedArtifact
    | PreservedAnalysisArtifact
    | FailedAnalysisArtifact;
```

artifact 由 analysis boundary 冻结，并用 module-private identity proof 绑定 canonical
`ParseArtifact`、root、leaf partition、token table 与 structural index。不得用
`leaves.map(raw).join("")` 重建 source。wrong source、dialect、mode、root、leaves、index
或 clone 均不是 canonical artifact。只有 `status="analyzed"` 的 canonical artifact 可进入
layout；target-level `preserved/failed` 由 orchestration 直接返回原始文本，不创建 doc。
兼容性的 type alias 可以保留，但不得削弱 status/index discriminated contract。

## 6. Layout IR 契约

现有 `{ kind: "text", value: string }` 允许 policy 注入任意 SQL 或 whitespace，无法证明 token equivalence，因此 3A 必须破坏性重定义。

目标 IR：

```ts
declare const POSITIVE_COLUMNS: unique symbol;
declare const POSITIVE_LEVELS: unique symbol;
type PositiveColumns = number & { readonly [POSITIVE_COLUMNS]: true };
type PositiveLevels = number & { readonly [POSITIVE_LEVELS]: true };

type LineSuffixSpacing =
    | { readonly kind: "space"; readonly columns: PositiveColumns }
    | { readonly kind: "pad-to-column"; readonly targetColumn: PositiveColumns }
    | null;

type VerbatimTrigger =
    | { readonly kind: "opaque"; readonly capabilityId: string | null }
    | { readonly kind: "node-capability"; readonly capabilityId: string }
    | {
          readonly kind: "operator-capability";
          readonly capabilityId: string;
          readonly operatorId: string;
      };

type LayoutDoc =
    | {
          readonly kind: "leaf";
          readonly leafId: number;
          readonly transform: "raw" | "keyword-case";
      }
    | {
          readonly kind: "verbatim";
          readonly ownerNodeId: number;
          readonly trigger: VerbatimTrigger;
          readonly leafRange: LeafRange;
      }
    | { readonly kind: "space"; readonly columns: PositiveColumns }
    | { readonly kind: "line"; readonly mode: "hard" }
    | {
          readonly kind: "line";
          readonly mode: "soft";
          readonly flat: "empty" | "space";
      }
    | { readonly kind: "concat"; readonly parts: readonly LayoutDoc[] }
    | {
          readonly kind: "indent";
          readonly levels: PositiveLevels;
          readonly content: LayoutDoc;
      }
    | {
          readonly kind: "align";
          readonly columns: PositiveColumns;
          readonly content: LayoutDoc;
      }
    | {
          readonly kind: "pad-to-column";
          readonly targetColumn: PositiveColumns;
      }
    | {
          readonly kind: "group";
          readonly mode: "auto";
          readonly maxFlatWidth: PositiveColumns;
          readonly content: LayoutDoc;
      }
    | {
          readonly kind: "group";
          readonly mode: "flat" | "break";
          readonly content: LayoutDoc;
      }
    | {
          readonly kind: "line-suffix";
          readonly commentLeafId: number;
          readonly spacing: LineSuffixSpacing;
      };
```

约束：

- `leaf` 不携带 caller string；renderer 从 canonical leaf 读取 raw，并且只有 contextual
  occurrence 明确 `keywordCaseEligible=true` 可使用 `transform: "keyword-case"`；
- protected/comment/identifier leaf 不允许 keyword transform；
- `verbatim` 使用 analysis-scoped canonical range handle；range 必须精确等于 owner 的
  opaque、未 formatted structured node 或被未 formatted operator支配的完整 expression
  范围，trigger identity 必须与 index/registry一致，不能用任意 in-bounds slice 冒充 ownership；
- policy 不创建包含 SQL token 或 whitespace 的字符串；所有 whitespace 只能通过
  `space/line/indent/align/pad-to-column` 表达；
- `line-suffix` 不是 arbitrary child doc；它只持有已绑定为 trailing 的 comment leaf id
  和受限 spacing，因此类型层不能塞入 syntax leaf、verbatim、line/group/indent/align 或
  nested suffix；
- 所有 node、range 和 parts array immutable、dense、无 cycle、无 shared child identity；
- zero space/indent/align/pad 由 factory canonicalize 为 content/empty concat，不创建 no-op
  node；negative/fractional/non-safe integer 无 branded value；
- empty source 使用 empty concat，不伪造 empty leaf/verbatim；
- doc 只能由 module-private canonical factory 创建；公开 type export 不是构造权限，factory
  proof、artifact proof 与 frozen graph 三者缺一即 fail closed。

Factory 必须是 `createLayoutDocFactory(analysisArtifact)` 的 analysis-scoped instance。
每个 source-derived doc node由 module-private WeakMap 绑定 exact analysis identity；同 leaf ids
的另一个 source、另一个 analysis 或另一个 factory 都不能复用。Verbatim handle 只能通过
该 factory 从 `StructuralIndex.nodeById()` 与 capability gating 生成。

## 7. Layout artifact 与 source ownership

Renderer 不直接接受任意 `LayoutDoc + source`。Layout builder 产出 canonical immutable artifact：

```ts
interface LayoutArtifact {
    readonly analysis: AnalyzedArtifact;
    readonly root: LayoutDoc;
    readonly options: CanonicalFormatOptions;
    readonly diagnostics: readonly Diagnostic[];
}
```

Artifact 必须通过内部 provenance proof 绑定同一 canonical analysis、source、leaf partition、
index、mode、dialect、doc 和 options。Renderer 只接受 canonical `LayoutArtifact`，对 clone、
cross-source leaves、wrong dialect/mode、forged range、noncanonical doc fail closed。

Coverage invariant：

1. 每个 code/protected/comment leaf 在 output 中恰好出现一次；任一 source leaf 最多出现
   一次；原 whitespace/newline leaf只能被 policy 明确保留一次或由 generated whitespace
   替代；
2. source-derived output 顺序与 leaf order 一致；
3. protected/comment leaf 只能 raw 或包含在 verbatim range 中；
4. opaque range 只能整体 verbatim，内部不得再出现 leaf refs；
5. 原始 layout whitespace 可以丢弃或替换，comment/blank-line ownership 除外；
6. generated whitespace 没有伪造 source mapping；
7. 任何重叠、遗漏、重复、倒序 ref 都是 internal invariant failure。

## 8. Renderer 语义

Renderer 是 SQL-agnostic 的 iterative interpreter：

- 显式 stack，禁止依赖 JS recursion 深度；
- `leaf(raw)` 原样写 leaf；`leaf(keyword-case)` 只按 canonical `keywordCase` 转换 parser-confirmed
  ASCII 且 `keywordCaseEligible` 的 syntax/word-operator/builtin-type keyword；
- `verbatim` 从 artifact source 的派生 span 写回 exact code-unit sequence；
- `space`、soft-line flat value、hard/soft break、indent、align 和 `pad-to-column` 是唯一 whitespace 生成路径；
- `Group(auto)` 使用明确的相对内容阈值 `maxFlatWidth`；不读取当前输出列，也不触发
  隐藏全局 print width；
- `Group(flat)` 遇 hard line、任意含 CR/LF/CRLF 的 source-derived leaf/verbatim，或同一
  flat scope 内无终止换行的 raw/verbatim line comment 后仍有 source emission 时
  invariant fail；`Group(break)` 展开 soft lines；
- auto group 若含 tab、multiline source emission、align、pad-to-column 或 line-suffix，则
  static flat width 为 unknown，保守 break；不缓存错误的 start-column-independent width；
- `line-suffix` 在物理换行前按注册顺序 flush；line comment 后只有仍存在后续
  source-derived syntax 时才在它之前强制换行，EOF comment 不自动新增最终 LF；
- LF 是 generated line ending；verbatim 内行尾保持原样；
- 所有 parse mode 是否有最终换行都在 emission 时遵守原 source，不允许事后 trim；
  statement/fragment 不得在目标 span 外新增 leading/trailing newline；
- render 后禁止 trim/replace/regex normalize。

列与布局节点语义冻结如下：

- display column 从每个物理行 0 开始；`space.columns` 是正整数 display columns；
- `indent.levels` 是相对 nesting level，只在其内容发生 physical line break 后增加行首
  indentation；space unit 为 4 个空格，tab unit 为一个 `\t`；
- `align.columns` 是在当前 indent 之外增加的相对 display columns，不改变已输出行内容；
- `pad-to-column.targetColumn` 是当前 physical line 的绝对 display column；当前列已达到或
  超过目标时输出空，不允许倒退或删字符；
- `line.flat` 明确为 `empty` 或 `space`；hard line 不能 flatten；
- `group(auto)` 必须携带正整数相对 `maxFlatWidth`，`flat/break` 类型没有 width 字段；任何
  policy 没有明确阈值时不能创建 auto group；
- node 数值必须是有限安全整数并受 artifact 资源预算约束，不能通过巨大 align/pad/space
  制造无界输出。

Flat width、group fit、AS/comment alignment 与最终输出必须共用同一 `displayWidth` 实现。
WeakMap 只缓存 context-independent summary（例如 `flatWidth:number|null`、multiline/hard/
tab/pad/suffix flags）；tab/pad/align/suffix 的实际宽度显式接受 current column/indent context，
不能只按 doc identity 缓存。禁止每个 Group 重新遍历完整 subtree。

Display width 规则固定并测试：

- tab stop 4；
- CRLF 视为一个 line break；
- 不调用 runtime `Intl.Segmenter` 或依赖 host ICU；项目内 checked-in、固定 Unicode 15.1
  grapheme/width subset tables 与 scanner 是唯一 authority，未列入的 code point保守宽度1；
- combining mark、variation selector、zero-width joiner、skin tone modifier 不单独增加
  cluster 宽度；
- East Asian wide/fullwidth cluster 与 emoji presentation cluster 宽度 2；ZWJ family、
  regional-indicator flag、keycap、skin-tone sequence 各按一个 grapheme cluster 计算；
- 其他 grapheme cluster 宽度 1；同一 subtree 从 display column 0..3 开始的 tab 正例必须
  得到各自正确结果。

### 8.1 Resource budgets

令 `U=max(1, leafCount + syntaxNodeCount)`、`S=source.length`。所有乘加先做 safe-integer
overflow check。Canonical artifact 固定预算：

- LayoutDoc nodes `<= 24*U + 64`；LayoutPlan actions `<= 16*U + 64`；
- graph nesting `<= min(4096, U + 64)`；cumulative indent levels
  `<= min(512, U + 32)`；
- pending line suffixes `<= min(4096, U)`；
- generated columns per physical line `<= 4*U + 256`；source-derived长行不计入该限制；
- total generated whitespace code units `<= 32*U + 2*S + 4096`；
- total output code units `<= S + generatedWhitespaceBudget`；每个 source leaf最多 raw emit
  一次，因此 source-derived bytes不能自行放大。

Factory 在注册 node 前检查 node-count 与单节点 scalar 上限；plan 在追加 action 前检查
action-count 与单 action 上限；artifact validator 在接受完整 graph 前统一检查 nesting、
累计 indent/align、pending suffix、逐行与总 whitespace/output 上限；renderer 在追加 chunk 前
执行同一累计预算的 runtime defense。非法 doc、计划冲突或 runtime 预算耗尽使本次 format
`failed` 并返回 original target，不返回 partial text/map。Policy 若在建 plan 前已知结构过深，
可以选择 target-level `preserved`；不得把一次超预算静默降级为局部丢失行为。

## 9. Source map 与 render result

Source map 在 render 时同步生成，不使用 render 后 diff：

- raw/keyword-case leaf 映射到该 leaf span；
- verbatim range 映射到同长度 source span；
- generated whitespace 无 source entry；
- entries 按 output span 严格递增、不重叠；source spans 单调、不重叠；
- 相邻且 source/output 均连续的 entries 可以合并；
- keyword case 不改变 ASCII keyword 长度；若未来 transform 改变长度，必须扩展 mapping contract，不能假设 1:1。

Wave 4 cursor restoration 只能消费该 map，不重新 diff SQL。

## 10. LayoutPlan 与 policy ownership

Policy 不直接拼接最终 doc string。它向 typed `LayoutPlan` 注册：

- leaf emission mode（raw/keyword/verbatim coverage）；
- boundary spacing/break decision；
- indent/align scope start/end；
- list separator placement；
- line suffix/comment placement；
- group/width/alignment identity。

Plan 使用 leaf/boundary direct-address arrays 和 node ids，不用“高优先级覆盖低优先级”掩盖
冲突。注册语义固定为：

1. 先登记 target/statement/opaque/unformatted dominating range；它阻止所有 descendant
   policy registration，不是事后覆盖；
2. protected/comment exactness claim 必须与任何 structure action兼容；
3. structural hard boundary、owned list/separator、expression/operator 对同一 boundary 的
   不兼容 action 一律 fail，不看写入顺序；
4. 未被 claim 的 boundary 保留原始 trivia；不做 raw lexical adjacency fallback；
5. 只有明确 formatted authority 可以把原始 trivia 替换成 generated whitespace。

这样 policy priority 表达“谁有注册资格”，不是 last-write/priority-wins。Safe compiler 不需
根据 raw 判断 token 拼接；未知边界保留原始 source trivia。

`compileLayoutDoc` 使用一个 source-order monotonic gap cursor：parent 只声明 child 之间的 gap，
child 消费自己的 range，opaque/verbatim range 一次消费后不得继续递归。每个 leaf 的 emission、
ownership lookup、boundary decision 与 width measurement都有常数上限。各 policy visitor 只能
遍历自己的 node/index 列表；禁止对每个 node 扫描完整 `leafRange`、全部
leaves/nodes/comments。3B 性能测试除 wall clock 外必须记录 leaf visit/emission/lookup
计数并断言线性预算。

## 11. Canonical options

Wave 3 建立 v2 单一 canonical resolver，默认值：

| Option | Default | Contract |
| --- | --- | --- |
| `dialect` | `hive` | `hive/generic/postgresql/mysql` |
| `keywordCase` | `upper` | `upper/lower` |
| `commaStyle` | `leading` | `leading/trailing` |
| `indentStyle` | `space` | `space/tab` |
| `maxAlignWidth` | `150` | integer `1..500` |
| `caseWhenThenWrapLength` | `50` | integer `1..300` |
| `caseLayout` | `expanded` | `expanded/compactShort` |
| `unsupportedSyntaxPolicy` | `warn` | `warn/preserve/bail_out` |

resolver 在 3A 与 LayoutArtifact provenance 同时建立，产出 module-private identity proof 的
deep-frozen options；plain clone 即使字段相同也不是 canonical options。Resolver 拒绝任何
unknown own enumerable string key并返回稳定 config failure；allowed keys 在异常 containment
内各读取一次，accessor/Proxy/read failure 不向外抛。symbol/non-enumerable keys也不作为隐藏
配置通道，存在即拒绝。Wave 3 不修改
`package.json` 的当前 1.x setting defaults；Wave 4/5 切换时再统一 contribution。Invalid
runtime option 必须产生稳定 config failure，由 internal format boundary 转为
original-text `failed`，不得静默产生部分 SQL。

## 12. 默认 Hive layout policy

默认 layout 以稳定、可读、Hive-first 为目标，不继承 1.x 的隐藏 regex/marker 行为。

### 12.1 Statements 与 clauses

- 每个 non-empty statement 独立格式化；semicolon 保持 syntax order；多 statement 之间一个 hard line，最多保留一个用户空行；
- WITH、SELECT、FROM、JOIN、LATERAL VIEW、WHERE、GROUP BY、HAVING、WINDOW、ORDER BY、CLUSTER BY、DISTRIBUTE BY、SORT BY、LIMIT、INSERT/PARTITION 与 set operator 使用结构 hard boundaries；
- nested query 在 owning parentheses 内增加一个 indent level，close delimiter 与 query owner 对齐；
- target-level preserved result 完全返回 source，不调整最终换行。

### 12.2 Lists 与 comma

Query-level SELECT/GROUP/ORDER/CLUSTER/DISTRIBUTE/SORT lists 默认 multiline。

Trailing：

```sql
SELECT
    account_id,
    total_amount
FROM sales
```

Leading（默认）：

```sql
SELECT
      account_id
    , total_amount
FROM sales
```

leading 风格在一个 indent unit 内为首项保留两列 content prefix，后续 comma + one space，使 item content display column 一致；tab/space 都通过 renderer display columns 实现，不拼接混合 indent string。

Function args、type args、value collections 在“无 comment/subquery/expanded CASE/hard line、
无 context-sensitive width 且 owner 未声明 multiline”时 structurally flat-eligible；eligible
即保持 flat，不使用隐藏长度阈值，其他情况 break。CTE/FROM direct separators 使用
`ClauseNode.separatorLeafIds`，不重新寻找 comma。

### 12.3 Conditions 与 joins

- first WHERE/HAVING/JOIN ON condition 跟在 clause head 后；顶层 AND/OR continuation hard-break，并对齐到 first operand；
- nested boolean group 使用 expression tree/precedence，不扫描 raw operators；
- JOIN head 与 right relation 同行；ON/USING 属于 join，ON continuation 增加一个 indent level；
- keyword-shaped relation/alias/name 保持 identifier role，不应用 keywordCase。

### 12.4 Expressions 与 spacing

- prefix/infix/postfix spacing 来自 contextual operator occurrence；
- binary/word predicates 两侧一个 space；symbol prefix 紧贴 operand，word prefix 后一个 space；postfix cast `::` 紧贴两侧，word postfix 前一个 space；
- delimiter、dot、subscript、function call、type angle/paren、collection separator 只使用 owner facts；
- protected literal/parameter/template/quoted identifier 始终 raw；
- unknown/unformatted expression 使用最小 expression range verbatim。

### 12.5 CASE

- `expanded`：CASE/WHEN/ELSE/END 使用结构化 hard lines 与 indent；
- `compactShort`：仅在无 comment/opaque/hard line，且 renderer flat width `<= caseWhenThenWrapLength` 时 flat；否则自动 expanded；
- long THEN/ELSE value 使用同一 threshold 和 Group metrics；
- simple/searched CASE、nested CASE 与 CASE in list 使用同一 policy，不维护第二 width calculation。

### 12.6 AS 与 comments

- AS alignment 仅在同一 list 的连续 single-line items 内进行；target width 必须 `< maxAlignWidth`，否则不 align；
- trailing comment alignment 使用相同 rendered code width 与 `pad-to-column` node；multiline/opaque/over-limit row 终止 alignment group；
- leading/trailing/dangling placement只来自 `CommentBinding`；line/block comment raw 不改；
- line comment 必须由 line-suffix flush，任何后续 syntax 必须在下一行；
- blank line 只从 trivia sequence/line index恢复，最多一个，不从 comment raw 推断。

## 13. Unsupported policy 与 FormatResult

Internal `formatSql`（不从 root export）返回既有 `FormatResult` discriminated contract：

- `formatted`：安全输出且 `text !== source`；
- `unchanged`：安全输出与 source 相同；
- `preserved`：analysis target preserve、`bail_out`、不可靠边界或 policy 明确保留整个目标；`text === source`；
- `failed`：config/internal/layout/render/token-equivalence failure；`text === source` 且 index/output 不泄漏部分结果。

规则：

- bounded opaque node/statement 可 verbatim，其他已 formatted structure 继续；
- `warn` 保留 diagnostics，adapter 在 Wave 4 显示；
- `preserve` 使用同样安全输出，但 adapter 将 capability warning 静默；core 仍返回 diagnostic facts；
- `bail_out` 遇任一 unsupported/diagnostic capability 时保留整个请求目标；
- lexical fatal、unreliable target boundary、analysis failed、layout/source coverage failure 均不得输出部分格式化 SQL。

## 14. Token equivalence 与 idempotency

每个 formatted/unchanged result 必须满足：

1. output 重新 lex 后 non-trivia token 数量、kind、channel 与 semantic raw 顺序等价；
2. 允许的 raw 差异只有 contextual occurrence 明确 case-eligible 的 syntax keyword、word
   operator keyword 与 builtin type keyword之 configured ASCII case；
3. protected/comment raw 逐 leaf 严格相等；
4. opaque source slice 严格存在且顺序不变；
5. `format(format(source, options).text, options).text` 与第一次严格相等；
6. failed/preserved 始终返回 original source；
7. 不允许 marker leakage 或 source map overlap。

Token equivalence checker 是 test/invariant，不是 render 后修复器。

## 15. Dialect 与 support matrix

- registry 是 parser、layout gating、support matrix 与 tests 的唯一 capability authority；
- `formatted` 表示该 dialect/capability 有 behavior + golden + protected + idempotency coverage；
- generic/PostgreSQL/MySQL shared query subset 可在 3E 转为 formatted；dialect-specific operators 只在对应 tests 通过后转换；
- `hive-ddl` 在 Wave 3 保持 `verbatim`；
- `merge/pivot/unpivot/qualify/match-recognize` 保持 `diagnostic`，除非本波次另有明确 parser/layout scope（当前无）；
- generated v2 matrix 文案从 Wave 2 parser matrix 更新为 v2 development capability matrix。

## 16. 性能与资源门槛

- LayoutPlan build、doc compile、doc invariant、metrics、render、source map 与 token-equivalence 各自 O(n) 或有界 O(n log n)；
- doc/node/action 数量 O(leaves + syntax nodes)；
- source 只保留一份，不为每个 node materialize source slice；
- renderer chunks 最终 join 一次，不做 repeated whole-output concatenation；
- context-independent metrics memoized，context-sensitive width 不错误复用；alignment 不重复
  render whole rows；
- 在 fresh child process 中采样 100/800/1200 statements；normalized median
  `(time/input)/(time100/100) <= 1.5`，即 800/100 <=12x、1200/100 <=18x；
- 3B 首个端到端 formatter checkpoint 建立绝对/relative baseline；3C–3F 相对已提交 3B baseline无解释退化 <=20%；
- Wave 2 parser/analysis relative gate继续运行；
- 记录 median、source/output chars、leaf/doc/action count、隔离 child process maxRSS、
  Node/platform/arch/CPU；relative gate 使用
  `current/max(baseline,5ms)<=1.20`，baseline <5ms 时另允许最多 +2ms absolute noise；
- deep CTE、depth-256 expression、250k comment、comment-dense lists 必须有 closure probes。

## 17. 子波次

### 3A：Contextual facts、IR 与 invariant contract

- contextual leaf roles；
- node marker/name/separator/capability occurrence closure；
- formatted state parser compatibility；
- constrained LayoutDoc、factory、artifact provenance 与 invariant validator；
- canonical options resolver 与 identity proof；
- 无 SQL behavior layout。

### 3B：Renderer、source map 与 safe leaf compiler

- iterative renderer、display width、metrics、line suffix、source map；
- LayoutPlan/direct-address compiler；
- raw/keyword/protected/opaque emission；
- internal format result/failure containment；
- identity kernel、Hive no-FROM SELECT 最小 behavior/transition 与首个 formatter baseline；
  其他 SQL behavior从3C开始。

### 3C：Hive query、clause、relation 与 list layout

- WITH/CTE、SELECT/FROM/JOIN/LATERAL、filters、group/order/cluster/distribute/sort/limit；
- subquery、set、multi statement、INSERT OVERWRITE PARTITION；
- leading/trailing comma；
- Hive query capability states转为 formatted。

### 3D：Expression、CASE、type、collection 与 window

- registry-driven operator spacing；
- CASE strategies/threshold；
- function/cast/type/collection/subquery/window；
- depth/opaque boundaries与 expression golden。

### 3E：Trivia、alignment、dialect 与 option matrix

- leading/trailing/dangling comments、blank lines、line suffix；
- AS/comment alignment 与 shared width；
- generic/PostgreSQL/MySQL proven subset；
- full option Cartesian/threshold boundaries；
- support matrix formatted transitions。

### 3F：Closure

- 将 `cst-contextual-invariants.ts` 按 capability allowlist、fact/name/separator shape 与 exact
  marker closure 拆成聚焦模块，入口只做编排；3B–3E 的 layout/renderer 行为不得继续进入该文件；

- corpus golden、protected exactness、token equivalence、idempotency、fuzz；
- performance/relative baseline/memory；
- boundary、generated matrix、Wave 0/1/2/3 aggregate、VSIX；
- independent reviewer Critical=0、Important=0。

子波次允许主 Codex 自主委派只读 review；由于 `build:v2-core` 使用共享 `.tmp/v2-core`，同一 worktree 的 build/test 必须串行，reviewer 运行 gate 时主代理不得并发重建产物。

## 18. 测试策略

### 18.1 Contract / adversarial

- arbitrary string injection、whitespace string、forged leaf/range/artifact；
- sparse/mutable/cyclic/shared LayoutDoc；
- cross-source leaf refs、duplicate/missing/reordered refs；
- protected keyword transform、opaque nested refs；
- invalid Group/Align/PadToColumn/LineSuffix；
- keyword-shaped identifier/alias/table relation contextual role。

### 18.2 Renderer

- flat/break group、soft-line empty/space、nested indent/align/pad-to-column；
- line suffix ordering；
- CRLF/multiline leaf/verbatim 与 EOF line comment；
- grapheme cluster/Unicode/tab context-sensitive display width；
- source-map monotonicity与 merge；
- iterative deep doc no stack overflow；
- deterministic render。

### 18.3 Behavior

- Hive Wave 0/2 corpus；
- CTE/subquery/window/lateral/insert/set/multi statement；
- no-FROM SELECT；
- leading/trailing comma；
- CASE/cast/type/collection/operator；
- AS/trailing comment/blank line；
- strings、dollar strings、quoted identifiers、parameters、templates、block/line comments；
- bounded opaque around known structure；
- four dialect proven subset与 unsupported false positives。

### 18.4 Properties

- protected/comment exactness；
- source coverage；
- output token equivalence；
- format idempotency；
- original-text failed/preserved；
- deterministic LayoutDoc/source map/result；
- O(n) scale与 bounded object count。

## 19. 完成条件

Wave 3 只有全部满足才可关闭：

1. contextual leaf role不依赖 layout raw word recognition；
2. node/operator capability occurrence与registry一致；
3. LayoutDoc不能携带任意 SQL/whitespace字符串；
4. Layout artifact绑定 canonical source/leaves/analysis；
5. renderer是唯一 whitespace generator；
6. protected/comment/opaque exactness 100%；
7. output token equivalence 100%；
8. complete Wave 3 corpus idempotent；
9. Hive-first设计声明的 query/expression/comment policy全部有 golden；
10. generic/PostgreSQL/MySQL matrix不夸大 formatted capability；
11. source map单调、无重叠并由render同步生成；
12. option values与组合均有真实行为；
13. scale与relative performance gates通过；
14. `npm run test:v2:wave0`、`wave1`、`wave2`、`wave3`、`test:verify` 全部通过；
15. VSIX继续排除 v2 source/test/docs/build；
16. `extension.js`、`vkbeautify.js`、`lib/**`、`package-lock.json` 无 diff；
17. root runtime value exports仍只有 `lexSql`；
18. 不实现 Wave 4 adapter/DDL；
19. independent reviewer Critical=0、Important=0；
20. Wave 3 checkpoint commit仅在验证/review清零后创建，且不合并 `main`。

## 20. 主要风险与缓解

### Layout 重新成为第二 parser

通过 contextual role、syntax marker、capability occurrence和禁止 raw word detection消除。任何 layout 中出现 clause/operator word set 都是架构回归。

### IR 可以注入或丢失 SQL token

Leaf/Verbatim 只引用 analysis-scoped canonical leaves/range handles，coverage invariant 和
output token equivalence 双重约束。

### Group/measurement 产生 O(n²)

context-independent metrics memoized、context-sensitive width显式传上下文、
plan/direct-address、one-pass compiler和100/800/1200 gate共同防护。

### Comment 破坏 line layout

comment binding是唯一ownership，line-suffix是唯一trailing路径，multiline leaf/verbatim阻止
flat，EOF comment不制造额外最终换行。

### Capability matrix 与行为漂移

node/operator occurrence直接引用registry；只有behavior/golden/idempotency同时存在才允许formatted。

### 历史 baseline 与并发 build

保留 Wave 2B/3B anchor commit和完整Git历史；任何rebase/squash必须显式迁移baseline。共享 `.tmp/v2-core` 验证串行，不在多代理间并发build。
