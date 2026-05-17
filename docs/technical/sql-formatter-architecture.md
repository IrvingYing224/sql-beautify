# SQL Formatter Architecture

This document is for maintainers. User-facing behavior belongs in `README.md`.

## Boundaries

- `lib/core/`: SQL formatting core. It owns tokenization, shielding, canonical options, registries, clause splitting, comment/code line modeling, case/select/condition formatting, layout rendering, and keyword casing.
- `lib/adapters/`: host integration. It owns VS Code configuration mapping, VS Code command/provider orchestration, range-safety enforcement, and user-facing diagnostics.
- `lib/experimental/ddl/`: experimental Hive DDL formatting and Extract DDL. It is intentionally outside the main SQL formatter responsibility layer.
- Root `lib/*.js` files are compatibility shims only. They must remain single-line re-exports and must not contain formatter logic.
- `lib/core/sql-token-primitives.js`: shared token-aware primitives for top-level item splitting and code/comment boundaries. New SQL boundary logic must reuse it instead of re-implementing character scans.

## Pipeline

```mermaid
flowchart LR
    A["adapter canonical options"] --> B["core sql-formatter"]
    B --> C["SET payload protection"]
    C --> D["token shield"]
    D --> E["comment protection"]
    E --> F["opaque clause protection"]
    F --> G["lexical normalization"]
    G --> H["clause splitting"]
    H --> I["select/condition/layout passes"]
    I --> J["restore comments and shields"]
    J --> K["case/select/comment alignment"]
    K --> L["keyword case"]
    L --> M["opaque restore and comment spacing"]
```

## Core Rules

- Core accepts canonical option names only: `keywordCase`, `commaStyle`, `indentStyle`, `maxAlignWidth`, `caseWhenThenWrapLength`, `dialect`, and `unsupportedSyntaxPolicy`.
- Core must not import `lib/adapters/` or `lib/experimental/`.
- VS Code configuration accepts `sqlBeautify.*` only. Positional `vkbeautify.sql(...)` arguments remain a wrapper responsibility for the JS API.
- Comments, strings, block comments, quoted identifiers, and opaque unsupported syntax must be protected before broad formatting passes.
- Comment/layout interaction must use code/comment models or explicit state, not fake SQL marker strings.
- Layout must render the requested indentation directly. It must not render tabs first and globally replace them later.
- Output whitespace contract: preserve at most one user blank line between logical blocks, normalize line endings to LF, and emit exactly one trailing newline.
- Range formatting contract: only whole-line, clause-safe, structurally balanced fragments are formatted; unsafe fragments are rejected rather than speculatively rewritten.

## Shared Format Model

`lib/core/sql-format-model.js` provides reusable line-level facts for passes that need code/comment split, parenthesis delta, and CASE balance. It does not replace the tokenizer and must not become a mutable global cache. The model exists to reduce repeated tokenization and prevent comment / condition / layout passes from deriving conflicting facts from the same line.

## Verification Contract

- `tests/module-boundary.test.js` checks the live core source graph for forbidden legacy markers and dependency direction.
- `tests/canonical-core-boundary.test.js` checks canonical options through the core path.
- `tests/layout-marker-leakage.test.js` protects user-authored text that resembles removed historical markers.
- `tests/generated-support-matrix.test.js` keeps `docs/technical/sql-support-matrix.md` synchronized with clause/operator registries.

## Unsupported Policy

Unsupported syntax detection has two inputs:

- Opaque protection for constructs whose body must not be rewritten.
- A lightweight syntax risk detector for known dialect mismatches or known unmodeled constructs.

This is still not a full parser. The policy means "known low-confidence syntax", not "every possible unsupported SQL grammar form". Opaque constructs must be preserved through shielding before broad rewrites; detector-only findings are context-aware and are reported without implying that every detected fragment was isolated as an opaque preserved segment. Experimental DDL should remain clearly labeled and tested separately.

Detector findings must not be based on word value alone. Keyword-shaped identifiers, aliases, and expression function names such as `qualify`, `merge`, or `pivot` are valid formatter inputs unless they appear at a recognized clause or table-construct boundary. Clause splitting follows the same rule so a `SELECT qualify AS c` list item is not rewritten into a `QUALIFY` clause.

`unsupportedSyntaxPolicy` currently supports:

- `preserve`: keep protected opaque syntax intact, record detected low-confidence syntax, and continue formatting around it
- `warn`: keep formatting behavior, and emit a runtime warning through the adapter diagnostics path; the warning does not imply every detected fragment was opaque-preserved
- `bail_out`: abort formatting when known low-confidence syntax is detected

## Diagnostics Contract

- Formatter exceptions surface as user-visible errors and do not replace the source text.
- Unsafe range fragments are rejected in both the VS Code range formatter and command-driven selection formatting.
- `warn` diagnostics are user-visible warnings, not debug-only logs.
- `sqlBeautify.debugDiagnostics=true` adds structured payloads to the extension host console; it does not change formatting behavior.
