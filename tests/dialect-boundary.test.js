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

console.log('dialect boundary tests passed');
