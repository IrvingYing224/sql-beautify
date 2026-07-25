'use strict';

function frozenCase(value) {
    return Object.freeze({
        id: value.id,
        source: value.source,
        options: Object.freeze(value.options),
        expectedOutcome: value.expectedOutcome || 'safe'
    });
}

module.exports = Object.freeze([
    frozenCase({
        id: 'max-align-width-16',
        source: 'select a as x, long_name as y from t',
        options: { dialect: 'hive', maxAlignWidth: 16 }
    }),
    frozenCase({
        id: 'max-align-width-17',
        source: 'select a as x, long_name as y from t',
        options: { dialect: 'hive', maxAlignWidth: 17 }
    }),
    frozenCase({
        id: 'multiline-protected-identifier',
        source: 'select a as `x\ny`, longer_name as z from t',
        options: { dialect: 'hive' }
    }),
    frozenCase({
        id: 'trailing-comma-blank-line',
        source: 'select a as x,\n\nlonger_name as y from t',
        options: { dialect: 'hive', commaStyle: 'trailing' }
    }),
    frozenCase({
        id: 'trailing-comma-independent-comment',
        source: 'select a as x,\n/* keep */\nlonger_name as y from t',
        options: { dialect: 'hive', commaStyle: 'trailing' }
    }),
    frozenCase({
        id: 'hive-template-opaque',
        source: 'select id from ${db}.src where ds = ${hivevar:day}',
        options: { dialect: 'hive' }
    }),
    frozenCase({
        id: 'postgres-dollar-string',
        source: "select $tag$line  \r\nkeep$tag$, $1 from t",
        options: { dialect: 'postgresql' }
    }),
    frozenCase({
        id: 'mysql-variable-and-prefixed-literal',
        source: "select _utf8mb4'abc', @user_id from t where id = :id",
        options: { dialect: 'mysql' }
    }),
    frozenCase({
        id: 'generic-keyword-shaped-identifier',
        source: 'select qualify as c from t where qualify = 1',
        options: { dialect: 'generic' }
    }),
    frozenCase({
        id: 'unsupported-qualify-bailout',
        source: 'select * from t qualify row_number() over () = 1',
        options: {
            dialect: 'hive',
            unsupportedSyntaxPolicy: 'bail_out'
        },
        expectedOutcome: 'original'
    }),
    frozenCase({
        id: 'unsupported-match-recognize-warning',
        source: 'select * from t match_recognize (partition by id order by ts pattern (A+))',
        options: {
            dialect: 'generic',
            unsupportedSyntaxPolicy: 'warn'
        }
    }),
    frozenCase({
        id: 'postgres-json-opaque-operator',
        source: "select payload @> '{\"id\":1}'::jsonb from t",
        options: { dialect: 'postgresql' }
    }),
    frozenCase({
        id: 'line-comment-and-eof',
        source: 'select a -- keep FROM',
        options: { dialect: 'hive' }
    }),
    frozenCase({
        id: 'unicode-tab-display',
        source: 'select `名字` as x, abc as y from t',
        options: { dialect: 'hive', indentStyle: 'tab' }
    }),
    frozenCase({
        id: 'nested-case-expression',
        source: "select case when a=1 then case when b=2 then 'x' else 'y' end else 'z' end from t",
        options: { dialect: 'hive', caseLayout: 'compactShort' }
    }),
    frozenCase({
        id: 'leading-comment-list',
        source: 'select /* lead */ a as x, longer_name as y from t',
        options: { dialect: 'hive', commaStyle: 'leading' }
    }),
    frozenCase({
        id: 'unknown-expression-local-recovery',
        source: "select case when a=1 then f(a => b) else 'y' end",
        options: {
            dialect: 'hive',
            caseLayout: 'compactShort',
            caseWhenThenWrapLength: 200
        }
    }),
    frozenCase({
        id: 'structured-template-parameter',
        source: 'select ${hiveconf:value}+1 from t',
        options: { dialect: 'hive' }
    })
]);
