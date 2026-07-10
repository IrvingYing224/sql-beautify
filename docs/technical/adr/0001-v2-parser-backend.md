# ADR 0001: SQL Formatter v2 Parser Backend

- Status: Accepted
- Candidate: dt-sql-parser@4.5.0
- Decision role: rejected

## Context

The formatter requires Hive-first grammar coverage without surrendering exact source text, opaque fallback, package discipline, or near-linear scaling.

## Decision

Do not use dt-sql-parser as a v2 backend or oracle; implement and validate the production grammar backend in-project.

A project-owned lossless lexer remains mandatory in every outcome. External parser tokens cannot own protected source units unless atomic-lexeme and source-partition gates both pass.

## Evidence

- Required parse rate: 76.92%
- Source round-trip rate: 100.00%
- Required case node-range rate: 69.23%
- Atomic lexeme rate: 82.76%
- Minified/gzip bytes: 7415519 / 1263579
- Cold start median ms: 371.47
- 8x scale ratio: 6.26
- Maximum RSS KiB: 564544
- Environment: v24.18.0 / darwin-arm64 / Apple M1 Pro

Full per-case evidence is recorded in `docs/technical/v2-parser-evaluation-report.md`.

## Consequences

- Canonical CST, diagnostic, layout, and result types remain independent of candidate parse-tree classes.
- No candidate package is imported by the shipping 1.x entrypoint.
- Wave 1 can implement the lossless lexer without reopening the backend role unless committed evidence changes.
