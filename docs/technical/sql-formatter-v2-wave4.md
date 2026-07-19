# SQL Formatter v2 Wave 4 Maintainer Contract

Wave 4 is the host-integration and experimental Hive DDL boundary for the v2 formatter. It is committed for validation and Wave 5 cutover work, but it does not replace the current 1.x VS Code provider or commands.

## Runtime Artifacts

`npm run build:v2-runtime` builds four ignored, reproducible artifacts:

- `dist/v2-core.cjs`: public `formatSql`/`lexSql` plus the adapter-private target formatter
- `dist/v2-ddl.cjs`: experimental `formatHiveDdl` and `extractDdl` only
- `dist/v2-format-bridge.cjs`: host-neutral compatibility bridge
- `dist/v2-worker.cjs`: persistent worker entry that loads `v2-core.cjs` instead of bundling formatter core

The artifacts are included in local VSIX verification so Wave 5 can cut over to known bundle boundaries. Generated `dist/**` and `.vsix` files remain ignored and must not be committed.

## Public Format Result

`formatSql(source, options)` returns a frozen discriminated result. `formatted` and `unchanged` include a validated source map. `preserved` and `failed` return the exact source text and never expose a partial source map.

The root `src/core/index.ts` value surface remains limited to `formatSql` and `lexSql`. Internal parse, analysis, layout, and target-format APIs are not public root values.

## Transaction Boundary

Document, range, and multi-selection formatting use the same transaction sequence:

1. Snapshot the document, target ranges, options, cancellation token, and formatter result.
2. Validate non-overlap, range ownership, protected boundaries, source maps, and diagnostics.
3. Compute every target before constructing edits.
4. Recheck document identity, version, and source before one host commit.
5. Return no edits after cancellation, stale state, preservation, failure, or host rejection.

Experimental DDL uses a dedicated atomic text transaction because its conservative layout does not yet produce a cursor source map. Only diagnostic-free, non-empty `formatted` or `extracted` results can reach the host commit. All other DDL statuses retain source text and produce no edit.

## Executor Boundary

Small requests use the direct executor. Large requests use one persistent worker selected by source code-unit and leaf-count thresholds. Both paths load the same formatter artifact and validate request identity, generation, document version, target id, source digest, and runtime digest.

Queued cancellation removes one request. Active cancellation retires the worker before queued work continues. Timeout, crash, malformed response, stale response, and concurrent disposal all fail closed.

## Experimental Hive DDL

The v2 DDL formatter accepts only a fully consumed Hive `CREATE TABLE` subset. It supports qualified/quoted names, `IF NOT EXISTS`, column comments, `DECIMAL`, `ARRAY`, `MAP`, and nested `STRUCT` types. It preserves the complete source for SQL line/block comments, constraints, defaults, unknown suffixes, malformed delimiters, and multiple statements.

Extract DDL uses query CST ownership. It requires exactly one structured query and a complete, unambiguous projection schema. Wildcards, unresolved expressions without aliases, duplicate Hive output names, malformed aliases, and set-branch schema mismatches reject the whole operation. The only wildcard scalar shape accepted by the projection safety rule is structurally exact `count(*)`. No type inference is claimed: callers receive `__TYPE_REQUIRED__` unless they provide a bounded `defaultType`.

## Verification

`npm run test:v2:wave4` builds the core/runtime artifacts and runs API, transaction, executor, DDL, property, performance, and boundary tests. `npm run test:verify` also reruns Wave 0-3 and the complete 1.x regression suite.

Before Wave 5 cutover, verify:

```bash
npm run test:verify
npm run package:vsix
npm exec -- vsce ls --tree
git diff --name-status -- extension.js vkbeautify.js lib package-lock.json
git diff --check
```

Wave 4 completion does not authorize merging to `main`, publishing a VSIX, or changing current 1.x command/configuration behavior. Those actions belong to the Wave 5 release gate.
