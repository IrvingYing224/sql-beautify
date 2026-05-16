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

## Verification Contract

- `tests/module-boundary.test.js` checks the live core source graph for forbidden legacy markers and dependency direction.
- `tests/canonical-core-boundary.test.js` checks canonical options through the core path.
- `tests/layout-marker-leakage.test.js` protects user-authored text that resembles removed historical markers.
- `tests/generated-support-matrix.test.js` keeps `docs/technical/sql-support-matrix.md` synchronized with clause/operator registries.

## Unsupported Policy

The formatter is not a full SQL parser. When confidence is low, preserve syntax through token shielding or opaque protection rather than performing speculative rewrites. Experimental DDL should remain clearly labeled and tested separately.

`unsupportedSyntaxPolicy` currently supports:

- `preserve`: keep unsupported syntax opaque and continue formatting around it
- `warn`: keep unsupported syntax opaque, continue formatting around it, and emit a runtime warning through the adapter diagnostics path
- `bail_out`: abort formatting when unsupported protected syntax is detected

## Diagnostics Contract

- Formatter exceptions surface as user-visible errors and do not replace the source text.
- Unsafe range fragments are rejected in both the VS Code range formatter and command-driven selection formatting.
- `warn` diagnostics are user-visible warnings, not debug-only logs.
- `sqlBeautify.debugDiagnostics=true` adds structured payloads to the extension host console; it does not change formatting behavior.
