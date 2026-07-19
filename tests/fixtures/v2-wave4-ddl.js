'use strict';

module.exports = Object.freeze({
    ddl: Object.freeze([
        Object.freeze({
            id: 'simple-create-table',
            source: 'create table t (a int,b string)',
            status: 'formatted',
            text: [
                'CREATE TABLE t',
                '(',
                '     a INT',
                '    ,b STRING',
                ')',
                ''
            ].join('\n')
        }),
        Object.freeze({
            id: 'trailing-semicolon-preserved',
            source: 'create table t (a int);',
            status: 'formatted',
            text: [
                'CREATE TABLE t',
                '(',
                '     a INT',
                ');',
                ''
            ].join('\n')
        }),
        Object.freeze({
            id: 'external-complex-types',
            source: [
                'create external table if not exists db.`t(` (',
                '`a,b` decimal (18, 2) comment \'a  b, (c)\',',
                'payload map < string, array < struct < `x,y`: string, n: int > > >',
                ')'
            ].join('\n'),
            status: 'formatted',
            text: [
                'CREATE EXTERNAL TABLE IF NOT EXISTS db.`t(`',
                '(',
                "     `a,b`   DECIMAL(18,2) COMMENT 'a  b, (c)'",
                '    ,payload MAP<STRING,ARRAY<STRUCT<`x,y`:STRING,n:INT>>>',
                ')',
                ''
            ].join('\n')
        }),
        Object.freeze({
            id: 'unknown-suffix-preserved',
            source: 'CREATE TABLE t (a STRING) STORED AS ORC',
            status: 'preserved',
            code: 'DDL_UNMODELED_SUFFIX'
        }),
        Object.freeze({
            id: 'constraint-preserved',
            source: 'CREATE TABLE t (a STRING, PRIMARY KEY (a))',
            status: 'preserved',
            code: 'DDL_UNMODELED_COLUMN'
        }),
        Object.freeze({
            id: 'default-constraint-preserved',
            source: 'CREATE TABLE t (a STRING DEFAULT \'x\')',
            status: 'preserved',
            code: 'DDL_UNMODELED_COLUMN'
        }),
        Object.freeze({
            id: 'line-comment-preserved',
            source: 'CREATE TABLE t (a STRING -- keep\n)',
            status: 'preserved',
            code: 'DDL_COMMENT_TRIVIA'
        }),
        Object.freeze({
            id: 'block-comment-preserved',
            source: 'CREATE TABLE /* keep */ t (a STRING)',
            status: 'preserved',
            code: 'DDL_COMMENT_TRIVIA'
        }),
        Object.freeze({
            id: 'multiple-statements-preserved',
            source: 'CREATE TABLE a (x INT); CREATE TABLE b (y INT)',
            status: 'preserved',
            code: 'DDL_MULTI_STATEMENT'
        }),
        Object.freeze({
            id: 'unclosed-complex-type-preserved',
            source: 'CREATE TABLE t (a ARRAY<STRUCT<x:STRING>)',
            status: 'preserved'
        })
    ]),
    extract: Object.freeze([
        Object.freeze({
            id: 'simple-alias-comment',
            source: 'SELECT a, b AS bee -- note\nFROM t',
            status: 'extracted',
            text: [
                '     a   __TYPE_REQUIRED__',
                "    ,bee __TYPE_REQUIRED__ COMMENT 'note'",
                ''
            ].join('\n')
        }),
        Object.freeze({
            id: 'qualified-and-expression-alias',
            source: 'SELECT t.user_id, count(*) AS total FROM t',
            status: 'extracted',
            text: [
                '     user_id __TYPE_REQUIRED__',
                '    ,total   __TYPE_REQUIRED__',
                ''
            ].join('\n')
        }),
        Object.freeze({
            id: 'parenthesized-function-wildcard-argument',
            source: 'SELECT (count(*)) AS total FROM t',
            status: 'extracted',
            names: Object.freeze(['total'])
        }),
        Object.freeze({
            id: 'with-outer-select',
            source: 'WITH c AS (SELECT hidden FROM src) SELECT visible FROM c',
            status: 'extracted',
            names: Object.freeze(['visible'])
        }),
        Object.freeze({
            id: 'parenthesized-query',
            source: '(SELECT a FROM t)',
            status: 'extracted',
            names: Object.freeze(['a'])
        }),
        Object.freeze({
            id: 'with-set-query',
            source: 'WITH c AS (SELECT hidden FROM src) SELECT a FROM c UNION ALL SELECT a FROM other',
            status: 'extracted',
            names: Object.freeze(['a'])
        }),
        Object.freeze({
            id: 'keyword-alias-is-quoted',
            source: 'SELECT window AS order FROM t',
            status: 'extracted',
            names: Object.freeze(['`order`'])
        }),
        Object.freeze({
            id: 'matching-set-query',
            source: 'SELECT a FROM x UNION ALL SELECT a FROM y ORDER BY a',
            status: 'extracted',
            names: Object.freeze(['a'])
        }),
        Object.freeze({
            id: 'set-name-mismatch',
            source: 'SELECT a FROM x UNION ALL SELECT b FROM y',
            status: 'ambiguous',
            code: 'EXTRACT_SCHEMA_MISMATCH'
        }),
        Object.freeze({
            id: 'set-count-mismatch',
            source: 'SELECT a FROM x UNION ALL SELECT a, b FROM y',
            status: 'ambiguous',
            code: 'EXTRACT_SCHEMA_MISMATCH'
        }),
        Object.freeze({
            id: 'wildcard',
            source: 'SELECT * FROM x',
            status: 'ambiguous',
            code: 'EXTRACT_WILDCARD'
        }),
        Object.freeze({
            id: 'qualified-wildcard',
            source: 'SELECT t.* FROM x t',
            status: 'ambiguous',
            code: 'EXTRACT_WILDCARD'
        }),
        Object.freeze({
            id: 'aliased-wildcard',
            source: 'SELECT * AS x FROM t',
            status: 'ambiguous',
            code: 'EXTRACT_WILDCARD'
        }),
        Object.freeze({
            id: 'aliased-qualified-wildcard',
            source: 'SELECT t.* AS x FROM t t',
            status: 'ambiguous',
            code: 'EXTRACT_WILDCARD'
        }),
        Object.freeze({
            id: 'aliased-parenthesized-wildcard',
            source: 'SELECT (*) AS x FROM t',
            status: 'ambiguous',
            code: 'EXTRACT_WILDCARD'
        }),
        Object.freeze({
            id: 'aliased-parenthesized-qualified-wildcard',
            source: 'SELECT ((t.*)) AS x FROM t t',
            status: 'ambiguous',
            code: 'EXTRACT_WILDCARD'
        }),
        Object.freeze({
            id: 'aliased-wildcard-in-tuple',
            source: 'SELECT (t.*, a) AS x FROM t t',
            status: 'ambiguous',
            code: 'EXTRACT_WILDCARD'
        }),
        Object.freeze({
            id: 'aliased-wildcard-in-binary-expression',
            source: 'SELECT (t.* + 1) AS x FROM t t',
            status: 'ambiguous',
            code: 'EXTRACT_WILDCARD'
        }),
        Object.freeze({
            id: 'aliased-wildcard-in-prefix-expression',
            source: 'SELECT +t.* AS x FROM t t',
            status: 'ambiguous',
            code: 'EXTRACT_WILDCARD'
        }),
        Object.freeze({
            id: 'aliased-wildcard-in-function',
            source: 'SELECT coalesce(t.*, a) AS x FROM t t',
            status: 'ambiguous',
            code: 'EXTRACT_WILDCARD'
        }),
        Object.freeze({
            id: 'count-distinct-wildcard-is-not-count-star',
            source: 'SELECT COUNT(DISTINCT *) AS x FROM t',
            status: 'ambiguous',
            code: 'EXTRACT_WILDCARD'
        }),
        Object.freeze({
            id: 'mixed-resolvable-and-expression',
            source: 'SELECT a, count(*) FROM x',
            status: 'ambiguous',
            code: 'EXTRACT_VALUE_SHAPE'
        }),
        Object.freeze({
            id: 'duplicate-case-insensitive-alias',
            source: 'SELECT a AS X, b AS x FROM t',
            status: 'ambiguous',
            code: 'EXTRACT_DUPLICATE_NAME'
        }),
        Object.freeze({
            id: 'duplicate-quoted-unquoted-alias',
            source: 'SELECT a AS x, b AS `x` FROM t',
            status: 'ambiguous',
            code: 'EXTRACT_DUPLICATE_NAME'
        }),
        Object.freeze({
            id: 'duplicate-quoted-case-insensitive-alias',
            source: 'SELECT a AS `X`, b AS `x` FROM t',
            status: 'ambiguous',
            code: 'EXTRACT_DUPLICATE_NAME'
        }),
        Object.freeze({
            id: 'matching-quoted-unquoted-set-alias',
            source: 'SELECT a AS x FROM t UNION ALL SELECT b AS `x` FROM u',
            status: 'extracted',
            names: Object.freeze(['x'])
        }),
        Object.freeze({
            id: 'multiple-statements',
            source: 'SELECT a; SELECT b',
            status: 'ambiguous',
            code: 'EXTRACT_MULTI_STATEMENT'
        }),
        Object.freeze({
            id: 'empty',
            source: '',
            status: 'empty',
            code: 'EXTRACT_EMPTY'
        }),
        Object.freeze({
            id: 'unsupported-ddl',
            source: 'CREATE TABLE t (a STRING)',
            status: 'unsupported',
            code: 'EXTRACT_UNSUPPORTED_STATEMENT'
        }),
        Object.freeze({
            id: 'malformed-query',
            source: "SELECT 'unterminated",
            status: 'failed',
            code: 'EXTRACT_ANALYSIS_FAILED'
        })
    ])
});
