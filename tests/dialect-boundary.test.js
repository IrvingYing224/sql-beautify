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

function assert_contains_exactly_once(name, input, fragment, dialect) {
    var actual = format(input, dialect);
    var first = actual.indexOf(fragment);
    var last = actual.lastIndexOf(fragment);
    assert.notStrictEqual(first, -1, name + '\n--- expected fragment ---\n' + fragment + '\n--- actual ---\n' + actual);
    assert.strictEqual(first, last, name + '\n--- fragment count ---\nexpected exactly once\n--- actual ---\n' + actual);
}

assert_contains(
    'PostgreSQL dollar quoted string is opaque in generic mode',
    'select $$from where case when then$$ as s from t where a=1',
    '$$from where case when then$$',
    'generic'
);

assert_contains(
    'Generic hash comment is treated as a line comment',
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
    'QUALIFY-shaped SELECT list identifier is not split as a clause in postgres mode',
    'select qualify as c from t',
    'SELECT  QUALIFY AS c',
    'postgres'
);

assert_not_contains(
    'QUALIFY-shaped SELECT list identifier does not create a standalone clause in postgres mode',
    'select qualify as c from t',
    'SELECT\nQUALIFY AS c',
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

assert_contains_exactly_once(
    'PostgreSQL dollar quoted string in CASE branch keeps double-dash byte-for-byte',
    'select case when a=1 then $$x--y$$ else z end as v from t',
    '$$x--y$$',
    'postgres'
);

assert_not_contains(
    'PostgreSQL dollar quoted string in CASE branch is not rewritten around line-comment marker',
    'select case when a=1 then $$x--y$$ else z end as v from t',
    '$$x --y$$',
    'postgres'
);

assert_contains_exactly_once(
    'PostgreSQL dollar quoted string in CASE branch keeps CASE keywords opaque',
    'select case when a=1 then $$WHEN--THEN ELSE END$$ else z end as v from t',
    '$$WHEN--THEN ELSE END$$',
    'postgres'
);

assert_not_contains(
    'PostgreSQL dollar quoted string in CASE branch does not get keyword-aware spacing',
    'select case when a=1 then $$WHEN--THEN ELSE END$$ else z end as v from t',
    '$$WHEN --THEN ELSE END$$',
    'postgres'
);

assert_contains(
    'Generic hash comment inside CASE branch stays a comment on the CASE formatter path',
    [
        "select case when a=1 then 'x' # keep hash comment",
        "when a=2 then 'y'",
        "else 'z' end as c from t"
    ].join('\n'),
    "# keep hash comment",
    'generic'
);

assert_not_contains(
    'Generic hash comment inside CASE branch is not treated as active SQL by case formatting',
    [
        "select case when a=1 then 'x' # keep hash comment",
        "when a=2 then 'y'",
        "else 'z' end as c from t"
    ].join('\n'),
    "WHEN a = 2 THEN 'y' #",
    'generic'
);

assert_contains(
    'MySQL hash comment on condition continuation stays opaque on the condition formatter path',
    [
        'select * from t',
        'where a=1 # keep hash comment',
        'and b=2'
    ].join('\n'),
    '# keep hash comment',
    'mysql'
);

assert_contains(
    'Generic standalone hash comment stays on its own line in SELECT blocks',
    [
        'select a,',
        '# keep hash comment',
        'b from t'
    ].join('\n'),
    [
        'SELECT  a',
        '       # keep hash comment',
        '       ,b',
        'FROM t'
    ].join('\n'),
    'generic'
);

assert_contains(
    'MySQL standalone hash comment stays on its own line in condition blocks',
    [
        'select * from t',
        'where a=1',
        '# keep hash comment',
        'and b=2'
    ].join('\n'),
    [
        'SELECT  *',
        'FROM t',
        'WHERE a = 1',
        '# keep hash comment',
        '  AND b = 2'
    ].join('\n'),
    'mysql'
);

assert_contains_exactly_once(
    'PostgreSQL trailing comma style keeps dollar-quoted string byte-for-byte',
    [
        'select $$x--y$$ as v',
        ',a',
        'from t'
    ].join('\n'),
    '$$x--y$$',
    'postgres'
);

console.log('dialect boundary tests passed');
