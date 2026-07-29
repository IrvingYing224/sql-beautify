# Syntax node invariant checklist

This checklist is the maintenance gate for adding or changing a `SyntaxNode` kind.
The runtime authority is `NODE_KIND_REGISTRY` in `src/core/syntax/invariant-shared.ts`;
the check script derives the declared kinds from `node.ts` and rejects registry drift.

## Trigger signal

- A new member is added to `SyntaxNode`.
- A node gains a subtype, child reference, marker, capability, or container rule.
- A parser change alters which node owns a source leaf or child.

## Root constraint

Canonical CST values are not accepted from callers. The parser factory proves local
shape/range facts while constructing frozen nodes, the parser grants an artifact only
after an O(1) exact provenance/root-coverage check, and structural-index construction
performs the single production full-tree traversal. The explicit hostile-object
validator remains an independent debug/test oracle with six families: shape,
relationship, container, contextual facts, capability allowlist, and exact marker
closure. A new node must enroll in both the canonical construction/index path and all
applicable hostile-object families.

## Correct approach

1. Add the node type and factory construction with frozen exact data fields.
2. Add or update its `NODE_CONTRACTS` child/reference relationship authority.
3. Add its exhaustive `NODE_KIND_REGISTRY` entry, including subtype field/domain.
4. Implement construction-time shape/range checks and the corresponding single-pass
   structural-index ownership/semantic checks.
5. Implement independent hostile shape and subtype checks in `cst-invariants.ts`.
6. Extend container, contextual fact, capability, and marker-closure validators where
   the node has a new semantic rule; an intentional no-op still remains registered.
7. Update analysis query consumers and layout policy only after the CST proof
   is complete.
8. Add canonical, hostile-clone, missing-field, extra-field, wrong-owner, wrong-marker,
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

The registry check proves exhaustive enrollment; the hostile suite proves fail-closed
behavior; the operation-count gate proves canonical parsing does not enter the debug
oracle/exception probes and formatting performs exactly one structural-index traversal.

## Scope

This applies to production formatter CST nodes only. Experimental Hive DDL has a
separate parser and does not extend `SyntaxNode`.
