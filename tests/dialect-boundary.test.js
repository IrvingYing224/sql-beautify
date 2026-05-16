var assert = require('assert');
var vkbeautify = require('../vkbeautify');

function format(sql, dialect) {
    return vkbeautify.sql(sql, true, false, true, 150, 80, { dialect: dialect || 'generic' }).trim();
}

function assert_contains(name, input, expected, dialect) {
    var actual = format(input, dialect);
    assert.ok(actual.indexOf(expected) >= 0, name + '\n--- expected ---\n' + expected + '\n--- actual ---\n' + actual);
}

function assert_not_contains(name, input, forbidden, dialect) {
    var actual = format(input, dialect);
    assert.strictEqual(actual.indexOf(forbidden), -1, name + '\n--- forbidden ---\n' + forbidden + '\n--- actual ---\n' + actual);
}

assert_contains(
    'PostgreSQL dollar quoted string is opaque in generic mode',
    'select $$from where case when then$$ as s from t where a=1',
    '$$from where case when then$$',
    'generic'
);

assert_contains(
    'MySQL hash comment is a line comment in generic mode',
    'select a # from where\nfrom t',
    '# from where',
    'generic'
);

assert_contains(
    'PostgreSQL JSON operator keeps arrow text',
    "select data->>'name' as name from t where data->'x' is not null",
    "data->>'name'",
    'postgres'
);

assert_not_contains(
    'PostgreSQL JSON operator is not split by greater-than spacing',
    "select data->>'name' as name from t",
    '->  >',
    'postgres'
);

assert_contains(
    'MySQL null-safe equality operator keeps <=> token',
    'select a<=>b from t where c<=>d',
    'a <=> b',
    'mysql'
);

assert_not_contains(
    'MySQL null-safe equality operator is not split into <= and >',
    'select a<=>b from t where c<=>d',
    '<= >',
    'mysql'
);

assert_contains(
    'WITH RECURSIVE keeps recursive keyword under keyword casing',
    'with recursive cte as (select 1 as n) select * from cte',
    'WITH RECURSIVE cte AS',
    'generic'
);

assert_contains(
    'VALUES keyword is uppercased under keyword casing',
    'values (1,2),(3,4)',
    'VALUES',
    'generic'
);

assert_contains(
    'QUALIFY is treated as a keyword in postgres mode',
    'select sum(x) over(partition by a) as s from t qualify s>1',
    'QUALIFY',
    'postgres'
);

assert_contains(
    'PostgreSQL cast and JSON operators keep canonical operator text',
    "select payload::json->>'name' #>> '{a,b}' from t",
    "payload::json->>'name' #>> '{a,b}'",
    'postgres'
);

assert_not_contains(
    'PostgreSQL #>> operator is not split by spacing normalization',
    "select payload::json->>'name' #>> '{a,b}' from t",
    '# >  >',
    'postgres'
);

console.log('dialect boundary tests passed');
