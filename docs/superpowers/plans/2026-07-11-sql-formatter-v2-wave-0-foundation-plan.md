# SQL Formatter v2 Wave 0 Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish the evidence, strict TypeScript contracts, parser-backend decision, and reproducible baseline required before implementing the v2 lossless lexer or formatter.

**Architecture:** Keep the shipping 1.x formatter untouched while adding a non-shipping v2 contract surface under `src/core/` and a development-only parser evaluation harness. A project-owned lossless lexer remains mandatory; Wave 0 decides whether `dt-sql-parser` can serve as a runtime grammar backend, a development oracle only, or must be rejected.

**Tech Stack:** Node.js CommonJS test scripts, TypeScript 6.0.3 strict type checking, `dt-sql-parser` 4.5.0 as a development-only candidate, esbuild 0.28.1 for candidate bundle measurement, existing `assert`-based tests, local VSIX inspection.

## Global Constraints

- Governing designs: `docs/superpowers/specs/2026-07-10-sql-formatter-v2-optimization-program-design.md` and `docs/superpowers/specs/2026-07-11-sql-formatter-v2-wave-0-foundation-design.md`.
- This plan implements Wave 0 only: technical evaluation, backend-neutral contracts, ADR, and benchmark baseline.
- Do not modify the active formatter path under `lib/core/`, `lib/adapters/`, `lib/experimental/ddl/`, `extension.js`, or `vkbeautify.js`.
- Do not register v2 commands, providers, configuration keys, activation events, or runtime entrypoints.
- Hive is the default and primary dialect; generic, PostgreSQL, and MySQL evidence is secondary.
- Core input and `SourceSpan` use JavaScript UTF-16 code-unit offsets; concatenated leaf `raw` values must exactly equal the input string.
- Unknown or invalid SQL is evidence for preservation/rejection behavior, never permission to mutate source.
- `dt-sql-parser` remains a pinned `devDependency` throughout Wave 0 and must not enter the VSIX.
- TypeScript and esbuild are development/build dependencies only.
- Network-dependent install commands use `ALL_PROXY=socks5://127.0.0.1:7897`. Local tests, type checks, reports, and VSIX inspection do not use a proxy.
- Existing 1.x tests must remain green after every task that changes shared metadata.
- Each task ends in a focused commit. Do not combine later-wave lexer, CST, layout, adapter, DDL, or command cleanup work into these commits.

## Evidence Sources

- `dt-sql-parser` official package and repository: `https://www.npmjs.com/package/dt-sql-parser` and `https://github.com/DTStack/dt-sql-parser`.
- TypeScript 6.0.3 official release: `https://github.com/microsoft/TypeScript/releases/tag/v6.0.3`.
- esbuild package used for bundle measurement: `https://www.npmjs.com/package/esbuild`.
- `sql-parser-cst` is architecture reference material only: `https://github.com/nene/sql-parser-cst`. It demonstrates lossless CST reconstruction but does not support Hive and is GPL-2.0.

---

## File Structure

### Create

- `tsconfig.v2.json`: strict, no-emit compilation boundary for v2 contracts.
- `src/core/source/source-span.ts`: end-exclusive source span contract.
- `src/core/lexer/token.ts`: lossless leaf/token contract.
- `src/core/diagnostics/diagnostic.ts`: diagnostic and recovery-action contract.
- `src/core/syntax/node.ts`: structured and opaque CST node contracts.
- `src/core/syntax/parser-backend.ts`: canonical parser backend interface.
- `src/core/layout/doc.ts`: Layout IR discriminated union.
- `src/core/config/options.ts`: public and canonical option types.
- `src/core/api/format-result.ts`: structured result and source-map types.
- `src/core/index.ts`: single v2 contract export surface.
- `tests/v2/contracts.type-test.ts`: compile-time consistency test.
- `tests/fixtures/v2-parser-evaluation-cases.js`: Hive-first evaluation cases.
- `tests/v2/parser-evaluation-corpus.test.js`: corpus schema and coverage guard.
- `scripts/v2-parser-evaluation/evaluator.js`: candidate-neutral gates and classification.
- `tests/v2/parser-evaluation-harness.test.js`: evaluator branch tests.
- `scripts/v2-parser-evaluation/candidates/dt-sql-parser.js`: official API adapter.
- `scripts/v2-parser-evaluation/candidates/dt-entry.js`: minimal bundle entry.
- `scripts/v2-parser-evaluation/cold-start.js`: isolated cold-start probe.
- `scripts/v2-parser-evaluation/probe-dt-sql-parser.js`: package/performance probe.
- `tests/v2/dt-sql-parser-candidate.test.js`: adapter safety test.
- `scripts/v2-parser-evaluation/report.js`: report and ADR renderer.
- `scripts/v2-parser-evaluation/run.js`: evaluation orchestrator.
- `docs/technical/v2-parser-evaluation-report.md`: generated evidence.
- `docs/technical/adr/0001-v2-parser-backend.md`: generated decision.
- `tests/v2/parser-evaluation-report.test.js`: evidence completeness guard.
- `tests/v2/wave0-boundary.test.js`: shipping boundary guard.

### Modify

- `package.json`: pinned development dependencies and Wave 0 scripts.
- `package-lock.json`: exact dependency graph.
- `.gitignore`: ignore `.tmp/` evaluation output.
- `.vscodeignore`: exclude development-only source, scripts, and artifacts.

---

### Task 1: Freeze Backend-Neutral TypeScript Contracts

**Files:**
- Create: `tsconfig.v2.json`
- Create: `src/core/source/source-span.ts`
- Create: `src/core/lexer/token.ts`
- Create: `src/core/diagnostics/diagnostic.ts`
- Create: `src/core/syntax/node.ts`
- Create: `src/core/syntax/parser-backend.ts`
- Create: `src/core/layout/doc.ts`
- Create: `src/core/config/options.ts`
- Create: `src/core/api/format-result.ts`
- Create: `src/core/index.ts`
- Create: `tests/v2/contracts.type-test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.gitignore`
- Modify: `.vscodeignore`

**Interfaces:**
- Consumes: approved v2 types from design sections 7, 8, 11, 13, 14, and 15.
- Produces: `SourceSpan`, `SourceLeaf`, `SyntaxNode`, `ParserBackend`, `LayoutDoc`, `FormatOptions`, `CanonicalFormatOptions`, `Diagnostic`, and `FormatResult`.

- [ ] **Step 1: Verify the untouched baseline**

Run:

```bash
git status --short
npm run test:verify
```

Expected: the worktree has no uncommitted files and the complete 1.x regression suite passes.

- [ ] **Step 2: Install exact Wave 0 development dependencies**

Run:

```bash
ALL_PROXY=socks5://127.0.0.1:7897 npm install --save-dev --save-exact typescript@6.0.3 esbuild@0.28.1 dt-sql-parser@4.5.0
```

Expected: `package.json` and `package-lock.json` change; all three packages appear only under `devDependencies`.

- [ ] **Step 3: Add the strict compiler boundary and failing contract test**

Create `tsconfig.v2.json`:

```json
{
    "compilerOptions": {
        "target": "ES2022",
        "module": "Node16",
        "moduleResolution": "Node16",
        "strict": true,
        "noEmit": true,
        "noUncheckedIndexedAccess": true,
        "exactOptionalPropertyTypes": true,
        "useUnknownInCatchVariables": true,
        "noImplicitOverride": true,
        "noUnusedLocals": true,
        "noUnusedParameters": true,
        "skipLibCheck": true
    },
    "include": [
        "src/**/*.ts",
        "tests/v2/**/*.type-test.ts"
    ]
}
```

Add this script to `package.json`:

```json
"typecheck:v2": "tsc -p tsconfig.v2.json"
```

Create `tests/v2/contracts.type-test.ts`:

```ts
import type {
    CanonicalFormatOptions,
    Diagnostic,
    FormatResult,
    LayoutDoc,
    ParserBackend,
    SourceLeaf,
    SourceSpan,
    SyntaxNode,
} from "../../src/core/index";

const span: SourceSpan = { start: 0, end: 6 };
const leaf: SourceLeaf = {
    id: 0,
    kind: "keyword",
    channel: "code",
    raw: "SELECT",
    span,
};
const opaqueNode: SyntaxNode = {
    id: 1,
    kind: "opaque",
    span,
    reasonCode: "UNMODELED_CONSTRUCT",
};
const root: SyntaxNode = {
    id: 0,
    kind: "program",
    span,
    children: [opaqueNode],
};
const diagnostic: Diagnostic = {
    code: "UNMODELED_CONSTRUCT",
    severity: "warning",
    message: "The construct is preserved verbatim.",
    span,
    recovery: "verbatim-node",
};
const doc: LayoutDoc = {
    kind: "group",
    content: {
        kind: "concat",
        parts: [
            { kind: "text", value: "SELECT" },
            { kind: "line", mode: "soft" },
            { kind: "verbatim", span },
        ],
    },
};
const options: CanonicalFormatOptions = {
    dialect: "hive",
    keywordCase: "upper",
    commaStyle: "leading",
    indentStyle: "space",
    maxAlignWidth: 150,
    caseWhenThenWrapLength: 50,
    caseLayout: "expanded",
    unsupportedSyntaxPolicy: "warn",
};
const backend: ParserBackend = {
    id: "contract-test",
    version: "0.0.0",
    parse(input) {
        const sourceLeaf: SourceLeaf = {
            ...leaf,
            raw: input.source,
            span: { start: 0, end: input.source.length },
        };
        return {
            root: { ...root, span: sourceLeaf.span },
            leaves: [sourceLeaf],
            diagnostics: [],
        };
    },
};
const result: FormatResult = {
    status: "preserved",
    text: "SELECT",
    diagnostics: [diagnostic],
    sourceMap: {
        entries: [{ source: span, output: span }],
    },
};

function statusLabel(value: FormatResult): string {
    switch (value.status) {
        case "formatted":
        case "unchanged":
        case "preserved":
        case "failed":
            return value.status;
        default: {
            const exhaustive: never = value.status;
            return exhaustive;
        }
    }
}

void backend;
void doc;
void options;
void statusLabel(result);
```

Add `.tmp/` to `.gitignore`. Add these entries to `.vscodeignore`:

```text
.tmp/**
src/**
scripts/**
```

- [ ] **Step 4: Verify the intended type-check failure**

Run:

```bash
npm run typecheck:v2
```

Expected: FAIL with a module-resolution error for `../../src/core/index`.

- [ ] **Step 5: Add source, leaf, and diagnostic contracts**

Create `src/core/source/source-span.ts`:

```ts
export interface SourceSpan {
    // End-exclusive JavaScript UTF-16 code-unit offsets.
    readonly start: number;
    readonly end: number;
}
```

Create `src/core/lexer/token.ts`:

```ts
import type { SourceSpan } from "../source/source-span";

export type TokenChannel = "code" | "trivia" | "protected";
export type TokenKind =
    | "keyword"
    | "identifier"
    | "quoted-identifier"
    | "number"
    | "string"
    | "parameter"
    | "operator"
    | "punctuation"
    | "line-comment"
    | "block-comment"
    | "whitespace"
    | "newline"
    | "unknown";

export interface SourceLeaf {
    readonly id: number;
    readonly kind: TokenKind;
    readonly channel: TokenChannel;
    readonly raw: string;
    readonly span: SourceSpan;
}
```

Create `src/core/diagnostics/diagnostic.ts`:

```ts
import type { SourceSpan } from "../source/source-span";

export type DiagnosticSeverity = "info" | "warning" | "error";
export type RecoveryAction =
    | "none"
    | "verbatim-node"
    | "preserve-statement"
    | "preserve-target";

export interface Diagnostic {
    readonly code: string;
    readonly severity: DiagnosticSeverity;
    readonly message: string;
    readonly span: SourceSpan;
    readonly recovery: RecoveryAction;
}
```

- [ ] **Step 6: Add syntax and parser contracts**

Create `src/core/syntax/node.ts`:

```ts
import type { SourceSpan } from "../source/source-span";

export type StructuredSyntaxKind =
    | "program"
    | "statement"
    | "query"
    | "with-clause"
    | "select-clause"
    | "from-clause"
    | "where-clause"
    | "group-by-clause"
    | "having-clause"
    | "order-by-clause"
    | "insert-clause"
    | "list"
    | "expression";

export interface StructuredNode {
    readonly id: number;
    readonly kind: StructuredSyntaxKind;
    readonly span: SourceSpan;
    readonly children: readonly SyntaxNode[];
}

export interface OpaqueNode {
    readonly id: number;
    readonly kind: "opaque";
    readonly span: SourceSpan;
    readonly reasonCode: string;
}

export type SyntaxNode = StructuredNode | OpaqueNode;
```

Create `src/core/syntax/parser-backend.ts`:

```ts
import type { Dialect } from "../config/options";
import type { Diagnostic } from "../diagnostics/diagnostic";
import type { SourceLeaf } from "../lexer/token";
import type { SyntaxNode } from "./node";

export type ParseMode = "document" | "statement" | "fragment";
export interface ParseInput {
    readonly source: string;
    readonly dialect: Dialect;
    readonly mode: ParseMode;
}
export interface ParseOutput {
    readonly root: SyntaxNode;
    readonly leaves: readonly SourceLeaf[];
    readonly diagnostics: readonly Diagnostic[];
}
export interface ParserBackend {
    readonly id: string;
    readonly version: string;
    parse(input: ParseInput): ParseOutput;
}
```

- [ ] **Step 7: Add layout, option, result, and export contracts**

Create `src/core/layout/doc.ts`:

```ts
import type { SourceSpan } from "../source/source-span";

export type LayoutDoc =
    | { readonly kind: "text"; readonly value: string }
    | { readonly kind: "verbatim"; readonly span: SourceSpan }
    | { readonly kind: "line"; readonly mode: "hard" | "soft" }
    | { readonly kind: "concat"; readonly parts: readonly LayoutDoc[] }
    | { readonly kind: "indent"; readonly content: LayoutDoc }
    | { readonly kind: "align"; readonly columns: number; readonly content: LayoutDoc }
    | { readonly kind: "group"; readonly content: LayoutDoc };
```

Create `src/core/config/options.ts`:

```ts
export type Dialect = "hive" | "generic" | "postgresql" | "mysql";
export type KeywordCase = "upper" | "lower";
export type CommaStyle = "leading" | "trailing";
export type IndentStyle = "space" | "tab";
export type CaseLayout = "expanded" | "compactShort";
export type UnsupportedSyntaxPolicy = "warn" | "preserve" | "bail_out";

export interface CanonicalFormatOptions {
    readonly dialect: Dialect;
    readonly keywordCase: KeywordCase;
    readonly commaStyle: CommaStyle;
    readonly indentStyle: IndentStyle;
    readonly maxAlignWidth: number;
    readonly caseWhenThenWrapLength: number;
    readonly caseLayout: CaseLayout;
    readonly unsupportedSyntaxPolicy: UnsupportedSyntaxPolicy;
}

export type FormatOptions = Readonly<Partial<CanonicalFormatOptions>>;
```

Create `src/core/api/format-result.ts`:

```ts
import type { Diagnostic } from "../diagnostics/diagnostic";
import type { SourceSpan } from "../source/source-span";

export type FormatStatus = "formatted" | "unchanged" | "preserved" | "failed";
export interface SourceMapEntry {
    readonly source: SourceSpan;
    readonly output: SourceSpan;
}
export interface SourceMap {
    readonly entries: readonly SourceMapEntry[];
}
export interface FormatResult {
    readonly status: FormatStatus;
    readonly text: string;
    readonly diagnostics: readonly Diagnostic[];
    readonly sourceMap?: SourceMap;
}
```

Create `src/core/index.ts`:

```ts
export type { SourceSpan } from "./source/source-span";
export type { SourceLeaf, TokenChannel, TokenKind } from "./lexer/token";
export type { Diagnostic, DiagnosticSeverity, RecoveryAction } from "./diagnostics/diagnostic";
export type { OpaqueNode, StructuredNode, StructuredSyntaxKind, SyntaxNode } from "./syntax/node";
export type { ParseInput, ParseMode, ParseOutput, ParserBackend } from "./syntax/parser-backend";
export type { LayoutDoc } from "./layout/doc";
export type {
    CanonicalFormatOptions,
    CaseLayout,
    CommaStyle,
    Dialect,
    FormatOptions,
    IndentStyle,
    KeywordCase,
    UnsupportedSyntaxPolicy,
} from "./config/options";
export type { FormatResult, FormatStatus, SourceMap, SourceMapEntry } from "./api/format-result";
```

- [ ] **Step 8: Verify contracts and unchanged 1.x behavior**

Run:

```bash
npm run typecheck:v2
npm run test:verify
```

Expected: both pass; no file under `lib/` or `extension.js` changes.

- [ ] **Step 9: Commit the contract foundation**

Run:

```bash
git add package.json package-lock.json tsconfig.v2.json .gitignore .vscodeignore src/core tests/v2/contracts.type-test.ts
git commit -m "build: add strict v2 core contracts"
```

Expected: one contract/toolchain commit.

---

### Task 2: Add the Hive-First Parser Evaluation Corpus

**Files:**
- Create: `tests/fixtures/v2-parser-evaluation-cases.js`
- Create: `tests/v2/parser-evaluation-corpus.test.js`
- Modify: `package.json`

**Interfaces:**
- Consumes: Task 1 dialect names.
- Produces: cases with `id`, `dialect`, `expectation`, `source`, `atomicLexemes`, and `tags`.

- [ ] **Step 1: Add the failing corpus schema test**

Create `tests/v2/parser-evaluation-corpus.test.js`:

```js
var assert = require('assert');
var cases = require('../fixtures/v2-parser-evaluation-cases');
var ids = Object.create(null);
var allowedDialects = ['hive', 'generic', 'postgresql', 'mysql'];
var allowedExpectations = ['required', 'opaque', 'invalid'];
var required = 0;
var hiveRequired = 0;

assert.ok(cases.length >= 14, 'Wave 0 corpus must contain at least 14 focused cases');
cases.forEach(function(testCase) {
    assert.ok(testCase.id, 'case id is required');
    assert.ok(!ids[testCase.id], 'case ids must be unique: ' + testCase.id);
    ids[testCase.id] = true;
    assert.ok(allowedDialects.indexOf(testCase.dialect) >= 0, testCase.id + ' dialect');
    assert.ok(allowedExpectations.indexOf(testCase.expectation) >= 0, testCase.id + ' expectation');
    assert.strictEqual(typeof testCase.source, 'string', testCase.id + ' source');
    assert.ok(testCase.source.length > 0, testCase.id + ' source must not be empty');
    assert.ok(Array.isArray(testCase.atomicLexemes), testCase.id + ' atomicLexemes');
    assert.ok(Array.isArray(testCase.tags), testCase.id + ' tags');
    testCase.atomicLexemes.forEach(function(lexeme) {
        assert.ok(testCase.source.indexOf(lexeme) >= 0, testCase.id + ' missing lexeme ' + lexeme);
    });
    if (testCase.expectation == 'required') {
        required++;
        if (testCase.dialect == 'hive') {
            hiveRequired++;
        }
    }
});
assert.ok(required >= 10, 'at least 10 cases must require parsing');
assert.ok(hiveRequired >= 7, 'at least 7 required cases must be Hive');
assert.ok(cases.some(function(item) { return item.expectation == 'opaque'; }), 'opaque case required');
assert.ok(cases.some(function(item) { return item.expectation == 'invalid'; }), 'invalid case required');
console.log('v2 parser evaluation corpus tests passed');
```

Add:

```json
"test:v2:parser-corpus": "node tests/v2/parser-evaluation-corpus.test.js"
```

- [ ] **Step 2: Verify the missing-fixture failure**

Run:

```bash
npm run test:v2:parser-corpus
```

Expected: FAIL because the fixture module does not exist.

- [ ] **Step 3: Add the complete evaluation corpus**

Create `tests/fixtures/v2-parser-evaluation-cases.js`:

```js
module.exports = Object.freeze([
    {
        id: 'hive-cte-window-comments',
        dialect: 'hive',
        expectation: 'required',
        source: [
            'WITH src AS (',
            'SELECT user_id, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY ts DESC) AS rn',
            'FROM fact_orders -- 保留 FROM 😀',
            "WHERE ds = '2026-07-11'",
            ') SELECT user_id FROM src WHERE rn = 1',
        ].join('\n'),
        atomicLexemes: ['-- 保留 FROM 😀', "'2026-07-11'"],
        tags: ['cte', 'window', 'comment'],
    },
    {
        id: 'hive-lateral-view-explode',
        dialect: 'hive',
        expectation: 'required',
        source: 'SELECT id, item FROM src LATERAL VIEW EXPLODE(items) e AS item',
        atomicLexemes: [],
        tags: ['lateral-view', 'explode'],
    },
    {
        id: 'hive-insert-overwrite-partition',
        dialect: 'hive',
        expectation: 'required',
        source: "INSERT OVERWRITE TABLE dst PARTITION (ds='2026-07-11') SELECT id FROM src",
        atomicLexemes: ["'2026-07-11'"],
        tags: ['insert', 'partition'],
    },
    {
        id: 'hive-complex-type-ddl',
        dialect: 'hive',
        expectation: 'required',
        source: "CREATE TABLE `t(` (`a,b` DECIMAL(18,2) COMMENT 'a  b', payload STRUCT<x:ARRAY<STRING>,y:MAP<STRING,STRING>>)",
        atomicLexemes: ['`t(`', '`a,b`', "'a  b'"],
        tags: ['ddl', 'complex-type', 'quoted'],
    },
    {
        id: 'hive-no-from-functions',
        dialect: 'hive',
        expectation: 'required',
        source: "SELECT ARRAY('a','b'), MAP('x', 1), NAMED_STRUCT('k', 2)",
        atomicLexemes: ["'a'", "'b'", "'x'", "'k'"],
        tags: ['no-from', 'collection'],
    },
    {
        id: 'hive-literal-first-nested-query',
        dialect: 'hive',
        expectation: 'required',
        source: "WITH x AS (SELECT 'literal' AS c) SELECT c FROM x",
        atomicLexemes: ["'literal'"],
        tags: ['cte', 'literal-first'],
    },
    {
        id: 'hive-case-and-subquery',
        dialect: 'hive',
        expectation: 'required',
        source: "SELECT CASE WHEN id IN (SELECT id FROM dim) THEN 'y' ELSE 'n' END AS flag FROM src",
        atomicLexemes: ["'y'", "'n'"],
        tags: ['case', 'subquery'],
    },
    {
        id: 'hive-cluster-distribute-sort',
        dialect: 'hive',
        expectation: 'required',
        source: 'SELECT id FROM src DISTRIBUTE BY id SORT BY ts DESC',
        atomicLexemes: [],
        tags: ['distribute-by', 'sort-by'],
    },
    {
        id: 'hive-template-substitution',
        dialect: 'hive',
        expectation: 'opaque',
        source: "SELECT id FROM ${db}.src WHERE ds = ${hivevar:day}",
        atomicLexemes: ['${db}', '${hivevar:day}'],
        tags: ['template', 'opaque'],
    },
    {
        id: 'postgres-dollar-parameter-operators',
        dialect: 'postgresql',
        expectation: 'required',
        source: "SELECT $1, $tag$line  \r\nkeep$tag$, payload @> '{\"id\":1}'::jsonb FROM t WHERE payload ?| ARRAY['id']",
        atomicLexemes: ['$1', "$tag$line  \r\nkeep$tag$", '@>', '::', '?|'],
        tags: ['parameter', 'dollar-string', 'operator'],
    },
    {
        id: 'postgres-prefixed-strings',
        dialect: 'postgresql',
        expectation: 'required',
        source: "SELECT E'abc', U&'d\\0061t' FROM t WHERE name !~* 'x'",
        atomicLexemes: ["E'abc'", "U&'d\\0061t'", '!~*'],
        tags: ['prefixed-string', 'operator'],
    },
    {
        id: 'mysql-prefixed-literal-variable',
        dialect: 'mysql',
        expectation: 'required',
        source: "SELECT _utf8mb4'abc', 0b101, @user_id FROM t WHERE id = :id",
        atomicLexemes: ["_utf8mb4'abc'", '0b101', '@user_id', ':id'],
        tags: ['prefixed-string', 'number', 'parameter'],
    },
    {
        id: 'generic-array-without-from',
        dialect: 'generic',
        expectation: 'required',
        source: "SELECT ARRAY['a','b']",
        atomicLexemes: ["'a'", "'b'"],
        tags: ['array', 'no-from'],
    },
    {
        id: 'match-recognize-function-name',
        dialect: 'generic',
        expectation: 'required',
        source: 'SELECT match_recognize(a) AS value FROM t',
        atomicLexemes: [],
        tags: ['false-positive', 'function'],
    },
    {
        id: 'match-recognize-construct',
        dialect: 'generic',
        expectation: 'opaque',
        source: 'SELECT * FROM t MATCH_RECOGNIZE (PARTITION BY id ORDER BY ts PATTERN (A+) DEFINE A AS value > 0)',
        atomicLexemes: [],
        tags: ['unsupported', 'opaque'],
    },
    {
        id: 'unterminated-string',
        dialect: 'hive',
        expectation: 'invalid',
        source: "SELECT 'unterminated FROM t",
        atomicLexemes: [],
        tags: ['invalid', 'preserve-target'],
    },
]);
```

- [ ] **Step 4: Verify and commit the corpus**

Run:

```bash
npm run test:v2:parser-corpus
npm run test:verify
git add package.json tests/fixtures/v2-parser-evaluation-cases.js tests/v2/parser-evaluation-corpus.test.js
git commit -m "test: add v2 parser evaluation corpus"
```

Expected: targeted and 1.x regression tests pass, then one corpus-only commit is created.

---

### Task 3: Implement Candidate-Neutral Evaluation Gates

**Files:**
- Create: `scripts/v2-parser-evaluation/evaluator.js`
- Create: `tests/v2/parser-evaluation-harness.test.js`
- Modify: `package.json`

**Interfaces:**
- Consumes: Task 2 case schema and a candidate with `metadata` and `analyze(testCase)`.
- Produces: `evaluate_candidate`, `assert_leaf_partition`, `GATES`, and a closed decision role.

> **Post-implementation erratum (2026-07-11):** The original Task 3 example below is fail-open for empty denominators and malformed evidence. The governing design requires complete candidate/corpus/probe schema validation to abort evaluation before classification, while per-case candidate failures remain contained and fail closed; the hardened implementation and regression tests supersede the example behavior.

- [ ] **Step 1: Add the failing evaluator test**

Create `tests/v2/parser-evaluation-harness.test.js`:

```js
var assert = require('assert');
var evaluator = require('../../scripts/v2-parser-evaluation/evaluator');
var cases = [
    { id: 'required', dialect: 'hive', expectation: 'required', source: 'SELECT 1', atomicLexemes: [], tags: [] },
    { id: 'atomic', dialect: 'postgresql', expectation: 'required', source: '$1', atomicLexemes: ['$1'], tags: [] },
    { id: 'invalid', dialect: 'hive', expectation: 'invalid', source: "'", atomicLexemes: [], tags: [] },
];

function candidate(failRequired) {
    return {
        metadata: { name: 'fake', version: '1.0.0', license: 'MIT' },
        analyze: function(testCase) {
            var accepted = testCase.expectation != 'invalid';
            if (failRequired && testCase.id == 'required') {
                accepted = false;
            }
            return {
                accepted: accepted,
                errors: accepted ? [] : ['rejected'],
                leaves: [{ kind: 'token', raw: testCase.source, span: { start: 0, end: testCase.source.length } }],
                nodeCount: accepted ? 1 : 0,
                nodeSpansValid: accepted,
            };
        },
    };
}

function probe(overrides) {
    return Object.assign({
        bundleBytes: 1024,
        gzipBytes: 512,
        coldStartMedianMs: 10,
        scaleRatio: 8,
        parse1200MedianMs: 50,
        bundledPackages: [{ name: 'fake', version: '1.0.0', license: 'MIT' }],
    }, overrides || {});
}

var runtime = evaluator.evaluate_candidate(candidate(false), cases, probe());
assert.strictEqual(runtime.decision.role, 'runtime-grammar-backend');
assert.strictEqual(runtime.decision.canOwnLeafStream, true);
var oracle = evaluator.evaluate_candidate(candidate(false), cases, probe({
    bundleBytes: evaluator.GATES.maxBundleBytes + 1,
}));
assert.strictEqual(oracle.decision.role, 'development-oracle');
var rejected = evaluator.evaluate_candidate(candidate(true), cases, probe());
assert.strictEqual(rejected.decision.role, 'rejected');
assert.throws(function() {
    evaluator.assert_leaf_partition('abc', [
        { raw: 'a', span: { start: 0, end: 1 } },
        { raw: 'c', span: { start: 2, end: 3 } },
    ]);
}, /gap-free/);
console.log('v2 parser evaluation harness tests passed');
```

Add:

```json
"test:v2:parser-harness": "node tests/v2/parser-evaluation-harness.test.js"
```

- [ ] **Step 2: Verify the missing-evaluator failure**

Run:

```bash
npm run test:v2:parser-harness
```

Expected: FAIL because the evaluator module does not exist.

- [ ] **Step 3: Implement the evaluator**

Create `scripts/v2-parser-evaluation/evaluator.js`:

```js
var assert = require('assert');
var GATES = Object.freeze({
    requiredParseRate: 1,
    invalidRejectRate: 1,
    roundTripRate: 1,
    requiredNodeSpanRate: 1,
    maxBundleBytes: 5 * 1024 * 1024,
    maxGzipBytes: 1536 * 1024,
    maxColdStartMedianMs: 400,
    maxScaleRatio: 12,
});
var ALLOWED_LICENSES = ['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC'];

function rate(passed, total) {
    return total == 0 ? 1 : passed / total;
}

function license_allowed(value) {
    var text = String(value || '');
    return ALLOWED_LICENSES.some(function(license) {
        return text.indexOf(license) >= 0;
    });
}

function assert_leaf_partition(source, leaves) {
    assert.ok(Array.isArray(leaves), 'candidate leaves must be an array');
    var cursor = 0;
    var rebuilt = '';
    leaves.forEach(function(leaf, index) {
        assert.strictEqual(leaf.span.start, cursor, 'leaf partition must be gap-free at ' + index);
        assert.strictEqual(leaf.span.end, leaf.span.start + leaf.raw.length, 'leaf end at ' + index);
        rebuilt += leaf.raw;
        cursor = leaf.span.end;
    });
    assert.strictEqual(cursor, source.length, 'leaf partition must cover source');
    assert.strictEqual(rebuilt, source, 'leaf raw values must rebuild source');
}

function evaluate_case(candidate, testCase) {
    var result;
    try {
        result = candidate.analyze(testCase);
    } catch (error) {
        result = {
            accepted: false,
            errors: [error && error.message ? error.message : String(error)],
            leaves: [],
            nodeCount: 0,
            nodeSpansValid: false,
        };
    }
    var roundTrip = true;
    try {
        assert_leaf_partition(testCase.source, result.leaves);
    } catch (error) {
        roundTrip = false;
    }
    var atomicPassed = testCase.atomicLexemes.filter(function(lexeme) {
        return result.leaves.some(function(leaf) { return leaf.raw == lexeme; });
    }).length;
    return {
        id: testCase.id,
        expectation: testCase.expectation,
        accepted: result.accepted === true,
        errors: Array.isArray(result.errors) ? result.errors : [],
        nodeCount: Number(result.nodeCount || 0),
        nodeSpansValid: result.nodeSpansValid === true,
        roundTrip: roundTrip,
        atomicPassed: atomicPassed,
        atomicTotal: testCase.atomicLexemes.length,
    };
}

function evaluate_candidate(candidate, cases, probe) {
    var outcomes = cases.map(function(testCase) { return evaluate_case(candidate, testCase); });
    var required = outcomes.filter(function(item) { return item.expectation == 'required'; });
    var invalid = outcomes.filter(function(item) { return item.expectation == 'invalid'; });
    var atomicPassed = outcomes.reduce(function(total, item) { return total + item.atomicPassed; }, 0);
    var atomicTotal = outcomes.reduce(function(total, item) { return total + item.atomicTotal; }, 0);
    var summary = {
        totalCases: outcomes.length,
        requiredParseRate: rate(required.filter(function(item) { return item.accepted; }).length, required.length),
        invalidRejectRate: rate(invalid.filter(function(item) { return !item.accepted; }).length, invalid.length),
        roundTripRate: rate(outcomes.filter(function(item) { return item.roundTrip; }).length, outcomes.length),
        requiredNodeSpanRate: rate(required.filter(function(item) {
            return item.accepted && item.nodeSpansValid;
        }).length, required.length),
        atomicLexemeRate: rate(atomicPassed, atomicTotal),
    };
    var licensePass = license_allowed(candidate.metadata.license)
        && probe.bundledPackages.length > 0
        && probe.bundledPackages.every(function(item) { return license_allowed(item.license); });
    var grammarPass = summary.requiredParseRate >= GATES.requiredParseRate
        && summary.invalidRejectRate >= GATES.invalidRejectRate
        && summary.roundTripRate >= GATES.roundTripRate
        && summary.requiredNodeSpanRate >= GATES.requiredNodeSpanRate;
    var packagingPass = probe.bundleBytes <= GATES.maxBundleBytes
        && probe.gzipBytes <= GATES.maxGzipBytes;
    var performancePass = probe.coldStartMedianMs <= GATES.maxColdStartMedianMs
        && probe.scaleRatio <= GATES.maxScaleRatio;
    var role = 'rejected';
    if (grammarPass && licensePass) {
        role = packagingPass && performancePass ? 'runtime-grammar-backend' : 'development-oracle';
    }
    return {
        candidate: candidate.metadata,
        gates: GATES,
        outcomes: outcomes,
        summary: summary,
        probe: probe,
        decision: {
            role: role,
            canOwnLeafStream: summary.roundTripRate == 1 && summary.atomicLexemeRate == 1,
            grammarPass: grammarPass,
            licensePass: licensePass,
            packagingPass: packagingPass,
            performancePass: performancePass,
        },
    };
}

exports.GATES = GATES;
exports.assert_leaf_partition = assert_leaf_partition;
exports.evaluate_candidate = evaluate_candidate;
```

- [ ] **Step 4: Verify and commit all evaluator branches**

Run:

```bash
npm run test:v2:parser-harness
npm run test:verify
git add package.json scripts/v2-parser-evaluation/evaluator.js tests/v2/parser-evaluation-harness.test.js
git commit -m "test: add v2 parser evaluation gates"
```

Expected: targeted and 1.x regression tests pass, then one evaluator-only commit is created.

---

### Task 4: Add the dt-sql-parser Candidate and Objective Probes

**Files:**
- Create: `scripts/v2-parser-evaluation/candidates/dt-sql-parser.js`
- Create: `scripts/v2-parser-evaluation/candidates/dt-entry.js`
- Create: `scripts/v2-parser-evaluation/cold-start.js`
- Create: `scripts/v2-parser-evaluation/probe-dt-sql-parser.js`
- Create: `tests/v2/dt-sql-parser-candidate.test.js`
- Modify: `package.json`

**Interfaces:**
- Consumes: `dt-sql-parser` public `HiveSQL`, `GenericSQL`, `PostgreSQL`, `MySQL`, `validate`, `getAllTokens`, and `parse` APIs.
- Produces: candidate `metadata`, `analyze(testCase)`, and `probe_dt_sql_parser(candidate)`.

- [ ] **Step 1: Add the failing adapter integration test**

Create `tests/v2/dt-sql-parser-candidate.test.js`:

```js
var assert = require('assert');
var cases = require('../fixtures/v2-parser-evaluation-cases');
var evaluator = require('../../scripts/v2-parser-evaluation/evaluator');
var candidate = require('../../scripts/v2-parser-evaluation/candidates/dt-sql-parser');

assert.strictEqual(candidate.metadata.name, 'dt-sql-parser');
assert.strictEqual(candidate.metadata.version, '4.5.0');
assert.ok(candidate.metadata.license.indexOf('MIT') >= 0);
cases.forEach(function(testCase) {
    var result = candidate.analyze(testCase);
    assert.strictEqual(typeof result.accepted, 'boolean', testCase.id + ' accepted');
    assert.ok(Array.isArray(result.errors), testCase.id + ' errors');
    assert.ok(Array.isArray(result.leaves), testCase.id + ' leaves');
    assert.strictEqual(typeof result.nodeCount, 'number', testCase.id + ' nodeCount');
    assert.strictEqual(typeof result.nodeSpansValid, 'boolean', testCase.id + ' nodeSpansValid');
    evaluator.assert_leaf_partition(testCase.source, result.leaves);
});
console.log('dt-sql-parser candidate adapter tests passed');
```

Add:

```json
"test:v2:dt-parser": "node tests/v2/dt-sql-parser-candidate.test.js"
```

- [ ] **Step 2: Verify the missing-adapter failure**

Run:

```bash
npm run test:v2:dt-parser
```

Expected: FAIL because the candidate adapter does not exist.

- [ ] **Step 3: Implement the dt-sql-parser adapter**

Create `scripts/v2-parser-evaluation/candidates/dt-sql-parser.js`:

```js
var fs = require('fs');
var path = require('path');
var dtSqlParser = require('dt-sql-parser');
var constructors = {
    hive: dtSqlParser.HiveSQL,
    generic: dtSqlParser.GenericSQL,
    postgresql: dtSqlParser.PostgreSQL,
    mysql: dtSqlParser.MySQL,
};
var instances = Object.create(null);

function package_metadata() {
    var current = path.dirname(require.resolve('dt-sql-parser'));
    while (current != path.dirname(current)) {
        var packagePath = path.join(current, 'package.json');
        if (fs.existsSync(packagePath)) {
            var value = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
            if (value.name == 'dt-sql-parser') {
                return value;
            }
        }
        current = path.dirname(current);
    }
    throw new Error('dt-sql-parser package metadata not found');
}

function parser_for(dialect) {
    if (!instances[dialect]) {
        var Constructor = constructors[dialect];
        if (!Constructor) {
            throw new Error('unsupported evaluation dialect: ' + dialect);
        }
        instances[dialect] = new Constructor();
    }
    return instances[dialect];
}

function leaves_from_tokens(source, tokens) {
    var usable = tokens.filter(function(token) {
        return Number.isInteger(token.start)
            && Number.isInteger(token.stop)
            && token.start >= 0
            && token.stop >= token.start
            && token.start < source.length;
    }).sort(function(left, right) {
        return left.start - right.start || left.stop - right.stop;
    });
    var leaves = [];
    var cursor = 0;
    usable.forEach(function(token) {
        var end = Math.min(source.length, token.stop + 1);
        if (token.start < cursor) {
            return;
        }
        if (token.start > cursor) {
            leaves.push({
                kind: 'gap',
                raw: source.slice(cursor, token.start),
                span: { start: cursor, end: token.start },
            });
        }
        leaves.push({
            kind: token.channel == 0 ? 'token' : 'trivia',
            raw: source.slice(token.start, end),
            span: { start: token.start, end: end },
        });
        cursor = end;
    });
    if (cursor < source.length) {
        leaves.push({
            kind: 'gap',
            raw: source.slice(cursor),
            span: { start: cursor, end: source.length },
        });
    }
    if (leaves.length == 0 && source.length > 0) {
        leaves.push({
            kind: 'opaque',
            raw: source,
            span: { start: 0, end: source.length },
        });
    }
    return leaves;
}

function inspect_nodes(root, sourceLength) {
    var count = 0;
    var rangedCount = 0;
    var invalidSpanCount = 0;
    var stack = root ? [root] : [];
    var seen = new Set();
    while (stack.length > 0) {
        var node = stack.pop();
        if (!node || typeof node != 'object' || seen.has(node)) {
            continue;
        }
        seen.add(node);
        count++;
        var constructorName = node.constructor && node.constructor.name
            ? node.constructor.name
            : '';
        if (/Context$/.test(constructorName)) {
            rangedCount++;
            if (!node.start || !node.stop
                || !Number.isInteger(node.start.start)
                || !Number.isInteger(node.stop.stop)) {
                invalidSpanCount++;
            } else {
                var start = node.start.start;
                var end = node.stop.stop + 1;
                if (start < 0 || end < start || end > sourceLength) {
                    invalidSpanCount++;
                }
            }
        }
        if (Array.isArray(node.children)) {
            node.children.forEach(function(child) {
                stack.push(child);
            });
        }
    }
    return {
        count: count,
        valid: rangedCount > 0 && invalidSpanCount == 0,
    };
}

function analyze(testCase) {
    var parser = parser_for(testCase.dialect);
    var errors = [];
    var tokens = [];
    var root = null;
    try {
        errors = parser.validate(testCase.source).map(function(error) {
            return error.message || String(error);
        });
    } catch (error) {
        errors.push(error && error.message ? error.message : String(error));
    }
    try {
        tokens = parser.getAllTokens(testCase.source);
    } catch (error) {
        errors.push(error && error.message ? error.message : String(error));
    }
    if (errors.length == 0) {
        try {
            root = parser.parse(testCase.source);
        } catch (error) {
            errors.push(error && error.message ? error.message : String(error));
        }
    }
    var inspection = inspect_nodes(root, testCase.source.length);
    return {
        accepted: errors.length == 0,
        errors: errors,
        leaves: leaves_from_tokens(testCase.source, tokens),
        nodeCount: inspection.count,
        nodeSpansValid: inspection.valid,
    };
}

var metadata = package_metadata();
exports.metadata = {
    name: metadata.name,
    version: metadata.version,
    license: metadata.license,
};
exports.analyze = analyze;
```

- [ ] **Step 4: Verify candidate partition safety**

Run:

```bash
npm run test:v2:dt-parser
```

Expected: PASS. Cases may be accepted or rejected, but every result reconstructs the complete source string and no parser exception crosses the adapter boundary.

- [ ] **Step 5: Add bundle, license, cold-start, and scaling probes**

Create `scripts/v2-parser-evaluation/candidates/dt-entry.js`:

```js
var HiveSQL = require('dt-sql-parser').HiveSQL;
module.exports = function create_hive_parser() {
    return new HiveSQL();
};
```

Create `scripts/v2-parser-evaluation/cold-start.js`:

```js
var started = process.hrtime.bigint();
var HiveSQL = require('dt-sql-parser').HiveSQL;
var parser = new HiveSQL();
parser.validate('SELECT 1');
var elapsedMs = Number(process.hrtime.bigint() - started) / 1000000;
process.stdout.write(String(elapsedMs));
```

Create `scripts/v2-parser-evaluation/probe-dt-sql-parser.js`:

```js
var fs = require('fs');
var os = require('os');
var path = require('path');
var zlib = require('zlib');
var childProcess = require('child_process');
var esbuild = require('esbuild');

function median(values) {
    var sorted = values.slice().sort(function(left, right) { return left - right; });
    return sorted[Math.floor(sorted.length / 2)] || 0;
}

function measure(action) {
    var started = process.hrtime.bigint();
    action();
    return Number(process.hrtime.bigint() - started) / 1000000;
}

function make_source(statementCount) {
    return new Array(statementCount + 1).join(
        "SELECT id, ROW_NUMBER() OVER (PARTITION BY id ORDER BY ts DESC) AS rn FROM src WHERE ds='2026-07-11';\n"
    );
}

function package_name_from_input(inputPath) {
    var marker = 'node_modules/';
    var index = inputPath.lastIndexOf(marker);
    if (index < 0) {
        return null;
    }
    var parts = inputPath.slice(index + marker.length).split('/');
    return parts[0] && parts[0].charAt(0) == '@'
        ? parts.slice(0, 2).join('/')
        : parts[0];
}

function bundled_packages(metafile) {
    var names = Object.create(null);
    Object.keys(metafile.inputs).forEach(function(inputPath) {
        var name = package_name_from_input(inputPath);
        if (name) {
            names[name] = true;
        }
    });
    return Object.keys(names).sort().map(function(name) {
        var packagePath = path.join(process.cwd(), 'node_modules', name, 'package.json');
        var value = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
        return { name: value.name, version: value.version, license: value.license || '' };
    });
}

function cold_start_samples() {
    var script = path.join(__dirname, 'cold-start.js');
    var samples = [];
    for (var i = 0; i < 5; i++) {
        var result = childProcess.spawnSync(process.execPath, [script], {
            cwd: process.cwd(),
            encoding: 'utf8',
        });
        if (result.status != 0) {
            throw new Error(result.stderr || 'cold-start probe failed');
        }
        samples.push(Number(result.stdout));
    }
    return samples;
}

function parse_samples(candidate, count) {
    var testCase = {
        id: 'scale-' + count,
        dialect: 'hive',
        expectation: 'required',
        source: make_source(count),
        atomicLexemes: [],
        tags: ['performance'],
    };
    candidate.analyze(testCase);
    return [
        measure(function() { candidate.analyze(testCase); }),
        measure(function() { candidate.analyze(testCase); }),
        measure(function() { candidate.analyze(testCase); }),
    ];
}

function probe_dt_sql_parser(candidate) {
    var outputDir = path.join(process.cwd(), '.tmp', 'v2-parser-evaluation');
    var outputFile = path.join(outputDir, 'dt-sql-parser.cjs');
    fs.mkdirSync(outputDir, { recursive: true });
    var build = esbuild.buildSync({
        entryPoints: [path.join(__dirname, 'candidates', 'dt-entry.js')],
        outfile: outputFile,
        bundle: true,
        minify: true,
        platform: 'node',
        format: 'cjs',
        target: 'node18',
        metafile: true,
    });
    var bundle = fs.readFileSync(outputFile);
    var samples100 = parse_samples(candidate, 100);
    var samples800 = parse_samples(candidate, 800);
    var samples1200 = parse_samples(candidate, 1200);
    var median100 = median(samples100);
    var median800 = median(samples800);
    return {
        bundleBytes: bundle.length,
        gzipBytes: zlib.gzipSync(bundle).length,
        coldStartMedianMs: median(cold_start_samples()),
        parse100MedianMs: median100,
        parse800MedianMs: median800,
        parse1200MedianMs: median(samples1200),
        scaleRatio: median800 / Math.max(0.001, median100),
        maxRssKb: process.resourceUsage().maxRSS,
        environment: {
            node: process.version,
            platform: process.platform,
            arch: process.arch,
            cpu: os.cpus()[0] ? os.cpus()[0].model : 'unknown',
        },
        bundledPackages: bundled_packages(build.metafile),
    };
}

exports.probe_dt_sql_parser = probe_dt_sql_parser;
```

- [ ] **Step 6: Smoke-test objective metrics**

Run:

```bash
node -e "var c=require('./scripts/v2-parser-evaluation/candidates/dt-sql-parser'); var p=require('./scripts/v2-parser-evaluation/probe-dt-sql-parser').probe_dt_sql_parser(c); console.log(JSON.stringify(p, null, 2));"
```

Expected: positive bundle/gzip/cold-start/parse/max-RSS values, a finite scale ratio, concrete Node/platform/CPU metadata, and a non-empty package list.

- [ ] **Step 7: Commit candidate probes**

Run:

```bash
npm run test:v2:dt-parser
npm run test:verify
git add package.json scripts/v2-parser-evaluation/candidates scripts/v2-parser-evaluation/cold-start.js scripts/v2-parser-evaluation/probe-dt-sql-parser.js tests/v2/dt-sql-parser-candidate.test.js
git commit -m "chore: add v2 parser candidate probes"
```

Expected: candidate and 1.x regression tests pass, one candidate-probe commit is created, and `.tmp/` is not staged.

---

### Task 5: Generate and Commit the Parser Decision

**Files:**
- Create: `scripts/v2-parser-evaluation/report.js`
- Create: `scripts/v2-parser-evaluation/run.js`
- Create: `docs/technical/v2-parser-evaluation-report.md`
- Create: `docs/technical/adr/0001-v2-parser-backend.md`
- Create: `tests/v2/parser-evaluation-report.test.js`
- Modify: `package.json`

**Interfaces:**
- Consumes: corpus, evaluator, candidate, and objective probe.
- Produces: reproducible evidence plus one of `runtime-grammar-backend`, `development-oracle`, or `rejected`.

- [ ] **Step 1: Add deterministic Markdown renderers**

Create `scripts/v2-parser-evaluation/report.js`:

```js
function percent(value) {
    return (value * 100).toFixed(2) + '%';
}

function bool(value) {
    return value ? 'pass' : 'fail';
}

function render_report(report) {
    return [
        '# SQL Formatter v2 Parser Evaluation Report',
        '',
        '- Candidate: ' + report.candidate.name + '@' + report.candidate.version,
        '- Candidate license: ' + report.candidate.license,
        '- Decision: ' + report.decision.role,
        '- Can own lossless leaf stream: ' + String(report.decision.canOwnLeafStream),
        '',
        '## Correctness',
        '',
        '| Metric | Actual | Gate |',
        '| --- | ---: | ---: |',
        '| Required parse rate | ' + percent(report.summary.requiredParseRate) + ' | 100.00% |',
        '| Invalid reject rate | ' + percent(report.summary.invalidRejectRate) + ' | 100.00% |',
        '| Source round-trip rate | ' + percent(report.summary.roundTripRate) + ' | 100.00% |',
        '| Required case node-range rate | ' + percent(report.summary.requiredNodeSpanRate) + ' | 100.00% |',
        '| Atomic lexeme rate | ' + percent(report.summary.atomicLexemeRate) + ' | informational |',
        '',
        '## Packaging and Performance',
        '',
        '| Metric | Actual | Gate |',
        '| --- | ---: | ---: |',
        '| Minified bundle bytes | ' + report.probe.bundleBytes + ' | <= ' + report.gates.maxBundleBytes + ' |',
        '| Gzip bundle bytes | ' + report.probe.gzipBytes + ' | <= ' + report.gates.maxGzipBytes + ' |',
        '| Cold start median ms | ' + report.probe.coldStartMedianMs.toFixed(2) + ' | <= ' + report.gates.maxColdStartMedianMs + ' |',
        '| 100 statement median ms | ' + report.probe.parse100MedianMs.toFixed(2) + ' | baseline |',
        '| 800 statement median ms | ' + report.probe.parse800MedianMs.toFixed(2) + ' | baseline |',
        '| 1200 statement median ms | ' + report.probe.parse1200MedianMs.toFixed(2) + ' | baseline |',
        '| 8x scale ratio | ' + report.probe.scaleRatio.toFixed(2) + ' | <= ' + report.gates.maxScaleRatio + ' |',
        '| Maximum RSS KiB | ' + report.probe.maxRssKb + ' | baseline |',
        '| Node/platform | ' + report.probe.environment.node + ' / ' + report.probe.environment.platform + '-' + report.probe.environment.arch + ' | recorded |',
        '',
        '## Gate Results',
        '',
        '- Grammar: ' + bool(report.decision.grammarPass),
        '- License: ' + bool(report.decision.licensePass),
        '- Packaging: ' + bool(report.decision.packagingPass),
        '- Performance: ' + bool(report.decision.performancePass),
        '',
        '## Case Outcomes',
        '',
        '| Case | Expected | Accepted | Round trip | Node ranges | Nodes |',
        '| --- | --- | --- | --- | --- | ---: |',
    ].concat(report.outcomes.map(function(item) {
        return '| ' + item.id + ' | ' + item.expectation + ' | '
            + String(item.accepted) + ' | ' + String(item.roundTrip) + ' | '
            + String(item.nodeSpansValid) + ' | '
            + item.nodeCount + ' |';
    })).concat([
        '',
        '## Bundled Packages',
        '',
    ], report.probe.bundledPackages.map(function(item) {
        return '- ' + item.name + '@' + item.version + ' — ' + item.license;
    }), [
        '',
        'This report is Wave 0 evidence and does not change the active formatter.',
        '',
    ]).join('\n');
}

function render_adr(report) {
    var roleText = {
        'runtime-grammar-backend': 'Use dt-sql-parser behind the project-owned lossless adapter as the v2 runtime grammar backend.',
        'development-oracle': 'Keep dt-sql-parser as a development-only differential oracle; implement the production grammar backend in-project.',
        'rejected': 'Do not use dt-sql-parser as a v2 backend or oracle; implement and validate the production grammar backend in-project.',
    }[report.decision.role];
    return [
        '# ADR 0001: SQL Formatter v2 Parser Backend',
        '',
        '- Status: Accepted',
        '- Candidate: ' + report.candidate.name + '@' + report.candidate.version,
        '- Decision role: ' + report.decision.role,
        '',
        '## Context',
        '',
        'The formatter requires Hive-first grammar coverage without surrendering exact source text, opaque fallback, package discipline, or near-linear scaling.',
        '',
        '## Decision',
        '',
        roleText,
        '',
        'A project-owned lossless lexer remains mandatory in every outcome. External parser tokens cannot own protected source units unless atomic-lexeme and source-partition gates both pass.',
        '',
        '## Evidence',
        '',
        '- Required parse rate: ' + percent(report.summary.requiredParseRate),
        '- Source round-trip rate: ' + percent(report.summary.roundTripRate),
        '- Required case node-range rate: ' + percent(report.summary.requiredNodeSpanRate),
        '- Atomic lexeme rate: ' + percent(report.summary.atomicLexemeRate),
        '- Minified/gzip bytes: ' + report.probe.bundleBytes + ' / ' + report.probe.gzipBytes,
        '- Cold start median ms: ' + report.probe.coldStartMedianMs.toFixed(2),
        '- 8x scale ratio: ' + report.probe.scaleRatio.toFixed(2),
        '- Maximum RSS KiB: ' + report.probe.maxRssKb,
        '- Environment: ' + report.probe.environment.node + ' / ' + report.probe.environment.platform + '-' + report.probe.environment.arch + ' / ' + report.probe.environment.cpu,
        '',
        'Full per-case evidence is recorded in `docs/technical/v2-parser-evaluation-report.md`.',
        '',
        '## Consequences',
        '',
        '- Canonical CST, diagnostic, layout, and result types remain independent of candidate parse-tree classes.',
        '- No candidate package is imported by the shipping 1.x entrypoint.',
        '- Wave 1 can implement the lossless lexer without reopening the backend role unless committed evidence changes.',
        '',
    ].join('\n');
}

exports.render_report = render_report;
exports.render_adr = render_adr;
```

- [ ] **Step 2: Add the orchestrator**

Create `scripts/v2-parser-evaluation/run.js`:

```js
var fs = require('fs');
var path = require('path');
var cases = require('../../tests/fixtures/v2-parser-evaluation-cases');
var evaluator = require('./evaluator');
var candidate = require('./candidates/dt-sql-parser');
var probe = require('./probe-dt-sql-parser').probe_dt_sql_parser(candidate);
var renderer = require('./report');
var report = evaluator.evaluate_candidate(candidate, cases, probe);
var technicalRoot = path.join(process.cwd(), 'docs', 'technical');
var adrRoot = path.join(technicalRoot, 'adr');
fs.mkdirSync(adrRoot, { recursive: true });
fs.writeFileSync(path.join(technicalRoot, 'v2-parser-evaluation-report.md'), renderer.render_report(report));
fs.writeFileSync(path.join(adrRoot, '0001-v2-parser-backend.md'), renderer.render_adr(report));
console.log(JSON.stringify({
    candidate: report.candidate,
    decision: report.decision,
    summary: report.summary,
    probe: report.probe,
}, null, 2));
```

Add:

```json
"evaluate:v2:parser": "node scripts/v2-parser-evaluation/run.js"
```

- [ ] **Step 3: Generate the evidence and closed decision**

Run:

```bash
npm run evaluate:v2:parser
```

Expected: exit 0, measured JSON, and two Markdown files. The role is one of the three closed values; candidate rejection is a valid result.

- [ ] **Step 4: Add evidence completeness guards**

Create `tests/v2/parser-evaluation-report.test.js`:

```js
var fs = require('fs');
var path = require('path');
var assert = require('assert');
var reportPath = path.join(__dirname, '..', '..', 'docs', 'technical', 'v2-parser-evaluation-report.md');
var adrPath = path.join(__dirname, '..', '..', 'docs', 'technical', 'adr', '0001-v2-parser-backend.md');
var report = fs.readFileSync(reportPath, 'utf8');
var adr = fs.readFileSync(adrPath, 'utf8');
assert.ok(report.indexOf('dt-sql-parser@4.5.0') >= 0, 'exact candidate version');
assert.ok(report.indexOf('Required parse rate') >= 0, 'correctness evidence');
assert.ok(report.indexOf('Required case node-range rate') >= 0, 'source-range evidence');
assert.ok(report.indexOf('8x scale ratio') >= 0, 'scaling evidence');
assert.ok(report.indexOf('Maximum RSS KiB') >= 0, 'memory evidence');
assert.ok(report.indexOf('Node/platform') >= 0, 'environment evidence');
assert.ok(adr.indexOf('Status: Accepted') >= 0, 'accepted ADR');
assert.ok(adr.indexOf('project-owned lossless lexer') >= 0, 'owned lexer decision');
assert.ok(
    /Decision role: (runtime-grammar-backend|development-oracle|rejected)/.test(adr),
    'closed decision role'
);
console.log('v2 parser evaluation report tests passed');
```

Add:

```json
"test:v2:parser-report": "node tests/v2/parser-evaluation-report.test.js"
```

- [ ] **Step 5: Verify and commit measured evidence**

Run:

```bash
npm run test:v2:parser-report
npm run test:verify
git diff --check
git add package.json scripts/v2-parser-evaluation/report.js scripts/v2-parser-evaluation/run.js docs/technical/v2-parser-evaluation-report.md docs/technical/adr/0001-v2-parser-backend.md tests/v2/parser-evaluation-report.test.js
git commit -m "docs: record v2 parser backend decision"
```

Expected: report, 1.x regression, and diff checks pass; one evidence/ADR commit is created.

---

### Task 6: Integrate the Wave 0 Verification Boundary

**Files:**
- Create: `tests/v2/wave0-boundary.test.js`
- Modify: `package.json`

**Interfaces:**
- Consumes: all Wave 0 contracts, tests, and evidence.
- Produces: `test:v2:wave0` and a full `test:verify` path protecting Wave 0 and 1.x together.

- [ ] **Step 1: Add the shipping-boundary test**

Create `tests/v2/wave0-boundary.test.js`:

```js
var fs = require('fs');
var path = require('path');
var assert = require('assert');
var root = path.join(__dirname, '..', '..');
var packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
var vscodeIgnore = fs.readFileSync(path.join(root, '.vscodeignore'), 'utf8');
assert.strictEqual(packageJson.main, './extension.js', 'Wave 0 must not replace entrypoint');
assert.strictEqual((packageJson.dependencies || {})['dt-sql-parser'], undefined, 'no runtime parser dependency');
assert.strictEqual(packageJson.devDependencies['dt-sql-parser'], '4.5.0', 'candidate version');
assert.strictEqual(packageJson.devDependencies.typescript, '6.0.3', 'TypeScript version');
assert.strictEqual(packageJson.devDependencies.esbuild, '0.28.1', 'esbuild version');
assert.ok(vscodeIgnore.indexOf('node_modules/**') >= 0, 'exclude dependencies');
assert.ok(vscodeIgnore.indexOf('.tmp/**') >= 0, 'exclude evaluation output');
assert.ok(vscodeIgnore.indexOf('src/**') >= 0, 'exclude TypeScript source');
assert.ok(vscodeIgnore.indexOf('scripts/**') >= 0, 'exclude evaluation scripts');
console.log('v2 Wave 0 boundary tests passed');
```

- [ ] **Step 2: Add aggregate verification scripts**

Add:

```json
"test:v2:boundary": "node tests/v2/wave0-boundary.test.js",
"test:v2:wave0": "npm run typecheck:v2 && npm run test:v2:parser-corpus && npm run test:v2:parser-harness && npm run test:v2:dt-parser && npm run test:v2:parser-report && npm run test:v2:boundary"
```

Append `&& npm run test:v2:wave0` to the existing `test:verify` command.

- [ ] **Step 3: Run targeted and complete verification**

Run:

```bash
npm run test:v2:wave0
npm run test:verify
```

Expected: both pass; 1.x and Wave 0 are green in one command.

- [ ] **Step 4: Package and inspect the VSIX**

Run:

```bash
npm run package:vsix
npm exec -- vsce ls --tree
```

Expected:

- Packaging succeeds.
- Runtime `extension.js` and current `lib/` files are present.
- `src/`, `scripts/`, `tests/`, `docs/`, `.tmp/`, and `node_modules/dt-sql-parser` are absent.
- The generated VSIX remains ignored and uncommitted.

- [ ] **Step 5: Verify final scope and commit**

Run:

```bash
git diff --check
git status --short
git add package.json tests/v2/wave0-boundary.test.js
git commit -m "test: verify v2 wave 0 foundation"
```

Expected: only the two intended tracked changes are staged and the commit succeeds.

- [ ] **Step 6: Record completion evidence**

Run:

```bash
git status --short
git log --oneline -7
```

Expected: clean worktree and focused commits for contracts, corpus, gates, probes, decision, and aggregate verification.

## Wave 0 Completion Gate

Do not start Wave 1 until all conditions are true:

1. `npm run test:v2:wave0` passes.
2. `npm run test:verify` passes.
3. Parser report and ADR contain measured data and one closed role.
4. The ADR retains a project-owned lossless lexer.
5. `dt-sql-parser` is absent from `dependencies` and VSIX contents.
6. `src/core/` is not imported by the current extension or `lib/`.
7. The worktree is clean and all Wave 0 commits are independently reviewable.
8. Wave 1 receives its own focused design and plan for lossless lexing; this plan does not authorize Wave 1 implementation.
