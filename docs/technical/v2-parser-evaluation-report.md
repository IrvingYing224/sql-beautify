# SQL Formatter v2 Parser Evaluation Report

- Candidate: dt-sql-parser@4.5.0
- Candidate license: MIT
- Decision: rejected
- Can own lossless leaf stream: false

## Correctness

| Metric | Actual | Gate |
| --- | ---: | ---: |
| Required parse rate | 76.92% | 100.00% |
| Invalid reject rate | 100.00% | 100.00% |
| Source round-trip rate | 100.00% | 100.00% |
| Required case node-range rate | 69.23% | 100.00% |
| Atomic lexeme rate | 82.76% | informational |

## Packaging and Performance

| Metric | Actual | Gate |
| --- | ---: | ---: |
| Minified bundle bytes | 7415519 | <= 5242880 |
| Gzip bundle bytes | 1263579 | <= 1572864 |
| Cold start median ms | 371.47 | <= 400 |
| 100 statement median ms | 9.85 | baseline |
| 800 statement median ms | 61.68 | baseline |
| 1200 statement median ms | 98.75 | baseline |
| 8x scale ratio | 6.26 | <= 12 |
| Maximum RSS KiB | 564544 | baseline |
| Node/platform | v24.18.0 / darwin-arm64 | recorded |

## Gate Results

- Grammar: fail
- License: pass
- Packaging: fail
- Performance: pass

## Case Outcomes

| Case | Expected | Accepted | Round trip | Node ranges | Nodes |
| --- | --- | --- | --- | --- | ---: |
| hive-cte-window-comments | required | true | true | true | 153 |
| hive-lateral-view-explode | required | true | true | true | 55 |
| hive-insert-overwrite-partition | required | true | true | true | 32 |
| hive-complex-type-ddl | required | true | true | true | 41 |
| hive-no-from-functions | required | true | true | true | 155 |
| hive-literal-first-nested-query | required | true | true | true | 50 |
| hive-case-and-subquery | required | true | true | true | 101 |
| hive-cluster-distribute-sort | required | true | true | true | 50 |
| hive-template-substitution | opaque | false | true | false | 0 |
| postgres-dollar-parameter-operators | required | true | true | false | 74 |
| postgres-prefixed-strings | required | false | true | false | 0 |
| mysql-prefixed-literal-variable | required | false | true | false | 0 |
| generic-array-without-from | required | false | true | false | 0 |
| match-recognize-function-name | required | true | true | true | 32 |
| match-recognize-construct | opaque | false | true | false | 0 |
| unterminated-string | invalid | false | true | false | 0 |

## Bundled Packages

- antlr4-c3@3.3.7 — MIT
- antlr4ng@2.0.11 — BSD-3-Clause
- dt-sql-parser@4.5.0 — MIT

This report is Wave 0 evidence and does not change the active formatter.
