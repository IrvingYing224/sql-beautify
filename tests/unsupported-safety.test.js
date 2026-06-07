var assert = require('assert');
var vkbeautify = require('../vkbeautify');
var sqlFormatter = require('../lib/sql-formatter');

function format(sql, dialect) {
    return vkbeautify.sql(sql, true, false, true, 150, 80, {
        dialect: dialect || 'generic'
    }).trim();
}

function assert_contains(name, actual, expected) {
    assert.ok(
        actual.indexOf(expected) >= 0,
        name + '\n--- expected ---\n' + expected + '\n--- actual ---\n' + actual
    );
}

function assert_not_match(name, actual, forbidden) {
    assert.ok(
        !forbidden.test(actual),
        name + '\n--- forbidden ---\n' + forbidden + '\n--- actual ---\n' + actual
    );
}

var unsupportedMatchRecognize = format(
    'select * from t match_recognize (partition by a order by b measures match_number() as mn one row per match pattern (A B+) define A as x=1, B as y=2)',
    'generic'
);

var originalMatchRecognizeClause = 'match_recognize (partition by a order by b measures match_number() as mn one row per match pattern (A B+) define A as x=1, B as y=2)';

assert_contains(
    'unsupported MATCH_RECOGNIZE clause must be preserved exactly before normal formatting resumes',
    unsupportedMatchRecognize,
    originalMatchRecognizeClause
);

assert_not_match(
    'unsupported MATCH_RECOGNIZE syntax must not have internal keyword case rewritten',
    unsupportedMatchRecognize,
    /\bPARTITION BY a\b|\bORDER BY b\b|\bAS mn\b/
);

assert_not_match(
    'unsupported MATCH_RECOGNIZE syntax must not have internal operator spacing rewritten',
    unsupportedMatchRecognize,
    /\bx = 1\b|\by = 2\b/
);

assert_not_match(
    'unsupported MATCH_RECOGNIZE syntax must not have internal clause layout rewritten',
    unsupportedMatchRecognize,
    /\bpartition by a\s*\n\s*order by b\b/i
);

assert.throws(
    function() {
        vkbeautify.sql(
            'select * from t match_recognize (partition by a order by b measures match_number() as mn one row per match pattern (A B+) define A as x=1, B as y=2)',
            true,
            false,
            true,
            150,
            80,
            {
                dialect: 'generic',
                unsupportedSyntaxPolicy: 'bail_out'
            }
        );
    },
    /Unsupported SQL fragment detected under bail_out policy/,
    'bail_out policy must reject unsupported syntax instead of silently formatting'
);

var warned = sqlFormatter.format_sql_detailed(
    'select * from t match_recognize (partition by a order by b measures match_number() as mn one row per match pattern (A B+) define A as x=1, B as y=2)',
    {
        keywordCase: 'upper',
        commaStyle: 'leading',
        indentStyle: 'tab',
        maxAlignWidth: 150,
        caseWhenThenWrapLength: 80,
        dialect: 'generic',
        unsupportedSyntaxPolicy: 'warn'
    }
);

assert.ok(
    warned.diagnostics.some(function(item) {
        return item.level == 'warning' && item.code == 'unsupported_syntax';
    }),
    'warn policy must emit a real runtime warning diagnostic'
);

assert.ok(
    warned.diagnostics[0].unsupportedSegments && warned.diagnostics[0].unsupportedSegments.length > 0,
    'warn policy must include the preserved unsupported fragment metadata'
);

[
    'select qualify as c from t',
    'select merge as c from t',
    'select pivot as c from t'
].forEach(function(sql) {
    assert.doesNotThrow(
        function() {
            vkbeautify.sql(
                sql,
                true,
                false,
                true,
                150,
                80,
                {
                    dialect: 'postgres',
                    unsupportedSyntaxPolicy: 'bail_out'
                }
            );
        },
        sql + ' must not be rejected when low-confidence words are identifiers or aliases'
    );

    var identifierWarning = sqlFormatter.format_sql_detailed(sql, {
        keywordCase: 'upper',
        commaStyle: 'leading',
        indentStyle: 'space',
        maxAlignWidth: 150,
        caseWhenThenWrapLength: 80,
        dialect: 'postgres',
        unsupportedSyntaxPolicy: 'warn'
    });

    assert.ok(
        !identifierWarning.diagnostics.some(function(item) {
            return item.code == 'unsupported_syntax';
        }),
        sql + ' must not emit unsupported syntax diagnostics when the word is an identifier or alias'
    );
});

assert.strictEqual(
    format('select qualify as c from t', 'postgres'),
    [
        'SELECT  QUALIFY AS c',
        'FROM t'
    ].join('\n'),
    'postgres QUALIFY-shaped identifier in SELECT list must not be split as a QUALIFY clause'
);

assert.strictEqual(
    format('select qualify as c from t', 'generic'),
    [
        'SELECT  QUALIFY AS c',
        'FROM t'
    ].join('\n'),
    'generic QUALIFY-shaped identifier in SELECT list must not be split as a QUALIFY clause'
);

[
    {
        sql: 'select * from t where qualify = 1',
        dialect: 'postgres',
        name: 'QUALIFY-shaped identifier in WHERE left operand'
    },
    {
        sql: 'select * from t where x = qualify(y)',
        dialect: 'postgres',
        name: 'QUALIFY-shaped function name in WHERE expression'
    },
    {
        sql: 'select * from t where x = pivot(y)',
        dialect: 'generic',
        name: 'PIVOT-shaped function name in WHERE expression'
    }
].forEach(function(testCase) {
    assert.doesNotThrow(
        function() {
            vkbeautify.sql(
                testCase.sql,
                true,
                false,
                true,
                150,
                80,
                {
                    dialect: testCase.dialect,
                    unsupportedSyntaxPolicy: 'bail_out'
                }
            );
        },
        testCase.name + ' must not be rejected as low-confidence syntax'
    );

    var detailed = sqlFormatter.format_sql_detailed(testCase.sql, {
        keywordCase: 'upper',
        commaStyle: 'leading',
        indentStyle: 'space',
        maxAlignWidth: 150,
        caseWhenThenWrapLength: 80,
        dialect: testCase.dialect,
        unsupportedSyntaxPolicy: 'warn'
    });

    assert.ok(
        !detailed.diagnostics.some(function(item) {
            return item.code == 'unsupported_syntax';
        }),
        testCase.name + ' must not emit unsupported syntax diagnostics'
    );
});

assert.throws(
    function() {
        vkbeautify.sql(
            'select * from t qualify row_number() over(partition by a order by b)=1',
            true,
            false,
            true,
            150,
            80,
            {
                dialect: 'postgres',
                unsupportedSyntaxPolicy: 'bail_out'
            }
        );
    },
    /Unsupported SQL fragment detected/,
    'bail_out must reject known low-confidence syntax for the selected dialect'
);

var warnedQualify = sqlFormatter.format_sql_detailed(
    'select * from t qualify row_number() over(partition by a order by b)=1',
    {
        keywordCase: 'upper',
        commaStyle: 'leading',
        indentStyle: 'space',
        maxAlignWidth: 150,
        caseWhenThenWrapLength: 80,
        dialect: 'postgres',
        unsupportedSyntaxPolicy: 'warn'
    }
);

assert.ok(
    warnedQualify.diagnostics.some(function(item) {
        return item.code == 'unsupported_syntax';
    }),
    'warn must emit diagnostics for known low-confidence dialect syntax'
);

assert_not_match(
    'warn diagnostic must not claim every detected low-confidence syntax was preserved',
    warnedQualify.diagnostics[0].message,
    /were preserved without reformatting/
);

assert.throws(
    function() {
        vkbeautify.sql(
            'select * from t pivot (sum(x) for y in (1))',
            true,
            false,
            true,
            150,
            80,
            {
                dialect: 'generic',
                unsupportedSyntaxPolicy: 'bail_out'
            }
        );
    },
    /Unsupported SQL fragment detected/,
    'bail_out must reject known low-confidence PIVOT table constructs'
);

var unsupportedQualifyWindow = format(
    'select * from t qualify row_number() over(partition by a order by b)=1',
    'generic'
);

assert_not_match(
    'unsupported QUALIFY in generic mode must not be reformatted into a broken ROW_NUMBER call',
    unsupportedQualifyWindow,
    /ROW_NUMBER\s*\n\s*\(\s*\n\s*\)\s*OVER/i
);

assert.throws(
    function() {
        vkbeautify.sql(
            'select * from (select a, row_number() over(partition by k order by ts) as rn from t qualify rn=1) q',
            true,
            false,
            true,
            150,
            80,
            {
                dialect: 'postgres',
                unsupportedSyntaxPolicy: 'bail_out'
            }
        );
    },
    /Unsupported SQL fragment detected/,
    'bail_out must reject real QUALIFY inside nested subqueries'
);

assert.doesNotThrow(
    function() {
        vkbeautify.sql(
            'with qualify_alias as (select qualify as c from t) select * from qualify_alias where c=1',
            true,
            false,
            true,
            150,
            80,
            {
                dialect: 'postgres',
                unsupportedSyntaxPolicy: 'bail_out'
            }
        );
    },
    'bail_out must allow CTEs and SELECT-list aliases named qualify'
);

assert.doesNotThrow(
    function() {
        vkbeautify.sql(
            'select merge as c from t where merge = 1',
            true,
            false,
            true,
            150,
            80,
            {
                dialect: 'generic',
                unsupportedSyntaxPolicy: 'bail_out'
            }
        );
    },
    'bail_out must allow MERGE-shaped identifiers outside statement-start context'
);

assert.throws(
    function() {
        vkbeautify.sql(
            'merge into target t using source s on t.id=s.id when matched then update set v=s.v',
            true,
            false,
            true,
            150,
            80,
            {
                dialect: 'generic',
                unsupportedSyntaxPolicy: 'bail_out'
            }
        );
    },
    /Unsupported SQL fragment detected/,
    'bail_out must reject real MERGE INTO statements'
);

assert.doesNotThrow(
    function() {
        vkbeautify.sql(
            'select * from t where x = pivot(y)',
            true,
            false,
            true,
            150,
            80,
            {
                dialect: 'generic',
                unsupportedSyntaxPolicy: 'bail_out'
            }
        );
    },
    'bail_out must allow PIVOT-shaped expression functions'
);

assert.throws(
    function() {
        vkbeautify.sql(
            'select * from t pivot (sum(x) for y in (1)) where x = pivot(y)',
            true,
            false,
            true,
            150,
            80,
            {
                dialect: 'generic',
                unsupportedSyntaxPolicy: 'bail_out'
            }
        );
    },
    /Unsupported SQL fragment detected/,
    'bail_out must reject real PIVOT table constructs even when PIVOT-shaped functions also exist'
);

var spacedMatchRecognize = format(
    'select * from t match recognize (partition by a order by b measures match_number() as mn one row per match pattern (A B+) define A as x=1, B as y=2)',
    'generic'
);

var originalSpacedMatchRecognizeClause = 'match recognize (partition by a order by b measures match_number() as mn one row per match pattern (A B+) define A as x=1, B as y=2)';

assert_contains(
    'unsupported MATCH RECOGNIZE spaced clause must be preserved exactly before normal formatting resumes',
    spacedMatchRecognize,
    originalSpacedMatchRecognizeClause
);

var extractedAdd = vkbeautify.extractddl('select a + b from t');
assert.strictEqual(
    extractedAdd.trim(),
    '',
    'extractddl must conservatively skip unsupported arithmetic expressions without alias'
);

var extractedConcat = vkbeautify.extractddl('select concat(a,b) from t');
assert.strictEqual(
    extractedConcat.trim(),
    '',
    'extractddl must conservatively skip unsupported function expressions without alias'
);

var extractedCase = vkbeautify.extractddl('select case when x=1 then y else z end from t');
assert.strictEqual(
    extractedCase.trim(),
    '',
    'extractddl must conservatively skip unsupported CASE expressions without alias'
);

console.log('unsupported safety tests passed');
