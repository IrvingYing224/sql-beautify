# Token Spacing Policy Consolidation Design

## Objective

Centralize SQL token spacing decisions so the structured renderer, render-width estimation, and snippet-level token rendering use one shared policy.

This is an architecture and stability cleanup. It should not intentionally change formatted SQL output. The formatter has recently exposed two symptoms of duplicated spacing logic:

- trailing comment alignment could drift when planned width did not match final rendered token spacing
- inline comma spacing could differ between function arguments, `IN (...)`, and `ORDER BY` lists

The target state is that common token-adjacency choices are owned by one module:

```text
lib/core/sql-render-token-spacing.js
```

Callers may still decide which token sequence to render and which contextual options apply, but they must not carry private copies of comma, parenthesis, operator, window `ORDER BY`, `GROUP BY`, or leading-comma spacing rules.

## Current State

Confirmed from the current code:

- `lib/core/sql-render-line.js` delegates final line token spacing to `sql-render-token-spacing.js`.
- `lib/core/sql-render-width.js` already uses `sql-render-token-spacing.js` when a line needs planned rendered text instead of original source text.
- `lib/core/sql-token-renderer.js` still implements a separate local token rendering loop with private helpers and branches for:
  - trailing-space trimming
  - leading comma prefix detection
  - scope lookup by open/close paren token index
  - `IN` parenthesis spacing
  - comma-following spacing
  - window `ORDER BY` spacing
  - unary number joining

`sql-token-renderer.js` is used by mutation-planning helpers such as `sql-select-mutations.js` and `sql-case-mutations.js`. That makes it a real runtime path, not a test-only helper. If it formats a token snippet differently from the final structured renderer, mutation planning can compute text that later does not match final rendering.

`sql-render-token-spacing.js` is currently the closest thing to a policy owner, but its public surface is too narrow for snippet rendering:

```js
exports.token_value = token_value;
exports.append_visible_token = append_visible_token;
```

`append_visible_token()` renders one token at a time. It works well for line assembly and width estimation, but snippet rendering still needs repeated boilerplate for:

- skipping null tokens
- keyword casing
- choosing the rendered token value
- applying explicit snippet options before appending
- resetting previous-token state after inserted line breaks if future callers need it

That missing sequence-level helper is why `sql-token-renderer.js` kept its own spacing logic.

## Design

Keep `sql-render-token-spacing.js` as the single token spacing policy owner and extend it with a small sequence-level helper.

Expected public surface after this plan:

```js
exports.token_value = token_value;
exports.append_visible_token = append_visible_token;
exports.render_visible_tokens = render_visible_tokens;
```

`render_visible_tokens(document, tokens, options)` should render a token array by calling `append_visible_token()` for spacing-sensitive token adjacency. It should own the common rendering loop that `sql-token-renderer.js` currently duplicates.

`sql-token-renderer.js` should remain as the compatibility facade for existing mutation callers:

```js
var sqlRenderTokenSpacing = require('./sql-render-token-spacing');

function render_tokens(document, tokens, options) {
    return sqlRenderTokenSpacing.render_visible_tokens(document, tokens, options);
}

exports.render_tokens = render_tokens;
```

The facade keeps the existing module dependency from `sql-select-mutations.js` and `sql-case-mutations.js` stable. It also makes the architectural boundary explicit: mutation modules ask for token rendering, but spacing policy lives in the renderer policy module.

## Behavior Contract

The implementation must preserve these current behaviors:

- `coalesce(a,b,'x')` renders as `coalesce(a, b, 'x')`.
- `IN (1,2,3)` renders as `IN (1, 2, 3)`.
- `ORDER BY a DESC,b DESC` renders as `ORDER BY a DESC, b DESC`.
- Existing window `ORDER BY` spacing is preserved, including the current double space before the first expression when enabled by the caller.
- SELECT leading-comma style remains compact after the comma:

  ```sql
  SELECT  a
         ,b
         ,c
  ```

- Strings, comments, block comments, and quoted identifiers remain opaque and are not scanned by spacing regexes.
- Comment alignment width calculation continues to match the final rendered code width.
- `GROUPING SETS` parenthesis and comma behavior is preserved unless an existing test explicitly expects otherwise.

No public VS Code setting, root shim, adapter, experimental DDL module, or README behavior should change.

## API Shape

`render_visible_tokens(document, tokens, options)` should support the existing `sql-token-renderer.js` options:

```js
{
    applyKeywordCase: true,
    keywordCase: 'upper',
    unaryNumberMode: 'select',
    windowOrderBySpacing: true,
    spaceBeforeInParen: true,
    preserveCommaGapTokenIndexes: {},
    preserveCommaGapExceptFunctionName: 'COALESCE',
    compactOperatorToken: function(document, token) {},
    followsCompactOperator: function(document, previousToken, token) {},
    spacedScopeId: 123,
    dialect: 'generic',
    groupByLine: false
}
```

The helper should keep options narrow and current-use driven. Do not introduce a new abstract policy object or a second module such as `sql-spacing-policy.js` in this phase.

Where existing options overlap with `append_visible_token()` behavior, the sequence helper should translate options into the existing append path instead of adding parallel branches. If a behavior cannot be represented by the current append API, prefer adding a focused argument or option to `append_visible_token()` rather than implementing spacing directly inside `sql-token-renderer.js`.

## Module Boundaries

After migration:

- `sql-render-token-spacing.js` owns spacing predicates and adjacency rendering.
- `sql-token-renderer.js` exposes only `render_tokens` and delegates to `sql-render-token-spacing.js`.
- `sql-render-width.js` continues to use `sql-render-token-spacing.js`.
- `sql-render-line.js` continues to use `sql-render-token-spacing.js`.
- `sql-select-mutations.js` and `sql-case-mutations.js` continue to use `sql-token-renderer.js`.
- No mutation module should import `sql-render-token-spacing.js` directly in this plan. The facade remains the mutation boundary.

Add module-boundary tests that reject local reintroduction of these helper names in `sql-token-renderer.js`:

- `trim_trailing_space`
- `output_is_leading_comma_prefix`
- `follows_window_order_by`
- `token_inside_scope_kind`
- `owner_function_scope`
- `should_preserve_comma_gap`
- `should_join_unary_number`

The exact guard can be regex-based like existing `tests/module-boundary.test.js` checks. It should require `sql-token-renderer.js` to import `./sql-render-token-spacing`.

## Testing Strategy

Use tests to prove both behavior stability and boundary improvement:

- Add focused `tests/token-spacing-policy.test.js` coverage for final formatter outputs that combine function arguments, `IN`, `ORDER BY`, window `ORDER BY`, leading SELECT commas, and comment alignment width.
- Expand `tests/sql-token-renderer.test.js` so snippet rendering covers the same comma and window cases as final rendering.
- Expand `tests/render-width.test.js` only if a gap remains after the new policy test.
- Add module-boundary assertions preventing `sql-token-renderer.js` from regaining private spacing helpers.
- Run final verification with:

```bash
node tests/token-spacing-policy.test.js
node tests/sql-token-renderer.test.js
node tests/render-width.test.js
node tests/module-boundary.test.js
node tests/pipeline-idempotency.test.js
npm run test:verify
git diff --check
```

If implementation touches packaged runtime file lists or `package.json`, also run:

```bash
npm run package:vsix
```

Local verification commands do not use proxy.

## Risks

The main risk is accidentally changing long-standing spacing around edge constructs while replacing duplicate logic. Keep the migration staged:

1. Add failing boundary and behavior tests.
2. Add `render_visible_tokens()` while preserving existing callers.
3. Migrate `sql-token-renderer.js` to the shared helper.
4. Run targeted tests before broad regression.

The second risk is making `sql-render-token-spacing.js` too large. This plan accepts that tradeoff because central policy ownership is more valuable than splitting an immature abstraction. A later cleanup can split internal helpers only after the policy surface is stable.

The third risk is broadening mutation-module dependencies. Avoid it by keeping `sql-token-renderer.js` as the mutation-facing facade.

## Success Criteria

- All token spacing decisions used by `sql-token-renderer.js` flow through `sql-render-token-spacing.js`.
- `sql-token-renderer.js` becomes a thin facade and no longer contains private comma, paren, window, operator, or scope spacing helpers.
- Final formatter output remains stable except for changes explicitly approved by tests.
- Comment alignment width continues to match final rendered code.
- Module-boundary tests prevent the duplicated policy from returning.
