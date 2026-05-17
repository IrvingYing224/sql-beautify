var assert = require('assert');
var rangePolicy = require('../lib/adapters/range-format-policy');
var sqlDialect = require('../lib/core/sql-dialect');

function create_position(offset) {
    return { offset: offset };
}

function create_range(start, end) {
    return {
        start: create_position(start),
        end: create_position(end)
    };
}

function create_document(text) {
    return {
        getText: function(range) {
            if (!range) {
                return text;
            }
            return text.slice(range.start.offset, range.end.offset);
        }
    };
}

function analyze(text, start, end, dialect) {
    return rangePolicy.analyze_range(
        create_document(text),
        create_range(start, end),
        sqlDialect.get_capabilities(dialect || 'generic')
    );
}

var cte = 'with s as (select a from t)\nselect a from s\n';
assert.strictEqual(
    analyze(cte, 0, cte.length, 'generic').safe,
    true,
    'complete CTE selection must be accepted as a safe range'
);

var recursiveCte = 'with recursive s as (select 1 as id)\nselect id from s\n';
assert.strictEqual(
    analyze(recursiveCte, 0, recursiveCte.length, 'postgres').safe,
    true,
    'complete WITH RECURSIVE selection must be accepted'
);

var incompleteCte = 'with s as (select a from t\nselect a from s\n';
assert.strictEqual(
    analyze(incompleteCte, 0, incompleteCte.length, 'generic').safe,
    false,
    'CTE selection with unbalanced structure must still be rejected'
);

var continuationOnly = 'select a\nfrom t\nwhere x=1\nand y=2\n';
assert.strictEqual(
    analyze(continuationOnly, continuationOnly.indexOf('and'), continuationOnly.length, 'generic').safe,
    false,
    'condition continuation-only range must remain unsafe'
);

assert.strictEqual(
    analyze('select a,\n b\nfrom t', 1, 11, 'generic').safe,
    false,
    'partial non-whole-line selection must remain unsafe'
);

console.log('range format policy tests passed');
