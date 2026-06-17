# Select Header and Render Width Contract Design

## Objective

Fix two structural formatter weaknesses without replacing the current structured pipeline:

- SELECT header modifiers such as `DISTINCT` and `ALL` are not explicitly modeled, so they can leak into SELECT item ownership and affect first-field alignment.
- Comment alignment plans depend on `sql-render-width.js` predicting final rendered code width, while actual rendering is owned by the renderer path. This duplicated rendering logic can drift and has caused trailing comments to align only after a second formatting pass.

The goal is long-term stability, maintainability, and extensibility. This is not a cosmetic patch. It is a bounded architecture hardening of the existing `FormatDocument -> ScopeModel -> FormatNodes -> MutationPlan -> StructuredRenderer` pipeline.

## Confirmed Context

The current repository already has symptom-level regression coverage for `SELECT DISTINCT` / `SELECT ALL` field alignment and production-style trailing comment idempotency. The code still contains structural workarounds:

- `lib/core/sql-select-item-nodes.js` filters a first-line single-token `DISTINCT` / `ALL` pseudo-item with `is_select_modifier_item()`.
- `lib/core/sql-select-mutations.js` has `has_select_modifier_header_line()` to repair the first real field indentation when the header modifier sits on the SELECT line.
- `lib/core/sql-render-width.js` has its own token rendering, indentation, prefix, line join, and width simulation logic instead of consuming a renderer-owned pre-alignment line fact.

These workarounds fix specific outputs, but they do not establish durable contracts. Future SELECT header variants or renderer changes can reintroduce the same classes of bugs.

## Scope

In scope:

- Model SELECT header modifier ownership on SELECT list spans.
- Ensure SELECT items contain only real list items, not header tokens.
- Replace global `selectItem:0` first-item assumptions with owner-local ordering.
- Define the formatter behavior for `SELECT DISTINCT` and `SELECT ALL` header layout.
- Create a renderer-owned line facts boundary for comment alignment width planning.
- Add invariants that protect SELECT modifier ownership and planned-vs-rendered width consistency.
- Add regression tests for node shape, output behavior, comment alignment idempotency, and edge cases.

Out of scope:

- Replacing the formatter with a complete SQL AST.
- Rewriting CASE, condition, DDL, opaque unsupported syntax, or dialect detection behavior.
- Generalizing every possible SELECT header extension in this change. The design should leave a clear extension point, but only `DISTINCT` and `ALL` are implemented now.
- Changing VS Code configuration, adapter behavior, package metadata, or README.
- Moving root `lib/*.js` compatibility shims.

## Recommended Design

### 1. SELECT Header Model

Extend `selectList` spans produced by `lib/core/sql-list-nodes.js` with explicit header facts:

```js
{
    id: 'selectList:0',
    kind: 'selectList',
    startTokenIndex: selectToken.index,
    endTokenIndex: ...,
    startLine: selectToken.line,
    endLine: ...,
    header: {
        selectTokenId: selectToken.id,
        selectTokenIndex: selectToken.index,
        modifier: {
            kind: 'DISTINCT',
            tokenId: modifierToken.id,
            tokenIndex: modifierToken.index,
            line: modifierToken.line
        }
    },
    itemsStartTokenIndex: firstRealItemToken.index
}
```

When there is no modifier, `header.modifier` is `null` and `itemsStartTokenIndex` points to the first real item token after `SELECT`. If no real item token exists before the span boundary, `itemsStartTokenIndex` is `null` and item extraction returns no items for that span.

Only recognize `DISTINCT` or `ALL` when it is the first active code token after the owning `SELECT` token at the same query/list depth. Do not treat nested occurrences such as `COUNT(DISTINCT a)` as SELECT header modifiers.

This model should live in `sql-list-nodes.js` because list span extraction already owns SELECT list boundaries. `sql-select-item-nodes.js` should consume `span.itemsStartTokenIndex` instead of starting blindly at `span.startTokenIndex + 1`.

### 2. SELECT Item Ownership

Add owner-local item ordering to each item:

```js
{
    id: 'selectItem:7',
    ownerScopeId: 'selectList:0',
    ownerKind: 'selectList',
    ordinalInOwner: 0,
    ...
}
```

Use `ordinalInOwner` for first-item layout decisions instead of global ID checks like `item.id == 'selectItem:0'`. This avoids hidden coupling across nested SELECT lists, GROUP BY lists, and ORDER BY lists.

`DISTINCT` and `ALL` must not appear in `selectItem.tokens`. The old `is_select_modifier_item()` workaround should be removed or reduced to an assertion-only guard during implementation, then deleted once span-owned item starts are stable.

### 3. SELECT Modifier Layout Behavior

When a `selectList` span has `header.modifier`, the formatter should render the header modifier as part of the SELECT header, not as part of the first field.

Target behavior:

```sql
SELECT DISTINCT
        a
       ,b
FROM t
```

```sql
SELECT ALL
        a
       ,b
FROM t
```

This rule applies to structured SELECT list formatting. The first real field begins on the line after the header and aligns with later field expressions. The modifier does not participate in:

- SELECT item ownership
- leading comma migration
- first-item AS alignment width
- trailing comment grouping for SELECT fields
- CASE item coordination

Hive SELECT hints remain separate from this behavior. A line comment such as `--+ MAPJOIN(t)` after `SELECT` is not a modifier and must continue through existing hint-specific behavior.

### 4. Renderer-Owned Width Facts

Do not continue expanding `sql-render-width.js` as a second renderer. Introduce a renderer facts boundary near the current renderer helpers, either as a new focused module such as `lib/core/sql-render-line-facts.js` or as a carefully bounded export from `sql-render-line.js`.

The facts API should render each relevant line up to the same stage the real renderer uses immediately before comment alignment:

1. token rendering through `sql-render-line.render_line_from_tokens`
2. scope body indent
3. scope close indent
4. explicit line indent
5. moved separator line prefix
6. code/comment split before applying comment alignment

Line joins need separate facts because the current renderer appends joined source lines after rendering the current line. The facts API should expose both the unjoined current segment and the effective join prefix width used by comment alignment, without changing the renderer's ordering.

`sql-comment-mutations.js` should consume a context with facts such as:

```js
facts.codeWidthBeforeComment(lineIndex)
facts.alignmentWidthBeforeComment(lineIndex)
facts.joinPrefixWidth(lineIndex)
facts.codeSegmentBeforeComment(lineIndex)
facts.unjoinedCodeWidthBeforeComment(lineIndex)
facts.isCaseEndAliasCommentLine(lineIndex)
facts.isCaseBranchValueCommentLine(lineIndex)
```

`sql-render-width.js` may remain as the public facade to preserve module-boundary expectations, but its implementation should delegate to renderer-owned facts for line rendering, indentation, separator prefix, and join behavior. It should no longer own private token spacing or line render simulation logic.

The renderer facts must be computed before comment alignment mutations are applied. They should be based on the same mutation plan that comment alignment will use, excluding only the comment alignment columns being calculated.

### 5. Invariants

Add SELECT header invariants to `lib/core/sql-format-invariants.js`:

- A `selectList` span with `header.modifier` must have the modifier token inside the span.
- `itemsStartTokenIndex` must be greater than the modifier token index when a modifier exists.
- No `selectItem.tokens` entry may use the modifier token ID for its owner span.
- `ordinalInOwner` must be contiguous from zero within each owner.

Add render width invariants around comment alignment:

- For each `commentAlignment` mutation, the planned pre-comment code width must match the renderer-owned pre-alignment fact for that rendered line.
- Joined lines and moved separator prefixes must be checked through facts, not through final text after comment alignment.

If the invariant cannot be safely enforced for a special case, the implementation must document that case in code and cover it with a targeted regression. Silent fallback to a duplicated width calculation is not acceptable.

## Alternatives Considered

### Keep Existing Workarounds

This would retain `is_select_modifier_item()` and `has_select_modifier_header_line()` and add more tests. It is lower effort, but it keeps the structural bug alive. Future code still sees modifier handling as a SELECT item cleanup problem.

Rejected because it optimizes for short-term output, not long-term maintainability.

### Full SQL AST Rewrite

This would rebuild SELECT, CASE, CTE, functions, windows, unsupported syntax, and comments around a larger AST.

Rejected because the repository already has a structured formatter pipeline with usable boundaries. Replacing it would expand the risk surface dramatically and delay fixes to known defects.

### Bounded Contract Hardening

This is the recommended approach. It keeps the existing pipeline, but turns two missing assumptions into explicit contracts:

- SELECT header modifiers belong to SELECT spans.
- comment alignment width comes from renderer-owned pre-alignment facts.

This gives the implementation a stable extension point without forcing a broad parser rewrite.

## Testing Plan

Add or update focused tests:

- `tests/format-invariants.test.js`
  - SELECT span shape includes `header.modifier` and `itemsStartTokenIndex`.
  - SELECT items for `SELECT DISTINCT a, b FROM t` contain only `a` and `b`.
  - `ordinalInOwner` starts at zero for each SELECT/GROUP BY/ORDER BY owner.
  - invariants reject a modifier token inside item tokens.
- `tests/select-alignment.test.js`
  - `SELECT DISTINCT a, b FROM t` renders with `SELECT DISTINCT` as a header line and aligned fields.
  - `SELECT ALL a, b FROM t` uses the same behavior.
  - already-multiline `SELECT DISTINCT` remains idempotent.
  - nested SELECT lists with inner and outer modifiers both align correctly.
- `tests/comment-alignment.test.js`
  - production-style SELECT DISTINCT trailing comments align after one pass.
  - second formatting pass is byte-identical.
  - moved leading commas and CASE alias comments stay aligned.
- `tests/render-width.test.js`
  - width facade returns the same pre-comment code width as renderer facts for indentation, moved comma prefix, line join, and token spacing cases.
- `tests/module-boundary.test.js`
  - update allowed exports only if a new renderer facts module is introduced.
  - ensure `sql-comment-mutations.js` continues delegating width logic.

Minimum validation:

```bash
node tests/format-invariants.test.js
node tests/select-alignment.test.js
node tests/comment-alignment.test.js
node tests/render-width.test.js
node tests/module-boundary.test.js
node tests/token-boundary.test.js
node tests/pipeline-idempotency.test.js
npm run test:verify
git diff --check
```

If module structure or VSIX runtime contents change, also run:

```bash
npm run package:vsix
```

These local validation commands do not use proxy.

## Risks

- The explicit modifier layout is a user-visible behavior change for compact `SELECT DISTINCT a, b` inputs. This is intentional because the current compact rendering misaligns fields.
- SELECT hints and modifiers both live near the SELECT header. The implementation must keep Hive hints comment-owned and only recognize active code tokens as modifiers.
- Renderer facts can accidentally become a third rendering path if implemented loosely. The facts helper must call existing renderer helper functions and share move state and indent state with `sql-structured-renderer.js`.
- Comment alignment on lines that render into multiple physical lines needs careful treatment. Facts must describe the final physical segment that owns the trailing comment, not just the source line's original code text.
- Existing tests may assume `selectItem:0` is globally first. Those tests should move to `ordinalInOwner` rather than preserving a misleading global-ID contract.

## Success Criteria

- `DISTINCT` and `ALL` are modeled only as SELECT span header modifiers.
- SELECT items never include SELECT header modifier tokens.
- Compact `SELECT DISTINCT a, b FROM t` and `SELECT ALL a, b FROM t` render with header modifiers on a header line and aligned fields.
- Comment alignment uses renderer-owned pre-alignment facts instead of duplicated rendering simulation.
- Planned comment widths and renderer pre-alignment code widths are covered by invariants.
- Formatting the targeted SELECT modifier and trailing-comment cases twice yields the same output as formatting once.
- Full local regression passes with `npm run test:verify`.
