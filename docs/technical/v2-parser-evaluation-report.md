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
| Cold start median ms | 348.91 | <= 400 |
| 100 statement median ms | 8.37 | baseline |
| 800 statement median ms | 62.49 | baseline |
| 1200 statement median ms | 91.51 | baseline |
| 8x scale ratio | 7.47 | <= 12 |
| Maximum RSS KiB | 535648 | baseline |
| Environment | v24.18.0 / darwin-arm64 / Apple M1 Pro | recorded |

## Evaluation Method and Limitations

- On the recorded Node environment, directly loading pinned `dt-sql-parser@4.5.0` failed with stable error code `ERR_UNSUPPORTED_DIR_IMPORT`.
- Evaluation uses a dev-only esbuild CommonJS (CJS) interoperability bundle; the minified and gzip bundle byte measurements remain recorded against their thresholds.
- Cold start measures loading that bundle, constructing `HiveSQL`, and validating `SELECT 1`.
- `maxRssKb` is the evaluation process upper watermark, not isolated parser heap.

## Gate Results

- Grammar: fail
- License: pass
- Packaging: fail
- Performance: pass

## Case Outcomes

| Case | Expected | Accepted | Errors | Round trip | Node ranges | Nodes | Atomic passed/total |
| --- | --- | --- | --- | --- | --- | ---: | ---: |
| hive-cte-window-comments | required | true | none | true | true | 153 | 2/2 |
| hive-lateral-view-explode | required | true | none | true | true | 55 | 0/0 |
| hive-insert-overwrite-partition | required | true | none | true | true | 32 | 1/1 |
| hive-complex-type-ddl | required | true | none | true | true | 41 | 3/3 |
| hive-no-from-functions | required | true | none | true | true | 155 | 4/4 |
| hive-literal-first-nested-query | required | true | none | true | true | 50 | 1/1 |
| hive-case-and-subquery | required | true | none | true | true | 101 | 2/2 |
| hive-cluster-distribute-sort | required | true | none | true | true | 50 | 0/0 |
| hive-template-substitution | opaque | false | '$' is not valid at this position, expecting an existing table or an existing view or a keyword | true | false | 0 | 0/2 |
| postgres-dollar-parameter-operators | required | true | none | true | false | 74 | 4/5 |
| postgres-prefixed-strings | required | false | "," is no valid input at all<br>"U" is no valid input at all<br>"&amp;" is no valid input at all<br>Unfinished single quoted string literal<br>"d" is no valid input at all<br>"&#92;" is no valid input at all<br>"0" is no valid input at all<br>"0" is no valid input at all<br>"6" is no valid input at all<br>"1" is no valid input at all<br>"t" is no valid input at all<br>Unfinished single quoted string literal<br>"F" is no valid input at all<br>"R" is no valid input at all<br>"O" is no valid input at all<br>"M" is no valid input at all<br>"t" is no valid input at all<br>"W" is no valid input at all<br>"H" is no valid input at all<br>"E" is no valid input at all<br>"R" is no valid input at all<br>"E" is no valid input at all<br>"n" is no valid input at all<br>"a" is no valid input at all<br>"m" is no valid input at all<br>"e" is no valid input at all<br>"!" is no valid input at all<br>"~" is no valid input at all<br>"*" is no valid input at all<br>Unfinished single quoted string literal<br>"x" is no valid input at all<br>Unfinished single quoted string literal | true | false | 0 | 3/3 |
| mysql-prefixed-literal-variable | required | false | 'id' is not valid at this position, expecting an existing column | true | false | 0 | 2/4 |
| generic-array-without-from | required | false | '[' is not valid at this position, expecting a keyword | true | false | 0 | 2/2 |
| match-recognize-function-name | required | true | none | true | true | 32 | 0/0 |
| match-recognize-construct | opaque | false | 'PARTITION' is not valid at this position, expecting a keyword<br>'A' is not valid at this position<br>'DEFINE' is not valid at this position | true | false | 0 | 0/0 |
| unterminated-string | invalid | false | Unfinished single quoted string literal<br>Statement is incomplete, expecting an existing column or an existing function or a keyword | true | false | 0 | 0/0 |

## Bundled Packages

- antlr4-c3@3.3.7 — MIT
- antlr4ng@2.0.11 — BSD-3-Clause
- dt-sql-parser@4.5.0 — MIT

This report is Wave 0 evidence and does not change the active formatter.
