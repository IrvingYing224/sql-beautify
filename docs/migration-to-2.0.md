# Migrating to SQL Beautify 2.0

SQL Beautify 2.0 replaces the 1.x formatter with the lossless v2 pipeline. It is a deliberate breaking release: there is one production implementation, no hidden 1.x fallback, and no guarantee that 1.x and 2.0 produce identical line-by-line layouts.

## VS Code users

The standard `Format Document` and `Format Selection` actions continue to work for the explicit `sql` and `hive-sql` language IDs. Existing keyboard shortcuts are unchanged, but broad language IDs that merely contain the word `sql` are no longer matched.

Update command IDs used by keybindings, tasks, or other extensions:

| Removed 1.x command | 2.0 command |
| --- | --- |
| `extension.beautifySql` | `sqlBeautify.formatSql` |
| `extension.beautifySqlddl` | `sqlBeautify.formatHiveDdl` |
| `extension.extractDdl` | `sqlBeautify.extractHiveDdl` |

Only `sqlBeautify.*` settings are read. There is no `extension.*` or `languageMode` fallback. Change `sqlBeautify.dialect: "postgres"` to `sqlBeautify.dialect: "postgresql"`. Hive remains the default and primary formatting target; `generic`, `postgresql`, and `mysql` only guarantee the capability states listed in the [support matrix](technical/sql-support-matrix.md).

The default `unsupportedSyntaxPolicy` is now `warn`. Known low-confidence constructs remain visible through editor diagnostics while safe surrounding structures may still be formatted. Use `preserve` for the same safe output without editor capability warnings, or `bail_out` to retain the complete target whenever such syntax is found. Explicit safe diagnostic reports and debug summaries retain aggregate diagnostic evidence under every policy.

Document, range, and multi-selection operations are atomic. Cancellation, a stale document, an unsafe range, a formatter failure, or rejection of any target causes the entire operation to make no edits.

## Node consumers

The package root, `vkbeautify.js`, `vkbeautify.sql(...)`, `sqlddl()`, `extractddl()`, and all root `lib/**` require paths were removed. Use the two explicit subpath exports:

```js
const { formatSql, lexSql } = require('vscode-sql-beautify/formatter');
const { formatHiveDdl, extractDdl } = require('vscode-sql-beautify/experimental/ddl');
```

`formatSql(source, options)` accepts one options object and returns a frozen structured result:

- `formatted` or `unchanged`: `text`, `diagnostics`, and a validated `sourceMap` are available.
- `preserved` or `failed`: `text` is the exact original source and no partial `sourceMap` is exposed.

The canonical dialect values are `hive`, `generic`, `postgresql`, and `mysql`. Positional formatting arguments and unknown option keys are rejected rather than silently mapped.

Experimental DDL APIs also return structured results. `formatHiveDdl()` only formats a fully consumed Hive `CREATE TABLE` subset. `extractDdl()` returns `extracted`, `unsupported`, `ambiguous`, `empty`, or `failed`; every non-success result retains the original source. It does not infer column types and uses the visible `__TYPE_REQUIRED__` placeholder unless a bounded `defaultType` is supplied.

The package does not currently ship standalone TypeScript declaration files. Treat the value API and result tags above as the supported JavaScript boundary.

## Output and rollback

Version 2.0 prioritizes lossless tokens, fail-closed behavior, idempotency, and transactional edits over 1.x snapshot compatibility. Review changed formatting in version control before applying it broadly.

If a workflow requires the old formatter or positional API, install the latest 1.x VSIX. Version 2.0 intentionally has no compatibility switch back to 1.x. The minimum supported VS Code version remains `1.90.0`.
