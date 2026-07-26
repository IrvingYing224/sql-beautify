'use strict';

var assert = require('assert');
var analysisApi = require('../../.tmp/v2-core/core/analysis/index.js');
var dialectApi = require('../../.tmp/v2-core/core/dialects/index.js');
var formatApi = require('../../.tmp/v2-core/core/api/format.js');
var lexerApi = require('../../.tmp/v2-core/core/lexer/lossless-lexer.js');

var SHARED_FORMATTED = [
    'multi-statement',
    'with-cte',
    'select-without-from',
    'from',
    'join',
    'subquery',
    'table-function',
    'where',
    'group-by',
    'having',
    'window',
    'order-by',
    'limit',
    'set-operations',
    'case-expression',
    'function-call',
    'cast-type',
    'subquery-expression',
    'window-expression'
].sort();

var CAPABILITY_CORPUS = [
    'select 1; select 2',
    [
        'with c as (select a from t where a>0)',
        'select c.a from c join (select b as a from u) q on c.a=q.a',
        'group by c.a having count(*)>0',
        'window w as (partition by c.a order by c.a)',
        'order by c.a limit 5'
    ].join(' '),
    [
        'select case when a=1 then lower(cast(a as string))',
        'else (select max(b) from u) end,',
        'sum(a) over(partition by a order by a) from t'
    ].join(' '),
    'select x from unnest(a) x',
    'select a from t union all select b from u'
];

var GOLDENS = {
    generic: {
        source: [
            'with c as (select a+1 as x from t where a=1)',
            "select case when c.x>1 then lower('FROM') else 'x' end as value,",
            'count(*) over(partition by c.x order by c.x) as n',
            'from c left join u on c.x=u.x where u.y is not null',
            'group by c.x having count(*)>0 order by value limit 5'
        ].join(' '),
        options: { keywordCase: 'lower', commaStyle: 'trailing' },
        expected: [
            'with',
            '    c as (',
            '        select',
            '            a + 1 as x',
            '        from t',
            '        where a = 1',
            '    )',
            'select',
            '    case',
            "        when c.x > 1 then lower('FROM')",
            "        else 'x'",
            '    end as value,',
            '    count(*) over (partition by c.x order by c.x) as n',
            'from c',
            'left join u',
            '    on c.x = u.x',
            'where u.y is not null',
            'group by',
            '    c.x',
            'having count(*) > 0',
            'order by',
            '    value',
            'limit 5'
        ].join('\n')
    },
    postgresql: {
        source: [
            "select $$FROM where$$ as body, cast(a as text) as value from t where id=$1",
            "union all select 'x', cast(2 as text) from u order by value limit 2"
        ].join(' '),
        options: {},
        expected: [
            'SELECT',
            '      $$FROM where$$  AS body',
            '    , CAST(a AS text) AS value',
            'FROM t',
            'WHERE id = $1',
            'UNION ALL',
            'SELECT',
            "      'x'",
            '    , CAST(2 AS text)',
            'FROM u',
            'ORDER BY',
            '      value',
            'LIMIT 2'
        ].join('\n')
    },
    mysql: {
        source: [
            'select `from` as name, cast(a as char) as value from t',
            "where id=? and label='FROM' order by value limit 2"
        ].join(' '),
        options: { indentStyle: 'tab', commaStyle: 'trailing' },
        expected: [
            'SELECT',
            '\t`from`          AS name,',
            '\tCAST(a AS CHAR) AS value',
            'FROM t',
            'WHERE id = ?',
            "\tAND label = 'FROM'",
            'ORDER BY',
            '\tvalue',
            'LIMIT 2'
        ].join('\n')
    }
};

function protectedRows(source, dialect) {
    return lexerApi.lexSql(source, { dialect: dialect }).leaves.filter(function(leaf) {
        return leaf.channel === 'protected' ||
            leaf.kind === 'line-comment' ||
            leaf.kind === 'block-comment';
    }).map(function(leaf) {
        return [leaf.kind, leaf.channel, leaf.raw];
    });
}

function assertStable(dialect, source, options, expected) {
    var config = Object.assign({ dialect: dialect }, options);
    var first = formatApi.formatSql(source, config);
    assert.ok(first.status === 'formatted' || first.status === 'unchanged', dialect);
    if (expected !== undefined) {
        assert.strictEqual(first.text, expected, dialect + ' golden');
    }
    assert.deepStrictEqual(
        protectedRows(first.text, dialect),
        protectedRows(source, dialect),
        dialect + ' protected/comment bytes'
    );
    var second = formatApi.formatSql(first.text, config);
    assert.strictEqual(second.status, 'unchanged', dialect + ' repeat');
    assert.strictEqual(second.text, first.text, dialect + ' idempotency');
}

['generic', 'postgresql', 'mysql'].forEach(function(dialect) {
    var view = dialectApi.getDialect(dialect);
    assert.deepStrictEqual(
        view.listCapabilities().filter(function(capability) {
            return capability.state === 'formatted';
        }).map(function(capability) {
            return capability.id;
        }).sort(),
        SHARED_FORMATTED,
        dialect + ' exact formatted manifest'
    );

    var observed = new Set();
    CAPABILITY_CORPUS.forEach(function(source) {
        var analysis = analysisApi.analyzeSql(source, {
            dialect: dialect,
            mode: 'document'
        });
        assert.strictEqual(analysis.status, 'analyzed', dialect + ': ' + source);
        analysis.index.nodes().forEach(function(node) {
            if (node.capabilityId !== null) {
                observed.add(node.capabilityId);
            }
        });
        assertStable(dialect, source, {}, undefined);
    });
    assert.deepStrictEqual(
        SHARED_FORMATTED.filter(function(id) { return observed.has(id); }),
        SHARED_FORMATTED,
        dialect + ' every formatted capability must have a real occurrence'
    );

    var golden = GOLDENS[dialect];
    assertStable(
        dialect,
        golden.source,
        golden.options,
        golden.expected
    );
});

(function testUnicodeIdentifierDialectMatrixAndTokenEquivalence() {
    var source = 'select 中文字段 as c1, b as c2 from t';
    ['hive', 'generic'].forEach(function(dialect) {
        assertStable(dialect, source, {}, [
            'SELECT',
            '      中文字段 AS c1',
            '    , b AS c2',
            'FROM t'
        ].join('\n'));
    });
    ['postgresql', 'mysql'].forEach(function(dialect) {
        assertStable(dialect, source, {}, [
            'SELECT',
            '      中文字段 AS c1',
            '    , b        AS c2',
            'FROM t'
        ].join('\n'));
    });

    assertStable(
        'postgresql',
        'select \u{10400}name as x, b as y from t',
        {},
        [
            'SELECT',
            '      \u{10400}name AS x',
            '    , b     AS y',
            'FROM t'
        ].join('\n')
    );
    assertStable(
        'mysql',
        'select a\u0301 as x, b as y from t',
        {},
        [
            'SELECT',
            '      a\u0301 AS x',
            '    , b AS y',
            'FROM t'
        ].join('\n')
    );
})();

(function testDialectSpecificStructuredOperatorsRemainAtomicBoundaries() {
    [
        ['generic', 'generic-array-subset', 'select ARRAY[1,2] as x from t', 'ARRAY[1,2]'],
        ['postgresql', 'postgres-json-operators', "select payload->>'x' as x from t", "payload->>'x'"],
        ['postgresql', 'postgres-type-cast', 'select a::text as x from t', 'a::text'],
        ['mysql', 'mysql-json-operators', "select payload->>'$.x' as x from t", "payload->>'$.x'"]
    ].forEach(function(row) {
        assert.strictEqual(
            dialectApi.getDialect(row[0]).getCapability(row[1]).state,
            'structured',
            row[0] + '/' + row[1]
        );
        var result = formatApi.formatSql(row[2], { dialect: row[0] });
        assert.strictEqual(result.status, 'formatted', row[0] + '/' + row[1]);
        assert.ok(result.text.indexOf(row[3]) >= 0, row[3] + ' must stay atomic');
        assert.strictEqual(
            formatApi.formatSql(result.text, { dialect: row[0] }).status,
            'unchanged',
            row[0] + '/' + row[1] + ' idempotency'
        );
    });
})();

(function testUnsupportedPoliciesAndKeywordShapedIdentifiers() {
    var unsupported = [
        ['generic', 'merge', 'merge into t using s on t.id=s.id when matched then update set x=1'],
        ['generic', 'qualify', 'select a from t qualify row_number() over(order by a)=1'],
        ['postgresql', 'pivot', 'select a from t pivot(sum(v) for k in (1))'],
        ['mysql', 'unpivot', 'select a from t unpivot(v for k in (a,b))'],
        ['generic', 'match-recognize', 'select a from t match_recognize(pattern (A))']
    ];
    unsupported.forEach(function(row) {
        ['warn', 'preserve'].forEach(function(policy) {
            var result = formatApi.formatSql(row[2], {
                dialect: row[0],
                unsupportedSyntaxPolicy: policy
            });
            assert.strictEqual(result.text, row[2], row[1] + '/' + policy);
            assert.ok(result.diagnostics.some(function(diagnostic) {
                return diagnostic.capabilityId === row[1];
            }), row[1] + '/' + policy + ' diagnostic');
        });
        var bailed = formatApi.formatSql(row[2], {
            dialect: row[0],
            unsupportedSyntaxPolicy: 'bail_out'
        });
        assert.strictEqual(bailed.status, 'preserved', row[1] + '/bail_out');
        assert.strictEqual(bailed.text, row[2], row[1] + '/bail_out source');
    });

    ['generic', 'postgresql', 'mysql'].forEach(function(dialect) {
        var source = 'select qualify as merge from pivot where unpivot=1';
        var result = formatApi.formatSql(source, { dialect: dialect });
        assert.strictEqual(result.status, 'formatted', dialect + ' identifiers');
        assert.strictEqual(result.diagnostics.length, 0, dialect + ' false positive');
        assert.strictEqual(
            formatApi.formatSql(result.text, { dialect: dialect }).status,
            'unchanged',
            dialect + ' identifier idempotency'
        );
    });
})();

console.log('v2 Wave 3E dialect layout tests passed');
