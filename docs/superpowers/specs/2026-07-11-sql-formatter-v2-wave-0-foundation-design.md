# SQL Formatter v2 Wave 0 Foundation Design

- 日期：2026-07-11
- 状态：已批准（从已确认的 v2 umbrella design 派生）
- 上位设计：`docs/superpowers/specs/2026-07-10-sql-formatter-v2-optimization-program-design.md`

## 1. 目标

Wave 0 在不接管当前 formatter 的前提下完成四件事：

1. 冻结 backend-neutral 的 TypeScript strict 契约；
2. 建立 Hive-first parser evaluation corpus；
3. 用可复现证据决定 `dt-sql-parser` 的角色；
4. 建立进入 Wave 1 前的 correctness、package 和 performance baseline。

## 2. 非目标

- 不实现 v2 lexer、CST parser、Layout IR renderer 或 VS Code adapter；
- 不修改 `lib/core/`、`lib/adapters/`、`lib/experimental/ddl/` 的运行行为；
- 不注册 v2 command、provider、configuration、activation event 或 runtime entrypoint；
- 不把候选 parser 加入 runtime dependency 或 VSIX；
- 不以 Wave 0 的 probe code 代替 Wave 1 的 production lossless lexer。

## 3. 固定架构决策

### 3.1 Project-owned lossless lexer

无论 external candidate 的评估结果如何，v2 都保留 project-owned lossless lexer。它最终负责：

- exact source-string reconstruction；
- protected token 原子边界；
- UTF-16 code-unit source span；
- trivia/comment ownership 的原始输入；
- opaque/verbatim source slice。

External parser token stream 只有同时通过 source partition 和 atomic lexeme gate，才可以作为词法实现参考；不能绕过 canonical `SourceLeaf`。

### 3.2 External candidate 范围

生产候选只评估 `dt-sql-parser@4.5.0`：

- 它公开 Hive、generic、PostgreSQL 和 MySQL parser；
- 它提供 token、validation 和 parse-tree API；
- 它使用 MIT license；
- 它是否适合作为 VS Code extension runtime 尚未验证。

`sql-parser-cst` 只作为 lossless CST 设计参考。它当前不支持 Hive 且采用 GPL-2.0，不进入可发布候选。

### 3.3 Candidate role

评估只允许三个闭合结果：

- `runtime-grammar-backend`：语法、range、license、package 和 performance gate 全部通过；
- `development-oracle`：语法、range 和 license 通过，但 package 或 performance 不适合 runtime；
- `rejected`：语法、range、source round-trip 或 license 任一 MUST gate 失败。

候选角色只决定 grammar backend。它不改变 project-owned lossless lexer 的决定。

## 4. Canonical contracts

Wave 0 冻结以下 TypeScript strict 类型：

- `SourceSpan`：end-exclusive UTF-16 code-unit offsets；
- `SourceLeaf`：`id/kind/channel/raw/span`；
- `Diagnostic`：稳定 code、severity、span 和 recovery action；
- `SyntaxNode`：structured node 或 opaque node；
- `ParserBackend`：canonical parse input/output；
- `LayoutDoc`：`Text/Verbatim/Line/Concat/Indent/Align/Group`；
- `CanonicalFormatOptions`；
- `FormatResult`：`formatted/unchanged/preserved/failed`。

这些类型不能引用 `dt-sql-parser` 私有 parse-tree class。

## 5. Evaluation corpus

Corpus 至少包含：

- 7 个 required Hive cases；
- CTE、window、comment、lateral view/explode；
- insert overwrite partition；
- complex Hive DDL types 和 quoted content；
- no-FROM、collection function、CASE 和 nested query；
- literal-first nested query；
- Hive template substitution opaque case；
- PostgreSQL dollar string、parameter、prefixed string 和 operator；
- MySQL prefixed literal、binary number 和 variable；
- generic array/no-FROM；
- `MATCH_RECOGNIZE` function-name false positive 与真实 construct；
- unterminated string invalid case；
- CRLF、中文和 emoji，用于验证 UTF-16 offset 与 source reconstruction。

## 6. MUST gates

| Gate | Threshold | Purpose |
| --- | ---: | --- |
| Required parse rate | 100% | 已声明 required 的语料必须成功 |
| Invalid reject rate | 100% | 明确非法输入必须产生拒绝证据 |
| Source round-trip rate | 100% | leaf `raw` 拼接严格等于输入 |
| Required case node-range rate | 100% | required parse tree 必须提供有效 source range |
| Bundled license | allowlist only | 不引入不兼容 runtime license |

Atomic lexeme rate 单独记录。只有达到 100% 才能声称 candidate token stream 有资格承担 leaf 边界；该指标不取消 project-owned lexer。

## 7. Runtime suitability gates

| Gate | Threshold |
| --- | ---: |
| Minified Hive-entry bundle | <= 5 MiB |
| Gzip bundle | <= 1.5 MiB |
| Cold-start median | <= 400 ms |
| 100 -> 800 statement scale ratio | <= 12x |

同时记录 100、800、1200 statement median、maximum RSS、Node version、platform、architecture 和 CPU。绝对 parse latency 在本次报告中形成 baseline；后续 v2 提交不得无解释退化超过 umbrella design 的限制。

## 8. Data flow

```text
evaluation cases
  -> candidate adapter
  -> leaf/source partition checks
  -> grammar/error/range checks
  -> esbuild/package/license probe
  -> cold-start/scaling/memory probe
  -> deterministic gate classifier
  -> evidence report + ADR
```

Probe 不格式化 SQL，也不产生 document edit。Invalid/opaque case 只用于评估 candidate 的接受、拒绝和原文边界能力。

## 9. Shipping boundary

- 当前 `main` 仍指向 `extension.js` 和现有 `lib/`；
- candidate、TypeScript source、evaluation scripts、tests、docs 和 `.tmp` 不进入 VSIX；
- `dt-sql-parser`、TypeScript 和 esbuild 仅为 pinned dev dependencies；
- `npm run test:verify` 最终同时覆盖 1.x 和 Wave 0；
- Wave 0 不能改变任何当前 SQL 输出。

## 10. Deliverables

- strict TypeScript contract surface；
- evaluation corpus 与 schema guard；
- candidate-neutral evaluator；
- `dt-sql-parser` adapter；
- bundle/license/performance/memory probes；
- generated evaluation report；
- accepted ADR with one closed candidate role；
- aggregate Wave 0 verification and VSIX boundary test。

## 11. 完成条件

1. 全部 canonical contract type-check；
2. evaluator 的 runtime/oracle/rejected 三条分支均有测试；
3. candidate 对每个 case 返回完整 source partition，不向外抛出用户 SQL exception；
4. report 包含 correctness、range、package、license、performance、memory 和 environment evidence；
5. ADR 明确 candidate role，并保留 project-owned lossless lexer；
6. `npm run test:verify` 和本地 VSIX inspection 通过；
7. 当前 formatter entry 和输出未改变；
8. Wave 1 在独立 design/plan 获批前不得开始。
