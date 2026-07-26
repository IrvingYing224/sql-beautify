# Syntax node invariant checklist

This checklist is the maintenance gate for adding or changing a `SyntaxNode` kind.
The runtime authority is `NODE_KIND_REGISTRY` in `src/core/syntax/invariant-shared.ts`;
the check script derives the declared kinds from `node.ts` and rejects registry drift.

## Trigger signal

- A new member is added to `SyntaxNode`.
- A node gains a subtype, child reference, marker, capability, or container rule.
- A parser change alters which node owns a source leaf or child.

## Root constraint

Every parsed tree is proved in full on every parse. A new node therefore participates
in six independent families: shape, relationship, container, contextual facts,
capability allowlist, and exact marker closure. Omitting any family can turn malformed
or unowned syntax into an apparently canonical artifact.

## Correct approach

1. Add the node type and factory construction with frozen exact data fields.
2. Add or update its `NODE_CONTRACTS` child/reference relationship authority.
3. Add its exhaustive `NODE_KIND_REGISTRY` entry, including subtype field/domain.
4. Implement shape and subtype checks in `cst-invariants.ts`.
5. Extend container, contextual fact, capability, and marker-closure validators where
   the node has a new semantic rule; an intentional no-op still remains registered.
6. Update analysis ownership/index consumers and layout policy only after the CST proof
   is complete.
7. Add canonical, hostile-clone, missing-field, extra-field, wrong-owner, wrong-marker,
   wrong-capability, malformed, and recovery tests.

## Validation method

```bash
npm run typecheck:v2
npm run build:v2-core
node scripts/check-syntax-node-registry.js
npm run test:v2:wave2-foundation
node tests/v2/recovery-fuzz.test.js
node tests/v2/syntax-invariants-performance.test.js
```

The registry check proves exhaustive enrollment; the hostile and performance suites
prove that enrollment still fails closed without weakening the linear full-tree pass.

## Scope

This applies to production formatter CST nodes only. Experimental Hive DDL has a
separate parser and does not extend `SyntaxNode`.
