# ADR 0001: SQL Formatter v2 Parser Backend

- Status: Accepted
- Candidate: dt-sql-parser@4.5.0
- Decision role: rejected

## Context

The formatter requires Hive-first grammar coverage without surrendering exact source text, opaque fallback, package discipline, or near-linear scaling.

## Decision

Do not use dt-sql-parser as a v2 backend or oracle; implement and validate the production grammar backend in-project.

The rejecting MUST gate evidence is: required parse rate, required node-range rate.

A project-owned lossless lexer remains mandatory in every outcome. External parser tokens cannot own protected source units unless source reconstruction, native partition, non-trivia coverage, and atomic-lexeme gates all pass.

## Evidence

- Required parse rate: 76.92%
- Invalid reject rate: 100.00%
- Source reconstruction rate: 100.00%
- Required case node-range rate: 76.92%
- Native token partition rate: 100.00%
- Native non-trivia coverage rate: 87.50%
- Native atomic lexeme rate: 75.86%
- Minified/gzip bytes: 1116785 / 211258
- Cold start median ms: 82.40
- 8x scale ratio: 6.35
- Maximum RSS KiB: 633728
- Environment: v24.18.0 / darwin-arm64 / Apple M1 Pro

## Evaluation Method and Limitations

- On the recorded Node environment, directly loading pinned `dt-sql-parser@4.5.0` failed with stable error code `ERR_UNSUPPORTED_DIR_IMPORT`.
- Packaging measures a tree-shaken ESM named `HiveSQL` entry emitted as CommonJS for Node/VS Code cold start.
- Candidate evaluation loads a separate ESM named-import entry containing only Hive, generic, PostgreSQL, and MySQL constructors.
- Source reconstruction includes explicit synthetic fallback leaves; it proves containment and preservation, not native candidate token ownership.
- Native partition, non-trivia coverage, and atomic metrics count candidate-origin evidence only.
- Candidate leaf ownership requires the source reconstruction gate plus native partition, non-trivia coverage, and atomic-lexeme gates; it does not inherit unrelated grammar gates.
- Cold start requires the built CommonJS artifact, constructs `HiveSQL`, and verifies that `SELECT 1` has no syntax diagnostics.
- `maxRssKb` is the evaluation process upper watermark, not isolated parser heap.

Full per-case evidence is recorded in `docs/technical/v2-parser-evaluation-report.md`.

## Consequences

- Canonical CST, diagnostic, layout, and result types remain independent of candidate parse-tree classes.
- Synthetic source-preservation leaves never count as candidate-native ownership evidence.
- The candidate package never entered the 2.x production runtime. Its evaluator and dependency were removed during Wave 5 cutover.
- The project-owned lossless lexer and grammar backend remain the production implementation unless new committed evidence reopens this ADR.
