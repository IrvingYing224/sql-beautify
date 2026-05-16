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

var unsupportedQualifyWindow = format(
    'select * from t qualify row_number() over(partition by a order by b)=1',
    'generic'
);

assert_not_match(
    'unsupported QUALIFY in generic mode must not be reformatted into a broken ROW_NUMBER call',
    unsupportedQualifyWindow,
    /ROW_NUMBER\s*\n\s*\(\s*\n\s*\)\s*OVER/i
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
