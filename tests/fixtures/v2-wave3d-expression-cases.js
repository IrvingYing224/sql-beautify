'use strict';

function frozenCase(value) {
    return Object.freeze({
        id: value.id,
        source: value.source,
        options: Object.freeze(Object.assign({ dialect: 'hive' }, value.options)),
        expected: value.expected,
        capabilities: Object.freeze((value.capabilities || []).slice())
    });
}

module.exports = Object.freeze([
    frozenCase({
        id: 'registry-operators-and-boolean-continuation',
        source: "select -a+b*c,not flag,x not between 1 and 3,y is not null " +
            "from t where a=1 and b>2 or c like 'x%'",
        expected: [
            'SELECT',
            '      -a + b * c',
            '    , NOT flag',
            '    , x NOT BETWEEN 1 AND 3',
            '    , y IS NOT NULL',
            'FROM t',
            'WHERE a = 1',
            '    AND b > 2',
            "    OR c LIKE 'x%'"
        ].join('\n')
    }),
    frozenCase({
        id: 'expanded-case-and-function-call',
        source: "select case when a=1 then concat('FROM',b) else 'x' end as c from t",
        expected: [
            'SELECT',
            '      CASE',
            "          WHEN a = 1 THEN concat('FROM', b)",
            "          ELSE 'x'",
            '      END AS c',
            'FROM t'
        ].join('\n'),
        capabilities: ['case-expression', 'function-call']
    }),
    frozenCase({
        id: 'cast-collection-and-type-layout',
        source: "select cast(array('x',2) as array<string>)," +
            'cast(v as decimal(18,2)) from t',
        expected: [
            'SELECT',
            "      CAST(array('x', 2) AS ARRAY<STRING>)",
            '    , CAST(v AS DECIMAL(18, 2))',
            'FROM t'
        ].join('\n'),
        capabilities: ['cast-type', 'collection-expression']
    }),
    frozenCase({
        id: 'subquery-and-window-layout',
        source: "select exists(select 'x'),sum(x) over(partition by " +
            "coalesce('x',a) order by y rows between 1 preceding and current row) from t",
        expected: [
            'SELECT',
            '      EXISTS (',
            "          SELECT 'x'",
            '      )',
            "    , sum(x) OVER (PARTITION BY coalesce('x', a) ORDER BY y " +
                'ROWS BETWEEN 1 PRECEDING AND CURRENT ROW)',
            'FROM t'
        ].join('\n'),
        capabilities: ['function-call', 'subquery-expression', 'window-expression']
    })
]);
