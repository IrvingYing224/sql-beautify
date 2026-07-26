'use strict';

function frozenCase(value) {
    var evidence = {};
    Object.keys(value.evidenceByCapability || {}).forEach(function(capabilityId) {
        evidence[capabilityId] = Object.freeze({
            commentRaw: value.evidenceByCapability[capabilityId].commentRaw
        });
    });
    return Object.freeze({
        id: value.id,
        source: value.source,
        options: Object.freeze(Object.assign({ dialect: 'hive' }, value.options)),
        expected: value.expected,
        capabilities: Object.freeze(value.capabilities.slice()),
        evidenceByCapability: Object.freeze(evidence)
    });
}

module.exports = Object.freeze([
    frozenCase({
        id: 'query-clauses-leading',
        source: 'select a,b from t,u where a=1 group by a,b having count(*)>1 ' +
            'window w as (partition by a order by b),x as (order by c) ' +
            'order by a,b cluster by a,b distribute by a,b sort by a,b limit 10',
        options: { commaStyle: 'leading' },
        expected: [
            'SELECT',
            '      a',
            '    , b',
            'FROM',
            '      t',
            '    , u',
            'WHERE a = 1',
            'GROUP BY',
            '      a',
            '    , b',
            'HAVING count(*) > 1',
            'WINDOW',
            '      w AS (PARTITION BY a ORDER BY b)',
            '    , x AS (ORDER BY c)',
            'ORDER BY',
            '      a',
            '    , b',
            'CLUSTER BY',
            '      a',
            '    , b',
            'DISTRIBUTE BY',
            '      a',
            '    , b',
            'SORT BY',
            '      a',
            '    , b',
            'LIMIT 10'
        ].join('\n'),
        capabilities: [
            'from',
            'where',
            'group-by',
            'having',
            'window',
            'order-by',
            'cluster-by',
            'distribute-by',
            'sort-by',
            'limit'
        ]
    }),
    frozenCase({
        id: 'query-clauses-trailing',
        source: 'select a,b from t,u where a=1 group by a,b having count(*)>1 ' +
            'window w as (partition by a order by b),x as (order by c) ' +
            'order by a,b cluster by a,b distribute by a,b sort by a,b limit 10',
        options: { commaStyle: 'trailing' },
        expected: [
            'SELECT',
            '    a,',
            '    b',
            'FROM',
            '    t,',
            '    u',
            'WHERE a = 1',
            'GROUP BY',
            '    a,',
            '    b',
            'HAVING count(*) > 1',
            'WINDOW',
            '    w AS (PARTITION BY a ORDER BY b),',
            '    x AS (ORDER BY c)',
            'ORDER BY',
            '    a,',
            '    b',
            'CLUSTER BY',
            '    a,',
            '    b',
            'DISTRIBUTE BY',
            '    a,',
            '    b',
            'SORT BY',
            '    a,',
            '    b',
            'LIMIT 10'
        ].join('\n'),
        capabilities: [
            'from',
            'where',
            'group-by',
            'having',
            'window',
            'order-by',
            'cluster-by',
            'distribute-by',
            'sort-by',
            'limit'
        ]
    }),
    frozenCase({
        id: 'with-cte-and-parenthesized-queries',
        source: 'with a as (select x from t), b(c,d) as (select y from u) ' +
            'select * from a',
        options: { commaStyle: 'leading' },
        expected: [
            'WITH',
            '      a AS (',
            '          SELECT',
            '                x',
            '          FROM t',
            '      )',
            '    , b(c, d) AS (',
            '          SELECT',
            '                y',
            '          FROM u',
            '      )',
            'SELECT',
            '      *',
            'FROM a'
        ].join('\n'),
        capabilities: ['with-cte', 'subquery', 'from']
    }),
    frozenCase({
        id: 'join-lateral-and-table-function',
        source: 'select * from a left join b on a.id=b.id and a.x=b.x ' +
            'join c using(id,x) lateral view explode(c.xs) e as x,y',
        options: { commaStyle: 'leading' },
        expected: [
            'SELECT',
            '      *',
            'FROM a',
            'LEFT JOIN b',
            '    ON a.id = b.id',
            '        AND a.x = b.x',
            'JOIN c',
            '    USING (id, x)',
            'LATERAL VIEW explode(c.xs) e AS x, y'
        ].join('\n'),
        capabilities: ['from', 'join', 'lateral-view', 'table-function']
    }),
    frozenCase({
        id: 'from-subquery-and-qualified-alias',
        source: 'select q.x from (select x from db . t) q',
        options: { commaStyle: 'leading' },
        expected: [
            'SELECT',
            '      q.x',
            'FROM (',
            '    SELECT',
            '          x',
            '    FROM db.t',
            ') q'
        ].join('\n'),
        capabilities: ['from', 'subquery']
    }),
    frozenCase({
        id: 'parenthesized-set-query',
        source: '(select a from t union all select b from u order by 1 limit 2)',
        options: { commaStyle: 'leading' },
        expected: [
            '(',
            '    SELECT',
            '          a',
            '    FROM t',
            '    UNION ALL',
            '    SELECT',
            '          b',
            '    FROM u',
            '    ORDER BY',
            '          1',
            '    LIMIT 2',
            ')'
        ].join('\n'),
        capabilities: ['subquery', 'set-operations', 'from', 'order-by', 'limit']
    }),
    frozenCase({
        id: 'insert-overwrite-partition-select',
        source: 'insert overwrite table d partition(ds=1,hr) select a from s',
        options: { commaStyle: 'leading' },
        expected: [
            'INSERT OVERWRITE TABLE d',
            'PARTITION (ds = 1, hr)',
            'SELECT',
            '      a',
            'FROM s'
        ].join('\n'),
        capabilities: ['insert-overwrite-partition-select', 'from']
    }),
    frozenCase({
        id: 'multi-statement-empty-and-comment',
        source: 'select 1; ; -- keep\nselect 2;',
        options: { commaStyle: 'leading' },
        expected: [
            'SELECT 1;',
            '; -- keep',
            'SELECT 2;'
        ].join('\n'),
        capabilities: ['multi-statement', 'select-without-from']
    }),
    frozenCase({
        id: 'protected-comments-and-keyword-shaped-text',
        source: "select /*+ MAPJOIN(t) */ a, -- keep  FROM\n 'x, FROM' as s " +
            'from `db . t` t -- tail\n where a=1',
        options: { commaStyle: 'leading' },
        expected: [
            'SELECT',
            '      /*+ MAPJOIN(t) */',
            '      a',
            '    , -- keep  FROM',
            "      'x, FROM' AS s",
            'FROM `db . t` t -- tail',
            'WHERE a = 1'
        ].join('\n'),
        capabilities: ['from', 'where']
    }),
    frozenCase({
        id: 'protected-clause-capability-evidence',
        source: "select 'x' as s from /*e:from*/ t where /*e:where*/ a=1 " +
            'group by /*e:group*/ a having /*e:having*/ count(*)>0 ' +
            'window w as (partition /*e:window*/ by a) ' +
            'order by /*e:order*/ a cluster by /*e:cluster*/ a ' +
            'distribute by /*e:distribute*/ a sort by /*e:sort*/ a ' +
            'limit /*e:limit*/ 1',
        options: { commaStyle: 'leading' },
        expected: [
            'SELECT',
            "      'x' AS s",
            'FROM',
            '    /*e:from*/',
            '    t',
            'WHERE',
            '/*e:where*/',
            'a = 1',
            'GROUP BY',
            '      /*e:group*/',
            '      a',
            'HAVING',
            '/*e:having*/',
            'count(*) > 0',
            'WINDOW',
            '      w AS (PARTITION /*e:window*/ BY a)',
            'ORDER BY',
            '      /*e:order*/',
            '      a',
            'CLUSTER BY',
            '      /*e:cluster*/',
            '      a',
            'DISTRIBUTE BY',
            '      /*e:distribute*/',
            '      a',
            'SORT BY',
            '      /*e:sort*/',
            '      a',
            'LIMIT',
            '/*e:limit*/',
            '1'
        ].join('\n'),
        capabilities: [
            'cluster-by',
            'distribute-by',
            'from',
            'group-by',
            'having',
            'limit',
            'order-by',
            'sort-by',
            'where',
            'window'
        ],
        evidenceByCapability: {
            'cluster-by': { commentRaw: '/*e:cluster*/' },
            'distribute-by': { commentRaw: '/*e:distribute*/' },
            from: { commentRaw: '/*e:from*/' },
            'group-by': { commentRaw: '/*e:group*/' },
            having: { commentRaw: '/*e:having*/' },
            limit: { commentRaw: '/*e:limit*/' },
            'order-by': { commentRaw: '/*e:order*/' },
            'sort-by': { commentRaw: '/*e:sort*/' },
            where: { commentRaw: '/*e:where*/' },
            window: { commentRaw: '/*e:window*/' }
        }
    }),
    frozenCase({
        id: 'protected-cte-subquery-capability-evidence',
        source: 'with a(/*e:with*/c) as (/*e:subquery*/ ' +
            'select /*e:select*/ 1) select c from /*e:from2*/ a',
        options: { commaStyle: 'leading' },
        expected: [
            'WITH',
            '      a(/*e:with*/c) AS (',
            '          /*e:subquery*/',
            '          SELECT',
            '          /*e:select*/',
            '          1',
            '      )',
            'SELECT',
            '      c',
            'FROM',
            '    /*e:from2*/',
            '    a'
        ].join('\n'),
        capabilities: ['from', 'select-without-from', 'subquery', 'with-cte'],
        evidenceByCapability: {
            'select-without-from': { commentRaw: '/*e:select*/' },
            subquery: { commentRaw: '/*e:subquery*/' },
            'with-cte': { commentRaw: '/*e:with*/' }
        }
    }),
    frozenCase({
        id: 'protected-join-lateral-capability-evidence',
        source: "select 'x' from a join /*e:join*/ b using(id) " +
            'lateral view explode(/*e:table*/b.xs) e as ' +
            '/*e:lateral*/ x',
        options: { commaStyle: 'leading' },
        expected: [
            'SELECT',
            "      'x'",
            'FROM a',
            'JOIN',
            '    /*e:join*/',
            '    b',
            '    USING (id)',
            'LATERAL VIEW explode(/*e:table*/b.xs) e AS',
            '/*e:lateral*/',
            'x'
        ].join('\n'),
        capabilities: ['from', 'join', 'lateral-view', 'table-function'],
        evidenceByCapability: {
            join: { commentRaw: '/*e:join*/' },
            'lateral-view': { commentRaw: '/*e:lateral*/' },
            'table-function': { commentRaw: '/*e:table*/' }
        }
    }),
    frozenCase({
        id: 'protected-set-query-capability-evidence',
        source: "(/*e:subquery-set*/ select 'a' from t " +
            "union /*e:set*/ all select 'b' from u order by 1 limit 2)",
        options: { commaStyle: 'leading' },
        expected: [
            '(',
            '    /*e:subquery-set*/',
            '    SELECT',
            "          'a'",
            '    FROM t',
            '    UNION /*e:set*/ ALL',
            '    SELECT',
            "          'b'",
            '    FROM u',
            '    ORDER BY',
            '          1',
            '    LIMIT 2',
            ')'
        ].join('\n'),
        capabilities: ['from', 'limit', 'order-by', 'set-operations', 'subquery'],
        evidenceByCapability: {
            'set-operations': { commentRaw: '/*e:set*/' }
        }
    }),
    frozenCase({
        id: 'protected-insert-capability-evidence',
        source: "insert overwrite table d partition(/*e:insert*/ds=1,hr) " +
            "select 'x' from s",
        options: { commaStyle: 'leading' },
        expected: [
            'INSERT OVERWRITE TABLE d',
            'PARTITION (/*e:insert*/ds = 1, hr)',
            'SELECT',
            "      'x'",
            'FROM s'
        ].join('\n'),
        capabilities: ['from', 'insert-overwrite-partition-select'],
        evidenceByCapability: {
            'insert-overwrite-partition-select': {
                commentRaw: '/*e:insert*/'
            }
        }
    }),
    frozenCase({
        id: 'protected-insert-into-capability-evidence',
        source: "insert into table d partition(/*e:insert-into*/ds=1) " +
            "with q as (select 'x' from s) select 'x' from q",
        options: { commaStyle: 'leading' },
        expected: [
            'INSERT INTO TABLE d',
            'PARTITION (/*e:insert-into*/ds = 1)',
            'WITH',
            '      q AS (',
            '          SELECT',
            "                'x'",
            '          FROM s',
            '      )',
            'SELECT',
            "      'x'",
            'FROM q'
        ].join('\n'),
        capabilities: [
            'from',
            'insert-into-partition-select',
            'subquery',
            'with-cte'
        ],
        evidenceByCapability: {
            'insert-into-partition-select': {
                commentRaw: '/*e:insert-into*/'
            }
        }
    }),
    frozenCase({
        id: 'protected-set-command-capability-evidence',
        source: 'set /*e:set-command*/ hive.exec.flag=select MiXeD /*raw*/ x=y',
        options: { commaStyle: 'leading' },
        expected: [
            'SET',
            '/*e:set-command*/',
            'hive.exec.flag=select MiXeD /*raw*/ x=y'
        ].join('\n'),
        capabilities: ['set-command'],
        evidenceByCapability: {
            'set-command': { commentRaw: '/*e:set-command*/' }
        }
    }),
    frozenCase({
        id: 'protected-multi-statement-capability-evidence',
        source: 'select /*e:select2*/ 1; /*e:multi*/ select 2;',
        options: { commaStyle: 'leading' },
        expected: [
            'SELECT',
            '/*e:select2*/',
            '1; /*e:multi*/',
            'SELECT 2;'
        ].join('\n'),
        capabilities: ['multi-statement', 'select-without-from'],
        evidenceByCapability: {
            'multi-statement': { commentRaw: '/*e:multi*/' }
        }
    }),
    frozenCase({
        id: 'tab-leading-content-columns',
        source: 'select a,b from t',
        options: { commaStyle: 'leading', indentStyle: 'tab' },
        expected: 'SELECT\n\t  a\n\t, b\nFROM t',
        capabilities: ['from']
    })
]);
